// Chain witness: does the transaction's token-balance delta corroborate the
// fill this consumer decoded?
//
// The check exists so that a decoder reading the WRONG field cannot pass:
// the amounts the ledger claims must appear as real balance movements in the
// transaction fetched straight from the RPC by signature.
//
// MATCHING RULE (fee-aware — this is the part that was wrong before):
//
//   A token-2022 mint with a transfer fee never moves the raw event amount
//   as one single account delta. Measured on live mainnet 2026-11-09,
//   signature 3kD6M924zkA4… (pool 8MM3qdHHrnd917…, 3% transfer-fee mint):
//
//     event input_amount        = 169628503
//     event input_transfer_fee  = 5088856      (= 3% of the input)
//     pool-side account delta   = +164539647
//     169628503 - 5088856       = 164539647   <-- exact
//     event output_amount       = 27631830, output_transfer_fee = 0
//     chain delta               = -27631830   <-- exact
//
// The OLD rule demanded a delta equal to the RAW amount on both sides, so it
// reported this correct decode as a contradiction (39/40 witnessed, "mismatched=1")
// — an oracle that calls a right answer wrong. The event carries the fee
// VERBATIM for exactly this reason, so a side matches when some |delta| equals
// the raw amount or the raw amount minus the declared transfer fee.
//
// What this does NOT weaken:
//   - equality stays EXACT (bigint), no tolerance: a wrong-field decode has
//     to land on a real delta twice, once per side;
//   - BOTH sides must match;
//   - the fee-adjusted branch only exists when the event itself declares a
//     non-zero fee for that side.
// Falsification (tools/e2e-whirlpool.mjs --mutate, input/output swapped) and
// the mutant guard in test/witness.test.mjs both stay red.

export function witnessVerdict(fill, deltas) {
  const input = BigInt(fill.input);
  const output = BigInt(fill.output);
  const inFee = BigInt(fill.input_transfer_fee || 0);
  const outFee = BigInt(fill.output_transfer_fee || 0);
  const abs = deltas.map((d) => (d < 0n ? -d : d));

  const inputCandidates = [input];
  if (inFee > 0n) inputCandidates.push(input - inFee);
  const outputCandidates = [output];
  if (outFee > 0n) outputCandidates.push(output - outFee);

  const pick = (candidates) => {
    for (const c of candidates) {
      if (c < 0n) continue;
      const i = abs.findIndex((d) => d === c);
      if (i >= 0) return { matched: c, delta: deltas[i] };
    }
    return null;
  };

  const inputHit = pick(inputCandidates);
  const outputHit = pick(outputCandidates);
  return {
    witnessed: Boolean(inputHit && outputHit),
    input: inputHit,
    output: outputHit,
    feeAdjusted: Boolean(
      (inputHit && inputHit.matched !== input) || (outputHit && outputHit.matched !== output),
    ),
  };
}
