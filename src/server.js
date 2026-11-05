import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { analyze, applyProjects, estimateSavings, undoProjects } from './dedupe.js';
import { describeProject, findNodeModules, isEligible } from './scan.js';
import { addStore, collectGarbage, loadStores, storeStatus, suggestStores } from './store.js';
import { mapLimit } from './util.js';

const MAX_BODY = 1024 * 1024;

function openBrowser(url) {
  const [command, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

/** Opens the operating system's folder dialog. Returns null if cancelled or unavailable. */
function pickFolder() {
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d=New-Object System.Windows.Forms.FolderBrowserDialog',
    'if($d.ShowDialog() -eq "OK"){$d.SelectedPath}',
  ].join(';');
  const [command, args] =
    process.platform === 'win32' ? ['powershell', ['-NoProfile', '-STA', '-Command', script]]
    : process.platform === 'darwin' ? ['osascript', ['-e', 'POSIX path of (choose folder)']]
    : ['zenity', ['--file-selection', '--directory']];
  return new Promise((resolve) => {
    execFile(command, args, (error, stdout) => resolve(error ? null : stdout.trim() || null));
  });
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const publicProject = (project, include) => ({
  path: project.path,
  projectDir: project.projectDir,
  name: project.name,
  files: project.fileCount,
  bytes: project.bytes,
  flags: project.flags,
  eligible: isEligible(project, include),
});

/**
 * Serves the web interface on the loopback interface only. Any page in the user's
 * browser can reach localhost, so every request must carry the secret token and a
 * loopback Host header (which stops DNS rebinding).
 */
export async function startServer({ port = 0, open = true } = {}) {
  const token = randomBytes(24).toString('hex');
  const page = await fs.readFile(new URL('./ui.html', import.meta.url), 'utf8');
  let job = null;
  let lastScan = null;

  const runJob = (type, task) => {
    if (job?.running) throw Object.assign(new Error('Another operation is still running.'), { status: 409 });
    const current = { type, running: true, phase: null, done: 0, total: 0, result: null, error: null };
    job = current;
    const onProgress = ({ phase, done, total }) => Object.assign(current, { phase, done, total });
    task(onProgress).then(
      (result) => Object.assign(current, { running: false, result }),
      (error) => Object.assign(current, { running: false, error: error.message }),
    );
    return { started: true };
  };

  /** Only folders from the latest scan can be changed; the client cannot name other paths. */
  const selectedFromScan = (paths, predicate) => {
    if (!lastScan) throw Object.assign(new Error('Scan first.'), { status: 400 });
    if (!Array.isArray(paths)) throw Object.assign(new Error('paths must be a list.'), { status: 400 });
    return paths.map((nmDir) => {
      const project = lastScan.projects.find((candidate) => candidate.path === nmDir);
      if (!project || !predicate(project)) {
        throw Object.assign(new Error(`Not selectable: ${nmDir}`), { status: 400 });
      }
      return project;
    });
  };

  const routes = {
    'GET /api/state': async () => {
      const { stores, missing } = await loadStores();
      const details = [];
      for (const store of stores) details.push({ path: store.path, mode: store.mode, ...(await storeStatus(store)) });
      return { stores: details, missing, suggestions: suggestStores() };
    },
    'GET /api/job': async () => job,
    'POST /api/init': async ({ stores }) => {
      if (!Array.isArray(stores) || stores.length === 0) {
        throw Object.assign(new Error('Choose at least one location.'), { status: 400 });
      }
      for (const storePath of stores) await addStore(String(storePath));
      return { ok: true };
    },
    'POST /api/pick-folder': async () => ({ path: await pickFolder() }),
    'POST /api/scan': async ({ dirs }) => {
      if (!Array.isArray(dirs) || dirs.length === 0 || dirs.some((dir) => typeof dir !== 'string' || !dir.trim())) {
        throw Object.assign(new Error('Choose a folder.'), { status: 400 });
      }
      return runJob('scan', async (onProgress) => {
        const { stores } = await loadStores();
        for (const dir of dirs) await fs.access(dir);
        const paths = await findNodeModules(dirs);
        let done = 0;
        const projects = await mapLimit(paths, 8, async (nmDir) => {
          const project = await describeProject(nmDir, stores);
          done += 1;
          onProgress({ phase: 'list', done, total: paths.length });
          return project;
        });
        const eligible = projects.filter((project) => isEligible(project));
        const analysis = await analyze(eligible, { onProgress });
        lastScan = { projects, analysis };
        const savings = estimateSavings(analysis, eligible.map((project) => project.path));
        return { projects: projects.map((project) => publicProject(project)), ...savings };
      });
    },
    'POST /api/estimate': async ({ paths }) => {
      const selected = selectedFromScan(paths, (project) => isEligible(project));
      return estimateSavings(lastScan.analysis, selected.map((project) => project.path));
    },
    'POST /api/apply': async ({ paths }) => {
      const selected = selectedFromScan(paths, (project) => isEligible(project));
      return runJob('apply', (onProgress) => applyProjects(selected, { onProgress }));
    },
    'POST /api/undo': async ({ paths }) => {
      const selected = selectedFromScan(paths, (project) => !project.flags.includes('pnpm'));
      return runJob('undo', (onProgress) => undoProjects(selected, { onProgress }));
    },
    'POST /api/gc': async () => runJob('gc', async () => {
      const { stores } = await loadStores();
      let removed = 0;
      let bytes = 0;
      for (const store of stores) {
        const result = await collectGarbage(store);
        removed += result.removed;
        bytes += result.bytes;
      }
      return { removed, bytes };
    }),
  };

  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    try {
      const { port: boundPort } = server.address();
      const origin = `http://127.0.0.1:${boundPort}`;
      if (req.headers.host !== `127.0.0.1:${boundPort}`) return send(403, { error: 'Bad host' });
      if (req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'Bad origin' });
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/') {
        if (url.searchParams.get('t') !== token) return send(403, 'Open the link printed by nm-manager.', 'text/plain; charset=utf-8');
        return send(200, page, 'text/html; charset=utf-8');
      }
      if (req.headers['x-nm-token'] !== token) return send(403, { error: 'Bad token' });
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(404, { error: 'Not found' });
      return send(200, await route(req.method === 'POST' ? await readJson(req) : {}));
    } catch (error) {
      const status = error.status ?? (error instanceof SyntaxError ? 400 : 500);
      return send(status, { error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
  if (open) openBrowser(url);
  return { url, token, server };
}
