// PULS M pin — the consumer's ledger contract, in the vocabulary that
// already existed at 658951c, so this file COMPILES on the baseline tree and
// goes RED there by BEHAVIOR, not by a missing export.
//
// Baseline behavior (measured 2026-11-10 against the published reeflog
// v0.7.14 seat, research/consumer-ledger-durability-baseline-2026-11-10
// .json): three of these five tests FAIL at 658951c:
//   C1 a corrupt ledger was swallowed into a fresh empty one (loadLedger
//      returned {fills:{}} instead of refusing) — F1/F4/F5;
//   C2 the tail run spawned the mailbox anyway and died AFTER the cursor
//      advanced — the fills were consumed and never redelivered — F2;
//   C4 the webhook answered 200 ok over an erased ledger, recording a
//      delivery receipt the mailbox will honour forever — F4.
// C3 and C5 are guards that held before and must keep holding.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

import {
  loadLedger, saveLedger, absorbRow, runWebhookReceiver,
} from '../src/whirlpool-watcher.mjs';

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;

function tmpdir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-contract-'));
  t.after(() => {
    const unlock = (p) => {
      try { fs.chmodSync(p, 0o700); } catch { /* gone */ }
      let ents;
      try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of ents) if (e.isDirectory()) unlock(path.join(p, e.name));
    };
    unlock(d);
    fs.rmSync(d, { recursive: true, force: true });
  });
  return d;
}

const corrupt = (file) => fs.writeFileSync(file, '{"fills": {"broken": ');

// --- C1: a corrupt ledger is a REFUSAL, never a fresh start ---------------
test('C1: loadLedger refuses a corrupt file and leaves it byte-identical', (t) => {
  const d = tmpdir(t);
  const file = path.join(d, 'ledger.json');
  corrupt(file);
  const before = fs.readFileSync(file, 'utf8');

  assert.throws(
    () => loadLedger(file),
    (err) => /refus/i.test(err.message) && err.message.includes(file),
    'a ledger that does not parse must refuse naming the file — not return an empty one',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before,
    'the refused file must be untouched');
});

// --- C2: the tail run must not consume when its ledger is broken ----------
test('C2: a tail run with a corrupt ledger refuses BEFORE the mailbox is read', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'ledger.json');
  corrupt(ledger);
  const cursor = path.join(d, 'cursor.txt');
  const marker = path.join(d, 'mailbox-ran');
  // A fake mailbox that records it was invoked and advances the cursor like
  // the real one (the advance is the whole hazard: rows printed are rows
  // consumed).
  const bin = path.join(d, 'fake-reeflog');
  fs.writeFileSync(bin, `#!/bin/sh\ntouch ${marker}\nprintf '1\\n' > "$5"\nexit 0\n`);
  fs.chmodSync(bin, 0o755);

  const r = spawnSync(process.execPath, [CLI, 'tail', '--db', path.join(d, 'j.db'),
    '--cursor', cursor, '--bin', bin, '--ledger', ledger], { encoding: 'utf8' });

  assert.equal(r.status, 3, `a corrupt ledger must exit 3 (refusal), got ${r.status}`);
  assert.equal(fs.existsSync(marker), false,
    'the mailbox must NOT be invoked: rows it prints are rows it consumes');
  assert.equal(fs.readFileSync(ledger, 'utf8').includes('broken'), true,
    'the corrupt bytes must still be there — nothing was overwritten');
});

// --- C3 (guard): a missing ledger is still the first run -------------------
test('C3: a missing ledger is the documented first run, not a refusal', (t) => {
  const d = tmpdir(t);
  const ledger = loadLedger(path.join(d, 'never-existed.json'));
  assert.deepEqual(ledger, { fills: {}, retractions: {}, meta: {} });
});

// --- C4: the webhook ACKs only a durable delivery --------------------------
test('C4: webhook answers 503 over a corrupt ledger and does not overwrite it', async (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'ledger.json');
  corrupt(ledger);
  const before = fs.readFileSync(ledger, 'utf8');

  const server = await runWebhookReceiver({
    port: 0, secret: 'pinsecret', ledgerPath: ledger, log: () => {},
  });
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });
  const port = server.address().port;

  const body = JSON.stringify({ type: 'event', seq: 1, signature: 'x', slot: 1, err: null, logs: null });
  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-reeflog-signature': `sha256=${createHmac('sha256', 'pinsecret').update(body).digest('hex')}`,
    },
    body,
  });

  assert.equal(res.status, 503,
    'an unreadable ledger must refuse (retry-later) so the mailbox keeps the event owed — a 200 records a receipt for a history that was never read');
  assert.equal(fs.readFileSync(ledger, 'utf8'), before,
    'the refused ledger must be untouched');
});

test('C4b: webhook ACKs 200 and records the fill once the ledger is sound', async (t) => {
  const d = tmpdir(t);
  const ledgerFile = path.join(d, 'ledger.json');
  saveLedger(ledgerFile, { fills: {}, retractions: {}, meta: {} });

  const server = await runWebhookReceiver({
    port: 0, secret: 'pinsecret', ledgerPath: ledgerFile, log: () => {},
  });
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });
  const port = server.address().port;

  const body = JSON.stringify({
    type: 'event', seq: 1, signature: FIX.traded[0].signature, slot: FIX.traded[0].slot,
    err: null, logs: [`Program data: ${FIX.traded[0].program_data}`],
  });
  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-reeflog-signature': `sha256=${createHmac('sha256', 'pinsecret').update(body).digest('hex')}`,
    },
    body,
  });
  assert.equal(res.status, 200);
  assert.equal(Object.keys(loadLedger(ledgerFile).fills).length, 1,
    'the fill must be recorded before the ACK');
});

test('C4c: webhook answers 503 (not 200) when only the SAVE fails', async (t) => {
  const d = tmpdir(t);
  const home = path.join(d, 'home');
  fs.mkdirSync(home, { recursive: true });
  const ledgerFile = path.join(home, 'ledger.json');
  saveLedger(ledgerFile, { fills: {}, retractions: {}, meta: {} });

  const secret = '***';
  const server = await runWebhookReceiver({
    port: 0, secret, ledgerPath: ledgerFile, log: () => {},
  });
  t.after(() => {
    try { fs.chmodSync(home, 0o700); } catch { /* best effort */ }
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });
  const port = server.address().port;
  const post = (seq) => {
    const body = JSON.stringify({
      type: 'event', seq, signature: `sig${seq}`, slot: 1, err: null, logs: null,
    });
    return fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-reeflog-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
      body,
    });
  };

  const ok = await post(1);
  assert.equal(ok.status, 200, 'the first durable save must ACK');

  fs.chmodSync(home, 0o500);
  const refused = await post(2);
  assert.equal(refused.status, 503,
    'a save that could not become durable must refuse (retry later)');
  const after = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.equal(after.fills.sig2, undefined,
    'the undurable fill must not appear in the ledger');
});

// --- C5 (guard): a full clean tail run still works -------------------------
test('C5: a healthy tail run delivers, reports COMPLETE, and exits 0', (t) => {
  const d = tmpdir(t);
  const row = {
    seq: 1, signature: FIX.traded[0].signature, slot: 1, seal: 'finalized', err: null,
    logs: [`Program data: ${FIX.traded[0].program_data}`],
  };
  const bin = path.join(d, 'fake-reeflog');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(row).replace(/'/g, "'\\''")}'\nprintf '1\\n' > "$5"\nexit 0\n`);
  fs.chmodSync(bin, 0o755);
  const ledgerFile = path.join(d, 'ledger.json');
  const r = spawnSync(process.execPath, [CLI, 'tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'cursor.txt'), '--bin', bin, '--ledger', ledgerFile],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, `clean run exits 0 (stderr: ${r.stderr})`);
  const rep = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(rep.verdict, 'COMPLETE');
  assert.equal(rep.fills, 1);
  assert.equal(Object.keys(loadLedger(ledgerFile).fills).length, 1);
});
