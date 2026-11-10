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

Exit codes follow reeflog's discipline: `0` complete, `3` something is owed or refused
(pending payloads, unverifiable events) — silence is never health.

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
- **The named repair is a real merge**: `mergeLedger(disk, mine)` unions both
  instances' fills and retractions with the durable disk copy winning per key;
  on the CLI paths the refused instance parks its consumed rows for `rescue`,
  which replays into the current ledger — measured end to end: slow instance
  refuses with `exit 3`, fast instance's fills survive, rescue merges all four.

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

## Falsification

```bash
node --test 'test/*.test.mjs'          # offline; 49 tests, no network
bash tools/mutation-ladder-ledger-durability.sh  # 6 mutations, all must be CAUGHT
bash tools/mutation-ladder-ledger-concurrency.sh # 7 mutations, all must be CAUGHT
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
  instances RACED and the loser stopped without writing. Simultaneous saves
  inside one read-check-write window can still interleave on the disk check
  (the window is microseconds, and the loser then fails at the next save or
  overwrites with its own now-stale content only if the check passed twice —
  measured, not closed: run one instance per ledger, or merge on refusal).

## License

MIT
