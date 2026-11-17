// `inbound --live --plan`. docs/INBOUND-SPEC.md, "Live mode and --plan".
//
// THE PLAN IS THE TICK. It runs the engine's own `tick` on an in-memory copy of the journal, with
// adapters that call nothing and record what they were asked. So the order (interrupted attempts,
// then new leads, then clocks), capacity, the rotation pointer and every refusal are the tick's own,
// and cannot drift from it as a hand-written walk of the journal did.
//
// What the planning adapters answer, which is what makes the list an UPPER BOUND:
//   assign  succeeds, with the contacts the journal says this tool owns, so nothing is ALREADY_OWNED
//   read    the owner this tool wrote and no activity: every lead past its window is untouched,
//           so it is reassigned, which is the answer that leads to the most calls
//   post    succeeds
//   find    the earlier post is not found, so it is posted again
// Any other answer from HubSpot or Slack (a touched lead, an owner a person set, a post that is
// found, a failure) leads to fewer calls for THAT lead. But it can free a rep: a lead found touched,
// or one a person owns, no longer counts against its rep's capacity, so a later lead the plan saw
// refused NO_ELIGIBLE_REP may be assigned after all. Those are listed separately as `possible`, an
// assign and a post each, so calls + possible is never shorter than what the tick does; and when
// every answer is as assumed, `calls` is exactly the tick (test/inbound-plan-parity.test.mjs).

import { tick, fold } from './engine.mjs';
import { fakeHubSpot, fakeSlack } from './fakes.mjs';

/** The most HTTP requests each adapter operation can make (src/inbound/hubspot.mjs, slack.mjs). */
export const HTTP_CALLS = Object.freeze({ assign: 4, read: 1, post: 1, find: 2 });

/**
 * Runs one tick against recording adapters. `journal` is opened read-only by the caller; nothing is
 * written anywhere. Returns { calls, outcomes, at } where every call carries the key of the lead it
 * was made for.
 */
export async function planCalls({ events, rotation, journal, at, uncertain = false }) {
  const state = fold(journal.entries());
  const contacts = [];
  for (const lead of state.leads.values()) {
    const written = [...lead.attempts].reverse().find((a) => a.crm !== null);
    if (written !== undefined) {
      contacts.push({ contactId: written.crm.contact_id, email: String(lead.brief.to).trim().toLowerCase(), ownerId: written.crm.owner_id, properties: {}, lastActivityAt: null });
    }
  }
  const owners = Object.values(rotation.pools).flat().map((rep) => rep.hubspot_owner_id);
  const hubspot = fakeHubSpot({ owners, snapshot: { nextId: 1, contacts } });
  const slack = fakeSlack();

  const calls = [];
  let pending = [];
  const record = (op) => pending.push(op);
  const planning = {
    hubspot: {
      assign: (args) => { record({ op: 'assign', email: args.email, ownerId: args.ownerId }); return hubspot.assign(args); },
      read: (args) => { record({ op: 'read', email: args.email }); return hubspot.read(args); },
    },
    slack: {
      post: (message) => { record({ op: 'post', channel: message.channel }); return slack.post(message); },
      find: (query) => { record({ op: 'find', channel: query.channel }); return slack.find(query); },
    },
  };

  const report = await tick({
    events,
    rotation,
    journal: journal.scratch(),
    ...planning,
    now: () => at,
    uncertain,
    onOutcome: (outcome) => {
      for (const op of pending) calls.push({ ...op, key: outcome.key });
      pending = [];
    },
  });
  // Leads refused only for want of an eligible rep may be assigned if an earlier answer frees one.
  const emailOf = new Map(events.map(({ key, lead }) => [key, lead?.to]));
  for (const lead of state.leads.values()) emailOf.set(lead.key, lead.brief.to);
  const possible = report.outcomes
    .filter((o) => o.code === 'NO_ELIGIBLE_REP')
    .flatMap((o) => [{ op: 'assign', key: o.key, email: emailOf.get(o.key), ownerId: null }, { op: 'post', key: o.key, channel: null }]);

  return { calls, possible, outcomes: report.outcomes, at: report.at };
}
