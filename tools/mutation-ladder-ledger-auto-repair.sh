#!/usr/bin/env bash
# PULS O mutation ladder — every guard in the auto-repair contract must
# catch its own mutation, and the tree must come back byte-identical.
#
# A pin that passes no matter what the source says proves nothing. Six
# mutations, one per defect class PULS O measured (or a guard's opposite):
#
#   M1 saveLedgerWithRepair never repairs (the stale save throws) -> MR1 RED
#   M2 the repair saves MINE without merging (the disk copy is dropped)
#      -> MR1/MR3 RED (the other instance's fills vanish)
#   M3 mergeLedger lets MINE win over the durable disk copy        -> MR3 RED
#   M4 mergeLedger does not let RETRACTIONS win over fills          -> MR3 RED
#   M5 mergeLedger's meta spread drops the other side's reports    -> MR2 RED
#   M6 the freshness refusal loses the `freshness` marker, so the
#      repair path is never entered (everything stays a refusal)    -> MR1 RED
#
# Rules this ladder enforces on ITSELF (learned in reeflog's ladders):
#  * the mutation must COMPILE — a TypeError at import is not a fang;
#  * the mutation must actually change the file (cmp against the pre-
#    mutation byte-copy) or it is ANCHOR-FAIL, not CAUGHT;
#  * restore is a byte-copy cp, never `git checkout`;
#  * after the ladder the full suite must be green and the source
#    byte-identical.

set -u
cd "$(dirname "$0")/.."
SRC=src/whirlpool-watcher.mjs
BACKUP=$(mktemp /tmp/ww-ladder-o-src.XXXXXX)
restore() { cp "$BACKUP" "$SRC"; }
trap restore EXIT
cp "$SRC" "$BACKUP"

status=fail0
caught() {
  local name="$1" test="$2"
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
  local out pass failn
  out=$(node --test "test/$test" 2>&1 | grep -E '^ℹ (pass|fail)' | head -4)
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

# --- M1: the repair never repairs ------------------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('    const merged = mergeLedger(disk, ledger);',
  '    throw err; // mutated: no repair\n    const merged = mergeLedger(disk, ledger);');
fs.writeFileSync(f, s);
EOF
caught M1 ledger-auto-merge-repair.test.mjs

# --- M2: the repair saves MINE without merging ------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('    const merged = mergeLedger(disk, ledger);',
  '    const merged = ledger; // mutated: no merge');
fs.writeFileSync(f, s);
EOF
caught M2 ledger-auto-merge-repair.test.mjs

# --- M3: mergeLedger lets MINE win over the durable disk copy ---------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('  const fills = { ...mine.fills, ...diskLedger.fills };',
  '  const fills = { ...diskLedger.fills, ...mine.fills };');
fs.writeFileSync(f, s);
EOF
caught M3 ledger-auto-merge-repair.test.mjs

# --- M4: retractions do not win over fills ----------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('  for (const key of Object.keys(retractions)) delete fills[key];',
  '  // mutated: retractions do not delete the fill');
fs.writeFileSync(f, s);
EOF
caught M4 ledger-auto-merge-repair.test.mjs

# --- M5: the meta spread drops the other side's reports ---------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('    meta: mergeMeta(diskLedger.meta || {}, mine.meta || {}),',
  '    meta: { ...mine.meta, ...diskLedger.meta },');
fs.writeFileSync(f, s);
EOF
caught M5 ledger-auto-merge-repair.test.mjs

# --- M6: the refusal loses the freshness marker ----------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('  err.freshness = true;',
  '  // mutated: no freshness marker');
fs.writeFileSync(f, s);
EOF
caught M6 ledger-auto-merge-repair.test.mjs

# --- restore + suite gates --------------------------------------------------
if cmp -s "$BACKUP" "$SRC"; then
  echo "RESTORE byte-identical"
else
  echo "RESTORE-DIFFERS"; status=fail1
fi

sout=$(npm test 2>&1 | grep -E '^ℹ (pass|fail)')
sfail=$(echo "$sout" | awk '/ fail/{print $3}')
if [ "$sfail" = "0" ]; then
  echo "SUITE green after ladder"
else
  echo "SUITE red after ladder (fail=$sfail)"; status=fail1
fi

[ "$status" = fail0 ] || exit 1
