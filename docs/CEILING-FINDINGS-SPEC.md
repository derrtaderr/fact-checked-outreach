---
name: signal-desk lead ceiling findings spec (row 80)
read_by: the lane that closes the four billing-adjacent findings from the lead-ceiling review, and any later session touching flag parsing in src/cli.mjs, the kernel ceiling, liveConfig, or the live cost wording in the README. Read docs/LEAD-CEILING-SPEC.md first; this spec corrects it.
date: 2026-11-16
status: spec — written before the fixes existed
---

# The lead ceiling, four findings closed

The per-run lead ceiling (docs/LEAD-CEILING-SPEC.md, PR #6) shipped with four gaps that bite on a
stranger's first live run, plus four smaller ones from the same review. Each one below gets a
failing test before its fix.

## Prior art, checked 2026-11-16

- `flagValue` on main is still `args.indexOf(name)`: first match wins, no repeat check.
- No open PR and no branch carries this work. The ceiling shipped in PR #6; these findings were
  carried forward from its review.
- Baseline on `8d4410f`: `npm test` (`node --test "test/**/*.test.mjs"`) exit 0, 868 tests,
  867 pass, 0 fail, 1 skipped (the keyed smoke test, which runs only with
  `SIGNAL_DESK_LIVE_SMOKE=1`).
- The golden ledger pins the FIXTURE run only. Fixture mode has no `limits` and nothing here
  changes `defaultConfig`, so no golden should move. If one does, that is a bug, not an update.

## Finding 1. A repeated value flag silently takes the first value

`run --live --max-leads 500 --max-leads 5` ran under 500, because `flagValue` returns the first
match. The operator's last word was 5.

**Fix.** The flag check in `src/cli.mjs` (the same pass that refuses unknown flags, before any verb
runs) refuses a value flag given more than once, with `FLAG_REPEATED`, naming the flag and every
value it got. Exit 2. Nothing is read, fetched or written. No "last one wins" rule: picking either
value is a guess about which one the operator meant, and the cost of the wrong guess is a bill.

**Blast radius, decided per flag.** `flagValue` has four callers, and there are four value flags.

| Flag | Verb | What first-match did | Decision |
|---|---|---|---|
| `--max-leads` | `run --live`, `dlq --replay` | billed under the first ceiling | refuse a repeat (the finding) |
| `--signals` | `run --live` | ran the first folder, which may bill | refuse a repeat |
| `--by` | `approve`, `reject` | recorded the first name | refuse a repeat: a decision ledger that records a name the operator overrode is wrong |
| `--note` | `approve`, `reject` | recorded the first note | refuse a repeat, same reason |
| `--live`, `--replay` | boolean | a repeat means the same thing | allowed, no value to disagree |

**The same pass, a missing value.** `run --live --signals` with no value fell back to `./signals`,
a different folder from the one the operator was about to type, and ran it. `--by` and `--note`
with no value fell back to the default name and no note. All three now refuse with
`FLAG_VALUE_MISSING` when the value is absent or is itself a flag (`--signals --max-leads 5`).
`--max-leads` keeps its own refusal, `LEAD_CEILING_INVALID`, which already covers a missing value
and is already tested; routing it through the generic one would change a code operators may
already script against for no gain.

## Finding 2. The kernel stop fails open on a non-integer ceiling

`ceilingOf` returned "no ceiling" for `maxLeads` of `null`, `'5'` or `2.5`, so a live run with any
of those fetched for every lead (15 fetches, 0 refusals in the review's probe). `Infinity`
crashed. `liveConfig` accepted any `maxLeads` it was handed. The README promises the kernel bounds
"any caller", and for those values it bounded nothing. The CLI cannot reach this today, since
`parseMaxLeads` runs first; a script or a future entry point can.

**Fix, fail closed in two places.**

1. `liveConfig` validates `maxLeads`: a safe integer of 1 or more, or it throws
   `LeadCeilingInvalidError` (`LEAD_CEILING_INVALID`).
2. `ceilingOf` in `src/kernel.mjs` throws `LEAD_CEILING_MISSING` before any stage runs when:
   - the config is live (`mode: 'live'`) and carries no `limits`, or
   - a `limits` object is present (any mode) and its `maxLeads` is not a safe integer of 1 or more,
     or its `countedFrom` is not the name of a stage in this pipeline (a ceiling counted at a stage
     that never runs bounds nothing).

   A config with no `limits` and no live mode is still fixture mode with no ceiling, unchanged.
   The throw happens before the first stage, so nothing runs, nothing bills and no ledger line is
   written. A thrown kernel is the right failure here: a misconfigured ceiling is a programming
   error in the caller, not a decision about a lead.

**Consequence, recorded as a divergence, and WITHDRAWN in fix wave 1 (I1).** This said a live
capture written before PR #6 would now throw on replay, and justified it as "already a different
run". That justification was false: the capture's run id was computed from its own config, which had
no `limits`, and replay recomputes the id from the same config, so on main it printed "exact match".
The regression was real and is fixed below; the kernel no longer keys on the `mode` label.

## Finding 3. "The refusal is free, so it doubles as the preview"

The README and flow.md call the start refusal a free preview. It is free only when the folder is
OVER the ceiling. Under the ceiling, the same command is the real, billed run. A stranger who
"previews" with the real command and a ceiling that fits gets a bill.

**Decision: add a real `--plan`, and correct the wording.** `run --live --plan` loads the signals
folder exactly as a live run does and prints what that run would do, then exits 0 having fetched
nothing, called no model and written nothing:

- how many parsed payloads there are, the ceiling, and whether the run would start or be refused;
- per lead, the evidence URLs its payload cites and whether it names an identity source;
- the request count: the expected count with no retries, and the worst case with every retry.

Why `--plan` rather than wording alone: wording only tells the operator there is no preview, and
the ceiling's own spec leaned on the refusal because it had nothing better. A plan is small (it
reads the same folder through the same loader and shares the ceiling check and the cost formula
with the real run), it is fully testable keyless, and it answers the question a stranger actually
has before the first live run: what will this cost me. The previous spec's worry, a second live
mode that drifts from the first, does not apply: `--plan` never builds a transport or runs the
pipeline, and the count it prints comes from one function the refusal message also uses.

`--plan` needs no credentials, because it contacts nobody and verifies nothing. That also means it
cannot tell which payloads ingest will refuse for a bad signature, so its counts are an upper bound
and it says so. `--plan` on a fixture `run` refuses with an explanation, the same way
`--max-leads` does. `dlq --replay --plan` is not built (see open questions).

The README and flow.md sentences that call the refusal a preview are rewritten: the refusal is free
because it refuses; under the ceiling, the real command bills; `--plan` is the preview.

## Finding 4. "Two model calls per lead"

The README, the refusal message and the ceiling spec say every lead makes two model calls.
`src/live/anthropic.mjs` sets `DEFAULT_RETRIES = 2`, so each call is up to three attempts, and a
lead is up to six model attempts. Evidence fetches have the same shape (`src/live/http.mjs`,
`DEFAULT_RETRIES = 2`). The README gives no per-lead figure at all.

**Fix.** One function computes the request count from the code's own constants, and the refusal
message, `--plan` and the README all state the same formula:

```
per lead, expected (nothing retried):   U fetches + 2 model calls
per lead, worst case (every retry):     U × (1 + 2) fetches + 2 × (1 + 2) = 6 model attempts
    U = evidence URLs the payload cites + 1 if it names an identity source
    each model attempt asks for at most 2,048 output tokens (DEFAULT_MAX_TOKENS)
```

No price is given. None is in this repo, provider prices change, and whether a failed or timed-out
attempt is billed is the provider's rule, not this code's. The README gives the formula in
requests and tokens and says the price is the reader's to apply.

## Minors from the same review

Located with certainty or by a reading stated here. Each gets a test.

1. **Refusal advice when the operator lowered the ceiling.** The refusal always advised "raise the
   ceiling on purpose with `--max-leads N`", including when the operator had just typed a lower
   ceiling on purpose to cap spend. The message now says where the ceiling came from (the default,
   or the operator's own `--max-leads`), and when it was the operator's, leads with splitting the
   folder and offers the raise second.
2. **The dlq replay message reads as if it started.** `dlq --replay` printed "replaying N dead
   letter(s)" before the credential and ceiling checks, so a refused replay printed that it was
   replaying and then that it was refused. The announcement now prints only once those checks pass.
3. **The over-count for bad-signature payloads.** The start check counts parsed payloads,
   including ones ingest will refuse for a bad signature, so a folder of 11 with 2 badly signed is
   refused at a ceiling of 10. Kept (the start check cannot verify without running ingest), and now
   said in the refusal message and the README.
4. **The integer copy.** The invalid-ceiling message and the README say "a whole number", but the
   parser also refuses whole numbers written `007`, `+5` or `1e3`. The copy now says what is
   accepted: plain digits with no sign, leading zero, decimal point, exponent or spaces.

## Out of scope, an open question for the owner

After `approve`, the next `run --live` re-runs every lead in the folder, billing each again, and a
lead whose regenerated draft hashes differently parks again as `APPROVAL_STALE`, so the approve and
re-run loop can repeat the bill. The per-run ceiling does not bound repeated runs. Not built here;
the report cites the code.

## Gate commands

```console
$ npm test
$ node <path-to-system-map>/bin/system-map.mjs reconcile .
```

Every cycle commits with `npm test` green, and every cycle's test was first shown red with the
implementation reverted and the test kept.

# Fix wave 1, after the independent ship-check (2026-11-16)

The ship-check found that the four fixes held, and it blocked on a neighbouring hole in the same
class. Each item below gets a failing test first, as before.

## B1. A token that does not start with "--" was skipped, not checked

The flag check refused unknown `--` flags and skipped everything else. So `run --live -plan`,
`run --live —plan` (an em dash, which editors and chat apps substitute for two hyphens),
`run --live –plan` (an en dash) and `run --live plan` all ran the real, billed run, and
`run --live -max-leads 3` ran under the default ceiling of 10. A mistyped preview was the bill. The
`-max-leads` half predates this branch.

**Fix.** Every token is accounted for: an accepted flag, an accepted flag's value, or the verb's one
positional argument, written first. Anything else exits 2 before anything is read, fetched or
written. A token starting with a hyphen-minus or any dash-like character (U+2010 to U+2015, U+2212,
and the small and fullwidth hyphen-minus) is refused as `unknown flag`, saying flags take two ASCII
hyphens. A bare word in any other place is refused as `unexpected argument`, naming what the verb
does take. A dash-like token is refused even in the positional slot, because no draft hash, lead id
or run id starts with one.

| Verb | Positional, first place only | Decision |
|---|---|---|
| `run` | none | any bare word refuses |
| `queue` | none | any bare word refuses |
| `dlq` | none | any bare word refuses |
| `approve`, `reject` | the draft hash or lead id | kept; a second bare word refuses |
| `explain` | the lead id | kept; a second bare word refuses |
| `replay` | the run id | kept; a second bare word refuses |
| `dashboard` | the run id, optional | kept; a second bare word refuses |

## I6. `run --signals <dir>` without `--live`

This ran the 14-signal fixture demo, ignored the folder and exited 0. It predates this branch. Now it
is refused the way `--max-leads` and `--plan` are on a fixture run, naming `run --live --signals`.

## I1, I2 and I3. The guard keys on the wiring, not on a label

**What was wrong.** Finding 2's guard switched on `config.mode === 'live'`, a label the caller
writes. Three consequences, all found by the ship-check:

- I2: with the real live transports wired and the label deleted, or written `'fixture'` or `'Live'`,
  every lead was fetched.
- I1: a live capture made before the ceiling existed carries `mode: 'live'` and no `limits`. Replay
  bills nothing, and it died with an uncaught `LeadCeilingMissingError`.
- I3: a ceiling counted at `draft` or `handoff` let every lead through `enrich`, the first stage that
  fetches, so it bounded nothing for fetches.

**Decision: key on the wiring, because it is clean.** The two functions in this repo that can reach
a metered service, `createLiveFetcher` and `createLiveModel`, mark the function they return with a
symbol (`src/billing.mjs`). The capture wrappers carry the mark through. The kernel asks the two
seams it was handed. Stages that reach a seam declare `billing: true` (`enrich`, `draft`, `gate`).

- Billing wired: a valid ceiling is required, whatever `mode` says, and `countedFrom` must be at or
  before the first `billing: true` stage. Counting earlier (`ingest`) is stricter and allowed. If no
  stage declares billing, the kernel cannot place the count, so it refuses.
- Nothing billing wired (fixture runs, `replay` from a capture): no ceiling is required. A pre-ceiling
  capture replays as an exact match again.
- A `limits` that is present but unreadable is refused in every mode, as in finding 2.
- `replay` catches a `LEAD_CEILING_*` error and prints it by name with exit 1, not a stack trace.

**The limit, stated plainly in the README.** A caller that writes its own fetch or model function
from scratch is not marked, because this repo cannot know a function it did not build spends money.
That caller is bounded only if it supplies `config.limits`. The README's "any caller" claim is
narrowed to exactly this.

**Why not key on the label and special-case replay.** Replay is not the only caller that wires
nothing billing; tests and scripts do too. And the label is precisely what I2 showed cannot be
trusted. The mark lives on the object that spends the money, so it cannot be mislabelled by editing
config.

## M6. `Infinity` or `NaN` through `buildLiveRun`

The run id serialiser threw a bare `TypeError` on a non-finite number before the kernel saw the
ceiling. `buildLiveRun` now runs the kernel's ceiling check first, so it throws
`LEAD_CEILING_MISSING`, with nothing fetched.

## M1. What `--plan` prints per lead

It printed a count ("2 evidence URL(s)"), while the README, flow.md and finding 3 above said it
prints the URLs and whether an identity source is named. It now prints each URL and either the
identity source or "no identity source named". Printing the URLs is the better side to converge on:
where a fetch goes is what an operator checks before paying for it.

## M5. Refusal advice for `dlq --replay`

Over its ceiling, `dlq --replay` advised splitting the signals into runs. It re-feeds the whole
queue at once and has no way to split, so the advice now says that, and that replaying them takes
`--max-leads <count>`, which bills for every letter. `run --live` keeps the split advice.

## I4. What a second `run --live` costs

Documented, not fixed: the fix is the owner's decision (see the open question above). A README
subsection in the live-mode section, "What a second run costs", and the flow.md live approval loop
now say the same thing. After `approve`, the next `run --live` re-runs every lead in the folder
through enrich, draft and gate, so it bills all of them again. If the approved lead's redraft hashes
differently, it parks again as `APPROVAL_STALE`. The ceiling bounds each run, not the number of runs.
flow.md's line "the approved draft is the only thing that moves" is corrected.

## M2, M3, M4, M7. Freshness

- M2: the system-map baseline is re-agreed once, at the final head of this wave, so it lists every
  module, edge and test file on disk.
- M3: the section 4 citations in `.vibecodepm/system.md` are corrected, and a test now reads each
  cited line and checks it is the line described, so they cannot go stale silently again.
- M4: the README says `dlq --replay` takes `--max-leads`, not "the same flag", which read as `--plan`.
- M7: the flow.md and metrics.md frontmatter name this build and today's date instead of the M4 lane.

# Fix wave 2, after ship-check pass 2 (2026-11-16)

Pass 2 blessed `6a6a776` and closed every pass-1 finding. It found one important defect that wave 1
widened, and four minors.

## N-A. `--plan` printed payload text raw

The preview is where an operator reads untrusted payloads, and it printed `id`, `sources` and
`identity_source` as they came. A payload carrying ESC, CR, BEL, NUL, backspace and a right-to-left
override rewrote the terminal and printed its own "This run would be refused" and "Nothing would be
billed. Safe to run." lines.

**Fix.** No helper in the repo fitted: the dashboard's `escapeHtml` is for HTML, and the redaction
and key scrubbers remove secrets, not control characters. A new `src/terminal.mjs` exports
`printable`, which leaves ordinary text alone and shows every control character as a visible escape
(`\x1b`, `\r`, `\n`, `\u202e`): C0, DEL, C1, U+202A to U+202E, U+2066 to U+2069, U+2028 and
U+2029. Escaping beats stripping because the operator can see the payload carried something. With
line breaks escaped, a payload can never begin a line of its own.

**Every path where payload-derived text reaches stdout or stderr, and what was done:**

| Path | Payload-derived text | Done |
|---|---|---|
| `run --live --plan` | id or file name, each source, identity source | escaped, truncated at 200, userinfo masked |
| run summary (`run`, `run --live`, `dlq --replay`) | lead id, which for an ingest-refused lead is the payload's own `id` | escaped |
| `explain` | the lead id (typed, and matching the payload's), the run id, each entry's detail and evidence refs | escaped; details are not truncated |
| `queue` | lead id, `to`, `subject`, owner, status, draft hash | escaped |
| `approve`, `reject` | lead id, `to`, `subject`, `by` | escaped |
| `dlq` listing | file, reason, signal id, source file name, detail | escaped; detail not truncated |
| dashboard | everything | left: it is written to an HTML file and already passes through `escapeHtml`; the terminal sees only counts and a path |
| refusals that echo argv (`unknown flag`, `unexpected argument`, `nothing parked matches`) | text the operator typed, not payload text | left: not payload-derived |
| `no signal directory at <dir>` | the operator's path | left: not payload-derived |
| the handoff and parked JSON files | everything | left: JSON-escaped files, not terminal output |

## N-D. Non-string sources and long values

`--plan` printed non-string sources as `12345`, `null` and `[object Object]` and counted them. Now
it prints `(not a string: number)` and so on. Only URLs that are https once `{domain}` and `{email}`
are expanded are counted in U, because the live fetcher refuses anything else before it sends a
request (`SOURCE_INSECURE`), so nothing else can bill. The count is taken after expansion, by the
run's own `expand()` and the fetcher's own `isFetchableUrl()` (review pass 3, X1). The README's formula says "https" now. A value longer than 200 characters is cut and says
`(N characters, first 200 shown)`.

## N-E. Credentials in a URL

`--plan` masks the userinfo of a printed URL: `https://user:pw@host/a` prints as
`https://***@host/a`. The query string is printed as it is. Whether `?api_key=` is a secret depends
on the source, and a URL the operator cannot read in full is one they cannot check before paying to
fetch it. The ledger and the capture still hold the URL as the payload gave it; masking is for the
terminal only.

## N-B. Which functions carry the billing mark, exactly

The README said a function written "from scratch" is not recognised. That was too narrow: a thin
wrapper around this repo's own transport, such as an arrow that calls it, a `.bind` copy or an
`Object.assign` copy, also loses the mark, because the mark is a non-enumerable symbol on the
function object. The README and `src/billing.mjs` now say that only the exact function
`createLiveFetcher` or `createLiveModel` returned, and the capture wrapper around it, is recognised.
A test pins each case. Making wrappers inherit the mark is not attempted: a wrapper can do anything,
including not calling the transport, so the honest rule is to state the boundary.

## N-C. The remaining stale citations in the system map

Sections 2 and 3 cited `src/cli.mjs` lines that this PR moved. They are corrected at the final head,
and the docs test now checks them the way it checks section 4: every `writeFileSync(` in the CLI is
cited and nothing else is, and the runs-directory cite lands on the line that reads
`SIGNAL_DESK_RUNS_DIR`.

## Split before raise

The ship-check noted that after the `ceiling-messages.test.mjs` revision nothing asserted that the
`run --live` refusal offers splitting before raising. It is asserted in
`test/plan-urls-dlq-advice.test.mjs`, in the test "run --live keeps the split advice, because a folder
can be split", which checks the split sentence comes before `--max-leads 3`. No change was needed.
