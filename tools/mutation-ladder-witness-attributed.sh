#!/usr/bin/env bash
# PULS Z mutation ladder — the ATTRIBUTED witness (v2) must have fangs.
#
# The defect PULS Z measured (2026-11-21, live mainnet E2E on the PUBLISHED
# reeflog v0.7.44 bytes): the v1 chain-witness compared a Traded event
# against NET pre/postTokenBalances deltas. A collect-fees+swap transaction
# on the SAME pool (honest co-instruction paying 295,219 TTW + 63,699,467
# USDC out of the very vaults the swap used) netted the swap's legs away:
# -3,130,330 = 63,699,467 - 60,569,137 and -581,328 = 295,219 + 286,109.
# The CORRECT decode was reported as a contradiction (2 of 41 sampled fills).
# The product was right; the ORACLE was blind.
#
# So the v2 oracle must be able to FAIL. Each mutation below turns one pin
# red; a mutation that changes nothing is ANCHOR-FAIL, a mutation that
# breaks the module is COMPILE-ERROR, and a test run with no fail-count is
# VACUUM-GATE — none of those count as a catch.
#
#   M1 the attributed space ignores the transfer amount
#      -> D1 RED (the fill would witness on an unrelated amount)
#   M2 the attributed space ignores DIRECTION (into/out of the pool)
#      -> G1 RED (a swapped decode would be witnessed)
#   M3 the attributed space accepts a near-miss amount
#      -> G3 RED (exactness is the guarantee)
#   M4 the fee branch is opened on a side that declares no fee
#      -> G4 RED
#   M5 the delta fallback is dropped (transfer-2022 fees unwitnessed)
#      -> T1v2 RED
#   M6 the delta fallback accepts any amount (the v1 exactness is lost)
#      -> G4 RED (the undeclared-fee side would match its net)
#   M7 the witness reports witnessed without both sides
#      -> G1 RED
#
# Rules this ladder enforces on ITSELF:
#  * the mutation must COMPILE (a TypeError at import is not a fang);
#  * the mutation must actually change the file (cmp vs the pre-mutation
#    byte-copy) or it is ANCHOR-FAIL, not CAUGHT;
#  * restore is a byte-copy cp, never `git checkout`;
#  * a VACUUM-GATE: a test run that produced no fail-count is not a catch;
#  * every mutated value is PRINTED, so a silent no-op cannot pass as a
#    catch (an `exec` where a `print` was meant prints nothing);
#  * after the ladder the full suite must be green and the sources
#    byte-identical.

set -u
cd "$(dirname "$0")/.."
SRC=src/witness.mjs
TEST=test/witness-attributed.test.mjs
BACKUP=$(mktemp /tmp/ww-ladder-z-witness.XXXXXX)
restore() { cp "$BACKUP" "$SRC"; }
trap restore EXIT
cp "$SRC" "$BACKUP"

status=fail0
caught() {
  local name="$1"
  local out pass failn
  if cmp -s "$BACKUP" "$SRC"; then
    echo "ANCHOR-FAIL $name: mutation changed nothing (pattern not found)"
    status=fail1
    return
  fi
  if ! node --check "$SRC" >/dev/null 2>&1; then
    echo "COMPILE-ERROR $name: the mutation broke the module, not the guard"
    status=fail1
    restore
    return
  fi
  out=$(node --test "$TEST" 2>&1 | grep -E '^ℹ (pass|fail)' | head -4)
  pass=$(echo "$out" | awk '/ pass/{print $3}')
  failn=$(echo "$out" | awk '/ fail/{print $3}')
  if [ -z "$failn" ]; then
    echo "VACUUM-GATE $name: test run produced no result"
    status=fail1
  elif [ "$failn" -ge 1 ]; then
    echo "CAUGHT $name (fail=$failn pass=$pass)"
  else
    echo "ESCAPED $name (fail=0) — the pin is vacuous"
    status=fail1
  fi
  restore
}

# --- M1: the attributed space ignores the transfer amount ------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/witness.mjs';
let s = fs.readFileSync(f, 'utf8');
const before = s;
s = s.replace(
  "      const i = transfers.findIndex((t) => t.intoPool === wantInto\n        && t.fromPool === !wantInto && t.amount === c);",
  "      const i = transfers.findIndex((t) => t.intoPool === wantInto\n        && t.fromPool === !wantInto); // mutated: amount not compared",
);
if (s === before) { console.error('M1 MUTATION DID NOT APPLY'); process.exit(3); }
fs.writeFileSync(f, s);
console.log('mutated M1: amount comparison removed');
EOF
caught M1

# --- M2: the attributed space ignores direction ----------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/witness.mjs';
let s = fs.readFileSync(f, 'utf8');
const before = s;
s = s.replace(
  "      const i = transfers.findIndex((t) => t.intoPool === wantInto\n        && t.fromPool === !wantInto && t.amount === c);",
  "      const i = transfers.findIndex((t) => t.amount === c); // mutated: direction not compared",
);
if (s === before) { console.error('M2 MUTATION DID NOT APPLY'); process.exit(3); }
fs.writeFileSync(f, s);
console.log('mutated M2: direction comparison removed');
EOF
caught M2

# --- M3: the attributed space accepts a near-miss amount --------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/witness.mjs';
let s = fs.readFileSync(f, 'utf8');
const before = s;
s = s.replace(
  "        && t.fromPool === !wantInto && t.amount === c);",
  "        && t.fromPool === !wantInto && t.amount >= c - 1n); // mutated: near-miss accepted",
);
if (s === before) { console.error('M3 MUTATION DID NOT APPLY'); process.exit(3); }
fs.writeFileSync(f, s);
console.log('mutated M3: near-miss amount accepted');
EOF
caught M3

# --- M4: the fee branch opens on a side that declares no fee ---------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/witness.mjs';
let s = fs.readFileSync(f, 'utf8');
const before = s;
s = s.replace(
  "  const outputCandidates = [output];\n  if (outFee > 0n) outputCandidates.push(output - outFee);",
  "  const outputCandidates = [output, output - 100n]; // mutated: fee branch always open",
);
if (s === before) { console.error('M4 MUTATION DID NOT APPLY'); process.exit(3); }
fs.writeFileSync(f, s);
console.log('mutated M4: output fee branch always open');
EOF
caught M4

# --- M5: the delta fallback is dropped -------------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/witness.mjs';
let s = fs.readFileSync(f, 'utf8');
const before = s;
s = s.replace(
  "  const inputD = pickDelta(inputCandidates);\n  const outputD = pickDelta(outputCandidates);",
  "  const inputD = null;\n  const outputD = null; // mutated: delta fallback dropped",
);
if (s === before) { console.error('M5 MUTATION DID NOT APPLY'); process.exit(3); }
fs.writeFileSync(f, s);
console.log('mutated M5: delta fallback dropped');
EOF
caught M5

# --- M6: the delta fallback accepts any amount -----------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/witness.mjs';
let s = fs.readFileSync(f, 'utf8');
const before = s;
s = s.replace(
  "      const i = abs.findIndex((d) => d === c);",
  "      const i = abs.findIndex((d) => d !== 0n); // mutated: any delta matches",
);
if (s === before) { console.error('M6 MUTATION DID NOT APPLY'); process.exit(3); }
fs.writeFileSync(f, s);
console.log('mutated M6: delta space accepts any non-zero delta');
EOF
caught M6

# --- M7: the witness reports witnessed without both sides ------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/witness.mjs';
let s = fs.readFileSync(f, 'utf8');
const before = s;
s = s.replace(
  "  if (!inputHit || !outputHit) {",
  "  if (!inputHit) { // mutated: one side is enough",
);
if (s === before) { console.error('M7 MUTATION DID NOT APPLY'); process.exit(3); }
fs.writeFileSync(f, s);
console.log('mutated M7: one side suffices');
EOF
caught M7

# --- the control: the unmutated tree must be green -------------------------
out=$(node --test "$TEST" 2>&1 | grep -E '^ℹ (pass|fail)' | head -4)
pass=$(echo "$out" | awk '/ pass/{print $3}')
failn=$(echo "$out" | awk '/ fail/{print $3}')
if [ "$failn" != "0" ]; then
  echo "CONTROL-FAIL: the unmutated tree is not green (fail=$failn pass=$pass)"
  status=fail1
else
  echo "CONTROL-GREEN (pass=$pass fail=0)"
fi

# --- the tree must be byte-identical after the ladder ----------------------
if cmp -s "$BACKUP" "$SRC"; then
  echo "RESTORE-OK: src/witness.mjs is byte-identical to the pre-ladder snapshot"
else
  echo "RESTORE-DIFF: the source was not restored"
  status=fail1
fi

# --- the full suite must be green ------------------------------------------
out=$(node --test 'test/*.test.mjs' 2>&1 | grep -E '^ℹ (pass|fail)' | head -4)
pass=$(echo "$out" | awk '/ pass/{print $3}')
failn=$(echo "$out" | awk '/ fail/{print $3}')
if [ "$failn" != "0" ]; then
  echo "SUITE-FAIL after ladder (fail=$failn pass=$pass)"
  status=fail1
else
  echo "SUITE-GREEN after ladder (pass=$pass fail=0)"
fi

if [ "$status" = "fail0" ]; then
  echo "LADDER RESULT: 7/7 CAUGHT"
  exit 0
fi
echo "LADDER RESULT: FAILURES"
exit 1
