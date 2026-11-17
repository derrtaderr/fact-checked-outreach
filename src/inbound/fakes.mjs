// The fake HubSpot and fake Slack. docs/INBOUND-SPEC.md, "Adapters".
//
// Fixture mode and every engine test run on these. They follow what the live developer portal did on
// 2026-11-16: contacts keyed by email (case-insensitive), created on a miss, updated after; an owner
// id the portal does not have is refused; the Last activity date moves when activity is logged. A
// fake kinder than the real service would make the tests above it prove nothing.
//
// No clock and no randomness: ids and Slack timestamps are counters, so a fixture run is repeatable.

import { InboundAdapterError } from './errors.mjs';

const keyOf = (email) => String(email).trim().toLowerCase();

export function fakeHubSpot({ owners = [], snapshot } = {}) {
  const contacts = new Map((snapshot?.contacts ?? []).map((contact) => [keyOf(contact.email), { ...contact }]));
  let nextId = snapshot?.nextId ?? 501;
  let failure = null;

  const failIfScripted = () => {
    if (failure === null) return;
    const code = failure;
    failure = null;
    throw new InboundAdapterError(code, `fake HubSpot scripted to fail with ${code}`);
  };

  return {
    async assign({ email, ownerId, properties = {} }) {
      failIfScripted();
      if (!owners.includes(ownerId)) {
        throw new InboundAdapterError('HUBSPOT_INVALID_OWNER', `${ownerId} was not a valid owner ID`);
      }
      const existing = contacts.get(keyOf(email));
      if (existing !== undefined) {
        existing.ownerId = ownerId;
        return { contactId: existing.contactId, created: false };
      }
      const contact = { contactId: String(nextId), email: keyOf(email), ownerId, properties: { ...properties }, lastActivityAt: null };
      nextId += 1;
      contacts.set(keyOf(email), contact);
      return { contactId: contact.contactId, created: true };
    },

    async read({ email }) {
      failIfScripted();
      const contact = contacts.get(keyOf(email));
      if (contact === undefined) return null;
      return { contactId: contact.contactId, ownerId: contact.ownerId, lastActivityAt: contact.lastActivityAt };
    },

    // What a rep or an admin does in HubSpot, for tests and for the fixture demo.
    logActivity(email, at) {
      contacts.get(keyOf(email)).lastActivityAt = at;
    },
    setOwner(email, ownerId) {
      contacts.get(keyOf(email)).ownerId = ownerId;
    },
    failNext(code) {
      failure = code;
    },
    contacts: () => [...contacts.values()].map((contact) => ({ ...contact })),
    snapshot: () => ({ nextId, contacts: [...contacts.values()].map((contact) => ({ ...contact })) }),
  };
}

export function fakeSlack({ searchable = true, snapshot } = {}) {
  const posts = [...(snapshot?.posts ?? [])];
  let scripted = null;

  return {
    async post({ channel, text, blocks, marker }) {
      const next = scripted;
      scripted = null;
      if (next?.kind === 'reject') {
        throw new InboundAdapterError('SLACK_REJECTED', `Slack answered ok: false, ${next.error}`);
      }
      const ts = `${1000 + posts.length}.000100`;
      posts.push({ channel, text, blocks, marker, ts });
      if (next?.kind === 'ambiguous') {
        throw new InboundAdapterError('SLACK_UNREACHABLE', 'the connection dropped after the request was sent', { ambiguous: true });
      }
      return { ts };
    },

    async find({ channel, marker }) {
      if (!searchable) {
        throw new InboundAdapterError('SLACK_UNSEARCHABLE', 'this Slack connection cannot read message history, so it cannot tell whether the post landed');
      }
      const found = posts.find((post) => post.channel === channel && post.marker === marker);
      return found === undefined ? null : { ts: found.ts };
    },

    ambiguousNext() {
      scripted = { kind: 'ambiguous' };
    },
    rejectNext(error) {
      scripted = { kind: 'reject', error };
    },
    posts: () => posts.map((post) => ({ ...post })),
    snapshot: () => ({ posts: posts.map((post) => ({ ...post })) }),
  };
}
