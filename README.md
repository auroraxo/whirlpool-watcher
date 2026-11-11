# whirlpool-watcher

A **real, out-of-tree consumer** of the [reeflog](https://github.com/auroraxo/reeflog)
event mailbox: it watches Orca Whirlpool swaps (`whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`)
and turns them into a durable fill ledger — **without making a single RPC call of its own**.

```
               reeflog daemon                this repository
mainnet WS ──▶ journal (SQLite) ──tail──▶    decode `Traded` ──▶ fills.json (ledger)
                                └──webhook─▶ HMAC verify ──────▶ fills.json (ledger)
                                └──reorg tail▶ undo ───────────▶ fills.json (retractions)
```

It links **no reeflog code**: it spawns the `reeflog` CLI and consumes its published
output (the tail contract), or receives signed HTTP deliveries (the webhook contract).
The event layout was decoded independently, from live mainnet data — see
[Where the decoder comes from](#where-the-decoder-comes-from).

## Why it exists

reeflog's own qualification list ends at: *"user zero — my own RFQ fill polling and
Whirlpool watcher on `reeflog tail` … the production glue still polls, so user zero is
earned, not assumed."* This repository is that Whirlpool watcher, as a separate
repository with its own contract, so the mailbox is proven by a consumer that reeflog's
test harness cannot accidentally satisfy.

## Usage

```bash
# 1. tail mode — pull fills from a local reeflog journal
node src/cli.mjs tail --db /path/reeflog.db --cursor /tmp/ww-cursor.txt \
     --ledger /tmp/ww-fills.json --bin /path/to/reeflog

# 2. retract mode — join the reorg channel against what THIS consumer read
node src/cli.mjs retract --db /path/reeflog.db --cursor /tmp/ww-reorg-cursor.txt \
     --ledger /tmp/ww-fills.json --bin /path/to/reeflog

# 3. webhook mode — receive signed deliveries over HTTP
node src/cli.mjs webhook --port 8787 --secret whsec_... --ledger /tmp/ww-fills.json
```

Point reeflog at it:

```bash
cat > webhooks.json <<'EOF'
{ "targets": [ { "id": "whirlpool-watcher", "url": "http://127.0.0.1:8787/hook",
                "secret": "whsec_...", "timeout_ms": 5000 } ] }
EOF
reeflog start --db reeflog.db --webhook-config webhooks.json --webhook-every 5
```

Exit codes follow reeflog's discipline: `0` complete, `2` the consumer could
not run at all (a missing mailbox binary), `3` something is owed or refused
(pending payloads, unverifiable events, a mailbox that refused) — silence is
never health. The report's `verdict` field is the **mailbox's** verdict,
carried: `COMPLETE` (reeflog exit 0), `OWED` (exit 3), `REFUSED` (any other
exit, e.g. reeflog's named refusals exit 1), `UNAVAILABLE` (the mailbox never
ran) — see "The mailbox verdict is carried, never stamped" below.

## What a fill looks like

```json
{
  "signature": "65MbpjcSFqAaBzc8v2eKx31ZeKxqVtR7saokLZN6R3KD6SpXP624Xdj6dVsWDYdLiVnPBoqE1bjf5HVXLsw3bA86",
  "seq": 118,
  "slot": 463755812,
  "pool": "55BrDTCLWayM16GwrMEQU57o4PTm6ceF9wavSdNZcEiy",
  "a_to_b": true,
  "input": "1133",
  "output": "876795",
  "input_transfer_fee": "0",
  "output_transfer_fee": "0",
  "lp_fee": "1",
  "protocol_fee": "0",
  "pre_sqrt_price": "513388739522206142214",
  "post_sqrt_price": "513387192657098477077"
}
```

Amounts are exact strings: a u64 does not fit a JSON number without losing digits.

## Where the decoder comes from

The `Traded` event layout (`whirlpool, a_to_b, pre_sqrt_price, post_sqrt_price,
input_amount, output_amount, input_transfer_fee, output_transfer_fee, lp_fee,
protocol_fee` — borsh, 121 bytes with the 8-byte Anchor discriminator
`sha256("event:Traded")[0..8] = e1ca49af932ba096`) was **not guessed**:

- it is declared in `orca-whirlpools-recon/programs/whirlpool/src/events.rs`,
- and it was verified against **live mainnet**: real swap transactions carry
  `Program data: 4cpJr5MroJYz…` whose first 8 bytes decode to exactly that hex,
- and the decoded amounts were matched against the same transaction's
  `pre/postTokenBalances` (see the fixtures in `test/fixtures.json`).

A line that is not a `Traded` event decodes to `other` (never a guessed fill); a
`Traded` line with the wrong length decodes to `invalid` and is **reported** in the
ledger, never dropped.

## Ledger durability (the consumer-side contract)

reeflog closes, release by release, every way a cursor or report can collapse a
failure into "delivered" behind a healthy exit. This consumer holds the **same
contract on its side of the mailbox** — a fill delivered by the mailbox is
never lost:

- **Refuses corrupt history (never swallows)**: a corrupt ledger file (torn
  write, truncated JSON) is refused (`exit 3`), named, and left byte-identical
  on disk. A fresh run does not quietly start from an empty ledger and does not
  report `COMPLETE` over destroyed history.
- **Pre-spawn writability check**: `watchTail` verifies the ledger directory
  is writable **before** invoking `reeflog tail`. Because the mailbox advances
  its cursor when it prints rows, discovering an unwritable storage only after
  the spawn would permanently consume the rows without recording them; the
  pre-check keeps the cursor untouched so the mailbox redelivers.
- **Atomic fsync swap**: `saveLedger` stages into a sibling `.tmp` file, flushes
  it to disk with `fsync`, and renames atomically over the target path, followed
  by a best-effort directory fsync. A failed save leaves the existing ledger
  untouched.
- **Park on consumed refusal**: if a failure hits *after* the mailbox delivered
  (the narrow window where the cursor already advanced), delivered rows are
  parked in an OS-temp rescue file named in the refusal, and `node src/cli.mjs
  rescue --file <path> --ledger <ledger>` replays them without an RPC call.
- **Webhook refuses 503 (never 200)**: a corrupt or unwritable ledger on the
  webhook path answers `503` so reeflog classifies the delivery transient and
  holds the queue; answering 200 would record a delivery receipt for a fill
  that is on no disk.

Measured against the **published** `reeflog v0.7.14` linux asset (sha256 checked
against the GitHub Release API digest):

| Face | Baseline (658951c) | Fixed |
|---|---|---|
| F1: corrupt history replaced behind COMPLETE | VIOLATED (exit 0, emptied) | CLOSED (exit 3, file untouched) |
| F2: unwritable dir after cursor advanced | VIOLATED (cursor moved, rows lost) | CLOSED (refuses before spawn, cursor untouched) |
| F3 (guard): unwritable webhook holds queue | HELD (0 receipts) | HELD (0 receipts) |
| F4: webhook ACKs corrupt overwrite | VIOLATED (200 ACK, emptied) | CLOSED (503 retry, file untouched) |
| G1 (guard): missing ledger delivers clean | HELD (4 fills, exit 0) | HELD (4 fills, exit 0) |

The measurement (`tools/measure-consumer-ledger-durability.mjs`), baseline and
published artifacts (`research/consumer-ledger-durability-*.json`), and the
mutation ladder (`tools/mutation-ladder-ledger-durability.sh`, 6/6 caught) are
committed in the repository.

## Ledger concurrency (one ledger file, one instance — or refuse, never revert)

Durability without concurrency is half a contract. Two watcher instances
pointed at the SAME `--ledger` path (a cron overlap, a retry loop, a second
terminal — or one crashed instance's leftover temp file) used to destroy each
other's history in silence:

- **Fixed staging names collided**: `saveLedger` staged into `${file}.tmp` and
  the writability probe used `${file}.writability-probe` — fixed names shared
  by every instance. A second writer's rename stole the first writer's staged
  file; a foreign `.tmp` was opened with `'w'` (its bytes destroyed) and then
  renamed over the ledger.
- **The lost update**: a save never checked whether the file had changed since
  *this instance* read it. Instance A (slow mailbox) exits 0 after instance B
  (fast) already made its fills durable — A's save silently reverts the file
  to A's older view, and B's fills vanish behind two healthy reports.

The contract now:

- **Per-process staging**: the temp and probe files carry this process's pid
  (`${file}.${pid}.tmp`, `${file}.${pid}.writability-probe`); no two writers
  ever open the same temp path, and a foreign file is never adopted or
  destroyed. The same torn-write window PULS L closed for the reeflog cursor
  (O_TRUNC-then-write), closed here on the consumer side.
- **Freshness refusal, not revert**: `loadLedger` remembers the exact bytes it
  read; `saveLedger` re-reads the file and REFUSES (`exit 3`, message names
  the concurrent writer, file byte-identical) when the disk no longer matches
  this instance's view — including the absent→present case of a first run
  racing another writer's first save.
- **The named repair is a real merge — and the consumer RUNS IT ITSELF**
  (PULS O): `mergeLedger(disk, mine)` unions both instances' fills and
  retractions with the durable disk copy winning per key; retractions WIN
  over fills (a retraction is a deletion — a spread-union cannot express it,
  so the other side's disk copy must not resurrect an undone fill); the meta
  REPORTS (`failed_transactions`, `invalid_events`) are unioned by
  `(seq, signature)` instead of being clobbered by the disk spread. When a
  save hits a freshness clash, the CLI performs the repair its own refusal
  names — reload the durable copy, merge, save once — reports
  `merge_repair: "applied"` on stdout and the original refusal on stderr,
  and exits 0 with BOTH instances' fills durable. `rescue` stays the
  fallback for a repair that cannot be applied (storage broken, file gone)
  and for rows a third writer raced during the merged save; it is
  idempotent (a replayed row is counted as a duplicate, never recorded
  twice). A freshness clash is the ONLY self-repairable failure: an
  unwritable directory or a corrupt ledger is still refused, parked and
  exited 3 (503 on the webhook) — merging cannot fix a broken disk.

Measured with two REAL CLI instances racing one ledger
(`tools/measure-ledger-concurrency.mjs`):

| Face | Baseline (f604cf3) | Fixed |
|---|---|---|
| F1: two instances, one ledger (slow saves last) | VIOLATED (both exit 0, fast run's fills erased) | CLOSED (slow refuses exit 3, fills survive, rescue → 4/4) |
| F2: foreign `ledger.json.tmp` clobbered by a save | VIOLATED (renamed away) | CLOSED (bytes intact) |
| F3: foreign writability probe clobbered | VIOLATED (destroyed) | CLOSED (bytes intact) |
| F4: stale view saves over a newer file | VIOLATED (silent revert) | CLOSED (refusal, file unchanged) |
| G1 (guard): single writer delivers clean | HELD (4 fills, exit 0) | HELD (4 fills, exit 0, no residue) |

Pin: `test/ledger-concurrency.test.mjs` — 7 defect tests RED on the pre-fix
tree (f604cf3), 10/10 green after; the PULS M pins stay green (the durability
measurement still closes all faces). Mutation ladder
`tools/mutation-ladder-ledger-concurrency.sh`: 7/7 caught, tree restored
byte-identical.

## Self-repair: the refusal runs its own named repair (PULS O)

PULS N's refusal ended with "exit 3 + rows parked in an OS-temp file": the
history was only complete if a HUMAN noticed the parked file and ran
`rescue`, while the repair the refusal named (`mergeLedger`) was a library
export no CLI path could invoke. Two further defects hid in that merge:
the plain meta spread dropped every failure report only one side had, and a
retracted fill resurrected as an open fill from the other side's disk copy.

The contract now (`tools/measure-ledger-auto-repair.mjs`):

| Face | Baseline (a74594f) | Fixed |
|---|---|---|
| F1: slow tail instance over a newer ledger | VIOLATED (exit 3, 2/4 fills, 1 parked file — waits for a human) | CLOSED (exit 0, `merge_repair: "applied"`, 4/4 fills, no parked file) |
| F2: slow retract over a newer ledger | VIOLATED (exit 3; the retracted fill resurrects as open) | CLOSED (exit 0, retraction durable, never open again, other fill survives) |
| F3: merge must keep both sides' reports | VIOLATED (disk spread dropped the other side's failure/invalid reports) | CLOSED (union by `(seq, signature)`, no duplicates) |
| G1 (guard): single writer | HELD (4 fills, COMPLETE, `merge_repair: null`, no residue) | HELD |

Pin: `test/ledger-auto-merge-repair.test.mjs` — MR1/MR2/MR3 RED on the
pre-fix tree (a74594f), guards MG1/MG2/MG3 green on BOTH trees, 7/7 green
after (MR4 pins the per-key rule PULS N's G-N3 already covered; both stay
green on the pre-fix tree because that rule was never broken — their job is
to catch a regression in the REWRITTEN merge). Mutation ladder `tools/mutation-ladder-ledger-auto-repair.sh`:
6/6 caught, tree restored byte-identical. The PULS N pins stay green on
this tree (C-N7's expected end state moved from "exit 3 + rescue" to
"exit 0 + self-repair"; the library-level refusal it also asserts is
unchanged).

## The mailbox verdict is carried, never stamped (PULS P)

Everything above protects the LEDGER. This section protects the one mouth
left: the `verdict` field and the exit code of a run whose MAILBOX never
really ran. Hand-measured 2026-11-11 against the **published reeflog v0.7.14**
binary (linux asset sha256 `9b6c3034…` == the GitHub Release API digest, the
tree-local build `a50facf1…`): every one of these faces printed
`"verdict": "COMPLETE"` with watcher exit 0:

- `tail` over a db with **no journal** — reeflog refuses (exit 1) and names
  the repair (`reeflog init --db … --program <pubkey>`). Nothing about the
  chain was checked; the watcher said COMPLETE.
- `tail` with a **missing reeflog binary** — the spawn fails, `mailbox_exit`
  is `null` (the strongest "we know nothing") — COMPLETE, exit 0.
- `tail` whose **cursor belongs to another journal** — reeflog's own v0.7.13
  provenance gate refuses by name (`does not belong here`). The mailbox's
  refusal vanished into a healthy report — and the save still MINTED a
  `{fills:{}}` ledger, first-run state from a run that never happened
  (PULS M's guarantee was the opposite).
- `retract` over a refusing mailbox — exit 0 with an empty retraction list
  read as health.

The fix is one rule: **the CLI has no verdict of its own.** `verdict` is
reeflog's exit code read verbatim (`0`→COMPLETE, `3`→OWED, `null`→
UNAVAILABLE, anything else→REFUSED), and the watcher's exit follows it
(COMPLETE→0, UNAVAILABLE→2, OWED/REFUSED→3). A run whose mailbox refused
and delivered nothing writes no ledger.

Measured with the real CLI against fake bins that reproduce the published
binary's exact behavior (`tools/measure-mailbox-verdict.mjs`, artifacts
committed at `research/mailbox-verdict-{baseline,fixed}-2026-11-11.json`):

| Face | Baseline (729d048) | Fixed |
|---|---|---|
| X1: mailbox refuses (exit 1, no journal) | VIOLATED (exit 0, COMPLETE) | CLOSED (exit 3, REFUSED, refusal relayed, no ledger minted) |
| X2: mailbox binary missing | VIOLATED (exit 0, COMPLETE) | CLOSED (exit 2, UNAVAILABLE) |
| X3: foreign-cursor refusal | VIOLATED (exit 0, COMPLETE) | CLOSED (exit 3, REFUSED, repair text relayed) |
| X4: retract over a refusing mailbox | VIOLATED (exit 0, no verdict) | CLOSED (exit 3, REFUSED) |
| X5: refusing mailbox mints `{fills:{}}` | VIOLATED (ledger written behind a dead mailbox) | CLOSED (no file — the run never happened) |
| GX1 (guard): healthy run | HELD (4 fills, COMPLETE, exit 0) | HELD |
| GX2 (guard): owed pass | HELD (exit 3, OWED) | HELD |

Pin: `test/mailbox-verdict.test.mjs` — X1–X5 RED on the pre-fix tree
(729d048: 5 fail / 2 guards green), 7/7 green after. Mutation ladder
`tools/mutation-ladder-mailbox-verdict.sh`: 6/6 caught (verdict mapping
both ways, exit mapping both ways, the skip-save gate, the owed guard's
opposite), tree restored byte-identical.

Honest limits: the fake bins quote the published binary's measured words,
but the CI faces do not execute reeflog itself; reeflog's own exit-code
table (usage → 64) is carried into REFUSED, not mapped specially; a mailbox
that dies by SIGNAL (no exit code in the usual range) is REFUSED by the
same rule — the consumer never invents health.

## Falsification

```bash
node --test 'test/*.test.mjs'          # offline; 63 tests, no network
bash tools/mutation-ladder-ledger-durability.sh  # 6 mutations, all must be CAUGHT
bash tools/mutation-ladder-ledger-concurrency.sh # 7 mutations, all must be CAUGHT
bash tools/mutation-ladder-ledger-auto-repair.sh # 6 mutations, all must be CAUGHT
bash tools/mutation-ladder-mailbox-verdict.sh    # 6 mutations, all must be CAUGHT
node tools/measure-ledger-auto-repair.mjs --expect clean   # 0 faces violated
node tools/measure-mailbox-verdict.mjs --expect clean      # 0 faces violated
node tools/e2e-whirlpool.mjs           # live mainnet comparison
node tools/e2e-whirlpool.mjs --mutate  # must go RED
```

The live E2E runs a classic direct-RPC poller and this watcher against the same
mainnet window and checks:

1. `consumer_makes_no_rpc_calls` — the watcher itself spent 0 RPC calls.
2. `window_superset` — every trade the poller found inside the daemon's slot window
   is in the watcher's ledger.
3. `decoded_amounts_match` — overlapping fills decode identically, from two
   independently written decoders.
4. `chain_witness` — every ledger fill's input/output amounts appear as real
   token-balance moves in a transaction re-fetched from the chain by signature.
   A side with a declared transfer fee is matched **net of that fee**, because
   that is what actually moved (`input - input_transfer_fee`); measured on live
   mainnet 2026-11-09, a 3% transfer-fee mint produced `169628503 - 5088856 =
   164539647` on chain while the raw amount appeared nowhere — the old
   raw-only rule called that correct decode a contradiction. The sample always
   includes fee-bearing fills so the branch is exercised, not just written.
5. `no_guessed_fills` — every ledger fill came from a `Traded` event; invalid legs
   are counted, never guessed.
6. `exactly_once_on_replay` — a second tail run adds no fill.
7. `retraction_undo_is_scoped` — a retraction undoes exactly the fill this consumer
   read, and nothing else (an unknown signature undoes nothing).

`--mutate` corrupts the decoder on purpose and requires check 3 to go red: a green
harness over a broken decoder is worse than no harness. (Check 4 alone cannot
catch a pure swap when both amounts are on chain — it proves the amounts are
real, not their direction; that limit is pinned by the `LIMIT` test in
`test/witness.test.mjs`.)

## Limits (honest)

- **No external users yet.** This is the mailbox owner's own consumer, in its own
  second repository; it is user-zero evidence, not adoption.
- The `Traded` event is the pool's own accounting of the swap; the
  `chain_witness` check corroborates it against token balance deltas,
  matching transfer-2022 sides net of the verbatim
  `input_transfer_fee`/`output_transfer_fee`. The watcher still carries the raw
  amounts and the fees separately and does not net them into the fill — the
  fee-adjusted value exists only inside the witness rule, so no consumer gets a
  number the chain did not actually move presented as the raw event amount.
- Only Whirlpool `Traded` events are decoded. Other programs (and other Whirlpool
  event types) arrive as `other`.
- The webhook receiver binds to `127.0.0.1` and relies on reeflog's HMAC contract;
  put TLS and auth in front of it before exposing it beyond localhost.
- Retractions undo what **this** consumer read; if you share a ledger between
  consumers, dedup happens on (signature, pool, amounts), not on consumer identity.
- Concurrency is detected, not arbitrated: a freshness refusal means two
  instances RACED and the loser stops without overwriting. The loser now
  self-repairs by merging (PULS O), which closes the lost-update *outcome*;
  the check itself still sits BEFORE the stage, so a writer landing inside
  the microseconds between check and rename can still interleave — in that
  window the winner's bytes were written after the loser's read, and the
  loser's merged save refuses again (rows then park for rescue, the
  documented fallback). Measured limit, not closed: one instance per ledger
  remains the operating rule; the merge makes a race non-destructive,
  not impossible.
- The self-repair only fires on the freshness refusal (`err.freshness`):
  a stale view whose file CANNOT be re-read (deleted + corrupt) is not
  mergeable and stays a refusal; the merge assumes both sides hold
  at-least-once deliveries, so a ledger shared between two DIFFERENT
  consumer identities still dedups on (signature, pool, amounts) — the
  merge does not create fills either side never consumed.

## License

MIT
