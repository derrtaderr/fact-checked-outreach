// The ceiling guard keys on the WIRING, not on a label. docs/CEILING-FINDINGS-SPEC.md, fix wave 1,
// I1, I2, I3 and M6.
//
// I2. The guard keyed on config.mode === 'live', a label the caller writes. With the real live
//     transports wired and the label deleted, or written 'fixture' or 'Live', every lead was fetched.
// I3. A ceiling counted at `draft` or `handoff` let every lead through `enrich`, the first stage that
//     fetches, so it bounded nothing for fetches.
// I1. Keying on the label also broke replay: a live capture made before the ceiling existed carries
//     mode 'live' and no limits, and replay, which bills nothing, died with a stack trace.
// M6. maxLeads of Infinity or NaN through buildLiveRun threw a bare TypeError from the run-id
//     serialiser instead of the documented LEAD_CEILING_MISSING.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { liveConfig } from '../src/live/config.mjs';
import { buildLiveRun } from '../src/runner.mjs';
import { runPipeline } from '../src/kernel.mjs';
import { recordingClock } from '../src/context.mjs';
import { createLiveFetcher } from '../src/live/http.mjs';
import { createLiveModel } from '../src/live/anthropic.mjs';
import { publicConfig } from '../src/live/keys.mjs';
import { signRaw } from '../src/stages/ingest.mjs';
import { main } from '../src/cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'wiring-secret';
const START = '2026-11-16T09:00:00.000Z';

function signed(index) {
  const domain = `co${index}.example.com`;
  const signal = {
    id: `w${index}`,
    source: 'rb2b',
    received_at: '2026-11-16T08:59:00.000Z',
    payload: {
      company: { name: `Company ${index}`, domain },
      contact: { name: 'Pat Example', email: `pat@${domain}` },
      sources: [`https://${domain}/about`],
    },
  };
  const raw = JSON.stringify(signal);
  return { ...signal, raw, signature: signRaw(SECRET, raw), source_file: `w${index}.json` };
}

function clock() {
  let tick = 0;
  return recordingClock({ read: () => new Date(Date.parse(START) + 1000 * tick++).toISOString() });
}

// The real live transports, over a counting fake socket. This is the wiring a live run has.
function liveWiring() {
  const requests = [];
  const transport = async (url) => {
    requests.push(url);
    return { status: 404, headers: { get: () => null }, text: async () => '{}' };
  };
  return {
    requests,
    fetch: createLiveFetcher({ transport, readClock: () => START }),
    model: createLiveModel({ key: 'sk-ant-wiring-0000', transport }),
  };
}

function configWith(edit) {
  const config = liveConfig({ secret: SECRET, startedAt: START, maxLeads: 2 });
  edit(config);
  return config;
}

async function runWired(config, count = 5) {
  const wiring = liveWiring();
  const signals = Array.from({ length: count }, (_, index) => signed(index + 1));
  let error = null;
  try {
    const run = buildLiveRun({ signals, config, clock: clock(), fetch: wiring.fetch, model: wiring.model });
    await runPipeline({ stages: run.stages, signals, ctx: run.ctx, ledger: run.ledger });
  } catch (caught) {
    error = caught;
  }
  return { error, requests: wiring.requests };
}

// --- I2 ---------------------------------------------------------------------------------------

test('with the live transports wired, a missing ceiling is refused whatever the mode label says', async () => {
  for (const [label, edit] of [
    ['limits deleted', (c) => delete c.limits],
    ['limits and mode deleted', (c) => { delete c.limits; delete c.mode; }],
    ['mode fixture, no limits', (c) => { delete c.limits; c.mode = 'fixture'; }],
    ['mode Live, no limits', (c) => { delete c.limits; c.mode = 'Live'; }],
  ]) {
    const { error, requests } = await runWired(configWith(edit));
    assert.equal(error?.code, 'LEAD_CEILING_MISSING', label);
    assert.equal(requests.length, 0, `${label}: not one request`);
  }
});

test('with the live transports wired and a valid ceiling, the run stops at the ceiling', async () => {
  const { error, requests } = await runWired(configWith(() => {}));
  assert.equal(error, null);
  assert.deepEqual(requests.sort(), ['https://co1.example.com/about', 'https://co2.example.com/about']);
});

// --- I3 ---------------------------------------------------------------------------------------

test('with the live transports wired, a ceiling counted after the first fetching stage is refused', async () => {
  for (const countedFrom of ['draft', 'gate', 'handoff', 'score']) {
    const { error, requests } = await runWired(configWith((c) => { c.limits.countedFrom = countedFrom; }));
    assert.equal(error?.code, 'LEAD_CEILING_MISSING', `countedFrom ${countedFrom}`);
    assert.match(error.message, /enrich/, 'it names the first stage that bills');
    assert.equal(requests.length, 0);
  }
});

test('a ceiling counted at ingest, before the first fetching stage, is stricter and is allowed', async () => {
  const { error, requests } = await runWired(configWith((c) => { c.limits.countedFrom = 'ingest'; }));
  assert.equal(error, null);
  assert.equal(requests.length, 2);
});

// --- M6 ---------------------------------------------------------------------------------------

test('buildLiveRun refuses Infinity or NaN with LEAD_CEILING_MISSING, not a bare TypeError', () => {
  for (const maxLeads of [Infinity, NaN]) {
    const wiring = liveWiring();
    const config = configWith((c) => { c.limits.maxLeads = maxLeads; });
    assert.throws(
      () => buildLiveRun({ signals: [signed(1)], config, clock: clock(), fetch: wiring.fetch, model: wiring.model }),
      (error) => error.code === 'LEAD_CEILING_MISSING',
      String(maxLeads),
    );
    assert.equal(wiring.requests.length, 0);
  }
});

// --- I1 ---------------------------------------------------------------------------------------

// A capture shaped like one written before the ceiling existed: mode 'live', no limits. The run is
// built with plain fakes (nothing that bills), the way that era's capture recorded what it saw.
async function preCeilingRunDir() {
  const runs = mkdtempSync(join(tmpdir(), 'signal-desk-preceiling-'));
  const signals = [signed(1), signed(2)];
  const config = configWith((c) => delete c.limits);
  const runClock = clock();
  const run = buildLiveRun({
    signals,
    config,
    clock: runClock,
    fetch: async () => ({ status: 404, body: {}, fetched_at: START }),
    model: async () => {
      throw new Error('not reached');
    },
  });
  await runPipeline({ stages: run.stages, signals, ctx: run.ctx, ledger: run.ledger });
  const dir = join(runs, run.run_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ledger.jsonl'), run.ledger.toJSONL());
  writeFileSync(
    join(dir, 'inputs.json'),
    `${JSON.stringify({
      mode: 'live',
      config: publicConfig(run.config),
      signals,
      recordings: run.capture,
      recordings_seed: run.recordingsSeed,
      clock: runClock.readings(),
    }, null, 2)}\n`,
  );
  return { runs, runId: run.run_id, dir };
}

async function replay(runs, runId) {
  const out = [];
  const err = [];
  const code = await main({
    argv: ['replay', runId],
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { SIGNAL_DESK_RUNS_DIR: runs, SIGNAL_DESK_SIGNAL_SECRET: SECRET },
    cwd: ROOT,
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('a live capture from before the ceiling existed still replays as an exact match', async () => {
  const { runs, runId } = await preCeilingRunDir();
  const { code, stdout, stderr } = await replay(runs, runId);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /is an exact match/);
});

test('a capture whose ceiling was edited into nonsense is refused by name, not with a stack trace', async () => {
  const { runs, runId, dir } = await preCeilingRunDir();
  const inputs = JSON.parse(readFileSync(join(dir, 'inputs.json'), 'utf8'));
  inputs.config.limits = { maxLeads: '5', countedFrom: 'enrich' };
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify(inputs));
  const { code, stderr } = await replay(runs, runId);
  assert.equal(code, 1);
  assert.match(stderr, /^LEAD_CEILING_MISSING: /m);
  assert.doesNotMatch(stderr, /\n\s+at /, 'no stack trace');
});
