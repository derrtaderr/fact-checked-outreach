// The inbound engine. docs/INBOUND-SPEC.md.
//
// One call is one TICK: finish any attempt a crash or a failure interrupted, take the new leads, then
// check every open assignment against the response clock. No file, no network and no wall clock of
// its own: the journal, both adapters and `now` are handed in, which is what lets the tests crash it at
// every line and replay it at any instant.
//
// THE ONE RULE EVERYTHING ELSE RESTS ON: an intent line is appended BEFORE each side effect and a
// result line AFTER it, and the state is a fold of those lines. So wherever a crash lands, the journal
// says which rep the attempt belongs to (the pointer moved in the same line), whether HubSpot was
// written, and whether a Slack post may exist. The spec's table walks every crash point.

import { pickRep } from './rotation.mjs';
import { buildSlackMessage, markerFor } from './message.mjs';
import { InboundAdapterError } from './errors.mjs';

// --- the fold -------------------------------------------------------------------------------------

/** State from journal entries. Pure; called afresh whenever the engine needs the current picture. */
export function fold(entries) {
  const pointers = {};
  const leads = new Map();

  for (const entry of entries) {
    if (entry.type === 'claim') {
      const previous = pointers[entry.pool];
      pointers[entry.pool] = entry.rep_id;
      let lead = leads.get(entry.key);
      if (lead === undefined) {
        lead = { key: entry.key, lead_id: entry.lead_id, pool: entry.pool, brief: entry.brief, attempts: [], stopped: null };
        leads.set(entry.key, lead);
      }
      lead.attempts.push({
        attempt: entry.attempt,
        rep_id: entry.rep_id,
        owner_id: entry.owner_id,
        slack_user_id: entry.slack_user_id,
        claimed_at: entry.at,
        reassigned: entry.reassigned ?? null,
        crm: null,
        crm_failure: null,
        slack: null,
        slack_open: false,
        slack_channel: null,
        slack_failure: null,
        released: null,
        previous_pointer: previous,
      });
      continue;
    }
    const lead = leads.get(entry.key);
    if (lead === undefined) continue;
    const attempt = lead.attempts.find((a) => a.attempt === entry.attempt);
    switch (entry.type) {
      case 'crm_written':
        // owner_id: the owner actually written, which is what the clock compares HubSpot against. It
        // can differ from the claim's when the rotation file was corrected between a failure and the retry.
        attempt.crm = { at: entry.at, contact_id: entry.contact_id, owner_id: entry.owner_id ?? attempt.owner_id };
        attempt.crm_failure = null;
        break;
      case 'crm_failed':
        attempt.crm_failure = { code: entry.code, detail: entry.detail };
        break;
      case 'slack_attempt':
        attempt.slack_open = true;
        attempt.slack_attempt_at = entry.at;
        attempt.slack_channel = entry.channel ?? attempt.slack_user_id;
        break;
      case 'slack_posted':
        attempt.slack = { at: entry.at, ts: entry.ts };
        attempt.slack_open = false;
        attempt.slack_failure = null;
        break;
      case 'slack_failed':
        attempt.slack_open = false;
        attempt.slack_failure = { code: entry.code, detail: entry.detail };
        break;
      case 'released':
        attempt.released = { at: entry.at, reason: entry.reason };
        break;
      case 'already_owned':
        // The rep never had the lead, so the turn is given back, unless the pool has moved on since.
        if (pointers[lead.pool] === attempt.rep_id) {
          if (attempt.previous_pointer === undefined) delete pointers[lead.pool];
          else pointers[lead.pool] = attempt.previous_pointer;
        }
        lead.stopped = { type: entry.type, at: entry.at, detail: entry.detail };
        break;
      case 'touched':
      case 'owner_changed':
      case 'exhausted':
        lead.stopped = { type: entry.type, at: entry.at, detail: entry.detail };
        break;
      default:
        break;
    }
  }

  return { pointers, leads };
}

const latest = (lead) => lead.attempts[lead.attempts.length - 1];

/** rep id -> open assignments held, for capacity. Open: latest attempt theirs, clock not stopped. */
export function openCounts(state) {
  const open = {};
  for (const lead of state.leads.values()) {
    if (lead.stopped !== null || latest(lead).released !== null) continue;
    const rep = latest(lead).rep_id;
    open[rep] = (open[rep] ?? 0) + 1;
  }
  return open;
}

// --- the engine -----------------------------------------------------------------------------------

const scrubbed = (scrub, error) => scrub(String(error?.message ?? error));

/**
 * One tick.
 *
 *   events    [{ key, lead }]  key is the signal id; lead is the brief (lead_id, pool, company, to, ...)
 *   rotation  from parseRotationConfig
 *   journal   a Journal
 *   hubspot   { assign, read }
 *   slack     { post, find }
 *   now       () -> ISO instant. The tick reads it once for its clock decisions, and once per line.
 *   scrub     removes any secret from upstream error text before it is journaled or printed
 *
 * Returns { at, outcomes: [{ key, lead_id, status, code?, detail, rep? }], repaired }.
 */
export async function tick({ events, rotation, journal, hubspot, slack, now, scrub = (text) => text, uncertain = false, onOutcome = () => {} }) {
  const at = now();
  const state = () => fold(journal.entries());
  const outcomes = new Map();
  // onOutcome: called as each lead's outcome is settled, after every call made for it. --plan uses it
  // to say which lead each recorded call belongs to.
  const say = (key, lead_id, outcome) => {
    const settled = { key, lead_id, ...outcome };
    outcomes.set(key, settled);
    onOutcome(settled);
  };

  // Appends an intent or result line for one lead's attempt.
  const write = (record) => journal.append({ ...record, at: now() });

  // What a failure means for the next run, by code: some clear on their own, others repeat until a
  // person fixes the rotation file or the token, and the output must say which.
  function nextStep(code, rep) {
    switch (code) {
      case 'HUBSPOT_INVALID_OWNER':
        return `this repeats until hubspot_owner_id for ${rep} is corrected in the rotation file; each run reads the file again`;
      case 'HUBSPOT_UNAUTHORIZED':
      case 'HUBSPOT_SCOPE_MISSING':
        return 'this repeats until the HubSpot token or its scopes are fixed';
      case 'SLACK_REJECTED':
        return `if Slack named the channel or user, this repeats until slack_user_id for ${rep} is corrected in the rotation file (each run reads it again) or the bot token is fixed`;
      default:
        return null;
    }
  }

  // A claim whose rep is no longer in the lead's pool is released, with the reason journaled, and the
  // lead is assigned again from the rotation as it is now. The released rep never had a working turn,
  // so the next rep's message is a plain assignment, not "reassigned because untouched".
  async function reclaim(key, why) {
    const lead = state().leads.get(key);
    const attempt = latest(lead);
    const tried = lead.attempts.filter((a) => a.released === null).map((a) => a.rep_id);
    const known = state();
    const pick = pickRep({ rotation, pool: lead.pool, last: known.pointers[lead.pool], open: openCounts(known), exclude: tried });
    if (pick.rep === undefined) {
      return {
        status: 'REASSIGN_WAITING',
        code: pick.code,
        detail: `${why}. Nobody can take it yet: ${pick.detail}. The next run tries again`,
      };
    }
    claim(lead, pick, attempt.attempt + 1);
    const outcome = await complete(key);
    return { ...outcome, detail: `${outcome.detail}. ${why}` };
  }

  // Finishes the latest attempt of a lead in the journal: HubSpot first, then Slack. The rep's ids
  // are read from the rotation as it is NOW, not frozen from the claim, so a corrected file heals a
  // retry. The ids actually used are journaled on the result lines.
  async function complete(key) {
    const lead = state().leads.get(key);
    const attempt = latest(lead);
    if (attempt.released !== null) return reclaim(key, attempt.released.reason);

    const now_ = (rotation.pools[lead.pool] ?? []).find((r) => r.id === attempt.rep_id);
    if (now_ === undefined) {
      const reason = `${attempt.rep_id} was claimed for this lead but is no longer in the "${lead.pool}" rotation, so the claim was released`;
      write({ type: 'released', key, attempt: attempt.attempt, reason });
      return reclaim(key, reason);
    }
    const rep = { id: attempt.rep_id, slack_user_id: now_.slack_user_id };
    const label = attempt.reassigned ? 'REASSIGNED' : 'ASSIGNED';

    if (attempt.crm === null) {
      // The journal write sits OUTSIDE the try. A crash while recording the result is a crash, not a
      // HubSpot failure; caught here it would be journaled as crm_failed, which is a false record.
      let written;
      try {
        written = await hubspot.assign({
          email: lead.brief.to,
          ownerId: now_.hubspot_owner_id,
          properties: { company: lead.brief.company },
          // Owners this tool wrote, or may have written before a crash, for this lead: replacing those
          // is the rotation working. Any other owner is a person's decision.
          mayReplace: [...new Set(lead.attempts.flatMap((a) => [a.owner_id, a.crm?.owner_id]).filter(Boolean))],
          overwrite: rotation.overwrite_owner === true,
        });
      } catch (error) {
        const code = error?.code ?? 'HUBSPOT_UNAVAILABLE';
        const detail = scrubbed(scrub, error);
        write({ type: 'crm_failed', key, attempt: attempt.attempt, code, detail });
        const blocked = nextStep(code, rep.id);
        return {
          status: 'CRM_PENDING',
          code,
          rep: rep.id,
          detail: `HubSpot did not take the owner (${detail}). ${rep.id} keeps this turn and is not told until the owner is written; ${blocked ?? 'the next run writes the owner again'}`,
        };
      }
      if (written.refused === 'ALREADY_OWNED') {
        const detail =
          `the contact already has owner ${written.ownerId} in HubSpot, which this tool did not write. It was left alone, ` +
          `nobody was told and ${rep.id} keeps their turn. To let the tool replace owners it did not write, set "overwrite_owner": true in the rotation file`;
        write({ type: 'already_owned', key, attempt: attempt.attempt, owner_seen: written.ownerId, detail });
        return { status: 'ALREADY_OWNED', rep: rep.id, detail };
      }
      write({ type: 'crm_written', key, attempt: attempt.attempt, contact_id: written.contactId, owner_id: now_.hubspot_owner_id });
    }

    const current = latest(state().leads.get(key));
    if (current.slack !== null) return { status: label, rep: rep.id, detail: `owner written, ${rep.id} told` };

    const message = buildSlackMessage({
      lead: lead.brief,
      rep,
      key,
      attempt: attempt.attempt,
      contactId: current.crm.contact_id,
      reassigned: attempt.reassigned ?? undefined,
    });

    // A post that may exist: ask Slack before posting again. `uncertain` (inbound --recover, after the
    // journal lost lines) treats EVERY post this tick as one that may exist.
    if (current.slack_open || uncertain) {
      let found;
      try {
        // Searched where the earlier post went, which the slack_attempt line recorded.
        found = await slack.find({ channel: current.slack_channel ?? message.channel, marker: message.marker, oldest: current.slack_attempt_at ?? null });
      } catch (error) {
        return {
          status: 'SLACK_UNCONFIRMED',
          code: error?.code ?? 'SLACK_UNSEARCHABLE',
          rep: rep.id,
          detail:
            `a post to ${rep.id} may or may not have landed, and Slack could not be asked (${scrubbed(scrub, error)}). ` +
            `Nothing was posted again. Look for ${markerFor(key, attempt.attempt)} in their messages`,
        };
      }
      if (found !== null) {
        write({ type: 'slack_posted', key, attempt: attempt.attempt, ts: found.ts, found: true });
        return { status: label, rep: rep.id, detail: `owner written, ${rep.id} told (the earlier post was found, not repeated)` };
      }
    }

    write({ type: 'slack_attempt', key, attempt: attempt.attempt, marker: message.marker, channel: message.channel });
    // As above: a crash while recording a post that landed must stay a crash. Caught here, it would be
    // journaled as slack_failed and the next run would post a second time.
    let posted;
    try {
      posted = await slack.post(message);
    } catch (error) {
      const code = error?.code ?? 'SLACK_UNREACHABLE';
      // Only a named refusal that proves nothing was posted may be retried by posting. Anything else,
      // including an error the adapter did not name, may have landed and goes through find first.
      if (!(error instanceof InboundAdapterError) || error.ambiguous) {
        return {
          status: 'SLACK_UNCONFIRMED',
          code,
          rep: rep.id,
          detail: `the post to ${rep.id} may have landed (${scrubbed(scrub, error)}). The next run asks Slack before posting again`,
        };
      }
      write({ type: 'slack_failed', key, attempt: attempt.attempt, code, detail: scrubbed(scrub, error) });
      const blocked = nextStep(code, rep.id);
      return {
        status: 'SLACK_PENDING',
        code,
        rep: rep.id,
        detail: `the owner is written; Slack refused the post (${scrubbed(scrub, error)}). ${blocked === null ? 'The next run posts it' : `The next run posts it again; ${blocked}`}`,
      };
    }
    write({ type: 'slack_posted', key, attempt: attempt.attempt, ts: posted.ts });
    return { status: label, rep: rep.id, detail: `owner written, ${rep.id} told` };
  }

  function claim(lead, pick, attempt, reassigned) {
    write({
      type: 'claim',
      key: lead.key,
      lead_id: lead.lead_id,
      pool: lead.pool,
      ...(attempt === 0 ? { brief: lead.brief } : {}),
      attempt,
      rep_id: pick.rep.id,
      owner_id: pick.rep.hubspot_owner_id,
      slack_user_id: pick.rep.slack_user_id,
      ...(reassigned === undefined ? {} : { reassigned }),
    });
  }

  // 1. Finish what was interrupted.
  for (const lead of state().leads.values()) {
    const attempt = latest(lead);
    if (lead.stopped === null && (attempt.released !== null || attempt.crm === null || attempt.slack === null)) {
      say(lead.key, lead.lead_id, await complete(lead.key));
    }
  }

  // 2. New leads, in key order so a run is repeatable.
  const sorted = [...events].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { key, lead } of sorted) {
    const known = state();
    if (known.leads.has(key) || outcomes.has(key)) continue;
    if (typeof lead?.to !== 'string' || lead.to.trim() === '') {
      say(key, lead?.lead_id, { status: 'REFUSED', code: 'LEAD_HAS_NO_EMAIL', detail: 'the approved draft has no recipient address, so there is no contact to own' });
      continue;
    }
    const holder = [...known.leads.values()].find((other) => other.lead_id === lead.lead_id);
    if (holder !== undefined) {
      say(key, lead.lead_id, {
        status: 'LEAD_ALREADY_ASSIGNED',
        rep: latest(holder).rep_id,
        detail: `this person already came in as ${holder.key} and is with ${latest(holder).rep_id}; a new signal id does not take another rep's turn`,
      });
      continue;
    }
    const pick = pickRep({ rotation, pool: lead.pool, last: known.pointers[lead.pool], open: openCounts(known) });
    if (pick.rep === undefined) {
      say(key, lead.lead_id, { status: 'REFUSED', code: pick.code, detail: `${pick.detail}. Nobody was assigned and the rotation did not move` });
      continue;
    }
    claim({ key, lead_id: lead.lead_id, pool: lead.pool, brief: lead }, pick, 0);
    const outcome = await complete(key);
    say(key, lead.lead_id, pick.note === undefined ? outcome : { ...outcome, detail: `${outcome.detail}. ${pick.note}` });
  }

  // 3. The clock, for every assignment whose rep has been told and whose clock is still running.
  for (const lead of state().leads.values()) {
    // Already reported this tick (just assigned, or resumed): its clock started moments ago.
    if (outcomes.has(lead.key)) continue;
    const attempt = latest(lead);
    if (lead.stopped !== null || attempt.slack === null) continue;
    const deadline = Date.parse(attempt.slack.at) + rotation.response_minutes * 60000;
    if (Date.parse(at) < deadline) {
      const left = Math.ceil((deadline - Date.parse(at)) / 60000);
      say(lead.key, lead.lead_id, {
        status: 'CLOCK_RUNNING',
        rep: attempt.rep_id,
        detail: `already assigned to ${attempt.rep_id}; ${left} minute(s) left before an untouched lead is reassigned`,
      });
      continue;
    }
    say(lead.key, lead.lead_id, await expire(lead.key));
  }

  // The window has passed. Read HubSpot, and only an observed "untouched" moves the lead.
  async function expire(key) {
    const lead = state().leads.get(key);
    const attempt = latest(lead);
    let seen;
    try {
      seen = await hubspot.read({ email: lead.brief.to });
    } catch (error) {
      return {
        status: 'CLOCK_CHECK_FAILED',
        code: error?.code ?? 'HUBSPOT_UNAVAILABLE',
        rep: attempt.rep_id,
        detail: `could not read the contact to see whether ${attempt.rep_id} touched it (${scrubbed(scrub, error)}). Nothing was reassigned on a guess; the next run checks again`,
      };
    }

    const written = attempt.crm.owner_id;
    if (seen === null || seen.ownerId !== written) {
      const detail = seen === null
        ? 'the contact is no longer in HubSpot, so a person removed it; the clock stopped'
        : `the owner in HubSpot is now ${seen.ownerId}, not ${written} as written for ${attempt.rep_id}; a person reassigned it, so the clock stopped and nothing was changed`;
      write({ type: 'owner_changed', key, attempt: attempt.attempt, owner_seen: seen?.ownerId ?? null, detail });
      return { status: 'OWNER_CHANGED', rep: attempt.rep_id, detail };
    }

    if (seen.lastActivityAt && Date.parse(seen.lastActivityAt) >= Date.parse(attempt.crm.at)) {
      const detail = `${attempt.rep_id} logged activity at ${seen.lastActivityAt}, after the owner was written at ${attempt.crm.at}; the clock stopped`;
      write({ type: 'touched', key, attempt: attempt.attempt, activity_at: seen.lastActivityAt, detail });
      return { status: 'TOUCHED', rep: attempt.rep_id, detail };
    }

    const tried = lead.attempts.filter((a) => a.released === null).map((a) => a.rep_id);
    const known = state();
    const pick = pickRep({ rotation, pool: lead.pool, last: known.pointers[lead.pool], open: openCounts(known), exclude: tried });
    if (pick.rep === undefined) {
      // A pool that is missing or empty is not "every rep had it" ([].every is true): it waits, under
      // its own code, journals nothing, and the lead resumes the moment the pool is back.
      const pool = rotation.pools[lead.pool] ?? [];
      if (pool.length > 0 && pool.every((rep) => tried.includes(rep.id))) {
        const detail = `untouched by every rep in "${lead.pool}" (${tried.join(', ')}); it stays with ${attempt.rep_id} and needs a person to decide`;
        write({ type: 'exhausted', key, attempt: attempt.attempt, detail });
        return { status: 'NO_REP_RESPONDED', rep: attempt.rep_id, detail };
      }
      return {
        status: 'REASSIGN_WAITING',
        code: pick.code,
        rep: attempt.rep_id,
        detail: `untouched past the window, and nobody can take it yet: ${pick.detail}. It stays with ${attempt.rep_id}; the next run tries again`,
      };
    }

    claim(lead, pick, attempt.attempt + 1, { from: attempt.rep_id, minutes: rotation.response_minutes });
    return complete(key);
  }

  return { at, outcomes: [...outcomes.values()], repaired: journal.repaired ?? null };
}
