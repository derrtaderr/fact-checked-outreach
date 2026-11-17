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

// --- the fold -------------------------------------------------------------------------------------

/** State from journal entries. Pure; called afresh whenever the engine needs the current picture. */
export function fold(entries) {
  const pointers = {};
  const leads = new Map();

  for (const entry of entries) {
    if (entry.type === 'claim') {
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
        slack_failure: null,
      });
      continue;
    }
    const lead = leads.get(entry.key);
    if (lead === undefined) continue;
    const attempt = lead.attempts.find((a) => a.attempt === entry.attempt);
    switch (entry.type) {
      case 'crm_written':
        attempt.crm = { at: entry.at, contact_id: entry.contact_id };
        attempt.crm_failure = null;
        break;
      case 'crm_failed':
        attempt.crm_failure = { code: entry.code, detail: entry.detail };
        break;
      case 'slack_attempt':
        attempt.slack_open = true;
        attempt.slack_attempt_at = entry.at;
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
    if (lead.stopped !== null) continue;
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
export async function tick({ events, rotation, journal, hubspot, slack, now, scrub = (text) => text }) {
  const at = now();
  const state = () => fold(journal.entries());
  const outcomes = new Map();
  const say = (key, lead_id, outcome) => outcomes.set(key, { key, lead_id, ...outcome });

  // Appends an intent or result line for one lead's attempt.
  const write = (record) => journal.append({ ...record, at: now() });

  // Finishes the latest attempt of a lead in the journal: HubSpot first, then Slack.
  async function complete(key) {
    const lead = state().leads.get(key);
    const attempt = latest(lead);
    const rep = { id: attempt.rep_id, slack_user_id: attempt.slack_user_id };
    const label = attempt.attempt === 0 ? 'ASSIGNED' : 'REASSIGNED';

    if (attempt.crm === null) {
      // The journal write sits OUTSIDE the try. A crash while recording the result is a crash, not a
      // HubSpot failure; caught here it would be journaled as crm_failed, which is a false record.
      let written;
      try {
        written = await hubspot.assign({
          email: lead.brief.to,
          ownerId: attempt.owner_id,
          properties: { company: lead.brief.company },
        });
      } catch (error) {
        const code = error?.code ?? 'HUBSPOT_UNAVAILABLE';
        const detail = scrubbed(scrub, error);
        write({ type: 'crm_failed', key, attempt: attempt.attempt, code, detail });
        return {
          status: 'CRM_PENDING',
          code,
          rep: rep.id,
          detail: `HubSpot did not take the owner (${detail}). ${rep.id} keeps this turn; the next run writes the owner again and only then tells them`,
        };
      }
      write({ type: 'crm_written', key, attempt: attempt.attempt, contact_id: written.contactId, owner_id: attempt.owner_id });
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

    // A post that may exist: ask Slack before posting again.
    if (current.slack_open) {
      let found;
      try {
        found = await slack.find({ channel: message.channel, marker: message.marker, oldest: current.slack_attempt_at });
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

    write({ type: 'slack_attempt', key, attempt: attempt.attempt, marker: message.marker });
    // As above: a crash while recording a post that landed must stay a crash. Caught here, it would be
    // journaled as slack_failed and the next run would post a second time.
    let posted;
    try {
      posted = await slack.post(message);
    } catch (error) {
      const code = error?.code ?? 'SLACK_UNREACHABLE';
      if (error?.ambiguous) {
        return {
          status: 'SLACK_UNCONFIRMED',
          code,
          rep: rep.id,
          detail: `the post to ${rep.id} may have landed (${scrubbed(scrub, error)}). The next run asks Slack before posting again`,
        };
      }
      write({ type: 'slack_failed', key, attempt: attempt.attempt, code, detail: scrubbed(scrub, error) });
      return {
        status: 'SLACK_PENDING',
        code,
        rep: rep.id,
        detail: `the owner is written; Slack refused the post (${scrubbed(scrub, error)}). The next run posts it`,
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
    if (lead.stopped === null && (attempt.crm === null || attempt.slack === null)) {
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

    if (seen === null || seen.ownerId !== attempt.owner_id) {
      const detail = seen === null
        ? 'the contact is no longer in HubSpot, so a person removed it; the clock stopped'
        : `the owner in HubSpot is now ${seen.ownerId}, not ${attempt.owner_id} as written for ${attempt.rep_id}; a person reassigned it, so the clock stopped and nothing was changed`;
      write({ type: 'owner_changed', key, attempt: attempt.attempt, owner_seen: seen?.ownerId ?? null, detail });
      return { status: 'OWNER_CHANGED', rep: attempt.rep_id, detail };
    }

    if (seen.lastActivityAt && Date.parse(seen.lastActivityAt) >= Date.parse(attempt.crm.at)) {
      const detail = `${attempt.rep_id} logged activity at ${seen.lastActivityAt}, after the owner was written at ${attempt.crm.at}; the clock stopped`;
      write({ type: 'touched', key, attempt: attempt.attempt, activity_at: seen.lastActivityAt, detail });
      return { status: 'TOUCHED', rep: attempt.rep_id, detail };
    }

    const tried = lead.attempts.map((a) => a.rep_id);
    const known = state();
    const pick = pickRep({ rotation, pool: lead.pool, last: known.pointers[lead.pool], open: openCounts(known), exclude: tried });
    if (pick.rep === undefined) {
      const pool = rotation.pools[lead.pool] ?? [];
      if (pool.every((rep) => tried.includes(rep.id))) {
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
