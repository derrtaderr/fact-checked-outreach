// The docs say what the code does. docs/CEILING-FINDINGS-SPEC.md, fix wave 1, I4, M3, M4 and M7.
//
// I4. Nothing told an operator that the `run --live` after `approve` bills every lead in the folder
//     again, and flow.md said "the approved draft is the only thing that moves".
// M3. The system map cited config.mjs lines that had moved.
// M4. "`dlq --replay` ... takes the same flag" sat right after the --plan paragraph and read as
//     `dlq --replay --plan`, which is refused.
// M7. flow.md and metrics.md said they matched the M4 build.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

function liveSection(readme) {
  const start = readme.indexOf('\n## Live mode\n');
  const end = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
}

test('I4: the README live-mode section says a second run --live after approve bills every lead again', () => {
  const live = liveSection(read('README.md')).replace(/\s+/g, ' ');
  assert.match(live, /What a second run costs/);
  assert.match(live, /bills every lead in the folder again/);
  assert.match(live, /APPROVAL_STALE/);
  assert.match(live, /not bound by the ceiling/i, 'the ceiling is per run, and the README says so');
});

test('I4: flow.md no longer says the approved draft is the only thing that moves on a live re-run', () => {
  const flow = read('.vibecodepm/flow.md');
  assert.doesNotMatch(flow, /run --live\s+the approved draft is the only thing that moves/);
  assert.match(flow.replace(/\s+/g, ' '), /bills every lead in the folder again/);
});

test('M3: every citation in system map section 4 points at the line it describes', () => {
  const section = read('.vibecodepm/system.md').split('## 4.')[1].split('\n## ')[0];
  const expectations = [
    [/src\/live\/config\.mjs:(\d+)\), carried/, /export const DEFAULT_MAX_LEADS/],
    [/capture \(src\/live\/config\.mjs:(\d+)\)/, /limits: \{ maxLeads/],
    [/ceiling \(src\/cli\.mjs:(\d+)\)/, /^function ceilingRefusal/],
    [/LEAD_CEILING_REACHED \(src\/kernel\.mjs:(\d+)\)/, /^export function ceilingOf/],
    [/mark themselves \(src\/billing\.mjs:(\d+)\)/, /export const BILLS/],
    [/writes nothing \(src\/cli\.mjs:(\d+)\)/, /^function planLive/],
  ];
  for (const [cite, lineShape] of expectations) {
    const match = section.match(cite);
    assert.ok(match, `system.md section 4 carries ${cite}`);
    const file = cite.source.match(/src\\\/([a-z/\\]+)\\\.mjs/)[0].replace(/\\/g, '');
    const line = read(file).split('\n')[Number(match[1]) - 1];
    assert.match(line, lineShape, `${file}:${match[1]} is ${JSON.stringify(line)}`);
  }
});

test('M4: the README names the flag dlq --replay shares, so it cannot read as --plan', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /takes the same flag/);
  assert.match(readme.replace(/\s+/g, ' '), /`dlq --replay` is held to the same ceiling and takes `--max-leads`/);
});

test('M7: flow.md and metrics.md say which build they match, and it is not M4', () => {
  for (const path of ['.vibecodepm/flow.md', '.vibecodepm/metrics.md']) {
    const front = read(path).split('---')[1];
    assert.doesNotMatch(front, /lane\/signal-desk-m4/, path);
    assert.match(front, /row 80/, path);
    assert.match(front, /date: 2026-11-16/, path);
  }
});

// --- fix wave 2 ----------------------------------------------------------------------------------

test('N-B: a thin wrapper around a billing transport loses the mark, and the README says exactly that', async () => {
  const { createLiveFetcher } = await import('../src/live/http.mjs');
  const { bills } = await import('../src/billing.mjs');
  const fetch = createLiveFetcher({ transport: async () => ({ status: 404, headers: { get: () => null }, text: async () => '{}' }) });
  assert.equal(bills(fetch), true, 'the function createLiveFetcher returned is marked');
  assert.equal(bills((url) => fetch(url)), false, 'an arrow around it is not');
  assert.equal(bills(fetch.bind(null)), false, 'a bound copy is not');
  assert.equal(bills(Object.assign(async (url) => fetch(url), fetch)), false, 'an Object.assign copy is not');

  const readme = read('README.md').replace(/\s+/g, ' ');
  assert.doesNotMatch(readme, /writes its own fetch or model function from scratch is not recognised/);
  assert.match(readme, /exact function `createLiveFetcher` or `createLiveModel` returned/);
  assert.match(readme, /\.bind/);
  assert.match(readme, /Object\.assign/);
  assert.match(readme, /arrow function/);
});

test('N-C: the system map section 2 and 3 cli citations point at the lines they describe', () => {
  const map = read('.vibecodepm/system.md');
  const cli = read('src/cli.mjs').split('\n');

  const writes = map.split('\n').find((line) => line.includes('written with writeFileSync, and also at src/cli.mjs'));
  assert.ok(writes, 'section 2 carries the cli write bullet');
  const cited = [...writes.matchAll(/src\/cli\.mjs:(\d+)/g)].map((match) => Number(match[1]));
  const actual = cli.flatMap((line, index) => (/writeFileSync\(/.test(line) ? [index + 1] : []));
  assert.deepEqual([...cited].sort((a, b) => a - b), actual, 'every cli write is cited, and nothing else');

  const runsDir = map.match(/read via an injected env object \(src\/cli\.mjs:(\d+)\)/);
  assert.ok(runsDir);
  assert.match(cli[Number(runsDir[1]) - 1], /SIGNAL_DESK_RUNS_DIR/);
});
