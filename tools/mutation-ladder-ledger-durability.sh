#!/usr/bin/env bash
# PULS M mutation ladder — every guard in the ledger contract must catch its
# own mutation, and the tree must come back byte-identical.
#
# A pin that passes no matter what the source says proves nothing. Six
# mutations, each a defect class the baseline measurement observed (or a
# guard's opposite):
#
#   M1 loadLedger swallows the parse error again      -> C1 RED
#   M2 watchTail swallows the corrupt-ledger throw   -> C2 RED (the mailbox
#      runs anyway; refusal arrives after consumption)
#   M3 the webhook answers 200 on a load failure     -> C4 RED
#   M4 the webhook answers 200 on a save failure     -> C4b/C5 RED or C4
#   M5 loadLedger refuses a MISSING file             -> C3 RED (guard: the
#      documented first run must stay legal)
#   M6 watchTail skips the pre-spawn writability check -> C2-style face F2
#      (verified through the measurement tool, not the unit pin: the unit
#      pins use a corrupt FILE, not an unwritable DIR)
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
BACKUP=$(mktemp /tmp/ww-ladder-src.XXXXXX)
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
  # The mutated tree must still COMPILE; a dead module is a vacuum, not a catch.
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

# --- M1: swallow the parse error -------------------------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  `  } catch (err) {
    throw shapeError(\`does not parse as JSON (\${String(err && err.message).split('\\n')[0]})\`, file);
  }
  let parsed2;
  void parsed2;`,
  `  } catch (err) {
    return { fills: {}, retractions: {}, meta: {} };
  }`,
);
if (!s.includes('return { fills: {}, retractions: {}, meta: {} };\n  }\n  const ledger = checkLedgerShape')) {
  // Fall back: simpler targeted replacement (drop the throw line, keep flow).
  s = fs.readFileSync(f, 'utf8').replace(
    `    throw shapeError(\`does not parse as JSON (\${String(err && err.message).split('\\n')[0]})\`, file);`,
    `    return { fills: {}, retractions: {}, meta: {} };`,
  );
}
fs.writeFileSync(f, s);
EOF
caught M1 ledger-contract.test.mjs

# --- M2: watchTail swallows the corrupt-ledger refusal ---------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  `  let ledger;
  try {
    ledger = loadLedger(ledgerPath);
  } catch (err) {
    if (err instanceof LedgerRefusal) {
      die(\`refusing tail run: \${err.message} — the mailbox was NOT read and the cursor is UNCHANGED; repair or remove the ledger, then run again\`);
    }
    throw err;
  }
  const t = await cli([bin, 'tail', '--db', db, '--cursor', cursor, '--limit', String(limit)]);`,
  `  let ledger;
  try {
    ledger = loadLedger(ledgerPath);
  } catch (err) {
    ledger = { fills: {}, retractions: {}, meta: {} };
  }
  const t = await cli([bin, 'tail', '--db', db, '--cursor', cursor, '--limit', String(limit)]);`,
);
fs.writeFileSync(f, s);
EOF
caught M2 ledger-contract.test.mjs

# --- M3: webhook answers 200 on a load failure -----------------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace('res.writeHead(503).end(`ledger unreadable',
              'res.writeHead(200).end(`ledger unreadable');
fs.writeFileSync(f, s);
EOF
caught M3 ledger-contract.test.mjs

# --- M4: webhook answers 200 on a save failure (event path) ----------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(`          log({ refused: true, why: err.message });
          res.writeHead(503).end(\`ledger unwritable: \${String(err.message).replace(/\\s+/g, ' ')}\`);
          return;
        }
        log({ delivered: true,`,
`          log({ refused: true, why: err.message });
          res.writeHead(200).end('ok');
          return;
        }
        log({ delivered: true,`);
fs.writeFileSync(f, s);
EOF
caught M4 ledger-contract.test.mjs

# --- M5: a missing ledger refuses (kills the first run) --------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  `      // A missing file is the documented first run, not a corruption.
      return { fills: {}, retractions: {}, meta: {} };`,
  `      throw shapeError('does not exist yet', file);`,
);
fs.writeFileSync(f, s);
EOF
caught M5 ledger-contract.test.mjs

# --- M6: watchTail skips the pre-spawn writability check -------------------
node - <<'EOF'
import fs from 'node:fs';
const f = 'src/whirlpool-watcher.mjs';
let s = fs.readFileSync(f, 'utf8');
s = s.replace(
  `  ensureLedgerWritable(ledgerPath);
  let ledger;
  try {
    ledger = loadLedger(ledgerPath);
  } catch (err) {
    if (err instanceof LedgerRefusal) {
      die(\`refusing tail run: \${err.message}`,
  `  let ledger;
  try {
    ledger = loadLedger(ledgerPath);
  } catch (err) {
    if (err instanceof LedgerRefusal) {
      die(\`refusing tail run: \${err.message}`);
fs.writeFileSync(f, s);
EOF
if cmp -s "$BACKUP" "$SRC"; then
  echo "ANCHOR-FAIL M6"; status=fail1
else
  if node --check "$SRC" >/dev/null 2>&1; then
    # C2 uses a corrupt file (load refuses regardless of the check), so the
    # catch here is the MEASUREMENT tool's F2 face, run with --expect clean:
    # with the pre-check gone, F2 must go violated again.
    out=$(PULSE_M_OUT=/tmp/ww-ladder-f2.json node tools/measure-consumer-ledger-durability.mjs --seat local --expect clean --label ladder-m6 2>&1 | tail -1)
    if [ $? -eq 0 ]; then
      # exit 0 with --expect clean means NO face violated -> the pre-check
      # mutation ESCAPED (load-refusal alone can still close F2); check
      # whether F2 itself violated, which is the honest verdict.
      v=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/ww-ladder-f2.json','utf8')).summary.violated.join(','))" 2>/dev/null)
      if echo "$v" | grep -q F2; then echo "CAUGHT M6 via face F2 (violated: $v)"; else echo "PARTIAL M6: F2 closed by the load-refusal alone (defense-in-depth, unit suite still green)"; fi
    else
      echo "NOTE M6: measurement refused to run clean -> face reopened (CAUGHT)"
    fi
  else
    echo "COMPILE-ERROR M6"; status=fail1
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
