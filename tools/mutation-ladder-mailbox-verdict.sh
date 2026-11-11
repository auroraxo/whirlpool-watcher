#!/usr/bin/env bash
# PULS P mutation ladder — every guard in the mailbox-verdict contract must
# catch its own mutation, and the tree must come back byte-identical.
#
# A pin that passes no matter what the source says proves nothing. Six
# mutations, one per face the tool measured (or a guard's opposite):
#
#   M1 verdictOf maps every non-3 exit to COMPLETE (the pre-fix rule)
#      -> X1/X3/X4 RED (a refused mailbox reported COMPLETE)
#   M2 verdictOf maps an unspawnable mailbox (null) to COMPLETE
#      -> X2 RED
#   M3 exitFor returns 0 for a REFUSED verdict (the exit code lies even
#      though the field is right)
#      -> X1/X3/X4 RED
#   M4 exitFor returns 0 for an UNAVAILABLE verdict
#      -> X2 RED
#   M5 the refused-and-empty run saves the ledger anyway (state is minted
#      by a run that never happened)
#      -> X5 RED
#   M6 verdictOf maps the OWED exit (3) to COMPLETE (the owed guard's
#      opposite)
#      -> GX2 RED
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
BACKUP=$(mktemp /tmp/ww-ladder-p-cli.XXXXXX)
BACKUP2=$(mktemp /tmp/ww-ladder-p-lib.XXXXXX)
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

# --- M1: every non-3 exit is COMPLETE again ---------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/cli.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace("  if (mailboxExit === 3) return 'OWED';\n  return 'REFUSED';",
  "  if (mailboxExit === 3) return 'OWED';\n  return 'COMPLETE'; // mutated");
fs.writeFileSync(f, s);
EOF
caught M1 mailbox-verdict.test.mjs

# --- M2: an unspawnable mailbox is COMPLETE ---------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/cli.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace("  if (mailboxExit === null || mailboxExit === undefined) return 'UNAVAILABLE';",
  "  if (mailboxExit === null || mailboxExit === undefined) return 'COMPLETE'; // mutated");
fs.writeFileSync(f, s);
EOF
caught M2 mailbox-verdict.test.mjs

# --- M3: a REFUSED verdict still exits 0 ------------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/cli.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace("  if (verdict === 'UNAVAILABLE') return 2;\n  return 3;",
  "  if (verdict === 'UNAVAILABLE') return 2;\n  return 0; // mutated");
fs.writeFileSync(f, s);
EOF
caught M3 mailbox-verdict.test.mjs

# --- M4: an UNAVAILABLE verdict still exits 0 -------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/cli.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace("  if (verdict === 'UNAVAILABLE') return 2;",
  "  if (verdict === 'UNAVAILABLE') return 0; // mutated");
fs.writeFileSync(f, s);
EOF
caught M4 mailbox-verdict.test.mjs

# --- M5: a refused-and-empty run saves the ledger anyway --------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('  if (mailboxRefused && rows.length === 0) {',
  '  if (false && mailboxRefused && rows.length === 0) { // mutated');
fs.writeFileSync(f, s);
EOF
caught M5 mailbox-verdict.test.mjs

# --- M6: the OWED verdict is COMPLETE --------------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/cli.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace("  if (mailboxExit === 3) return 'OWED';",
  "  if (mailboxExit === 3) return 'COMPLETE'; // mutated");
fs.writeFileSync(f, s);
EOF
caught M6 mailbox-verdict.test.mjs

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
