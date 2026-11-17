// The CLI. Ten verbs: run, run --live, queue, approve, reject, explain, replay, dashboard, dlq, inbound.
//
// This is where bytes reach disk. Stages do no I/O and the kernel writes only to an
// in-memory ledger, so putting every write in one place keeps the rest of the system
// testable with plain objects.
//
//
// THE APPROVAL LOOP, which is the shape of the whole tool:
//
//   run      composes drafts, gates them, and parks the survivors
//   queue    lists what is parked, with the content hash of each draft
//   approve  records a human decision BOUND TO THAT HASH
//   run      again; the approved draft is the only thing that moves

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeFixtureRun, buildRun, buildLiveRun, buildReplayRun, loadFixtures } from './runner.mjs';
import { recordingClock } from './context.mjs';
import { createLiveFetcher } from './live/http.mjs';
import { createLiveModel } from './live/anthropic.mjs';
import { nodeTransport } from './live/node-transport.mjs';
import {
  resolveModelKey,
  secretScrubber,
  publicConfig,
  secretFingerprint,
  SecretMismatchError,
} from './live/keys.mjs';
import {
  liveConfig,
  resolveSignalSecret,
  parseMaxLeads,
  DEFAULT_MAX_LEADS,
  MODEL_VARIABLE,
  SECRET_VARIABLE,
} from './live/config.mjs';
import { loadLiveSignals, liveSignalFromBytes } from './live/signals.mjs';
import { MODEL_CALLS_PER_LEAD, leadRequests, runRequests, plannedFetches } from './live/cost.mjs';
import { printable, maskUrl } from './terminal.mjs';

// Payload-derived text reaching the terminal goes through these (fix wave 2, N-A). `shown` is for
// short values such as ids and URLs and truncates at a stated length; `shownWhole` escapes only, for
// details whose full text an operator needs.
const shown = (value) => printable(value);
const shownWhole = (value) => printable(value, { max: Infinity });
const shownUrl = (value) => printable(maskUrl(value));
import { writeDeadLetter, readDeadLetters, isDeadLetterable, dlqPath } from './live/dlq.mjs';
import {
  loadDecisions,
  loadDecisionEntries,
  appendDecision,
  decisionsPath,
  decisionFor,
} from './decisions.mjs';
import { runPipeline } from './kernel.mjs';
import { parseLedger, verifyChain, isSealed, sealOf } from './ledger.mjs';
import { adapters } from './adapters.mjs';
import { buildDashboardView, renderDashboard } from './dashboard.mjs';
import { verbInbound } from './inbound/verb.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const USAGE = `signal-desk — a signal-to-outreach pipeline where every decision can be
inspected, replayed, or refused.

Usage:
  node bin/signal-desk.mjs run            Run the keyless fixture pipeline and write a ledger
  node bin/signal-desk.mjs run --live     Run real signals against real sources and a real model
  node bin/signal-desk.mjs queue          List drafts parked for a human, with their hashes
  node bin/signal-desk.mjs approve <id>   Approve a parked draft, binding to its content
  node bin/signal-desk.mjs reject <id>    Reject a parked draft, with an optional --note
  node bin/signal-desk.mjs explain <lead> Print the full decision trail for one lead
  node bin/signal-desk.mjs replay <run>   Re-execute a run and verify its ledger still matches
  node bin/signal-desk.mjs dashboard      Render a run's ledger as one self-contained HTML file
  node bin/signal-desk.mjs dlq            List payloads live ingest could not accept, and replay them
  node bin/signal-desk.mjs inbound        Give approved leads an owner, tell the rep, run the response clock

Flags, per verb. Anything else is refused rather than ignored, so no invocation can quietly
become a different one than you typed. Write them as "--flag value", never "--flag=value",
and give each value flag once: a repeated one is refused rather than guessed at. A flag typed with
one dash or a typographic dash (-plan, —plan) is refused, and so is any word a verb does not take.

  run       --live, --signals <dir>, --max-leads <n>, --plan
  approve   --by <name>, --note <text>
  reject    --by <name>, --note <text>
  dlq       --replay, --max-leads <n>
  inbound   --live, --plan, --rotation <file>, --at <instant>

There is no install step, so the invocation is spelled out in full. A bare signal-desk is
not on PATH in a fresh clone.

<id> is a draft hash or a lead id, and any unambiguous prefix of either will do.

An approval binds to the draft's CONTENT, never to the lead. Edit the draft and the old
decision stops covering it, so the lead parks again rather than going out unread.

Runs are written to ./runs/<run-id>/. The fixture demo needs no API key and no network.
This tool never sends mail; handoffs are written as dry-run JSON.

Live mode brings your own key. Export SIGNAL_DESK_ANTHROPIC_KEY (or ANTHROPIC_API_KEY)
and SIGNAL_DESK_SIGNAL_SECRET, put signed payload files in ./signals/, and every draft
faces exactly the gates the fixture demo shows.

A live run bills per lead: its evidence fetches and ${MODEL_CALLS_PER_LEAD} model calls, which retries
make up to ${leadRequests({}).modelCalls.worst} model attempts. So it has a lead ceiling: ${DEFAULT_MAX_LEADS} unless --max-leads <n> says
otherwise. A signals folder holding more than the ceiling refuses to start, before anything is
fetched, and names the count. Under the ceiling the same command is the real, billed run, so to
preview one use run --live --plan: it prints what would run and the request count, needs no key,
fetches nothing and writes nothing. dlq --replay is held to the same ceiling.

A live run captures what it observed, so it replays with no model key. Replaying also
verifies every payload signature when SIGNAL_DESK_SIGNAL_SECRET is set; without it, the
chain and the seal are verified and replay says plainly what it did not check. The capture
stores a fingerprint of that secret, never the secret itself.
`;

function runsDir(env, cwd) {
  return env.SIGNAL_DESK_RUNS_DIR ?? join(cwd, 'runs');
}

export const LATEST_POINTER = 'latest';

// The most recent run, by what actually happened rather than by how its id happens to sort.
//
// Run ids are hashes of the inputs. They carry no temporal ordering whatsoever, so sorting
// them and taking the last one picks an arbitrary run. `run` writes a pointer; this reads it,
// falling back to modification time for a runs directory produced before the pointer existed.
export function latestRunId(base) {
  if (!existsSync(base)) return null;

  const pointer = join(base, LATEST_POINTER);
  if (existsSync(pointer)) {
    const runId = readFileSync(pointer, 'utf8').trim();
    if (runId !== '' && existsSync(join(base, runId))) return runId;
  }

  const candidates = readdirSync(base)
    .filter((name) => name.startsWith('run-') && existsSync(join(base, name, 'ledger.jsonl')))
    .map((name) => ({ name, at: statSync(join(base, name)).mtimeMs }))
    .sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : 1));

  return candidates.length === 0 ? null : candidates[candidates.length - 1].name;
}

function pad(value, width) {
  return String(value).padEnd(width);
}

// Writes an export, and refuses to destroy a different one.
//
// Run scoping already separates runs, and the filename carries the draft hash, so two different
// messages to one person land in different files. What remains is the case where a path exists
// and the bytes DISAGREE, which means something is about to be lost. That refuses loudly.
//
// Identical bytes are not a collision. They are an idempotent re-run, which is what keeps
// `signal-desk run` safe to invoke twice into the same directory.
export class ArtifactClobberError extends Error {
  constructor(path) {
    super(
      `refusing to overwrite ${path}: a different artifact already exists at that path. ` +
        'An export that silently replaced a prior one would lose a record of something that was approved.',
    );
    this.name = 'ArtifactClobberError';
  }
}

export function writeArtifact(path, contents) {
  if (existsSync(path) && readFileSync(path, 'utf8') !== contents) {
    throw new ArtifactClobberError(path);
  }
  writeFileSync(path, contents);
}

// --- run -------------------------------------------------------------------------------

async function verbRun({ args, out, err, env, cwd }) {
  // Accepted by the flag table because run --live takes it, and refused here because a fixture run
  // bills nothing. Ignoring it would be a flag that silently means nothing, the --live=true shape.
  if (flagPresent(args, '--max-leads')) {
    err('--max-leads bounds a live run, and a fixture run bills nothing, so it has no ceiling.');
    err('Did you mean: node bin/signal-desk.mjs run --live --max-leads <n>');
    return 2;
  }
  if (flagPresent(args, '--plan')) {
    err('--plan previews a live run, and a fixture run bills nothing, so there is nothing to preview.');
    err('Did you mean: node bin/signal-desk.mjs run --live --plan');
    return 2;
  }
  // The same shape, found by the row 80 ship-check: --signals without --live ran the fixture demo and
  // ignored the folder, exit 0, so the operator believed their signals had been run.
  if (flagPresent(args, '--signals')) {
    err('--signals names the folder a live run reads, and a fixture run reads the committed corpus.');
    err('Did you mean: node bin/signal-desk.mjs run --live --signals <dir>');
    return 2;
  }
  const base = runsDir(env, cwd);
  // Decisions a human recorded with `approve` / `reject`, layered over the shipped corpus. A
  // fresh clone has none, which is what keeps the README's example output true for everyone.
  const { run_id, ledger, report } = await executeFixtureRun({ decisions: loadDecisions(base) });

  // No inputs file. A fixture run's inputs are the committed corpus, so writing a copy of them
  // into the run directory would duplicate the repo and invite the two to disagree. A LIVE run
  // writes one because its inputs exist nowhere else.
  writeRunArtifacts({ base, run_id, ledger, report, cwd, out });
  return 0;
}


// --- run --live ------------------------------------------------------------------------
//
// The same eight stages, with real transports behind the two seams. See docs/M4-SPEC.md and
// src/live/config.mjs for what changes and — the more important list — what does not.
//
// THE ORDER OF THE CHECKS IS PART OF THE BEHAVIOUR. Both credentials are resolved BEFORE any file
// is read, any URL is fetched, or any directory is created, so a missing key costs nothing and
// leaves nothing behind. A tool that half-ran and then complained about its configuration would
// have already contacted somebody's server on the strength of a run it could not finish.

export const LIVE_SIGNALS_DIR = 'signals';

function writeRunArtifacts({ base, run_id, ledger, report, cwd, out, inputs, mode }) {
  const dir = join(base, run_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ledger.jsonl'), ledger.toJSONL());

  // The capture, written beside the ledger because it is the other half of the same artifact. A
  // ledger says what was decided; this says what the decisions were made from. See M4 spec §6.
  if (inputs !== undefined) {
    writeFileSync(join(dir, 'inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`);
  }

  const handoffDir = join(dir, 'handoffs');
  mkdirSync(handoffDir, { recursive: true });
  const handed = report.leads.filter((lead) => lead.output?.handoff !== undefined);
  for (const lead of handed) {
    const { adapter, filename, artifact } = lead.output.handoff;
    writeArtifact(join(handoffDir, filename), adapters[adapter].serialize(artifact));
  }

  const parked = report.leads.filter(
    (lead) => lead.final_status === 'NEEDS_HUMAN' && lead.output?.draft_hash !== undefined,
  );
  if (parked.length > 0) {
    const parkedDir = join(dir, 'parked');
    mkdirSync(parkedDir, { recursive: true });
    for (const lead of parked) {
      writeArtifact(
        join(parkedDir, `${lead.lead_id}-${lead.output.draft_hash}.json`),
        `${JSON.stringify(
          {
            lead_id: lead.lead_id,
            draft_hash: lead.output.draft_hash,
            run_id,
            // Which entry point composed this, so `approve` can tell the operator the command that
            // will actually act on their decision. Telling a live operator to type `run` sends them
            // to the fixture corpus, which cannot contain their lead, and the tool then looks broken
            // for a reason that has nothing to do with their approval.
            mode: mode ?? 'fixture',
            owner: lead.output.route.owner,
            reason: lead.reason_codes.join(','),
            to: lead.output.draft.to,
            subject: lead.output.draft.subject,
            body: lead.output.draft.body,
          },
          null,
          2,
        )}\n`,
      );
    }
  }

  writeFileSync(join(base, LATEST_POINTER), `${run_id}\n`);

  const show = (path) => relative(cwd, path) || path;
  reportRun({ out, run_id, report, show, dir, handoffDir, handed, mode });
  return { dir, handed };
}

function reportRun({ out, run_id, report, show, dir, handoffDir, handed, mode }) {
  out(`run ${run_id}`);
  out('');
  out(`  ${report.summary.PASS} passed to handoff`);
  out(`  ${report.summary.NEEDS_HUMAN} awaiting a human`);
  out(`  ${report.summary.REFUSE} refused`);
  out(`  ${report.summary.total} signals in total`);
  out('');

  for (const lead of report.leads) {
    const reason = lead.reason_codes.length > 0 ? lead.reason_codes.join(',') : '';
    // An ingest-refused lead is filed under the payload's own id, so this can be a stranger's text.
    out(`  ${pad(shown(lead.lead_id), 22)} ${pad(lead.final_stage, 9)} ${pad(lead.final_status, 12)} ${reason}`);
  }

  out('');
  out(`  ledger    ${show(join(dir, 'ledger.jsonl'))}`);
  out(`  handoffs  ${handed.length} dry run artifact(s) in ${show(handoffDir)}`);
  out('');
  out('  Nothing was sent. This tool never sends mail.');
  out(`  Inspect a decision with: node bin/signal-desk.mjs explain <lead>`);
  // The M3 advocate's carry: `dashboard` existed and the run that produced it never mentioned it.
  out('  See the whole run at once with: node bin/signal-desk.mjs dashboard');
  if (report.summary.NEEDS_HUMAN > 0) {
    out(`  Act on what is parked with: node bin/signal-desk.mjs queue`);
  }
  void mode;
}

// Dead-letters what INGEST refused, and nothing else. The boundary is argued in src/live/dlq.mjs:
// "we could not accept this" has a fix at the sender, "we accepted it and said no" is a decision the
// ledger already holds and replaying it until it passes is not a recovery.
function deadLetterIngestRefusals({ base, report, signals, run_id, at, out }) {
  const written = [];
  for (const lead of report.leads) {
    if (lead.final_stage !== 'ingest' || lead.final_status !== 'REFUSE') continue;
    const reason = lead.reason_codes[0];
    if (!isDeadLetterable(reason)) continue;

    // The kernel files a refused ingest under the signal's own id, so the bytes are found by it.
    const signal = signals.find((candidate) => candidate.id === lead.lead_id) ?? {};
    written.push(
      writeDeadLetter(base, {
        reason,
        detail: lead.detail ?? null,
        source: signal.source_file ?? null,
        signal_id: signal.id ?? lead.lead_id,
        signature: signal.signature ?? '',
        raw: signal.raw ?? '',
        at,
        run_id,
      }),
    );
  }
  if (written.length > 0) {
    out('');
    out(`  ${written.length} signal(s) dead-lettered. Inspect with: node bin/signal-desk.mjs dlq`);
  }
  return written;
}

// THE START-TIME CEILING CHECK. docs/LEAD-CEILING-SPEC.md. After the credentials, before the
// transport exists, so a refusal has fetched nothing, called no model and written nothing. It
// counts parsed payloads, which is a conservative upper bound: the kernel counts the exact number
// (leads that cleared ingest) and stops AT the ceiling whatever a caller checked first.
//
// The advice depends on where the ceiling came from (CEILING-FINDINGS-SPEC minor 1). An operator who
// typed a low ceiling chose that cap, so telling them to raise it first argues against their own
// decision; they are told the ceiling was theirs and offered the split first.
function ceilingRefusal({ signals, maxLeads, fromFlag = false, replay = false, err }) {
  if (signals.length <= maxLeads) return false;
  const ceiling = fromFlag
    ? `a ceiling of ${maxLeads} lead(s), which you set with --max-leads ${maxLeads}`
    : `the default ceiling of ${maxLeads} lead(s)`;
  err(
    `LEAD_CEILING_EXCEEDED: ${signals.length} signal(s) to run and ${ceiling}. ` +
      `Every admitted lead bills its evidence fetches and ${MODEL_CALLS_PER_LEAD} model calls, up to ` +
      `${leadRequests({}).modelCalls.worst} model attempts with retries, so the run was refused before it ` +
      'started. Nothing was fetched, no model was called and no run was written.',
  );
  // CEILING-FINDINGS-SPEC minor 3: the count is an upper bound, and the operator should know why.
  err(
    'This check counts every parsed payload, including any ingest would refuse for a bad signature, ' +
      'so it can count more than would bill.',
  );
  err(
    // dlq --replay cannot be split (fix wave 1, M5): it re-feeds the whole queue, so the only advice it
    // can follow is the ceiling.
    replay
      ? `dlq --replay re-feeds every dead letter at once and cannot be split, so replaying these takes --max-leads ${signals.length}, which bills for all ${signals.length}. Until then they stay in the queue.`
      : fromFlag
      ? `Split the signals into runs of at most ${maxLeads}, or type --max-leads ${signals.length} only if you mean to bill for all ${signals.length}.`
      : `Split the signals across runs, or raise the ceiling on purpose with --max-leads ${signals.length}.`,
  );
  return true;
}

// Reads --max-leads if present. Returns the ceiling, or null after printing the refusal.
function maxLeadsFrom(args, err) {
  if (!flagPresent(args, '--max-leads')) return DEFAULT_MAX_LEADS;
  try {
    return parseMaxLeads(flagValue(args, '--max-leads'));
  } catch (error) {
    err(`${error.code}: ${error.message}`);
    return null;
  }
}

async function executeLive({ signals, dead, base, env, cwd, out, err, httpTransport, at, maxLeads = DEFAULT_MAX_LEADS, fromFlag = false, replay = false, announce = () => {} }) {
  // Credentials first, before anything is read or written. See the note above.
  let key;
  let secret;
  try {
    key = resolveModelKey(env);
    secret = resolveSignalSecret(env);
  } catch (error) {
    err(`${error.code}: ${error.message}`);
    return 2;
  }

  if (ceilingRefusal({ signals, maxLeads, fromFlag, replay, err })) return 2;

  // Only now has the run started. A caller's announcement printed before these checks would say a
  // replay began when it was about to be refused (CEILING-FINDINGS-SPEC minor 2).
  announce();

  const transport = httpTransport ?? nodeTransport();
  const clock = recordingClock();
  const config = liveConfig({ secret, startedAt: at, model: env[MODEL_VARIABLE], maxLeads });

  // The CLI is the one place that holds BOTH secrets, so it is the one place that can build the
  // scrubber every transport applies to text that came from outside. See test/key-hygiene.test.mjs.
  const scrub = secretScrubber([key, secret]);

  const { run_id, ledger, ctx, stages, capture, config: runConfig, recordingsSeed } = buildLiveRun({
    signals,
    config,
    clock,
    // THE LIVE APPROVAL LOOP, and omitting this broke it completely. A live lead parked, an
    // operator approved it, and the next `run --live` parked it again, forever, so no live lead
    // could ever reach handoff. Found by the M4 ship-check.
    //
    // It is the same CLASS as the M2 replay blocker: a SECOND ENTRY POINT missing a store the first
    // one loads. Both shipped for the same reason, which is the lesson worth keeping — the fixture
    // loop had a subprocess test walking run -> approve -> run since M2, and nothing walked it
    // across the live path. The gap was in the test coverage of the composition, not in anybody's
    // understanding of the queue.
    decisions: loadDecisions(base),
    // No run clock here, on purpose: the transport stamps its own observation. See the note in
    // src/live/http.mjs about the replay misalignment that taught us the difference.
    fetch: createLiveFetcher({ transport, scrub }),
    model: createLiveModel({ key, transport, model: config.model, scrub }),
  });

  const report = await runPipeline({ stages, signals, ctx, ledger });

  const written = writeRunArtifacts({
    base,
    run_id,
    ledger,
    report,
    cwd,
    out,
    mode: 'live',
    // Everything a replay needs and nothing a replay must not have. No key, no headers, no
    // endpoint: src/live/capture.mjs keeps those out and a test asserts it.
    inputs: {
      mode: 'live',
      // THE PUBLIC CONFIG, never the executing one. This file is the artifact the README tells you
      // to hand to other people, and it used to carry the signing secret verbatim. It now carries a
      // fingerprint; replay resolves the real secret from the environment. See src/live/keys.mjs for
      // the decision and what each of the three replay outcomes can honestly claim.
      config: publicConfig(runConfig),
      signals,
      recordings: capture,
      recordings_seed: recordingsSeed,
      clock: clock.readings(),
    },
  });

  // Payload files that never became a signal, plus everything ingest refused.
  for (const entry of dead) {
    writeDeadLetter(base, { ...entry, at, run_id });
  }
  deadLetterIngestRefusals({ base, report, signals, run_id, at, out });

  out('');
  out(`  Replay it with no key at all: node bin/signal-desk.mjs replay ${run_id}`);
  void written;
  return 0;
}

function flagPresent(args, name) {
  return args.includes(name);
}

async function verbRunLive({ args, out, err, env, cwd, now, httpTransport }) {
  const base = runsDir(env, cwd);
  const signalsDir = flagValue(args, '--signals') ?? join(cwd, LIVE_SIGNALS_DIR);
  const at = now();

  // A malformed ceiling is a malformed invocation, refused where an unknown flag is: before the
  // credentials are read, so the operator fixes the command they typed first.
  const maxLeads = maxLeadsFrom(args, err);
  if (maxLeads === null) return 2;

  if (flagPresent(args, '--plan')) return planLive({ args, signalsDir, maxLeads, out, err });

  // Read AFTER the credential check inside executeLive, so a keyless invocation touches no files.
  // The loader is passed as a thunk rather than its result for exactly that reason.
  let key;
  try {
    resolveModelKey(env);
    resolveSignalSecret(env);
  } catch (error) {
    err(`${error.code}: ${error.message}`);
    return 2;
  }
  void key;

  const { signals, dead, missingDir } = loadLiveSignals(signalsDir);
  if (missingDir) {
    err(`no signal directory at ${signalsDir}`);
    err('live mode reads payload files. Point it somewhere with --signals <dir>, or see the');
    err('live-mode section of the README for the file layout it expects.');
    return 2;
  }
  if (signals.length === 0 && dead.length === 0) {
    err(`${signalsDir} holds no .json payload files, so there is nothing to run`);
    return 2;
  }

  return executeLive({
    signals, dead, base, env, cwd, out, err, httpTransport, at, maxLeads,
    fromFlag: flagPresent(args, '--max-leads'),
  });
}

// --- run --live --plan ------------------------------------------------------------------
//
// THE FREE PREVIEW. docs/CEILING-FINDINGS-SPEC.md, finding 3. The start refusal is free only because
// it refuses; under the ceiling, the real command is the billed run. This reads the folder through
// the same loader and counts with the same function the refusal message uses, and it never builds a
// transport or runs a stage, so it cannot drift into being a second live mode. No credentials: it
// contacts nobody and verifies nothing, which is also why its counts are upper bounds.
function planLive({ args, signalsDir, maxLeads, out, err }) {
  const { signals, dead, missingDir } = loadLiveSignals(signalsDir);
  if (missingDir) {
    err(`no signal directory at ${signalsDir}`);
    err('live mode reads payload files. Point it somewhere with --signals <dir>, or see the');
    err('live-mode section of the README for the file layout it expects.');
    return 2;
  }
  if (signals.length === 0 && dead.length === 0) {
    err(`${signalsDir} holds no .json payload files, so there is nothing to run`);
    return 2;
  }

  const fromFlag = flagPresent(args, '--max-leads');
  const over = signals.length > maxLeads;
  const total = runRequests(signals);

  out(`plan for run --live over ${signalsDir}`);
  out('');
  out(`  ${signals.length} payload(s) parsed${dead.length > 0 ? `, ${dead.length} that will not parse (a run would dead-letter them; they never bill)` : ''}`);
  out(`  a ceiling of ${maxLeads} lead(s), ${fromFlag ? 'from your --max-leads' : 'the default'}`);
  out('');
  if (over) {
    out('  This run would be refused at start with LEAD_CEILING_EXCEEDED, which bills nothing.');
    out(`  To run all of it, split the folder, or type --max-leads ${signals.length} on purpose.`);
    out('');
    out('  Raised to run all of it, it could make:');
  } else {
    out('  This run would start. Typed without --plan, this is the real, billed run.');
    out('');
    out('  Requests it could make:');
  }
  out(`    expected    ${total.fetches.expected} fetch(es) and ${total.modelCalls.expected} model call(s), nothing retried`);
  out(`    worst case  ${total.fetches.worst} fetch(es) and ${total.modelCalls.worst} model attempt(s), every retry taken`);
  out(`    each model attempt asks for at most ${total.maxOutputTokensPerAttempt.toLocaleString('en-US')} output tokens`);
  out('');
  for (const signal of signals) {
    const lead = leadRequests(signal);
    // The URLs themselves, not a count (fix wave 1, M1): what an operator checks before paying for
    // a fetch is WHERE it goes.
    // Every payload-derived value is escaped, truncated and userinfo-masked (fix wave 2, N-A, N-D,
    // N-E): this is where an operator reads untrusted payloads, so it must not be forgeable.
    // Printed AFTER {domain} and {email} are expanded, by the run's own code, so what is listed and
    // counted is what the run fetches (review pass 3, X1).
    out(`    ${shown(signal.id ?? signal.source_file)}, ${lead.urls} evidence URL(s)`);
    const planned = plannedFetches(signal);
    const line = ({ url, template, fetchable }) => {
      const note = fetchable
        ? ''
        : url !== null
          ? '  (not https: refused before any request, not counted)'
          : '  (refused before any request, not counted)';
      return `${shownUrl(url ?? template)}${note}`;
    };
    for (const source of planned.filter((p) => p.kind === 'source')) {
      out(`      source           ${line(source)}`);
    }
    const identity = planned.find((p) => p.kind === 'identity');
    out(identity === undefined ? '      no identity source named' : `      identity source  ${line(identity)}`);
  }
  out('');
  out('  These are upper bounds. --plan does not verify signatures, so a payload ingest refuses is');
  out('  counted here and bills nothing past ingest. The price per request is your provider\'s.');
  out('  Nothing was fetched, no model was called and nothing was written.');
  return 0;
}

// --- dlq ---------------------------------------------------------------------------------

async function verbDlq(context) {
  const { args, out, err, env, cwd } = context;
  const base = runsDir(env, cwd);

  if (flagPresent(args, '--max-leads') && !flagPresent(args, '--replay')) {
    err('--max-leads bounds a replay, which bills like a live run. Listing the queue bills nothing.');
    err('Did you mean: node bin/signal-desk.mjs dlq --replay --max-leads <n>');
    return 2;
  }
  const maxLeads = maxLeadsFrom(args, err);
  if (maxLeads === null) return 2;

  const letters = readDeadLetters(base);

  if (flagPresent(args, '--replay')) {
    if (letters.length === 0) {
      out('nothing is dead-lettered, so there is nothing to replay.');
      return 0;
    }
    const signals = [];
    const dead = [];
    for (const letter of letters) {
      const { signal, dead: stillDead } = liveSignalFromBytes(letter.raw, letter.signature, letter.file);
      if (signal !== undefined) signals.push(signal);
      else dead.push(stillDead);
    }
    // WHY THIS NEEDS BOTH CREDENTIALS, recorded because it looks like over-strictness and is not.
    // A re-fed payload that clears ingest runs the whole pipeline, which drafts with the model. Asking
    // for the key only once a signal reached the draft stage would mean starting a run that dies
    // halfway, after fetching strangers' URLs, with some leads processed and some not. The signing
    // secret is needed even for a payload that will be refused again, because refusing it for an
    // invalid signature IS the verification. Both up front, or a partial run nobody asked for.
    // Printed by executeLive once the credential and ceiling checks pass, never before them.
    const announce = () => {
      out(`replaying ${letters.length} dead letter(s)`);
      out('');
      out('  Both credentials are required: a re-fed payload that clears ingest drafts with the model,');
      out('  and verifying a signature is what deciding to refuse one again consists of.');
      out('');
    };
    return executeLive({
      announce,
      replay: true,
      signals,
      dead,
      base,
      env,
      cwd,
      out,
      err,
      httpTransport: context.httpTransport,
      at: context.now(),
      maxLeads,
      fromFlag: flagPresent(args, '--max-leads'),
    });
  }

  if (letters.length === 0) {
    out('nothing is dead-lettered.');
    out('');
    out('  Every signal this pipeline was handed was accepted, or was refused for a reason the');
    out('  ledger records. A dead letter is a payload that never became a signal at all.');
    return 0;
  }

  out(`${letters.length} dead letter(s) in ${relative(cwd, dlqPath(base)) || dlqPath(base)}`);
  out('');
  for (const letter of letters) {
    out(`  ${shown(letter.file)}`);
    out(`    reason    ${shown(letter.reason)}`);
    out(`    signal    ${letter.signal_id == null ? '(never parsed)' : shown(letter.signal_id)}`);
    out(`    from      ${letter.source == null ? '(unknown)' : shown(letter.source)}`);
    if (letter.detail) out(`    detail    ${shownWhole(letter.detail)}`);
    out('');
  }
  out('  Each one keeps the exact bytes it arrived as, so a fix at the sender can be proven');
  out('  against the same message rather than a reconstruction of it.');
  out('');
  out('  Re-feed them with: node bin/signal-desk.mjs dlq --replay');
  return 0;
}

// --- queue / approve / reject -----------------------------------------------------------
//
// The approval workflow. `run` parks drafts, `queue` shows them, `approve` and `reject` record
// a human decision BOUND TO THE DRAFT'S CONTENT HASH, and the next `run` honours it.

function latestRunDir(env, cwd) {
  const base = runsDir(env, cwd);
  const runId = latestRunId(base);
  return runId === null ? null : join(base, runId);
}

function parkedDrafts(env, cwd) {
  const dir = latestRunDir(env, cwd);
  if (dir === null) return null;
  const parkedDir = join(dir, 'parked');
  if (!existsSync(parkedDir)) return [];
  return readdirSync(parkedDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(parkedDir, name), 'utf8')));
}

// Resolves what a human typed to exactly one parked draft.
//
// Accepts a draft hash, a lead id, or any unambiguous PREFIX of either, because these are
// hashes and nobody is going to retype one correctly. An ambiguous prefix is an error rather
// than a guess: approving the wrong draft is the failure this whole design exists to prevent.
function resolveParked(drafts, id) {
  const exact = drafts.filter((d) => d.draft_hash === id || d.lead_id === id);
  const matches = exact.length > 0
    ? exact
    : drafts.filter((d) => d.draft_hash.startsWith(id) || d.lead_id.startsWith(id));

  if (matches.length === 0) return { error: `nothing parked matches "${id}"` };
  if (matches.length > 1) {
    return {
      error:
        `"${id}" matches ${matches.length} parked drafts: ` +
        `${matches.map((d) => d.draft_hash).join(', ')}. Use more characters.`,
    };
  }
  return { draft: matches[0] };
}

async function verbQueue({ out, err, env, cwd }) {
  const drafts = parkedDrafts(env, cwd);
  if (drafts === null) {
    err('no runs found. Run `node bin/signal-desk.mjs run` first.');
    return 2;
  }

  if (drafts.length === 0) {
    out('nothing is parked for a human.');
    out('');
    out('  Every lead in the last run either reached handoff or was refused.');
    return 0;
  }

  out(`${drafts.length} draft(s) awaiting a human`);
  out('');
  for (const draft of drafts) {
    out(`  ${shown(draft.draft_hash)}`);
    out(`    lead     ${shown(draft.lead_id)}`);
    out(`    to       ${shown(draft.to)}`);
    out(`    subject  ${shown(draft.subject)}`);
    out(`    owner    ${shown(draft.owner)}`);
    out(`    status   ${shown(draft.reason)}`);
    out('');
  }
  out('  Approve with: node bin/signal-desk.mjs approve <draft-hash>');
  out('  Reject with:  node bin/signal-desk.mjs reject <draft-hash> --note "why"');
  out('');
  out('  A decision binds to the draft hash above. Change the draft and it stops applying.');
  return 0;
}

function flagValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function verbDecide(decision, { args, out, err, env, cwd, now }) {
  const id = args[0];
  if (id === undefined || id.startsWith('--')) {
    err(`${decision} needs a draft hash or lead id. Try: node bin/signal-desk.mjs queue`);
    return 2;
  }

  const drafts = parkedDrafts(env, cwd);
  if (drafts === null) {
    err('no runs found. Run `node bin/signal-desk.mjs run` first.');
    return 2;
  }

  const resolved = resolveParked(drafts, id);
  if (resolved.error !== undefined) {
    err(resolved.error);
    return 2;
  }

  const { draft } = resolved;

  // Deciding the same way twice is not an error and not news. Say so, record nothing, and exit
  // zero. Appending a duplicate would grow the store with lines that change nothing and make
  // the history harder to read, which is the opposite of what the store is for.
  //
  // A DIFFERENT decision is a different thing to say, so it is recorded and the latest binds.
  const standing = decisionFor(loadDecisionEntries(runsDir(env, cwd)), draft.draft_hash);
  if (standing !== undefined && standing.decision === decision) {
    out(`${draft.draft_hash} was already ${decision === 'approve' ? 'approved' : 'rejected'}`);
    out('');
    out(`  by       ${standing.by}`);
    out(`  at       ${standing.at}`);
    out('');
    out('  Nothing recorded; that decision already stands for this exact draft.');
    return 0;
  }

  let written;
  try {
    written = appendDecision(runsDir(env, cwd), {
      draft_hash: draft.draft_hash,
      lead_id: draft.lead_id,
      decision,
      by: flagValue(args, '--by') ?? 'cli-operator',
      at: now(),
      note: flagValue(args, '--note'),
      run_id: draft.run_id,
    });
  } catch (error) {
    err(error.message);
    return 1;
  }

  out(`${decision === 'approve' ? 'approved' : 'rejected'} ${draft.draft_hash}`);
  out('');
  out(`  lead     ${shown(draft.lead_id)}`);
  out(`  to       ${shown(draft.to)}`);
  out(`  subject  ${shown(draft.subject)}`);
  out(`  by       ${shown(written.by)}`);
  out('');
  out(`  recorded in ${relative(cwd, decisionsPath(runsDir(env, cwd))) || decisionsPath(runsDir(env, cwd))}`);
  out('  This decision covers that exact draft. Edit the text and it stops applying.');
  out('');
  // Mode-aware, because the two entry points read different signals. A live operator sent to plain
  // `run` lands in the fixture corpus, which cannot contain their lead, and the tool then looks
  // broken for a reason that has nothing to do with their approval.
  out(`  Run again to act on it: node bin/signal-desk.mjs run${draft.mode === 'live' ? ' --live' : ''}`);
  return 0;
}

// --- explain ---------------------------------------------------------------------------

async function verbExplain({ args, out, err, env, cwd }) {
  const leadId = args[0];
  if (leadId === undefined) {
    err('explain needs a lead id. Try: node bin/signal-desk.mjs explain <lead>');
    return 2;
  }

  const entries = await loadLatestLedger({ env, cwd, err });
  if (entries === null) return 2;

  const forLead = entries.filter((entry) => entry.lead_id === leadId);
  if (forLead.length === 0) {
    err(`lead ${shown(leadId)} not found in the latest ledger`);
    return 2;
  }

  out(`lead ${shown(leadId)}`);
  out(`run  ${shown(forLead[0].run_id)}`);
  out('');

  for (const entry of forLead) {
    out(`  ${entry.ts}  ${pad(entry.stage, 9)} ${pad(entry.verdict, 12)} ${entry.actor}`);
    if (entry.reason_codes.length > 0) out(`      reasons   ${entry.reason_codes.join(', ')}`);
    // A detail or an evidence ref can quote a payload or a source's answer, so both are escaped.
    if (entry.detail) out(`      detail    ${shownWhole(entry.detail)}`);
    if (entry.evidence_refs.length > 0) out(`      evidence  ${entry.evidence_refs.map(shownWhole).join('\n                ')}`);
  }

  const last = forLead[forLead.length - 1];
  out('');
  out(`  outcome: ${last.verdict} at ${last.stage}`);
  return 0;
}

async function loadLatestLedger({ env, cwd, err }) {
  const runId = latestRunId(runsDir(env, cwd));
  if (runId === null) {
    err('no runs found. Run `node bin/signal-desk.mjs run` first.');
    return null;
  }
  return parseLedger(readFileSync(join(runsDir(env, cwd), runId, 'ledger.jsonl'), 'utf8'));
}

// --- replay ----------------------------------------------------------------------------

async function verbReplay({ args, out, err, env, cwd }) {
  const runId = args[0];
  if (runId === undefined) {
    err('replay needs a run id. Try: node bin/signal-desk.mjs replay <run>');
    return 2;
  }

  const path = join(runsDir(env, cwd), runId, 'ledger.jsonl');
  if (!existsSync(path)) {
    err(`run ${runId} not found at ${path}`);
    return 2;
  }

  const recorded = readFileSync(path, 'utf8');
  const recordedEntries = parseLedger(recorded);

  if (recordedEntries.length === 0) {
    err(`run ${runId} has an empty ledger, so there is nothing to replay`);
    return 1;
  }

  // Two independent checks. The chain proves the file was not edited after it was written.
  // The re-execution proves the code still makes the same decisions from the same inputs.
  // A file can pass one and fail the other, and the difference matters.
  const chain = verifyChain(recordedEntries);
  if (!chain.ok) {
    err(`hash chain broken: ${chain.reason}`);
    err('the ledger was tampered with after it was written');
    return 1;
  }
  out(`hash chain verified across ${recordedEntries.length} entries`);

  // Completeness, which the chain does not cover. Every entry links to the one before it, so
  // nothing can be edited or reordered undetected, and yet nothing in that says the last line
  // here is the last line that was written. Truncating a ledger leaves a chain that verifies
  // perfectly clean. The seal is the terminal entry a completed run appends, so its absence is
  // how a truncation becomes visible.
  if (!isSealed(recordedEntries)) {
    err(`run ${runId} has no terminal seal, so it is not a record of a completed run`);
    err('the chain verified, which means nothing was edited. Lines were removed from the end,');
    err('or the run never finished. A hash chain proves order, not completeness.');
    return 1;
  }

  const seal = sealOf(recordedEntries);
  out(
    `seal verified: ${seal.summary.PASS} passed, ${seal.summary.NEEDS_HUMAN} parked, ` +
      `${seal.summary.REFUSE} refused, ${seal.summary.total} in total`,
  );

  // A LIVE run replays from its own capture. Its inputs — the responses, the completions and the
  // clock readings — exist nowhere else, so the run directory carries them and this reads them
  // back. Nothing here needs a key or a socket, which is the point: whoever you hand a run
  // directory to can re-derive every decision in it without your credentials.
  //
  // A FIXTURE run has no inputs file, because its inputs are the committed corpus. Writing a copy
  // into the run directory would duplicate the repo and invite the two to disagree.
  const inputsPath = join(runsDir(env, cwd), runId, 'inputs.json');
  let inputs = null;
  if (existsSync(inputsPath)) {
    inputs = JSON.parse(readFileSync(inputsPath, 'utf8'));

    // THE SIGNING SECRET IS NOT IN THE CAPTURE, by decision. See src/live/keys.mjs. Three outcomes,
    // and the point of separating them is that each can claim exactly what it checked.
    const fingerprint = inputs.config?.ingest?.secret_fingerprint;
    if (typeof fingerprint === 'string' && fingerprint !== '') {
      const supplied = env[SECRET_VARIABLE];
      const haveSecret = typeof supplied === 'string' && supplied.trim() !== '';

      if (haveSecret && secretFingerprint(supplied.trim()) !== fingerprint) {
        const mismatch = new SecretMismatchError();
        err(`${mismatch.code}: ${mismatch.message}`);
        return 1;
      }

      if (!haveSecret) {
        // Deliberately does NOT re-execute. Re-executing with no secret would skip the signature
        // check the original run performed and then print "exact match", which claims more than was
        // verified. What a reader needs is the boundary named and the way to cross it.
        out('');
        out('  signatures were NOT re-verified: this run signs over raw bytes and no signing');
        out(`  secret is available. Export ${SECRET_VARIABLE} to re-execute the run in full.`);
        out('');
        out('  What was verified: the ledger was not edited after it was written (chain), and it is');
        out('  the record of a completed run (seal).');
        out('  What was not: that each payload was signed by the sender you trust, and that');
        out('  re-executing the pipeline still produces these exact bytes.');
        return 0;
      }

      inputs = {
        ...inputs,
        config: { ...inputs.config, ingest: { ...inputs.config.ingest, secret: supplied.trim() } },
      };
    }
  }

  const replayed = inputs !== null
    ? buildReplayRun(inputs)
    : buildRun({
        fixtures: loadFixtures(),
        // The decisions have to be layered in exactly as `run` layers them, or this re-execution
        // is not a re-execution of the same run. Omitting them rebuilt the run from the fixture
        // corpus alone, which produced the fixture-only run id and reported "the inputs or the
        // wiring have changed" at the happy path's final step, blaming the user for a wiring bug.
        decisions: loadDecisions(runsDir(env, cwd)),
      });

  const { ledger, ctx, stages, signals, run_id } = replayed;
  // A capture whose ceiling cannot be read (hand-edited, or from a writer with a bug) is refused by
  // name. It used to surface as an uncaught stack trace (fix wave 1, I1).
  try {
    await runPipeline({ stages, signals, ctx, ledger });
  } catch (error) {
    if (typeof error?.code !== 'string' || !error.code.startsWith('LEAD_CEILING_')) throw error;
    err(`${error.code}: ${error.message}`);
    return 1;
  }

  if (run_id !== runId) {
    err(`replay produced ${run_id}, which does not match ${runId}`);
    err('the inputs or the wiring have changed since that run');
    return 1;
  }

  if (ledger.toJSONL() !== recorded) {
    err(`replay of ${runId} differs from the recorded ledger`);
    return 1;
  }

  out(`replay of ${runId} is an exact match`);
  out(`${recordedEntries.length} entries, identical bytes, chain intact`);
  if (inputs?.config?.ingest?.secret_fingerprint !== undefined) {
    out('every payload signature was re-verified against the secret you supplied');
  }
  return 0;
}

// --- dashboard ---------------------------------------------------------------------------
//
// One self-contained HTML file over one run's ledger, written into that run's own directory.
//
// It is READ-ONLY, per DESIGN.md's non-scope: approvals happen in the CLI only, and the page
// does not carry a control that could mutate one or a control that looks like it might. The
// renderer is a pure function in src/dashboard.mjs and this is the only thing here that writes.

export const DASHBOARD_FILE = 'dashboard.html';

async function verbDashboard({ args, out, err, env, cwd }) {
  const base = runsDir(env, cwd);
  const runId = args[0] ?? latestRunId(base);

  if (runId === null || runId === undefined) {
    err('no runs found. Run `node bin/signal-desk.mjs run` first.');
    return 2;
  }

  const ledgerPath = join(base, runId, 'ledger.jsonl');
  if (!existsSync(ledgerPath)) {
    err(`run ${runId} not found at ${ledgerPath}`);
    return 2;
  }

  const entries = parseLedger(readFileSync(ledgerPath, 'utf8'));
  if (entries.length === 0) {
    err(`run ${runId} has an empty ledger, so there is nothing to draw`);
    return 1;
  }

  // The chain is checked BEFORE anything is rendered, and nothing is written when it fails.
  // A confident dashboard over a record that was edited after it was written is the false-clean
  // reading this whole repo exists to prevent, and it would be worse than the raw file because
  // it looks authoritative. `replay` makes the same check for the same reason.
  const chain = verifyChain(entries);
  if (!chain.ok) {
    err(`hash chain broken: ${chain.reason}`);
    err('the ledger was tampered with after it was written, so no picture of it can be trusted');
    err('nothing was written');
    return 1;
  }

  const view = buildDashboardView(entries);
  const path = join(base, runId, DASHBOARD_FILE);
  writeFileSync(path, renderDashboard(view));

  const show = (target) => relative(cwd, target) || target;

  out(`dashboard ${runId}`);
  out('');
  out(`  ${view.entry_count} ledger entries across ${view.leads.length} lead(s)`);
  if (view.seal !== null) {
    out(
      `  ${view.seal.summary.PASS} passed, ${view.seal.summary.NEEDS_HUMAN} parked, ` +
        `${view.seal.summary.REFUSE} refused`,
    );
  } else {
    out('  no terminal seal: this is not a record of a completed run');
  }
  out(`  ${view.refusals.length} distinct refusal reason(s), ${view.decisions.length} human decision(s)`);
  out('');
  out(`  ${show(path)}`);
  out('');
  out('  Open it in a browser. It is one file, works offline, and fetches nothing.');
  out('  It is a read-only view. Decisions are still made with: node bin/signal-desk.mjs approve <id>');
  return 0;
}

// --- flag discipline -------------------------------------------------------------------
//
// A MODE IS NEVER INFERRED FROM A FLAG THE CLI DOES NOT RECOGNISE.
//
// `run --live=true` used to run the FIXTURE corpus and exit 0, which is the failure shape this repo
// dislikes most: a plausible success nobody chose. The operator believes they ran against their own
// signals with their own key; they got the demo, with a zero exit code and output that looks exactly
// like a working run. Nothing downstream could tell them otherwise, because nothing downstream was
// wrong.
//
// So the accepted flags are declared per verb and anything else refuses. Declared as data rather than
// checked inline, because the failure being designed out is somebody adding a flag in one place and
// forgetting the other.

const ACCEPTED_FLAGS = Object.freeze({
  run: ['--live', '--signals', '--max-leads', '--plan'],
  queue: [],
  approve: ['--by', '--note'],
  reject: ['--by', '--note'],
  explain: [],
  replay: [],
  dashboard: [],
  dlq: ['--replay', '--max-leads'],
  inbound: ['--live', '--plan', '--rotation', '--at'],
});

// Flags that take a value, so the value is not mistaken for a flag or for a positional argument.
const FLAGS_WITH_VALUES = Object.freeze(['--signals', '--by', '--note', '--max-leads', '--rotation', '--at']);

// EVERY TOKEN IS ACCOUNTED FOR. docs/CEILING-FINDINGS-SPEC.md, fix wave 1, B1.
//
// The check above used to skip any token that did not start with "--", so `run --live -plan`,
// `run --live —plan` (an em dash, which editors and chat apps substitute for two hyphens) and
// `run --live plan` all ran the REAL billed run. A mistyped preview was the bill. Now a token is an
// accepted flag, an accepted flag's value, or the verb's one positional argument in first place, and
// anything else refuses. What each verb takes in first place:
const POSITIONAL = Object.freeze({
  run: null,
  queue: null,
  dlq: null,
  inbound: null,
  approve: 'the draft hash or lead id',
  reject: 'the draft hash or lead id',
  explain: 'the lead id',
  replay: 'the run id',
  dashboard: 'the run id',
});

// A hyphen-minus, an en dash, an em dash or a minus sign, followed by something. None of these is a
// flag this CLI accepts, and none is a draft hash, lead id or run id either.
const DASH_LIKE = /^[-\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/u;

function strayToken(verb, arg, index) {
  if (DASH_LIKE.test(arg)) {
    const name = arg.replace(/^[-\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]+/u, '');
    return (
      `unknown flag ${arg}. Flags are written with two ASCII hyphens, like --${name}. ` +
      'Nothing was read, fetched or written.'
    );
  }
  const positional = POSITIONAL[verb];
  if (index === 0 && positional) return null;
  return (
    `unexpected argument ${JSON.stringify(arg)}: ${verb} takes ` +
    `${positional ? `one positional argument, ${positional}, written first` : 'no positional argument'}. ` +
    'Nothing was read, fetched or written.'
  );
}

function unknownFlag(verb, args) {
  const accepted = ACCEPTED_FLAGS[verb];
  if (accepted === undefined) return null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== 'string') continue;
    if (!arg.startsWith('--')) {
      const stray = strayToken(verb, arg, index);
      if (stray !== null) return stray;
      continue;
    }

    // `--flag=value` is refused even when `--flag` is accepted, rather than being parsed. Supporting
    // one spelling and silently ignoring the other is how `--live=true` became a fixture run; a CLI
    // this small is better off accepting exactly one form and saying so.
    if (arg.includes('=')) {
      const [name] = arg.split('=');
      return accepted.includes(name)
        ? `${arg} is not a form this CLI accepts. Write it as: ${name}${FLAGS_WITH_VALUES.includes(name) ? ' <value>' : ''}`
        : `unknown flag ${arg}`;
    }

    if (!accepted.includes(arg)) return `unknown flag ${arg}`;
    if (FLAGS_WITH_VALUES.includes(arg)) {
      const value = args[index + 1];
      // A value flag with nothing after it, or with another flag where its value belongs, used to
      // fall back to the default (`--signals` alone ran ./signals). --max-leads is exempt: its own
      // parser refuses a missing value with LEAD_CEILING_INVALID, which is the code it documents.
      if (arg !== '--max-leads' && (typeof value !== 'string' || value.startsWith('--'))) {
        return `FLAG_VALUE_MISSING: ${arg} needs a value and got ${value === undefined ? 'nothing' : `the flag ${value}`}. Nothing was read, fetched or written.`;
      }
      index += 1;
    }
  }

  return repeatedValueFlag(args);
}

// A VALUE FLAG SAYS ONE THING, ONCE. docs/CEILING-FINDINGS-SPEC.md, finding 1.
//
// `--max-leads 500 --max-leads 5` used to run under 500, because flagValue takes the first match.
// Neither "first wins" nor "last wins" is safe: either is a guess about which value the operator
// meant, and for --max-leads and --signals the wrong guess is a bill. So a repeat is refused, and
// the refusal names every value it was given. Boolean flags may repeat; they cannot disagree.
function repeatedValueFlag(args) {
  const seen = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!FLAGS_WITH_VALUES.includes(arg)) continue;
    seen.set(arg, [...(seen.get(arg) ?? []), args[index + 1]]);
    index += 1;
  }
  for (const [flag, values] of seen) {
    if (values.length > 1) {
      return (
        `FLAG_REPEATED: ${flag} was given ${values.length} times (${values.map((v) => JSON.stringify(v ?? null)).join(', ')}). ` +
        'This CLI takes one value per flag and will not guess which one you meant, so nothing was read, ' +
        `fetched or written. Type ${flag} once.`
      );
    }
  }
  return null;
}

// --- dispatch --------------------------------------------------------------------------

export async function main({
  argv = [],
  out = console.log,
  err = console.error,
  env = process.env,
  cwd = process.cwd(),
  // Injected, like the pipeline's clock. A human decision happens at a real instant rather
  // than a pipeline position, and a test that needs a fixed one should not have to freeze
  // the process clock to get it.
  now = () => new Date().toISOString(),
  // The HTTP implementation live mode uses. Injected so the live paths can be driven without a
  // socket; when it is absent the CLI builds the real one, and src/live/node-transport.mjs is the
  // only module in the repo that can. See test/no-network.test.mjs.
  httpTransport,
} = {}) {
  const [verb, ...args] = argv;
  const context = { args, out, err, env, cwd, now, httpTransport };

  // Before anything runs, and before a mode is chosen. An unrecognised flag is refused rather than
  // ignored, so no invocation can quietly become a different one than the operator typed.
  const flagProblem = unknownFlag(verb, args);
  if (flagProblem !== null) {
    err(flagProblem);
    const accepted = ACCEPTED_FLAGS[verb];
    err(
      accepted.length === 0
        ? `${verb} takes no flags.`
        : `${verb} accepts: ${accepted.join(', ')}`,
    );
    return 2;
  }

  switch (verb) {
    case 'run':
      return args.includes('--live') ? verbRunLive(context) : verbRun(context);
    case 'dlq':
      return verbDlq(context);
    case 'inbound':
      // The transport is built here, on demand, because this module is the only one allowed to import
      // node-transport.mjs (test/no-network.test.mjs). A fixture tick and --plan never call it.
      return verbInbound({ ...context, makeTransport: () => httpTransport ?? nodeTransport() });
    case 'queue':
      return verbQueue(context);
    case 'approve':
      return verbDecide('approve', context);
    case 'reject':
      return verbDecide('reject', context);
    case 'explain':
      return verbExplain(context);
    case 'replay':
      return verbReplay(context);
    case 'dashboard':
      return verbDashboard(context);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      out(USAGE);
      return verb === undefined ? 2 : 0;
    default:
      err(`unknown verb: ${verb}`);
      err(USAGE);
      return 2;
  }
}

export { PACKAGE_ROOT };
