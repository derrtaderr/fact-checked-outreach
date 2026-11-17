// The journal's head lives outside the journal. docs/INBOUND-SPEC.md, "The head file".
//
// Review pass 1, I2: dropping whole trailing lines from the journal left a chain that still verified,
// so the leads in those lines looked new and were claimed and posted again. A small head file, written
// atomically after every append, records how many lines there are and the last hash. A journal that
// disagrees with it is refused, JOURNAL_HEAD_MISMATCH, and `inbound --recover` is the way out that
// does not repost: every Slack post on that tick is looked for by marker first.

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Journal } from '../src/inbound/journal.mjs';
import { tick } from '../src/inbound/engine.mjs';
import { main } from '../src/cli.mjs';
import { eventOf, world, run, T0 } from './helpers/inbound-world.mjs';

const lines = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean);
const mismatch = (error) => {
  assert.equal(error.code, 'JOURNAL_HEAD_MISMATCH');
  return true;
};

test('I2: dropping whole trailing lines is detected and refused', async () => {
  const w = world();
  await run(w, [eventOf(1), eventOf(2)]);
  writeFileSync(w.path, `${lines(w.path).slice(0, 4).join('\n')}\n`);
  assert.throws(() => Journal.open(w.path), mismatch);
  assert.throws(() => Journal.open(w.path, { readOnly: true }), mismatch, 'a plan refuses too');
});

test('I2: an emptied journal is detected and refused', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  writeFileSync(w.path, '');
  assert.throws(() => Journal.open(w.path), mismatch);
});

test('I2: a journal whose head file was deleted is refused', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  unlinkSync(`${w.path.replace(/\.jsonl$/, '')}.head`);
  assert.throws(() => Journal.open(w.path), mismatch);
});

test('I2: a trailing blank line from an editor save is not tampering, and appends continue', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  appendFileSync(w.path, '\n\n');
  const journal = Journal.open(w.path);
  assert.equal(journal.entries().length, 4);
  journal.append({ type: 'note', key: 'x', at: T0 });
  assert.equal(Journal.open(w.path).entries().length, 5);
});

test('I2: a crash between the journal append and the head write is not a mismatch', async () => {
  const w = world();
  await run(w, [eventOf(1)]);
  const head = `${w.path.replace(/\.jsonl$/, '')}.head`;
  const before = readFileSync(head, 'utf8');
  Journal.open(w.path).append({ type: 'note', key: 'x', at: T0 });
  writeFileSync(head, before);
  assert.equal(Journal.open(w.path).entries().length, 5);
});

test('I2: recovery after truncation does not repost: every post that tick is looked for first', async () => {
  const w = world();
  await run(w, [eventOf(1), eventOf(2)]);
  assert.equal(w.slack.posts().length, 2);
  writeFileSync(w.path, `${lines(w.path).slice(0, 4).join('\n')}\n`);

  const journal = Journal.open(w.path, { accept: true });
  assert.match(journal.recovered, /4/);
  const result = await tick({ events: [eventOf(1), eventOf(2)], rotation: w.rotation, journal, hubspot: w.hubspot, slack: w.slack, now: () => T0, uncertain: true });
  assert.equal(w.slack.posts().length, 2, `nothing reposted: ${JSON.stringify(result.outcomes)}`);
  assert.deepEqual(w.hubspot.contacts().map((c) => c.ownerId).sort(), ['o-ana', 'o-ben']);
  assert.doesNotThrow(() => Journal.open(w.path), 'the head agrees with the journal again');
});

test('I2: the CLI refuses a truncated journal, and --recover finishes it without a second post', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'signal-desk-head-'));
  const output = [];
  const cli = (argv) => main({ argv, cwd, env: {}, out: (l) => output.push(l), err: (l) => output.push(l), now: () => T0 });
  await cli(['run']);
  assert.equal(await cli(['inbound', '--at', T0]), 0);
  const path = join(cwd, 'runs', 'inbound-fixture', 'journal.jsonl');
  writeFileSync(path, '');
  output.length = 0;
  assert.equal(await cli(['inbound', '--at', T0]), 1);
  assert.match(output.join('\n'), /JOURNAL_HEAD_MISMATCH/);
  assert.match(output.join('\n'), /--recover/);
  output.length = 0;
  assert.equal(await cli(['inbound', '--at', T0, '--recover']), 0, output.join('\n'));
  const slack = JSON.parse(readFileSync(join(cwd, 'runs', 'inbound-fixture', 'slack.json'), 'utf8'));
  assert.equal(slack.posts.length, 1, 'the rep was not told twice');
  assert.match(output.join('\n'), /recover/);
});
