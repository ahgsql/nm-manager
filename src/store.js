import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream, existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allocated, mapLimit } from './util.js';

const META_FILE = 'nm-store.json';

export const cloneFile = (from, to) => fs.copyFile(from, to, constants.COPYFILE_FICLONE_FORCE);

export function configPath() {
  if (process.env.NM_MANAGER_CONFIG) return process.env.NM_MANAGER_CONFIG;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'nm-manager', 'config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'nm-manager', 'config.json');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'nm-manager', 'config.json');
}

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(configPath(), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { stores: [] };
    throw new Error(`Cannot read config ${configPath()}: ${error.message}`);
  }
}

async function writeConfig(config) {
  const target = configPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`);
  await fs.rename(tmp, target);
}

/** Default store locations: one per Windows drive, or one in the home directory. */
export function suggestStores() {
  if (process.platform !== 'win32') return [path.join(os.homedir(), '.nm-store')];
  const stores = [];
  for (let code = 67; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (existsSync(root)) stores.push(`${root}.nm-store`);
  }
  return stores;
}

/** Finds the best sharing mechanism by trying it, because support varies per volume. */
async function detectMode(dir) {
  const probe = path.join(dir, `.probe-${randomBytes(4).toString('hex')}`);
  const target = `${probe}-2`;
  await fs.writeFile(probe, 'probe');
  try {
    try {
      await cloneFile(probe, target);
      return 'clone';
    } catch {
      await fs.rm(target, { force: true });
    }
    await fs.link(probe, target);
    return 'hardlink';
  } catch (error) {
    throw new Error(`This volume supports neither reflinks nor hard links (${error.code}).`);
  } finally {
    await fs.rm(probe, { force: true });
    await fs.rm(target, { force: true });
  }
}

async function describe(storePath) {
  const meta = JSON.parse(await fs.readFile(path.join(storePath, META_FILE), 'utf8'));
  const { dev } = await fs.stat(storePath, { bigint: true });
  return { path: storePath, mode: meta.mode, dev };
}

/** Creates a store (or registers an existing one). A volume can only have one. */
export async function addStore(storePath, { mode } = {}) {
  const resolved = path.resolve(storePath);
  await fs.mkdir(path.join(resolved, 'objects'), { recursive: true });
  const metaPath = path.join(resolved, META_FILE);
  if (!existsSync(metaPath)) {
    const detected = mode ?? (await detectMode(resolved));
    await fs.writeFile(metaPath, `${JSON.stringify({ version: 1, mode: detected }, null, 2)}\n`);
  }
  const store = await describe(resolved);
  const { stores: known } = await loadStores();
  const sameVolume = known.find((other) => other.dev === store.dev && other.path !== resolved);
  if (sameVolume) {
    throw new Error(`This volume already has a store at ${sameVolume.path}.`);
  }
  const config = await readConfig();
  if (!config.stores.includes(resolved)) {
    config.stores.push(resolved);
    await writeConfig(config);
  }
  return store;
}

/** Loads configured stores. Missing ones are reported, not fatal: a USB drive may be unplugged. */
export async function loadStores() {
  const config = await readConfig();
  const stores = [];
  const missing = [];
  for (const storePath of config.stores) {
    try {
      stores.push(await describe(storePath));
    } catch {
      missing.push(storePath);
    }
  }
  return { stores, missing };
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Hard links share permissions, so files that differ in mode must not share an
 * entry. Windows has no meaningful mode bits here.
 */
export function objectKey(hash, mode) {
  return process.platform === 'win32' ? hash : `${hash}-${(Number(mode) & 0o777).toString(8)}`;
}

export const hashOfKey = (key) => key.split('-')[0];
export const objectPath = (store, key) => path.join(store.path, 'objects', key.slice(0, 2), key);

async function listObjects(store) {
  const root = path.join(store.path, 'objects');
  const objects = [];
  for (const prefix of await fs.readdir(root)) {
    const dir = path.join(root, prefix);
    for (const name of await fs.readdir(dir)) objects.push({ name, file: path.join(dir, name), isTemp: name.startsWith('.nmtmp-') });
  }
  return objects;
}

// Clone-mode bookkeeping: clones have no link count, so usage is recorded per project.
const manifestDir = (store) => path.join(store.path, 'projects');
const manifestFile = (store, nmDir) =>
  path.join(manifestDir(store), `${createHash('sha256').update(nmDir).digest('hex')}.json`);

export async function readManifest(store, nmDir) {
  try {
    return JSON.parse(await fs.readFile(manifestFile(store, nmDir), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeManifest(store, nmDir, files) {
  await fs.mkdir(manifestDir(store), { recursive: true });
  await fs.writeFile(manifestFile(store, nmDir), JSON.stringify({ path: nmDir, files }));
}

export const removeManifest = (store, nmDir) => fs.rm(manifestFile(store, nmDir), { force: true });

async function readManifests(store) {
  const dir = manifestDir(store);
  if (!existsSync(dir)) return [];
  const names = await fs.readdir(dir);
  return Promise.all(
    names.map(async (name) => ({
      file: path.join(dir, name),
      ...JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')),
    })),
  );
}

/** Which objects are still in use by a project. Clone stores answer from manifests. */
async function usageChecker(store, { pruneManifests }) {
  if (store.mode !== 'clone') {
    return async (object) => (await fs.stat(object.file, { bigint: true })).nlink > 1n;
  }
  const used = new Set();
  for (const manifest of await readManifests(store)) {
    if (!existsSync(manifest.path)) {
      if (pruneManifests) await fs.rm(manifest.file, { force: true });
      continue;
    }
    for (const entry of Object.values(manifest.files)) used.add(entry[0]);
  }
  return async (object) => used.has(object.name);
}

/**
 * Deletes objects no project uses any more. Never touches project files, so it
 * cannot damage a project even if the usage answer were wrong.
 */
export async function collectGarbage(store, { dryRun = false } = {}) {
  const inUse = await usageChecker(store, { pruneManifests: !dryRun });
  const objects = await listObjects(store);
  let removed = 0;
  let bytes = 0;
  await mapLimit(objects, 32, async (object) => {
    const stat = await fs.stat(object.file);
    if (!object.isTemp && (await inUse(object))) return;
    removed += 1;
    if (!object.isTemp) bytes += allocated(stat.size);
    if (!dryRun) await fs.rm(object.file, { force: true });
  });
  return { removed, bytes };
}

/** Reports the store's size and, for hard links, how much sharing it is providing. */
export async function storeStatus(store) {
  const objects = (await listObjects(store)).filter((object) => !object.isTemp);
  const inUse = await usageChecker(store, { pruneManifests: false });
  const status = { objects: objects.length, bytes: 0, unused: 0, savedBytes: 0 };
  await mapLimit(objects, 32, async (object) => {
    const stat = await fs.stat(object.file, { bigint: true });
    const size = allocated(Number(stat.size));
    status.bytes += size;
    if (!(await inUse(object))) status.unused += 1;
    if (store.mode === 'hardlink' && stat.nlink > 2n) status.savedBytes += Number(stat.nlink - 2n) * size;
  });
  return status;
}

/** Moves an object whose content no longer matches its name out of circulation. */
export async function quarantine(store, key) {
  const dir = path.join(store.path, 'quarantine');
  await fs.mkdir(dir, { recursive: true });
  await fs.rename(objectPath(store, key), path.join(dir, `${key}.${Date.now()}`));
}

/** Re-hashes every object. A mismatch means a hard-linked file was edited in place. */
export async function verifyStore(store, { fix = false, onProgress } = {}) {
  const objects = (await listObjects(store)).filter((object) => !object.isTemp);
  const corrupted = [];
  let done = 0;
  await mapLimit(objects, 8, async (object) => {
    if ((await hashFile(object.file)) !== hashOfKey(object.name)) {
      corrupted.push(object.name);
      if (fix) await quarantine(store, object.name);
    }
    done += 1;
    onProgress?.({ phase: 'verify', done, total: objects.length });
  });
  return { checked: objects.length, corrupted };
}
