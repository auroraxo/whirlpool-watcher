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

## Falsification

```bash
node --test 'test/*.test.mjs'          # offline; 12 tests, no network
REEFLOG_BIN=... node tools/e2e-whirlpool.mjs           # live mainnet comparison
REEFLOG_BIN=... node tools/e2e-whirlpool.mjs --mutate  # must go RED
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
5. `no_guessed_fills` — every ledger fill came from a `Traded` event; invalid legs
   are counted, never guessed.
6. `exactly_once_on_replay` — a second tail run adds no fill.
7. `retraction_undo_is_scoped` — a retraction undoes exactly the fill this consumer
   read, and nothing else (an unknown signature undoes nothing).

`--mutate` corrupts the decoder on purpose and requires check 3 to go red: a green
harness over a broken decoder is worse than no harness.

## Limits (honest)

- **No external users yet.** This is the mailbox owner's own consumer, in its own
  second repository; it is user-zero evidence, not adoption.
- The `Traded` event is the pool's own accounting of the swap; the
  `chain_witness` check corroborates it against token balance deltas, but
  transfer-2022 pools' *effective* amounts are the raw amounts minus
  `input_transfer_fee`/`output_transfer_fee` — the watcher carries both fields
  verbatim and does not net them.
- Only Whirlpool `Traded` events are decoded. Other programs (and other Whirlpool
  event types) arrive as `other`.
- The webhook receiver binds to `127.0.0.1` and relies on reeflog's HMAC contract;
  put TLS and auth in front of it before exposing it beyond localhost.
- Retractions undo what **this** consumer read; if you share a ledger between
  consumers, dedup happens on (signature, pool, amounts), not on consumer identity.

## License

MIT
