// The inbound journal. docs/INBOUND-SPEC.md, "The journal, and why a crash cannot skip, double-assign
// or double-post".
//
// One append-only JSONL file, hash-chained with the run ledger's own hash (src/ledger.mjs), so an
// edited line is detectable. The engine writes an intent line BEFORE every side effect and a result
// line AFTER it, and the state is a fold of these lines and nothing else.
//
// WHY APPEND, NOT REWRITE. The approval store rewrites its whole file on every decision, which is fine
// for a human typing one command. Here a crash can land between any two calls, and a rewrite that dies
// halfway loses every line, not just the new one. A single append of one line ending in a newline
// leaves, at worst, one torn line at the end.
//
// WHY A TORN FINAL LINE IS SAFE TO DROP. The engine makes a call only after the append announcing it
// has returned. An append that never finished never returned, so the call it announced never started.
// Any OTHER line that fails to parse or verify is not a crash artifact, and the journal is refused.

// WHY A HEAD FILE. A hash chain proves no line was edited, but not that none was REMOVED from the end:
// a journal cut back by whole lines still verifies, and the leads in the lost lines look new and are
// claimed and posted again. So the count of lines and the last hash also live outside the journal, in
// `<journal>.head`, written atomically (temp file, fsync, rename, fsync of the directory) after every
// append, which is itself fsynced. A journal that disagrees with its head is refused,
// JOURNAL_HEAD_MISMATCH, with one exception that a crash produces: the journal exactly one line ahead
// of the head, that line chained to the head's hash (the append landed, the head write did not).
// Blank lines (an editor's save) carry nothing and are skipped wherever they are.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import { GENESIS_PREV, hashEntry } from '../ledger.mjs';
import { canonical } from '../canonical.mjs';

export class JournalTamperedError extends Error {
  constructor(path, problem) {
    super(
      `the inbound journal at ${path} does not verify: ${problem}. It was edited after it was written, ` +
        'so the rotation pointer and every assignment in it are untrustworthy. No CRM or Slack call was made.',
    );
    this.name = 'JournalTamperedError';
    this.code = 'JOURNAL_TAMPERED';
  }
}

export class JournalHeadMismatchError extends Error {
  constructor(path, problem) {
    super(
      `the inbound journal at ${path} does not match its head file: ${problem}. Lines were removed or the ` +
        'head was deleted, so leads in the missing lines would look new and be claimed and posted again. ' +
        'No CRM or Slack call was made. If you know why, run the same command with --recover: it accepts the ' +
        'journal as it is, and on that tick looks for every Slack post by its marker before posting, so no rep ' +
        'is told twice (README, "Inbound last mile", recovery).',
    );
    this.name = 'JournalHeadMismatchError';
    this.code = 'JOURNAL_HEAD_MISMATCH';
  }
}

export const headPathOf = (path) => `${path.replace(/\.jsonl$/, '')}.head`;

function syncDir(dir, fsync) {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Some platforms cannot fsync a directory; the rename is still atomic.
  }
}

function writeHead(path, entries, fsync = fsyncSync) {
  const head = headPathOf(path);
  const temp = `${head}.tmp`;
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, `${JSON.stringify({ lines: entries.length, hash: entries.length === 0 ? GENESIS_PREV : entries[entries.length - 1].hash })}\n`);
    fsync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, head);
  syncDir(dirname(path), fsync);
}

function appendDurably(target, text, fsync = fsyncSync) {
  const fd = openSync(target, 'a');
  try {
    writeSync(fd, text);
    fsync(fd);
  } finally {
    closeSync(fd);
  }
}

function readHead(path) {
  const head = headPathOf(path);
  if (!existsSync(head)) return null;
  try {
    const parsed = JSON.parse(readFileSync(head, 'utf8'));
    if (Number.isSafeInteger(parsed?.lines) && typeof parsed?.hash === 'string') return parsed;
  } catch {
    // fall through
  }
  return { lines: -1, hash: 'unreadable' };
}

/** null when the journal agrees with its head (or is one crash-legitimate line ahead), else the problem. */
function headProblem(path, entries) {
  // No head yet reads as an empty one, so a crash between the very first append and its head write is
  // the ordinary one-line-ahead case.
  const head = readHead(path) ?? { lines: 0, hash: GENESIS_PREV, missing: true };
  if (head.lines === -1) return `the head file ${headPathOf(path)} is unreadable`;
  const at = (n) => (n === 0 ? GENESIS_PREV : entries[n - 1].hash);
  if (entries.length === head.lines && at(head.lines) === head.hash) return null;
  if (entries.length === head.lines + 1 && at(head.lines) === head.hash) return null;
  if (head.missing) return `the head file ${headPathOf(path)} is missing, and the journal has ${entries.length} line(s)`;
  if (entries.length < head.lines) return `the head says ${head.lines} line(s) and the journal has ${entries.length}`;
  return `the head says ${head.lines} line(s) ending in ${head.hash.slice(0, 12)}, and the journal does not have that line there`;
}

function payloadOf(entry) {
  const { hash, prev, ...payload } = entry;
  return payload;
}

function load(path, { readOnly = false } = {}) {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (text === '') return { entries: [], repaired: null };

  const lines = text.split('\n');
  // A file ending in a newline splits into a trailing ''. Anything else in last place was never
  // finished, which is what a crash during the append leaves behind. Whitespace alone is an editor's
  // trailing blank line, not a torn write.
  const tail = lines.pop();
  let repaired = null;
  if (tail.trim() !== '') {
    repaired = `removed a torn final line (${tail.length} bytes) left by a write that did not finish; the call it announced never started`;
  }

  const entries = [];
  let prev = GENESIS_PREV;
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new JournalTamperedError(path, `line ${index + 1} is not JSON`);
    }
    if (entry === null || typeof entry !== 'object' || entry.prev !== prev || entry.hash !== hashEntry(prev, payloadOf(entry))) {
      throw new JournalTamperedError(path, `line ${index + 1} does not chain to the line before it`);
    }
    prev = entry.hash;
    entries.push(Object.freeze(entry));
  });

  if (repaired !== null && !readOnly) {
    // Rewritten without the torn line, so the next append starts on a line of its own.
    writeFileSync(path, entries.map((entry) => `${canonical(entry)}\n`).join(''));
  }
  return { entries, repaired };
}

function verified(path, { readOnly = false, accept = false, fsync = fsyncSync } = {}) {
  const { entries, repaired } = load(path, { readOnly });
  const problem = headProblem(path, entries);
  let recovered = null;
  if (problem !== null) {
    if (!accept) throw new JournalHeadMismatchError(path, problem);
    recovered = `accepted the journal as it is (${entries.length} line(s)) although ${problem}; every Slack post this tick is looked for by marker before it is made`;
  }
  // Bring the head up to the journal: after a crash between an append and its head write, after an
  // accepted recovery, or for a journal with no head yet.
  if (!readOnly && entries.length > 0) {
    const head = readHead(path);
    const last = entries[entries.length - 1].hash;
    if (head === null || head.lines !== entries.length || head.hash !== last) writeHead(path, entries, fsync);
  }
  return { entries, repaired, recovered };
}

export class Journal {
  #path;
  #entries;
  #appendLine;

  /** repaired: null, or a sentence saying what was removed on load. */
  repaired;

  /** recovered: null, or a sentence saying a head mismatch was accepted with --recover. */
  recovered;

  #readOnly;

  #fsync;

  constructor(path, entries, repaired, appendLine, recovered = null, readOnly = false, fsync = fsyncSync) {
    this.#path = path;
    this.#entries = entries;
    this.repaired = repaired;
    this.recovered = recovered;
    this.#appendLine = appendLine;
    this.#readOnly = readOnly;
    this.#fsync = fsync;
  }

  /**
   * Opens (and, on the first append, creates) the journal at path. `appendLine` is injectable so a
   * test can make a write fail at an exact point, which is how the crash tests simulate a crash.
   */
  static open(path, { appendLine, readOnly = false, accept = false, fsync = fsyncSync } = {}) {
    // readOnly: for --plan, which must write nothing, so a torn tail is reported and left in place.
    // accept: --recover, which takes a journal that disagrees with its head as it is.
    // fsync: injectable like appendLine, so a test that appends thousands of lines need not wait on
    // the disk for each; every caller in src/ leaves it as fsyncSync.
    const { entries, repaired, recovered } = verified(path, { readOnly, accept, fsync });
    const append = appendLine ?? ((target, text) => appendDurably(target, text, fsync));
    return new Journal(path, entries, repaired, append, recovered, readOnly, fsync);
  }

  entries() {
    return [...this.#entries];
  }

  /** An in-memory copy that appends to nothing on disk, for --plan, which runs the tick on it. */
  scratch() {
    return new Journal(this.#path, [...this.#entries], this.repaired, () => {}, this.recovered, true);
  }

  head() {
    return this.#entries.length === 0 ? GENESIS_PREV : this.#entries[this.#entries.length - 1].hash;
  }

  /** Appends one fact. Memory changes only after the write returned. */
  append(record) {
    const prev = this.head();
    const written = Object.freeze({ ...record, prev, hash: hashEntry(prev, record) });
    mkdirSync(dirname(this.#path), { recursive: true });
    this.#appendLine(this.#path, `${canonical(written)}\n`);
    this.#entries.push(written);
    // After the line is durable. A crash before this leaves the journal one line ahead of the head,
    // which load accepts; the head is never ahead of the journal.
    if (!this.#readOnly) writeHead(this.#path, this.#entries, this.#fsync);
    return written;
  }
}
