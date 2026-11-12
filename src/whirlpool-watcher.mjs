// whirlpool-watcher: an out-of-tree consumer of the reeflog mailbox.
//
// Why this process exists
// -----------------------
// reeflog's open qualification list says, verbatim: "user zero: my own RFQ
// fill polling and Whirlpool watcher on `reeflog tail` — the prototype
// proves the mailbox, but production glue still polls." This repository is
// that Whirlpool watcher as a REAL consumer: it is not part of reeflog, it
// does not import reeflog's harnesses, it links no reeflog code, and every
// fact it uses about the chain was verified from its own side (the event
// layout was decoded live from mainnet `Program data:` lines and pinned
// against the transaction's pre/postTokenBalances).
//
// What it does
// ------------
//  - `tail` mode:   spawns `reeflog tail --db --cursor`, decodes Whirlpool
//                   `Traded` events from the delivered rows, appends them to
//                   a durable fill ledger, and exits 3 when the mailbox
//                   reports debt (pending/unavailable payloads) — silence is
//                   never health.
//  - `webhook` mode: runs a local HTTP receiver, verifies the
//                   `X-Reeflog-Signature` HMAC on every delivery byte-for-
//                   byte with node:crypto, dedups on the stable delivery id,
//                   answers 2xx only after the fill is durably recorded —
//                   and runs the retraction join on `type: "reorg"`
//                   deliveries (PULS Q: the ACK of a reorg means the fill
//                   was undone, not merely that the event was counted).
//  - `retract` mode: joins the `reeflog reorg tail` channel against the fill
//                   ledger — only fills THIS consumer read are marked undone;
//                   unknown signatures are reported, never turned into an
//                   unfill of somebody else's fill.
//
// What it never does
// ------------------
//  - no RPC calls of its own (that is the point; measured in e2e),
//  - no guessed decode: a `Program data:` line that is not Traded is
//    `other`; a Traded line with a wrong size is `invalid` and is reported,
//  - no silent drop: counts of rows/legs it could not read land in the
//    ledger and the run report.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { tradesFromRow, WHIRLPOOL_PROGRAM } from './decode.mjs';

const bigintReplacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);

// The consumer's refusal voice: `die` throws a named refusal that the CLI
// turns into an exit code and a clean message instead of a stack trace.
// Throwing is the contract: every mode turns a LedgerRefusal into an exit-3
// refusal or a 503, so the mailbox keeps its at-least-once promise.
// Swallowing it is the defect PULS M measured on the published reeflog
// v0.7.14 seat (2026-11-10, research/consumer-ledger-durability-*.json):
// a corrupt ledger was silently replaced by a fresh empty one behind a
// COMPLETE report (F1), fills died with no report after the mailbox cursor
// had advanced (F2), and the webhook answered 200 ok over an erased
// history (F4).
export function die(message) {
  const err = new LedgerRefusal(message);
  err.isRefusal = true;
  throw err;
}

export class LedgerRefusal extends Error {}

function cli(args) {
  return new Promise((resolve) => {
    const c = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    c.stdout.on('data', (d) => { o += d; });
    c.stderr.on('data', (d) => { e += d; });
    // 'close', not 'exit': exit can fire while piped stdout is still unread,
    // which silently truncates the delivered rows. Measured inside reeflog's
    // own harnesses 2026-10-29; re-learned here from the same failure mode.
    c.on('close', (code) => resolve({ code, out: o, err: e }));
    c.on('error', (err) => resolve({ code: null, out: o, err: `${e}\n${err}` }));
  });
}

// --- the ledger ------------------------------------------------------------

function shapeError(why, file) {
  return new LedgerRefusal(`ledger ${file} ${why}; refusing to guess the history (repair or remove the file by hand — the file is UNCHANGED)`);
}

function checkLedgerShape(ledger, file) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw shapeError('does not hold a JSON object', file);
  }
  for (const key of ['fills', 'retractions', 'meta']) {
    const v = ledger[key];
    if (v === undefined) continue;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw shapeError(`holds \`${key}\` as ${Array.isArray(v) ? 'an array' : typeof v}, expected an object`, file);
    }
  }
  return ledger;
}

export function loadLedger(file) {
  let raw;
  let existed = true;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // A missing file is the documented first run, not a corruption.
      existed = false;
    } else {
      throw new LedgerRefusal(`ledger ${file} cannot be read: ${err && err.code ? err.code : err}; refusing to start without the history`);
    }
  }
  let ledger;
  if (!existed) {
    ledger = { fills: {}, retractions: {}, meta: {} };
  } else {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw shapeError(`does not parse as JSON (${String(err && err.message).split('\n')[0]})`, file);
    }
    ledger = checkLedgerShape(parsed, file);
    ledger = {
      fills: ledger.fills || {},
      retractions: ledger.retractions || {},
      meta: ledger.meta || {},
    };
  }
  // PULS N: remember WHAT was on disk when this instance read it, so a
  // later save can prove its view is still current. Non-enumerable: it is
  // bookkeeping, never serialized content.
  Object.defineProperty(ledger, LOADED_MARKER, {
    value: existed ? raw : null,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return ledger;
}

// The freshness marker key (non-enumerable on every ledger loadLedger
// returns). It holds the exact disk bytes at read time, or null when the
// file did not exist (documented first run).
const LOADED_MARKER = '__onDiskAtLoad';

// PULS N — one watcher instance per ledger file, or the history is someone
// else's guess. Two faces, measured on the pre-fix tree (7 RED pins in
// test/ledger-concurrency.test.mjs):
//   * the stage/probe files carried FIXED names (`${file}.tmp`,
//     `${file}.writability-probe`): two instances (or a crashed older one)
//     opened the same temp by name — one instance's rename stole the other's
//     staged file, and the survivor wrote foreign bytes over the payload.
//     The same torn-write window PULS L closed for the reeflog cursor,
//     reopened on the consumer side by naming the temp after the payload.
//   * a save never checked whether the file changed since THIS instance
//     read it: a late writer silently reverted the ledger to an older
//     history behind its own exit 0 — the lost update.
// The repair contract: pid-unique staging (no two writers ever share a temp
// path), a freshness refusal that names the concurrent writer and promises
// the file is UNCHANGED, and a real merge (mergeLedger) as the named fix.
function markLoaded(diskBytes, ledger) {
  Object.defineProperty(ledger, LOADED_MARKER, {
    value: diskBytes,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return ledger;
}

function freshnessRefusal(file, why) {
  const err = new LedgerRefusal(
    `ledger ${file}: ${why} — refusing to overwrite; the file is UNCHANGED; ` +
    'repair: load the current ledger, mergeLedger(disk, this view), then save again ' +
    '(rows this run consumed are parked for `node src/cli.mjs rescue`)');
  // Same convention as die(): the CLI maps this to exit 3 (tail/retract)
  // and the webhook maps it to 503, so the mailbox keeps what it owes.
  err.isRefusal = true;
  // PULS O: a freshness clash is the ONE refusal the consumer can repair
  // itself — the durable disk copy and this view can be merged without any
  // human decision (the file is readable and writable; only the VIEW is
  // old). Every other refusal (unwritable storage, corrupt history) is
  // NOT repairable by merging and must stay a refusal.
  err.freshness = true;
  return err;
}

function checkFreshness(file, ledger) {
  const expected = ledger[LOADED_MARKER];
  if (expected === undefined) {
    // A hand-built object never came from loadLedger: nothing to compare
    // against. The product paths (tail/retract/webhook/rescue) ALWAYS load
    // before saving, so the measured lost-update faces are all marked —
    // refusing here would break documented construction, not clobbering.
    return;
  }
  let current;
  let exists = true;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') { exists = false; } else { return; }
  }
  const state = expected === null ? 'absent' : 'present';
  if (state === 'absent' && exists) {
    throw freshnessRefusal(file,
      'this instance read the ledger as ABSENT, but a concurrent writer created it since');
  }
  if (state === 'present' && !exists) {
    throw freshnessRefusal(file,
      'this instance read the ledger as present, but it is gone from disk (removed concurrently)');
  }
  if (state === 'present' && current !== expected) {
    throw freshnessRefusal(file,
      'the file changed on disk since this instance read it (another whirlpool-watcher instance saved concurrently)');
  }
}

// Meta entries that are REPORTS (lists), not maps. A spread-union over a
// list keeps only one side's list: the durable disk copy's
// `failed_transactions` replaced this instance's, so every failure report
// only THIS side had was silently dropped by the merge — the ledger kept
// the fills and lost the account of what went wrong. PULS O measured it
// (MR2). These lists are unioned by (seq, signature): the same report seen
// by both sides must not appear twice.
const META_REPORT_LISTS = ['failed_transactions', 'invalid_events'];

function reportKey(entry) {
  if (!entry || typeof entry !== 'object') return String(entry);
  return `${entry.seq}:${entry.signature}`;
}

function mergeMeta(diskMeta, myMeta) {
  const merged = { ...myMeta, ...diskMeta };
  for (const key of META_REPORT_LISTS) {
    const diskList = Array.isArray(diskMeta?.[key]) ? diskMeta[key] : [];
    const myList = Array.isArray(myMeta?.[key]) ? myMeta[key] : [];
    if (!diskList.length && !myList.length) {
      if (diskMeta?.[key] === undefined && myMeta?.[key] === undefined) delete merged[key];
      continue;
    }
    const seen = new Map();
    for (const e of diskList) seen.set(reportKey(e), e);
    for (const e of myList) {
      if (!seen.has(reportKey(e))) seen.set(reportKey(e), e);
    }
    merged[key] = [...seen.values()];
  }
  return merged;
}

// The documented repair for a freshness refusal: union of both instances'
// fills and retractions, the DURABLE disk copy winning per key (it was
// already delivered to whoever consumed the ledger). The result keeps the
// disk view's freshness, so saving it re-checks against the same state —
// a writer that landed in between still refuses.
//
// PULS O: two rules this merge was missing, both measured:
//   * a retraction is a DELETION of a fill. A spread-union cannot express
//     that — the disk copy's fill would resurrect a key the other side
//     retracted (MR3). Retractions win over fills.
//   * the meta REPORTS are lists, not maps: a plain spread kept only the
//     disk side and dropped every failure/invalid report only this side
//     had (MR2).
export function mergeLedger(diskLedger, mine) {
  const fills = { ...mine.fills, ...diskLedger.fills };
  const retractions = { ...mine.retractions, ...diskLedger.retractions };
  // Retractions win: a key either side undid is not an open fill.
  for (const key of Object.keys(retractions)) delete fills[key];
  const merged = {
    fills,
    retractions,
    meta: mergeMeta(diskLedger.meta || {}, mine.meta || {}),
  };
  const marker = Object.getOwnPropertyDescriptor(diskLedger, LOADED_MARKER);
  if (marker) Object.defineProperty(merged, LOADED_MARKER, marker);
  return merged;
}

// PULS O — the refusal named this repair, so the consumer performs it
// ITSELF instead of waiting for a human to notice a parked file.
//
// The freshness refusal is the one failure where both sides are known and
// mergeable: the durable disk copy and this instance's view. Merging them
// loses nothing (the disk copy wins per key, this side's unique fills are
// added, retractions win over fills) and keeps the at-least-once promise:
// the rows this run consumed ARE in the merged ledger.
//
// Anything else stays a refusal: an unwritable directory or a corrupt
// ledger cannot be merged away — those keep the PULS M contract (refuse,
// park, exit 3 / 503).
//
// Returns {repaired: bool, ledger}. On a second refusal (a third writer
// landed between the reload and the save) the refusal propagates: the
// caller then parks the rows, exactly as before.
export function saveLedgerWithRepair(file, ledger) {
  try {
    saveLedger(file, ledger);
    return { repaired: false, ledger };
  } catch (err) {
    if (!(err instanceof LedgerRefusal) || !err.freshness) throw err;
    let disk;
    try {
      disk = loadLedger(file);
    } catch {
      // The current file cannot even be read — merging is impossible.
      throw err;
    }
    const merged = mergeLedger(disk, ledger);
    // saveLedger re-checks freshness against the DISK bytes we just read
    // (the merge carries that marker), so this refuses too if a third
    // writer landed in between.
    saveLedger(file, merged);
    // The original refusal is returned so the CLI can NAME what happened:
    // a repair an operator never hears about is a silent concurrency
    // event, and silence is never health.
    return { repaired: true, ledger: merged, note: err.message };
  }
}

export function saveLedger(file, ledger) {
  // Validate BEFORE anything is written: a bad shape must never reach the
  // disk, not even briefly.
  checkLedgerShape(ledger, file);
  // PULS N: refuse a stale view BEFORE staging anything. The file is read
  // (never written) here; a refusal leaves it byte-identical.
  checkFreshness(file, ledger);
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new LedgerRefusal(`ledger ${file} cannot be staged: cannot create ${dir}: ${err && err.code ? err.code : err}; refusing to run without the history`);
  }
  // Stage under a name UNIQUE to this process: a fixed sibling made two
  // instances of this watcher open, truncate and swap the SAME temp —
  // one rename stole the other's staged file and the survivor wrote it
  // back over the payload (the C-N1 torn ledger). pid + file: no two
  // writers of the same ledger path ever share a temp path.
  const tmp = `${file}.${process.pid}.tmp`;
  let bytes;
  try {
    bytes = Buffer.from(JSON.stringify(ledger, bigintReplacer, 2));
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, bytes);
      // Flush to the disk BEFORE the swap: the rename makes the file visible
      // atomically, and this fsync makes the CONTENT survive a crash with it
      // (the same contract reeflog v0.7.14 holds for its own cursor).
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw new LedgerRefusal(`ledger write ${file}: ${err && err.code ? err.code : err} — the ledger file is UNCHANGED and the fills printed this run will REDLIVER only if the mailbox has not advanced; refusing to pretend they were recorded`);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw new LedgerRefusal(`ledger write ${file}: rename failed: ${err && err.code ? err.code : err} — the ledger file is UNCHANGED; refusing to pretend the history was recorded`);
  }
  // This instance now owns exactly these bytes on disk: refresh the mark so
  // its NEXT save re-checks against reality instead of refusing on its own
  // write (single-writer sequences must stay legal).
  markLoaded(bytes.toString('utf8'), ledger);
  // Best-effort directory fsync, like reeflog's own cursor swap.
  try {
    const d = fs.openSync(dir, 'r');
    try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  } catch { /* best effort */ }
}

// Check that the ledger CAN be written BEFORE the mailbox is read. This is
// the face the mailbox cannot protect: `reeflog tail` advances its cursor
// when it prints rows, so a consumer that discovers "I cannot save" only
// AFTER the spawn has already consumed delivery. Refusing before the spawn
// keeps the cursor where it is, and the rows redeliver — the at-least-once
// promise holds without needing the rescue file.
//
// The check touches NOTHING the ledger owns: it creates the directory like
// saveLedger would, stages a probe temp and removes it, and — only when a
// ledger FILE already exists — asks whether it is writable. An absent file
// is the documented first run, not a refusal.
export function ensureLedgerWritable(file) {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    die(`ledger ${file} cannot be staged: cannot create ${dir}: ${err && err.code ? err.code : err} — refusing to read the mailbox BEFORE any row is consumed; the cursor is UNCHANGED and rows will REDLIVER once storage is writable`);
  }
  const probe = `${file}.${process.pid}.writability-probe`;
  try {
    const fd = fs.openSync(probe, 'w');
    fs.closeSync(fd);
    fs.rmSync(probe, { force: true });
  } catch (err) {
    try { fs.rmSync(probe, { force: true }); } catch { /* best effort */ }
    die(`ledger ${file} cannot be staged in ${dir}: ${err && err.code ? err.code : err} — refusing to read the mailbox BEFORE any row is consumed; the cursor is UNCHANGED and rows will REDLIVER once storage is writable`);
  }
  if (fs.existsSync(file)) {
    try {
      fs.accessSync(file, fs.constants.W_OK);
    } catch (err) {
      die(`ledger ${file} exists but is not writable: ${err && err.code ? err.code : err} — refusing to read the mailbox BEFORE any row is consumed; the cursor is UNCHANGED and rows will REDLIVER once the file is writable`);
    }
  }
}

// Park rows that were already CONSUMED by the mailbox so a ledger refusal
// cannot silently drop them. The ledger directory may itself be the
// unwritable thing, so the rescue file goes to the OS temp dir with the
// ledger's basename embedded; the refusal names the exact path.
export function parkRows(rows, ledgerPath) {
  const base = path.basename(ledgerPath || 'ledger.json');
  const file = path.join(os.tmpdir(), `whirlpool-watcher-rescue-${base}-${Date.now()}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  return file;
}

// PULS X: park the unreadable LINES byte-verbatim. `parkRows` re-serialises
// objects — for a line that never became an object the bytes ARE the only
// surviving copy, so a repaired copy of somebody's truncation would mint a
// new "fact". These bytes go to disk exactly as they arrived.
export function parkLines(lines, ledgerPath) {
  const base = path.basename(ledgerPath || 'ledger.json');
  const file = path.join(os.tmpdir(), `whirlpool-watcher-unreadable-${base}-${Date.now()}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''));
  return file;
}

// PULS X — the delivery-line contract, one level below decode.mjs's
// "a consumer that silently drops `invalid` claims delivery it did not
// get". A line on a delivered channel that the consumer cannot read is
// DEBT: reeflog advances the cursor after printing every row, so a skipped
// line is lost forever and a row without identity mints a fill nothing can
// ever name or retract (applyRetractions joins on `signature`). The reader
// therefore collects defects and the run refuses over them; it never
// `continue`s past them. `null` means the row is readable and named.
function eventRowDefect(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return 'is not a JSON object';
  }
  if (typeof row.signature !== 'string' || row.signature === '') {
    return 'carries no `signature` — a fill without identity can never be deduped or retracted';
  }
  if (typeof row.seq !== 'number') {
    return 'carries no numeric `seq` — the delivery position is unknown';
  }
  return null;
}

function reorgRowDefect(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return 'is not a JSON object';
  }
  if (typeof row.signature !== 'string' || row.signature === '') {
    return 'carries no `signature` — a retraction that names no transaction cannot undo anything';
  }
  return null;
}

// Split a delivered stdout into lines and read EVERY one. Returns the rows
// that survived validation and the defects (ordinal, reason, verbatim
// bytes) for the rest. `kind` decides the row contract: event rows need
// `signature` + numeric `seq`; retraction rows need `signature`.
export function readDeliveryLines(stdout, kind) {
  const lines = String(stdout).split('\n').filter(Boolean);
  const rows = [];
  const defects = [];
  lines.forEach((line, i) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      defects.push({ ordinal: i + 1, why: `does not parse as JSON (${String(err && err.message).split('\n')[0]})`, line });
      return;
    }
    const bad = kind === 'reorg' ? reorgRowDefect(row) : eventRowDefect(row);
    if (bad) defects.push({ ordinal: i + 1, why: bad, line });
    else rows.push(row);
  });
  return { rows, defects };
}

// The refusal for unreadable DELIVERED lines: names the channel, each
// defect with its ordinal and bytes, the parked copy, and the truth that
// the mailbox will not redeliver. The message is the API — the run keeps
// what arrived intact (absorbed and saved) before refusing.
export function lineRefusal(channel, defects, parked) {
  const detail = defects
    .map((x) => `  line ${x.ordinal} ${x.why}: ${x.line.slice(0, 120)}`)
    .join('\n');
  return `refusing ${channel} run: ${defects.length} unreadable line(s) on delivered ${channel} output — a line the consumer cannot read is debt, not noise:\n${detail}\n` +
    `the unreadable lines are parked verbatim at ${parked} — the mailbox cursor already advanced past every line the mailbox printed, so reeflog will NOT redeliver them\n` +
    `intact rows from the same batch were absorbed and saved; repair the parked bytes by hand if the lost rows matter`;
}

// The refusal text for rows the mailbox already delivered (cursor advanced):
// names the defect, the parked file, and the repair command.
export function consumedRefusal(err, parked, rows, phase) {
  return `ledger refused during ${phase}: ${err.message}\n` +
    `${rows} delivered row(s) are parked at ${parked} — the mailbox cursor already advanced past them, so reeflog will NOT redeliver them\n` +
    `repair the ledger storage, then replay the parked rows:\n` +
    `  node src/cli.mjs rescue --file ${parked} --ledger <ledger>`;
}

// Turn one delivered row into ledger entries. `seq` is stored so a fill can
// be traced back to its delivery (and so the e2e can prove exactly-once).
//
// A FAILED transaction is not a fill. Measured 2026-10-31 on live mainnet:
// 4 of 25 sampled Whirlpool "trades" came from transactions with
// `meta.err` set (InstructionError[1,{Custom:13}] and friends). Their logs
// still contain the `Traded` event — the program emitted it before a LATER
// instruction failed — but the whole transaction was rolled back, so no
// token balance moved. A consumer that recorded those would book 16% phantom
// fills. reeflog ships `err` verbatim for exactly this reason; a row whose
// err is set is reported, not counted as a fill.
//
// A zero-amount trade is not a fill either: nothing was exchanged.
export function rowToFills(row) {
  const { trades, invalid } = tradesFromRow(row);
  const failed = row.err != null;
  const zero_amount = trades
    .filter((t) => t.input_amount === 0n && t.output_amount === 0n)
    .map((t) => ({ pool: t.whirlpool }));
  const fills = trades
    .filter((t) => !(t.input_amount === 0n && t.output_amount === 0n))
    .map((t) => ({
      signature: row.signature,
      seq: row.seq,
      slot: row.slot,
      seal: row.seal ?? null,
      err: row.err ?? null,
      pool: t.whirlpool,
      a_to_b: t.a_to_b,
      input: t.input_amount,
      output: t.output_amount,
      input_transfer_fee: t.input_transfer_fee,
      output_transfer_fee: t.output_transfer_fee,
      lp_fee: t.lp_fee,
      protocol_fee: t.protocol_fee,
      pre_sqrt_price: t.pre_sqrt_price,
      post_sqrt_price: t.post_sqrt_price,
    }));
  return { fills, invalid, failed, zero_amount };
}

export function absorbRow(ledger, row) {
  const { fills, invalid, failed, zero_amount } = rowToFills(row);
  let dupes = 0;
  // A row whose fill is ALREADY UNDONE (sitting in ledger.retractions) is a
  // redelivery of a consumed delivery, not a new fill. The dedup check used
  // to look at ledger.fills ONLY, so the rescue replay of an already-undone
  // row resurrected the fill beside its own retraction record (PULS Q2,
  // measured 2026-11-11: after a retract pass, rescue answered open_fills: 1
  // with exit 0 — open and undone both true).
  const retractedKeys = new Set(Object.keys(ledger.retractions || {}));
  let retracted_replays_ignored = 0;
  // A reverted transaction leaves no fill behind. It is recorded as an
  // event that happened, so the ledger can explain why a trade it saw in the
  // logs is not a fill.
  if (failed) {
    ledger.meta.failed_transactions = (ledger.meta.failed_transactions || []);
    ledger.meta.failed_transactions.push({
      seq: row.seq,
      signature: row.signature,
      err: row.err,
      trades_in_logs: fills.length + zero_amount.length,
    });
  }
  if (zero_amount.length) {
    ledger.meta.zero_amount_trades = (ledger.meta.zero_amount_trades || 0) + zero_amount.length;
  }
  if (!failed) {
    for (const f of fills) {
      // Dedup key: same signature, same pool, same decoded amounts = the same
      // leg (a tx may contain several Traded events from different pools).
      const dedupKey = `${f.signature}:${f.pool}:${f.input}:${f.output}:${f.lp_fee}`;
      if (retractedKeys.has(dedupKey)) {
        // The fill this key names was already undone by the retraction join;
        // the ledger must never claim it open again. A retraction is a
        // VERDICT about this delivery, not a payload at-least-once will
        // retry — redelivering it cannot change the verdict.
        retracted_replays_ignored++;
        continue;
      }
      if (ledger.fills[dedupKey]) { dupes++; continue; }
      ledger.fills[dedupKey] = { ...f, recorded_at: Date.now() };
    }
  }
  if (invalid.length) {
    ledger.meta.invalid_events = (ledger.meta.invalid_events || []);
    ledger.meta.invalid_events.push({ seq: row.seq, signature: row.signature, invalid });
  }
  return { fills: failed ? 0 : fills.length, dupes, invalid: invalid.length, failed, zero: zero_amount.length,
    retracted_replays_ignored };
}

// --- tail mode -------------------------------------------------------------

export async function watchTail({ db, cursor, bin = 'reeflog', limit = 5000, ledgerPath }) {
  // Refuse BEFORE consuming anything (see ensureLedgerWritable): the
  // strongest form of the contract is one where the mailbox never runs.
  // The ledger is also READ before the spawn, so a corrupt ledger is
  // refused while the cursor still points at every undelivered row — no
  // rescue file is needed, the run simply never happened.
  ensureLedgerWritable(ledgerPath);
  let ledger;
  try {
    ledger = loadLedger(ledgerPath);
  } catch (err) {
    if (err instanceof LedgerRefusal) {
      die(`refusing tail run: ${err.message} — the mailbox was NOT read and the cursor is UNCHANGED; repair or remove the ledger, then run again`);
    }
    throw err;
  }
  const t = await cli([bin, 'tail', '--db', db, '--cursor', cursor, '--limit', String(limit)]);
  // PULS X — read EVERY delivered line. The pre-fix reader did
  // `try { row = JSON.parse(line); } catch { continue; }`: a mailbox that
  // exits 0 (its cursor already advanced past every row it printed) with
  // one truncated line lost that row FOREVER while the report said
  // COMPLETE and the process exited 0. Hand-measured on c176efc: a
  // half-line on stdout gave `rows: 2, verdict COMPLETE, exit 0` with the
  // third row silently gone. A row that PARSES but carries no `signature`
  // is worse: the dedup key becomes the literal `undefined:...` and the
  // ledger mints a fill that no reorg can ever name.
  const { rows, defects } = readDeliveryLines(t.out, 'event');
  // PULS P — X5: a mailbox that REFUSED (exit 1: no journal, foreign
  // cursor, corrupt db) or never spawned (null) delivered nothing. Saving
  // here would mint `{fills:{}}` first-run state out of a run that never
  // happened — the file IS something that happened, and PULS M's guarantee
  // was "the run simply never happened". No rows + no explicit 0/3 verdict
  // => skip the save entirely; the refusal rides out through the verdict.
  const mailboxRefused = !(t.code === 0 || t.code === 3);
  if (mailboxRefused && rows.length === 0) {
    return { exit: t.code, stderr: t.err, rows: 0, legs: 0, dupes: 0, invalid: 0, mergeRepaired: false, mergeNote: null, ledger };
  }
  // Everything past this point means the mailbox has delivered: a save
  // refusal now either self-repairs (a freshness clash: the durable disk
  // copy and this view are mergeable — PULS O) or parks the rows in a
  // rescue file (storage/corruption failures), because the cursor has
  // already advanced.
  let rowsN = 0, legs = 0, dupes = 0, invalid = 0;
  for (const row of rows) {
    rowsN++;
    const r = absorbRow(ledger, row);
    legs += r.fills; dupes += r.dupes; invalid += r.invalid;
  }
  let mergeRepaired = false;
  let mergeNote = null;
  try {
    const res = saveLedgerWithRepair(ledgerPath, ledger);
    mergeRepaired = res.repaired;
    mergeNote = res.note || null;
    ledger = res.ledger;
  } catch (err) {
    if (err instanceof LedgerRefusal && rows.length) {
      const parked = parkRows(rows, ledgerPath);
      die(consumedRefusal(err, parked, rows.length, 'tail save'));
    }
    throw err;
  }
  // PULS X — the refusal comes AFTER the save: the rows that DID arrive are
  // durable (nothing delivered is lost), and the unreadable lines are
  // parked verbatim (their bytes are the only copy that will survive).
  if (defects.length) {
    const parked = parkLines(defects.map((x) => x.line), ledgerPath);
    die(lineRefusal('tail', defects, parked));
  }
  return { exit: t.code, stderr: t.err, rows: rowsN, legs, dupes, invalid, mergeRepaired, mergeNote, ledger };
}

// --- retraction join -------------------------------------------------------

// Join retraction rows against the ledger. Pure so it can be tested
// deterministically: only fills THIS consumer read are undone; unknown
// signatures are reported, never turned into an unfill of somebody else's
// fill. Re-running on the same rows is a no-op (the first pass already
// moved the fill to `retractions`).
export function applyRetractions(ledger, rows) {
  const retractions = [];
  for (const row of rows) {
    const undoable = [];
    for (const [k, f] of Object.entries(ledger.fills)) {
      if (f.signature === row.signature) undoable.push(k);
    }
    retractions.push({ ...row, undoable_fills: undoable });
    for (const k of undoable) {
      ledger.retractions[k] = { ...ledger.fills[k], reorg: row, undone_at: Date.now() };
      delete ledger.fills[k];
    }
  }
  return retractions;
}

export async function watchRetractions({ db, cursor, bin = 'reeflog', limit = 1000, ledgerPath }) {
  ensureLedgerWritable(ledgerPath);
  let ledger;
  try {
    ledger = loadLedger(ledgerPath);
  } catch (err) {
    if (err instanceof LedgerRefusal) {
      die(`refusing retract run: ${err.message} — the mailbox was NOT read and the cursor is UNCHANGED; repair or remove the ledger, then run again`);
    }
    throw err;
  }
  const t = await cli([bin, 'reorg', 'tail', '--db', db, '--cursor', cursor, '--limit', String(limit)]);
  // PULS X — same contract on the reorg channel. A retraction is a VERDICT
  // about an already-delivered fill, and reeflog advances the reorg cursor
  // past every line it printed: swallowing an unreadable line loses the
  // undo forever while the fill stays open beside a COMPLETE report.
  const { rows, defects } = readDeliveryLines(t.out, 'reorg');
  const retractions = applyRetractions(ledger, rows);
  let mergeRepaired = false;
  let mergeNote = null;
  if (retractions.length) {
    try {
      const res = saveLedgerWithRepair(ledgerPath, ledger);
      mergeRepaired = res.repaired;
      mergeNote = res.note || null;
    } catch (err) {
      if (err instanceof LedgerRefusal && rows.length) {
        const parked = parkRows(rows, ledgerPath);
        die(consumedRefusal(err, parked, rows.length, 'retract save'));
      }
      throw err;
    }
  }
  // PULS X — the readable retractions are already applied and durable; the
  // unreadable ones are debt and ride out as a refusal (exit 3).
  if (defects.length) {
    const parked = parkLines(defects.map((x) => x.line), ledgerPath);
    die(lineRefusal('reorg', defects, parked));
  }
  return { exit: t.code, stderr: t.err, retractions, mergeRepaired, mergeNote };
}

// --- webhook mode ----------------------------------------------------------

// Header parsing per the receiver contract proven in reeflog's own e2e:
// `X-Reeflog-Signature: sha256=<hex>` over the exact body bytes, and the
// signature covers `sha256=<hex>` as a whole (verified against reeflog's
// `signature_header`, which formats `sha256={hex}` and HMACs the body).
export function verifyDelivery(secret, body, header) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const want = createHmac('sha256', secret).update(body).digest('hex');
  const got = header.slice('sha256='.length);
  const a = Buffer.from(got, 'hex');
  const b = Buffer.from(want, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function runWebhookReceiver({ port, secret, ledgerPath, log = () => {} }) {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const header = req.headers['x-reeflog-signature'];
      if (!verifyDelivery(secret, body, header)) {
        log({ rejected: true, path: req.url });
        res.writeHead(403).end('bad signature');
        return;
      }
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400).end('bad json');
        return;
      }
      let ledger;
      try {
        ledger = loadLedger(ledgerPath);
      } catch (err) {
        // 503 = retry later: reeflog classifies it transient and HOLDS the
        // queue, so the event redelivers once the ledger is repaired. A 200
        // here would record a delivery receipt for a history that was never
        // read — the F4 defect the measurement pins.
        log({ refused: true, why: err.message });
        res.writeHead(503).end(`ledger unreadable: ${String(err.message).replace(/\s+/g, ' ')}`);
        return;
      }
      if (payload.type === 'event') {
        const row = {
          seq: payload.seq,
          signature: payload.signature,
          slot: payload.slot,
          seal: payload.seal,
          err: payload.err,
          logs: payload.logs ?? null,
        };
        const r = absorbRow(ledger, row);
        let repaired = false;
        try {
          repaired = saveLedgerWithRepair(ledgerPath, ledger).repaired;
        } catch (err) {
          // Same contract: a save failure is a refusal (503), never an ACK.
          // A freshness clash self-repairs first (PULS O); if even the
          // merged save refuses, the delivery stays owed.
          log({ refused: true, why: err.message });
          res.writeHead(503).end(`ledger unwritable: ${String(err.message).replace(/\s+/g, ' ')}`);
          return;
        }
        // One log line per delivery — the pre-fix branch logged twice
        // (measured 2026-11-11: the same `{delivered,seq,fills,dupe}` line
        // printed twice for one ACK, the second carrying merge_repair),
        // which double-counts any consumer reading the log as a delivery
        // tally.
        log({ delivered: true, seq: payload.seq, fills: r.fills, dupes: r.dupes,
          ...(repaired ? { merge_repair: 'applied' } : {}) });
        res.writeHead(200).end('ok');
      } else if (payload.type === 'reorg') {
        // PULS Q: the retraction is a VERDICT about an already-delivered
        // event, and this webhook ACK is the only copy this consumer will
        // ever see: `retract` mode joins a DIFFERENT channel (`reeflog reorg
        // tail`, its own cursor) that a webhook deployment never walks.
        // Bumping a counter and answering 200 (the pre-fix branch) let
        // reeflog mark the retraction delivered while the fill stayed open
        // forever — the ACK meant the undo, not a receipt. So run the SAME
        // scoped join retract mode runs: only fills this ledger holds are
        // undone; an unknown signature is reported, never turned into an
        // unfill of somebody else's fill. Redelivery of the same reorg is a
        // no-op by construction (the fill is already out of `fills`).
        const retracted = applyRetractions(ledger, [payload]);
        const undone = retracted.reduce((n, x) => n + x.undoable_fills.length, 0);
        ledger.meta.retractions_seen = (ledger.meta.retractions_seen || 0) + 1;
        if (undone === 0 && retracted[0] && retracted[0].undoable_fills.length === 0) {
          // An unknown-signature retraction is health for nobody: keep the
          // report visible, not only in the log line.
          ledger.meta.retractions_unknown = (ledger.meta.retractions_unknown || []);
          ledger.meta.retractions_unknown.push({
            reorg_id: payload.reorg_id ?? null, signature: payload.signature });
        }
        try {
          saveLedgerWithRepair(ledgerPath, ledger);
        } catch (err) {
          log({ refused: true, why: err.message });
          res.writeHead(503).end(`ledger unwritable: ${String(err.message).replace(/\s+/g, ' ')}`);
          return;
        }
        log({ retraction: true, signature: payload.signature, undone });
        res.writeHead(200).end('ok');
      } else {
        res.writeHead(400).end('unknown type');
      }
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

export const PROGRAM = WHIRLPOOL_PROGRAM;
