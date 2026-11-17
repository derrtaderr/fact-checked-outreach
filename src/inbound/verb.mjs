// The `inbound` verb. docs/INBOUND-SPEC.md.
//
//   inbound [--at <instant>] [--rotation <file>]     one tick on the fakes (fixture mode)
//   inbound --live [--rotation <file>]                one tick against HubSpot and Slack
//   inbound --live --plan [--rotation <file>]         the calls a live tick would make, an upper bound; contacts nothing
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
import { parseRotationConfig, RotationConfigError } from './rotation.mjs';
import { Journal, JournalTamperedError, JournalHeadMismatchError } from './journal.mjs';
import { acquireLock, InboundLockedError } from './lock.mjs';
import { tick, fold } from './engine.mjs';
import { planCalls, HTTP_CALLS } from './plan.mjs';
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
  const recover = args.includes('--recover');
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

  if (plan) {
    // A plan reads and writes nothing, so it takes no lock.
    let journal;
    try {
      journal = Journal.open(journalPath, { readOnly: true, accept: recover });
    } catch (error) {
      if (!(error instanceof JournalTamperedError) && !(error instanceof JournalHeadMismatchError)) throw error;
      err(`${error.code}: ${error.message}`);
      return 1;
    }
    return planTick({ out, rotation, journal, events, refused, at: now(), runId, journalPath: show(journalPath), recover });
  }

  // Live: the adapters, and the Slack token's scopes, checked before anything is written. Without
  // im:history a post whose outcome is unknown can never be looked up, so it would park as
  // SLACK_UNCONFIRMED for good; that is found out here, not after a HubSpot write.
  let adapters = null;
  let scopeNote = null;
  if (live) {
    const scrub = secretScrubber([hubspotToken, slackToken]);
    const transport = makeTransport();
    adapters = {
      scrub,
      hubspot: createHubSpotAdapter({ transport, token: hubspotToken, scrub }),
      slack: createSlackAdapter({ transport, token: slackToken, scrub }),
    };
    let scopes;
    try {
      scopes = await adapters.slack.scopes();
    } catch (error) {
      err(`${error?.code ?? 'SLACK_UNREACHABLE'}: the Slack token could not be checked at auth.test before the tick (${printable(scrub(String(error?.message ?? error)), { max: Infinity })}). Nothing was written.`);
      return 2;
    }
    if (scopes === null) {
      scopeNote = 'Slack did not report the token\'s scopes, so chat:write, im:write and im:history were not checked before this tick';
    } else {
      const missing = SLACK_SCOPES.filter((scope) => !scopes.includes(scope));
      if (missing.length > 0) {
        err(
          `SLACK_SCOPE_MISSING: the Slack token lacks ${missing.join(', ')}. inbound needs ${SLACK_SCOPES.join(', ')}: ` +
            'chat:write to post, im:write to open the DM, and im:history to look for a post whose outcome is unknown ' +
            'before posting again (without it such a lead could never be confirmed). Add the scope to the Slack app, ' +
            'reinstall it, and export the new token. Nothing was read from the journal and nothing was written.',
        );
        return 2;
      }
    }
  }

  // One tick at a time per state directory, held from before the journal is read until after the last
  // write. A second process stops here, having written nothing.
  let lock;
  try {
    mkdirSync(stateDir, { recursive: true });
    lock = acquireLock(stateDir);
  } catch (error) {
    if (!(error instanceof InboundLockedError)) throw error;
    err(error.message);
    return EXIT_LOCKED;
  }
  try {
    return await lockedTick({ out, err, live, located, rotation, runId, events, refused, stateDir, journalPath, show, adapters, scopeNote, now, at, lock, recover });
  } finally {
    lock.release();
  }
}

/**
 * Exit codes of `inbound`, documented in the README, "Inbound last mile":
 *   0  the tick ran and nothing needs a person
 *   1  the journal was refused (JOURNAL_TAMPERED, JOURNAL_HEAD_MISMATCH); nothing was called
 *   2  refused before the tick (flags, tokens, Slack scopes, rotation file, no run); nothing was written
 *   3  INBOUND_LOCKED: another tick holds the state directory; nothing was written
 *   4  the tick ran, and at least one lead needs a person (NEEDS_A_PERSON below)
 */
export const EXIT_LOCKED = 3;
export const EXIT_NEEDS_A_PERSON = 4;
export const SLACK_SCOPES = Object.freeze(['chat:write', 'im:write', 'im:history']);
// The one auth.test request every live tick makes before the lock and the journal.
const SCOPE_CHECK_CALLS = 1;

// A call failed, a lead was assigned to nobody, or a lead is parked for a person. Each of these stays
// as it is until a person acts or the next tick succeeds, so a scheduled run must be able to alarm.
export const NEEDS_A_PERSON = Object.freeze(['CRM_PENDING', 'SLACK_PENDING', 'SLACK_UNCONFIRMED', 'CLOCK_CHECK_FAILED', 'REFUSED', 'NO_REP_RESPONDED']);

async function lockedTick({ out, err, live, located, rotation, runId, events, refused, stateDir, journalPath, show, adapters, scopeNote, now, at, lock, recover }) {
  let journal;
  try {
    journal = Journal.open(journalPath, { accept: recover });
  } catch (error) {
    if (!(error instanceof JournalTamperedError) && !(error instanceof JournalHeadMismatchError)) throw error;
    err(`${error.code}: ${error.message}`);
    return 1;
  }

  let hubspot;
  let slack;
  let save = () => {};
  let scrub = (text) => text;
  if (live) {
    ({ hubspot, slack, scrub } = adapters);
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
    // --recover: every post this tick is looked for by marker first, whether or not the journal says
    // one may exist, because the lines that would have said so may be the ones that were lost.
    report = await tick({ events, rotation, journal, hubspot, slack, now: clock, scrub, uncertain: recover });
  } finally {
    save();
  }

  out(`inbound tick at ${report.at} (${live ? 'live mode: HubSpot and Slack' : 'fixture mode: fake HubSpot and fake Slack'}), run ${runId}`);
  out(`  rotation  ${located.synthetic ? 'the committed synthetic reps' : show(located.path)}, ${rotation.response_minutes} minute response window`);
  if (lock.broke) out(`  lock      ${lock.broke}`);
  if (report.repaired) out(`  journal   ${report.repaired}`);
  if (journal.recovered) out(`  recover   ${journal.recovered}`);
  if (scopeNote) out(`  slack     ${scopeNote}`);
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
  const attention = outcomes.filter((o) => NEEDS_A_PERSON.includes(o.status));
  if (attention.length > 0) {
    out(`  needs a person: ${attention.length} lead(s) (${[...new Set(attention.map((o) => o.status))].join(', ')}); exit 4, so a scheduled run can alarm.`);
    return EXIT_NEEDS_A_PERSON;
  }
  return 0;
}

// --- --plan ---------------------------------------------------------------------------------------
//
// The plan is the engine's own tick on an in-memory copy of the journal (src/inbound/plan.mjs), so the
// calls it lists are made in the tick's order, against the tick's capacity, and cannot drift from it.

async function planTick({ out, rotation, journal, events, refused, at, runId, journalPath, recover }) {
  const before = fold(journal.entries());
  const { calls, possible, outcomes } = await planCalls({ events, rotation, journal, at, uncertain: recover });
  const url = (path) => printable(maskUrl(`${HUBSPOT_BASE}${path}`), { max: Infinity });
  const assignLines = (op, indent) => {
    out(`${indent}GET ${url(hubspotPaths.read(op.email))}  (read the owner first)`);
    out(`${indent}  on 404, POST ${url(hubspotPaths.create())}; on 409, GET again`);
    out(`${indent}  if it has an owner this tool did not write: no write, ALREADY_OWNED, nobody told (unless "overwrite_owner": true)`);
    out(`${indent}  otherwise PATCH ${url(hubspotPaths.update(op.email))}  (owner ${shown(op.ownerId)})`);
  };
  const opLines = (ops, indent) => {
    let found = false;
    for (const op of ops) {
      if (op.op === 'assign') assignLines(op, indent);
      if (op.op === 'find') {
        out(`${indent}POST ${SLACK_BASE}/conversations.open and GET ${SLACK_BASE}/conversations.history, to look for the earlier post`);
        found = true;
      }
      if (op.op === 'post') out(`${indent}POST ${SLACK_BASE}/chat.postMessage to ${shown(op.channel)}${found ? ', only if the earlier post is not found' : ''}`);
    }
  };

  out(`plan for inbound --live at ${at}, run ${runId}`);
  out(`  journal   ${journalPath} (${journal.entries().length} line(s))${journal.repaired ? `; on a real tick: ${journal.repaired}` : ''}`);
  if (journal.recovered) out(`  recover   ${journal.recovered}`);
  out('');
  // Made by every live tick before anything else (see verbInbound), so it is listed and counted.
  out(`  POST ${SLACK_BASE}/auth.test  (the Slack token's scope check, first; it writes nothing)`);

  for (const outcome of outcomes) {
    const label = `  ${shown(outcome.key)} (${shown(outcome.lead_id ?? '-')})`;
    const ops = calls.filter((op) => op.key === outcome.key);
    const read = ops.findIndex((op) => op.op === 'read');
    const known = before.leads.get(outcome.key);
    if (read !== -1) {
      const holder = known.attempts[known.attempts.length - 1].rep_id;
      out(`${label} is past its window with ${shown(holder)}; would read it:`);
      out(`    GET ${url(hubspotPaths.read(ops[read].email))}`);
      out('    if the owner changed or activity was logged, would stop the clock and call nothing else');
      const rest = ops.slice(read + 1);
      if (outcome.status === 'REASSIGNED') {
        out(`    if untouched, would reassign to ${shown(outcome.rep)}:`);
        opLines(rest, '      ');
      } else {
        out(`    if untouched: ${outcome.status}${outcome.code ? ` ${outcome.code}` : ''}, ${printable(outcome.detail ?? '', { max: Infinity })}`);
        opLines(rest, '      ');
      }
      continue;
    }
    if (outcome.status === 'CLOCK_RUNNING') {
      out(`${label} is with ${shown(outcome.rep)}; clock running, no call`);
      continue;
    }
    if (ops.length > 0 && (outcome.status === 'ASSIGNED' || outcome.status === 'REASSIGNED')) {
      const resumed = known !== undefined && known.attempts[known.attempts.length - 1].rep_id === outcome.rep;
      out(resumed
        ? `${label} has an interrupted attempt for ${shown(outcome.rep)}; would finish it:`
        : `${label} is new and would go to ${shown(outcome.rep)}:`);
      opLines(ops, '    ');
      continue;
    }
    out(`${label} would be ${outcome.status}${outcome.code ? `: ${outcome.code}` : ''}, ${printable(outcome.detail ?? '', { max: Infinity })}`);
    opLines(ops, '    ');
  }
  for (const r of refused) out(`  ${shown(r.key)} would be refused: ${r.code}`);
  for (const key of [...new Set(possible.map((op) => op.key))]) {
    out(`  ${shown(key)} was refused NO_ELIGIBLE_REP above; if an answer above frees a rep (a lead found touched, or one a person owns), it may be assigned after all: up to ${HTTP_CALLS.assign} HubSpot calls and ${HTTP_CALLS.post} Slack post`);
  }

  const assumed = SCOPE_CHECK_CALLS + calls.reduce((sum, op) => sum + HTTP_CALLS[op.op], 0);
  const extra = possible.reduce((sum, op) => sum + HTTP_CALLS[op.op], 0);
  out('');
  out(`  At most ${assumed + extra} HTTP call(s) in all${extra > 0 ? ` (${assumed} as planned, ${extra} more only if a rep is freed)` : ''}. HubSpot and Slack calls are rate-limited, not billed per call.`);
  if (calls.some((op) => op.op === 'read')) {
    out('  Each clock read depends on what HubSpot answers. This plan assumes every lead past its window is untouched,');
    out('  the answer that makes the most calls; a touched lead, or an owner a person set, stops that lead with no further call.');
  }
  out('  Each assignment counts its most HubSpot requests (read, create, read again, owner write); usually it takes two.');
  out('  Nothing was contacted and nothing was written. No token was needed to plan.');
  return 0;
}
