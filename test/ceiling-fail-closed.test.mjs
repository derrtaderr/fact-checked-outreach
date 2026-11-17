// The ceiling fails CLOSED. docs/CEILING-FINDINGS-SPEC.md, finding 2.
//
// The kernel used to read a ceiling it could not understand as no ceiling at all: maxLeads of null,
// '5' or 2.5 let every lead reach the billing stage, and liveConfig accepted any of them. The README
// promises the kernel bounds "any caller", so a caller that gets the ceiling wrong must be stopped
// before anything runs, never waved through.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runPipeline } from '../src/kernel.mjs';
import { Ledger } from '../src/ledger.mjs';
import { createContext, fixtureClock } from '../src/context.mjs';
import { pass } from '../src/contract.mjs';
import { liveConfig } from '../src/live/config.mjs';

function countingStages() {
  const calls = { ingest: 0, enrich: 0, draft: 0 };
  const stage = (name) => ({
    name,
    run: async (input) => {
      calls[name] += 1;
      return pass({ output: { ...input, lead_id: input.lead_id ?? `lead-${input.id}` } });
    },
  });
  return { calls, stages: [stage('ingest'), stage('enrich'), stage('draft')] };
}

async function run(config, count = 3) {
  const { calls, stages } = countingStages();
  const ledger = new Ledger();
  const ctx = createContext({
    ledger,
    clock: fixtureClock({ start: '2026-03-01T09:00:00.000Z', stepMs: 1000 }),
    fetch: async () => {
      throw new Error('no fetch in this test');
    },
    config,
    run_id: 'run-fail-closed',
  });
  const signals = Array.from({ length: count }, (_, index) => ({ id: `s${index + 1}` }));
  let error = null;
  try {
    await runPipeline({ stages, signals, ctx, ledger });
  } catch (caught) {
    error = caught;
  }
  return { calls, error, entries: ledger.entries() };
}

const BAD_MAX_LEADS = [null, undefined, '5', 2.5, 0, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 2];

test('the kernel refuses to run a ceiling whose maxLeads is not a whole number of 1 or more', async () => {
  for (const maxLeads of BAD_MAX_LEADS) {
    const { calls, error, entries } = await run({ mode: 'live', limits: { maxLeads, countedFrom: 'enrich' } });
    assert.ok(error, `maxLeads ${String(maxLeads)} should throw`);
    assert.equal(error.code, 'LEAD_CEILING_MISSING', `maxLeads ${String(maxLeads)}`);
    assert.equal(calls.ingest, 0, 'not one stage ran');
    assert.equal(calls.enrich, 0, 'and nothing billed');
    assert.equal(entries.length, 0, 'and no ledger line was written');
  }
});

test('an invalid ceiling is refused in any mode, because a limits object means someone wanted one', async () => {
  const { calls, error } = await run({ limits: { maxLeads: '5', countedFrom: 'enrich' } });
  assert.equal(error?.code, 'LEAD_CEILING_MISSING');
  assert.equal(calls.enrich, 0);
});

test('a live config with no limits at all is refused, never treated as fixture mode', async () => {
  const { calls, error } = await run({ mode: 'live' });
  assert.equal(error?.code, 'LEAD_CEILING_MISSING');
  assert.match(error.message, /live/);
  assert.equal(calls.enrich, 0);
});

test('a ceiling counted at a stage this pipeline does not have bounds nothing, so it is refused', async () => {
  for (const countedFrom of ['enrichment', '', undefined, 7]) {
    const { calls, error } = await run({ mode: 'live', limits: { maxLeads: 1, countedFrom } });
    assert.equal(error?.code, 'LEAD_CEILING_MISSING', `countedFrom ${String(countedFrom)}`);
    assert.equal(calls.enrich, 0);
  }
});

test('a valid live ceiling still runs and stops at the ceiling', async () => {
  const { calls, error } = await run({ mode: 'live', limits: { maxLeads: 2, countedFrom: 'enrich' } }, 5);
  assert.equal(error, null);
  assert.equal(calls.enrich, 2);
});

test('fixture mode, with no limits and no live mode, is unchanged', async () => {
  const { calls, error } = await run({ mode: 'fixture' }, 5);
  assert.equal(error, null);
  assert.equal(calls.enrich, 5);
});

test('liveConfig refuses a maxLeads that is not a whole number of 1 or more', () => {
  for (const maxLeads of [null, '5', 2.5, 0, -3, Infinity, NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(
      () => liveConfig({ secret: 's', startedAt: '2026-11-16T09:00:00.000Z', maxLeads }),
      (error) => error.code === 'LEAD_CEILING_INVALID',
      `maxLeads ${String(maxLeads)} should refuse`,
    );
  }
});

test('liveConfig still defaults the ceiling when none is passed', () => {
  assert.equal(liveConfig({ secret: 's', startedAt: '2026-11-16T09:00:00.000Z' }).limits.maxLeads, 10);
  assert.equal(liveConfig({ secret: 's', startedAt: '2026-11-16T09:00:00.000Z', maxLeads: 7 }).limits.maxLeads, 7);
});
