#!/usr/bin/env bash
# PULS Y mutation ladder — the crossing must have FANGS.
#
# The defect PULS Y measured: the mailbox's two channels CROSS. reeflog
# delivers events by `seq` and retractions by `reorg_id` — two independent
# orders — so a retraction can be delivered BEFORE the event it undoes. The
# pre-fix consumer answered "no such fill", dropped the verdict into a
# counter, and let the mailbox move past it; the fill arrived later and was
# booked OPEN forever, although the chain had reverted it.
#
# Every face of the new contract gets one mutation that MUST turn its test
# red:
#
#   M1 absorbRow stops consulting the pending verdicts
#      -> Y1 RED (the fill opens again beside a verdict that will never
#         redeliver)
#   M2 the webhook receiver stops recording the pending verdict
#      -> Y1 RED (the verdict is dropped into a counter again)
#   M3 the retract channel stops recording the pending verdict
#      -> Y2 RED (the reorg cursor moves past the verdict)
#   M4 the pending verdicts are consumed but the join never runs
#      -> Y1 RED (the fill stays open; only the verdict vanishes)
#   M5 the pending verdict is consumed WITHOUT the fill being booked first
#      -> Y1 RED (the join has nothing to undo: the fill is lost instead)
#   M6 a pending verdict for an UNKNOWN signature is not stored
#      -> Y3 RED (the report-only path is the pre-fix behaviour)
#   M7 the pending verdict list is not unioned by the merge
#      -> Y1 RED through the merge path (a concurrent writer's verdict is
#         dropped)
#
# Rules this ladder enforces on ITSELF:
#  * the mutation must COMPILE — a TypeError at import is not a fang;
#  * the mutation must actually change the file (cmp against the
#    pre-mutation byte-copy) or it is ANCHOR-FAIL, not CAUGHT;
#  * restore is a byte-copy cp, never `git checkout`;
#  * a VACUUM-GATE: a test run that produced no fail-count is not a catch;
#  * after the ladder the full suite must be green and the sources
#    byte-identical.

set -u
cd "$(dirname "$0")/.."
SRC=src/whirlpool-watcher.mjs
CLI=src/cli.mjs
TEST=test/retraction-crossing.test.mjs
BACKUP=$(mktemp /tmp/ww-ladder-y-lib.XXXXXX)
BACKUP2=$(mktemp /tmp/ww-ladder-y-cli.XXXXXX)
restore() { cp "$BACKUP" "$SRC"; cp "$BACKUP2" "$CLI"; }
trap restore EXIT
cp "$SRC" "$BACKUP"
cp "$CLI" "$BACKUP2"

status=fail0
caught() {
  local name="$1" test="$2"
  if cmp -s "$BACKUP" "$SRC" && cmp -s "$BACKUP2" "$CLI"; then
    echo "ANCHOR-FAIL $name: mutation changed nothing (pattern not found)"
    status=fail1
    return
  fi
  if ! node --check "$SRC" >/dev/null 2>&1 || ! node --check "$CLI" >/dev/null 2>&1; then
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

# --- M1: absorbRow stops consulting the pending verdicts --------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  "    for (const sig of rowSignatures) {\n      if (pendingSignatureVerdict(ledger, sig)) {",
  "    for (const sig of rowSignatures) {\n      if (false && pendingSignatureVerdict(ledger, sig)) { // mutated");
fs.writeFileSync(f, s);
EOF
caught M1 retraction-crossing.test.mjs

# --- M2: the webhook receiver stops recording the pending verdict -----------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  "          recordPendingVerdict(ledger, payload);",
  "          // mutated: the webhook drops the verdict into the counter only");
fs.writeFileSync(f, s);
EOF
caught M2 retraction-crossing.test.mjs

# --- M3: the retract channel stops recording the pending verdict ------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  "    if (undoable && undoable.undoable_fills.length === 0 && recordPendingVerdict(ledger, row)) {",
  "    if (false && undoable && undoable.undoable_fills.length === 0 && recordPendingVerdict(ledger, row)) { // mutated");
fs.writeFileSync(f, s);
EOF
caught M3 retraction-crossing.test.mjs

# --- M4: the pending verdict is consumed but the join never runs ------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  "        applyRetractions(ledger, consumePendingVerdicts(ledger, sig));",
  "        consumePendingVerdicts(ledger, sig); // mutated: the join never runs");
fs.writeFileSync(f, s);
EOF
caught M4 retraction-crossing.test.mjs

# --- M5: the verdict is consumed WITHOUT the fill being booked first --------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  "      ledger.fills[dedupKey] = { ...f, recorded_at: Date.now() };\n      rowSignatures.add(f.signature);",
  "      // mutated: fill never booked before the join\n      rowSignatures.add(f.signature);");
fs.writeFileSync(f, s);
EOF
caught M5 retraction-crossing.test.mjs

# --- M6: a pending verdict for an unknown signature is not stored -----------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  "  const pending = (ledger.meta.retractions_pending = ledger.meta.retractions_pending || []);\n  const existing = pending.find((p) => p.signature === row.signature);",
  "  if (true) return false; // mutated: the unknown-signature verdict is dropped\n  const pending = (ledger.meta.retractions_pending = ledger.meta.retractions_pending || []);\n  const existing = pending.find((p) => p.signature === row.signature);");
fs.writeFileSync(f, s);
EOF
caught M6 retraction-crossing.test.mjs

# --- M7: the merge drops the pending verdicts --------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  "  const dp = Array.isArray(diskMeta?.retractions_pending) ? diskMeta.retractions_pending : [];",
  "  return merged; // mutated: retractions_pending merge is skipped\n  const dp = Array.isArray(diskMeta?.retractions_pending) ? diskMeta.retractions_pending : [];");
fs.writeFileSync(f, s);
EOF
caught M7 retraction-crossing.test.mjs

# --- restore + suite gates --------------------------------------------------
if cmp -s "$BACKUP" "$SRC" && cmp -s "$BACKUP2" "$CLI"; then
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
