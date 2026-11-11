// PULS Q — THE WEBHOOK RETRACTION NEVER REACHES THE LEDGER, AND A RESCUE
// RESURRECTS WHAT A RETRACTION UNDID.
//
// One rule, two mouths: the ledger holds open fills and undone fills as two
// different objects (`fills` and `retractions`), and every path that adds a
// fill must first give the retractions their say. Two paths do not:
//
//   Q1 the webhook retraction branch records the EVENT, not the JOIN.
//      The retraction join (`applyRetractions`) — the code that moves a fill
//      from `fills` to `retractions` — is called ONLY by `watchRetractions`
//      (retract/tail mode). The webhook's `type === 'reorg'` branch bumps
//      `meta.retractions_seen`, answers 200, and touches the ledger no
//      further (hand-measured 2026-11-11 on addbb50: fill open before the
//      reorg delivery, open after it, `retractions_seen: 1` printed next to
//      the still-open fill). reeflog has delivered its retraction channel
//      (webhook.rs `deliver_reorgs`, in `reorg_id` order, dedup on the
//      target's own cursor) and the delivery receipt is durable — the undo
//      lives only in this consumer, and the webhook path never runs it.
//      The reorg rows `watchRetractions` joins come from `reeflog reorg
//      tail`, a SEPARATE cursor a webhook deployment will never also walk:
//      the retraction the webhook ACKed is lost to the undo forever. A
//      reeflog retraction is a VERDICT about an already-delivered event,
//      not a payload at-least-once will redeliver.
//   Q2 the rescue replay resurrects a retracted fill. `absorbRow` dedups on
//      `${signature}:${pool}:${input}:${output}:${lp_fee}` — checked ONLY
//      against `ledger.fills`. A key sitting in `ledger.retractions` is
//      invisible to it, so replaying a row whose fill was already undone
//      puts the fill BACK into `fills` while the retraction record survives
//      beside it: the ledger then claims the same fill is both open and
//      undone (hand-measured 2026-11-11: after a retract pass, `rescue` of
//      the same parked row answers `open_fills: 1` with exit 0).
//      The rescue file exists precisely because its rows were consumed once
//      already — "already delivered" rows are its whole population — so the
//      redelivery window the dedup guards applies to EVERY key the
//      retraction join has moved.
//
// Guards (GREEN on the pre-fix tree too — say so explicitly):
//   GQ1 a fresh fill with no retraction on record is absorbed exactly as
//       before (the common path must not move). GREEN on both trees.
//   GQ2 a reorg naming a signature this consumer never read stays a report,
//       never an unfill (the scoped-undo contract). GREEN on both trees.
//   GQ3 the same reorg row replayed does not move anything twice
//       (idempotence of the join). GREEN on both trees — vacuously on the
//       pre-fix tree, where the join never runs; the assertion is therefore
//       written so Q1's fix must keep it true.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

import {
  loadLedger, saveLedger, absorbRow, applyRetractions, runWebhookReceiver,
} from '../src/whirlpool-watcher.mjs';

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;

function tmpdir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-pulsq-'));
  t.after(() => { fs.rmSync(d, { recursive: true, force: true }); });
  return d;
}

function rowOf(i, seq = i + 1) {
  return {
    type: 'event',
    seq,
    signature: FIX.traded[i].signature,
    slot: FIX.traded[i].slot,
    err: null,
    seal: 'finalized',
    logs: [`Program data: ${FIX.traded[i].program_data}`],
  };
}

function reorgOf(i, id = i + 1) {
  return {
    type: 'reorg',
    reorg_id: id,
    signature: FIX.traded[i].signature,
    slot: FIX.traded[i].slot,
    detected_at: 1,
    status_source: 'getTransaction',
    tx_source: 'rpc',
    detail: 'transaction reverted on a later check',
  };
}

// POST signed payloads through the REAL webhook receiver, like reeflog
// would. Returns the statuses.
async function hook(ledgerPath, payloads) {
  const server = await runWebhookReceiver({
    port: 0, secret: '***', ledgerPath, log: () => {},
  });
  const port = server.address().port;
  const out = [];
  try {
    for (const p of payloads) {
      const body = JSON.stringify(p);
      const res = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-reeflog-signature': `sha256=${createHmac('sha256', '***').update(body).digest('hex')}`,
        },
        body,
      });
      out.push(res.status);
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  return out;
}

// --- the defect faces (RED on addbb50) ---------------------------------------

test('Q1: a webhook reorg UNDOES the fill this consumer recorded', async (t) => {
  const d = tmpdir(t);
  const ledgerFile = path.join(d, 'ledger.json');
  // 1. the fill arrives and is ACKed (delivery durable on both sides).
  assert.deepEqual(await hook(ledgerFile, [rowOf(0)]), [200]);
  assert.equal(Object.keys(loadLedger(ledgerFile).fills).length, 1,
    'setup: the fill is open before the retraction arrives');
  // 2. the retraction arrives over the same channel and is ACKed 200 —
  //    reeflog records the receipt and will NEVER redeliver this reorg.
  assert.deepEqual(await hook(ledgerFile, [reorgOf(0)]), [200]);
  const ledger = loadLedger(ledgerFile);
  assert.equal(Object.keys(ledger.fills).length, 0,
    'a retraction of a fill this consumer read must undo it — the ACK meant the verdict, not just the receipt');
  assert.equal(Object.keys(ledger.retractions).length, 1,
    'the undone fill must be recorded as undone, with the reorg attached');
  const undone = Object.values(ledger.retractions)[0];
  assert.equal(undone.signature, FIX.traded[0].signature);
  assert.ok(undone.reorg, 'the retraction record must name the reorg that undid it');
});

test('Q1b: the webhook retraction stays scoped — only the retracted signature is undone', async (t) => {
  const d = tmpdir(t);
  const ledgerFile = path.join(d, 'ledger.json');
  assert.deepEqual(await hook(ledgerFile, [rowOf(0), rowOf(1)]), [200, 200]);
  assert.deepEqual(await hook(ledgerFile, [reorgOf(1)]), [200]);
  const ledger = loadLedger(ledgerFile);
  assert.equal(Object.keys(ledger.fills).length, 1,
    'only the retracted signature is undone — the other fill stays open');
  assert.equal(Object.values(ledger.fills)[0].signature, FIX.traded[0].signature);
  assert.equal(Object.keys(ledger.retractions).length, 1);
  assert.equal(Object.values(ledger.retractions)[0].signature, FIX.traded[1].signature);
});

test('Q1c: the webhook retraction is idempotent — the same reorg id twice moves nothing twice', async (t) => {
  const d = tmpdir(t);
  const ledgerFile = path.join(d, 'ledger.json');
  await hook(ledgerFile, [rowOf(0)]);
  await hook(ledgerFile, [reorgOf(0)]);
  const first = loadLedger(ledgerFile);
  assert.equal(Object.keys(first.fills).length, 0, 'setup: Q1 fixed, fill undone');
  // reeflog retries on its own clock when a 200 is lost mid-response: the
  // same reorg id arrives again.
  assert.deepEqual(await hook(ledgerFile, [reorgOf(0)]), [200]);
  const after = loadLedger(ledgerFile);
  assert.equal(Object.keys(after.retractions).length, 1,
    'the same reorg must not grow the retractions map');
  assert.equal(Object.keys(after.fills).length, 0);
});

test('Q2: the rescue replay must not resurrect a retracted fill', (t) => {
  const d = tmpdir(t);
  const ledgerFile = path.join(d, 'ledger.json');
  // Disk truth: the fill was delivered and then undone (retract path ran).
  const ledger = { fills: {}, retractions: {}, meta: {} };
  const row = { seq: 1, signature: FIX.traded[0].signature, slot: FIX.traded[0].slot,
    seal: 'finalized', err: null, logs: [`Program data: ${FIX.traded[0].program_data}`] };
  absorbRow(ledger, row);
  applyRetractions(ledger, [{ reorg_id: 1, signature: row.signature, slot: row.slot }]);
  saveLedger(ledgerFile, ledger);
  assert.equal(Object.keys(loadLedger(ledgerFile).fills).length, 0,
    'setup: the fill is undone on disk');
  // A parked rescue file from an older refused run replays the SAME row.
  const parked = path.join(d, 'parked.jsonl');
  fs.writeFileSync(parked, JSON.stringify(row) + '\n');
  const r = spawnSync(process.execPath, [CLI, 'rescue', '--file', parked, '--ledger', ledgerFile],
    { encoding: 'utf8' });
  const s = (r.stdout || '').indexOf('{');
  assert.ok(s >= 0, `no rescue JSON report (stderr: ${JSON.stringify(r.stderr)})`);
  const rep = JSON.parse(r.stdout.slice(s));
  const after = loadLedger(ledgerFile);
  assert.equal(Object.keys(after.fills).length, 0,
    'a row whose fill is already undone must not reopen it — open and undone cannot both be true');
  assert.equal(Object.keys(after.retractions).length, 1);
  assert.equal(rep.retracted_replays_ignored, 1,
    'the rescue report must NAME what it declined to resurrect — silence about a skipped row is the same lie class as the stamped verdict');
});

// --- guards (GREEN on both trees) --------------------------------------------

test('GQ1 (guard): a fresh fill with no retraction on record is absorbed exactly as before', (t) => {
  const ledger = { fills: {}, retractions: {}, meta: {} };
  const row = { seq: 1, signature: FIX.traded[0].signature, slot: FIX.traded[0].slot,
    seal: 'finalized', err: null, logs: [`Program data: ${FIX.traded[0].program_data}`] };
  const r = absorbRow(ledger, row);
  assert.equal(r.fills, 1);
  assert.equal(r.dupes, 0);
  assert.equal(Object.keys(ledger.fills).length, 1, 'the common path must not move');
});

test('GQ2 (guard): a reorg for a signature this consumer never read stays a report, not an unfill', (t) => {
  const ledger = { fills: {}, retractions: {}, meta: {} };
  const row = { seq: 1, signature: FIX.traded[0].signature, slot: FIX.traded[0].slot,
    seal: 'finalized', err: null, logs: [`Program data: ${FIX.traded[0].program_data}`] };
  absorbRow(ledger, row);
  const before = Object.keys(ledger.fills).length;
  applyRetractions(ledger, [{ reorg_id: 1, signature: 'NEVER-READ-SIGNATURE', slot: 1 }]);
  assert.equal(Object.keys(ledger.fills).length, before,
    'an unknown signature must never unfill somebody else\'s fill');
  assert.equal(Object.keys(ledger.retractions).length, 0);
});

test('GQ3 (guard): rescue of a genuinely NEW row still records it (fix must not over-tighten)', (t) => {
  const d = tmpdir(t);
  const ledgerFile = path.join(d, 'ledger.json');
  // Pre-fix tree: rescue already does this; the pin guards the fix.
  const row = { seq: 2, signature: FIX.traded[1].signature, slot: FIX.traded[1].slot,
    seal: 'finalized', err: null, logs: [`Program data: ${FIX.traded[1].program_data}`] };
  const parked = path.join(d, 'parked.jsonl');
  fs.writeFileSync(parked, JSON.stringify(row) + '\n');
  const r = spawnSync(process.execPath, [CLI, 'rescue', '--file', parked, '--ledger', ledgerFile],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(rep.fills, 1, 'a real new fill still lands through rescue');
  assert.equal(Object.keys(loadLedger(ledgerFile).fills).length, 1);
});
