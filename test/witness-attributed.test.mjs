// Chain-witness rule v2: attribution, not netting.
//
// RED first (2026-11-21, live mainnet whirlpool E2E on the PUBLISHED
// reeflog v0.7.44 bytes): the v1 oracle compared the Traded event against
// NET pre/postTokenBalances deltas. Two fills (5VrAzXLJ…, 3GevuNkviwL1…,
// pool 56QW1m7pe5TdbEg9hTqmCB943LT3PSauVyBdnX4UACXH) were reported as
// contradictions — but the transaction itself is collect-fees + swap on
// the SAME pool: an honest co-instruction paid 295,219 TTW and
// 63,699,467 USDC out of the same vaults the swap then used. The netting
// erased the swap's legs (−3,130,330 = 63,699,467 − 60,569,137;
// −581,328 = 295,219 + 286,109), so a CORRECT decode was called wrong.
// The product (journal + consumer decode) was right; the oracle was blind.
//
// The fix keeps exactness and direction, and adds attribution: a side is
// witnessed when the event amount appears as a REAL token transfer into
// (input) / out of (output) a pool-owned account in the same transaction,
// with the v1 delta space kept as a fallback so the measured transfer-fee
// case (T1, 2026-11-09) stays witnessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { witnessVerdictTransfers } from '../src/witness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'research', 'fixtures');
const FIX_A = JSON.parse(readFileSync(join(FIXTURES, 'collect-fees-plus-swap-a.json'), 'utf8'));
const FIX_B = JSON.parse(readFileSync(join(FIXTURES, 'collect-fees-plus-swap-b.json'), 'utf8'));
const POOL = '56QW1m7pe5TdbEg9hTqmCB943LT3PSauVyBdnX4UACXH';

// The fill the consumer's ledger actually booked for FIX_A (byte-checked
// against the journal's Traded line before this file was written).
const FILL_A = {
  signature: '5VrAzXLJL4NpFACW4QZLXt6YZb9oaeg6x4bfGzyLWfsB9Xzu9GaPfvVQpAJPmiwgabtkqhuiw9nipKwj9Vbfvy2E',
  pool: POOL,
  a_to_b: false,
  input: '60569137',
  output: '286109',
  input_transfer_fee: '0',
  output_transfer_fee: '0',
};
const FILL_B = {
  signature: '3GevuNkviwL1xepYBBkzFfBkjTDPkPxYv3TadF7KQUDkVAEYa8mZYDGSLgPL9pfN2aYnNGiCCfoR5P6SCLBTf8cH',
  pool: POOL,
  a_to_b: false,
  input: '60515590',
  output: '285851',
  input_transfer_fee: '0',
  output_transfer_fee: '0',
};

// Extraction the harness performs (mirrors tools/e2e-whirlpool.mjs), kept in
// the TEST on purpose: this file pins the ORACLE, not the extractor.
function contextFromTx(tx) {
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const poolAccounts = new Set();
  for (const p of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]) {
    if (p.owner === POOL) poolAccounts.add(keys[p.accountIndex]);
  }
  const transfers = [];
  for (const g of tx.meta.innerInstructions || []) {
    for (const ix of g.instructions) {
      const i = ix.parsed && ix.parsed.info;
      if (!i) continue;
      // Only the TOKEN programs' transfers move tokens: a system-program CPI
      // also parses as {type:'transfer'} but carries `lamports`, no amount.
      if (ix.program !== 'spl-token' && ix.program !== 'spl-token-2022') continue;
      if (ix.parsed.type === 'transferChecked' || ix.parsed.type === 'transfer') {
        const amount = BigInt(i.amount ?? (i.tokenAmount && i.tokenAmount.amount));
        transfers.push({
          amount,
          source: i.source,
          destination: i.destination,
          intoPool: poolAccounts.has(i.destination),
          fromPool: poolAccounts.has(i.source),
        });
      }
    }
  }
  const postByIdx = new Map((tx.meta.postTokenBalances || []).map((p) => [p.accountIndex, p.uiTokenAmount.amount]));
  const deltas = (tx.meta.preTokenBalances || []).map((p) => {
    const after = postByIdx.get(p.accountIndex);
    if (after === undefined) return null;
    return BigInt(after) - BigInt(p.uiTokenAmount.amount);
  }).filter((x) => x !== null);
  return { transfers, deltas, poolAccounts };
}

test('D1: the collect-fees+swap fill is witnessed by ATTRIBUTED transfers, matched raw', () => {
  const v = witnessVerdictTransfers(FILL_A, contextFromTx(FIX_A));
  assert.equal(v.witnessed, true,
    'input 60569137 is a real transfer INTO a pool account, output 286109 OUT of one');
  assert.equal(v.transferWitnessed, true, 'both sides matched on attributed transfers, not netted deltas');
  assert.equal(v.input.matched, 60569137n);
  assert.equal(v.output.matched, 286109n);
  assert.equal(v.input.direction, 'into_pool');
  assert.equal(v.output.direction, 'out_of_pool');
});

test('D2: the second collect-fees+swap fill is witnessed the same way', () => {
  const v = witnessVerdictTransfers(FILL_B, contextFromTx(FIX_B));
  assert.equal(v.witnessed, true);
  assert.equal(v.transferWitnessed, true);
  assert.equal(v.input.matched, 60515590n);
  assert.equal(v.output.matched, 285851n);
});

test('D3: the v1 netted-delta oracle is blind on this exact transaction (the defect, pinned)', () => {
  // The delta space of FIX_A carries NEITHER event amount (both were netted
  // away by the honest collect instruction) — a fill claiming them must NOT
  // be witnessed from deltas alone, which is exactly what the live run of
  // 2026-11-21 reported as a false contradiction.
  const { deltas } = contextFromTx(FIX_A);
  const net = new Set(deltas.map((d) => (d < 0n ? -d : d)));
  assert.equal(net.has(60569137n), false, 'the swap input is not a net delta of this tx');
  assert.equal(net.has(286109n), false, 'the swap output is not a net delta of this tx');
});

test('G1: a mutated decode (amounts swapped) is still a contradiction under attribution', () => {
  const mutant = { ...FILL_A, input: FILL_A.output, output: FILL_A.input };
  const v = witnessVerdictTransfers(mutant, contextFromTx(FIX_A));
  assert.equal(v.witnessed, false,
    'no transfer carries 286109 INTO the pool and none carries 60569137 OUT of it');
});

test('G2: a wrong-field read with a real-looking amount still needs BOTH sides attributed', () => {
  // in=60569137 is real; out=63699467 is the COLLECT leg (real pool outflow
  // of the same tx) — both are real amounts, so this is the documented
  // swap-symmetry boundary, NOT witnessed as a decoder-derangement catch:
  // but out=60569137 (the INPUT leg claimed as output) has no out-transfer,
  // so the deranged direction must fail.
  const wrong = { ...FILL_A, output: FILL_A.input };
  const v = witnessVerdictTransfers(wrong, contextFromTx(FIX_A));
  assert.equal(v.witnessed === false || v.output.direction === 'into_pool', true,
    'output must not be satisfied by an INTO-pool transfer');
});

test('G3: exactness holds under attribution — one lamport off is a contradiction', () => {
  const off = { ...FILL_A, input: '60569136' };
  const v = witnessVerdictTransfers(off, contextFromTx(FIX_A));
  assert.equal(v.witnessed, false);
});

test('T1v2: the measured transfer-fee fill stays witnessed through the delta fallback', () => {
  // Live mainnet 2026-11-09, signature 3kD6M924zkA4… (3% transfer-fee mint):
  // input moved NET of its declared fee, so only the delta space can see it.
  const fill = {
    input: '169628503', output: '27631830',
    input_transfer_fee: '5088856', output_transfer_fee: '0',
  };
  const v = witnessVerdictTransfers(fill, {
    transfers: [],
    deltas: [1410575n, 0n, 164539647n, -13406n, 0n, -27631830n, -171082705n, 13406n, 27630818n, -990609419n, 0n],
  });
  assert.equal(v.witnessed, true, 'delta fallback keeps the fee case');
  assert.equal(v.feeAdjusted, true);
  assert.equal(v.transferWitnessed, false, 'no transfers were provided — this is the fallback, honestly named');
});

test('G4: the fee branch only exists on the side that declares it', () => {
  const fill = { input: '1000', output: '2500', input_transfer_fee: '500', output_transfer_fee: '0' };
  // The input declares a 500 fee: 1000 raw is absent as a transfer, but
  // 1000-500=500 IS a real transfer INTO the pool -> witnessed on that side.
  const v = witnessVerdictTransfers(fill, {
    transfers: [{ amount: 500n, source: 'USER', destination: 'POOL', intoPool: true, fromPool: false }],
    deltas: [-2500n],
  });
  assert.equal(v.witnessed, true);
  assert.equal(v.input.matched, 500n);
  assert.equal(v.output.matched, 2500n);
  // The OUTPUT declares no fee: only its RAW 2500 may match. A delta of
  // 2400 (the net of a fee this side never declared) must NOT satisfy it.
  const v2 = witnessVerdictTransfers({ ...fill, input: '500' }, {
    transfers: [],
    deltas: [500n, -2400n],
  });
  assert.equal(v2.witnessed, false,
    'output 2500 is absent; 2400 is the net of an undeclared fee on the output side');
  assert.equal(v2.output, null, 'the output side witnessed nothing');
  assert.equal(v2.input && v2.input.matched, 500n, 'the input side keeps its declared fee');
});
