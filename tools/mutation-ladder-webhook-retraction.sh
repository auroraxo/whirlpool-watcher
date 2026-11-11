#!/usr/bin/env bash
# PULS Q mutation ladder — every guard in the webhook-retraction contract
# must catch its own mutation, and the tree must come back byte-identical.
#
# A pin that passes no matter what the source says proves nothing. Six
# mutations, one per face the tool measured (or a guard's opposite):
#
#   MQ1 the webhook reorg branch does not run the join (the pre-fix rule:
#        the retraction is counted, never applied)
#        -> Q1 RED (the fill stays open behind an ACKed retraction)
#   MQ2 the dedup ignores ledger.retractions (the pre-fix dedup)
#        -> Q2 RED (rescue resurrects the undone fill)
#   MQ3 the join is unscoped (it undoes every fill, not only the retracted
#      signature) -> Q1b RED (a scoped undo became a blanket undo)
#   MQ4 the rescue report drops the declined replay (the count is lost)
#        -> Q2 RED (the skip is no longer named)
#   MQ5 the dedup is dropped entirely (over-tightening in the other
#      direction: a replayed row books the same fill twice)
#        -> Q2b/GQ3 RED
#   MQ6 the join moves the fill but forgets the retraction record
#        -> Q1 RED (the ledger no longer says WHICH fill was undone)
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
BACKUP=$(mktemp /tmp/ww-ladder-q-cli.XXXXXX)
BACKUP2=$(mktemp /tmp/ww-ladder-q-lib.XXXXXX)
restore() { cp "$BACKUP" "$SRC"; cp "$BACKUP2" "$LIB"; }
trap restore EXIT
cp "$SRC" "$BACKUP"
cp "$LIB" "$BACKUP2"

status=fail0
caught() {
  local name="$1"; shift
  local tests="$(for t in "$@"; do printf 'test/%s ' "$t"; done)"
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
  out=$(node --test $tests 2>&1 | grep -E '^ℹ (pass|fail)' | head -4)
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

# --- MQ1: the webhook reorg does not run the join ---------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('        const retracted = applyRetractions(ledger, [payload]);',
  '        const retracted = [{ undoable_fills: [] }]; // mutated: the join never runs');
fs.writeFileSync(f, s);
EOF
caught MQ1 webhook-retraction.test.mjs

# --- MQ2: the dedup ignores the retraction map ------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('  const retractedKeys = new Set(Object.keys(ledger.retractions || {}));',
  '  const retractedKeys = new Set(); // mutated: the undones are invisible');
fs.writeFileSync(f, s);
EOF
caught MQ2 webhook-retraction.test.mjs

# --- MQ3: the join is unscoped (undoes every fill) --------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('      if (f.signature === row.signature) undoable.push(k);',
  '      undoable.push(k); // mutated: the undo is a blanket undo');
fs.writeFileSync(f, s);
EOF
caught MQ3 webhook-retraction.test.mjs

# --- MQ4: the rescue report drops the declined replay -----------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/cli.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('    retracted_replays_ignored: retractedReplays,',
  '    retracted_replays_ignored: 0, // mutated: the skip is not named');
fs.writeFileSync(f, s);
EOF
caught MQ4 webhook-retraction.test.mjs

# --- MQ5: the dedup is dropped entirely --------------------------------------
# The webhook file alone does not pin the open-fill dedup (its own faces are
# about undone fills): run it together with the two files that do — the
# decode dedup (r2.dupes) and the rescue duplicate count.
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('      if (ledger.fills[dedupKey]) { dupes++; continue; }',
  '      // mutated: the dedup is gone');
fs.writeFileSync(f, s);
EOF
caught MQ5 decode.test.mjs ledger-auto-merge-repair.test.mjs

# --- MQ6: the join moves the fill but forgets the record --------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('      ledger.retractions[k] = { ...ledger.fills[k], reorg: row, undone_at: Date.now() };',
  '      // mutated: the undo happens but is never recorded');
fs.writeFileSync(f, s);
EOF
caught MQ6 webhook-retraction.test.mjs

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
