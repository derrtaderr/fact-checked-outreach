// Which seams can bill. docs/CEILING-FINDINGS-SPEC.md, fix wave 1, I2.
//
// The kernel's lead ceiling used to switch on config.mode === 'live', a label the caller writes. A
// caller that wired the real live transports and deleted the label, or wrote 'fixture' or 'Live',
// ran with no ceiling at all. So the guard keys on the wiring instead: the two functions in this repo
// that can reach a metered service, createLiveFetcher and createLiveModel, mark what they return, the
// capture wrappers carry the mark through, and the kernel asks the seams it was handed.
//
// What this does NOT cover, and the README says so: only the exact function createLiveFetcher or
// createLiveModel returned, or the capture wrapper around it, carries the mark. Any other function
// does not, including a thin wrapper around a marked one (an arrow that calls it, a .bind copy, an
// Object.assign copy, since the mark is non-enumerable). Such a caller is bounded only if it supplies
// config.limits itself.

export const BILLS = Symbol.for('signal-desk.bills');

export function markBilling(fn) {
  Object.defineProperty(fn, BILLS, { value: true, enumerable: false });
  return fn;
}

export function bills(fn) {
  return typeof fn === 'function' && fn[BILLS] === true;
}
