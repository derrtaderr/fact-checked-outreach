// docs/CEILING-FINDINGS-SPEC.md, fix wave 1, M1 and M5.
//
// M1. --plan printed a count of URLs per lead, while the README, flow.md and the spec said it prints
//     the URLs and whether an identity source is named. It now prints them.
// M5. A dlq --replay over the ceiling advised "split the signals into runs", and dlq has no way to
//     split. The advice now names what the operator can actually do.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.mjs';
import { writeDeadLetter } from '../src/live/dlq.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function cli(argv, runs) {
  const out = [];
  const err = [];
  const code = await main({
    argv,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { SIGNAL_DESK_RUNS_DIR: runs, SIGNAL_DESK_ANTHROPIC_KEY: 'sk-ant-advice-0000', SIGNAL_DESK_SIGNAL_SECRET: 's' },
    cwd: ROOT,
    httpTransport: async () => {
      throw new Error('no request may be made');
    },
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('--plan prints each evidence URL and whether the payload names an identity source', async () => {
  const signals = mkdtempSync(join(tmpdir(), 'signal-desk-planurls-'));
  writeFileSync(join(signals, '0001.json'), JSON.stringify({
    id: 'with-identity',
    payload: { sources: ['https://one.example.com/a', 'https://one.example.com/b'], identity_source: 'https://people.example.com/pat' },
  }));
  writeFileSync(join(signals, '0002.json'), JSON.stringify({ id: 'without-identity', payload: { sources: ['https://two.example.com/a'] } }));

  const { code, stdout } = await cli(['run', '--live', '--plan', '--signals', signals], mkdtempSync(join(tmpdir(), 'signal-desk-planurls-runs-')));

  assert.equal(code, 0);
  for (const url of ['https://one.example.com/a', 'https://one.example.com/b', 'https://two.example.com/a']) {
    assert.ok(stdout.includes(url), `prints ${url}`);
  }
  assert.match(stdout, /identity source\s+https:\/\/people\.example\.com\/pat/);
  assert.match(stdout, /no identity source named/);
});

function letters(count) {
  const runs = mkdtempSync(join(tmpdir(), 'signal-desk-dlqadvice-'));
  for (let index = 1; index <= count; index += 1) {
    writeDeadLetter(runs, { reason: 'SIGNATURE_INVALID', source: `${index}.json`, signal_id: `s${index}`, signature: 'bad', raw: JSON.stringify({ id: `s${index}` }) });
  }
  return runs;
}

test('dlq --replay over a ceiling the operator typed gives advice dlq can follow, not "split"', async () => {
  const { code, stderr } = await cli(['dlq', '--replay', '--max-leads', '2'], letters(4));
  assert.equal(code, 2);
  assert.doesNotMatch(stderr, /Split the signals/i);
  assert.match(stderr, /dlq --replay re-feeds every dead letter at once/);
  assert.match(stderr, /--max-leads 4/);
});

test('dlq --replay over the default ceiling gives the same followable advice', async () => {
  const { stderr } = await cli(['dlq', '--replay'], letters(11));
  assert.doesNotMatch(stderr, /Split the signals/i);
  assert.match(stderr, /--max-leads 11/);
});

test('run --live keeps the split advice, because a folder can be split', async () => {
  const signals = mkdtempSync(join(tmpdir(), 'signal-desk-splitadvice-'));
  for (let index = 1; index <= 3; index += 1) {
    writeFileSync(join(signals, `000${index}.json`), JSON.stringify({ id: `s${index}`, payload: {} }));
  }
  const { stderr } = await cli(['run', '--live', '--signals', signals, '--max-leads', '2'], mkdtempSync(join(tmpdir(), 'signal-desk-splitadvice-runs-')));
  const split = stderr.search(/Split the signals into runs of at most 2/);
  const raise = stderr.search(/--max-leads 3/);
  assert.ok(split !== -1 && raise !== -1 && split < raise, 'splitting is offered before raising');
});
