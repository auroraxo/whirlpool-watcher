#!/usr/bin/env node
// CLI entry point for whirlpool-watcher.
//
//   node src/whirlpool-watcher.mjs tail \
//        --db /path/reeflog.db --cursor /tmp/watcher-cursor.txt \
//        --ledger /tmp/fills.json [--bin ./reeflog] [--limit 5000]
//
//   node src/whirlpool-watcher.mjs retract \
//        --db /path/reeflog.db --cursor /tmp/reorg-cursor.txt \
//        --ledger /tmp/fills.json [--bin ./reeflog]
//
//   node src/whirlpool-watcher.mjs webhook \
//        --port 8787 --secret whsec_... --ledger /tmp/fills.json
//
// Exit codes, same discipline as reeflog itself:
//   0 = the mailbox is complete for what this consumer needed
//   2 = the consumer could not run at all (missing binary, bad arguments)
//   3 = something is owed or refused (pending payload, unverifiable event,
//       blocked retraction, a mailbox that refused) — silence is not health
// PULS P: `verdict` is the MAILBOX's verdict, carried, never stamped here.
//   COMPLETE (mailbox exit 0) | OWED (exit 3) | REFUSED (any other exit,
//   e.g. reeflog's named refusals exit 1) | UNAVAILABLE (no exit at all:
//   the mailbox binary could not be spawned — a missing mailbox is exit 2,
//   the consumer's own documented "could not run at all" class).
import path from 'node:path';
import fs from 'node:fs';
import {
  watchTail, watchRetractions, runWebhookReceiver, loadLedger, saveLedger,
  absorbRow, parkRows,
} from './whirlpool-watcher.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(k);

const mode = process.argv[2];
const ledgerPath = arg('--ledger', path.join('/tmp', 'whirlpool-fills.json'));

function report(obj) {
  console.log(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

// PULS P — the verdict is the MAILBOX's, carried, never stamped here.
// reeflog's own exit codes: 0 = owes nothing for this pass, 1 = a named
// refusal (die()), 3 = payloads owed, 64 = usage, null = never spawned.
// Anything that is not an explicit 0 or 3 is NOT health: a watcher that
// reports COMPLETE over a dead mailbox measures nothing and says it did.
function verdictOf(mailboxExit) {
  if (mailboxExit === null || mailboxExit === undefined) return 'UNAVAILABLE';
  if (mailboxExit === 0) return 'COMPLETE';
  if (mailboxExit === 3) return 'OWED';
  return 'REFUSED';
}

// Consumer exit: the mailbox verdict rides through the CLI's documented
// exit-code contract — 2 only when the mailbox could not run at all
// (missing binary), 3 for anything owed OR refused, 0 for genuine
// completeness.
function exitFor(verdict) {
  if (verdict === 'COMPLETE') return 0;
  if (verdict === 'UNAVAILABLE') return 2;
  return 3;
}

if (mode === 'tail') {
  const db = arg('--db');
  const cursor = arg('--cursor', path.join('/tmp', 'whirlpool-cursor.txt'));
  const bin = arg('--bin', 'reeflog');
  if (!db) { console.error('tail needs --db'); process.exit(2); }
  let r;
  try {
    r = await watchTail({ db, cursor, bin, limit: Number(arg('--limit', '5000')), ledgerPath });
  } catch (err) {
    // A refusal is not a crash: exit 3 says "something is owed or refused",
    // which is the same contract the mailbox uses. The message names the
    // defect, the parked rows and the repair.
    if (err && err.isRefusal) { console.error(err.message); process.exit(3); }
    throw err;
  }
  // reeflog's own exit code carries the mailbox's verdict: 3 = the journal
  // still owes payloads (pending/unavailable). A consumer that ignores it
  // would report "no fills" as if that were a fact about the chain. PULS P
  // closes the mirror face: exit 1 (a NAMED REFUSAL inside the mailbox —
  // no journal, foreign cursor) and a mailbox that never spawned (null)
  // were both reported COMPLETE with exit 0.
  const verdict = verdictOf(r.exit);
  report({
    mode: 'tail',
    rows: r.rows,
    fills: r.legs,
    duplicates_ignored: r.dupes,
    invalid_events: r.invalid,
    open_fills: Object.keys(r.ledger.fills).length,
    // PULS O: "applied" means this run hit a freshness clash and performed
    // the repair its own refusal names (reload the durable copy, merge, save)
    // — the fills of both instances are durable without a human rescue step.
    // null means no clash happened; a refusal that could NOT be repaired
    // ends in exit 3 with the rows parked, never here.
    merge_repair: r.mergeRepaired ? 'applied' : null,
    mailbox_exit: r.exit,
    verdict,
  });
  if (r.stderr) console.error(r.stderr.trim());
  // PULS O: a self-repaired clash is not an error, but it is not silence
  // either — the operator must be able to see that two instances collided.
  if (r.mergeNote) console.error(`whirlpool-watcher: merge repair applied after: ${r.mergeNote.replace(/\s+/g, ' ')}`);
  // PULS P: UNAVAILABLE is the documented exit 2 ("the consumer could not
  // run at all"); REFUSED and OWED both ride exit 3 ("something is owed or
  // refused — silence is not health").
  process.exit(exitFor(verdict));
}

if (mode === 'retract') {
  const db = arg('--db');
  const cursor = arg('--cursor', path.join('/tmp', 'whirlpool-reorg-cursor.txt'));
  const bin = arg('--bin', 'reeflog');
  if (!db) { console.error('retract needs --db'); process.exit(2); }
  let r;
  try {
    r = await watchRetractions({ db, cursor, bin, limit: Number(arg('--limit', '1000')), ledgerPath });
  } catch (err) {
    if (err && err.isRefusal) { console.error(err.message); process.exit(3); }
    throw err;
  }
  const retractions = r.retractions.filter((x) => x.undoable_fills.length);
  // PULS P: the retraction pass carried the mailbox exit code in a field
  // but decided health only by "did a retraction undo something" — a
  // mailbox that died (exit 1) or never ran (null) answered exit 0 with an
  // empty array read as health. The same verdict rule as tail mode.
  const verdict = verdictOf(r.exit);
  report({
    mode: 'retract',
    retractions: r.retractions.length,
    undoable: retractions.length,
    undone_fills: retractions.reduce((n, x) => n + x.undoable_fills.length, 0),
    open_fills: Object.keys(loadLedger(ledgerPath).fills).length,
    merge_repair: r.mergeRepaired ? 'applied' : null,
    mailbox_exit: r.exit,
    verdict,
  });
  if (r.stderr) console.error(r.stderr.trim());
  if (r.mergeNote) console.error(`whirlpool-watcher: merge repair applied after: ${r.mergeNote.replace(/\s+/g, ' ')}`);
  // A retraction that this consumer cannot act on is not health either —
  // and a mailbox that refused is not a retraction pass at all. verdict
  // alone decides: UNAVAILABLE -> 2, COMPLETE -> 0, OWED/REFUSED -> 3.
  process.exit(exitFor(verdict));
}

// Rescue mode: absorb rows that were PARKED by a ledger refusal. The
// mailbox had already advanced its cursor past them, so reeflog will not
// redeliver them; this is the documented repair.
if (mode === 'rescue') {
  const file = arg('--file');
  if (!file) { console.error('rescue needs --file'); process.exit(2); }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`rescue: cannot read ${file}: ${e.code || e}`);
    process.exit(2);
  }
  const rows = raw.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  let ledger;
  try {
    ledger = loadLedger(ledgerPath);
  } catch (err) {
    if (err && err.isRefusal) { console.error(err.message); process.exit(3); }
    throw err;
  }
  let legs = 0, dupes = 0;
  for (const row of rows) {
    const r = absorbRow(ledger, row);
    legs += r.fills; dupes += r.dupes;
  }
  try {
    saveLedger(ledgerPath, ledger);
  } catch (err) {
    if (err && err.isRefusal) { console.error(err.message); process.exit(3); }
    throw err;
  }
  report({
    mode: 'rescue',
    parked_rows: rows.length,
    fills: legs,
    duplicates_ignored: dupes,
    open_fills: Object.keys(ledger.fills).length,
    verdict: 'COMPLETE',
  });
  process.exit(0);
}

if (mode === 'webhook') {
  const port = Number(arg('--port', '8787'));
  const secret = arg('--secret');
  if (!secret) { console.error('webhook needs --secret'); process.exit(2); }
  const server = await runWebhookReceiver({
    port, secret, ledgerPath, log: (e) => console.log(JSON.stringify(e)),
  });
  console.log(`whirlpool-watcher listening on 127.0.0.1:${port}, ledger ${ledgerPath}`);
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else if (mode !== undefined) {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
