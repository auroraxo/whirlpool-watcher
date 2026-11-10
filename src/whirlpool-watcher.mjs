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
//                   and answers 2xx only after the fill is durably recorded.
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

// The documented repair for a freshness refusal: union of both instances'
// fills and retractions, the DURABLE disk copy winning per key (it was
// already delivered to whoever consumed the ledger). The result keeps the
// disk view's freshness, so saving it re-checks against the same state —
// a writer that landed in between still refuses.
export function mergeLedger(diskLedger, mine) {
  const merged = {
    fills: { ...mine.fills, ...diskLedger.fills },
    retractions: { ...mine.retractions, ...diskLedger.retractions },
    meta: { ...mine.meta, ...diskLedger.meta },
  };
  const marker = Object.getOwnPropertyDescriptor(diskLedger, LOADED_MARKER);
  if (marker) Object.defineProperty(merged, LOADED_MARKER, marker);
  return merged;
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
      if (ledger.fills[dedupKey]) { dupes++; continue; }
      ledger.fills[dedupKey] = { ...f, recorded_at: Date.now() };
    }
  }
  if (invalid.length) {
    ledger.meta.invalid_events = (ledger.meta.invalid_events || []);
    ledger.meta.invalid_events.push({ seq: row.seq, signature: row.signature, invalid });
  }
  return { fills: failed ? 0 : fills.length, dupes, invalid: invalid.length, failed, zero: zero_amount.length };
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
  const lines = t.out.split('\n').filter(Boolean);
  const rows = [];
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    rows.push(row);
  }
  // Everything past this point means the mailbox has delivered: a save
  // refusal now parks the rows in a rescue file instead of dropping them,
  // because the cursor has already advanced.
  let rowsN = 0, legs = 0, dupes = 0, invalid = 0;
  for (const row of rows) {
    rowsN++;
    const r = absorbRow(ledger, row);
    legs += r.fills; dupes += r.dupes; invalid += r.invalid;
  }
  try {
    saveLedger(ledgerPath, ledger);
  } catch (err) {
    if (err instanceof LedgerRefusal && rows.length) {
      const parked = parkRows(rows, ledgerPath);
      die(consumedRefusal(err, parked, rows.length, 'tail save'));
    }
    throw err;
  }
  return { exit: t.code, stderr: t.err, rows: rowsN, legs, dupes, invalid, ledger };
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
  const lines = t.out.split('\n').filter(Boolean);
  const rows = [];
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    rows.push(row);
  }
  const retractions = applyRetractions(ledger, rows);
  if (retractions.length) {
    try {
      saveLedger(ledgerPath, ledger);
    } catch (err) {
      if (err instanceof LedgerRefusal && rows.length) {
        const parked = parkRows(rows, ledgerPath);
        die(consumedRefusal(err, parked, rows.length, 'retract save'));
      }
      throw err;
    }
  }
  return { exit: t.code, stderr: t.err, retractions };
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
        try {
          saveLedger(ledgerPath, ledger);
        } catch (err) {
          // Same contract: a save failure is a refusal (503), never an ACK.
          // The ledger file is unchanged (saveLedger stages a temp and only
          // then swaps), so retrying after the repair is at-least-once safe.
          log({ refused: true, why: err.message });
          res.writeHead(503).end(`ledger unwritable: ${String(err.message).replace(/\s+/g, ' ')}`);
          return;
        }
        log({ delivered: true, seq: payload.seq, fills: r.fills, dupes: r.dupes });
        res.writeHead(200).end('ok');
      } else if (payload.type === 'reorg') {
        try {
          ledger.meta.retractions_seen = (ledger.meta.retractions_seen || 0) + 1;
          saveLedger(ledgerPath, ledger);
        } catch (err) {
          log({ refused: true, why: err.message });
          res.writeHead(503).end(`ledger unwritable: ${String(err.message).replace(/\s+/g, ' ')}`);
          return;
        }
        log({ retraction: true, signature: payload.signature });
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
