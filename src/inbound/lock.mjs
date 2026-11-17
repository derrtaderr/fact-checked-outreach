// One tick at a time per state directory. docs/INBOUND-SPEC.md, "One tick at a time".
//
// The journal is safe against a crash, not against a second writer: two processes that both read it
// before either appends both claim the lead, both post, and leave two lines chained to the same head.
// So a tick holds an exclusive lock on its state directory from before the journal is opened until
// after its last write.
//
// THE LOCK. `<state>/lock`, created with O_CREAT|O_EXCL ('wx'), which the OS makes atomic: of any
// number of processes creating it at once, exactly one succeeds. It holds the holder's pid, host and
// start instant, and only its holder removes it.
//
// THE STALE RULE, and why it cannot let two live processes in. A lock is stale only when its host is
// this host and its pid is not running (process.kill(pid, 0) answers ESRCH). Breaking it takes a
// second exclusive file, `<state>/lock.break`, so only one process breaks at a time; holding that, the
// breaker reads the lock AGAIN, and only if it is still the same stale holder does it remove it and
// then create its own lock with 'wx' like anyone else. Nobody can replace a stale lock except a
// breaker (its holder is dead, so it will not remove it), so the lock the breaker removes is the
// stale one it judged. A process that starts in between simply wins the 'wx' create and the breaker
// refuses. A pid reused by an unrelated live process makes the lock look live: the safe direction.
// A lock from another host is never judged stale here. A `lock.break` left by a crash in the few
// microseconds of a break is not broken automatically; the refusal names it for a person.

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export class InboundLockedError extends Error {
  constructor(path, holder, problem) {
    super(
      `${problem}: ${path}${holder ? ` (pid ${holder.pid} on ${holder.host}, started ${holder.started_at})` : ''}. ` +
        'Another inbound tick is using this state directory, so this one stopped before reading the journal. ' +
        'Nothing was written, and nothing was called except, on a live tick, the Slack scope check (auth.test, which writes nothing). ' +
        'If no tick is running, see the README, "One tick at a time".',
    );
    this.name = 'InboundLockedError';
    this.code = 'INBOUND_LOCKED';
  }
}

function readHolder(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    // A lock file that is not JSON was torn by a crash during its own create; treat it as a holder we
    // cannot judge, so it is never broken automatically.
    return { pid: null, host: 'unknown', started_at: 'unknown' };
  }
}

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function isStale(holder, here) {
  return holder !== null && holder.host === here && Number.isSafeInteger(holder.pid) && holder.pid > 0 && !running(holder.pid);
}

function create(path, record) {
  const fd = openSync(path, 'wx');
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
}

const same = (a, b) => a !== null && b !== null && a.pid === b.pid && a.host === b.host && a.started_at === b.started_at;

/**
 * Takes the lock on stateDir (which must exist). Returns { release, broke } where broke is null or a
 * sentence about the stale lock that was removed. Throws InboundLockedError when another holds it.
 */
export function acquireLock(stateDir, { now = () => new Date().toISOString(), pid = process.pid } = {}) {
  const path = join(stateDir, 'lock');
  const here = hostname();
  const record = { pid, host: here, started_at: now() };
  let broke = null;

  try {
    create(path, record);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const holder = readHolder(path);
    if (!isStale(holder, here)) throw new InboundLockedError(path, holder, 'INBOUND_LOCKED');

    const breaker = join(stateDir, 'lock.break');
    try {
      create(breaker, record);
    } catch (inner) {
      if (inner?.code !== 'EEXIST') throw inner;
      throw new InboundLockedError(breaker, readHolder(breaker), 'INBOUND_LOCKED: another process is breaking a stale lock, or one crashed while breaking it; if no tick is running, remove');
    }
    try {
      if (same(readHolder(path), holder)) {
        unlinkSync(path);
        broke = `removed a stale lock left by pid ${holder.pid}, which started ${holder.started_at} on this host and is no longer running`;
      }
    } finally {
      unlinkSync(breaker);
    }
    try {
      create(path, record);
    } catch (again) {
      if (again?.code !== 'EEXIST') throw again;
      throw new InboundLockedError(path, readHolder(path), 'INBOUND_LOCKED');
    }
  }

  return {
    broke,
    release() {
      // Only the holder removes its lock, and only its own: nobody else can have replaced a live lock.
      if (same(readHolder(path), record)) unlinkSync(path);
    },
  };
}
