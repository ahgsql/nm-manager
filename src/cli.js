import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { analyze, applyProjects, DEFAULT_MIN_SIZE, estimateSavings, undoProjects } from './dedupe.js';
import { describeProject, findNodeModules, isEligible } from './scan.js';
import { startServer } from './server.js';
import { addStore, collectGarbage, configPath, loadStores, storeStatus, suggestStores, verifyStore } from './store.js';
import { formatBytes as size, mapLimit } from './util.js';

const HELP = `nm-manager: reclaim disk space from duplicate node_modules

Usage:
  nm-manager init [--store <path>]...     Choose where shared files are kept
  nm-manager scan <dir>...                List projects and estimated savings (changes nothing)
  nm-manager apply <dir>...               Scan, ask, then share identical files
  nm-manager undo <dir>...                Give projects independent copies again
  nm-manager gc [--dry-run]               Delete shared files no project uses any more
  nm-manager status                       Show stores and their savings
  nm-manager verify [--fix]               Check that shared files are still intact
  nm-manager ui [--port <n>] [--no-open]  Open the local web interface

Options:
  --yes                    Apply to or undo every eligible project without asking
  --include <flags>        Also process flagged projects: patched,synced
  --min-size <bytes>       Ignore smaller files (default ${DEFAULT_MIN_SIZE})
  --fast                   scan: list sizes only, skip hashing
  --json                   scan, status: machine-readable output
`;

const useColor = process.env.FORCE_COLOR ? true : process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const bold = paint(1);
const dim = paint(2);
const green = paint(32);
const yellow = paint(33);

const FLAG_HINTS = {
  pnpm: 'already linked by pnpm',
  patched: 'edits files in place; use --include patched to override',
  synced: 'in a cloud-sync folder; use --include synced to override',
  'no-store': 'no store on this volume; run nm-manager init --store <path>',
};

function progressPrinter() {
  if (!process.stderr.isTTY) return undefined;
  let last = 0;
  return ({ phase, done, total }) => {
    const now = Date.now();
    if (now - last < 100 && done !== total) return;
    last = now;
    process.stderr.write(`\r\x1b[K${dim(`${phase} ${done}/${total}`)}`);
    if (done === total) process.stderr.write('\r\x1b[K');
  };
}

async function requireStores() {
  const { stores, missing } = await loadStores();
  for (const storePath of missing) console.error(yellow(`Store not available: ${storePath}`));
  if (stores.length === 0) throw new UsageError('No store yet. Run: nm-manager init');
  return stores;
}

class UsageError extends Error {}

async function discover(dirs, include, stores) {
  if (dirs.length === 0) throw new UsageError('Give at least one folder to search.');
  const paths = await findNodeModules(dirs);
  const projects = await mapLimit(paths, 8, (nmDir) => describeProject(nmDir, stores));
  return projects.map((project) => ({ ...project, eligible: isEligible(project, include) }));
}

function printTable(projects, savings) {
  const rows = projects.map((project, index) => [
    String(index + 1),
    project.projectDir,
    size(project.bytes),
    !project.eligible ? '-' : savings ? size(savings.perProject[project.path] ?? 0) : '?',
    project.flags.join(','),
  ]);
  const widths = [2, 7, 6, 8].map((min, column) => Math.max(min, ...rows.map((row) => row[column].length)));
  console.log(bold(`${'#'.padStart(widths[0])}  ${'Project'.padEnd(widths[1])}  ${'Size'.padStart(widths[2])}  ${'Saveable'.padStart(widths[3])}`));
  for (const row of rows) {
    const saveable = row[3].padStart(widths[3]);
    console.log(
      `${row[0].padStart(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2].padStart(widths[2])}  ${row[3] === '-' ? dim(saveable) : green(saveable)}${row[4] ? `  ${yellow(row[4])}` : ''}`,
    );
  }
  for (const flag of new Set(projects.flatMap((project) => project.flags))) {
    console.log(dim(`  ${flag}: ${FLAG_HINTS[flag]}`));
  }
}

function parseSelection(answer, count) {
  const text = answer.trim().toLowerCase();
  if (text === 'a' || text === 'all') return Array.from({ length: count }, (_, index) => index);
  if (text === '' || text === 'n' || text === 'no') return [];
  const picked = new Set();
  for (const part of text.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) throw new UsageError(`Could not read selection: ${part}`);
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    for (let number = from; number <= to; number += 1) {
      if (number < 1 || number > count) throw new UsageError(`No project number ${number}.`);
      picked.add(number - 1);
    }
  }
  return [...picked];
}

async function ask(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

async function chooseProjects(projects, yes, verb) {
  const eligible = projects.filter((project) => project.eligible);
  if (yes) return eligible;
  if (!process.stdin.isTTY) throw new UsageError(`Refusing to ${verb} without confirmation: pass --yes or run in a terminal.`);
  const answer = await ask(bold(`${verb} which projects? [a]ll, numbers like 1,3-5, or [n]o: `));
  const picked = parseSelection(answer, projects.length).map((index) => projects[index]);
  const blocked = picked.filter((project) => !project.eligible);
  if (blocked.length > 0) throw new UsageError(`Not eligible: ${blocked.map((project) => project.projectDir).join(', ')}`);
  return answer.trim().toLowerCase().startsWith('a') ? eligible : picked;
}

async function commandInit(options) {
  let chosen = options.store ?? [];
  if (chosen.length === 0) {
    if (!process.stdin.isTTY) throw new UsageError('Pass --store <path> when not running in a terminal.');
    console.log('A store holds shared files. Links cannot cross volumes, so each drive needs its own.');
    for (const candidate of suggestStores()) {
      const answer = await ask(`Create a store at ${bold(candidate)}? [y/N] `);
      if (answer.trim().toLowerCase().startsWith('y')) chosen.push(candidate);
    }
  }
  if (chosen.length === 0) throw new UsageError('No store selected.');
  for (const storePath of chosen) {
    const store = await addStore(storePath);
    console.log(`${green('Ready')} ${store.path} ${dim(`(${store.mode})`)}`);
  }
  console.log(dim(`Config: ${configPath()}`));
  return 0;
}

async function commandScan(dirs, options) {
  const stores = await requireStores();
  const projects = await discover(dirs, options.include, stores);
  const eligible = projects.filter((project) => project.eligible);
  const analysis = options.fast ? null : await analyze(eligible, { minSize: options.minSize, onProgress: progressPrinter() });
  const savings = analysis ? estimateSavings(analysis, eligible.map((project) => project.path)) : null;
  if (options.json) {
    console.log(JSON.stringify({
      savings: savings?.total ?? null,
      projects: projects.map((project) => ({
        path: project.path,
        name: project.name,
        files: project.fileCount,
        bytes: project.bytes,
        saveable: savings?.perProject[project.path] ?? null,
        flags: project.flags,
      })),
    }, null, 2));
    return 0;
  }
  if (projects.length === 0) {
    console.log('No node_modules found.');
    return 0;
  }
  printTable(projects, savings);
  if (savings) {
    console.log(`\n${bold('Can save')} ${green(`~${size(savings.total)}`)} across ${eligible.length} project(s). Nothing was changed.`);
  }
  return 0;
}

function printSkipped(result) {
  if (result.skippedCount === 0) return;
  console.log(yellow(`${result.skippedCount} file(s) skipped and left untouched (in use or changed):`));
  for (const { file, code } of result.skipped.slice(0, 5)) console.log(dim(`  ${code} ${file}`));
}

async function commandApply(dirs, options) {
  const stores = await requireStores();
  const projects = await discover(dirs, options.include, stores);
  if (projects.length === 0) {
    console.log('No node_modules found.');
    return 0;
  }
  const eligible = projects.filter((project) => project.eligible);
  const analysis = await analyze(eligible, { minSize: options.minSize, onProgress: progressPrinter() });
  printTable(projects, estimateSavings(analysis, eligible.map((project) => project.path)));
  const selected = await chooseProjects(projects, options.yes, 'Share');
  if (selected.length === 0) {
    console.log('Nothing changed.');
    return 0;
  }
  const estimate = estimateSavings(analysis, selected.map((project) => project.path)).total;
  console.log(`Sharing ${selected.length} project(s), estimated ~${size(estimate)}...`);
  const result = await applyProjects(selected, { minSize: options.minSize, onProgress: progressPrinter() });
  console.log(`${green('Done.')} ${result.linked} linked to the store, ${result.added} added to it, ${result.already} already shared.`);
  for (const [storePath, freed] of Object.entries(result.freed)) {
    console.log(`${bold('Free space change')} on ${storePath}: ${green(size(freed))} ${dim('(measured; other programs affect it too)')}`);
  }
  if (result.corrupted.length > 0) {
    console.log(yellow(`${result.corrupted.length} store file(s) were edited in place and quarantined. Reinstall the affected projects; see nm-manager verify.`));
  }
  printSkipped(result);
  return 0;
}

async function commandUndo(dirs, options) {
  const stores = await requireStores();
  const projects = (await discover(dirs, [], stores)).map((project) => ({
    ...project,
    eligible: !project.flags.includes('pnpm'),
  }));
  if (projects.length === 0) {
    console.log('No node_modules found.');
    return 0;
  }
  printTable(projects, null);
  const selected = await chooseProjects(projects, options.yes, 'Undo');
  if (selected.length === 0) {
    console.log('Nothing changed.');
    return 0;
  }
  const result = await undoProjects(selected, { onProgress: progressPrinter() });
  console.log(`${green('Done.')} ${result.restored} file(s) are independent copies again. Run nm-manager gc to clear unused store files.`);
  printSkipped(result);
  return 0;
}

async function commandGc(options) {
  for (const store of await requireStores()) {
    const { removed, bytes } = await collectGarbage(store, { dryRun: options.dryRun });
    console.log(`${store.path}: ${options.dryRun ? 'would remove' : 'removed'} ${removed} unused file(s), ${green(size(bytes))}`);
  }
  return 0;
}

async function commandStatus(options) {
  const stores = await requireStores();
  const report = [];
  for (const store of stores) report.push({ path: store.path, mode: store.mode, ...(await storeStatus(store)) });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  for (const item of report) {
    console.log(bold(item.path), dim(`(${item.mode})`));
    console.log(`  ${item.objects} file(s), ${size(item.bytes)} in store, ${item.unused} unused`);
    if (item.mode === 'hardlink') console.log(`  Saving ${green(size(item.savedBytes))} through shared files`);
  }
  return 0;
}

async function commandVerify(options) {
  let failed = false;
  for (const store of await requireStores()) {
    const { checked, corrupted } = await verifyStore(store, { fix: options.fix, onProgress: progressPrinter() });
    console.log(`${store.path}: ${checked} checked, ${corrupted.length === 0 ? green('all intact') : yellow(`${corrupted.length} corrupted`)}`);
    if (corrupted.length > 0) {
      failed = true;
      console.log(yellow(options.fix
        ? '  Quarantined. Projects using these files may hold edited content: reinstall them.'
        : '  A shared file was edited in place. Run with --fix, then reinstall affected projects.'));
    }
  }
  return failed ? 1 : 0;
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        store: { type: 'string', multiple: true },
        include: { type: 'string', default: '' },
        'min-size': { type: 'string' },
        yes: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        fast: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        fix: { type: 'boolean', default: false },
        port: { type: 'string', default: '0' },
        'no-open': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...dirs] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return 0;
  }
  const minSize = values['min-size'] === undefined ? DEFAULT_MIN_SIZE : Number(values['min-size']);
  if (!Number.isInteger(minSize) || minSize < 1) {
    console.error('--min-size must be a positive whole number.');
    return 2;
  }
  const options = {
    store: values.store,
    include: values.include.split(',').filter(Boolean),
    minSize,
    yes: values.yes,
    dryRun: values['dry-run'],
    fast: values.fast,
    json: values.json,
    fix: values.fix,
  };
  try {
    switch (command) {
      case 'init': return await commandInit(options);
      case 'scan': return await commandScan(dirs, options);
      case 'apply': return await commandApply(dirs, options);
      case 'undo': return await commandUndo(dirs, options);
      case 'gc': return await commandGc(options);
      case 'status': return await commandStatus(options);
      case 'verify': return await commandVerify(options);
      case 'ui': {
        const { url } = await startServer({ port: Number(values.port), open: !values['no-open'] });
        console.log(`nm-manager is running at ${bold(url)}\nPress Ctrl+C to stop.`);
        return await new Promise(() => {});
      }
      default:
        console.error(`Unknown command: ${command}\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : `Error: ${error.message}`);
    return error instanceof UsageError ? 2 : 1;
  }
}
