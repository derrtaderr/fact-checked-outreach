// The rotation. docs/INBOUND-SPEC.md, "The rotation".
//
// Pure: no file, no clock, no network. The CLI reads the file and the journal holds the pointer;
// this decides who is next.
//
// THE POINTER IS AN ID, NEVER AN INDEX. An index survives a crash just as well, and then silently
// means a different rep the moment someone reorders or removes a line in the rotation file. The id
// of the last rep assigned keeps meaning the same person, and when that person is gone the run says
// so instead of guessing.

export class RotationConfigError extends Error {
  constructor(problem) {
    super(
      `the rotation file is not usable: ${problem}. Nothing was read from the run, no CRM or Slack ` +
        'call was made and nothing was written.',
    );
    this.name = 'RotationConfigError';
    this.code = 'ROTATION_CONFIG_INVALID';
  }
}

const isText = (value) => typeof value === 'string' && value.trim() !== '';

/** Validates a parsed rotation file. Returns a frozen copy, or throws RotationConfigError. */
export function parseRotationConfig(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RotationConfigError('it is not a JSON object');
  }
  const minutes = input.response_minutes;
  if (!Number.isSafeInteger(minutes) || minutes < 1) {
    throw new RotationConfigError(`response_minutes is ${JSON.stringify(minutes ?? null)}, and it must be a whole number of 1 or more`);
  }
  // overwrite_owner: opt in to replacing a HubSpot owner this tool did not write. Off by default, so a
  // lead a person already gave to someone is left alone (ALREADY_OWNED).
  const overwrite = input.overwrite_owner;
  if (overwrite !== undefined && typeof overwrite !== 'boolean') {
    throw new RotationConfigError(`overwrite_owner is ${JSON.stringify(overwrite)}; it is true or false, or left out`);
  }
  const pools = input.pools;
  if (pools === null || typeof pools !== 'object' || Array.isArray(pools)) {
    throw new RotationConfigError('pools is missing or is not an object of pool name to a list of reps');
  }

  const seen = new Set();
  const parsed = {};
  for (const [pool, reps] of Object.entries(pools)) {
    if (!Array.isArray(reps)) throw new RotationConfigError(`pool "${pool}" must be a list of reps`);
    parsed[pool] = reps.map((rep, index) => {
      const where = `pool "${pool}" rep ${index + 1}`;
      if (rep === null || typeof rep !== 'object') throw new RotationConfigError(`${where} is not an object`);
      if (!isText(rep.id)) throw new RotationConfigError(`${where} has no id`);
      if (seen.has(rep.id)) throw new RotationConfigError(`duplicate rep id "${rep.id}"; an id names one person in every pool`);
      seen.add(rep.id);
      if (!isText(rep.hubspot_owner_id)) throw new RotationConfigError(`${where} (${rep.id}) has no hubspot_owner_id string`);
      if (!isText(rep.slack_user_id)) throw new RotationConfigError(`${where} (${rep.id}) has no slack_user_id string`);
      if (rep.away !== undefined && typeof rep.away !== 'boolean') {
        throw new RotationConfigError(`${where} (${rep.id}) has away ${JSON.stringify(rep.away)}; it is true or false`);
      }
      if (rep.capacity !== undefined && (!Number.isSafeInteger(rep.capacity) || rep.capacity < 1)) {
        throw new RotationConfigError(`${where} (${rep.id}) has capacity ${JSON.stringify(rep.capacity)}; it is a whole number of 1 or more, or left out`);
      }
      return Object.freeze({
        id: rep.id,
        hubspot_owner_id: rep.hubspot_owner_id,
        slack_user_id: rep.slack_user_id,
        away: rep.away === true,
        ...(rep.capacity === undefined ? {} : { capacity: rep.capacity }),
      });
    });
  }
  return Object.freeze({ response_minutes: minutes, overwrite_owner: overwrite === true, pools: Object.freeze(parsed) });
}

function skipReason(rep, open) {
  if (rep.away) return 'away';
  const held = open[rep.id] ?? 0;
  if (rep.capacity !== undefined && held >= rep.capacity) return `at capacity (${held} of ${rep.capacity} open)`;
  return null;
}

/**
 * Who is next in a pool.
 *
 *   last     the id of the last rep assigned in this pool, from the journal, or undefined
 *   open     rep id -> open assignments they hold, for capacity
 *   exclude  rep ids that already had this lead, so a reassignment never returns to them
 *
 * Returns { rep, pointer, skipped, note } or { code, detail } with no rep. A refusal does not move
 * the pointer, because nobody had a turn.
 */
export function pickRep({ rotation, pool, last, open = {}, exclude = [] }) {
  const reps = rotation.pools[pool];
  if (reps === undefined) {
    return {
      code: 'NO_ROTATION_FOR_POOL',
      detail: `the rotation file has no pool named "${pool}", which is the band owner this lead was routed to`,
    };
  }
  if (reps.length === 0) {
    return { code: 'ROTATION_EMPTY', detail: `the "${pool}" rotation has no reps, so nobody can be assigned` };
  }

  let start = 0;
  let note;
  if (last !== undefined) {
    const at = reps.findIndex((rep) => rep.id === last);
    if (at === -1) {
      note = `the last rep assigned in this pool, ${last}, is no longer in the ${pool} rotation, so the turn restarts at the top`;
    } else {
      start = (at + 1) % reps.length;
    }
  }

  const skipped = [];
  for (let step = 0; step < reps.length; step += 1) {
    const rep = reps[(start + step) % reps.length];
    if (exclude.includes(rep.id)) {
      skipped.push({ id: rep.id, reason: 'already had this lead' });
      continue;
    }
    const reason = skipReason(rep, open);
    if (reason !== null) {
      skipped.push({ id: rep.id, reason });
      continue;
    }
    return {
      rep,
      pointer: rep.id,
      skipped: skipped.filter((skip) => skip.reason !== 'already had this lead'),
      ...(note === undefined ? {} : { note }),
    };
  }

  return {
    code: 'NO_ELIGIBLE_REP',
    detail: `every rep in "${pool}" was skipped: ${skipped.map((skip) => `${skip.id}: ${skip.reason}`).join('; ')}`,
  };
}
