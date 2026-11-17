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

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function payloadOf(entry) {
  const { hash, prev, ...payload } = entry;
  return payload;
}

function load(path, { readOnly = false } = {}) {
  if (!existsSync(path)) return { entries: [], repaired: null };
  const text = readFileSync(path, 'utf8');
  if (text === '') return { entries: [], repaired: null };

  const lines = text.split('\n');
  // A file ending in a newline splits into a trailing ''. Anything else in last place was never
  // finished, which is what a crash during the append leaves behind.
  const tail = lines.pop();
  let repaired = null;
  if (tail !== '') {
    repaired = `removed a torn final line (${tail.length} bytes) left by a write that did not finish; the call it announced never started`;
  }

  const entries = [];
  let prev = GENESIS_PREV;
  lines.forEach((line, index) => {
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

export class Journal {
  #path;
  #entries;
  #appendLine;

  /** repaired: null, or a sentence saying what was removed on load. */
  repaired;

  constructor(path, entries, repaired, appendLine) {
    this.#path = path;
    this.#entries = entries;
    this.repaired = repaired;
    this.#appendLine = appendLine;
  }

  /**
   * Opens (and, on the first append, creates) the journal at path. `appendLine` is injectable so a
   * test can make a write fail at an exact point, which is how the crash tests simulate a crash.
   */
  static open(path, { appendLine = (target, text) => appendFileSync(target, text), readOnly = false } = {}) {
    // readOnly: for --plan, which must write nothing, so a torn tail is reported and left in place.
    const { entries, repaired } = load(path, { readOnly });
    return new Journal(path, entries, repaired, appendLine);
  }

  entries() {
    return [...this.#entries];
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
    return written;
  }
}
