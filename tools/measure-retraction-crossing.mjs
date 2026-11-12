#!/usr/bin/env node
// PULS Y — the retraction crossing, measured end to end on the REAL reeflog
// binary (seeded journal, no network beyond nothing — every byte is local).
//
//   node tools/measure-retraction-crossing.mjs --expect violations|clean [--label NAME]
//
// contract: `violations` exits 0 only when at least one face violates (the
// pre-fix tree); `clean` exits 0 only when no face violates (the fixed
// tree). A tool whose faces all go the "wrong" way exits non-zero: a lying
// measurement, not a result.
//
// The crossing (measured 2026-11-12 on 0cb1641, hand-reproduced first):
// reeflog delivers events by `seq` and reorgs by `reorg_id` — two
// independent orders on two independent cursors. A retraction can therefore
// be delivered while the event it undoes is still undelivered (blocked
// event queue — retractions jump ahead on PURPOSE, webhook.rs; a --limit
// cut; separate crons; separate processes). The pre-fix consumer answered
// "no such fill" (exit 0 / 200), the mailbox moved its cursor/receipt PAST
// the verdict (it never redelivers), and the event arriving later was
// booked OPEN — the ledger permanently claims a reverted transaction is an
// open fill. Nothing re-checks it: reorgs_after(cursor) is empty forever.
//
// Faces (each drives the real code path, real binary where one exists):
//   Y1 CLI channel: seed events(seq=1) + reorgs(id=1) for the SAME fixture
//      signature; run `retract` first (undoable 0, cursor advances), then
//      `tail`. Violation iff the final ledger holds the fill OPEN.
//   Y2 webhook channel: the same order through the real receiver — reorg
//      POSTed before the event. Violation iff the fill ends open after the
//      event is ACKed.
//   Y3 report-loss: the pre-fix unknown-signature branch kept only a
//      counter list. Violation iff a retraction of a not-yet-read signature
//      leaves NO consumable verdict (nothing pending to apply at delivery).
//
// Guards (must hold on BOTH trees):
//   G1 in-order delivery (event then reorg) still undoes exactly the fill
//   G2 a retraction for a signature that is never delivered touches no fill
//   G3 a normal duplicate delivery still dedups (no pending verdict)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures.json'), 'utf8'));
const REEFLOG = process.env.REEFLOG_BIN
  || path.join(os.homedir(), 'github_repos', 'reeflog', 'target', 'release', 'reeflog');
const PROG = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? i + 1 < process.argv.length ? process.argv[i + 1] : d : d;
};
const EXPECT = arg('--expect', '');
const LABEL = arg('--label', EXPECT || 'unlabeled');
const OUT = process.env.PULSE_Y_OUT
  || path.join(ROOT, 'research', `retraction-crossing-${LABEL}-2026-11-12.json`);

const { loadLedger, runWebhookReceiver, applyRetractions, absorbRow } =
  await import(path.join(ROOT, 'src', 'whirlpool-watcher.mjs'));

function needReeflog() {
  if (!fs.existsSync(REEFLOG)) {
    console.error(`NO VERDICT: reeflog binary not found at ${REEFLOG} (set REEFLOG_BIN)`);
    process.exit(2);
  }
}

function seedJournal(db, signature, logsJson) {
  const r = spawnSync(REEFLOG, ['init', '--db', db, '--program', PROG], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`reeflog init failed: ${r.stderr}`);
  const j = new DatabaseSync(db);
  j.exec(`INSERT INTO events(seq,signature,slot,err,logs,source,first_seen,payload_state,accounts,account_state)
    VALUES (1,'${signature}',100,NULL,'${logsJson.replace(/'/g, "''")}','ws',1,'held',NULL,NULL);
    INSERT INTO reorgs(signature,slot,detected_at,status_source,tx_source,detail)
    VALUES ('${signature}',100,1,'getTransaction','rpc','reverted');`);
  j.close();
}

function node(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}
function reportOf(stdout) {
  const s = (stdout || '').indexOf('{');
  return s >= 0 ? JSON.parse(stdout.slice(s)) : null;
}

// --- Y1: the CLI channel, retract drains the reorg cursor first -------------
async function faceY1(dir) {
  const db = path.join(dir, 'y1.db');
  const ledger = path.join(dir, 'y1-ledger.json');
  const LOGS = JSON.stringify([
    `Program ${PROG} invoke [1]`,
    `Program data: ${FIX.traded[0].program_data}`,
    `Program ${PROG} success`,
  ]);
  seedJournal(db, FIX.traded[0].signature, LOGS);
  const r1 = node(['retract', '--db', db, '--cursor', path.join(dir, 'rc'),
    '--ledger', ledger, '--bin', REEFLOG]);
  const rep1 = reportOf(r1.stdout);
  const r2 = node(['tail', '--db', db, '--cursor', path.join(dir, 'ec'),
    '--ledger', ledger, '--bin', REEFLOG]);
  const rep2 = reportOf(r2.stdout);
  const l = fs.existsSync(ledger) ? loadLedger(ledger) : null;
  const violated = [];
  if (!rep1 || !rep2 || !l) violated.push('NO VERDICT: run produced no report/ledger');
  else {
    if (rep1.undoable !== 0) violated.push(`NO VERDICT: retract found an undoable fill (${rep1.undoable}) — the event was not supposed to be read yet`);
    if (Object.keys(l.fills).length !== 0) {
      violated.push(`the retraction was delivered BEFORE the event (retract exit 0, cursor advanced), `
        + `and the later tail booked the fill OPEN: open_fills=${Object.keys(l.fills).length}, `
        + `retractions=${Object.keys(l.retractions).length} — the ledger claims a reverted transaction is open, forever`);
    }
    if (Object.keys(l.retractions).length !== 1) {
      violated.push(`expected the crossed fill in retractions (got ${Object.keys(l.retractions).length})`);
    }
    if (rep2.retraction_first_ignored !== 1) {
      violated.push(`the tail report does not name the refusal (retraction_first_ignored=${rep2.retraction_first_ignored})`);
    }
  }
  return { face: 'Y1_cli_retract_cursor_crosses_before_event', violated: violated.length > 0,
    detail: violated.length ? violated.join('; ') : 'retract pending_recorded -> tail retraction_first_ignored=1, fill lands in retractions',
    retract_report: rep1, tail_report: { rows: rep2?.rows, fills: rep2?.fills, retraction_first_ignored: rep2?.retraction_first_ignored, verdict: rep2?.verdict },
    open_fills: l ? Object.keys(l.fills).length : null,
    retractions: l ? Object.keys(l.retractions).length : null };
}

// --- Y2: the webhook channel, reorg POSTed before the event -----------------
async function faceY2(dir) {
  const ledger = path.join(dir, 'y2-ledger.json');
  const secret = '***';
  const server = await runWebhookReceiver({ port: 0, secret, ledgerPath: ledger, log: () => {} });
  const port = server.address().port;
  async function hook(p) {
    const body = JSON.stringify(p);
    const res = await fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST',
      headers: { 'content-type': 'application/json',
        'x-reeflog-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
      body });
    return res.status;
  }
  let statuses = [];
  try {
    statuses = [
      await hook({ type: 'reorg', reorg_id: 1, signature: FIX.traded[0].signature,
        slot: FIX.traded[0].slot, detected_at: 1, status_source: 'getTransaction',
        tx_source: 'rpc', detail: 'reverted' }),
      await hook({ type: 'event', seq: 1, signature: FIX.traded[0].signature,
        slot: FIX.traded[0].slot, err: null, seal: 'finalized',
        logs: [`Program data: ${FIX.traded[0].program_data}`] }),
    ];
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  const l = fs.existsSync(ledger) ? loadLedger(ledger) : null;
  const violated = [];
  if (!l) violated.push('NO VERDICT: no ledger written');
  else {
    if (!statuses.every((s) => s === 200)) violated.push(`NO VERDICT: delivery statuses ${statuses}`);
    if (Object.keys(l.fills).length !== 0) {
      violated.push(`reorg-first ACKed 200, event ACKed 200 — fill OPEN: open=${Object.keys(l.fills).length} `
        + `retractions=${Object.keys(l.retractions).length} — the ACKed verdict was dropped by the receiver`);
    }
    if (Object.keys(l.retractions).length !== 1) violated.push('the crossed fill did not land in retractions');
  }
  return { face: 'Y2_webhook_reorg_before_event', violated: violated.length > 0,
    detail: violated.length ? violated.join('; ') : 'reorg-first stored pending, event delivery ran the join, fill lands in retractions',
    statuses, open_fills: l ? Object.keys(l.fills).length : null,
    retractions: l ? Object.keys(l.retractions).length : null };
}

// --- Y3: the unknown-signature retraction leaves a CONSUMABLE verdict -------
async function faceY3(dir) {
  const ledger = path.join(dir, 'y3-ledger.json');
  const secret = '***';
  const server = await runWebhookReceiver({ port: 0, secret, ledgerPath: ledger, log: () => {} });
  const port = server.address().port;
  try {
    const body = JSON.stringify({ type: 'reorg', reorg_id: 1, signature: FIX.traded[0].signature,
      slot: FIX.traded[0].slot, detected_at: 1, status_source: 'getTransaction',
      tx_source: 'rpc', detail: 'reverted' });
    await fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST',
      headers: { 'content-type': 'application/json',
        'x-reeflog-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
      body });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  const l = loadLedger(ledger);
  const pending = (l.meta.retractions_pending || []).filter((p) => p.signature === FIX.traded[0].signature);
  const violated = [];
  if (pending.length !== 1) {
    violated.push('the unknown-signature retraction left no consumable pending verdict '
      + `(meta keys: ${Object.keys(l.meta).join(', ')}) — the counter is a report nobody can act on, `
      + 'and the mailbox receipt says this verdict was delivered');
  }
  return { face: 'Y3_verdict_is_durable_not_counter_only', violated: violated.length > 0,
    detail: violated.length ? violated.join('; ') : 'one pending verdict for the signature, reorg_ids named',
    pending_count: pending.length,
    pending: pending.map((p) => ({ signature: p.signature, reorg_ids: p.reorg_ids })) };
}

// --- guards ------------------------------------------------------------------
async function guardG1(dir) {
  const ledger = path.join(dir, 'g1-ledger.json');
  const l = { fills: {}, retractions: {}, meta: {} };
  absorbRow(l, { seq: 1, signature: FIX.traded[0].signature, slot: FIX.traded[0].slot,
    seal: 'finalized', err: null, logs: [`Program data: ${FIX.traded[0].program_data}`] });
  applyRetractions(l, [{ reorg_id: 1, signature: FIX.traded[0].signature, slot: FIX.traded[0].slot }]);
  const violated = [];
  if (Object.keys(l.fills).length !== 0) violated.push('the in-order undo moved');
  if (Object.keys(l.retractions).length !== 1) violated.push('the in-order record moved');
  return { face: 'G1_in_order_unchanged', violated: violated.length > 0,
    detail: violated.length ? violated.join('; ') : 'open=0 retracted=1' };
}

function guardG2() {
  const ledger = { fills: {}, retractions: {}, meta: {} };
  absorbRow(ledger, { seq: 1, signature: FIX.traded[0].signature, slot: FIX.traded[0].slot,
    seal: 'finalized', err: null, logs: [`Program data: ${FIX.traded[0].program_data}`] });
  applyRetractions(ledger, [{ reorg_id: 1, signature: 'NEVER-READ', slot: 1 }]);
  const violated = [];
  if (Object.keys(ledger.fills).length !== 1) violated.push('scoped undo broke: the held fill moved');
  if (Object.keys(ledger.retractions).length !== 0) violated.push('an unknown signature wrote a retraction record');
  return { face: 'G2_scoped_undo_unchanged', violated: violated.length > 0,
    detail: violated.length ? violated.join('; ') : 'fill held, no unfill' };
}

function guardG3() {
  const ledger = { fills: {}, retractions: {}, meta: {} };
  const row = { seq: 1, signature: FIX.traded[0].signature, slot: FIX.traded[0].slot,
    seal: 'finalized', err: null, logs: [`Program data: ${FIX.traded[0].program_data}`] };
  absorbRow(ledger, row);
  const r = absorbRow(ledger, row);
  const violated = [];
  if (r.dupes !== 1) violated.push(`normal replay no longer dedups (dupes=${r.dupes})`);
  if ((r.retraction_first_ignored || 0) !== 0) violated.push('a dedup was counted as a crossing refusal');
  if (Object.keys(ledger.fills).length !== 1) violated.push('the held fill count moved');
  return { face: 'G3_dedup_unchanged', violated: violated.length > 0,
    detail: violated.length ? violated.join('; ') : 'dupes=1, no refusal count' };
}

// --- run ---------------------------------------------------------------------
needReeflog();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-pulsy-measure-'));
let faces, guards;
try {
  faces = [await faceY1(dir), await faceY2(dir), await faceY3(dir)];
  guards = [await guardG1(dir), guardG2(), guardG3()];
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

const violations = faces.filter((f) => f.violated).map((f) => f.face);
const guardBreaks = guards.filter((g) => g.violated).map((g) => g.face);
const verdict = violations.length > 0 ? 'violations' : 'clean';

const output = {
  generatedAt: new Date().toISOString(),
  tool: 'tools/measure-retraction-crossing.mjs',
  label: LABEL,
  verdict,
  defect: 'reeflog delivers events by seq and reorgs by reorg_id — two independent cursors. A retraction delivered BEFORE its event was answered "no such fill" and the mailbox receipt/cursor moved past the verdict forever; the later event delivery booked the fill OPEN, so the ledger permanently claims a reverted transaction is an open fill. Both transports reproduce it: retract-then-tail on one cursor pair, and a reorg POSTed before the event.',
  faces,
  guards,
  summary: {
    faces_violated: violations.length, faces_total: faces.length,
    violated_faces: violations,
    guards_violated: guardBreaks.length, guards_total: guards.length,
  },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ verdict, violations, guardBreaks, out: OUT }, null, 2));

if (EXPECT === 'violations' && violations.length > 0 && guardBreaks.length === 0) process.exit(0);
if (EXPECT === 'clean' && violations.length === 0 && guardBreaks.length === 0) process.exit(0);
console.error(`EXPECT ${EXPECT}: got verdict=${verdict} violations=${violations.length} guardBreaks=${guardBreaks.length} — lying measurement, not a result`);
process.exit(1);
