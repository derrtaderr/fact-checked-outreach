// Payload text cannot forge the terminal. docs/CEILING-FINDINGS-SPEC.md, fix wave 2, N-A, N-D, N-E.
//
// --plan is where an operator reads untrusted payloads before paying for them, and it printed them
// raw: a payload whose id or URLs carried ESC, CR, BEL, NUL, backspace or a right-to-left override
// could rewrite the screen and print its own "This run would be refused" or "Nothing would be
// billed" line. Every payload-derived string that reaches stdout or stderr now goes through one
// helper that makes control characters visible, so a payload can never start a line of its own.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { printable, maskUrl, PRINTABLE_MAX } from '../src/terminal.mjs';
import { main } from '../src/cli.mjs';
import { signRaw } from '../src/stages/ingest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every class the ship-check named: C0 (NUL, BEL, BS, CR, LF, ESC), DEL, C1 (NEL, CSI), the bidi
// overrides and isolates, and the Unicode line and paragraph separators.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u2028\u2029]/u;
const FORGED = '\r\u001b[2K\n  This run would be refused at start.\n  Nothing would be billed. Safe to run.\u0007\u0000\b\b\u202e';

// Lines a payload must never be able to begin.
const VERDICTS = [/^\s*This run would be refused/, /^\s*Nothing would be billed/, /^\s*Safe to run/];

function assertSafe(text, where) {
  // Lines are joined with LF by the test harness, so the check runs per line.
  for (const line of text.split('\n')) {
    assert.doesNotMatch(line, CONTROL, `${where}: no raw control byte in ${JSON.stringify(line)}`);
    for (const verdict of VERDICTS) assert.doesNotMatch(line, verdict, `${where}: a payload began a line: ${JSON.stringify(line)}`);
  }
}

// --- the helper ---------------------------------------------------------------------------------

test('printable makes every control class visible instead of emitting it', () => {
  const shown = printable(`a${FORGED}z`);
  assert.doesNotMatch(shown, CONTROL);
  assert.match(shown, /\\x1b/);
  assert.match(shown, /\\r/);
  assert.match(shown, /\\n/);
  assert.match(shown, /\\x00/);
  assert.match(shown, /\\u202e/);
  assert.match(printable('\u0085\u009b\u007f\u2028\u2029\u2066'), /^(\\(x|u)[0-9a-f]+)+$/);
  assert.equal(printable('lead-abc123'), 'lead-abc123', 'ordinary text is untouched');
});

test('printable says what is not a string, and truncates long values with a stated length', () => {
  assert.equal(printable(12345), '(not a string: number)');
  assert.equal(printable(null), '(not a string: null)');
  assert.equal(printable({ a: 1 }), '(not a string: object)');
  const long = `https://example.com/${'a'.repeat(5000)}`;
  const shown = printable(long);
  assert.ok(shown.length < PRINTABLE_MAX + 80);
  assert.match(shown, new RegExp(`${long.length} characters, first ${PRINTABLE_MAX} shown`));
});

test('maskUrl hides the userinfo of a URL and leaves the rest alone', () => {
  assert.equal(maskUrl('https://user:PASSWORD@host.example.com/a?api_key=KEY'), 'https://***@host.example.com/a?api_key=KEY');
  assert.equal(maskUrl('https://host.example.com/a'), 'https://host.example.com/a');
  assert.equal(maskUrl('not a url user:pw@x'), 'not a url user:pw@x');
});

// --- --plan with a hostile payload -------------------------------------------------------------

function hostileFolder() {
  const dir = mkdtempSync(join(tmpdir(), 'signal-desk-hostile-'));
  writeFileSync(join(dir, '0001.json'), JSON.stringify({
    id: `hostile${FORGED}`,
    received_at: new Date().toISOString(),
    payload: {
      company: { name: 'Hostile', domain: 'hostile.example.com' },
      contact: { name: 'H', email: 'h@hostile.example.com' },
      sources: [`https://hostile.example.com/a${FORGED}`, 12345, null, { a: 1 }, `https://user:PASSWORD@hostile.example.com/b?api_key=KEY`, `https://hostile.example.com/${'x'.repeat(5000)}`],
      identity_source: `https://people.example.com/${FORGED}`,
    },
  }));
  writeFileSync(join(dir, '0001.json.sig'), 'not-a-real-signature\n');
  return dir;
}

async function cli(argv, runs) {
  const out = [];
  const err = [];
  const code = await main({
    argv,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { SIGNAL_DESK_RUNS_DIR: runs, SIGNAL_DESK_ANTHROPIC_KEY: 'sk-ant-hostile-0000', SIGNAL_DESK_SIGNAL_SECRET: 'hostile-secret' },
    cwd: ROOT,
    now: () => new Date().toISOString(),
    httpTransport: async () => ({ status: 404, headers: { get: () => null }, text: async () => '{}' }),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('--plan over a hostile payload prints no control byte and no forged verdict line', async () => {
  const { code, stdout, stderr } = await cli(['run', '--live', '--plan', '--signals', hostileFolder()], mkdtempSync(join(tmpdir(), 'sd-h-runs-')));
  assert.equal(code, 0);
  assertSafe(stdout, '--plan stdout');
  assertSafe(stderr, '--plan stderr');
  assert.match(stdout, /This run would start/, 'the real verdict is still there');
});

test('--plan says "not a string" for non-string sources, does not count them, and masks userinfo', async () => {
  const { stdout } = await cli(['run', '--live', '--plan', '--signals', hostileFolder()], mkdtempSync(join(tmpdir(), 'sd-h-runs-')));
  assert.match(stdout, /\(not a string: number\)/);
  assert.match(stdout, /\(not a string: null\)/);
  assert.match(stdout, /\(not a string: object\)/);
  assert.doesNotMatch(stdout, /\[object Object\]/);
  assert.doesNotMatch(stdout, /PASSWORD/);
  assert.match(stdout, /https:\/\/\*\*\*@hostile\.example\.com\/b\?api_key=KEY/);
  assert.match(stdout, /characters, first \d+ shown/);
  // 3 https strings + 1 identity source; the three non-strings are refused before any request.
  assert.match(stdout, /4 evidence URL\(s\)/);
});

// --- every other path payload text reaches the terminal ----------------------------------------

test('run --live, dlq and explain print a hostile ingest-refused lead without a control byte', async () => {
  const runs = mkdtempSync(join(tmpdir(), 'sd-h-live-'));
  const run = await cli(['run', '--live', '--signals', hostileFolder()], runs);
  assert.equal(run.code, 0, run.stderr);
  assertSafe(run.stdout, 'run --live stdout');

  const dlq = await cli(['dlq'], runs);
  assertSafe(dlq.stdout, 'dlq stdout');

  const leadId = `hostile${FORGED}`;
  const explain = await cli(['explain', leadId], runs);
  assertSafe(explain.stdout, 'explain stdout');
  assertSafe(explain.stderr, 'explain stderr');
});

function parkedRun(runs) {
  const runId = 'run-hostile0000';
  mkdirSync(join(runs, runId, 'parked'), { recursive: true });
  writeFileSync(join(runs, runId, 'ledger.jsonl'), '');
  writeFileSync(join(runs, 'latest'), `${runId}\n`);
  writeFileSync(join(runs, runId, 'parked', 'lead-x-abc.json'), JSON.stringify({
    lead_id: `lead-x${FORGED}`,
    draft_hash: 'abc0123456789',
    run_id: runId,
    mode: 'live',
    owner: `owner${FORGED}`,
    reason: 'AWAITING_APPROVAL',
    to: `h@hostile.example.com${FORGED}`,
    subject: `subject${FORGED}`,
    body: 'body',
  }));
}

test('queue and approve print a hostile parked draft without a control byte', async () => {
  const runs = mkdtempSync(join(tmpdir(), 'sd-h-queue-'));
  parkedRun(runs);
  const queue = await cli(['queue'], runs);
  assert.equal(queue.code, 0, queue.stderr);
  assertSafe(queue.stdout, 'queue stdout');

  const approve = await cli(['approve', 'abc0123'], runs);
  assert.equal(approve.code, 0, approve.stderr);
  assertSafe(approve.stdout, 'approve stdout');
  assert.ok(readFileSync(join(runs, 'approvals.jsonl'), 'utf8').length > 0, 'the decision was still recorded');
});
