// The pipeline kernel. It executes an ordered sequence of stages under one contract and
// is the only writer to the ledger.
//
// Two invariants live here rather than in the stages, because a discipline that depends on
// every stage remembering it is not a discipline:
//
//   1. Fail-closed. A stage that throws, or returns something the contract does not
//      recognise, becomes a REFUSE. There is no path through this function where an error
//      becomes a PASS.
//   2. Uniform trail. Every stage execution writes exactly one verdict entry, plus any
//      supplementary evidence entries the stage returned. A stage cannot run silently.

import {
  PASS,
  REFUSE,
  NEEDS_HUMAN,
  assertStageResult,
  ContractViolationError,
} from './contract.mjs';
import { SEAL_STAGE, SEAL_LEAD_ID } from './ledger.mjs';
import { bills } from './billing.mjs';

const STAGE_ERROR = 'STAGE_ERROR';
const CONTRACT_VIOLATION = 'CONTRACT_VIOLATION';
const LEAD_CEILING_REACHED = 'LEAD_CEILING_REACHED';

// THE PER-RUN LEAD CEILING. docs/LEAD-CEILING-SPEC.md.
//
// In live mode the stages from `countedFrom` onward bill per lead, so the number of leads admitted
// to that stage is the number this run pays for. The CLI refuses to START a run whose signals are
// over the ceiling; this is the invariant behind that courtesy, and it holds for any caller wired to a billing transport (see below). A lead
// that would be admitted past the ceiling never runs that stage or any later one. It is REFUSED,
// with its own ledger line, filed under the stage it was refused entry to: never a silent
// truncation, and never a lead that simply goes missing from the report.
//
// WHEN A CEILING IS REQUIRED is decided by the WIRING, not by a label (CEILING-FINDINGS-SPEC, fix
// wave 1, I1 and I2). If either seam the kernel was handed is one of this repo's billing transports
// (src/billing.mjs), a valid ceiling is required, whatever config.mode says. If neither bills, as in
// fixture mode and in a replay from a capture, no ceiling is required, so a capture made before the
// ceiling existed still replays.
//
// Any `limits` that IS present must be readable, in every mode, and FAILS CLOSED when it is not
// (finding 2): maxLeads of null, '5' or 2.5 used to read as "no ceiling", so a caller that got the
// ceiling wrong billed every lead it had. With billing wired, the ceiling must also be counted at or
// before the first stage that declares `billing: true` (I3): counted later, every lead would have
// passed through the fetching stage before the count began, and the ceiling would bound nothing.
export class LeadCeilingMissingError extends Error {
  constructor(problem) {
    super(
      `${problem}. A live run needs config.limits with maxLeads a whole number of 1 or more and ` +
        'countedFrom the name of a stage in this pipeline. Nothing was run, so nothing was fetched ' +
        'or billed and no ledger line was written.',
    );
    this.name = 'LeadCeilingMissingError';
    this.code = 'LEAD_CEILING_MISSING';
  }
}

export function ceilingOf(config, stages, { billing = false } = {}) {
  const limits = config?.limits;
  if (limits === undefined || limits === null) {
    if (billing) {
      throw new LeadCeilingMissingError(
        'this run is wired to a transport that bills and its config carries no lead ceiling',
      );
    }
    return null;
  }
  if (typeof limits !== 'object') throw new LeadCeilingMissingError(`config.limits is ${JSON.stringify(limits)}`);
  const { maxLeads, countedFrom } = limits;
  if (!Number.isSafeInteger(maxLeads) || maxLeads < 1) {
    throw new LeadCeilingMissingError(`config.limits.maxLeads is ${String(maxLeads)}, which bounds nothing`);
  }
  if (typeof countedFrom !== 'string' || !stages.some((stage) => stage.name === countedFrom)) {
    throw new LeadCeilingMissingError(
      `config.limits.countedFrom is ${JSON.stringify(countedFrom ?? null)}, which is not a stage in this pipeline, so the ceiling would never be counted`,
    );
  }
  if (billing) {
    const firstBilling = stages.findIndex((stage) => stage.billing === true);
    if (firstBilling === -1) {
      throw new LeadCeilingMissingError(
        'this run is wired to a transport that bills and no stage declares billing: true, so the ' +
          'kernel cannot tell where the ceiling has to be counted',
      );
    }
    const counted = stages.findIndex((stage) => stage.name === countedFrom);
    if (counted > firstBilling) {
      throw new LeadCeilingMissingError(
        `config.limits.countedFrom is ${JSON.stringify(countedFrom)}, after ${stages[firstBilling].name}, the ` +
          'first stage that bills, so every lead would be billed there before the ceiling counted it',
      );
    }
  }
  return { maxLeads, countedFrom };
}

function initialLeadId(signal, index) {
  if (signal && typeof signal === 'object') {
    if (typeof signal.lead_id === 'string' && signal.lead_id !== '') return signal.lead_id;
    if (typeof signal.id === 'string' && signal.id !== '') return signal.id;
  }
  return `unidentified-${index}`;
}

function sortSignals(signals) {
  return signals
    .map((signal, index) => ({ signal, index, key: initialLeadId(signal, index) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index));
}

export async function runPipeline({ stages, signals, ctx, ledger }) {
  const leads = [];
  const summary = { PASS: 0, REFUSE: 0, NEEDS_HUMAN: 0, total: 0 };
  const ceiling = ceilingOf(ctx.config, stages, { billing: bills(ctx.fetch) || bills(ctx.model) });
  let admitted = 0;

  for (const { signal, index } of sortSignals(signals)) {
    let leadId = initialLeadId(signal, index);
    let input = signal;
    let finalStatus = PASS;
    let finalStage = null;
    let reasonCodes = [];

    for (const stage of stages) {
      let result;
      const overCeiling =
        ceiling !== null && stage.name === ceiling.countedFrom && admitted >= ceiling.maxLeads;
      if (ceiling !== null && stage.name === ceiling.countedFrom && !overCeiling) admitted += 1;

      try {
        result = overCeiling
          ? {
              status: REFUSE,
              output: input,
              entries: [],
              reason_codes: [LEAD_CEILING_REACHED],
              detail:
                `${stage.name} was not run: this run has a ceiling of ${ceiling.maxLeads} lead(s) and ` +
                `${admitted} were already admitted. Re-run the rest under a ceiling sized on purpose.`,
            }
          : assertStageResult(await stage.run(input, ctx), stage.name);
      } catch (error) {
        const isContract = error instanceof ContractViolationError;
        result = {
          status: REFUSE,
          output: input,
          entries: [],
          reason_codes: [isContract ? CONTRACT_VIOLATION : STAGE_ERROR],
          detail: error.message,
        };
      }

      // A stage may assign the canonical lead id — ingest does, deriving it from the
      // company and contact. Adopt it BEFORE stamping, so every entry for this stage,
      // including ingest's own verdict, files under one id and `explain <lead>` returns the
      // whole trail rather than one that starts at the second stage. What we knew before is
      // not lost: ingest records `signal:<id>` in its evidence.
      if (result.status === PASS) {
        const assigned = result.output;
        if (assigned && typeof assigned === 'object' && typeof assigned.lead_id === 'string') {
          leadId = assigned.lead_id;
        }
      }
      const stampedLeadId = leadId;

      const stamp = (entry) => ({
        reason_codes: [],
        evidence_refs: [],
        actor: 'system',
        verdict: result.status,
        stage: stage.name,
        ...entry,
        ts: ctx.clock.now(),
        run_id: ctx.run_id,
        lead_id: stampedLeadId,
      });

      for (const entry of result.entries) ledger.append(stamp(entry));

      ledger.append(
        stamp({
          stage: stage.name,
          verdict: result.status,
          reason_codes: result.reason_codes ?? [],
          evidence_refs: result.evidence_refs ?? [],
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        }),
      );

      finalStage = stage.name;
      finalStatus = result.status;
      reasonCodes = result.reason_codes ?? [];

      if (result.status !== PASS) break;

      input = result.output;
    }

    leads.push({
      lead_id: leadId,
      final_status: finalStatus,
      final_stage: finalStage,
      reason_codes: reasonCodes,
      output: input,
    });
    summary[finalStatus] += 1;
    summary.total += 1;
  }

  // Seal the run. The kernel remains the only ledger writer, and this is the entry that turns
  // "these lines verify as a chain" into "this is a complete record of a finished run".
  //
  // `head` duplicates what the seal's own `prev` link already says, deliberately. Because it
  // sits inside the hashed payload, rewriting the summary or the head breaks the seal's own
  // hash rather than merely disagreeing with the chain.
  ledger.append({
    ts: ctx.clock.now(),
    run_id: ctx.run_id,
    lead_id: SEAL_LEAD_ID,
    stage: SEAL_STAGE,
    verdict: PASS,
    reason_codes: ['RUN_SEALED'],
    evidence_refs: [],
    actor: 'system',
    sealed: true,
    summary,
    head: ledger.head(),
  });

  return { run_id: ctx.run_id, leads, summary };
}

export { PASS, REFUSE, NEEDS_HUMAN, STAGE_ERROR, CONTRACT_VIOLATION, LEAD_CEILING_REACHED };
