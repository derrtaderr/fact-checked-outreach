// docs/CEILING-FINDINGS-SPEC.md, review pass 3, X1.
//
// --plan counted a source as a fetch only when its RAW string started with https. The run expands
// {domain} and {email} first and then fetches, so a payload whose sources are templates planned 0
// fetches while the run made 36 real requests. The plan must count and print what the run will
// fetch, derived by the run's own expansion and the run's own "will this be fetched" decision.
//
// Every test here compares the plan against a REAL live run, in process, through a counting fake
// transport. A plan checked only against itself cannot catch a plan that drifted from the run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.mjs';
import { signRaw } from '../src/stages/ingest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'plan-templates-secret';

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `signal-desk-${prefix}-`));
}

function writeSigned(dir, name, signal) {
  const bytes = JSON.stringify(signal, null, 2);
  writeFileSync(join(dir, `${name}.json`), bytes);
  writeFileSync(join(dir, `${name}.json.sig`), `${signRaw(SECRET, bytes)}\n`);
}

function body({ id, domain, email, sources, identity_source }) {
  return {
    id,
    source: 'rb2b',
    received_at: new Date().toISOString(),
    payload: {
      company: { name: `Company ${id}`, domain },
      contact: { name: 'Pat Example', email, title: 'VP Revenue Operations' },
      intent: { page: '/pricing', visits: 2 },
      sources,
      ...(identity_source === undefined ? {} : { identity_source }),
    },
  };
}

// Answers every GET with a fresh, well-formed record and every model call with a parseable reply,
// so nothing is retried and the GET count is exactly the number of evidence fetches the run made.
function countingTransport() {
  const gets = [];
  return {
    gets,
    transport: async (url, options) => {
      const json = (payload) => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) });
      if (options.method === 'POST') {
        const isJudge = options.body.includes('release gate');
        const reply = isJudge
          ? { verdict: 'FAIL', criteria: [{ name: 'claim_grounding', verdict: 'FAIL', note: 'test' }] }
          : { subject: 'Hello', body: 'Hi Pat,\n\nA question.\n\nThanks', claim_refs: [] };
        return json({ model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] });
      }
      gets.push(url);
      return json({ as_of: new Date(Date.now() - 3600000).toISOString(), claims: { note: 'fresh' } });
    },
  };
}

async function cli(argv, { runs, transport }) {
  const out = [];
  const err = [];
  const code = await main({
    argv,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: { SIGNAL_DESK_RUNS_DIR: runs, SIGNAL_DESK_ANTHROPIC_KEY: 'sk-ant-plan-templates-0000', SIGNAL_DESK_SIGNAL_SECRET: SECRET },
    cwd: ROOT,
    httpTransport: transport,
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

function plannedFetches(stdout) {
  const match = stdout.match(/expected\s+(\d+) fetch\(es\)/);
  assert.ok(match, `the plan states an expected fetch count:\n${stdout}`);
  return Number(match[1]);
}

async function planAndRun(signals) {
  const refuse = async () => {
    throw new Error('--plan must make no request');
  };
  const plan = await cli(['run', '--live', '--plan', '--signals', signals], { runs: tmp('plan-runs'), transport: refuse });
  assert.equal(plan.code, 0, plan.stderr);

  const counter = countingTransport();
  const run = await cli(['run', '--live', '--signals', signals], { runs: tmp('real-runs'), transport: counter.transport });
  assert.equal(run.code, 0, run.stderr);
  return { plan, gets: counter.gets };
}

// --- 1. templated sources: the reviewer's case -------------------------------------------------

test('X1: a payload of templated sources plans exactly the fetches the run makes', async () => {
  const signals = tmp('x1-templates');
  // Six leads, five templated claim sources and one templated identity source each: 36 requests.
  // Every source begins with a placeholder, so no RAW string starts with https.
  for (let index = 1; index <= 6; index += 1) {
    writeSigned(signals, `000${index}`, body({
      id: `x1-${index}`,
      domain: `https://co${index}.example.com`,
      email: `pat${index}@co${index}.example.com`,
      sources: ['{domain}/about', '{domain}/team', '{domain}/news?who={email}', '{domain}/press', '{domain}/{email}'],
      identity_source: '{domain}/people/{email}',
    }));
  }

  const { plan, gets } = await planAndRun(signals);

  assert.equal(gets.length, 36, 'the run makes 36 real requests');
  assert.equal(plannedFetches(plan.stdout), gets.length, 'the plan counts what the run fetches');
  // And it prints where they go, expanded, because WHERE is what an operator checks before paying.
  for (const url of gets) assert.ok(plan.stdout.includes(url), `the plan prints ${url}`);
  assert.match(plan.stdout, /x1-1, 6 evidence URL\(s\)/);
});
