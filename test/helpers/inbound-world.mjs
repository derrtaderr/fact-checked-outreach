// Shared world for the inbound engine tests: fakes, a journal on disk, a scripted instant.
// Not a test file, so the runner does not execute it on its own.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tick } from '../../src/inbound/engine.mjs';
import { Journal } from '../../src/inbound/journal.mjs';
import { parseRotationConfig } from '../../src/inbound/rotation.mjs';
import { fakeHubSpot, fakeSlack } from '../../src/inbound/fakes.mjs';

export const T0 = '2026-03-01T09:00:00.000Z';
export const minutesAfter = (minutes, from = T0) => new Date(Date.parse(from) + minutes * 60000).toISOString();

export function rotationOf(pools = { 'ae-round-robin': ['ana', 'ben', 'cy'] }, response_minutes = 30) {
  return parseRotationConfig({
    response_minutes,
    pools: Object.fromEntries(
      Object.entries(pools).map(([pool, reps]) => [
        pool,
        reps.map((rep) => (typeof rep === 'string' ? { id: rep, hubspot_owner_id: `o-${rep}`, slack_user_id: `U-${rep}` } : rep)),
      ]),
    ),
  });
}

export function eventOf(n, overrides = {}) {
  return {
    key: `sig-${n}`,
    lead: {
      lead_id: `lead-${n}`,
      pool: 'ae-round-robin',
      company: `Company ${n}`,
      to: `contact${n}@co${n}.example.com`,
      subject: `Subject ${n}`,
      body: `Body ${n}`,
      band: 'priority',
      play: 'executive-intro',
      score: 86,
      citations: [`https://directory.example.com/${n}`],
      approved_by: 'cli-operator',
      ...overrides,
    },
  };
}

export function world({ rotation = rotationOf(), owners = ['o-ana', 'o-ben', 'o-cy', 'o-dee'], searchable = true } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'signal-desk-inbound-')), 'journal.jsonl');
  return { path, rotation, hubspot: fakeHubSpot({ owners }), slack: fakeSlack({ searchable }) };
}

export function run(w, events, at = T0, journalOptions) {
  return tick({
    events,
    rotation: w.rotation,
    journal: Journal.open(w.path, journalOptions),
    hubspot: w.hubspot,
    slack: w.slack,
    now: () => at,
  });
}
