// The docs say what the inbound verb does. docs/INBOUND-SPEC.md.
//
// The reviewer walks flow.md and metrics.md; a status the engine can print that flow.md does not name
// is a state a user can land in with no map. So the list is read from the code, not typed twice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const flat = (text) => text.replace(/\s+/g, ' ');

function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `${heading} exists`);
  const level = heading.match(/^#+/)[0];
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`\\n${level} `));
  return end === -1 ? rest : rest.slice(0, end);
}

const engineStatuses = () => [...new Set(
  [...read('src/inbound/engine.mjs').matchAll(/status: '([A-Z_]+)'/g), ...read('src/inbound/verb.mjs').matchAll(/status: '([A-Z_]+)'/g)].map((m) => m[1]),
)].concat(['ASSIGNED', 'REASSIGNED']);

const codes = () => [...new Set(
  ['src/inbound/engine.mjs', 'src/inbound/verb.mjs', 'src/inbound/rotation.mjs', 'src/inbound/journal.mjs', 'src/inbound/hubspot.mjs', 'src/inbound/slack.mjs']
    .flatMap((file) => [...read(file).matchAll(/'((?:HUBSPOT|SLACK|ROTATION|NO|INBOUND|JOURNAL|LEAD|HANDOFF|SIGNAL)_[A-Z_]+)'/g)].map((m) => m[1]))
    .filter((code) => !code.endsWith('_VARIABLE')),
)];

test('the README has an inbound section: the three outputs, untouched defined, both tokens, --plan', () => {
  const inbound = flat(section(read('README.md'), '## Inbound last mile'));
  for (const needle of ['hubspot_owner_id', 'notes_last_updated', 'SIGNAL_DESK_HUBSPOT_TOKEN', 'SIGNAL_DESK_SLACK_TOKEN', 'inbound --live --plan', '--at', 'never posts twice', 'Nothing is sent to the prospect']) {
    assert.ok(inbound.includes(needle), `README inbound section mentions ${needle}`);
  }
  assert.match(inbound, /Untouched means/);
});

test('the README states what HubSpot Free and Starter cannot do for this job, with sources and the date read', () => {
  const inbound = flat(section(read('README.md'), '## Inbound last mile'));
  assert.match(inbound, /read 2026-11-16/);
  assert.match(inbound, /https:\/\/knowledge\.hubspot\.com\/workflows\/assign-and-rotate-record-owners-using-workflows/);
  assert.match(inbound, /https:\/\/developers\.hubspot\.com\/docs\/developer-tooling\/platform\/usage-guidelines\.md/);
  assert.match(inbound, /Professional or Enterprise/);
  assert.match(inbound, /100 requests per 10 seconds/);
  assert.match(inbound, /live Slack post was not run/i);
});

test('flow.md maps the inbound path: entry point, happy path, every status the code can print, recovery', () => {
  const flow = section(read('.vibecodepm/flow.md'), '## Inbound last mile, new in row 157');
  for (const heading of ['### Entry point', '### Happy path', '### States', '### Recovery paths']) {
    assert.ok(flow.includes(`\n${heading}\n`), `flow.md inbound has ${heading}`);
  }
  for (const status of engineStatuses()) assert.ok(flow.includes(`\`${status}\``), `flow.md names the state ${status}`);
  for (const code of codes()) assert.ok(flat(flow).includes(code), `flow.md names the reason ${code}`);
});

test('metrics.md names the inbound activation event and how it is measured', () => {
  const metrics = flat(section(read('.vibecodepm/metrics.md'), '### New in row 157: inbound is measured by the journal'));
  assert.match(metrics, /activation event/i);
  assert.match(metrics, /slack_posted/);
  assert.match(metrics, /journal\.jsonl/);
});

test('the system map names where inbound keeps state, its two keys, and that it does not bill', () => {
  const system = flat(read('.vibecodepm/system.md'));
  assert.match(system, /runs\/inbound\/journal\.jsonl/);
  assert.match(system, /SIGNAL_DESK_HUBSPOT_TOKEN/);
  assert.match(system, /SIGNAL_DESK_SLACK_TOKEN/);
  assert.match(system, /api\.hubapi\.com/);
  assert.match(system, /rate-limited, not billed/);
});

test('the frontmatter of flow.md and metrics.md says they match this build', () => {
  for (const file of ['.vibecodepm/flow.md', '.vibecodepm/metrics.md']) {
    assert.match(read(file).split('---')[1], /row157/);
  }
});

// Review pass 2, item 4: two promises the code does not keep. --recover looks only for the marker of
// the attempt it makes, so after a lost reassignment one rep can be told twice (probe7 F2b); and a lead
// parked ALREADY_OWNED is never retried, so setting overwrite_owner later does not take it over.
test('item 4: README and spec state the --recover limit where they promise no rep is told twice', () => {
  const readme = flat(section(read('README.md'), '### If the journal was cut short'));
  assert.match(readme, /only for the marker of the attempt it is making/);
  assert.match(readme, /lost lines held a reassignment/);
  assert.match(readme, /told about the same lead twice/);
  const spec = flat(read('docs/INBOUND-SPEC.md'));
  assert.doesNotMatch(spec, /Nothing is reposted\./);
  assert.match(spec, /only for the marker of the attempt it is making/);
  assert.match(spec, /told about the same lead twice/);
});

test('item 4: README says overwrite_owner applies to leads seen after it is set, and what to do with one already parked', () => {
  const inbound = flat(section(read('README.md'), '## Inbound last mile'));
  assert.doesNotMatch(inbound, /only if you want the rotation to take those leads over/);
  assert.match(inbound, /applies to leads the tool meets after it is set/);
  assert.match(inbound, /already parked as `ALREADY_OWNED` is not retried/);
});
