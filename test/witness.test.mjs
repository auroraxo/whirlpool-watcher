// Chain-witness rule, pinned by the one fill that falsified the OLD rule.
//
// RED first: this file was written against a faithful extraction of the old
// matcher (raw amount only, both sides) — T1 failed there and the guards
// passed, which is the ladder in both directions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { witnessVerdict } from '../src/witness.mjs';

// Live mainnet 2026-11-09, signature 3kD6M924zkA4rtg6Hs2munxQviTX8xLLJ7qWq2g79fphKrBKiVic1NqaAbEKdReXdUNEqDXnYqChqKmaUaRFBLhb,
// pool 8MM3qdHHrnd917TVEDKFXRhhGiicuthcDv4ji8QFZTUm: the transfer-fee fill
// the old oracle reported as a contradiction.
const TRANSFER_FEE_FILL = {
  signature: '3kD6M924zkA4rtg6Hs2munxQviTX8xLLJ7qWq2g79fphKrBKiVic1NqaAbEKdReXdUNEqDXnYqChqKmaUaRFBLhb',
  input: '169628503',
  output: '27631830',
  input_transfer_fee: '5088856',
  output_transfer_fee: '0',
};

// The absolute token-balance deltas of that transaction, as the harness reads
// them from pre/postTokenBalances (sign preserved for provenance).
const MAINNET_DELTAS = [
  1410575n, 0n, 164539647n, -13406n, 0n, -27631830n,
  -171082705n, 13406n, 27630818n, -990609419n, 0n,
];

test('T1: a fill whose input moved net of the declared transfer fee is witnessed', () => {
  const v = witnessVerdict(TRANSFER_FEE_FILL, MAINNET_DELTAS);
  assert.equal(v.witnessed, true,
    'input 169628503 - fee 5088856 = 164539647 is on chain, output 27631830 is on chain');
  assert.equal(v.feeAdjusted, true);
  assert.equal(v.input.matched, 164539647n);
  assert.equal(v.output.matched, 27631830n);
});

test('G1: a no-fee fill still needs the raw amounts on chain (guards the common path)', () => {
  const fill = { input: '1000', output: '2500', input_transfer_fee: '0', output_transfer_fee: '0' };
  const ok = witnessVerdict(fill, [1000n, -2500n]);
  assert.equal(ok.witnessed, true);
  assert.equal(ok.feeAdjusted, false);

  const missing = witnessVerdict(fill, [999n, -2500n]);
  assert.equal(missing.witnessed, false, 'a delta one unit off must not witness');
});

test('G2: the fee branch only exists when the event declares the fee', () => {
  // Declaring a fee that is NOT in the deltas must not manufacture a match.
  const fill = { input: '1000', output: '2500', input_transfer_fee: '500', output_transfer_fee: '0' };
  // 1000-500=500 present, but that is the only branch; raw absent:
  assert.equal(witnessVerdict(fill, [500n, -2500n]).witnessed, true);
  // No 1000 and no 500: must fail.
  assert.equal(witnessVerdict(fill, [600n, -2500n]).witnessed, false);
  // Fee declared but zero-cost side must still match raw only.
  assert.equal(witnessVerdict(fill, [600n, -2400n]).witnessed, false);
});

test('F1: a mutated decode (input/output swapped) is still a contradiction', () => {
  const mutant = {
    input: TRANSFER_FEE_FILL.output,
    output: TRANSFER_FEE_FILL.input,
    input_transfer_fee: TRANSFER_FEE_FILL.input_transfer_fee,
    output_transfer_fee: TRANSFER_FEE_FILL.output_transfer_fee,
  };
  assert.equal(witnessVerdict(mutant, MAINNET_DELTAS).witnessed, false,
    'the swap must not satisfy both sides');
});

test('F2: a wrong-field read with the right fee still fails', () => {
  const wrong = { ...TRANSFER_FEE_FILL, input: '169628504' };
  assert.equal(witnessVerdict(wrong, MAINNET_DELTAS).witnessed, false);
});

test('LIMIT: the witness alone is swap-symmetric when both raw amounts are on chain', () => {
  // Named, not hidden: if BOTH raw amounts appear as deltas, swapping them
  // still satisfies this oracle — it proves the amounts are real, not their
  // direction. Direction is what decoded_amounts_match (against the naive
  // decoder) is for; measured 2026-11-09, --mutate went red on THAT check
  // while chain_witness stayed green. This test pins the boundary so nobody
  // later mistakes the witness for a swap detector.
  const plain = { input: '1000', output: '2500', input_transfer_fee: '0', output_transfer_fee: '0' };
  const swapped = { ...plain, input: '2500', output: '1000' };
  assert.equal(witnessVerdict(swapped, [1000n, -2500n]).witnessed, true,
    'known limit: symmetric oracle');
  // …and the transfer-fee case is NOT swap-symmetric, because only one side
  // moved raw (the other moved net of its fee).
  const mutant = {
    input: TRANSFER_FEE_FILL.output,
    output: TRANSFER_FEE_FILL.input,
    input_transfer_fee: TRANSFER_FEE_FILL.input_transfer_fee,
    output_transfer_fee: TRANSFER_FEE_FILL.output_transfer_fee,
  };
  assert.equal(witnessVerdict(mutant, MAINNET_DELTAS).witnessed, false,
    'the fee fill breaks the symmetry: the raw input is not on chain');
});
