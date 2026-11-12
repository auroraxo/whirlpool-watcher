// PULS Y — A RETRACTION THAT ARRIVES BEFORE ITS EVENT IS A VERDICT THIS
// CONSUMER ALREADY OWES, NOT A REPORT IT CAN DROP.
//
// The two channels of the mailbox cross. reeflog delivers events in `seq`
// order and retractions in `reorg_id` order (webhook.rs deliver_events /
// deliver_reorgs), and both orders are independent: a retraction can be
// recorded — and delivered — while the event it undoes is still in the
// journal, undelivered (event queue blocked → retractions jump ahead on
// purpose; a `--limit` cut; a retract cron firing before the tail cron;
// `reeflog reorg tail` in one process, `reeflog tail` in another). On that
// crossing the pre-fix consumer answered "no such fill" (200, exit 0,
// COMPLETE) and remembered nothing. The retraction cursor/webhook receipt
// then moved PAST the verdict — reeflog will never deliver it again — and
// when the event finally arrived, absorbRow booked it OPEN.
//
// Hand-reproduced 2026-11-12 on 0cb1641, both channels:
//   CLI:  retract → undoable:0 COMPLETE; tail → fills:1 exit 0 COMPLETE;
//         ledger ends open_fills=1, retractions={} — the ledger claims
//         open a fill the chain reverted. Nothing re-checks it: the reorg
//         channel is drained (reorgs_after(cursor) is empty forever).
//   hook: reorg-first 200 (retractions_unknown grows), SAME reorg
//         redelivered 200 (second report — the "health" is a counter of
//         known-unknowns), then event 200 → fill open forever.
//
// The fix (test-first): a retraction over a signature this ledger does not
// hold becomes a DURABLE VERDICT — meta.retractions_pending keyed by the
// signature, recording every reorg id that named it. When absorbRow later
// sees a delivery for that signature, it refuses to open the fill (the
// chain reverted it), moves the evidence to retractions via the join, and
// reports retraction_first_ignored. absorbRow must consult ONLY
// retractions_pending for this: pending-vs-held is a channel-ordering
// fact, not dedup — GY3 keeps a normal replay (fill held, no pending)
// deduping exactly as before.
//
// Guards (GREEN on BOTH trees — say so explicitly):
//   GY1 the GQ1/Q1 in-order path is byte-for-byte unchanged: event then
//       reorg still moves the fill to retractions.
//   GY2 an unknown-signature retraction with NO later event stays exactly
//       what it was (a report; scoped-undo untouched).
//   GY3 a normal duplicate delivery (fill held, nothing pending) still
//       dedups through `fills` — the pending check must not widen.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  loadLedger, absorbRow, applyRetractions, runWebhookReceiver, saveLedger, mergeLedger as importMerge,
} from '../src/whirlpool-watcher.mjs';

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const REEFLOG = process.env.REEFLOG_BIN
  || path.join(os.homedir(), 'github_repos', 'reeflog', 'target', 'release', 'reeflog');

function tmpdir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-pulsy-'));
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

async function hook(ledgerPath, payloads) {
  const server = await runWebhookReceiver({ port: 0, secret: '***', ledgerPath, log: () => {} });
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

function sqlite(db, sqlText) {
  const d = new DatabaseSync(db);
  d.exec(sqlText);
  d.close();
}

// Y1 — the crossing, end to end, through the REAL receiver with the REAL
// reeflog delivery order (event queue blocked → retractions jump ahead):
// reorg first (unknown signature at that moment), then the event.
test('Y1: a retraction delivered before its event undoes the fill when the event arrives (webhook channel)', async (t) => {
  const d = tmpdir(t);
  const ledgerFile = path.join(d, 'ledger.json');
  // 1. The retraction jumps the blocked event queue and is ACKed 200 —
  //    reeflog's receipt is durable; this reorg id will NEVER redeliver.
  assert.deepEqual(await hook(ledgerFile, [reorgOf(0)]), [200]);
  const afterReorg = loadLedger(ledgerFile);
  assert.equal(Object.keys(afterReorg.fills).length, 0,
    'the event has not been read yet — nothing is undone yet');
  assert.ok(Array.isArray(afterReorg.meta.retractions_pending)
    && afterReorg.meta.retractions_pending.length === 1,
    'the verdict must be recorded as PENDING, not dropped into a counter');
  assert.equal(afterReorg.meta.retractions_pending[0].signature, FIX.traded[0].signature);
  // 2. The event arrives — the pre-fix consumer booked it OPEN forever.
  assert.deepEqual(await hook(ledgerFile, [rowOf(0)]), [200]);
  const ledger = loadLedger(ledgerFile);
  assert.equal(Object.keys(ledger.fills).length, 0,
    'the chain reverted this transaction — a fill delivered AFTER its own retraction verdict must never open');
  assert.equal(Object.keys(ledger.retractions).length, 1,
    'the undone fill must be recorded as undone, exactly like the in-order join');
  assert.equal(Object.values(ledger.retractions)[0].signature, FIX.traded[0].signature);
  assert.ok(Object.values(ledger.retractions)[0].reorg,
    'the retraction record must carry the pending verdict (the reorg that undid it)');
});

// Y2 — same crossing on the CLI/retract channel: retract drains the reorg
// channel first (its cursor moves PAST the verdict), then tail delivers.
test('Y2: retract drains the reorg cursor first, tail delivers after — the fill still cannot open (CLI channel)', async (t) => {
  const d = tmpdir(t);
  const db = path.join(d, 'db');
  const LOGS = JSON.stringify([
    `Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke [1]`,
    `Program data: ${FIX.traded[0].program_data}`,
    `Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc success`,
  ]);
  const r0 = spawnSync(REEFLOG, ['init', '--db', db, '--program', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'], { encoding: 'utf8' });
  assert.equal(r0.status, 0, `reeflog init failed: ${r0.stderr}`);
  const j = new DatabaseSync(db);
  j.exec(`INSERT INTO events(seq,signature,slot,err,logs,source,first_seen,payload_state,accounts,account_state)
    VALUES (1,'${FIX.traded[0].signature}',100,NULL,'${LOGS.replace(/'/g, "''")}','ws',1,'held',NULL,NULL);
    INSERT INTO reorgs(signature,slot,detected_at,status_source,tx_source,detail)
    VALUES ('${FIX.traded[0].signature}',100,1,'getTransaction','rpc','reverted');`);
  j.close();
  // 1. retract first: the reorg channel is drained, its cursor moves past
  //    the verdict. Pre-fix: undoable 0, COMPLETE, nothing remembered.
  const r1 = spawnSync(process.execPath, [CLI, 'retract', '--db', db, '--cursor', path.join(d, 'rc'),
    '--ledger', path.join(d, 'L.json'), '--bin', REEFLOG], { encoding: 'utf8' });
  assert.equal(r1.status, 0, `retract run failed: ${r1.stderr}`);
  const rep1 = JSON.parse(r1.stdout.slice(r1.stdout.indexOf('{')));
  assert.equal(rep1.undoable, 0, 'setup: nothing to undo yet');
  assert.equal(rep1.pending_recorded, 1,
    'the retract report must NAME the verdict it stored as pending');
  assert.equal(Object.keys(loadLedger(path.join(d, 'L.json')).meta.retractions_pending || []).length, 1,
    'the unknown-signature retraction must become a durable pending verdict, not a counter bump');
  // 2. tail second: the event whose verdict already arrived is delivered.
  const r2 = spawnSync(process.execPath, [CLI, 'tail', '--db', db, '--cursor', path.join(d, 'ec'),
    '--ledger', path.join(d, 'L.json'), '--bin', REEFLOG], { encoding: 'utf8' });
  assert.equal(r2.status, 0, `tail run failed: ${r2.stderr}`);
  const rep2 = JSON.parse(r2.stdout.slice(r2.stdout.indexOf('{')));
  assert.equal(rep2.retraction_first_ignored, 1,
    'the tail report must NAME the delivery the pending verdict refused');
  const ledger = loadLedger(path.join(d, 'L.json'));
  assert.equal(Object.keys(ledger.fills).length, 0,
    'the reverted transaction must not be open in the ledger');
  assert.equal(Object.keys(ledger.retractions).length, 1,
    'the fill lands in retractions, with the pending verdict attached');
  assert.equal((ledger.meta.retractions_pending || []).length, 0,
    'the pending verdict is consumed by the delivery it names');
  assert.equal(rep2.verdict, 'COMPLETE');
});

// Y3 — idempotence: a redelivered reorg for a signature already pending
// updates the verdict in place instead of growing the list.
test('Y3: the same reorg id redelivered while pending updates the verdict, not the list', async (t) => {
  const d = tmpdir(t);
  const ledgerFile = path.join(d, 'ledger.json');
  assert.deepEqual(await hook(ledgerFile, [reorgOf(0)]), [200]);
  assert.deepEqual(await hook(ledgerFile, [reorgOf(0)]), [200]);
  const ledger = loadLedger(ledgerFile);
  assert.equal(ledger.meta.retractions_pending.length, 1,
    'the same signature twice must hold ONE verdict');
  assert.deepEqual(ledger.meta.retractions_pending[0].reorg_ids, [1],
    'the same reorg id must not be listed twice (a lost 200 is a redelivery, not a new verdict)');
  assert.equal(Object.keys(ledger.fills).length, 0);
});

// Y4 — a DIFFERENT reorg id for the same signature extends the verdict.
test('Y4: a second reorg id for the same signature extends the pending verdict', async (t) => {
  const d = tmpdir(t);
  const ledgerFile = path.join(d, 'ledger.json');
  assert.deepEqual(await hook(ledgerFile, [reorgOf(0, 1), reorgOf(0, 2)]), [200, 200]);
  const ledger = loadLedger(ledgerFile);
  assert.equal(ledger.meta.retractions_pending.length, 1);
  assert.deepEqual(ledger.meta.retractions_pending[0].reorg_ids, [1, 2]);
});

// Y5 — concurrency / merge: two instances running concurrently each see a
// pending retraction for a DIFFERENT signature. mergeLedger must union
// them (with reorg_id union), not drop one side's verdict.
test('Y5: mergeLedger unions meta.retractions_pending without dropping either side', () => {
  const disk = {
    fills: {},
    retractions: {},
    meta: {
      retractions_pending: [
        { signature: 'SIG-DISK', slot: 100, reorg_ids: [1] },
        { signature: 'SIG-BOTH', slot: 100, reorg_ids: [10] },
      ],
    },
  };
  const mine = {
    fills: {},
    retractions: {},
    meta: {
      retractions_pending: [
        { signature: 'SIG-MINE', slot: 101, reorg_ids: [2] },
        { signature: 'SIG-BOTH', slot: 100, reorg_ids: [11] },
      ],
    },
  };
  const merged = importMerge(disk, mine);
  const pending = merged.meta.retractions_pending;
  assert.equal(pending.length, 3, 'both unique signatures and the shared signature must survive');
  const both = pending.find((p) => p.signature === 'SIG-BOTH');
  assert.deepEqual(both.reorg_ids.sort(), [10, 11], 'the reorg_id trail for shared signatures must merge');
});

// --- guards (GREEN on BOTH trees) -------------------------------------------

// GY1: the in-order path (event first, retraction second) is untouched —
// this is the Q1 contract PULS Q delivered; the pending rule must not move it.
test('GY1 (guard): in-order retraction still undoes exactly as before', async (t) => {
  const d = tmpdir(t);
  const ledgerFile = path.join(d, 'ledger.json');
  assert.deepEqual(await hook(ledgerFile, [rowOf(0), reorgOf(0)]), [200, 200]);
  const ledger = loadLedger(ledgerFile);
  assert.equal(Object.keys(ledger.fills).length, 0);
  assert.equal(Object.keys(ledger.retractions).length, 1);
  assert.equal((ledger.meta.retractions_pending || []).length, 0,
    'the fill was held — no pending verdict may exist in the in-order path');
});

// GY2: an unknown-signature retraction with no later event stays a report,
// never an unfill (the scoped-undo contract, unchanged).
test('GY2 (guard): a retraction for a signature never delivered stays scoped', async (t) => {
  const ledger = { fills: {}, retractions: {}, meta: {} };
  absorbRow(ledger, rowOf(0));
  const before = Object.keys(ledger.fills).length;
  applyRetractions(ledger, [{ reorg_id: 1, signature: 'NEVER-READ', slot: 1 }]);
  assert.equal(Object.keys(ledger.fills).length, before);
  assert.equal(Object.keys(ledger.retractions).length, 0);
});

// GY3: a NORMAL replay (fill held, nothing pending) must still dedup
// through `fills` — the pending check must not swallow the dedup contract.
test('GY3 (guard): a held fill without any pending verdict dedups as before', (t) => {
  const ledger = { fills: {}, retractions: {}, meta: {} };
  absorbRow(ledger, rowOf(0));
  const r = absorbRow(ledger, rowOf(0));
  assert.equal(r.dupes, 1, 'the replay is a duplicate, exactly as before');
  assert.equal(r.retraction_first_ignored || 0, 0,
    'no pending verdict exists — the replay is a duplicate, not a refused opening');
  assert.equal(Object.keys(ledger.fills).length, 1);
});
