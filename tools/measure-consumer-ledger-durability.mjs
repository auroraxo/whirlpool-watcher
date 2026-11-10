// PULS M — the CONSUMER can destroy what the mailbox protected.
//
// reeflog v0.7.4..v0.7.14 closed, one face at a time, every way a cursor or
// a report can collapse a failure into "delivered": empty file, negative,
// garbage, crossing, provenance, truncate-write, dlq page. The consumer
// measured here (whirlpool-watcher, the user-zero integration) holds the
// SAME contract on its side of the mailbox — "a fill delivered by the
// mailbox is never lost" — and breaks it.
//
// Seats run against the published reeflog v0.7.14 linux asset when
// FIXED_RELEASE is set (sha256 checked against the GitHub Release API
// digest); otherwise against the local release build (same version).
//
// The faces (baseline = watcher at 658951c):
//   F1  corrupt_history_erased_behind_complete: a ledger with REAL history
//       (4 fills from a first delivery) is corrupted — the shape a torn
//       write leaves. A second delivery then runs the watcher again:
//       loadLedger swallows the parse error into an empty ledger, the run
//       reports COMPLETE with exit 0, and the old history is overwritten.
//       The cursor does not move (no new rows), so the mailbox is innocent:
//       the consumer destroyed the history itself, behind a healthy exit.
//   F2  unwritable_ledger_after_cursor_advanced: the ledger's directory is
//       unwritable. The watcher spawns `reeflog tail` FIRST, dies on
//       saveLedger before printing any report — but the mailbox cursor has
//       already advanced past the delivered rows, so those fills are never
//       redelivered. A durable-check BEFORE spawning would have refused
//       with the cursor untouched.
//   F3  webhook_ack_with_unwritable_ledger (guard): the receiver dies or
//       answers non-2xx when its ledger cannot be written — the mailbox
//       must hold the queue (no receipts). Baseline holds this; it must
//       keep holding.
//   F4  webhook_acks_corrupt_overwrite: a corrupt ledger on the webhook
//       path. The receiver answers 200 ok, reeflog records the delivery
//       receipt, and the ledger is rewritten — history erased behind an
//       ACK the mailbox will honour forever.
//   G1  fresh_ledger_still_works (guard): a MISSING ledger file is a first
//       run, not a corruption: it must still deliver with exit 0.
//
// Usage:
//   node tools/measure-consumer-ledger-durability.mjs --seat baseline|fixed|published
//   FIXED_RELEASE=v0.7.14 ... (published seat, digest-checked)
//
// The tool prints the JSON and exits 0 when the verdicts match what the
// chosen seat claims: baseline expects violations, fixed expects closures.
// A seat whose faces all go the "wrong" way exits non-zero — that is a
// lying measurement, not a result.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');

const REEFLOG_BIN = process.env.REEFLOG_BIN
  || path.join(os.homedir(), 'github_repos/reeflog/target/release/reeflog');
const FIXED_RELEASE = process.env.FIXED_RELEASE || 'v0.7.14';
// --seat local|published : which reeflog BINARY the mailbox runs (the fix
// lives in THIS watcher tree; the mailbox binary is named so the measurement
// says which artifact it ran against).
const SEAT = (() => {
  const i = process.argv.indexOf('--seat');
  return i >= 0 ? process.argv[i + 1] : 'local';
})();
// --expect violations|clean : the falsification contract. `violations` exits
// 0 only when at least one face violates (baseline tree); `clean` exits 0
// only when no face violates (fixed tree). A seat whose faces all go the
// "wrong" way exits non-zero — that is a lying measurement, not a result.
const EXPECT = (() => {
  const i = process.argv.indexOf('--expect');
  return i >= 0 ? process.argv[i + 1] : '';
})();
const LABEL = (() => {
  const i = process.argv.indexOf('--label');
  return i >= 0 ? process.argv[i + 1] : SEAT;
})();
const OUT = process.env.PULSE_M_OUT
  || path.join(ROOT, 'research', `consumer-ledger-durability-${LABEL}-2026-11-10.json`);

const PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const SECRET = 'pulse-m-shared-secret';
const CORRUPT_MARK = '"PULSE-M-CORRUPT-DO-NOT-LOSE"';

function sha256File(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- the published seat ---------------------------------------------------
function seatPublishedRelease() {
  const seat = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-m-release-'));
  const name = 'reeflog-linux-amd64.tar.gz';
  const api = JSON.parse(spawnSync('gh', [
    'api', `repos/auroraxo/reeflog/releases/tags/${FIXED_RELEASE}`,
  ], { encoding: 'utf8' }).stdout);
  const asset = api.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`no ${name} on ${FIXED_RELEASE}`);
  const want = String(asset.digest || '').replace('sha256:', '');
  const dl = spawnSync('gh', [
    'release', 'download', FIXED_RELEASE, '-R', 'auroraxo/reeflog',
    '--pattern', name, '--clobber',
  ], { cwd: seat, encoding: 'utf8', timeout: 120000 });
  if (dl.status !== 0) throw new Error(`download failed: ${dl.stderr}`);
  const tgz = path.join(seat, name);
  const got = sha256File(tgz);
  if (got !== want) throw new Error(`digest mismatch: got ${got}, api ${want}`);
  spawnSync('tar', ['xzf', tgz, '-C', seat]);
  const bin = path.join(seat, 'reeflog');
  fs.chmodSync(bin, 0o755);
  return {
    bin, digest: got, kind: `published ${FIXED_RELEASE} asset`,
    version: spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim(),
  };
}

function seatWorkingBinary() {
  return {
    bin: REEFLOG_BIN,
    digest: sha256File(REEFLOG_BIN),
    kind: 'local release build',
    version: spawnSync(REEFLOG_BIN, ['--version'], { encoding: 'utf8' }).stdout.trim(),
  };
}

// --- a deterministic offline journal --------------------------------------
// reeflog has no offline insert command, so the probe builds a journal with
// the SAME schema `reeflog init` creates and lets the PUBLISHED binary read
// it. Rows carry the watcher's own committed live-mainnet fixtures, so every
// delivered row decodes to a real Traded fill.
function buildJournal(dbPath, events) {
  fs.rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    signature TEXT NOT NULL UNIQUE,
    slot INTEGER NOT NULL,
    err TEXT,
    logs TEXT,
    source TEXT NOT NULL DEFAULT 'ws',
    first_seen INTEGER NOT NULL,
    seal_status TEXT,
    seal_seen INTEGER,
    payload_state TEXT,
    accounts TEXT,
    account_state TEXT);
    CREATE TABLE gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL, since_seq INTEGER, since_slot INTEGER,
    since_sig TEXT, detail TEXT NOT NULL DEFAULT '',
    detected_at INTEGER NOT NULL, resolved_at INTEGER,
    until_slot INTEGER, backfill_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE reorgs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signature TEXT NOT NULL UNIQUE,
    slot INTEGER NOT NULL, detected_at INTEGER NOT NULL,
    status_source TEXT NOT NULL, tx_source TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '');
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const ins = db.prepare(`INSERT INTO events (signature, slot, err, logs,
    source, first_seen, seal_status, seal_seen, payload_state)
    VALUES (?, ?, ?, ?, 'ws', ?, 'sealed', ?, NULL)`);
  for (const e of events) {
    ins.run(e.signature, e.slot, e.err ?? null, e.logs, Date.now(), Date.now());
  }
  db.close();
}

function fixtureEvents() {
  const f = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures.json'), 'utf8'));
  return f.traded.map((t) => ({
    signature: t.signature,
    slot: t.slot,
    logs: JSON.stringify([
      `Program ${PROGRAM} invoke [1]`,
      `Program data: ${t.program_data}`,
      `Program ${PROGRAM} success`,
    ]),
  }));
}

// --- watchers run through their OWN CLI (no paraphrase) --------------------
function runWatcher(args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), ...args], {
    encoding: 'utf8', timeout: 60000,
  });
}

function parseJson(out) {
  const start = (out || '').indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(out.slice(start)); } catch { return null; }
}

function cursorValue(cursorPath) {
  try {
    const raw = fs.readFileSync(cursorPath, 'utf8').trim();
    const j = JSON.parse(raw);
    return typeof j.value === 'number' ? j.value : null;
  } catch { return null; }
}

function ledgerFills(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw.fills ? Object.keys(raw.fills).length : null;
  } catch { return null; }
}

function corruptLedger(file) {
  // A truncated JSON document with a distinctive marker: whatever the
  // watcher does with this file, the marker says whether the bytes at the
  // path were preserved or replaced.
  fs.writeFileSync(file, `{"fills": {${CORRUPT_MARK}: `);
}

async function withReceiver(port, ledger, fn) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'),
    'webhook', '--port', String(port), '--secret', SECRET, '--ledger', ledger,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let outBuf = '';
  let ready = false;
  proc.stdout.on('data', (d) => { outBuf += d; if (outBuf.includes('listening')) ready = true; });
  proc.stderr.on('data', () => {});
  proc.on('close', () => { if (!ready) ready = 'died'; });
  const t0 = Date.now();
  while (ready === false && Date.now() - t0 < 8000) await sleep(100);
  let res = null, err = null;
  try { res = await fn(ready === true); }
  catch (e) { err = String(e && e.message); }
  finally { proc.kill('SIGKILL'); await Promise.race([new Promise((r) => proc.on('close', r)), sleep(1500)]); }
  return { res, err, ready };
}

function pushWebhook(bin, db, cfg) {
  return spawnSync(bin, ['webhook', 'push', '--db', db, '--config', cfg, '--limit', '10'], {
    encoding: 'utf8', timeout: 30000,
  });
}

function receiptCount(db) {
  const d = new DatabaseSync(db, { readOnly: true });
  try { return d.prepare('SELECT COUNT(*) AS n FROM webhook_receipts').get().n; }
  finally { d.close(); }
}

// --- F1: corrupt history erased behind a COMPLETE report -------------------
function faceF1(bin, dir) {
  const db = path.join(dir, 'f1.db');
  const cursor = path.join(dir, 'f1.cursor');
  const ledger = path.join(dir, 'f1-ledger.json');
  buildJournal(db, fixtureEvents());

  // Seed REAL history: one full delivery of the four fixture fills.
  const seed = runWatcher(['tail', '--db', db, '--cursor', cursor, '--ledger', ledger, '--bin', bin]);
  const seedFills = ledgerFills(ledger);

  // The ledger goes corrupt afterwards (torn write). A later run with NO
  // new rows is where the swallow shows: the parse error becomes an empty
  // ledger and the history is overwritten.
  corruptLedger(ledger);
  const r = runWatcher(['tail', '--db', db, '--cursor', cursor, '--ledger', ledger, '--bin', bin]);
  const rep = parseJson(r.stdout);
  const stillCorrupt = fs.readFileSync(ledger, 'utf8').includes(CORRUPT_MARK);
  const fillsAfter = ledgerFills(ledger);

  const violated = seed.status === 0 && seedFills === 4
    && r.status === 0 && rep && rep.verdict === 'COMPLETE'
    && !stillCorrupt;
  return {
    face: 'F1_corrupt_history_erased_behind_complete',
    seed_fills: seedFills,
    second_run_exit: r.status,
    verdict_reported: rep ? rep.verdict : null,
    corrupt_bytes_preserved: stillCorrupt,
    fills_in_ledger_after: fillsAfter,
    violated,
    detail: violated
      ? 'a corrupt ledger was replaced by a fresh empty one and the run reported COMPLETE with exit 0 — the delivered history is gone and nothing was said'
      : `exit=${r.status} verdict=${rep && rep.verdict} preserved=${stillCorrupt} fills=${fillsAfter}`,
    stderr: (r.stderr || '').trim().slice(0, 500),
  };
}

// --- F2: unwritable ledger AFTER the mailbox advanced the cursor -----------
function faceF2(bin, dir) {
  const db = path.join(dir, 'f2.db');
  const cursor = path.join(dir, 'f2.cursor');
  const roDir = path.join(dir, 'f2-ro');
  fs.mkdirSync(roDir, { recursive: true });
  const ledger = path.join(roDir, 'ledger.json');
  buildJournal(db, fixtureEvents());
  fs.chmodSync(roDir, 0o500);
  let r;
  try { r = runWatcher(['tail', '--db', db, '--cursor', cursor, '--ledger', ledger, '--bin', bin]); }
  finally { fs.chmodSync(roDir, 0o700); }

  const cv = cursorValue(cursor);
  // The violation: the run produced no report AND the mailbox cursor
  // advanced past the four rows — the fills were consumed by a run that
  // recorded nothing. A fixed watcher refuses BEFORE spawning the mailbox
  // read, so the cursor never moves.
  const violated = parseJson(r.stdout) === null && cv !== null && cv > 0;
  const refusedBeforeSpawn = cv === null
    && (r.stderr || '').includes('refusing')
    && parseJson(r.stdout) === null;
  return {
    face: 'F2_unwritable_ledger_after_cursor_advanced',
    exit: r.status,
    report_printed: parseJson(r.stdout) !== null,
    mailbox_cursor_after: cv,
    stdout: (r.stdout || '').trim().slice(0, 400),
    violated,
    closed_by_refusal_before_spawn: refusedBeforeSpawn,
    detail: violated
      ? `the run died (exit ${r.status}) with no report while the mailbox cursor had advanced to ${cv} — those fills are never redelivered`
      : `exit=${r.status} cursor=${cv} refused_before_spawn=${refusedBeforeSpawn}`,
    stderr: (r.stderr || '').trim().slice(0, 400),
  };
}

// --- F3 (guard): webhook with unwritable ledger must hold the queue --------
async function faceF3(bin, dir) {
  const db = path.join(dir, 'f3.db');
  const roDir = path.join(dir, 'f3-ro');
  fs.mkdirSync(roDir, { recursive: true });
  const ledger = path.join(roDir, 'ledger.json');
  buildJournal(db, fixtureEvents());
  fs.chmodSync(roDir, 0o500);
  const port = 18700 + Math.floor(Math.random() * 400);
  const cfg = path.join(dir, 'f3-webhook.json');
  fs.writeFileSync(cfg, JSON.stringify({
    targets: [{ id: 'ww', url: `http://127.0.0.1:${port}/hook`, secret: SECRET, timeout_ms: 4000 }],
  }));
  let push = null;
  const w = await withReceiver(port, ledger, async (alive) => {
    if (alive) push = pushWebhook(bin, db, cfg);
  });
  fs.chmodSync(roDir, 0o700);
  const receipts = receiptCount(db);
  return {
    face: 'F3_guard_webhook_unwritable_holds_queue',
    receiver_ready: w.ready,
    push_exit: push ? push.status : null,
    webhook_receipts: receipts,
    // A guard FAILS when a receipt appears for an undurable delivery.
    violated: receipts > 0,
    detail: receipts > 0
      ? `${receipts} delivery receipt(s) recorded although the consumer could not write its ledger`
      : `receipts=${receipts} push_exit=${push && push.status} (queue held)`,
  };
}

// --- F4: webhook ACKs a corrupt-overwrite ----------------------------------
async function faceF4(bin, dir) {
  const db = path.join(dir, 'f4.db');
  const ledger = path.join(dir, 'f4-ledger.json');
  buildJournal(db, fixtureEvents());
  corruptLedger(ledger);
  const port = 18800 + Math.floor(Math.random() * 400);
  const cfg = path.join(dir, 'f4-webhook.json');
  fs.writeFileSync(cfg, JSON.stringify({
    targets: [{ id: 'ww', url: `http://127.0.0.1:${port}/hook`, secret: SECRET, timeout_ms: 4000 }],
  }));
  let push = null;
  const w = await withReceiver(port, ledger, async (alive) => {
    if (alive) push = pushWebhook(bin, db, cfg);
  });
  const receipts = receiptCount(db);
  const stillCorrupt = fs.readFileSync(ledger, 'utf8').includes(CORRUPT_MARK);
  const fillsAfter = ledgerFills(ledger);
  const violated = receipts > 0 && !stillCorrupt;
  return {
    face: 'F4_webhook_acks_corrupt_overwrite',
    receiver_ready: w.ready,
    push_exit: push ? push.status : null,
    webhook_receipts: receipts,
    corrupt_bytes_preserved: stillCorrupt,
    fills_in_ledger_after: fillsAfter,
    violated,
    detail: violated
      ? `the receiver answered 2xx and the mailbox recorded ${receipts} receipt(s), replacing the corrupt ledger in silence — history erased behind an ACK the mailbox will honour forever`
      : `receipts=${receipts} preserved=${stillCorrupt} fills=${fillsAfter}`,
  };
}

// --- G1 (guard): a missing ledger is a first run, not a corruption ---------
function faceG1(bin, dir) {
  const db = path.join(dir, 'g1.db');
  const cursor = path.join(dir, 'g1.cursor');
  const ledger = path.join(dir, 'g1-ledger.json');
  buildJournal(db, fixtureEvents());
  const r = runWatcher(['tail', '--db', db, '--cursor', cursor, '--ledger', ledger, '--bin', bin]);
  const rep = parseJson(r.stdout);
  const fills = ledgerFills(ledger);
  return {
    face: 'G1_guard_fresh_ledger_delivers',
    exit: r.status,
    verdict: rep ? rep.verdict : null,
    fills,
    violated: !(r.status === 0 && fills === 4 && rep && rep.verdict === 'COMPLETE'),
    detail: `exit=${r.status} verdict=${rep && rep.verdict} fills=${fills}`,
  };
}

// --- the run ---------------------------------------------------------------
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-m-'));
  const seat = SEAT === 'published' ? seatPublishedRelease() : seatWorkingBinary();

  const order = [faceF1, faceF2, faceF3, faceF4, faceG1];
  const faces = [];
  for (const f of order) {
    try { faces.push(await f(seat.bin, dir)); }
    catch (e) { faces.push({ face: f.name, violated: null, error: String(e && e.message) }); }
  }

  const violated = faces.filter((x) => x.violated === true).map((x) => x.face);
  const expectation = EXPECT
    ? (EXPECT === 'violations' ? 'baseline tree: at least one face must violate'
       : 'fixed tree: no face may violate')
    : 'none (report only)';
  const consistent = !EXPECT
    ? true
    : EXPECT === 'violations' ? violated.length > 0 : violated.length === 0;
  const out = {
    measured_at: new Date().toISOString(),
    what: 'consumer-side mailbox contract: whirlpool-watcher ledger durability',
    seat: { kind: seat.kind, version: seat.version, sha256: seat.digest, watcher_tree: SEAT },
    faces,
    summary: {
      total: faces.length,
      violated_count: violated.length,
      violated,
      expectation,
      measurement_consistent: consistent,
    },
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
  process.exit(consistent ? 0 : 1);
}

main();
