import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listFiles, TEMP_PREFIX } from './scan.js';
import {
  cloneFile,
  hashFile,
  hashOfKey,
  objectKey,
  objectPath,
  quarantine,
  readManifest,
  removeManifest,
  writeManifest,
} from './store.js';
import { allocated, mapLimit, sleep } from './util.js';

// Below this a file usually lives inside the filesystem's own metadata record,
// so sharing it frees no clusters.
export const DEFAULT_MIN_SIZE = 1024;
const SKIPPED_LIST_LIMIT = 200;
const NTFS_LINK_LIMIT = 1023n;

const tempName = (dir) => path.join(dir, `${TEMP_PREFIX}${randomBytes(6).toString('hex')}`);
const lstat = (file) => fs.lstat(file, { bigint: true });
const sameFile = (a, b) => a.ino === b.ino && a.dev === b.dev;

const manifestEntry = (key, stat) => [key, Number(stat.size), Number(stat.mtimeMs), String(stat.ino)];
const manifestMatches = (entry, stat) =>
  entry && entry[1] === Number(stat.size) && entry[2] === Number(stat.mtimeMs) && entry[3] === String(stat.ino);

async function freeSpace(store) {
  const stat = await fs.statfs(store.path, { bigint: true });
  return Number(stat.bavail * stat.bsize);
}

/** Replaces a file atomically. Retries because antivirus and indexers hold files briefly. */
async function replaceFile(tmp, target) {
  const delays = [50, 200, 500];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmp, target);
      return;
    } catch (error) {
      if (attempt >= delays.length || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
      // Windows refuses to replace a read-only file.
      await fs.chmod(target, 0o666).catch(() => {});
      await sleep(delays[attempt]);
    }
  }
}

/** Hashes every shareable file so that savings can be estimated. Changes nothing. */
export async function analyze(projects, { minSize = DEFAULT_MIN_SIZE, onProgress } = {}) {
  const items = [];
  for (const project of projects) {
    const manifest = project.store.mode === 'clone' ? await readManifest(project.store, project.path) : null;
    for (const file of await listFiles(project.path)) items.push({ project, file, manifest });
  }
  const entries = new Map(projects.map((project) => [project.path, []]));
  const objectStats = new Map();
  let done = 0;
  await mapLimit(items, 16, async ({ project, file, manifest }) => {
    try {
      const stat = await lstat(file);
      if (stat.size >= BigInt(minSize)) {
        const relative = path.relative(project.path, file);
        const recorded = manifest?.files[relative];
        const known = manifestMatches(recorded, stat);
        const key = known ? recorded[0] : objectKey(await hashFile(file), stat.mode);
        const objectId = `${project.store.path}|${key}`;
        if (!objectStats.has(objectId)) {
          objectStats.set(objectId, await lstat(objectPath(project.store, key)).catch(() => null));
        }
        const object = objectStats.get(objectId);
        // `physical` identifies the bytes on disk, so already shared files count once.
        const physical = known || (object && sameFile(object, stat)) ? 'store' : String(stat.ino);
        entries.get(project.path).push({ objectId, physical, size: allocated(Number(stat.size)), inStore: Boolean(object) });
      }
    } catch {
      // Vanished or locked files are simply not counted; apply reports them.
    }
    done += 1;
    onProgress?.({ phase: 'hash', done, total: items.length });
  });
  return entries;
}

/** Estimates how much disk applying to the selected projects would free. */
export function estimateSavings(analysis, selectedPaths) {
  const seen = new Map();
  const perProject = {};
  let total = 0;
  for (const nmDir of selectedPaths) {
    let saved = 0;
    for (const entry of analysis.get(nmDir) ?? []) {
      if (entry.physical === 'store') continue;
      let copies = seen.get(entry.objectId);
      if (!copies) {
        copies = new Set();
        seen.set(entry.objectId, copies);
      }
      if (copies.has(entry.physical)) continue;
      // Without a store entry the first copy becomes it, and that one stays on disk.
      if (entry.inStore || copies.size > 0) saved += entry.size;
      copies.add(entry.physical);
    }
    perProject[nmDir] = saved;
    total += saved;
  }
  return { total, perProject };
}

class Linker {
  constructor(store, cloneFn) {
    this.store = store;
    this.cloneFn = cloneFn;
    this.verified = new Set();
    this.corrupted = new Set();
    this.locks = new Map();
  }

  /** Files with the same content are handled one at a time so they cannot race for the object. */
  withLock(key, task) {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(task, task);
    this.locks.set(key, run.catch(() => {}));
    return run;
  }

  /**
   * Returns the object's stat, or null if it is absent. The first use per run
   * re-hashes the object, so one edited in place cannot spread to more projects.
   */
  async usableObject(key) {
    const object = objectPath(this.store, key);
    const stat = await lstat(object).catch(() => null);
    if (!stat || this.verified.has(key)) return stat;
    if ((await hashFile(object)) === hashOfKey(key)) {
      this.verified.add(key);
      return stat;
    }
    await quarantine(this.store, key);
    this.corrupted.add(key);
    return null;
  }

  async addObject(file, key) {
    const object = objectPath(this.store, key);
    await fs.mkdir(path.dirname(object), { recursive: true });
    const tmp = tempName(path.dirname(object));
    if (this.store.mode === 'clone') {
      await this.cloneFn(file, tmp);
    } else {
      // A read-only file would make every future link read-only as well.
      if (process.platform === 'win32') await fs.chmod(file, 0o666).catch(() => {});
      await fs.link(file, tmp);
    }
    await fs.rename(tmp, object);
    this.verified.add(key);
  }

  async shareHardlink(file, stat, key) {
    const objectStat = await this.usableObject(key);
    if (!objectStat) {
      await this.addObject(file, key);
      return 'added';
    }
    if (sameFile(objectStat, stat)) return 'already';
    const tmp = tempName(path.dirname(file));
    try {
      await fs.link(objectPath(this.store, key), tmp);
    } catch (error) {
      // libuv reports the NTFS limit as UNKNOWN, so check the count there.
      const atNtfsLimit = process.platform === 'win32' && objectStat.nlink >= NTFS_LINK_LIMIT;
      if (error.code !== 'EMLINK' && !atNtfsLimit) throw error;
      // Existing links stay valid; this file simply becomes the object for later copies.
      await fs.rm(objectPath(this.store, key), { force: true });
      await this.addObject(file, key);
      return 'added';
    }
    await replaceFile(tmp, file);
    return 'linked';
  }

  async shareClone(file, stat, key, manifest, relative) {
    if (manifestMatches(manifest[relative], stat)) return 'already';
    let state = 'added';
    const objectStat = await this.usableObject(key);
    if (objectStat) {
      const tmp = tempName(path.dirname(file));
      await this.cloneFn(objectPath(this.store, key), tmp);
      await fs.utimes(tmp, Number(stat.atimeMs) / 1000, Number(stat.mtimeMs) / 1000);
      await replaceFile(tmp, file);
      state = 'linked';
    } else {
      await this.addObject(file, key);
    }
    manifest[relative] = manifestEntry(key, await lstat(file));
    return state;
  }
}

/** Shares the files of the selected projects through their stores. */
export async function applyProjects(projects, { minSize = DEFAULT_MIN_SIZE, onProgress, cloneFn = cloneFile } = {}) {
  const linkers = new Map();
  const result = { linked: 0, added: 0, already: 0, skippedCount: 0, skipped: [], corrupted: [], freed: {} };
  const skip = (file, code) => {
    result.skippedCount += 1;
    if (result.skipped.length < SKIPPED_LIST_LIMIT) result.skipped.push({ file, code });
  };
  const items = [];
  const manifests = new Map();
  const freeBefore = new Map();
  for (const project of projects) {
    const { store } = project;
    if (!linkers.has(store.path)) {
      linkers.set(store.path, new Linker(store, cloneFn));
      freeBefore.set(store.path, await freeSpace(store));
    }
    if (store.mode === 'clone') {
      manifests.set(project.path, (await readManifest(store, project.path))?.files ?? {});
    }
    for (const file of await listFiles(project.path, { removeStaleTemp: true })) items.push({ project, file });
  }
  let done = 0;
  await mapLimit(items, 16, async ({ project, file }) => {
    const linker = linkers.get(project.store.path);
    try {
      const stat = await lstat(file);
      if (stat.size >= BigInt(minSize)) {
        const hash = await hashFile(file);
        const key = objectKey(hash, stat.mode);
        const state = await linker.withLock(key, async () => {
          const current = await lstat(file);
          // The file changed after hashing, so the hash no longer describes it.
          if (current.mtimeMs !== stat.mtimeMs || current.size !== stat.size) return 'changed';
          if (project.store.mode === 'clone') {
            return linker.shareClone(file, current, key, manifests.get(project.path), path.relative(project.path, file));
          }
          return linker.shareHardlink(file, current, key);
        });
        if (state === 'changed') skip(file, 'CHANGED');
        else result[state] += 1;
      }
    } catch (error) {
      skip(file, error.code ?? error.message);
    }
    done += 1;
    onProgress?.({ phase: 'link', done, total: items.length });
  });
  for (const project of projects) {
    if (project.store.mode === 'clone') await writeManifest(project.store, project.path, manifests.get(project.path));
  }
  for (const [storePath, linker] of linkers) {
    result.corrupted.push(...linker.corrupted);
    result.freed[storePath] = (await freeSpace(linker.store)) - freeBefore.get(storePath);
  }
  return result;
}

/**
 * Gives a project its own independent copy of every shared file again. Clones
 * are already independent, so only their bookkeeping is removed.
 */
export async function undoProjects(projects, { onProgress } = {}) {
  const result = { restored: 0, skippedCount: 0, skipped: [] };
  const work = [];
  const needed = new Map();
  for (const project of projects) {
    if (project.store?.mode === 'clone') {
      await removeManifest(project.store, project.path);
      continue;
    }
    for (const file of await listFiles(project.path, { removeStaleTemp: true })) {
      const stat = await lstat(file).catch(() => null);
      if (stat && stat.nlink > 1n) {
        work.push({ file, stat });
        if (project.store) {
          needed.set(project.store.path, (needed.get(project.store.path) ?? 0) + allocated(Number(stat.size)));
        }
      }
    }
  }
  for (const project of projects) {
    const required = project.store ? needed.get(project.store.path) : 0;
    if (required && required > (await freeSpace(project.store))) {
      throw new Error(`Undo needs ${required} free bytes on the volume of ${project.store.path}; nothing was changed.`);
    }
  }
  let done = 0;
  await mapLimit(work, 16, async ({ file, stat }) => {
    const tmp = tempName(path.dirname(file));
    try {
      await fs.copyFile(file, tmp);
      await fs.utimes(tmp, Number(stat.atimeMs) / 1000, Number(stat.mtimeMs) / 1000);
      await replaceFile(tmp, file);
      result.restored += 1;
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      result.skippedCount += 1;
      if (result.skipped.length < SKIPPED_LIST_LIMIT) result.skipped.push({ file, code: error.code ?? error.message });
    }
    done += 1;
    onProgress?.({ phase: 'undo', done, total: work.length });
  });
  return result;
}
