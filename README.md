<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/fact-checked-outreach-wordmark-dark.png">
    <img src="assets/fact-checked-outreach-wordmark-light.png" alt="fact-checked-outreach" width="760">
  </picture>
  <br>
  A signal-to-outreach pipeline where every decision can be inspected, replayed, or refused.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white" alt="Node 20 or newer">
  <img src="https://img.shields.io/badge/dependencies-0-F97316" alt="Zero dependencies">
  <img src="https://img.shields.io/badge/mail%20sent-never-8B949E" alt="Never sends mail">
</p>

<p align="center">
  <a href="#try-it">
    <img src="assets/signal-desk-demo.gif" alt="Running node bin/signal-desk.mjs run on the recorded fixture corpus: 1 passed to handoff, 1 awaiting a human, 12 refused, 14 signals in total, then a decision per lead, and nothing was sent." width="760">
  </a>
</p>

An inbound intent signal arrives. Something has to enrich it, score it, decide who owns it,
write to the person, check that what was written is true and safe, and then stop and wait for
a human. signal-desk is that path, built so you can ask of any lead, at any point afterwards,
what happened and why.

It never sends mail. The pipeline ends at an approval queue, and survivors export through a
pluggable sender interface whose only reference adapter writes dry-run JSON.

## Try it

You need Node 20 or newer. There is nothing to install, no API key, and no network call.

```console
$ git clone https://github.com/derrtaderr/fact-checked-outreach.git
$ cd fact-checked-outreach
$ npm test
$ node bin/signal-desk.mjs run
```

The demo runs against a recorded fixture corpus, so it produces the same result on your
machine as on anyone else's.

<!-- verified-block: run -->
```console
$ node bin/signal-desk.mjs run
run run-44b10b54cba9

  1 passed to handoff
  1 awaiting a human
  12 refused
  14 signals in total

  lead-29e94419ba7e      handoff   PASS         
  sig-1001               ingest    REFUSE       DUPLICATE_SIGNAL
  lead-ff1af2ff8d01      queue     NEEDS_HUMAN  AWAITING_APPROVAL
  lead-845826c4c069      route     REFUSE       BELOW_ROUTING_FLOOR
  lead-e557482af15d      queue     REFUSE       REJECTED_BY_HUMAN
  sig-9001               ingest    REFUSE       MALFORMED_PAYLOAD
  lead-e321020a996e      gate      REFUSE       PII_IN_BODY
  lead-6dfbc9615067      gate      REFUSE       RUBRIC_FAILED
  lead-3a8cab6564a2      gate      REFUSE       UNGROUNDED_PROSE_CLAIM
  sig-9006               ingest    REFUSE       DUPLICATE_LEAD
  lead-aa10c945e3bf      enrich    REFUSE       IDENTITY_CONTRADICTED
  lead-d03317053357      enrich    REFUSE       EVIDENCE_DECAYED
  lead-f4a249c336f5      gate      REFUSE       PROMPT_INJECTION
  lead-03ceebb25be4      enrich    REFUSE       NO_CITED_CLAIMS

  ledger    runs/run-44b10b54cba9/ledger.jsonl
  handoffs  1 dry run artifact(s) in runs/run-44b10b54cba9/handoffs

  Nothing was sent. This tool never sends mail.
  Inspect a decision with: node bin/signal-desk.mjs explain <lead>
  See the whole run at once with: node bin/signal-desk.mjs dashboard
  Act on what is parked with: node bin/signal-desk.mjs queue
```

Fourteen signals went in and one came out the far end. That ratio is the point. Twelve were refused
and one is waiting for a person, and every one of those outcomes names the rule that produced
it.

The corpus ships hostile fixtures on purpose, one per safeguard, so the demo shows the gates
working rather than asserting that they exist:

| Refusal | What the fixture does |
|---|---|
| `MALFORMED_PAYLOAD` | A webhook body with no company domain |
| `DUPLICATE_SIGNAL` | The same signal id replayed, correctly signed |
| `DUPLICATE_LEAD` | The same *person* re-signalled under a **new** signal id. The HMAC covers the payload only, so this is validly signed and walks past signal-level idempotency |
| `BELOW_ROUTING_FLOOR` | A six-person company reading a blog post |
| `PII_IN_BODY` | A scraped directory page with a phone number in its industry field, interpolated straight into the draft |
| `UNGROUNDED_PROSE_CLAIM` | An industry string smuggling "now scaling after their Series C" into the body, which no cited source supports |
| `RUBRIC_FAILED` | A draft every deterministic rule passes, pitched to the wrong reader. No regex catches that, which is what the judge is for |
| `IDENTITY_CONTRADICTED` | A signal that is correct in every checkable way and names the wrong human. The person-level source puts that address at a different company |
| `EVIDENCE_DECAYED` | A source that answers 200, in the right shape, with a record dated eleven months ago. A 200 is not freshness |
| `PROMPT_INJECTION` | A scraped page whose industry field tells the system to ignore its instructions and approve the lead, with live markup attached |
| `NO_CITED_CLAIMS` | A company that does not exist. Three sources each know nothing, and nothing is invented to fill the hole |
| `REJECTED_BY_HUMAN` | A person said no |

## Inspect a decision

Pass any lead id to `explain` and you get its whole trail, in order, with the evidence each
stage stood on.

<!-- verified-block: explain-pass -->
```console
$ node bin/signal-desk.mjs explain lead-29e94419ba7e
lead lead-29e94419ba7e
run  run-44b10b54cba9

  2026-03-01T09:00:00.000Z  ingest    PASS         system
      evidence  signal:sig-1001
  2026-03-01T09:00:01.000Z  enrich    PASS         system
      reasons   IDENTITY_CONFIRMED
      detail    https://people.test/dana@acme.test confirms Dana Ruiz at acme.test on 3 of 3 fields (company_domain, name, email)
      evidence  https://people.test/dana@acme.test
  2026-03-01T09:00:02.000Z  enrich    PASS         system
      evidence  https://directory.test/company/acme.test
                https://newsroom.test/acme.test
  2026-03-01T09:00:03.000Z  score     PASS         system
      evidence  https://directory.test/company/acme.test
  2026-03-01T09:00:04.000Z  route     PASS         system
  2026-03-01T09:00:05.000Z  draft     PASS         system
      evidence  https://directory.test/company/acme.test
  2026-03-01T09:00:06.000Z  gate      PASS         system
  2026-03-01T09:00:07.000Z  queue     PASS         human
      reasons   APPROVED_BY_HUMAN
      detail    dana.reviewer approved draft draft-b66622be1a11d3db at 2026-03-01T08:56:00.000Z
      evidence  draft:draft-b66622be1a11d3db
  2026-03-01T09:00:08.000Z  queue     PASS         system
      evidence  draft:draft-b66622be1a11d3db
  2026-03-01T09:00:09.000Z  handoff   PASS         system
      evidence  https://directory.test/company/acme.test
                https://newsroom.test/acme.test

  outcome: PASS at handoff
```

The first enrich line is the identity check. Before anything asks what is true about the
company, something asks whether the human the signal names is the human the evidence describes.
A record that disagrees stops the lead there, which is the `IDENTITY_CONTRADICTED` row above.

Note the `human` actor on the queue line. A person approved that draft, and the ledger records
who, when, and **which draft**. An approval binds to a hash of the message content, never to
the lead, so changing a single character of the text leaves the old decision covering nothing
and the lead parks again as `APPROVAL_STALE`. A refusal reads the same way.

<!-- verified-block: explain-refuse -->
```console
$ node bin/signal-desk.mjs explain sig-9001
lead sig-9001
run  run-44b10b54cba9

  2026-03-01T09:00:35.000Z  ingest    REFUSE       system
      reasons   MALFORMED_PAYLOAD
      detail    signal is malformed: payload.company.domain

  outcome: REFUSE at ingest
```

## Replay a run

`replay` does three separate things, and reports them separately, because a ledger can pass one
and fail another. It verifies the hash chain, which proves the file was not edited after it was
written. It checks the terminal seal, which proves nothing was removed from the end. Then it
re-executes the run from the same inputs and compares the bytes, which proves the code still
makes the same decisions.

<!-- verified-block: replay -->
```console
$ node bin/signal-desk.mjs replay run-44b10b54cba9
hash chain verified across 83 entries
seal verified: 1 passed, 1 parked, 12 refused, 14 in total
replay of run-44b10b54cba9 is an exact match
83 entries, identical bytes, chain intact
```

If you edit a line in `runs/<run-id>/ledger.jsonl` and run `replay` again, it tells you which
entry broke and exits non-zero.

The seal is worth its own sentence, because a hash chain proves order and integrity and says
nothing about completeness. Delete the last few lines of a ledger and the chain still verifies
perfectly: every remaining entry links to the one before it. So every completed run appends a
terminal entry carrying the run summary and the head hash, and `replay` refuses a ledger that
does not end in one. That refusal says the chain was intact and lines were removed, because
that is a different problem from tampering and leads somewhere different.

## See the whole run at once

`dashboard` renders any run's ledger as one HTML file and writes it beside that ledger. No run
id means the latest run.

<!-- verified-block: dashboard -->
```console
$ node bin/signal-desk.mjs dashboard
dashboard run-44b10b54cba9

  83 ledger entries across 14 lead(s)
  1 passed, 1 parked, 12 refused
  12 distinct refusal reason(s), 2 human decision(s)

  runs/run-44b10b54cba9/dashboard.html

  Open it in a browser. It is one file, works offline, and fetches nothing.
  It is a read-only view. Decisions are still made with: node bin/signal-desk.mjs approve <id>
```

Open it in a browser. It is a single file with no dependencies, no external stylesheet, no
webfont and no JavaScript at all, so it renders identically with the network off. It shows the
funnel stage by stage, every refusal grouped by reason code, which part of the gate produced
each one, the human decisions with the draft hashes they bound to, and every lead's full trail.

Two properties are worth stating because they are enforced rather than intended.

**It is a pure function of the ledger and nothing else.** If a view is not derivable from the
ledger, the ledger does not record it and the fix belongs in the stage that should have written
it down. That is why the queue stage records `by` and `at` as fields rather than leaving a
renderer to parse them out of a sentence.

**It is read-only, and it does not pretend otherwise.** There is no approve control and no
disabled-looking one either, because a button that advertises a capability at the wrong surface
invites somebody to wire it up. Decisions are made at the command line. The page says so.

It also escapes every string it takes from the ledger, and that is not a formality here: the
prompt-injection fixture's payload is quoted into the ledger on purpose, so this page renders
attacker-controlled markup by design. A test renders the hostile run and asserts, in both
directions, that the payload is present and inert.

## The eight stages

The pipeline is an ordered list of stages in `src/config.mjs`. Order is the pipeline; nothing
else defines it.

| # | Stage | What it enforces |
|---|-------|------------------|
| 1 | ingest | HMAC over the payload, a replay window, an idempotency check, and a shape check strict enough that nothing downstream re-validates |
| 2 | enrich | Every claim binds to a citation fetched in this run. Claims the signal asserted about itself are kept and marked uncited |
| 3 | score | The total is exactly the sum of named factors, each carrying its points, its reason, and its evidence |
| 4 | route | A deterministic band decision with the reason attached |
| 5 | draft | Composes the message. A factual placeholder resolves only from a cited claim |
| 6 | gate | Three parts: fail-closed PII redaction, deterministic rules plus a fail-closed LLM rubric, and claim grounding over both structured references and prose. A gate that errors refuses |
| 7 | queue | Everything parks for a human by default. An approval binds to the draft's content hash, never to the lead. This is the send boundary |
| 8 | handoff | Renders an artifact through a documented adapter contract. Only approved draft hashes are exportable, and an export cannot overwrite a different one. Never sends |

## The gate

Stage 6 refuses on four separate disciplines rather than one list of rules.

**Fail-closed PII redaction.** Not one regex pass that reports what it matched, because that
cannot tell "there was no PII" apart from "my pattern did not match". Redaction and verification
are two passes with two different detectors, and the draft is refused when the second pass still
finds something. Finding a phone number is `PII_IN_BODY` and means everything worked. Residue
after redaction is `REDACTION_INCOMPLETE`, which is worse: the gate cannot characterise what it
is holding. Nothing is ever sent in redacted form; redaction here is how the check earns a
proof, not a repair.

**A fail-closed LLM rubric.** Silence is not a pass. A judge that could not be reached, answered
about a different draft, returned a shape this code cannot read, or left a required criterion
unanswered has approved nothing, and each of those is its own reason code. In fixture mode the
judge is a recorded response addressed by draft hash, which keeps the demo keyless and stops a
recorded verdict from outliving the draft it judged. Live mode (M4) swaps the fetcher and
changes nothing else.

**Claim grounding, over prose as well as references.** A `{claim:}` placeholder leaves a
structured reference the gate can verify. A sentence asserting a funding round leaves nothing,
which is how that used to get through. The prose check is typed: a funding claim grounds only
against a cited `funding_stage`, a headcount only against a cited `employee_count`. Typing is
what makes it correct rather than merely strict, and it is what lets a *contradiction* refuse.

**Prompt injection, new in M3.** A scraped page can carry text addressed to the system rather
than to the reader, and markup has no business in a message these templates compose as plain
prose. Both refuse, and the refusal quotes what it saw, because an operator cannot decide whether
to drop a source from their config on the strength of "something tried to instruct your system".

Worth being precise about what that rule does and does not buy, because the marketing version is
bigger than the honest one, and M4 changed which version is true.

**In fixture mode there is still no interpreter in the loop.** The draft stage is a mechanical
template fill, so an instruction smuggled into a source has nothing to instruct. What the rule buys
there is that the payload is **visible** — flagged by enrich where it entered, refused by the gate
where it landed.

**In live mode there is a model, and the defence is doing real work.** Enrichment text enters the
drafting prompt, wrapped in a fence whose delimiter is derived from a digest of the claim set, so a
hostile source cannot emit the closer that would end its own fence. The fence is defence in depth.
What **enforces** the rule is the same two things that enforced it in M3 — the injection detector at
enrich, and the gate's rules on the composed output — because both run on text the model produced
rather than on the prompt it was given. That is deliberate: a prompt is a request, and a gate is a
check. Nothing is stripped from the prompt either, because sanitising it would hide the payload from
the two rules built to catch it.

## What enrichment refuses

Three of M3's four hostile catches land at stage 2, and the unevenness is the point rather than
an accident. Most bad outreach is stopped by knowing something is wrong with the evidence, not by
catching a bad sentence after writing one.

**The signal names a person; the evidence names someone else.** Vendor-side identity resolution
is probabilistic, so a signal can be correctly attributed to a company and wrongly attributed to
a human. A person-level source is checked first, before any claim source, and a record that
disagrees stops the lead there. No draft is composed, because a message to the wrong person is
not made safer by being written first and refused later.

A record that is missing, unreachable or expired is reported as `IDENTITY_UNVERIFIED` and the
lead proceeds. That is not a fail-open. It is the state every lead was in before this rule
existed, and refusing it would be a new product policy rather than a safeguard. What matters is
that absence never reads as confirmation, and the ledger says so out loud.

**A 200 is not freshness.** Every claim response carries an `as_of`, compared against the run's
own clock. A record outside the freshness window is dropped and named. So is a record that
carries no `as_of` at all, and that is the load-bearing half: a response with no date cannot tell
"fetched fresh" apart from "read out of a cache in 2019", and trusting it would put the whole
rule at the mercy of a source that declines to date itself.

**No source knows this company.** Every source comes back empty and nothing is invented to fill
the hole. The refusal says what the run observed, which is that no citable claim exists. It does
not say the company is fake, because nothing here can tell that apart from every source being
down, and asserting it would be exactly the confident unsupported claim the safeguard exists to
refuse.

## The approval queue

The pipeline parks every survivor. `queue` shows what is waiting, `approve` and `reject` record
a decision, and the next run acts on it.

```console
$ node bin/signal-desk.mjs queue
$ node bin/signal-desk.mjs approve <draft-hash> --by you
$ node bin/signal-desk.mjs reject <draft-hash> --note "wrong persona"
$ node bin/signal-desk.mjs run
```

Any unambiguous prefix of a draft hash or a lead id works, because nobody retypes a hash. An
ambiguous one is an error rather than a guess.

**An approval binds to a hash of the draft's content, never to the lead.** This is the whole
design of the queue, and it exists because the alternative was tried: keying by lead meant one
recorded approval released a second draft the human had never seen. Edit a single character and
the old decision stops covering the draft, so the lead parks again as `APPROVAL_STALE` rather
than going out unread. Handoff re-checks the same binding, so only an approved draft hash is
exportable.

Decisions are written to `runs/approvals.jsonl` as an append-only, hash-chained ledger with
`actor: human`. Rewriting which draft a decision covers is precisely the attack the content hash
exists to stop, so the file holding the binding gets the same tamper-evidence as the run ledger.

## The stage contract

Every stage is the same shape, and that is the entire extension mechanism. There is no plugin
framework and there is not going to be one.

```js
stage(input, ctx) -> { status: PASS | REFUSE | NEEDS_HUMAN, output, entries }
```

`ctx` carries the ledger, the config, an injected clock, and an injected fetcher. Stages
perform no I/O of their own, which is what makes a fixture run reproducible and lets you test
any stage with a plain object.

Three rules the kernel enforces rather than trusting stages to remember.

A `REFUSE` or a `NEEDS_HUMAN` must carry a machine-readable reason code. A stage that throws
becomes a refusal, and a stage that returns something malformed becomes a refusal, so no error
can arrive at a later stage looking like a pass. And every stage execution writes a verdict
entry, so no stage can run silently.

To adapt the system, replace a module and re-wire the sequence in `src/config.mjs`.

## The decision ledger

Every run writes append-only JSONL, hash-chained so that editing or dropping a line is
detectable. Each entry carries `ts`, `run_id`, `lead_id`, `stage`, `verdict`, `reason_codes`,
`evidence_refs`, and `actor`, where actor is `system` or `human`.

Runs are byte-for-byte reproducible. Four things make that true, and each has a test. The
clock is injected and advances by pipeline position rather than elapsed time. The run id is
derived by hashing the wiring and the inputs rather than generated. Every line goes through
one canonical serialiser with sorted keys. And leads are processed in sorted order rather than
whatever order the filesystem listed them in.

## Fixture mode and live mode

Fixture mode is the default. It reads recorded responses from `fixtures/recordings.json`, and the
recorded fetcher throws on a URL it has no recording for rather than falling back to a live call.
The corpus signals carry real HMAC signatures, so the signature path is genuinely exercised
offline instead of skipped.

Live mode brings your own key. Nothing is hosted, there is no telemetry and no account, and the
tool still never sends mail.

## Live mode

```console
$ export SIGNAL_DESK_ANTHROPIC_KEY=sk-ant-...     # or ANTHROPIC_API_KEY
$ export SIGNAL_DESK_SIGNAL_SECRET=...            # what your sender signs with
$ node bin/signal-desk.mjs run --live --signals ./signals
```

`SIGNAL_DESK_ANTHROPIC_KEY` takes precedence over `ANTHROPIC_API_KEY`, so you can point this tool
at a different key from the one your shell already exports for everything else. With neither set,
`--live` refuses immediately with `LIVE_KEY_MISSING`, before reading a file or creating a
directory. With no signal secret it refuses with `LIVE_SECRET_MISSING`, because ingest skips
signature verification when it has no secret and a live mode that quietly accepted whatever
arrived would be worse than one that will not start.

The model defaults to `claude-sonnet-5` and `SIGNAL_DESK_MODEL` overrides it.

### The lead ceiling

A live run bills per lead: every admitted lead fetches the URLs its payload cites and makes two
model calls, one to draft and one to judge. Each of those requests is retried up to twice on a
timeout, a network error, a 429 or a 5xx, so the count per lead, from the code's own constants
(`src/live/cost.mjs`), is:

| Per lead | Fetches | Model | Output tokens per model attempt |
|---|---|---|---|
| Expected, nothing retried | U | 2 calls | at most 2,048 |
| Worst case, every retry | U × 3 | 6 attempts | at most 2,048 |

U is the evidence URLs the payload cites that are https once `{domain}` and `{email}` are expanded, plus one if it names an identity source that is.
Anything else (a plaintext URL, a number, `null`) is refused before any request and bills nothing. There is no
price here: none is in this repo, and whether a failed attempt is billed is your provider's rule.
Multiply by your own price. Input tokens grow with the evidence a lead carries; the only bound on them
is the 256 KiB cap on each source response. So a live run has a ceiling, **10 leads unless you say
otherwise**:

```console
$ node bin/signal-desk.mjs run --live --signals ./signals --max-leads 25
```

A signals folder holding more payloads than the ceiling refuses to start with
`LEAD_CEILING_EXCEEDED`, naming the count and the ceiling, before a single URL is fetched or a
model is called, and writes nothing. It counts parsed payloads, so a badly signed one counts against
the ceiling even though ingest will refuse it and it never bills past ingest. When the ceiling was
yours (`--max-leads`), the refusal says so and offers splitting the folder before raising it.
`dlq --replay` re-feeds the whole queue and cannot be split, so its refusal says that instead. That
refusal is free only because it refuses. **Under the
ceiling, the same command is the real, billed run**, so do not use it as a preview. The preview is
`--plan`:

```console
$ node bin/signal-desk.mjs run --live --plan --signals ./signals
```

It reads the folder the run would read and prints whether the run would start or be refused, the
evidence URLs per lead, and the expected and worst-case request counts from the table above. It
needs no key and no secret, fetches nothing, calls no model and writes nothing. It does not verify
signatures, so its counts are upper bounds. Everything it prints from a payload is made safe to read:
control characters (including ESC, CR, LF and the bidi overrides) are shown as escapes such as `\x1b`
rather than sent to your terminal, so a payload cannot rewrite the screen or print a line of its own;
values longer than 200 characters are cut, with their length stated; a source that is not a string
says so; and the user and password part of a URL (`https://user:pw@host`) prints as `***`. The query
string is printed as it is. The same escaping applies wherever payload text reaches the terminal:
the run summary, `explain`, `queue`, `approve` and `dlq`. `dlq --replay` is held to the same ceiling and takes `--max-leads` too (not `--plan`), because a
re-fed lead bills like a fresh one. The ceiling is written as plain digits, 1 or more, like `10` or
`25`. Zero, a negative, a fraction, or a spelling with a sign, leading zero, exponent or spaces
(`+5`, `007`, `1e3`) refuses with `LEAD_CEILING_INVALID`, and `--max-leads` on a fixture `run` refuses
rather than being ignored, since a fixture run bills nothing. `--max-leads` given twice refuses with
`FLAG_REPEATED` rather than quietly running under the first value, and so does any other value flag.
A flag typed with one dash or a typographic dash (`-plan`, `—plan`) or a stray word (`plan`) is
refused too, so a mistyped `--plan` can never become the billed run.

Behind the start check, the kernel enforces the ceiling itself. A lead admitted past it never
reaches `enrich` or anything after it, and gets its own `REFUSE` line with `LEAD_CEILING_REACHED`
in the ledger, never a silent truncation.

Exactly which callers that covers, because it is narrower than "any caller". The kernel requires a
ceiling when the run is wired to this repo's own billing transports, the ones `createLiveFetcher`
and `createLiveModel` return (`src/billing.mjs`), whatever the config's `mode` label says. With those
wired, a missing ceiling, a ceiling that is not a whole number of 1 or more (`null`, `'5'`, `2.5`,
`Infinity`), or one counted at a stage after `enrich`, the first stage that bills, throws
`LEAD_CEILING_MISSING` before anything is fetched. `liveConfig` refuses a bad value with
`LEAD_CEILING_INVALID`. A ceiling that is present but unreadable is refused in every mode. What it
does not cover: only the exact function `createLiveFetcher` or `createLiveModel` returned (and the
capture wrapper this repo puts around it) is recognised as billing. Any other function is not,
including a thin wrapper around one of those, such as an arrow function that calls it, a `.bind`
copy, or an `Object.assign` copy, because the mark is on the function object and none of those
carries it. Such a caller is bounded only if it supplies `config.limits` itself. With nothing billing wired,
as in fixture mode and in `replay`, no ceiling is required, which is why a live capture made before
the ceiling existed still replays. The ceiling is part of the run's config, so it is
in the run id and the capture, and a replay reproduces it. The default lives in
`src/live/config.mjs` as `DEFAULT_MAX_LEADS`. The per-request limits (source timeouts, the response
byte cap, bounded retries, the model's token cap) bound what one request costs; the ceiling bounds
how many leads make requests. `docs/LEAD-CEILING-SPEC.md` has the decisions.

### What a second run costs

The approval loop is `run --live`, `queue`, `approve`, then `run --live` again, and that second run
is not free. It re-reads the whole signals folder and runs every lead through enrich, draft and gate
again, so it bills every lead in the folder again, the one you approved included: its fetches and
two model calls, up to six attempts with retries. The approval is only checked at the queue stage,
after those calls. A model draft is not deterministic, so if the redraft of the approved lead comes
out different, it has a different hash, the approval does not cover it, and the lead parks again as
`APPROVAL_STALE` for you to read. Approving that and running again bills the folder again. The lead
ceiling is per run, so repeated runs are not bound by the ceiling. To keep the second run small, run
it over a folder that holds only the leads you approved.

### What live mode changes, and what it does not

Four switches, and they are the whole difference:

| | fixture | live |
|---|---|---|
| signature | HMAC over the canonical payload | HMAC over the **raw bytes**, and the parse must agree with them |
| enrichment | templated source URLs from config | the citation URLs **the payload names** |
| drafting | template fill | the LLM, refusing rather than falling back |
| rubric | recorded verdict | the LLM, through the same validator |

Everything else is identical, and that list is the more important one. The same eight stages. The
same deterministic gate rules, redaction passes, injection rule and claim-grounding check. The
same approval queue and its hash binding. The same handoff adapter that writes and never sends.
Earned autonomy, still off. **A live draft faces exactly the gates the fixture demo shows you**,
which is what makes the keyless demo evidence about the live path rather than a separate story.

### There is no server

Live mode reads files:

```
signals/0001.json       the exact bytes your sender transmitted
signals/0001.json.sig   the hex HMAC of those bytes
```

The signature sits beside the payload rather than inside it, because a signature inside the thing
it signs has to be excised before verification, and excising is where byte-exactness dies.

A server would be a listening socket, a deployment story, a TLS story and an authentication
surface, all of which are hosted-tool concerns. The ingest discipline this design cares about —
HMAC over raw bytes, a replay window, idempotency, a dead-letter queue — are properties of
*verifying* a payload rather than of *receiving* one, and files exercise all four. If you want a
webhook endpoint you already have one; the honest interface between it and this tool is a file.

Each payload names its own evidence, so no vendor account is involved:

```json
{
  "id": "sig-1",
  "source": "your-pipeline",
  "received_at": "2026-03-01T09:00:00.000Z",
  "payload": {
    "company": { "name": "Acme Robotics", "domain": "acme.example.com" },
    "contact": { "name": "Dana Ruiz", "email": "dana@acme.example.com", "title": "VP Revenue Operations" },
    "intent": { "page": "/pricing", "visits": 4 },
    "sources": ["https://your-enrichment.example.com/company/acme.example.com"],
    "identity_source": "https://your-people-api.example.com/dana@acme.example.com"
  }
}
```

Each source answers `{ "as_of": "<instant>", "claims": { ... } }` over HTTPS. Undated, stale,
future-dated, oversized, unparseable and plaintext-cited responses are each refused with their own
reason code.

### Trust boundaries

Stated plainly, because "bring your own key" is not the same as "nothing leaves the machine".

**What is sent to the model provider.** The company name, the contact's **first** name, their
title, the page they visited, and the cited claims with their citation URLs. That is all. It goes to
`https://api.anthropic.com/v1/messages` and nowhere else.

**Disclosed, because you should not have to infer it:** that endpoint was **never called during this
milestone's development.** Every test in this repo drives injected fake transports, and the request
shape is built to the published Messages API contract rather than confirmed against a live response.
`test/live-smoke.test.mjs` exists to confirm it against the real API and is skipped unless you set
both `SIGNAL_DESK_LIVE_SMOKE=1` and a key. **Your first live run is the first real call this code has
made**, so make it a small one.

**What is never sent to the model provider.** The recipient's email address. Writing the message
does not require it, so it stays in this process and the draft's `to` field is filled in locally.
Also never sent: your signal secret, your ledger, and any other lead's data.

**What is fetched.** Exactly the URLs a payload cited, over HTTPS only, with a timeout, bounded
retries, and a size cap. No redirects are followed, because a redirect is a source sending the run
somewhere it did not choose to cite.

**What is never sent anywhere, and never written down.** Your model key and your signing secret.
They live in one closure each, and appear in no ledger entry, no refusal detail, no capture and no
artifact — the run's capture stores a non-reversible fingerprint of the signing secret so a replay
can tell you if you have the wrong one. A provider's own 401 can echo a credential back at you, so
every message relayed from outside is scrubbed and capped first. `test/key-hygiene.test.mjs` runs a
live-shaped flow with a canary for **each** credential and greps every byte the run writes, including
`dashboard.html` and `inputs.json`, with a planted-value control proving the search works.

**The residual worth knowing about: a payload chooses what this tool fetches.** `sources` and
`identity_source` come from the signal, which is what keeps vendors out of this repo and makes the
citation discipline literal — and it means **a compromised or hostile sender can aim fetches at any
HTTPS endpoint reachable from the machine you run this on, including internal ones.** Four things
bound it: HTTPS only, no redirects followed, a per-request timeout and byte cap, and the fact that
nothing fetched can become a stated claim without passing the grounding gate. What is deliberately
**not** here is a host allowlist. If you run this where internal HTTPS services are reachable, treat
the signal secret as the control that matters, because it is: it is what decides whose payloads this
tool will act on at all.

**And nothing is ever sent to your prospect.** Live mode ends where fixture mode ends: at the
approval queue.

### A live run replays itself

A fixture run is **reproducible** — every input is in this repo, so the bytes match on any machine
forever. A live run is **replayable from its own capture**, which is a weaker and more useful
promise. It read a real clock and real strangers' servers, so it writes down everything it
observed into `runs/<run-id>/inputs.json`:

```console
$ node bin/signal-desk.mjs replay run-abc123456789
```

```console
$ node bin/signal-desk.mjs replay run-abc123456789     # chain + seal, no credentials at all
$ SIGNAL_DESK_SIGNAL_SECRET=... node bin/signal-desk.mjs replay run-abc123456789   # full re-execution
```

**What a replay can prove depends on what you share, and it says so rather than blurring it.** No
model key is ever needed — re-deriving a live run never touches the provider.

| They have | They can verify |
|---|---|
| the run directory | the ledger was not edited after it was written, and it is a completed run |
| ...plus your signing secret | all of that, **and** every payload signature, **and** that re-executing produces these exact bytes |

The capture holds a **fingerprint** of the signing secret, never the secret, so replaying with the
wrong one is refused by name instead of producing a byte mismatch that reads like a code change.
Replaying with none still verifies the chain and the seal, and prints exactly which checks it did not
make. A fixture run needs nothing at all, because its secret is a committed constant rather than a
credential.

### When ingest cannot accept something

```console
$ node bin/signal-desk.mjs dlq
$ node bin/signal-desk.mjs dlq --replay
```

The dead-letter queue holds payloads ingest **refused** — malformed, unsigned, wrongly signed,
outside the replay window — plus files that never parsed as JSON at all. Each one keeps its exact
bytes, so a fix at the sender can be proven against the same message rather than a reconstruction
of it.

It deliberately does not hold leads refused *downstream*. The ledger already records those
decisions completely, and retaining a payload whose gate refusal was correct invites somebody to
replay it until it passes. The line is between "we could not accept this" and "we accepted it and
said no", and only the first has a fix at the sender. Duplicates are excluded too, since a dead
letter for a successful no-op is an invitation to redeliver.

## Inbound last mile

`inbound` takes the leads a run handed off (a human approved that exact draft) and does the three
things that decide whether an inbound lead gets worked:

1. **An owner in HubSpot.** The next rep in a stored rotation is written to the contact as
   `hubspot_owner_id`. The contact is created if it does not exist, and a re-run never creates a
   second one.
2. **The rep told in Slack.** A direct message carrying the brief (company, contact, band, score,
   evidence) and the checked draft.
3. **A response clock.** If the lead is still untouched N minutes after the rep was told, it goes to
   the next rep, whose message says it was reassigned and from whom.

Nothing is sent to the prospect. The draft goes to the rep, who decides whether to send it.

Try it on the fakes, with no key. `--at` sets the tick's clock, so "31 minutes later" is a value
rather than a wait:

```console
$ node bin/signal-desk.mjs run
$ node bin/signal-desk.mjs inbound --at 2026-03-01T09:00:00.000Z
inbound tick at 2026-03-01T09:00:00.000Z (fixture mode: fake HubSpot and fake Slack), run run-44b10b54cba9
  rotation  the committed synthetic reps, 30 minute response window

  sig-1001     lead-29e94419ba7e    ASSIGNED              ana      owner written, ana told
  ...
$ node bin/signal-desk.mjs inbound --at 2026-03-01T09:31:00.000Z
  sig-1001     lead-29e94419ba7e    REASSIGNED            ben      owner written, ben told
```

The fakes keep their state in `runs/inbound-fixture/` (`hubspot.json`, `slack.json`, and the
journal), apart from live state, so a demo never touches a real assignment. To see the clock stop,
set `lastActivityAt` on the contact in `hubspot.json` and tick again.

### The rotation

A JSON file, `inbound.json` in the working directory or `--rotation <file>`. Pools are named by the
route band's owner (`ae-round-robin`, `sdr-queue` in the default config), so routing decides which
rotation a lead joins.

```json
{
  "response_minutes": 30,
  "pools": {
    "ae-round-robin": [
      { "id": "ana", "hubspot_owner_id": "1001", "slack_user_id": "U0001", "capacity": 5 },
      { "id": "ben", "hubspot_owner_id": "1002", "slack_user_id": "U0002", "away": true }
    ]
  }
}
```

`away: true` skips a rep. `capacity: n` skips a rep already holding n open leads.
`"overwrite_owner": true` at the top level lets the tool replace a HubSpot owner it did not write;
it is off by default (see the first live run below). The pointer is the
id of the last rep assigned, so reordering the file does not shift anyone's turn. A lead whose pool
is missing refuses `NO_ROTATION_FOR_POOL`, an empty pool refuses `ROTATION_EMPTY`, and every rep
skipped refuses `NO_ELIGIBLE_REP` naming each one and why. A refusal assigns nobody and does not move
the pointer.

### Untouched, exactly

**Untouched means** the contact's owner in HubSpot is still the rep this tool wrote, and HubSpot's
"Last activity date" (`notes_last_updated`) is empty or earlier than the instant the owner was
written. HubSpot sets that date when a note, call, email, meeting or task is logged on the contact.
So a rep who logs anything has touched it, and the clock stops. A person who changes the owner in
HubSpot stops it too, and the tool never fights them. A rep who replies from their own inbox without
logging it in HubSpot reads as untouched. When every rep in the pool has had the lead, it stays with
the last one and parks as `NO_REP_RESPONDED` for a person to decide. A parked lead is read and
listed again on every tick (and in `--plan`), and the tick exits 4, until a person gives it an owner,
logs activity on it, or deletes the contact in HubSpot.

### Why a crash cannot skip a rep, assign twice or post twice

Every tick writes to an append-only, hash-chained journal (`runs/inbound/journal.jsonl`): an intent
line before each call, a result line after it. The line that claims a lead for a rep also moves the
pointer. So after a crash the next tick knows which rep the lead belongs to, whether HubSpot was
written, and whether a Slack post might exist. It finishes the same attempt for the same rep. A
re-delivered event (the same signal id) assigns nothing. HubSpot is always written before Slack, so a
rep is never told about a lead they do not own. A post whose outcome is unknown is looked up by the
marker every message carries before anything is posted again; if Slack cannot be asked, the lead
parks as `SLACK_UNCONFIRMED` and it never posts twice on a guess. The only repost is after Slack
refused the post (an answer that proves nothing was posted) or after Slack's history, when asked,
did not show the marker. That lookup reads the newest 200 messages of the rep's DM from the attempt's
instant on, so a post buried under 200 later messages in the same minute would be posted again. Two
ticks never run at once on one state directory (see "One tick at a time"). A test crashes the tick at
every journal line, whole and torn, and checks all three properties after recovery.

### Live

```console
$ export SIGNAL_DESK_HUBSPOT_TOKEN=...   # private app: crm.objects.contacts.read, crm.objects.contacts.write
$ export SIGNAL_DESK_SLACK_TOKEN=...     # bot: chat:write, im:write, im:history
$ node bin/signal-desk.mjs inbound --live --plan
$ node bin/signal-desk.mjs inbound --live
```

**On the first live run, contacts that already have an owner are left alone.** Before writing, the
tool reads the contact; if it has an owner the tool did not write, it writes nothing, tells nobody,
gives the rep their turn back, and prints `ALREADY_OWNED` with the owner it found. Set
`"overwrite_owner": true` in the rotation file only if you want the rotation to take those leads
over. `--plan` prints this rule next to every write it would make.

`inbound --live --plan` needs no token, contacts nothing and writes nothing. It runs the tick itself
against adapters that call nothing, so it lists the calls in the order the tick makes them, with
method and URL, and for a lead past its window the read it would make and who would get the lead. A
clock read's answer is only known to HubSpot, so the plan assumes the answer that makes the most
calls (untouched, so reassigned) and its "At most N HTTP call(s)" is an upper bound, which it says;
a lead it shows refused for want of a free rep is listed as one that may be assigned if an earlier
answer frees one. Without either token, `--live` refuses
(`INBOUND_HUBSPOT_TOKEN_MISSING`, `INBOUND_SLACK_TOKEN_MISSING`) before reading a file. Without a
rotation file it refuses `ROTATION_CONFIG_MISSING`; live never falls back to the synthetic reps.
`--at` is refused in live mode, which reads real time. Run `inbound --live` on a schedule (cron, a
launchd job) to move the clock; each run is one tick.

### If the journal was cut short

Next to the journal sits `journal.head`, the number of lines and the last hash, written after every
append. A journal that has lost lines from its end (a restore from an older backup, a disk problem,
a hand edit) no longer matches it, and `inbound` refuses `JOURNAL_HEAD_MISMATCH`, exit 1, calling
nothing. If you know why, run the same command again with `--recover`. It accepts the journal as it
is and, on that tick, looks for every Slack post by its marker before making it, so no rep is told
twice; a lead whose owner was in the lost lines and would now go to someone else meets that owner in
HubSpot and parks as `ALREADY_OWNED`. `--recover` needs the Slack token's `im:history` scope, the same
one every live tick needs. A trailing blank line left by an editor is not a mismatch.

### Exit codes, for a scheduled run

| Exit | Means |
|---|---|
| 0 | the tick ran and nothing needs a person |
| 1 | the journal was refused (`JOURNAL_TAMPERED`, `JOURNAL_HEAD_MISMATCH`); nothing was called |
| 2 | refused before the tick: a flag, a token, `SLACK_SCOPE_MISSING`, the rotation file, or no run; nothing was written |
| 3 | `INBOUND_LOCKED`, another tick is running; nothing was written |
| 4 | the tick ran, and at least one lead is `CRM_PENDING`, `SLACK_PENDING`, `SLACK_UNCONFIRMED`, `CLOCK_CHECK_FAILED`, `REFUSED` or `NO_REP_RESPONDED` |

Alarm on any non-zero exit. Every state behind exit 4 stays until a person acts or a later tick
succeeds, so a failing HubSpot token shows up on the next run, not weeks later.

**The Slack token needs `im:history`,** as well as `chat:write` and `im:write`. Without it a post
whose outcome is unknown can never be looked up, so the lead could never be confirmed. A live tick
checks the token's scopes first (Slack's `auth.test`, which writes nothing) and refuses
`SLACK_SCOPE_MISSING`, exit 2, before anything is written.

### One tick at a time

A tick holds an exclusive lock on its state directory (`runs/inbound/lock`, or
`runs/inbound-fixture/lock`) from before it reads the journal until after its last write. The file is
created atomically and holds the pid, host and start instant of the tick that holds it. A second
`inbound` started while one is running refuses `INBOUND_LOCKED`, names the holder, exits 3, and
writes nothing, so two overlapping cron runs cannot both claim a lead. `--plan` writes nothing and
takes no lock.

**The stale-lock rule.** A lock is stale only if its host is this machine and its pid is no longer
running. The next tick then removes it and says so (`lock  removed a stale lock left by pid ...`).
Removing it takes a second exclusive file, `lock.break`, and re-reads the lock while holding it, so
only the stale lock that was judged is ever removed and two live ticks can never both get in. A lock
from another host, or a pid that is running (even if it is an unrelated process that reused the pid),
is never removed automatically. If you are sure no tick is running, delete the `lock` file (and a
`lock.break` left by a crash during a break) yourself.

Tokens stay inside the adapters. They are never printed, logged or written to the run directory, and
upstream error text is scrubbed before it is recorded. In Slack, payload text only appears in
`plain_text` blocks, so a company named `<!channel>` pings nobody.

**What was verified live, and what was not.** The engine and the HubSpot adapter ran against a HubSpot
developer test portal on 2026-11-16, with the fake Slack: two leads created and owned, a re-run that
assigned nothing and created no duplicate, a crash between the HubSpot write and its journal line
recovered with the same contact, a logged note stopping one lead's clock (`TOUCHED`) and the other
lead reassigned after the window (`REASSIGNED`). That portal has one owner, so both reps in the test
rotation mapped to it and the reassignment rewrote the same owner id. Every test record was deleted.
The live Slack post was not run; there was no Slack workspace for it, so the Slack adapter is tested
against a fake transport only.

### What HubSpot Free and Starter cannot do for this job (read 2026-11-16)

- **No native rotation.** HubSpot's "Rotate record to owner" workflow action needs a Sales Hub or
  Service Hub Professional or Enterprise subscription, and workflows themselves need Professional or
  Enterprise. On Free and Starter the rotation has to live outside HubSpot, which is what this is.
  https://knowledge.hubspot.com/workflows/assign-and-rotate-record-owners-using-workflows (page
  last updated October 26, 2026).
- **A tighter rate limit.** Private apps on Free and Starter get 100 requests per 10 seconds and
  250,000 per day per account (Professional gets 190 and 625,000). The CRM search API has its own
  stricter limits and sends no rate-limit headers, so this reads and updates contacts by email
  (`idProperty=email`) and never searches. A tick makes at most five HubSpot calls per lead (a
  clock read, then read, create, read again and owner write when it assigns).
  https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines.md
- **Batch upsert by email cannot do a partial update**, which is why this updates one contact at a
  time. https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/guide
- "Last activity date" is "the most recent already past date and time a note, call, [...] was logged
  on the contact record."
  https://knowledge.hubspot.com/properties/hubspots-default-contact-properties (page last updated
  September 21, 2026).

The spec, with every crash point and the prior art it was checked against, is `docs/INBOUND-SPEC.md`.

## What this milestone is

M1 built the kernel, the stage contract, the hash-chained ledger, all eight stages end to end in
fixture mode, and `run`, `explain` and `replay`.

M2 was the depth: the three-part gate, the approval queue and its `queue`, `approve` and
`reject` verbs, the adapter contract with a second conforming adapter, and a terminal seal that
makes a truncated ledger detectable. It also decided the identity model M1 left unowned, which
is why a second signal for one person is refused rather than doubling the motion.

M3 is the surface and the suite. The `dashboard` verb and its self-contained HTML page. The four
hostile fixtures the design still owed: a wrong-person match, a decayed record, a prompt
injection in a scraped page, and a company that does not exist. The mechanisms three of them
needed, in the stage that owns each. And a test that checks the design's hostile list against
the reason codes the demo actually produces, so the list cannot quietly stop being complete.

One of those four needed no new rule at all. The hallucination-bait lead is caught by a
discipline M1 built and no fixture had ever reached, and finding that out was worth more than
another gate would have been.

M4 is live mode: real HTTPS enrichment, real LLM drafting and judging, HMAC over raw bytes, the
dead-letter queue M1 registered as absent, and a capture that makes a live run replayable offline.
It opened by closing three findings the M3 review left, each before any live data could reach the
code they governed: a fieldless identity record used to read as CONFIRMED, a source could assert
any freshness it liked, and a hostile span quoted into the ledger could smuggle a third party's
data past the redaction rule.

Deliberately not here. No HTTP server, argued rather than deferred. Sending is non-scope in every
milestone, and approving from the dashboard is non-scope permanently rather than pending.

The M1 limitation that a test used to pin is closed, and the test was flipped rather than
deleted. See `test/adversarial.test.mjs`.

## Tests

```console
$ npm test
```

Zero runtime dependencies and zero dev dependencies. The suite is the node built-in test
runner, and it covers four families the design calls for.

Stage-contract conformance applies one harness to every stage, so a ninth stage is covered for
free. Golden-ledger regression pins the fixture run's ledger as a committed file, so any
behaviour drift shows up as a diff on the decisions. Adversarial tests prove the hostile
fixtures refuse with the expected reason codes. And a determinism test proves two runs produce
identical bytes.

If you change behaviour on purpose, regenerate the golden file in the same commit.

```console
$ npm run golden:update
```

The fixture corpus is generated too, and a test compares the committed files against the
generator, so a hand-edited signal with a stale signature fails the suite.

```console
$ node scripts/make-fixtures.mjs
```

## Design

`docs/DESIGN.md` is the approved design. `docs/M4-SPEC.md` is what this milestone built, including
the two transport seams, the recordings-in-the-run-id decision, the DLQ boundary and the
no-server argument. `docs/M3-SPEC.md` is the milestone before it,
carrying the stage-ownership argument for each hostile catch, the dashboard's contract and its
escaping rule. `docs/M2-SPEC.md` and `docs/M1-SPEC.md` are the earlier ones, each with its own
addendum on what the implementation taught.
`docs/ADAPTERS.md` is the sender adapter contract. `docs/LEAD-CEILING-SPEC.md` is the per-run lead
ceiling on live mode. `docs/INBOUND-SPEC.md` is the inbound last mile.

### Known boundaries

Named here rather than left to be discovered, and each one pinned by a test that fails if
somebody closes it.

- **The ledger chain is unkeyed.** It proves order and integrity, and the terminal seal proves
  completeness. None of that proves authenticity: anyone who can run this code can regenerate a
  ledger from scratch and produce a chain and seal that verify. What catches that is
  re-execution, which is why `replay` compares bytes as a separate check. A signing key would
  close it and would make this a hosted-secret tool, which it deliberately is not.
- **PII detection is ASCII, after NFKC normalisation.** Fullwidth and other compatibility forms
  are folded and caught. A homoglyph sitting directly against an `@` is not; that needs a
  Unicode confusables table.
- **Approvals do not expire.** A decision binds to a draft hash forever. Nothing re-asks after a
  week, and a draft that still hashes the same is still authorised. As of M3 this is pinned by a
  tripwire test rather than merely written down here, because until then adding an expiry window
  would have failed nothing.
- **Identity evidence is checked when it exists, and its absence is not a refusal.** A source
  that cannot answer leaves the lead `IDENTITY_UNVERIFIED`, and the pipeline will still write to
  a person no source confirmed. Absence never reads as confirmation, which is the property that
  matters, but an unverified identity is not a verified one.
- **The injection rule is lexical and deterministic, which bounds what it can catch.** In live mode
  it is now doing real work — there is a model in the drafting path — and it works by pattern, so a
  payload phrased in a way none of its patterns match will not be flagged. What stands behind it is
  the claim-grounding gate, which does not care how a sentence was induced: an assertion with no
  cited claim behind it is refused whatever talked the model into writing it. The prompt fence is
  defence in depth and is not load-bearing.
- **Deduplication is per run.** A lead processed on Monday can be processed again on Friday.
