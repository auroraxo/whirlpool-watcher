// The Whirlpool `Traded` event, decoded from a `Program data:` log line.
//
// Where the layout comes from
// ---------------------------
// Not guesswork: `orca-whirlpools-recon/programs/whirlpool/src/events.rs`
// declares the event with `#[event]` (borsh) in declaration order:
//
//   Traded { whirlpool, a_to_b, pre_sqrt_price, post_sqrt_price,
//            input_amount, output_amount, input_transfer_fee,
//            output_transfer_fee, lp_fee, protocol_fee }
//
// and the discriminator is Anchor's standard `sha256("event:Traded")[0..8]`
// = e1ca49af932ba096. Verified against live mainnet 2026-10-31: real swap
// transactions carry `Program data: 4cpJr5MroJYz…` whose first 8 bytes
// decode to exactly that hex, and the decoded fields (pool pubkey, a_to_b,
// input/output amounts, sqrt-price move) are consistent with the
// transaction's pre/postTokenBalances.
//
// Sizes: 8 (discriminator) + 32 (pubkey) + 1 (bool) + 16 (u128) + 16 (u128)
//        + 8 * 6 (u64) = 121 bytes.
//
// What this decoder does NOT claim: a transfer-2022 pool's *effective*
// amounts are the raw amounts minus transfer fees; `input_transfer_fee` and
// `output_transfer_fee` are carried verbatim so a consumer can apply them.

import { createHash } from 'node:crypto';

export const TRADED_DISCRIMINATOR = createHash('sha256')
  .update('event:Traded')
  .digest()
  .subarray(0, 8);

export const TRADED_EVENT_BYTES = 121;
export const WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function toBase58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s || '1';
}

const u64 = (buf, off) => buf.readBigUInt64LE(off);
const u128 = (buf, off) => buf.readBigUInt64LE(off) + (buf.readBigUInt64LE(off + 8) << 64n);

// Result kind is explicit: a line that is not a Traded event is NOT an
// error and never becomes a guessed fill — it is `other`, and a Traded line
// with a wrong size or a truncated body is `invalid`. The difference matters:
// a consumer that silently drops `invalid` claims delivery it did not get.
export function decodeProgramData(b64) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length < 8) return { kind: 'invalid', reason: 'shorter than a discriminator' };
  if (!raw.subarray(0, 8).equals(TRADED_DISCRIMINATOR)) return { kind: 'other' };
  if (raw.length !== TRADED_EVENT_BYTES) {
    return { kind: 'invalid', reason: `Traded payload is ${raw.length} bytes, expected 121` };
  }
  let o = 8;
  const whirlpool = toBase58(raw.subarray(o, o + 32));
  o += 32;
  const a_to_b = raw[o] !== 0;
  if (raw[o] > 1) return { kind: 'invalid', reason: `a_to_b byte is ${raw[o]}, not 0/1` };
  o += 1;
  const pre_sqrt_price = u128(raw, o);
  o += 16;
  const post_sqrt_price = u128(raw, o);
  o += 16;
  const input_amount = u64(raw, o);
  o += 8;
  const output_amount = u64(raw, o);
  o += 8;
  const input_transfer_fee = u64(raw, o);
  o += 8;
  const output_transfer_fee = u64(raw, o);
  o += 8;
  const lp_fee = u64(raw, o);
  o += 8;
  const protocol_fee = u64(raw, o);
  return {
    kind: 'traded',
    event: {
      whirlpool,
      a_to_b,
      pre_sqrt_price,
      post_sqrt_price,
      input_amount,
      output_amount,
      input_transfer_fee,
      output_transfer_fee,
      lp_fee,
      protocol_fee,
    },
  };
}

export function programDataLines(logs) {
  if (!Array.isArray(logs)) return [];
  const out = [];
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    const marker = 'Program data: ';
    const i = line.indexOf(marker);
    if (i < 0) continue;
    out.push(line.slice(i + marker.length).trim());
  }
  return out;
}

// One journal row -> zero or more trade fills. Strict: an `invalid` Traded
// payload is reported on the row, never skipped.
export function tradesFromRow(row) {
  const trades = [];
  const invalid = [];
  for (const b64 of programDataLines(row.logs)) {
    const d = decodeProgramData(b64);
    if (d.kind === 'traded') trades.push(d.event);
    else if (d.kind === 'invalid') invalid.push({ reason: d.reason, program_data: b64.slice(0, 24) });
  }
  return { trades, invalid };
}
