// The live HubSpot adapter. docs/INBOUND-SPEC.md, "Adapters".
//
// Three endpoints of the CRM v3 contacts API, by email, never by search: the search API has its own
// stricter rate limits and is eventually consistent, so a contact created a second ago may not be found
// and a re-run would create a duplicate. Update by email (`idProperty=email`) either finds the contact
// or 404s, immediately.
//
//   assign  PATCH /crm/v3/objects/contacts/{email}?idProperty=email   owner only
//           on 404, POST /crm/v3/objects/contacts                       email, owner, given properties
//           on 409 (it appeared meanwhile), PATCH again
//   read    GET   /crm/v3/objects/contacts/{email}?idProperty=email&properties=hubspot_owner_id,notes_last_updated
//
// `transport` is REQUIRED with no default, as in src/live/http.mjs: only src/cli.mjs builds a real one.
// The token lives in this closure. It is never returned, never put in an error (every upstream text
// passes through `scrub`), and never seen by the engine or the journal.
//
// No retries in here. The engine's next tick is the retry, and the journal says exactly where it
// resumes, so a retry loop here would only hide how often HubSpot is failing.

import { InboundAdapterError } from './errors.mjs';

export const HUBSPOT_BASE = 'https://api.hubapi.com';
export const HUBSPOT_TIMEOUT_MS = 10000;
const MAX_DETAIL = 300;

export const hubspotPaths = {
  update: (email) => `/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email`,
  create: () => '/crm/v3/objects/contacts',
  read: (email) => `/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email&properties=hubspot_owner_id,notes_last_updated`,
};

function short(text) {
  const compact = String(text).replace(/\s+/g, ' ').trim();
  return compact.length <= MAX_DETAIL ? compact : `${compact.slice(0, MAX_DETAIL - 1)}…`;
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createHubSpotAdapter({ transport, token, scrub = (text) => text, timeoutMs = HUBSPOT_TIMEOUT_MS } = {}) {
  if (typeof transport !== 'function') {
    throw new TypeError('createHubSpotAdapter requires a transport. There is deliberately no default, so nothing reaches HubSpot by omission');
  }
  if (typeof token !== 'string' || token.trim() === '') {
    throw new TypeError('createHubSpotAdapter requires a token');
  }

  // Every await after the request left sits inside the try, so a body that cannot be read is a named,
  // ambiguous failure (the write may have landed), never a raw error.
  async function call(method, path, body) {
    let response;
    let text;
    try {
      response = await transport(`${HUBSPOT_BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      const stage = response === undefined ? 'could not be reached' : `answered ${response.status} but the answer could not be read`;
      throw new InboundAdapterError('HUBSPOT_UNAVAILABLE', `HubSpot ${stage}: ${short(scrub(String(error?.message ?? error)))}`, { ambiguous: true });
    }
    return { status: response.status, text, json: parse(text) };
  }

  function failure(answer, action) {
    const message = short(scrub(answer.json?.message ?? answer.text));
    const says = `HubSpot answered ${answer.status} to ${action}: ${message}`;
    if (answer.status === 401) return new InboundAdapterError('HUBSPOT_UNAUTHORIZED', `${says}. The token was refused; check SIGNAL_DESK_HUBSPOT_TOKEN`);
    if (answer.status === 403) {
      const scopes = (answer.json?.errors ?? []).flatMap((e) => e?.context?.requiredGranularScopes ?? []);
      const named = scopes.length > 0 ? ` Missing scope: ${scopes.map((s) => short(scrub(String(s)))).join(', ')}.` : '';
      return new InboundAdapterError('HUBSPOT_SCOPE_MISSING', `${says}.${named} Add it to the private app and run again`);
    }
    if (answer.status === 400 && (answer.json?.errors ?? []).some((e) => e?.code === 'INVALID_OWNER_ID')) {
      return new InboundAdapterError('HUBSPOT_INVALID_OWNER', `${says}. The rotation file names an owner id this portal does not have`);
    }
    if (answer.status === 429) return new InboundAdapterError('HUBSPOT_RATE_LIMITED', says);
    if (answer.status >= 500) return new InboundAdapterError('HUBSPOT_UNAVAILABLE', says, { ambiguous: true });
    return new InboundAdapterError('HUBSPOT_REJECTED', says);
  }

  const update = (email, ownerId) => call('PATCH', hubspotPaths.update(email), { properties: { hubspot_owner_id: ownerId } });

  return {
    async assign({ email, ownerId, properties = {} }) {
      let answer = await update(email, ownerId);
      if (answer.status === 200) return { contactId: String(answer.json?.id), created: false };
      if (answer.status !== 404) throw failure(answer, 'the owner update');

      answer = await call('POST', hubspotPaths.create(), { properties: { email, hubspot_owner_id: ownerId, ...properties } });
      if (answer.status === 201 || answer.status === 200) return { contactId: String(answer.json?.id), created: true };
      if (answer.status !== 409) throw failure(answer, 'the contact create');

      answer = await update(email, ownerId);
      if (answer.status === 200) return { contactId: String(answer.json?.id), created: false };
      throw failure(answer, 'the owner update after a conflict');
    },

    async read({ email }) {
      const answer = await call('GET', hubspotPaths.read(email));
      if (answer.status === 404) return null;
      if (answer.status !== 200) throw failure(answer, 'the contact read');
      const properties = answer.json?.properties ?? {};
      return {
        contactId: String(answer.json?.id),
        ownerId: properties.hubspot_owner_id ?? null,
        lastActivityAt: properties.notes_last_updated ?? null,
      };
    },
  };
}
