#!/usr/bin/env node
// PULS Q — the retraction must reach the ledger it was ACKed for.
//
// Two faces, each driven through the REAL code paths:
//
//   Q1 a REAL reeflog binary (`webhook push`) delivers an event and then a
//      reorg to the REAL webhook receiver. reeflog records both deliveries
//      as delivered (its target cursor advances, no redelivery will ever
//      come), so the undo must be complete at ACK time: after the push the
//      fill may not be open. The pre-fix receiver answered 200 and bumped
//      `retractions_seen` without ever running the join — the fill stayed
//      open while the mailbox considered the retraction delivered.
//   Q2 `rescue` replays a parked row whose fill the retraction join already
//      moved to `retractions`. The dedup only knew `fills`, so the fill came
//      back beside its own undo record (open AND undone).
//
// Guards (must hold on BOTH trees):
//   G1 event delivery still records the fill (the common path must not move)
//   G2 a reorg for a signature this consumer never read stays a report
//   G3 rescue of a genuinely new row still records it
//
// Usage:
//   node tools/measure-webhook-retraction.mjs --expect violations|clean [--label NAME]
// contract: `violations` exits 0 only when at least one face violates (the
// pre-fix tree); `clean` exits 0 only when no face violates (the fixed
// tree). A tool whose faces all go the "wrong" way exits non-zero: a lying
// measurement, not a result.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures.json'), 'utf8'));
// The seeded event must carry a REAL Whirlpool Traded payload: the watcher's
// decoder only books fills from a decodable `Program data:` line, so the
// seed proves the same face a deployment would hit (a real fill, retracted).
const TRADED_LOGS = JSON.stringify([
  'Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke [1]',
  `Program data: ${FIX.traded[0].program_data}`,
  'Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc success',
]);
const { loadLedger, runWebhookReceiver } = await import(path.join(ROOT, 'src', 'whirlpool-watcher.mjs'));
const REEFLOG = process.env.REEFLOG_BIN
  || path.join(os.homedir(), 'github_repos', 'reeflog', 'target', 'release', 'reeflog');
const PROG = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const EXPECT = arg('--expect', '');
const LABEL = arg('--label', EXPECT || 'unlabeled');
const OUT = process.env.PULSE_Q_OUT
  || path.join(ROOT, 'research', `webhook-retraction-${LABEL}-2026-11-11.json`);

const scrub = (s, d) => String(s || '').split(d).join('<tmpdir>');

// Async spawn: the receiver runs in THIS process, so a spawnSync of
// `reeflog webhook push` would block the event loop and the delivery could
// never be answered (measured: every attempt became `timeout: global`).
function spawnAsync(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
  });
}

function needReeflog() {
  if (!fs.existsSync(REEFLOG)) {
    console.error(`NO VERDICT: reeflog binary not found at ${REEFLOG} (set REEFLOG_BIN)`);
    process.exit(2);
  }
}

function sqlite(db, sql) {
  const r = spawnSync('sqlite3', [db], { input: sql, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3: ${r.stderr}`);
}

// --- Q1: the real reeflog binary pushes an event + a reorg ------------------
async function faceQ1(dir) {
  const db = path.join(dir, 'q1.db');
  const ledger = path.join(dir, 'q1-ledger.json');
  const cfg = path.join(dir, 'q1-webhooks.json');
  let violated = [];
  let detail = {};

  if (spawnSync(REEFLOG, ['init', '--db', db, '--program', PROG], { encoding: 'utf8' }).status !== 0) {
    return { face: 'Q1_webhook_reorg_reaches_ledger', violated: true, detail: 'NO VERDICT: reeflog init failed' };
  }
  sqlite(db, `
INSERT INTO events(seq,signature,slot,err,logs,source,first_seen,payload_state,accounts,account_state) VALUES
 (1,'SIG-Q1-AAA',100,NULL,'${TRADED_LOGS}','ws',1,'held',NULL,NULL);
INSERT INTO reorgs(signature,slot,detected_at,status_source,tx_source,detail) VALUES
 ('SIG-Q1-AAA',100,1,'getTransaction','rpc','reverted');
`);

  const server = await runWebhookReceiver({ port: 0, secret: 'q1-secret', ledgerPath: ledger, log: () => {} });
  const port = server.address().port;
  fs.writeFileSync(cfg, JSON.stringify({
    targets: [{ id: 'q1', url: `http://127.0.0.1:${port}/hook`, secret: 'q1-secret', timeout_ms: 5000 }],
  }));
  try {
    const push = await spawnAsync(REEFLOG, ['webhook', 'push', '--db', db, '--config', cfg]);
    detail.push_exit = push.status;
    detail.push_stdout = scrub(push.stdout.trim().slice(0, 400), dir);
    detail.push_stderr = scrub(push.stderr.trim().slice(0, 300), dir);
    // The mailbox's own delivery receipt: both deliveries recorded.
    detail.delivered = /"delivered":\s*1/.test(push.stdout.replace(/\s+/g, ' ')) || push.stdout.includes('"delivered": 1');
    detail.reorg_delivered = /"reorg_delivered":\s*1/.test(push.stdout.replace(/\s+/g, ' ')) || push.stdout.includes('"reorg_delivered": 1');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }

  const l = fs.existsSync(ledger) ? loadLedger(ledger) : null;
  const openFills = l ? Object.keys(l.fills).length : null;
  const retractions = l ? Object.keys(l.retractions).length : null;
  const seen = l ? (l.meta || {}).retractions_seen ?? null : null;
  detail.open_fills_after_push = openFills;
  detail.retractions_after_push = retractions;
  detail.meta_retractions_seen = seen;

  if (!l) violated.push('no ledger was written at all');
  else if (openFills > 0) {
    violated.push(`the reorg was delivered (retractions_seen=${seen}) but the fill stayed OPEN — `
      + 'the ACKed retraction never reached the ledger');
  } else if (retractions !== 1) {
    violated.push(`expected the undone fill in retractions (got ${retractions})`);
  }
  return { face: 'Q1_webhook_reorg_reaches_ledger', violated: violated.length > 0,
    detail: violated.length ? violated.join('; ') : JSON.stringify(detail), ...detail };
}

// --- Q2: rescue must not resurrect an undone fill ---------------------------
async function faceQ2(dir) {
  const { loadLedger: _l, absorbRow, applyRetractions, saveLedger } =
    await import(path.join(ROOT, 'src', 'whirlpool-watcher.mjs'));
  const ledger = path.join(dir, 'q2-ledger.json');
  const parked = path.join(dir, 'q2-parked.jsonl');
  const row = { seq: 1, signature: 'SIG-Q2-AAA', slot: 1, seal: 'finalized', err: null,
    logs: ['Program data: dummy'] };

  // Disk truth: delivered, then undone by the retraction join (a fill with
  // no real Whirlpool payload — absorb records it as `other`-free leg? no:
  // decode yields zero trades for 'dummy'. Use the fixture instead.)
  const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures.json'), 'utf8'));
  const realRow = { seq: 1, signature: FIX.traded[0].signature, slot: FIX.traded[0].slot,
    seal: 'finalized', err: null, logs: [`Program data: ${FIX.traded[0].program_data}`] };
  const l = { fills: {}, retractions: {}, meta: {} };
  absorbRow(l, realRow);
  applyRetractions(l, [{ reorg_id: 1, signature: realRow.signature, slot: realRow.slot }]);
  saveLedger(ledger, l);
  fs.writeFileSync(parked, JSON.stringify(realRow) + '\n');

  const r = spawnSync(process.execPath, [CLI, 'rescue', '--file', parked, '--ledger', ledger],
    { encoding: 'utf8' });
  const s = (r.stdout || '').indexOf('{');
  const rep = s >= 0 ? JSON.parse(r.stdout.slice(s)) : null;
  const after = loadLedger(ledger);
  const openFills = Object.keys(after.fills).length;
  const retractions = Object.keys(after.retractions).length;

  const violated = [];
  if (openFills !== 0) violated.push(`rescue reopened the retracted fill (open_fills=${openFills}, `
    + `retractions=${retractions}) — the ledger claims it open AND undone`);
  if (!rep || rep.retracted_replays_ignored !== 1) {
    violated.push(`the rescue report does not name the declined replay `
      + `(retracted_replays_ignored=${rep && rep.retracted_replays_ignored})`);
  }
  return { face: 'Q2_rescue_no_resurrection', violated: violated.length > 0,
    detail: violated.length ? violated.join('; ') : `open_fills=0 retractions=1 report=${JSON.stringify(rep)}`,
    rescue_exit: r.status, open_fills: openFills, retractions };
}

// --- guards ----------------------------------------------------------------
async function guardG1(dir) {
  const { runWebhookReceiver: recv, loadLedger: l } = await import(path.join(ROOT, 'src', 'whirlpool-watcher.mjs'));
  const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures.json'), 'utf8'));
  const ledger = path.join(dir, 'g1-ledger.json');
  const server = await recv({ port: 0, secret: 'g1', ledgerPath: ledger, log: () => {} });
  const port = server.address().port;
  const body = JSON.stringify({ type: 'event', seq: 1, signature: FIX.traded[0].signature,
    slot: FIX.traded[0].slot, err: null, logs: [`Program data: ${FIX.traded[0].program_data}`] });
  const { createHmac } = await import('node:crypto');
  const res = await fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST',
    headers: { 'content-type': 'application/json',
      'x-reeflog-signature': `sha256=${createHmac('sha256', 'g1').update(body).digest('hex')}` },
    body });
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  const fills = fs.existsSync(ledger) ? Object.keys(l(ledger).fills).length : null;
  const violated = [];
  if (res.status !== 200) violated.push(`event ACK moved: ${res.status}`);
  if (fills !== 1) violated.push(`fill count moved: ${fills}`);
  return { face: 'G1_event_delivery_still_records_the_fill', violated: violated.length > 0,
    detail: violated.length ? violated.join('; ') : 'status=200 fills=1' };
}

async function guardG2(dir) {
  const { loadLedger: l, absorbRow, applyRetractions } = await import(path.join(ROOT, 'src', 'whirlpool-watcher.mjs'));
  const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures.json'), 'utf8'));
  const ledger = { fills: {}, retractions: {}, meta: {} };
  absorbRow(ledger, { seq: 1, signature: FIX.traded[0].signature, slot: 1, seal: 'finalized',
    err: null, logs: [`Program data: ${FIX.traded[0].program_data}`] });
  const before = Object.keys(ledger.fills).length;
  applyRetractions(ledger, [{ reorg_id: 1, signature: 'NEVER-READ', slot: 1 }]);
  const after = Object.keys(ledger.fills).length;
  const retractions = Object.keys(ledger.retractions).length;
  const violated = [];
  if (before !== 1) violated.push(`setup moved: ${before}`);
  if (after !== before) violated.push('an unknown signature undid a fill it never read');
  if (retractions !== 0) violated.push(`unknown signature wrote a retraction record: ${retractions}`);
  return { face: 'G2_unknown_signature_stays_a_report', violated: violated.length > 0,
    detail: violated.length ? violated.join('; ') : 'scope held' };
}

async function guardG3(dir) {
  const ledger = path.join(dir, 'g3-ledger.json');
  const parked = path.join(dir, 'g3-parked.jsonl');
  const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures.json'), 'utf8'));
  fs.writeFileSync(parked, JSON.stringify({ seq: 2, signature: FIX.traded[1].signature,
    slot: FIX.traded[1].slot, seal: 'finalized', err: null,
    logs: [`Program data: ${FIX.traded[1].program_data}`] }) + '\n');
  const r = spawnSync(process.execPath, [CLI, 'rescue', '--file', parked, '--ledger', ledger],
    { encoding: 'utf8' });
  const s = (r.stdout || '').indexOf('{');
  const rep = s >= 0 ? JSON.parse(r.stdout.slice(s)) : null;
  const fills = fs.existsSync(ledger) ? Object.keys(loadLedger(ledger).fills).length : null;
  const violated = [];
  if (r.status !== 0) violated.push(`rescue of a new row exited ${r.status}`);
  if (!rep || rep.fills !== 1) violated.push(`a real new fill did not land (fills=${rep && rep.fills})`);
  if (fills !== 1) violated.push(`ledger fills=${fills}`);
  return { face: 'G3_rescue_still_records_a_new_row', violated: violated.length > 0,
    detail: violated.length ? violated.join('; ') : 'status=0 fills=1' };
}

async function main() {
  needReeflog();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-q-'));
  const faces = [];
  faces.push(await faceQ1(dir));
  faces.push(await faceQ2(dir));
  faces.push(await guardG1(dir));
  faces.push(await guardG2(dir));
  faces.push(await guardG3(dir));

  const violated = faces.filter((x) => x.violated).map((x) => x.face);
  const defectFaces = ['Q1_webhook_reorg_reaches_ledger', 'Q2_rescue_no_resurrection'];
  const violatedDefects = violated.filter((f) => defectFaces.includes(f));
  const violatedGuards = violated.filter((f) => !defectFaces.includes(f));
  const consistent = !EXPECT
    ? true
    : EXPECT === 'violations' ? violatedDefects.length > 0 && violatedGuards.length === 0
      : violated.length === 0;

  const out = {
    measured_at: new Date().toISOString(),
    what: 'a retraction ACKed on the webhook must be applied to the ledger, and a rescue replay must never resurrect an undone fill',
    seat: {
      kind: 'watcher tree + REAL reeflog binary (webhook push over a local receiver)',
      watcher_commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
      reeflog_binary: REEFLOG,
      reeflog_sha: spawnSync('sha256sum', [REEFLOG], { encoding: 'utf8' }).stdout.trim().split(/\s+/)[0] || null,
      label: LABEL,
    },
    faces,
    summary: {
      total: faces.length,
      violated_count: violated.length,
      violated_defect_faces: violatedDefects,
      violated_guards: violatedGuards,
      expectation: EXPECT === 'violations'
        ? 'pre-fix tree: at least one DEFECT face must violate, no guard may'
        : EXPECT === 'clean' ? 'fixed tree: no face may violate' : 'none (report only)',
      measurement_consistent: consistent,
    },
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(consistent ? 0 : 1);
}

await main();
