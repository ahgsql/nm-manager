import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, existsSync, mkdirSync, mkdtempSync, promises as fs, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { analyze, applyProjects, estimateSavings, undoProjects } from '../src/dedupe.js';
import { describeProject, findNodeModules, isEligible, listFiles } from '../src/scan.js';
import { startServer } from '../src/server.js';
import { addStore, cloneFile, collectGarbage, loadStores, objectPath, storeStatus, verifyStore } from '../src/store.js';

const plainCopy = promisify(copyFile);
const BIN = path.resolve('bin/nm-manager.js');
const BIG = 'x'.repeat(5000);

let root;
let storeDir;

function write(relative, content = BIG) {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function makeProject(name, files = { 'lib/index.js': BIG }) {
  write(`${name}/package.json`, JSON.stringify({ name }));
  for (const [file, content] of Object.entries(files)) write(`${name}/node_modules/${file}`, content);
  return path.join(root, name, 'node_modules');
}

const ino = (file) => statSync(file, { bigint: true }).ino;

async function projectsIn(...dirs) {
  const { stores } = await loadStores();
  const paths = await findNodeModules(dirs);
  return Promise.all(paths.map((nmDir) => describeProject(nmDir, stores)));
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'nm-test-'));
  storeDir = path.join(root, 'store');
  process.env.NM_MANAGER_CONFIG = path.join(root, 'config', 'config.json');
});

describe('hard link stores', () => {
  let store;
  beforeEach(async () => {
    store = await addStore(storeDir, { mode: 'hardlink' });
  });

  test('finds node_modules recursively without entering one', async () => {
    makeProject('web/a');
    makeProject('web/b', { 'lib/index.js': BIG, 'foo/node_modules/bar/index.js': BIG });
    makeProject('mono/packages/c');
    makeProject('mono');
    const found = await findNodeModules([root]);
    assert.deepEqual(
      found.map((dir) => path.relative(root, dir).split(path.sep).join('/')),
      ['mono/node_modules', 'mono/packages/c/node_modules', 'web/a/node_modules', 'web/b/node_modules'],
    );
  });

  test('nested node_modules files are shared with their install', async () => {
    const nm = makeProject('a', { 'foo/node_modules/bar/index.js': BIG });
    const files = await listFiles(nm);
    assert.equal(files.length, 1);
    assert.match(files[0], /foo.node_modules.bar.index\.js$/);
  });

  test('identical files end up as one file on disk, with content intact', async () => {
    const a = makeProject('a');
    const b = makeProject('b');
    const result = await applyProjects(await projectsIn(root));
    const fileA = path.join(a, 'lib/index.js');
    const fileB = path.join(b, 'lib/index.js');
    assert.equal(ino(fileA), ino(fileB));
    assert.equal(readFileSync(fileA, 'utf8'), BIG);
    assert.equal(result.added, 1);
    assert.equal(result.linked, 1);
  });

  test('a later project links straight to what the store already holds', async () => {
    makeProject('a');
    await applyProjects(await projectsIn(root));
    const objectsBefore = (await storeStatus(store)).objects;

    const later = makeProject('later');
    const laterFile = path.join(later, 'lib/index.js');
    const before = ino(laterFile);
    const projects = await projectsIn(path.join(root, 'later'));
    const analysis = await analyze(projects);
    assert.equal(estimateSavings(analysis, [later]).total, 8192, 'a single project already saves against the store');

    const result = await applyProjects(projects);
    assert.equal(result.linked, 1);
    assert.equal(result.added, 0);
    assert.notEqual(ino(laterFile), before);
    assert.equal((await storeStatus(store)).objects, objectsBefore);
  });

  test('running twice changes nothing', async () => {
    makeProject('a');
    makeProject('b');
    await applyProjects(await projectsIn(root));
    const projects = await projectsIn(root);
    const analysis = await analyze(projects);
    assert.equal(estimateSavings(analysis, projects.map((project) => project.path)).total, 0);
    const result = await applyProjects(projects);
    assert.equal(result.linked + result.added, 0);
    assert.equal(result.already, 2);
  });

  test('same path with different content is never linked', async () => {
    const a = makeProject('a', { 'lib/index.js': `${BIG}a` });
    const b = makeProject('b', { 'lib/index.js': `${BIG}b` });
    await applyProjects(await projectsIn(root));
    assert.notEqual(ino(path.join(a, 'lib/index.js')), ino(path.join(b, 'lib/index.js')));
    assert.equal(readFileSync(path.join(a, 'lib/index.js'), 'utf8'), `${BIG}a`);
    assert.equal(readFileSync(path.join(b, 'lib/index.js'), 'utf8'), `${BIG}b`);
  });

  test('packages still resolve their sibling dependencies', async () => {
    const pad = `/*${BIG}*/`;
    makeProject('a', { 'lib/index.js': `${pad}module.exports=require("dep")`, 'dep/index.js': `${pad}module.exports="ok"` });
    makeProject('b', { 'lib/index.js': `${pad}module.exports=require("dep")`, 'dep/index.js': `${pad}module.exports="ok"` });
    await applyProjects(await projectsIn(root));
    const output = execFileSync(process.execPath, ['-p', 'require("lib")'], { cwd: path.join(root, 'a'), encoding: 'utf8' });
    assert.equal(output.trim(), 'ok');
  });

  test('deleting one project leaves the others intact, and gc frees only unused files', async () => {
    const a = makeProject('a', { 'shared.js': BIG, 'only-a.js': `${BIG}a` });
    const b = makeProject('b', { 'shared.js': BIG });
    await applyProjects(await projectsIn(root));
    rmSync(path.join(root, 'a'), { recursive: true });
    assert.equal(readFileSync(path.join(b, 'shared.js'), 'utf8'), BIG);
    assert.ok(!existsSync(a));

    const preview = await collectGarbage(store, { dryRun: true });
    assert.equal(preview.removed, 1);
    assert.equal((await storeStatus(store)).objects, 2, 'dry run deletes nothing');
    await collectGarbage(store);
    assert.equal((await storeStatus(store)).objects, 1);
    assert.equal(readFileSync(path.join(b, 'shared.js'), 'utf8'), BIG);
  });

  test('undo makes a project independent of the others', async () => {
    const a = makeProject('a');
    const b = makeProject('b');
    await applyProjects(await projectsIn(root));
    const projects = await projectsIn(path.join(root, 'a'));
    const result = await undoProjects(projects);
    assert.equal(result.restored, 1);
    writeFileSync(path.join(a, 'lib/index.js'), 'edited');
    assert.equal(readFileSync(path.join(b, 'lib/index.js'), 'utf8'), BIG);
  });

  test('an object edited in place is quarantined and does not spread', async () => {
    const a = makeProject('a');
    await applyProjects(await projectsIn(root));
    writeFileSync(path.join(a, 'lib/index.js'), `${BIG}EDITED`);

    const verify = await verifyStore(store);
    assert.equal(verify.corrupted.length, 1);

    const c = makeProject('c');
    const result = await applyProjects(await projectsIn(path.join(root, 'c')));
    assert.equal(result.corrupted.length, 1);
    assert.equal(readFileSync(path.join(c, 'lib/index.js'), 'utf8'), BIG, 'the clean file keeps its content');
    assert.equal((await verifyStore(store)).corrupted.length, 0, 'the bad object is out of circulation');
  });

  test('package-manager metadata, caches and small files are left alone', async () => {
    const nm = makeProject('a', {
      '.package-lock.json': BIG,
      '.cache/x.js': BIG,
      'lib/.cache/y.js': BIG,
      'lib/small.js': 'tiny',
      'lib/index.js': BIG,
    });
    const files = await listFiles(nm);
    assert.ok(!files.some((file) => file.includes('.cache') || file.includes('.package-lock')));
    const result = await applyProjects(await projectsIn(path.join(root, 'a')));
    assert.equal(result.added, 1);
    assert.notEqual(statSync(path.join(nm, 'lib/small.js'), { bigint: true }).nlink, 2n);
  });

  test('risky projects are flagged and not eligible by default', async () => {
    makeProject('plain');
    makeProject('pn', { '.pnpm/x.js': BIG });
    makeProject('patched');
    write('patched/patches/foo.patch', 'x');
    makeProject('OneDrive/synced');
    const projects = await projectsIn(root);
    const flagsOf = (name) => projects.find((project) => project.projectDir.endsWith(name)).flags;
    assert.deepEqual(flagsOf('plain'), []);
    assert.deepEqual(flagsOf('pn'), ['pnpm']);
    assert.deepEqual(flagsOf('patched'), ['patched']);
    assert.deepEqual(flagsOf('synced'), ['synced']);
    assert.equal(projects.filter((project) => isEligible(project)).length, 1);
    const patched = projects.find((project) => project.projectDir.endsWith('patched'));
    assert.ok(isEligible(patched, ['patched']));
    assert.ok(!isEligible(projects.find((project) => project.projectDir.endsWith('pn')), ['patched', 'synced']));
  });

  test('a project on a volume without a store is not eligible', async () => {
    makeProject('a');
    const [project] = await Promise.all((await findNodeModules([root])).map((nmDir) => describeProject(nmDir, [])));
    assert.deepEqual(project.flags, ['no-store']);
    assert.ok(!isEligible(project, ['patched', 'synced']));
  });

  test('read-only files are shared and remain deletable', async () => {
    const a = makeProject('a');
    const b = makeProject('b');
    const fileB = path.join(b, 'lib/index.js');
    await fs.chmod(fileB, 0o444);
    // POSIX keeps different permissions apart by design, so both must match there.
    if (process.platform !== 'win32') await fs.chmod(path.join(a, 'lib/index.js'), 0o444);
    await applyProjects(await projectsIn(root));
    assert.equal(ino(path.join(a, 'lib/index.js')), ino(fileB));
    rmSync(path.join(root, 'b'), { recursive: true, force: true });
    assert.equal(readFileSync(path.join(a, 'lib/index.js'), 'utf8'), BIG);
  });

  test('files with different permissions are kept apart', { skip: process.platform === 'win32' }, async () => {
    const a = makeProject('a');
    const b = makeProject('b');
    await fs.chmod(path.join(a, 'lib/index.js'), 0o755);
    await applyProjects(await projectsIn(root));
    assert.notEqual(ino(path.join(a, 'lib/index.js')), ino(path.join(b, 'lib/index.js')));
    assert.equal(statSync(path.join(a, 'lib/index.js')).mode & 0o777, 0o755);
  });

  test('symlinks inside node_modules are not followed or replaced', { skip: process.platform === 'win32' }, async () => {
    const a = makeProject('a');
    await fs.symlink(path.join(a, 'lib'), path.join(a, 'linked'));
    assert.equal((await listFiles(a)).length, 1);
  });

  test('passing the NTFS link limit keeps every file valid', { skip: process.platform !== 'win32' }, async () => {
    const files = {};
    for (let index = 0; index < 1030; index += 1) files[`p${index}/f.js`] = BIG;
    const nm = makeProject('a', files);
    const result = await applyProjects(await projectsIn(root));
    assert.equal(result.skippedCount, 0);
    assert.equal(result.added, 2, 'a second object starts when the first is full');
    assert.equal(readFileSync(path.join(nm, 'p1029/f.js'), 'utf8'), BIG);
  });

  test('a second store on the same volume is refused', async () => {
    await assert.rejects(addStore(path.join(root, 'store2'), { mode: 'hardlink' }), /already has a store/);
  });
});

describe('clone stores', () => {
  // The logic is exercised everywhere; a real reflink needs a supporting filesystem.
  const clone = (from, to) => plainCopy(from, to);
  let store;
  beforeEach(async () => {
    store = await addStore(storeDir, { mode: 'clone' });
  });

  test('keeps files independent, skips work on re-run, and tracks usage for gc', async () => {
    const a = makeProject('a');
    const b = makeProject('b');
    const first = await applyProjects(await projectsIn(root), { cloneFn: clone });
    assert.equal(first.added, 1);
    assert.equal(first.linked, 1);

    const second = await applyProjects(await projectsIn(root), { cloneFn: clone });
    assert.equal(second.already, 2);
    const projects = await projectsIn(root);
    const analysis = await analyze(projects);
    assert.equal(estimateSavings(analysis, projects.map((project) => project.path)).total, 0);

    writeFileSync(path.join(a, 'lib/index.js'), 'edited');
    assert.equal(readFileSync(path.join(b, 'lib/index.js'), 'utf8'), BIG, 'clones do not share edits');
    assert.equal((await verifyStore(store)).corrupted.length, 0);

    assert.equal((await collectGarbage(store)).removed, 0);
    rmSync(path.join(root, 'a'), { recursive: true });
    rmSync(path.join(root, 'b'), { recursive: true });
    assert.equal((await collectGarbage(store)).removed, 1);
    assert.equal((await storeStatus(store)).objects, 0);
  });

  test('uses a real reflink where the filesystem supports one', async (t) => {
    const source = write('real/source.js');
    try {
      await cloneFile(source, path.join(root, 'real/clone.js'));
    } catch {
      t.skip('this filesystem has no reflinks');
      return;
    }
    const a = makeProject('a');
    makeProject('b');
    const result = await applyProjects(await projectsIn(path.join(root, 'a'), path.join(root, 'b')));
    assert.equal(result.skippedCount, 0);
    assert.equal(result.linked, 1);
    assert.equal(readFileSync(path.join(a, 'lib/index.js'), 'utf8'), BIG);
  });
});

describe('command line', () => {
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    input: '',
    env: { ...process.env, NO_COLOR: '1' },
  });

  test('full flow: init, scan changes nothing, apply needs consent, gc, status', async () => {
    assert.equal(run('init', '--store', storeDir).status, 0);
    const a = makeProject('a');
    const b = makeProject('b');
    const fileA = path.join(a, 'lib/index.js');
    const fileB = path.join(b, 'lib/index.js');
    const dir = path.join(root, '.');

    const scan = run('scan', dir, '--json');
    assert.equal(scan.status, 0);
    const report = JSON.parse(scan.stdout);
    assert.equal(report.projects.length, 2);
    assert.equal(report.savings, 8192);
    assert.notEqual(ino(fileA), ino(fileB), 'scan must not change files');

    const refused = run('apply', dir);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /--yes/);
    assert.notEqual(ino(fileA), ino(fileB));

    assert.equal(run('apply', dir, '--yes').status, 0);
    const { mode } = (await loadStores()).stores[0];
    if (mode === 'hardlink') assert.equal(ino(fileA), ino(fileB));
    assert.match(run('status').stdout, /1 file\(s\)/);
    assert.equal(run('verify').status, 0);
    assert.equal(run('undo', dir, '--yes').status, 0);
    assert.notEqual(ino(fileA), ino(fileB));
    assert.match(run('gc').stdout, /removed 1 unused/);
  });

  test('explains missing setup and rejects bad options', () => {
    const noStore = run('scan', root);
    assert.equal(noStore.status, 2);
    assert.match(noStore.stderr, /nm-manager init/);
    assert.equal(run('scan', root, '--bogus').status, 2);
    assert.equal(run('nonsense').status, 2);
  });
});

describe('web interface security', () => {
  let server;
  let url;
  let token;
  let origin;
  before(async () => {
    process.env.NM_MANAGER_CONFIG = path.join(os.tmpdir(), `nm-ui-${process.pid}.json`);
    ({ server, url, token } = await startServer({ open: false }));
    origin = new URL(url).origin;
  });
  after(() => {
    server.close();
    rmSync(`${path.join(os.tmpdir(), `nm-ui-${process.pid}.json`)}`, { force: true });
  });
  const call = (route, { headers = { 'x-nm-token': token }, method = 'POST', body = {} } = {}) =>
    fetch(origin + route, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined });

  test('binds to loopback only', () => {
    assert.equal(server.address().address, '127.0.0.1');
  });

  test('the page and API need the token', async () => {
    assert.equal((await fetch(origin)).status, 403);
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await call('/api/state', { method: 'GET', headers: {} })).status, 403);
    assert.equal((await call('/api/state', { method: 'GET' })).status, 200);
  });

  test('requests from other origins are refused even with the token', async () => {
    const response = await call('/api/state', { method: 'GET', headers: { 'x-nm-token': token, origin: 'https://evil.example' } });
    assert.equal(response.status, 403);
  });

  test('apply only accepts folders from the latest scan', async () => {
    const response = await call('/api/apply', { body: { paths: ['/etc'] } });
    assert.equal(response.status, 400);
    const bad = await call('/api/scan', { body: { dirs: [''] } });
    assert.equal(bad.status, 400);
  });
});
