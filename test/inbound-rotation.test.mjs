// The rotation. docs/INBOUND-SPEC.md, "The rotation".
//
// The pointer is the id of the last rep assigned in a pool, never an index, so editing the file
// cannot silently shift every later turn. Skips pass a rep over without assigning; refusals assign
// nobody and say why.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRotationConfig, pickRep, RotationConfigError } from '../src/inbound/rotation.mjs';

const rep = (id, extra = {}) => ({ id, hubspot_owner_id: `o-${id}`, slack_user_id: `U-${id}`, ...extra });

function config(pools, response_minutes = 30) {
  return parseRotationConfig({ response_minutes, pools });
}

test('the first lead in a pool goes to the first rep, and the pointer names that rep', () => {
  const rotation = config({ ae: [rep('ana'), rep('ben'), rep('cy')] });
  const picked = pickRep({ rotation, pool: 'ae', last: undefined, open: {} });
  assert.equal(picked.rep.id, 'ana');
  assert.equal(picked.pointer, 'ana');
});

test('the next lead goes to the rep after the last one assigned, wrapping at the end', () => {
  const rotation = config({ ae: [rep('ana'), rep('ben'), rep('cy')] });
  assert.equal(pickRep({ rotation, pool: 'ae', last: 'ana', open: {} }).rep.id, 'ben');
  assert.equal(pickRep({ rotation, pool: 'ae', last: 'cy', open: {} }).rep.id, 'ana');
});

test('a rep marked away is skipped and the skip is named', () => {
  const rotation = config({ ae: [rep('ana'), rep('ben', { away: true }), rep('cy')] });
  const picked = pickRep({ rotation, pool: 'ae', last: 'ana', open: {} });
  assert.equal(picked.rep.id, 'cy');
  assert.deepEqual(picked.skipped, [{ id: 'ben', reason: 'away' }]);
});

test('a rep at capacity is skipped; below capacity is not', () => {
  const rotation = config({ ae: [rep('ana', { capacity: 2 }), rep('ben')] });
  assert.equal(pickRep({ rotation, pool: 'ae', last: 'ben', open: { ana: 2 } }).rep.id, 'ben');
  assert.deepEqual(pickRep({ rotation, pool: 'ae', last: 'ben', open: { ana: 2 } }).skipped, [
    { id: 'ana', reason: 'at capacity (2 of 2 open)' },
  ]);
  assert.equal(pickRep({ rotation, pool: 'ae', last: 'ben', open: { ana: 1 } }).rep.id, 'ana');
});

test('reps already tried for this lead are excluded, so a reassignment never returns to them', () => {
  const rotation = config({ ae: [rep('ana'), rep('ben'), rep('cy')] });
  const picked = pickRep({ rotation, pool: 'ae', last: 'ana', open: {}, exclude: ['ben'] });
  assert.equal(picked.rep.id, 'cy');
});

test('a pointer naming a rep no longer in the file restarts at the top and says so', () => {
  const rotation = config({ ae: [rep('ana'), rep('ben')] });
  const picked = pickRep({ rotation, pool: 'ae', last: 'gone', open: {} });
  assert.equal(picked.rep.id, 'ana');
  assert.match(picked.note, /gone.*no longer in the ae rotation/);
});

test('no pool for the band refuses NO_ROTATION_FOR_POOL and assigns nobody', () => {
  const rotation = config({ ae: [rep('ana')] });
  const picked = pickRep({ rotation, pool: 'sdr', last: undefined, open: {} });
  assert.equal(picked.rep, undefined);
  assert.equal(picked.code, 'NO_ROTATION_FOR_POOL');
});

test('an empty pool refuses ROTATION_EMPTY and assigns nobody', () => {
  const rotation = config({ ae: [] });
  const picked = pickRep({ rotation, pool: 'ae', last: undefined, open: {} });
  assert.equal(picked.rep, undefined);
  assert.equal(picked.code, 'ROTATION_EMPTY');
});

test('every rep skipped refuses NO_ELIGIBLE_REP, naming each rep and why', () => {
  const rotation = config({ ae: [rep('ana', { away: true }), rep('ben', { capacity: 1 })] });
  const picked = pickRep({ rotation, pool: 'ae', last: undefined, open: { ben: 1 } });
  assert.equal(picked.rep, undefined);
  assert.equal(picked.code, 'NO_ELIGIBLE_REP');
  assert.match(picked.detail, /ana: away/);
  assert.match(picked.detail, /ben: at capacity \(1 of 1 open\)/);
});

test('a malformed rotation file is refused by name, saying what is wrong', () => {
  const bad = [
    [{ pools: {} }, /response_minutes/],
    [{ response_minutes: 0, pools: {} }, /response_minutes/],
    [{ response_minutes: 30 }, /pools/],
    [{ response_minutes: 30, pools: { ae: 'x' } }, /ae.*list/],
    [{ response_minutes: 30, pools: { ae: [{ id: 'a', slack_user_id: 'U' }] } }, /hubspot_owner_id/],
    [{ response_minutes: 30, pools: { ae: [{ id: 'a', hubspot_owner_id: '1' }] } }, /slack_user_id/],
    [{ response_minutes: 30, pools: { ae: [rep('a'), rep('a')] } }, /duplicate rep id "a"/],
    [{ response_minutes: 30, pools: { ae: [rep('a', { capacity: 0 })] } }, /capacity/],
    [{ response_minutes: 30, pools: { ae: [rep('a', { away: 'yes' })] } }, /away/],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => parseRotationConfig(input), (error) => {
      assert.ok(error instanceof RotationConfigError);
      assert.equal(error.code, 'ROTATION_CONFIG_INVALID');
      assert.match(error.message, message);
      return true;
    });
  }
});
