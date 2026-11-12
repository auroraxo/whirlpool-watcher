#!/usr/bin/env bash
# PULS X mutation ladder — the delivery-line contract must have FANGS.
#
# The defect PULS X measured is a consumer that skips what it cannot read
# (`catch { continue; }` on a delivered stdout line). A guard that passes no
# matter what the source says proves nothing, so every face of the new
# contract gets one mutation that MUST turn its test red:
#
#   M1 the tail reader swallows an unparseable line again
#      -> D1 RED
#   M2 the tail reader stops validating identity (no `signature` check)
#      -> D2 RED
#   M3 the tail reader stops validating the delivery position (`seq`)
#      -> D2 RED (the identity-less row's sibling face)
#   M4 the tail run refuses no more (the defects are collected, never raised)
#      -> D1 RED
#   M5 the reorg reader swallows an unparseable line again
#      -> D3 RED
#   M6 the reorg reader stops validating identity
#      -> D3 RED
#   M7 the rescue reader swallows an unparseable line again
#      -> D4 RED
#   M8 the rescue reader refuses no more
#      -> D4 RED
#
# Rules this ladder enforces on ITSELF (learned in the other ladders):
#  * the mutation must COMPILE — a TypeError at import is not a fang;
#  * the mutation must actually change the file (cmp against the pre-
#    mutation byte-copy) or it is ANCHOR-FAIL, not CAUGHT;
#  * restore is a byte-copy cp, never `git checkout`;
#  * a VACUUM-GATE: a test run that produced no fail-count is not a catch;
#  * after the ladder the full suite must be green and the sources
#    byte-identical.

set -u
cd "$(dirname "$0")/.."
SRC=src/cli.mjs
LIB=src/whirlpool-watcher.mjs
TEST=test/delivery-line-voice.test.mjs
BACKUP=$(mktemp /tmp/ww-ladder-x-cli.XXXXXX)
BACKUP2=$(mktemp /tmp/ww-ladder-x-lib.XXXXXX)
restore() { cp "$BACKUP" "$SRC"; cp "$BACKUP2" "$LIB"; }
trap restore EXIT
cp "$SRC" "$BACKUP"
cp "$LIB" "$BACKUP2"

status=fail0
caught() {
  local name="$1" test="$2"
  if cmp -s "$BACKUP" "$SRC" && cmp -s "$BACKUP2" "$LIB"; then
    echo "ANCHOR-FAIL $name: mutation changed nothing (pattern not found)"
    status=fail1
    return
  fi
  if ! node --check "$SRC" >/dev/null 2>&1 || ! node --check "$LIB" >/dev/null 2>&1; then
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

# --- M1: the tail reader swallows an unparseable line again -----------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  "      defects.push({ ordinal: i + 1, why: `does not parse as JSON (${String(err && err.message).split('\\n')[0]})`, line });\n      return;",
  "      return; // mutated: swallow the unreadable line");
fs.writeFileSync(f, s);
EOF
caught M1 delivery-line-voice.test.mjs

# --- M2: identity is no longer required of a delivered row ------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  "  if (typeof row.signature !== 'string' || row.signature === '') {\n    return 'carries no `signature` — a fill without identity can never be deduped or retracted';\n  }",
  "  // mutated: identity is not required");
fs.writeFileSync(f, s);
EOF
caught M2 delivery-line-voice.test.mjs

# --- M3: the delivery position is no longer required ------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  "  if (typeof row.seq !== 'number') {\n    return 'carries no numeric `seq` — the delivery position is unknown';\n  }",
  "  // mutated: the delivery position is not required");
fs.writeFileSync(f, s);
EOF
caught M3 delivery-line-voice.test.mjs

# --- M4: the tail run collects defects but never refuses --------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  "  if (defects.length) {\n    const parked = parkLines(defects.map((x) => x.line), ledgerPath);\n    die(lineRefusal('tail', defects, parked));\n  }",
  "  // mutated: the collected defects are never raised");
fs.writeFileSync(f, s);
EOF
caught M4 delivery-line-voice.test.mjs

# --- M5: the reorg reader swallows an unparseable line again ----------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  "  const { rows, defects } = readDeliveryLines(t.out, 'reorg');",
  "  const { rows } = readDeliveryLines(t.out, 'reorg'); // mutated: no defects");
fs.writeFileSync(f, s);
EOF
caught M5 delivery-line-voice.test.mjs

# --- M6: the reorg reader stops validating identity ------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  "  if (typeof row.signature !== 'string' || row.signature === '') {\n    return 'carries no `signature` — a retraction that names no transaction cannot undo anything';\n  }",
  "  // mutated: a retraction needs no signature");
fs.writeFileSync(f, s);
EOF
caught M6 delivery-line-voice.test.mjs

# --- M7: the rescue reader swallows an unreadable line again ----------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/cli.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  "      unreadable.push({ ordinal: i + 1, why: `does not parse as JSON (${String(err && err.message).split('\\n')[0]})`, line });\n      return;",
  "      return; // mutated: swallow the unreadable parked line");
fs.writeFileSync(f, s);
EOF
caught M7 delivery-line-voice.test.mjs

# --- M8: the rescue run refuses no more -------------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/cli.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  "  if (unreadable.length) {",
  "  if (false && unreadable.length) { // mutated");
fs.writeFileSync(f, s);
EOF
caught M8 delivery-line-voice.test.mjs

# --- restore + suite gates --------------------------------------------------
if cmp -s "$BACKUP" "$SRC" && cmp -s "$BACKUP2" "$LIB"; then
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
