import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// Delete only a dead owner's unique marker. Never recursively remove a lock:
// another process may already have acquired a replacement directory.
export function removeStaleLoginLaunchLock(lock) {
  try {
    const names = readdirSync(lock);
    if (!names.length && Date.now() - statSync(lock).mtimeMs < 5000) return false;
    for (const name of names) {
      const match = /^(\d+)-[a-f0-9-]+\.owner$/.exec(name);
      if (!match || alive(Number(match[1]))) return false;
    }
    for (const name of names) {
      try { unlinkSync(join(lock, name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    rmdirSync(lock);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) return false;
    throw error;
  }
}

export function acquireLoginLaunchLock(lock) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (removeStaleLoginLaunchLock(lock)) continue;
      return undefined;
    }
    const owner = join(lock, `${process.pid}-${randomUUID()}.owner`);
    const release = () => {
      try { unlinkSync(owner); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { rmdirSync(lock); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    };
    try {
      const before = statSync(lock);
      writeFileSync(owner, '', { flag: 'wx', mode: 0o600 });
      const after = statSync(lock);
      // A reaper may remove an empty directory just before our owner marker is
      // written. Validate identity before entering the protected section.
      if (before.dev === after.dev && before.ino === after.ino) return release;
      release();
    } catch (error) {
      release();
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}
