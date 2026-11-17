// One tick at a time per state directory. docs/INBOUND-SPEC.md, "One tick at a time".
//
// Review pass 1, B1: two `inbound` processes on one state directory both read the journal before
// either appended, both claimed the lead, both posted to Slack, and the journal then failed its chain
// on every later run. The tick now holds an exclusive lock on the state directory from before the
// journal is opened until after the last write. A second process refuses INBOUND_LOCKED, exit 3, and
// writes nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Journal } from '../src/inbound/journal.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'signal-desk.mjs');
const T0 = '2026-03-01T09:00:00.000Z';
const STATE = (cwd) => join(cwd, 'runs', 'inbound-fixture');

let template;
function sandbox() {
  if (template === undefined) {
    template = mkdtempSync(join(tmpdir(), 'signal-desk-lock-template-'));
    const made = spawnSync(process.execPath, [BIN, 'run'], { cwd: template, encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
  }
  const cwd = mkdtempSync(join(tmpdir(), 'signal-desk-lock-'));
  cpSync(template, cwd, { recursive: true });
  return cwd;
}

function inbound(cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'inbound', '--at', T0], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function snapshot(dir) {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
}

test('B1: processes started together on one state directory claim once, post once, and leave an intact chain', async (t) => {
  const REPETITIONS = 25;
  const PROCESSES = 4;
  let lockedSeen = 0;
  for (let rep = 0; rep < REPETITIONS; rep += 1) {
    const cwd = sandbox();
    const results = await Promise.all(Array.from({ length: PROCESSES }, () => inbound(cwd)));
    for (const r of results) {
      assert.ok(r.code === 0 || r.code === 3, `exit ${r.code}: ${r.err}`);
      if (r.code === 3) {
        lockedSeen += 1;
        assert.match(r.err, /INBOUND_LOCKED/);
      }
    }
    const entries = Journal.open(join(STATE(cwd), 'journal.jsonl')).entries();
    assert.equal(entries.filter((e) => e.type === 'claim').length, 1, `repetition ${rep}: one claim`);
    const slack = JSON.parse(readFileSync(join(STATE(cwd), 'slack.json'), 'utf8'));
    assert.equal(slack.posts.length, 1, `repetition ${rep}: one post`);
    assert.ok(!existsSync(join(STATE(cwd), 'lock')), 'the lock is released');
  }
  // The OS schedules the race; this records that it happened, so a green run is not a serial one.
  assert.ok(lockedSeen > 0, 'at least one process found the lock held');
  t.diagnostic(`INBOUND_LOCKED seen ${lockedSeen} time(s) in ${REPETITIONS * PROCESSES} processes`);
});

test('B1: a lock held by a live process refuses INBOUND_LOCKED, exit 3, naming the holder, and writes nothing', async () => {
  const cwd = sandbox();
  mkdirSync(STATE(cwd), { recursive: true });
  writeFileSync(join(STATE(cwd), 'lock'), JSON.stringify({ pid: process.pid, host: hostname(), started_at: T0 }));
  const before = snapshot(STATE(cwd));
  const result = await inbound(cwd);
  assert.equal(result.code, 3, result.err);
  assert.match(result.err, /INBOUND_LOCKED/);
  assert.match(result.err, new RegExp(`pid ${process.pid}`));
  assert.deepEqual(snapshot(STATE(cwd)), before, 'nothing was written');
});

test('B1: a lock left by a process that is no longer running on this host is stale, and the tick proceeds', async () => {
  const cwd = sandbox();
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(dead.stdout);
  mkdirSync(STATE(cwd), { recursive: true });
  writeFileSync(join(STATE(cwd), 'lock'), JSON.stringify({ pid: deadPid, host: hostname(), started_at: T0 }));
  const result = await inbound(cwd);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /ASSIGNED/);
  assert.match(result.out, /stale lock/);
  assert.ok(!existsSync(join(STATE(cwd), 'lock')));
});

test('B1: a lock from another host is never judged stale here', async () => {
  const cwd = sandbox();
  mkdirSync(STATE(cwd), { recursive: true });
  writeFileSync(join(STATE(cwd), 'lock'), JSON.stringify({ pid: 999999, host: 'some-other-host', started_at: T0 }));
  const result = await inbound(cwd);
  assert.equal(result.code, 3);
  assert.match(result.err, /INBOUND_LOCKED/);
  assert.match(result.err, /some-other-host/);
});
