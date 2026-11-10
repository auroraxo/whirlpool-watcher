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
//   3 = something is owed or refused (pending payload, unverifiable event,
//       blocked retraction) — silence is not health
//   2 = the consumer could not run at all (missing binary, bad arguments)
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
  // would report "no fills" as if that were a fact about the chain.
  const owed = r.exit === 3;
  report({
    mode: 'tail',
    rows: r.rows,
    fills: r.legs,
    duplicates_ignored: r.dupes,
    invalid_events: r.invalid,
    open_fills: Object.keys(r.ledger.fills).length,
    mailbox_exit: r.exit,
    verdict: owed ? 'OWED' : 'COMPLETE',
  });
  if (r.stderr) console.error(r.stderr.trim());
  process.exit(owed ? 3 : 0);
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
  const undoable = r.retractions.filter((x) => x.undoable_fills.length);
  report({
    mode: 'retract',
    retractions: r.retractions.length,
    undoable: undoable.length,
    undone_fills: undoable.reduce((n, x) => n + x.undoable_fills.length, 0),
    open_fills: Object.keys(loadLedger(ledgerPath).fills).length,
    mailbox_exit: r.exit,
  });
  if (r.stderr) console.error(r.stderr.trim());
  // A retraction that this consumer cannot act on is not health either.
  process.exit(r.exit === 3 ? 3 : 0);
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
