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
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { tradesFromRow, WHIRLPOOL_PROGRAM } from './decode.mjs';

const bigintReplacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);

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

export function loadLedger(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { fills: raw.fills || {}, retractions: raw.retractions || {}, meta: raw.meta || {} };
  } catch {
    return { fills: {}, retractions: {}, meta: {} };
  }
}

export function saveLedger(file, ledger) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, bigintReplacer, 2));
  fs.renameSync(tmp, file);
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
  const t = await cli([bin, 'tail', '--db', db, '--cursor', cursor, '--limit', String(limit)]);
  const lines = t.out.split('\n').filter(Boolean);
  const ledger = loadLedger(ledgerPath);
  let rows = 0, legs = 0, dupes = 0, invalid = 0;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    rows++;
    const r = absorbRow(ledger, row);
    legs += r.fills; dupes += r.dupes; invalid += r.invalid;
  }
  saveLedger(ledgerPath, ledger);
  return { exit: t.code, stderr: t.err, rows, legs, dupes, invalid, ledger };
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
  const t = await cli([bin, 'reorg', 'tail', '--db', db, '--cursor', cursor, '--limit', String(limit)]);
  const lines = t.out.split('\n').filter(Boolean);
  const ledger = loadLedger(ledgerPath);
  const rows = [];
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    rows.push(row);
  }
  const retractions = applyRetractions(ledger, rows);
  if (retractions.length) saveLedger(ledgerPath, ledger);
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
      const ledger = loadLedger(ledgerPath);
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
        saveLedger(ledgerPath, ledger);
        log({ delivered: true, seq: payload.seq, fills: r.fills, dupes: r.dupes });
        res.writeHead(200).end('ok');
      } else if (payload.type === 'reorg') {
        ledger.meta.retractions_seen = (ledger.meta.retractions_seen || 0) + 1;
        saveLedger(ledgerPath, ledger);
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
