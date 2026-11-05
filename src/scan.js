import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { allocated, mapLimit } from './util.js';

export const TEMP_PREFIX = '.nmtmp-';

const SKIP_WHILE_SEARCHING = new Set([
  '.git', '.hg', '.svn', '.nm-store', '.Trash', '$Recycle.Bin', 'System Volume Information',
  'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'AppData', 'Library',
  'proc', 'sys', 'dev', 'snap',
]);

// Tools rewrite these in place, which would change every project sharing the file.
const WRITABLE_DIRS = new Set(['.cache', '.vite', '.vite-temp', '.turbo', '.parcel-cache', '.angular', '.next', '.nuxt', '.prisma']);
const SYNC_FOLDER = /[\\/](OneDrive[^\\/]*|Dropbox|Google Drive|iCloud Drive|Mobile Documents)([\\/]|$)/i;

const safeReaddir = (dir) => fs.readdir(dir, { withFileTypes: true }).catch(() => []);

/**
 * Finds node_modules folders under the given roots. It does not descend into one
 * it found: a nested node_modules belongs to the same install and is processed
 * with it. Links are never followed, so nothing is counted twice.
 */
export async function findNodeModules(roots) {
  const found = new Set();
  let queue = [];
  for (const root of roots.map((entry) => path.resolve(entry))) {
    const segments = root.split(path.sep);
    const index = segments.indexOf('node_modules');
    if (index >= 0) found.add(segments.slice(0, index + 1).join(path.sep));
    else queue.push(root);
  }
  while (queue.length > 0) {
    const next = [];
    await mapLimit(queue, 32, async (dir) => {
      for (const entry of await safeReaddir(dir)) {
        if (!entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        if (entry.name === 'node_modules') found.add(full);
        else if (!SKIP_WHILE_SEARCHING.has(entry.name)) next.push(full);
      }
    });
    queue = next;
  }
  return [...found].sort();
}

/** Lists shareable files inside a node_modules folder. */
export async function listFiles(nmDir, { removeStaleTemp = false } = {}) {
  const files = [];
  let queue = [nmDir];
  while (queue.length > 0) {
    const next = [];
    await mapLimit(queue, 32, async (dir) => {
      const isModulesRoot = path.basename(dir) === 'node_modules';
      for (const entry of await safeReaddir(dir)) {
        const full = path.join(dir, entry.name);
        if (entry.name.startsWith(TEMP_PREFIX)) {
          if (removeStaleTemp) await fs.rm(full, { force: true }).catch(() => {});
        } else if (isModulesRoot && entry.name.startsWith('.')) {
          // .bin, .package-lock.json, .yarn-integrity: owned by the package manager.
        } else if (entry.isDirectory()) {
          if (!WRITABLE_DIRS.has(entry.name)) next.push(full);
        } else if (entry.isFile()) {
          files.push(full);
        }
      }
    });
    queue = next;
  }
  return files;
}

async function isPatched(projectDir) {
  if (existsSync(path.join(projectDir, 'patches')) || existsSync(path.join(projectDir, '.yarn', 'patches'))) return true;
  try {
    const text = await fs.readFile(path.join(projectDir, 'package.json'), 'utf8');
    return text.includes('patch-package') || text.includes('patchedDependencies');
  } catch {
    return false;
  }
}

async function readPackageName(projectDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(projectDir, 'package.json'), 'utf8')).name ?? null;
  } catch {
    return null;
  }
}

/**
 * Describes one node_modules folder and why it may be unsafe to share:
 * pnpm     already linked by pnpm, whose layout must stay untouched
 * patched  patch tools edit files in place, which would reach other projects
 * synced   cloud sync clients do not preserve hard links
 * no-store no store exists on this volume, and links cannot cross volumes
 */
export async function describeProject(nmDir, stores) {
  const projectDir = path.dirname(nmDir);
  const { dev } = await fs.stat(nmDir, { bigint: true });
  const store = stores.find((candidate) => candidate.dev === dev) ?? null;
  const flags = [];
  if (existsSync(path.join(nmDir, '.pnpm')) || existsSync(path.join(nmDir, '.modules.yaml'))) flags.push('pnpm');
  if (await isPatched(projectDir)) flags.push('patched');
  if (SYNC_FOLDER.test(nmDir)) flags.push('synced');
  if (!store) flags.push('no-store');
  const files = await listFiles(nmDir);
  let bytes = 0;
  await mapLimit(files, 64, async (file) => {
    const stat = await fs.lstat(file).catch(() => null);
    if (stat) bytes += allocated(stat.size);
  });
  return {
    path: nmDir,
    projectDir,
    name: await readPackageName(projectDir),
    fileCount: files.length,
    bytes,
    store,
    flags,
  };
}

/** Flags the user may override. pnpm and no-store are hard limits. */
export const OVERRIDABLE_FLAGS = new Set(['patched', 'synced']);

export const isEligible = (project, include = []) =>
  project.flags.every((flag) => OVERRIDABLE_FLAGS.has(flag) && include.includes(flag));
