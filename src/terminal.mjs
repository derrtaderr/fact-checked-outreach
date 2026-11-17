// Text from a payload, made safe to print. docs/CEILING-FINDINGS-SPEC.md, fix wave 2, N-A, N-D, N-E.
//
// A payload is a stranger's bytes. Printed raw, its control characters drive the operator's terminal:
// ESC sequences erase and rewrite lines, CR and LF start new ones, a right-to-left override reorders
// what follows. The row 80 ship-check made `--plan` print a forged "Nothing would be billed. Safe to
// run." line this way. So every payload-derived string that reaches stdout or stderr goes through
// `printable`, which leaves ordinary text alone and makes every control character VISIBLE as an
// escape, rather than stripping it, so the operator can see that the payload carried one.
//
// Covered: C0 (U+0000 to U+001F, including CR, LF, ESC, BEL, NUL, backspace), DEL (U+007F), C1
// (U+0080 to U+009F, including NEL and CSI), the bidi embeddings and overrides (U+202A to U+202E),
// the bidi isolates (U+2066 to U+2069), and the line and paragraph separators (U+2028, U+2029).
// With line breaks escaped, a payload can never begin a line of its own.

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u2028\u2029]/gu;
const NAMED = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

// Longer than any sane URL or id, short enough that one hostile value cannot fill the screen.
export const PRINTABLE_MAX = 200;

function escapeControl(text) {
  return text.replace(CONTROL, (ch) => {
    if (NAMED[ch]) return NAMED[ch];
    const code = ch.codePointAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/**
 * A payload-derived value as one safe line. A value that is not a string says so rather than
 * printing as 12345, null or [object Object]; a long one is cut with its length stated.
 */
export function printable(value, { max = PRINTABLE_MAX } = {}) {
  if (typeof value !== 'string') return `(not a string: ${value === null ? 'null' : typeof value})`;
  if (value.length <= max) return escapeControl(value);
  return `${escapeControl(value.slice(0, max))}… (${value.length} characters, first ${max} shown)`;
}

/**
 * A URL with its userinfo masked: `https://user:pw@host/` prints as `https://***@host/`. The query is
 * left alone. Whether `?api_key=` is a secret depends on the source, and a URL the operator cannot
 * read in full is one they cannot check before paying to fetch it.
 */
export function maskUrl(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1***@');
}
