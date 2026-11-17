// A lead whose pool was removed or emptied is not "every rep had it". docs/INBOUND-SPEC.md, "The clock".
//
// Review pass 1, I4: `[].every(...)` is true, so a lead whose pool vanished from the rotation file was
// journaled `exhausted` and parked as NO_REP_RESPONDED with a false reason, and never revived when
// the pool came back.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Journal } from '../src/inbound/journal.mjs';
import { eventOf, rotationOf, world, run, minutesAfter } from './helpers/inbound-world.mjs';

for (const [label, pools, code] of [
  ['removed', { other: ['zed'] }, 'NO_ROTATION_FOR_POOL'],
  ['emptied', { 'ae-round-robin': [] }, 'ROTATION_EMPTY'],
]) {
  test(`I4: a pool ${label} from the rotation is its own refusal, nothing is journaled, and the lead resumes when it returns`, async () => {
    const w = world();
    await run(w, [eventOf(1)]);
    const lines = Journal.open(w.path).entries().length;

    const original = w.rotation;
    w.rotation = rotationOf(pools);
    const waiting = await run(w, [], minutesAfter(31));
    assert.equal(waiting.outcomes.length, 1);
    assert.notEqual(waiting.outcomes[0].status, 'NO_REP_RESPONDED');
    assert.equal(waiting.outcomes[0].code, code);
    assert.equal(waiting.outcomes[0].rep, 'ana');
    assert.equal(Journal.open(w.path).entries().length, lines, 'nothing was journaled');

    w.rotation = original;
    const back = await run(w, [], minutesAfter(62));
    assert.equal(back.outcomes[0].status, 'REASSIGNED');
    assert.equal(back.outcomes[0].rep, 'ben');
  });
}
