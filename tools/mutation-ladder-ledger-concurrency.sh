#!/usr/bin/env bash
# PULS N mutation ladder — every guard in the concurrency contract must
# catch its own mutation, and the tree must come back byte-identical.
#
# A pin that passes no matter what the source says proves nothing. Seven
# mutations, one per defect class PULS N measured (or a guard's opposite):
#
#   M1 staging uses a FIXED name again (`${file}.tmp`)   -> C-N1 RED
#   M2 the writability probe uses a FIXED name again     -> C-N3 RED
#   M3 saveLedger drops the freshness check              -> C-N2/C-N4 RED
#   M4 the freshness check ignores the CONTENT (only the
#      existence is compared)                           -> C-N2 RED
#   M5 mergeLedger drops the disk copy (mine wins)       -> G-N3 RED
#   M6 the freshness refusal loses the `isRefusal` flag  -> C-N5 RED
#   M7 saveLedger does not refresh the freshness mark
#      after a successful write                          -> G-N1 RED
#      (a single writer must be able to save twice)
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
BACKUP=$(mktemp /tmp/ww-ladder-n-src.XXXXXX)
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

# --- M1: fixed staging name -------------------------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('const tmp = `${file}.${process.pid}.tmp`;', 'const tmp = `${file}.tmp`;');
fs.writeFileSync(f, s);
EOF
caught M1 ledger-concurrency.test.mjs

# --- M2: fixed probe name ---------------------------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('const probe = `${file}.${process.pid}.writability-probe`;',
  'const probe = `${file}.writability-probe`;');
fs.writeFileSync(f, s);
EOF
caught M2 ledger-concurrency.test.mjs

# --- M3: no freshness check at all -----------------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('  checkFreshness(file, ledger);', '  // mutated: freshness check removed');
fs.writeFileSync(f, s);
EOF
caught M3 ledger-concurrency.test.mjs

# --- M4: freshness compares EXISTENCE only, not the content ------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  `  if (state === 'present' && current !== expected) {
    throw freshnessRefusal(file,
      'the file changed on disk since this instance read it (another whirlpool-watcher instance saved concurrently)');
  }`,
  `  // mutated: only the existence is compared`,
);
fs.writeFileSync(f, s);
EOF
caught M4 ledger-concurrency.test.mjs

# --- M5: mergeLedger lets MINE win over the durable disk copy ---------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('    fills: { ...mine.fills, ...diskLedger.fills },', '    fills: { ...diskLedger.fills, ...mine.fills },');
fs.writeFileSync(f, s);
EOF
caught M5 ledger-concurrency.test.mjs

# --- M6: the freshness refusal loses the CLI-visible flag -------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('  err.isRefusal = true;\n  return err;', '  return err;');
fs.writeFileSync(f, s);
EOF
caught M6 ledger-concurrency.test.mjs

# --- M7: the freshness mark is not refreshed after a successful write -------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
const line = '  markLoaded(bytes.toString(utf8), ledger);'.replace('utf8', String.fromCharCode(39) + 'utf8' + String.fromCharCode(39));
if (!s.includes(line)) { process.exit(2); }
s = s.replace(line, '  // mutated: freshness mark not refreshed');
fs.writeFileSync(f, s);
EOF
if [ $? -ne 0 ]; then
  echo "ANCHOR-FAIL M7"; status=fail1
else
  if node --check "$SRC" >/dev/null 2>&1; then
    out=$(node --test test/ledger-concurrency.test.mjs 2>&1 | grep -E '^ℹ (pass|fail)' | head -4)
    failn=$(echo "$out" | awk '/ fail/{print $3}')
    pass=$(echo "$out" | awk '/ pass/{print $3}')
    if [ -n "$failn" ] && [ "$failn" -ge 1 ]; then
      echo "CAUGHT M7 (fail=$failn pass=$pass)"
    else
      echo "ESCAPED M7 (fail=0) — the pin is vacuous"; status=fail1
    fi
  else
    echo "COMPILE-ERROR M7"; status=fail1
  fi
  restore
fi

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
