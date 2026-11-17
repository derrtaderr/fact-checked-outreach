---
name: signal-desk inbound last mile spec (row 157)
read_by: the lane that builds the inbound verb, and any later session touching src/inbound/, the inbound verb in src/cli.mjs, the rotation config, or the HubSpot and Slack adapters. The README's "Inbound last mile" section is the user-facing half of this file.
date: 2026-11-16
status: spec, written before the code existed
---

# Inbound last mile: an owner in HubSpot, the rep told in Slack, a response clock

## What this adds

A new verb, `inbound`, that takes leads the pipeline has already enriched, scored, routed, drafted,
gated and had approved, and does three things with each one.

1. Assigns an owner from a stored rotation pointer and writes it to the HubSpot contact as
   `hubspot_owner_id`, creating the contact if it does not exist and never creating a duplicate.
2. Posts a Slack message to that rep carrying the brief and the checked draft.
3. Runs a response clock. When a lead is still untouched N minutes after its rep was told, it is
   reassigned to the next rep in the rotation and that rep's Slack message says it was reassigned
   and from whom.

Nothing is sent to the prospect. The draft goes to the rep, who decides whether to send it. That keeps
`docs/DESIGN.md`'s non-scope ("No sending") intact: the new calls write an owner on a CRM record and
tell a colleague, and neither reaches the person the draft is addressed to.

## Prior art, checked 2026-11-16

| Prior art | What it does | How this differs |
|---|---|---|
| Router.so (384 stars, AGPL) | Hosted lead routing and round robin | Not read and not copied, because of the license. This is a CLI with no server, and its claim is crash recovery and replay of the rotation, which is the part routers do not show |
| Free n8n templates | Webhook to round robin to CRM owner to Slack | The round-robin pointer is workflow static data with no crash story. A re-delivered webhook assigns again |
| RevenueHero (paid) | Inbound routing, scheduling, reassignment | Paid and hosted. This is free, local and inspectable |
| HubSpot "Rotate record to owner" | Native rotation inside workflows | Needs Sales Hub or Service Hub Professional or Enterprise (sourced below). This works on Free through the API |
| Jason's `rb2b-router` | A webhook router | No owner assignment, no clock |

No open PR or branch in this repo carries this work (`gh pr list --state all`, 8 PRs, all merged,
none inbound).

## Baseline

`npm test` on `9698f5e`: exit 0, 945 tests, 944 pass, 0 fail, 1 skipped (the keyed smoke test). The
golden ledger pins the fixture run only. `inbound` does not run the kernel and does not change
`run`, so no golden moves. If one does, that is a bug.

## Input: which leads `inbound` takes

**Decision: leads that reached handoff, which means a human approved that exact draft hash.** The
row says "drafted". This repo's one invariant is that nothing acts on a draft a human has not
approved, bound to its content hash, and handoff is the only stage that re-checks that binding. A
lead parked in the queue has passed the gate but nobody has read it. Sending it to a CRM and a rep
before approval would make `inbound` the first path in the repo that acts without a human. So the
input is the `dry-run-json` handoff artifacts of the latest run (`runs/<run>/handoffs/*.json`).
An artifact in another format (`eml`) is refused by name, `HANDOFF_FORMAT_UNSUPPORTED`. **Divergence
from the row, open question for Jason:** if inbound speed matters more than the approval gate, the
alternative is to take parked leads too. That changes what the approval queue means, so it is not
built here.

The idempotency key is the signal id, read from the run ledger's ingest PASS entry for that lead
(`evidence_refs` holds `signal:<id>`, a field, not prose). A lead with no ingest entry is refused,
`SIGNAL_ID_UNKNOWN`. A re-delivered event (the same signal id in a later run) is recognised and
nothing is assigned twice. A different signal id for a lead that already has an open assignment is
skipped too, `LEAD_ALREADY_ASSIGNED`, so a person re-signalled under a new id does not take a second
rep's turn.

## The rotation

A JSON file, `--rotation <path>` (default `./inbound.json`). In fixture mode the default is the
committed `fixtures/inbound-rotation.json`, synthetic reps only.

```json
{
  "response_minutes": 30,
  "pools": {
    "ae-round-robin": [
      { "id": "rep-ana", "hubspot_owner_id": "1001", "slack_user_id": "U0001", "capacity": 5 },
      { "id": "rep-ben", "hubspot_owner_id": "1002", "slack_user_id": "U0002", "away": true }
    ]
  }
}
```

The pool is the route band's `owner` (`ae-round-robin`, `sdr-queue` in the default config), so the
existing routing decides which rotation a lead joins.

- **The pointer is the id of the last rep assigned in that pool**, kept in the journal, never an
  index. The next rep is the one after it in the current list. Stored as an id so reordering or
  removing reps in the file cannot silently shift every later turn. If the last rep was removed,
  the turn restarts at the top of the list and the run says so.
- **Skips.** `away: true` skips a rep. `capacity: n` skips a rep who already holds n open
  assignments. Open means assigned and neither touched nor taken over. A skipped rep does not lose
  their turn order, they are passed over this time.
- **Refusals, which assign nobody and do not move the pointer.** No pool for the lead's band,
  `NO_ROTATION_FOR_POOL`. An empty pool, `ROTATION_EMPTY`. Every rep skipped, `NO_ELIGIBLE_REP`,
  naming each rep and why. A malformed file, `ROTATION_CONFIG_INVALID`, naming what is wrong, before
  anything is read or called.

## The journal, and why a crash cannot skip, double-assign or double-post

State lives in one append-only, hash-chained JSONL file, `runs/inbound/journal.jsonl` for live and
`runs/inbound-fixture/journal.jsonl` for fixture mode, so a demo never touches live state. Every
line records the instant it was written (`at`). State is a pure fold of the journal.

**The rule: write the intent line before the side effect, and the result line after it.**

| Line | Written | Means |
|---|---|---|
| `claim` | before any call | this attempt belongs to rep R; also moves the pool's pointer, in the same line |
| `crm_written` | after HubSpot answered OK | the contact exists and its owner is R |
| `crm_failed` | after HubSpot refused or was unreachable | nothing posted; the next tick retries the write for R |
| `slack_attempt` | before the post | a post may now exist |
| `slack_posted` | after Slack said ok | the rep was told; the clock starts |
| `slack_failed` | after Slack answered `ok: false` | nothing was posted; safe to post again |
| `touched` / `owner_changed` | at a clock check | the clock stops |
| `exhausted` | at a clock check | every rep had a turn; parked for a human, `NO_REP_RESPONDED` |
| `released` | on resuming an attempt | the claimed rep is no longer in the lead's pool; the claim is let go with the reason, and the lead is claimed again from the rotation as it is now |

What each crash point leaves, and what the next run does.

- **Before or during the `claim` append.** No line, so no side effect began. The lead is new again
  and gets the same rep, because the pointer did not move. A torn final line (a crash mid-write) is
  removed on load and reported, because the call it announced had not started.
- **After `claim`, before HubSpot answered.** The claim names the rep. The next run re-does the
  write for that same rep, never re-picks, so no rep is skipped and none gets two turns. It reads
  that rep's `hubspot_owner_id` and `slack_user_id` from the rotation file as it is at that run, not
  as they were at the claim, so correcting a typo in the file heals the retry; the ids actually used
  are journaled on `crm_written` and `slack_attempt`, and the clock compares HubSpot with the owner
  written. If the rep has left the pool, the claim is `released` with the reason and the lead is
  claimed again from the current rotation (or waits, `REASSIGN_WAITING`, if nobody can take it). The write is
  idempotent: read the contact by email first (`GET .../contacts/{email}?idProperty=email`); on 404
  create it; on 409 (created by the attempt that crashed) read again. A found contact gets the owner
  (`PATCH .../contacts/{email}?idProperty=email`) only if it has none, has one this tool wrote for
  this lead, or `overwrite_owner` is set; see "An owner the tool did not write". There is never a second
  contact.
- **After `crm_written`, before Slack.** The owner is set, so the lead is never ownerless. The next
  run posts.
- **After `slack_attempt`, outcome unknown** (a crash, a timeout, a dropped connection). The post may
  or may not exist. Every message carries a marker, `signal-desk-` and the first 24 hex characters of
  the SHA-256 of the key and the attempt. It is in `[a-z0-9-]` only, so Slack's escaping of `&`, `<`
  and `>` cannot change it and the bytes sent are the bytes searched, whatever the signal id holds.
  It comes first in the notification text, which `find` searches. The next run asks
  Slack for a message carrying that marker. Found means record it, not found means post. If Slack
  cannot be asked, the lead parks as `SLACK_UNCONFIRMED` and nothing is posted, because guessing
  either way is either a double post or a rep never told. It never posts twice.
- **HubSpot refuses or is down.** `crm_failed`, no Slack post, reported as `CRM_PENDING` (and for a
  refusal that repeats until a person acts, `HUBSPOT_INVALID_OWNER` or a token problem, the output
  names what to fix rather than promising the retry works), retried on
  the next run for the same rep. The order HubSpot first, then Slack, is what makes "the rep was told
  about a lead they do not own" impossible.

**The head file.** The chain proves no line was edited, not that none was removed from the end. So
`journal.head` holds the line count and the last hash, written after every append (the append is
fsynced; the head goes to a temp file, is fsynced, renamed over, and the directory fsynced). A
journal that disagrees with it is refused, `JOURNAL_HEAD_MISMATCH`, exit 1, nothing called; the one
disagreement a crash makes, the journal exactly one line ahead and chained to the head's hash, is
accepted and the head brought up to date. Blank lines (an editor's save) are skipped. The way out,
`inbound --recover`, accepts the journal as it is and runs that tick with every Slack post looked for
by marker first, found or not; a lead the lost lines had given to a rep the rotation no longer picks
meets that rep's owner in HubSpot and parks `ALREADY_OWNED`. Nothing is reposted.

A journal whose chain is broken anywhere but a torn final line is refused, `JOURNAL_TAMPERED`, and
nothing is called.

## An owner the tool did not write

By default the tool never replaces a HubSpot owner it did not write. Before writing, it reads the
contact. If the contact already has an owner and that owner is not one this tool wrote for this lead
(the claim's, or a previous attempt's), nothing is written, nobody is told, the claim's turn is given
back (the pointer returns to where it was, unless the pool has moved on since), and the lead parks as
`ALREADY_OWNED` with the owner it found. A person decided that lead; the tool does not fight them,
the same rule as `owner_changed` at a clock check.

Opt in to replacing such owners with `"overwrite_owner": true` at the top of the rotation file.
HubSpot has no conditional update, so a person who sets an owner between the read and the write can
still be overwritten; the window is one round trip.

## One tick at a time

The journal survives a crash, not a second writer. Two processes that both read it before either
appends both claim, both post, and leave two lines chained to one head. So a tick takes an exclusive
lock on its state directory (`<state>/lock`, created with `O_CREAT|O_EXCL`, holding pid, host and
start instant) before it opens the journal, and releases it after its last write, the fixture fakes'
files included. A second process refuses `INBOUND_LOCKED`, exit 3, before reading or writing anything.
`--plan` takes no lock because it writes nothing.

Stale rule: a lock is stale only when its host is this host and its pid is not running. The breaker
takes a second exclusive file, `<state>/lock.break`, re-reads the lock while holding it, and removes
it only if it is still the same stale holder; then it creates its own lock with `O_EXCL` like any
other process. Only a breaker can remove a lock whose holder is dead, so the lock removed is always
the stale one judged, and a process that starts in between wins the create while the breaker
refuses. A reused pid reads as live (the safe direction). Another host's lock, and a `lock.break`
left by a crash mid-break, are never broken automatically; the refusal names the file for a person.

## The clock

The engine takes an injected clock, the same shape as the run clock (`now()`). Each `inbound`
invocation is one tick: it finishes interrupted attempts first, then takes new leads, then checks
every open assignment against its clock. Live mode reads real time. Fixture mode takes `--at <instant>`, so the demo and the tests
can say "45 minutes later" without waiting. `--at` is refused in live mode, because a live clock that
can be typed is a clock that can be lied to.

**Untouched, defined from something observable.** At a check, the engine reads the contact from
HubSpot (`GET .../contacts/{email}?idProperty=email&properties=hubspot_owner_id,notes_last_updated`).

- If `hubspot_owner_id` is no longer the owner this attempt wrote, a person reassigned it in
  HubSpot. The clock stops (`owner_changed`) and the engine never fights a human.
- Else, if `notes_last_updated` (HubSpot's "Last activity date") is at or after the instant the
  owner was written, the rep logged a note, call, email, meeting or task. The clock stops
  (`touched`).
- Else, if the window has passed since the rep was told (`slack_posted`), the lead is untouched and
  is reassigned to the next eligible rep who has not had it yet. If every rep has had it, it parks
  for a human, `NO_REP_RESPONDED`. If the lead's pool is missing from the rotation file or empty, that
  is not "every rep had it": the lead waits as `REASSIGN_WAITING` with `NO_ROTATION_FOR_POOL` or
  `ROTATION_EMPTY`, nothing is journaled, and it resumes when the pool returns.

`notes_last_updated` is computed by HubSpot, asynchronously, from the activity's own timestamp. Live
check on the test portal: a note logged through the API moved it within 8 seconds. A rep who acts
outside HubSpot (a reply from their own inbox that is not logged) reads as untouched. The README says
so.

**Replayable.** The journal records every instant used. The state at any point is a fold of the
journal, and given the same journal, the same instant and the same HubSpot reads, the engine makes
the same decision. Tests drive it with the fakes and a scripted clock.

## Adapters

Interfaces, each with a fake. Tests never touch the network.

- `hubspot.assign({ email, ownerId, properties }) -> { contactId, created }`
- `hubspot.read({ email }) -> { contactId, ownerId, lastActivityAt } | null`
- `slack.post({ channel, text, blocks, marker }) -> { ts }`
- `slack.find({ channel, marker, oldest }) -> { ts } | null`

The live adapters take a transport as a required argument with no default, like the live fetcher.
`src/cli.mjs` stays the only module that imports `node-transport.mjs`. Each call has a timeout and
is not retried inside the adapter: the next tick is the retry, and the journal says exactly where it
resumes. Any failure after the request may have left (a dropped connection, a timeout, a 5xx, or a
200 whose body cannot be read) is `ambiguous`: for Slack it goes through find-before-repost, never
straight to a second post. The engine treats any error from `slack.post` that is not a named,
unambiguous refusal (`SLACK_REJECTED`, `SLACK_RATE_LIMITED`) the same way. Errors carry a named code: `HUBSPOT_UNAUTHORIZED`, `HUBSPOT_SCOPE_MISSING`,
`HUBSPOT_INVALID_OWNER`, `HUBSPOT_RATE_LIMITED`, `HUBSPOT_UNAVAILABLE`, `SLACK_REJECTED`,
`SLACK_UNREACHABLE`.

Slack: `chat.postMessage` to the rep's user id (a DM from the app), and for `find`,
`conversations.open` then `conversations.history`. Scopes needed: `chat:write`, `im:write`,
`im:history`. No Slack webhook exists for this lane, so the live Slack adapter is tested against a
fake transport only and the live post is NOT RUN.

## Live mode and `--plan`

`inbound --live` needs `SIGNAL_DESK_HUBSPOT_TOKEN` and `SIGNAL_DESK_SLACK_TOKEN`, both checked before
any file is read or any call made (`INBOUND_HUBSPOT_TOKEN_MISSING`, `INBOUND_SLACK_TOKEN_MISSING`),
and a rotation file (`ROTATION_CONFIG_MISSING`; live never falls back to the synthetic reps).
`inbound --live --plan` needs no token, contacts nothing, writes nothing, and takes no lock. It is
the engine's own tick, run on an in-memory copy of the journal against adapters that call nothing and
record what they are asked (`src/inbound/plan.mjs`), so its order, capacity and pointer are the
tick's own. It prints each call with method and URL, grouped by lead. Some calls depend on answers
only HubSpot and Slack can give, so the adapters answer the way that makes the most calls: every
write succeeds, every lead past its window reads as untouched (and is reassigned), and an earlier
post is not found. Any other answer makes fewer calls for that lead, but can free a rep (a touched
lead, or one a person owns, stops counting against capacity), so a lead the plan shows refused
`NO_ELIGIBLE_REP` is also listed as one that may be assigned after all. The total it prints, "At most
N HTTP call(s)", counts each assignment at its most requests (read, create, read again, owner write)
and is an upper bound on the tick that follows; when every answer is as assumed, the list of
operations is exactly the tick's (`test/inbound-plan-parity.test.mjs`, 150 generated scenarios).

Nothing in this verb bills per use. HubSpot and Slack calls are rate-limited, not metered, so the
kernel's billing mark does not apply and none is added. The verb makes at most five HubSpot calls
(a clock read, then read, create, read again and owner write) and three Slack calls (open, history,
post) per lead per tick, and `--plan` prints the bound for the tick it previews.

## Escaping and secrets

- Length. Every block field is capped at Slack's section limit, "maximum length is 3000 characters"
  (https://docs.slack.dev/reference/block-kit/blocks/section-block), and the notification text below
  chat.postMessage's "limit the `text` field to 4,000 characters"
  (https://docs.slack.dev/reference/methods/chat.postMessage), at 3,900. Both read 2026-11-16. The
  marker comes first in the text and stands alone in its context element, so a cut never drops it.
- Every payload-derived value printed to the terminal goes through `printable` in
  `src/terminal.mjs`.
- In Slack, payload text only ever appears in `plain_text` block objects, which Slack renders without
  formatting, links or mentions, and in the notification fallback with `&`, `<` and `>` escaped and
  control characters made visible. A company called `<!channel>` pings nobody.
- Tokens live in the adapters' closures. They are never in the journal, the run directory, stdout or
  stderr. Upstream error text passes through the repo's `secretScrubber` before it is recorded. A test
  plants a canary token that a fake HubSpot echoes back in its 401 body and asserts it appears
  nowhere.

## HubSpot tier facts for this job (read 2026-11-16)

From HubSpot's own documentation, not from memory.

1. The native rotation, the workflow action "Rotate record to owner", needs a Sales Hub or Service Hub
   Professional or Enterprise subscription, and workflows themselves need Professional or Enterprise.
   Free and Starter cannot rotate owners natively, so the rotation has to live outside HubSpot, which
   is what this builds. https://knowledge.hubspot.com/workflows/assign-and-rotate-record-owners-using-workflows
   (page "Last updated: October 26, 2026").
2. Private-app rate limits on Free and Starter (any Hub): 100 requests per 10 seconds per app, 250,000
   per account per day. Professional is 190 and 625,000. The CRM search API has its own stricter
   limits and returns no rate-limit headers, which is one reason this uses read and update by email
   (`idProperty=email`) instead of search.
   https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines.md
3. Contacts are read and updated by email with `idProperty=email`; batch upsert by email does not
   support partial upserts. https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/guide
4. "Last activity date" (`notes_last_updated`) is "the most recent already past date and time a note,
   call, [...] was logged on the contact record". "Owner assigned date" is "the most recent timestamp
   of when an owner was assigned to the contact".
   https://knowledge.hubspot.com/properties/hubspots-default-contact-properties (page "Last updated:
   September 21, 2026").

Observed on the developer test portal 247782316 (account type DEVELOPER_TEST, so not proof of what a
paid Free portal allows): the private-app token's scopes include `crm.objects.contacts.read`,
`crm.objects.contacts.write` and `crm.objects.owners.read`; update by email, create, 409 on a
duplicate create, 400 `INVALID_OWNER_ID` for an owner that does not exist, and `notes_last_updated`
moving after a logged note all behaved as described above.

## Gate commands

| Area | Command | Passing looks like |
|---|---|---|
| Whole suite | `npm test` | exit 0, 944 old passes still passing, 1 skipped, new tests added |
| Inbound units | `node --test test/inbound-*.test.mjs` | exit 0 |
| Network gate | `node --test test/no-network.test.mjs` | exit 0, `src/cli.mjs` still the only importer of node-transport |
| Docs freshness | `node --test test/docs-row80.test.mjs test/docs-inbound.test.mjs` | exit 0, system map cites still on their lines |
| System map | `node ~/Projects/system-map/bin/system-map.mjs reconcile .` | its verdict, reported as-is |

## Divergences from the row

1. Input is approved handoffs, not every drafted lead (argued above; open question).
2. Untouched is HubSpot's Last activity date or an owner change, not a recorded acknowledgment. One
   observable source instead of two.
3. A reassignment cycle ends after every rep in the pool has had the lead once, parking it as
   `NO_REP_RESPONDED`, so the clock cannot loop forever.
4. The live Slack post is not run (no webhook or token for this lane).
