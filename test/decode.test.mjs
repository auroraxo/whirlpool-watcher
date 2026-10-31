// Offline tests for the whirlpool-watcher decoder and ledger.
//
// The fixtures are REAL mainnet data captured 2026-10-31 from the Orca
// Whirlpool program (whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc): four
// `Traded` events with their transactions' pre/postTokenBalances, and three
// `Program data:` lines that are NOT Traded events.
//
// The point of the vault deltas in the fixtures is that they are an
// INDEPENDENT witness: the decoded amounts must appear as actual token
// balance moves in the same transaction. A decoder that reads the wrong
// field cannot pass this.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  decodeProgramData, programDataLines, tradesFromRow,
  TRADED_DISCRIMINATOR, TRADED_EVENT_BYTES,
} from '../src/decode.mjs';
import {
  loadLedger, saveLedger, absorbRow, verifyDelivery, rowToFills,
} from '../src/whirlpool-watcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));

test('the discriminator is Anchor sha256("event:Traded")[0..8]', () => {
  assert.equal(TRADED_DISCRIMINATOR.toString('hex'), 'e1ca49af932ba096');
});

test('every captured live Traded payload decodes', () => {
  assert.equal(FIX.traded.length, 4);
  for (const t of FIX.traded) {
    const d = decodeProgramData(t.program_data);
    assert.equal(d.kind, 'traded', `${t.signature}: ${JSON.stringify(d, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}`);
    assert.match(d.event.whirlpool, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    assert.equal(typeof d.event.a_to_b, 'boolean');
    assert.ok(d.event.input_amount > 0n);
    assert.ok(d.event.output_amount > 0n);
  }
});

test('a non-Traded Program data line is "other", never a guessed fill', () => {
  for (const t of FIX.non_traded) {
    const d = decodeProgramData(t.program_data);
    assert.equal(d.kind, 'other');
    assert.equal(d.event, undefined);
  }
});

test('a Traded payload with a wrong length is invalid, not silently dropped', () => {
  const raw = Buffer.from(FIX.traded[0].program_data, 'base64');
  const short = raw.subarray(0, raw.length - 3).toString('base64');
  const d = decodeProgramData(short);
  assert.equal(d.kind, 'invalid');
  assert.match(d.reason, /bytes, expected 121/);
  // A truncated payload must never be decoded as a fill with missing fields.
  assert.equal(d.event, undefined);
});

test('a corrupted discriminator is "other", not a fill', () => {
  const raw = Buffer.from(FIX.traded[0].program_data, 'base64');
  raw[0] = raw[0] ^ 0xff;
  const d = decodeProgramData(raw.toString('base64'));
  assert.equal(d.kind, 'other');
});

test('the decoded amounts are corroborated by the chain token-balance deltas', () => {
  // Independent witness: the same amounts must show up as real balance moves.
  let witnessed = 0;
  for (const v of FIX.vaults) {
    const d = decodeProgramData(v.program_data);
    assert.equal(d.kind, 'traded');
    const inStr = d.event.input_amount.toString();
    const outStr = d.event.output_amount.toString();
    const abs = v.deltas.map((x) => (x.delta.startsWith('-') ? x.delta.slice(1) : x.delta));
    const hitIn = abs.includes(inStr);
    const hitOut = abs.includes(outStr);
    assert.ok(hitIn, `${v.signature}: input ${inStr} not among ${abs.join(',')}`);
    assert.ok(hitOut, `${v.signature}: output ${outStr} not among ${abs.join(',')}`);
    witnessed++;
  }
  assert.equal(witnessed, 4);
});

test('programDataLines finds only Program data lines', () => {
  const logs = [
    'Program log: Instruction: Swap',
    'Program data: 4cpJr5MroJYz',
    'Program log: Instruction: SwapOrcaWhirlpool',
  ];
  assert.deepEqual(programDataLines(logs), ['4cpJr5MroJYz']);
  assert.deepEqual(programDataLines(null), []);
  assert.deepEqual(programDataLines([42, null]), []);
});

test('tradesFromRow reports invalid legs instead of dropping them', () => {
  const raw = Buffer.from(FIX.traded[0].program_data, 'base64');
  const short = raw.subarray(0, 100).toString('base64');
  const row = { logs: [`Program data: ${short}`, `Program data: ${FIX.traded[0].program_data}`] };
  const r = tradesFromRow(row);
  assert.equal(r.trades.length, 1);
  assert.equal(r.invalid.length, 1);
  assert.match(r.invalid[0].reason, /expected 121/);
});

test('the ledger is durable, dedups, and survives a reload', () => {
  const file = path.join('/tmp', 'ww-ledger-test.json');
  fs.rmSync(file, { force: true });
  const ledger = loadLedger(file);
  const row = {
    seq: 7,
    signature: FIX.traded[0].signature,
    slot: 1,
    seal: 'finalized',
    err: null,
    logs: [`Program data: ${FIX.traded[0].program_data}`],
  };
  const r1 = absorbRow(ledger, row);
  assert.equal(r1.fills, 1);
  assert.equal(r1.dupes, 0);
  saveLedger(file, ledger);

  const ledger2 = loadLedger(file);
  assert.equal(Object.keys(ledger2.fills).length, 1);
  // The same leg delivered twice (at-least-once delivery is the contract)
  // must not become two fills.
  const r2 = absorbRow(ledger2, row);
  assert.equal(r2.fills, 1);
  assert.equal(r2.dupes, 1);
  assert.equal(Object.keys(ledger2.fills).length, 1);

  // BigInt amounts must survive the JSON round trip as exact strings.
  const stored = Object.values(ledger2.fills)[0];
  assert.equal(typeof stored.input, 'string');
  assert.equal(typeof stored.output, 'string');
  fs.rmSync(file, { force: true });
});

test('the ledger records invalid events for later inspection', () => {
  const file = path.join('/tmp', 'ww-ledger-invalid.json');
  fs.rmSync(file, { force: true });
  const ledger = loadLedger(file);
  const raw = Buffer.from(FIX.traded[0].program_data, 'base64');
  const short = raw.subarray(0, 90).toString('base64');
  absorbRow(ledger, { seq: 3, signature: 'x', slot: 1, logs: [`Program data: ${short}`] });
  saveLedger(file, ledger);
  const reloaded = loadLedger(file);
  assert.equal(reloaded.meta.invalid_events.length, 1);
  assert.equal(reloaded.meta.invalid_events[0].seq, 3);
  fs.rmSync(file, { force: true });
});

test('the webhook signature is verified byte-for-byte over the body', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ type: 'event', seq: 1 });
  const good = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyDelivery(secret, body, good), true);
  assert.equal(verifyDelivery('other-secret', body, good), false);
  assert.equal(verifyDelivery(secret, `${body} `, good), false);
  assert.equal(verifyDelivery(secret, body, 'sha256=00'), false);
  assert.equal(verifyDelivery(secret, body, undefined), false);
  assert.equal(verifyDelivery(secret, body, `sha256=${'0'.repeat(64)}`), false);
});

test('rowToFills keeps every decoded field on the fill', () => {
  const row = {
    seq: 1, signature: FIX.traded[0].signature, slot: 42, seal: 'finalized', err: null,
    logs: [`Program data: ${FIX.traded[0].program_data}`],
  };
  const { fills } = rowToFills(row);
  assert.equal(fills.length, 1);
  const f = fills[0];
  for (const k of ['pool', 'a_to_b', 'input', 'output', 'lp_fee', 'protocol_fee',
    'pre_sqrt_price', 'post_sqrt_price', 'seq', 'slot', 'signature']) {
    assert.ok(k in f, `missing ${k}`);
  }
});

test('a FAILED transaction yields no fill — its Traded event was rolled back', () => {
  // Regression, found by the live e2e 2026-10-31: 4 of 25 sampled "fills"
  // came from transactions with meta.err set. Their logs still carry the
  // Traded event (emitted before a later instruction failed), but no token
  // balance moved — recording them books phantom fills.
  const file = path.join('/tmp', 'ww-ledger-failed.json');
  fs.rmSync(file, { force: true });
  const ledger = loadLedger(file);
  const row = {
    seq: 9,
    signature: FIX.traded[1].signature,
    slot: 42,
    seal: 'confirmed',
    err: JSON.stringify({ InstructionError: [1, { Custom: 13 }] }),
    logs: [`Program data: ${FIX.traded[1].program_data}`],
  };
  const r = absorbRow(ledger, row);
  assert.equal(r.fills, 0, 'a reverted transaction must not produce a fill');
  assert.equal(r.failed, true);
  assert.equal(Object.keys(ledger.fills).length, 0);
  // The event is recorded, not dropped: the ledger can explain the absence.
  assert.equal(ledger.meta.failed_transactions.length, 1);
  assert.equal(ledger.meta.failed_transactions[0].trades_in_logs, 1);
  assert.match(ledger.meta.failed_transactions[0].err, /InstructionError/);
  fs.rmSync(file, { force: true });
});

test('the same row WITHOUT an error does produce a fill', () => {
  // False-positive guard: the failed-transaction filter must not eat real
  // fills. This is the one test in this pair that passes only when the row
  // has err=null.
  const file = path.join('/tmp', 'ww-ledger-ok.json');
  fs.rmSync(file, { force: true });
  const ledger = loadLedger(file);
  const r = absorbRow(ledger, {
    seq: 9,
    signature: FIX.traded[1].signature,
    slot: 42,
    seal: 'finalized',
    err: null,
    logs: [`Program data: ${FIX.traded[1].program_data}`],
  });
  assert.equal(r.fills, 1);
  assert.equal(r.failed, false);
  assert.equal(Object.keys(ledger.fills).length, 1);
  fs.rmSync(file, { force: true });
});

test('a zero-amount trade is counted, not booked as a fill', () => {
  const file = path.join('/tmp', 'ww-ledger-zero.json');
  fs.rmSync(file, { force: true });
  const ledger = loadLedger(file);
  // Build a Traded payload with input=0 and output=0 from a real fixture.
  const raw = Buffer.from(FIX.traded[0].program_data, 'base64');
  raw.writeBigUInt64LE(0n, 8 + 32 + 1 + 32); // input_amount
  raw.writeBigUInt64LE(0n, 8 + 32 + 1 + 32 + 8); // output_amount
  const r = absorbRow(ledger, {
    seq: 11, signature: 'zero-trade', slot: 43, seal: 'finalized', err: null,
    logs: [`Program data: ${raw.toString('base64')}`],
  });
  assert.equal(r.fills, 0);
  assert.equal(r.zero, 1);
  assert.equal(ledger.meta.zero_amount_trades, 1);
  assert.equal(Object.keys(ledger.fills).length, 0);
  fs.rmSync(file, { force: true });
});
