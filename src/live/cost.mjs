// What a live lead can cost, counted in requests. docs/CEILING-FINDINGS-SPEC.md, finding 4.
//
// Derived from the transports' own constants, so the count cannot drift from the code that makes the
// requests. It is deliberately NOT a price. No price is in this repo, provider prices change, and
// whether a failed or timed-out attempt is billed is the provider's rule rather than this code's. The
// reader multiplies these counts by their own price.
//
// Per lead:
//   U fetches        one per evidence URL the payload cites, plus one if it names an identity source
//   2 model calls    one to draft, one to judge
// and every one of those is retried up to DEFAULT_RETRIES times by its transport on a timeout, a
// network error, a 429 or a 5xx. "Expected" is the count with nothing retried; "worst" is with
// every request retried to its limit. A lead refused before a stage makes fewer requests, so both
// numbers are upper bounds for that lead.

import { DEFAULT_RETRIES as MODEL_RETRIES, DEFAULT_MAX_TOKENS } from './anthropic.mjs';
import { DEFAULT_RETRIES as FETCH_RETRIES, isFetchableUrl } from './http.mjs';
import { liveConfig } from './config.mjs';
import { leadFromPayload } from '../stages/ingest.mjs';
import { expand, fetchTemplates } from '../stages/enrich.mjs';

export { isFetchableUrl };

export const MODEL_CALLS_PER_LEAD = 2;

const FETCH_ATTEMPTS = 1 + FETCH_RETRIES;
const MODEL_ATTEMPTS = 1 + MODEL_RETRIES;

export const COST_FORMULA =
  `per lead, expected: U fetches + ${MODEL_CALLS_PER_LEAD} model calls; worst case, every retry: ` +
  `U × ${FETCH_ATTEMPTS} fetches + ${MODEL_CALLS_PER_LEAD} × ${MODEL_ATTEMPTS} = ` +
  `${MODEL_CALLS_PER_LEAD * MODEL_ATTEMPTS} model attempts, each asking for at most ` +
  `${DEFAULT_MAX_TOKENS.toLocaleString('en-US')} output tokens. U is the evidence URLs a payload cites that are https once {domain} and {email} ` +
  'are expanded, plus one if it names an identity source that is. The price per request is your provider\'s.';

// The enrich config a live run uses. Only its enrich block is read, so the secret and start are inert.
const LIVE = liveConfig({ secret: '', startedAt: '1970-01-01T00:00:00.000Z' });

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Every request enrich will consider for one parsed payload, in the order it makes them: the
 * identity source, then each claim source. Derived by the run's own code (review pass 3, X1): the
 * lead ingest builds, the templates enrich picks, enrich's expand(), and the live fetcher's
 * isFetchableUrl(). `url` is null for a source that is not a string, which enrich cannot expand.
 *
 * A payload with no usable domain or email is refused at ingest and fetches nothing. Its templates
 * are left unexpanded and counted only if they are https as written, which is still an upper bound.
 */
export function plannedFetches(signal) {
  const payload = signal?.payload !== null && typeof signal?.payload === 'object' ? signal.payload : {};
  const expandable = isNonEmptyString(payload.company?.domain) && isNonEmptyString(payload.contact?.email);
  const { lead } = leadFromPayload(
    expandable ? payload : { ...payload, company: { domain: '{domain}' }, contact: { email: '{email}' } },
  );
  const { identity, sources } = fetchTemplates(lead, LIVE);
  const one = (kind, template) => {
    if (typeof template !== 'string') return { kind, template, url: null, fetchable: false };
    const url = expand(template, lead);
    return { kind, template, url, fetchable: isFetchableUrl(url) };
  };
  return [...(identity === null ? [] : [one('identity', identity)]), ...sources.map((s) => one('source', s))];
}

/** The evidence URLs one parsed payload will make a live run fetch. */
export function evidenceUrls(signal) {
  return plannedFetches(signal).filter((planned) => planned.fetchable).length;
}

export function leadRequests(signal) {
  const urls = evidenceUrls(signal);
  return {
    urls,
    fetches: { expected: urls, worst: urls * FETCH_ATTEMPTS },
    modelCalls: { expected: MODEL_CALLS_PER_LEAD, worst: MODEL_CALLS_PER_LEAD * MODEL_ATTEMPTS },
  };
}

export function runRequests(signals) {
  const total = {
    leads: 0,
    fetches: { expected: 0, worst: 0 },
    modelCalls: { expected: 0, worst: 0 },
    maxOutputTokensPerAttempt: DEFAULT_MAX_TOKENS,
  };
  for (const signal of signals) {
    const lead = leadRequests(signal);
    total.leads += 1;
    total.fetches.expected += lead.fetches.expected;
    total.fetches.worst += lead.fetches.worst;
    total.modelCalls.expected += lead.modelCalls.expected;
    total.modelCalls.worst += lead.modelCalls.worst;
  }
  return total;
}
