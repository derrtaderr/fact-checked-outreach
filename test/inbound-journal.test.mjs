// The inbound journal. docs/INBOUND-SPEC.md, "The journal".
//
// Append-only, hash-chained, one line per fact, written with a single append so a crash leaves at
// most one torn final line. A torn final line is removed on load, because the call it announced had
// not started. Anything else that does not verify is refused, and nothing is called.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Journal, JournalTamperedError } from '../src/inbound/journal.mjs';

const file = () => join(mkdtempSync(join(tmpdir(), 'signal-desk-journal-')), 'journal.jsonl');

test('a fresh journal has no entries and creates nothing until the first append', () => {
  const path = file();
  const journal = Journal.open(path);
  assert.deepEqual(journal.entries(), []);
  assert.equal(journal.repaired, null);
});

test('appended lines survive a reopen, in order, each chained to the one before', () => {
  const path = file();
  const journal = Journal.open(path);
  journal.append({ type: 'claim', key: 'sig-1', at: '2026-03-01T09:00:00.000Z' });
  journal.append({ type: 'crm_written', key: 'sig-1', at: '2026-03-01T09:00:01.000Z' });

  const reopened = Journal.open(path);
  const entries = reopened.entries();
  assert.deepEqual(entries.map((e) => e.type), ['claim', 'crm_written']);
  assert.equal(entries[1].prev, entries[0].hash);
  assert.match(entries[0].hash, /^[0-9a-f]{64}$/);
});

test('each append is one write ending in a newline, so the file is valid JSONL after every append', () => {
  const path = file();
  const journal = Journal.open(path);
  journal.append({ type: 'claim', key: 'a', at: 't' });
  const text = readFileSync(path, 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.equal(text.split('\n').filter(Boolean).length, 1);
});

test('a torn final line (a crash mid-write) is removed on load and reported, and appends continue the chain', () => {
  const path = file();
  const journal = Journal.open(path);
  journal.append({ type: 'claim', key: 'a', at: 't1' });
  appendFileSync(path, '{"type":"crm_wri');

  const reopened = Journal.open(path);
  assert.equal(reopened.entries().length, 1);
  assert.match(reopened.repaired, /torn final line/);
  reopened.append({ type: 'crm_written', key: 'a', at: 't2' });
  const again = Journal.open(path);
  assert.deepEqual(again.entries().map((e) => e.type), ['claim', 'crm_written']);
  assert.equal(again.repaired, null);
});

test('an edited line is refused as JOURNAL_TAMPERED, with the line number', () => {
  const path = file();
  const journal = Journal.open(path);
  journal.append({ type: 'claim', key: 'a', rep_id: 'ana', at: 't1' });
  journal.append({ type: 'crm_written', key: 'a', at: 't2' });
  const text = readFileSync(path, 'utf8').replace('"ana"', '"ben"');
  writeFileSync(path, text);
  assert.throws(() => Journal.open(path), (error) => {
    assert.ok(error instanceof JournalTamperedError);
    assert.equal(error.code, 'JOURNAL_TAMPERED');
    assert.match(error.message, /line 1/);
    return true;
  });
});

test('an unparseable line that is not the last one is tampering, not a torn write', () => {
  const path = file();
  const journal = Journal.open(path);
  journal.append({ type: 'claim', key: 'a', at: 't1' });
  appendFileSync(path, 'garbage\n');
  journal.append({ type: 'claim', key: 'b', at: 't2' });
  assert.throws(() => Journal.open(path), JournalTamperedError);
});

test('an append whose write throws leaves the in-memory journal unchanged', () => {
  const path = file();
  let fail = false;
  const journal = Journal.open(path, {
    appendLine: (target, text) => {
      if (fail) throw new Error('simulated crash');
      appendFileSync(target, text);
    },
  });
  journal.append({ type: 'claim', key: 'a', at: 't1' });
  fail = true;
  assert.throws(() => journal.append({ type: 'crm_written', key: 'a', at: 't2' }), /simulated crash/);
  assert.equal(journal.entries().length, 1);
});
