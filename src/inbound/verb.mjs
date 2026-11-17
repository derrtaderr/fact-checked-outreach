// The `inbound` verb. docs/INBOUND-SPEC.md.
//
//   inbound [--at <instant>] [--rotation <file>]     one tick on the fakes (fixture mode)
//   inbound --live [--rotation <file>]                one tick against HubSpot and Slack
//   inbound --live --plan [--rotation <file>]         every call a live tick would make; contacts nothing
//
// Reads the latest run's approved handoffs. This module never builds a network transport: src/cli.mjs
// hands one in through `makeTransport`, so cli.mjs stays the only importer of node-transport.mjs.
//
// THE ORDER OF THE CHECKS IS PART OF THE BEHAVIOUR, as in `run --live`: flags, then credentials, then
// the rotation file, then the run, and only then any call. A refusal at any step has read nothing it
// did not need, called nothing and written nothing.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLedger } from '../ledger.mjs';
import { printable, maskUrl } from '../terminal.mjs';
import { secretScrubber } from '../live/keys.mjs';
import { parseRotationConfig, pickRep, RotationConfigError } from './rotation.mjs';
import { Journal, JournalTamperedError } from './journal.mjs';
import { tick, fold, openCounts } from './engine.mjs';
import { fakeHubSpot, fakeSlack } from './fakes.mjs';
import { createHubSpotAdapter, hubspotPaths, HUBSPOT_BASE } from './hubspot.mjs';
import { createSlackAdapter, SLACK_BASE } from './slack.mjs';

export const HUBSPOT_TOKEN_VARIABLE = 'SIGNAL_DESK_HUBSPOT_TOKEN';
export const SLACK_TOKEN_VARIABLE = 'SIGNAL_DESK_SLACK_TOKEN';
export const DEFAULT_ROTATION_FILE = 'inbound.json';
export const FIXTURE_ROTATION = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'inbound-rotation.json');

const shown = (value) => printable(value);
const pad = (value, width) => String(value).padEnd(width);

function flag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function runsDir(env, cwd) {
  return env.SIGNAL_DESK_RUNS_DIR ?? join(cwd, 'runs');
}

function token(env, name) {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// --- the rotation file -----------------------------------------------------------------------------

function rotationPath({ args, cwd, live }) {
  const typed = flag(args, '--rotation');
  if (typed !== undefined) return { path: typed, typed: true };
  const local = join(cwd, DEFAULT_ROTATION_FILE);
  if (existsSync(local)) return { path: local, typed: false };
  return live ? { path: local, typed: false, missing: true } : { path: FIXTURE_ROTATION, typed: false, synthetic: true };
}

function loadRotation(located, err) {
  if (located.missing || !existsSync(located.path)) {
    err(
      `ROTATION_CONFIG_MISSING: no rotation file at ${located.path}. Live mode assigns real owners, so it ` +
        'needs your reps: write inbound.json (see the README, "Inbound last mile") or pass --rotation <file>. ' +
        'It never falls back to the synthetic reps. Nothing was called and nothing was written.',
    );
    return null;
  }
  try {
    return parseRotationConfig(JSON.parse(readFileSync(located.path, 'utf8')));
  } catch (error) {
    const problem = error instanceof RotationConfigError ? error : new RotationConfigError(`it is not valid JSON (${error.message})`);
    err(`${problem.code}: ${problem.message}`);
    return null;
  }
}

// --- the events: the latest run's approved handoffs ------------------------------------------------

function latestRun(base) {
  const pointer = join(base, 'latest');
  if (!existsSync(pointer)) return null;
  const runId = readFileSync(pointer, 'utf8').trim();
  return runId !== '' && existsSync(join(base, runId, 'ledger.jsonl')) ? runId : null;
}

/** { events, refused } from the run's handoff folder, keyed by the signal id the ledger recorded. */
export function eventsFromRun(base, runId) {
  const dir = join(base, runId);
  const signalOf = new Map();
  for (const entry of parseLedger(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'))) {
    if (entry.stage !== 'ingest' || entry.verdict !== 'PASS') continue;
    const ref = entry.evidence_refs.find((r) => typeof r === 'string' && r.startsWith('signal:'));
    if (ref !== undefined) signalOf.set(entry.lead_id, ref.slice('signal:'.length));
  }

  const handoffs = join(dir, 'handoffs');
  const names = existsSync(handoffs) ? readdirSync(handoffs).sort() : [];
  const events = [];
  const refused = [];
  for (const name of names) {
    if (!name.endsWith('.json')) {
      refused.push({
        key: name, lead_id: name, status: 'REFUSED', code: 'HANDOFF_FORMAT_UNSUPPORTED',
        detail: 'inbound reads the dry-run-json handoff, which carries the whole brief; this export is another format',
      });
      continue;
    }
    const artifact = JSON.parse(readFileSync(join(handoffs, name), 'utf8'));
    const key = signalOf.get(artifact.lead_id);
    if (key === undefined) {
      refused.push({
        key: artifact.lead_id, lead_id: artifact.lead_id, status: 'REFUSED', code: 'SIGNAL_ID_UNKNOWN',
        detail: 'the run ledger has no passing ingest entry naming this lead\'s signal, so there is no idempotency key',
      });
      continue;
    }
    events.push({
      key,
      lead: {
        lead_id: artifact.lead_id,
        pool: artifact.owner,
        company: artifact.company,
        to: artifact.to,
        subject: artifact.subject,
        body: artifact.body,
        band: artifact.band,
        play: artifact.play,
        score: artifact.score,
        citations: artifact.citations,
        approved_by: artifact.approved_by,
      },
    });
  }
  return { events, refused };
}

// --- printing -------------------------------------------------------------------------------------

function printOutcomes(out, outcomes) {
  for (const o of outcomes) {
    out(`  ${pad(shown(o.key), 12)} ${pad(shown(o.lead_id ?? '-'), 20)} ${pad(o.status, 21)} ${pad(o.rep === undefined ? '-' : shown(o.rep), 8)} ${o.code ? `${o.code} ` : ''}${printable(o.detail ?? '', { max: Infinity })}`);
  }
}

// --- the verb -------------------------------------------------------------------------------------

export async function verbInbound({ args, out, err, env, cwd, now, makeTransport }) {
  const live = args.includes('--live');
  const plan = args.includes('--plan');
  const at = flag(args, '--at');

  if (plan && !live) {
    err('--plan previews a live tick. A fixture tick calls only the fakes, so run it as it is.');
    err('Did you mean: node bin/signal-desk.mjs inbound --live --plan');
    return 2;
  }
  if (at !== undefined && live) {
    err('INBOUND_AT_LIVE: --at sets the clock of a fixture tick. A live tick reads real time, because a live clock that can be typed can be lied to. Nothing was called.');
    return 2;
  }
  if (at !== undefined && Number.isNaN(Date.parse(at))) {
    err(`INBOUND_AT_INVALID: --at ${shown(at)} is not an instant. Write one like 2026-03-01T09:31:00.000Z.`);
    return 2;
  }

  // Credentials first for a live tick, before any file is read.
  let hubspotToken = null;
  let slackToken = null;
  if (live && !plan) {
    hubspotToken = token(env, HUBSPOT_TOKEN_VARIABLE);
    if (hubspotToken === null) {
      err(`INBOUND_HUBSPOT_TOKEN_MISSING: a live tick writes owners in HubSpot and found no token. Export ${HUBSPOT_TOKEN_VARIABLE} (a private app token with crm.objects.contacts.read and crm.objects.contacts.write). Nothing was read, called or written.`);
      return 2;
    }
    slackToken = token(env, SLACK_TOKEN_VARIABLE);
    if (slackToken === null) {
      err(`INBOUND_SLACK_TOKEN_MISSING: a live tick tells reps in Slack and found no token. Export ${SLACK_TOKEN_VARIABLE} (a bot token with chat:write, im:write and im:history). Nothing was read, called or written.`);
      return 2;
    }
  }

  const located = rotationPath({ args, cwd, live });
  const rotation = loadRotation(located, err);
  if (rotation === null) return 2;

  const base = runsDir(env, cwd);
  const runId = latestRun(base);
  if (runId === null) {
    err('no runs found. Run `node bin/signal-desk.mjs run` first; inbound takes the approved leads of the latest run.');
    return 2;
  }
  const { events, refused } = eventsFromRun(base, runId);

  const stateDir = join(base, live ? 'inbound' : 'inbound-fixture');
  const journalPath = join(stateDir, 'journal.jsonl');
  const show = (path) => relative(cwd, path) || path;

  let journal;
  try {
    journal = Journal.open(journalPath, { readOnly: plan });
  } catch (error) {
    if (!(error instanceof JournalTamperedError)) throw error;
    err(`${error.code}: ${error.message}`);
    return 1;
  }

  if (plan) return planTick({ out, rotation, journal, events, refused, at: now(), runId, journalPath: show(journalPath) });

  let hubspot;
  let slack;
  let save = () => {};
  let scrub = (text) => text;
  if (live) {
    scrub = secretScrubber([hubspotToken, slackToken]);
    const transport = makeTransport();
    hubspot = createHubSpotAdapter({ transport, token: hubspotToken, scrub });
    slack = createSlackAdapter({ transport, token: slackToken, scrub });
  } else {
    const owners = Object.values(rotation.pools).flat().map((rep) => rep.hubspot_owner_id);
    const read = (name) => (existsSync(join(stateDir, name)) ? JSON.parse(readFileSync(join(stateDir, name), 'utf8')) : undefined);
    hubspot = fakeHubSpot({ owners, snapshot: read('hubspot.json') });
    slack = fakeSlack({ snapshot: read('slack.json') });
    save = () => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'hubspot.json'), `${JSON.stringify(hubspot.snapshot(), null, 2)}\n`);
      writeFileSync(join(stateDir, 'slack.json'), `${JSON.stringify(slack.snapshot(), null, 2)}\n`);
    };
  }

  const clock = live ? now : () => at ?? now();
  let report;
  try {
    report = await tick({ events, rotation, journal, hubspot, slack, now: clock, scrub });
  } finally {
    save();
  }

  out(`inbound tick at ${report.at} (${live ? 'live mode: HubSpot and Slack' : 'fixture mode: fake HubSpot and fake Slack'}), run ${runId}`);
  out(`  rotation  ${located.synthetic ? 'the committed synthetic reps' : show(located.path)}, ${rotation.response_minutes} minute response window`);
  if (report.repaired) out(`  journal   ${report.repaired}`);
  out('');
  const outcomes = [...refused, ...report.outcomes];
  if (outcomes.length === 0) out('  nothing to do: no approved lead in the latest run is new, and no clock is running');
  printOutcomes(out, outcomes);
  out('');
  out(`  journal   ${show(journalPath)}`);
  if (!live) out(`  fakes     ${show(join(stateDir, 'hubspot.json'))} and ${show(join(stateDir, 'slack.json'))}`);
  out('');
  out('  Nothing was sent to a prospect. The draft went to the rep, who decides whether to send it.');
  out(`  Run again later to move the clock: node bin/signal-desk.mjs inbound${live ? ' --live' : ' --at <instant>'}`);
  return 0;
}

// --- --plan ---------------------------------------------------------------------------------------

function planTick({ out, rotation, journal, events, refused, at, runId, journalPath }) {
  const state = fold(journal.entries());
  const pointers = { ...state.pointers };
  const open = openCounts(state);
  const url = (path) => printable(maskUrl(`${HUBSPOT_BASE}${path}`), { max: Infinity });
  const assignCalls = (email, rep, indent) => {
    out(`${indent}GET ${url(hubspotPaths.read(email))}  (read the owner first)`);
    out(`${indent}  on 404, POST ${url(hubspotPaths.create())}; on 409, GET again`);
    out(`${indent}  if it has an owner this tool did not write: no write, ALREADY_OWNED, nobody told (unless "overwrite_owner": true)`);
    out(`${indent}  otherwise PATCH ${url(hubspotPaths.update(email))}  (owner ${shown(rep.hubspot_owner_id)})`);
    out(`${indent}POST ${SLACK_BASE}/chat.postMessage to ${shown(rep.slack_user_id)}`);
  };

  out(`plan for inbound --live at ${at}, run ${runId}`);
  out(`  journal   ${journalPath} (${journal.entries().length} line(s))${journal.repaired ? `; on a real tick: ${journal.repaired}` : ''}`);
  out('');

  let calls = 0;
  for (const lead of state.leads.values()) {
    const attempt = lead.attempts[lead.attempts.length - 1];
    const label = `  ${shown(lead.key)} (${shown(lead.lead_id)})`;
    if (lead.stopped !== null) continue;
    if (attempt.crm === null || attempt.slack === null) {
      out(`${label} has an interrupted attempt for ${shown(attempt.rep_id)}; would finish it:`);
      const rep = { hubspot_owner_id: attempt.owner_id, slack_user_id: attempt.slack_user_id };
      if (attempt.crm === null) { assignCalls(lead.brief.to, rep, '    '); calls += 4; }
      else {
        if (attempt.slack_open) out(`    POST ${SLACK_BASE}/conversations.open and GET ${SLACK_BASE}/conversations.history, to look for the earlier post`);
        out(`    POST ${SLACK_BASE}/chat.postMessage to ${shown(attempt.slack_user_id)}, only if the earlier post is not found`);
        calls += 3;
      }
      continue;
    }
    const deadline = Date.parse(attempt.slack.at) + rotation.response_minutes * 60000;
    if (Date.parse(at) < deadline) {
      out(`${label} is with ${shown(attempt.rep_id)}; clock running, no call`);
      continue;
    }
    out(`${label} is past its window with ${shown(attempt.rep_id)}; would read it:`);
    out(`    GET ${url(hubspotPaths.read(lead.brief.to))}`);
    out('    if the owner changed or activity was logged, would stop the clock and call nothing else');
    const pick = pickRep({ rotation, pool: lead.pool, last: pointers[lead.pool], open, exclude: lead.attempts.map((a) => a.rep_id) });
    if (pick.rep === undefined) {
      out(`    if untouched, would reassign to nobody: ${printable(pick.detail, { max: Infinity })}`);
      calls += 1;
      continue;
    }
    out(`    if untouched, would reassign to ${shown(pick.rep.id)}:`);
    assignCalls(lead.brief.to, pick.rep, '      ');
    pointers[lead.pool] = pick.rep.id;
    calls += 5;
  }

  const sorted = [...events].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { key, lead } of sorted) {
    if (state.leads.has(key)) continue;
    const label = `  ${shown(key)} (${shown(lead.lead_id)})`;
    if ([...state.leads.values()].some((other) => other.lead_id === lead.lead_id)) {
      out(`${label} would be skipped: LEAD_ALREADY_ASSIGNED`);
      continue;
    }
    const pick = pickRep({ rotation, pool: lead.pool, last: pointers[lead.pool], open });
    if (pick.rep === undefined) {
      out(`${label} would be refused: ${pick.code}, ${printable(pick.detail, { max: Infinity })}`);
      continue;
    }
    out(`${label} is new and would go to ${shown(pick.rep.id)}:`);
    assignCalls(lead.to, pick.rep, '    ');
    pointers[lead.pool] = pick.rep.id;
    open[pick.rep.id] = (open[pick.rep.id] ?? 0) + 1;
    calls += 4;
  }
  for (const r of refused) out(`  ${shown(r.key)} would be refused: ${r.code}`);

  out('');
  out(`  At most ${calls} call(s) in all. HubSpot and Slack calls are rate-limited, not billed per call.`);
  out('  Nothing was contacted and nothing was written. No token was needed to plan.');
  return 0;
}
