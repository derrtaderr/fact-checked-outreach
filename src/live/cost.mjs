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
import { DEFAULT_RETRIES as FETCH_RETRIES } from './http.mjs';

export const MODEL_CALLS_PER_LEAD = 2;

const FETCH_ATTEMPTS = 1 + FETCH_RETRIES;
const MODEL_ATTEMPTS = 1 + MODEL_RETRIES;

export const COST_FORMULA =
  `per lead, expected: U fetches + ${MODEL_CALLS_PER_LEAD} model calls; worst case, every retry: ` +
  `U × ${FETCH_ATTEMPTS} fetches + ${MODEL_CALLS_PER_LEAD} × ${MODEL_ATTEMPTS} = ` +
  `${MODEL_CALLS_PER_LEAD * MODEL_ATTEMPTS} model attempts, each asking for at most ` +
  `${DEFAULT_MAX_TOKENS.toLocaleString('en-US')} output tokens. U is the https evidence URLs a payload cites, plus ` +
  'one if it names an https identity source. The price per request is your provider\'s.';

// Only an https string can become a request: the live fetcher refuses anything else before it
// sends (SOURCE_INSECURE), so a non-string or plaintext source bills nothing (fix wave 2, N-D).
export function isFetchableUrl(value) {
  return typeof value === 'string' && /^https:\/\//i.test(value);
}

/** The evidence URLs one parsed payload will make a live run fetch. */
export function evidenceUrls(signal) {
  const payload = signal?.payload ?? {};
  const sources = Array.isArray(payload.sources) ? payload.sources.filter(isFetchableUrl).length : 0;
  const identity = isFetchableUrl(payload.identity_source) ? 1 : 0;
  return sources + identity;
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
