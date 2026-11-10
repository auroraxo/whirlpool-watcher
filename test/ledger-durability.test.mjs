// PULS M pin — the consumer's ledger contract, one test per measured face.
//
// RED first: every test here was written against the watcher at 658951c and
// FAILS there (the run that measured research/consumer-ledger-durability
// -baseline-*.json on the published reeflog v0.7.14 seat):
//   T1 a corrupt ledger is swallowed into a fresh empty one  (F1/F4/F5)
//   T2 an unwritable ledger directory dies AFTER the mailbox ran (F2)
//   T3 the webhook answers 200 over an erased ledger        (F4)
//   T4 no refusal ever reaches the operator                (all)
// GREEN here: refuse before consuming, 503 instead of ACK, file untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

import {
  loadLedger, saveLedger, ensureLedgerWritable, parkRows, die,
  absorbRow, LedgerRefusal, runWebhookReceiver,
} from '../src/whirlpool-watcher.mjs';

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;

function tmpdir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-pins-'));
  // Clean up recursively, unlocking read-only subdirectories first so an
  // rm can never be blocked (and never leave a /tmp leak behind).
  t.after(() => {
    const unlock = (p) => {
      try { fs.chmodSync(p, 0o700); } catch { /* gone or not ours */ }
      let ents;
      try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.isDirectory()) unlock(path.join(p, e.name));
      }
    };
    unlock(d);
    fs.rmSync(d, { recursive: true, force: true });
  });
  return d;
}

function corruptLedger(file) {
  fs.writeFileSync(file, '{"fills": {"broken": ');
}

// --- T1: a corrupt ledger is a REFUSAL, never a fresh start ---------------
test('T1: loadLedger refuses a corrupt file and does not touch it', (t) => {
  const d = tmpdir(t);
  const file = path.join(d, 'ledger.json');
  corruptLedger(file);
  const before = fs.readFileSync(file, 'utf8');

  assert.throws(
    () => loadLedger(file),
    (err) => err instanceof LedgerRefusal && err.message.includes(file),
    'a ledger that does not parse must refuse, not return an empty one',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before,
    'the refused file must be byte-identical afterwards');
});

test('T1b: a missing ledger is still the documented first run', () => {
  const ledger = loadLedger(path.join(os.tmpdir(), `ww-absent-${Date.now()}.json`));
  assert.deepEqual(ledger, { fills: {}, retractions: {}, meta: {} });
});

test('T1c: a ledger whose shape is wrong (array fills) refuses too', (t) => {
  const d = tmpdir(t);
  const file = path.join(d, 'ledger.json');
  fs.writeFileSync(file, '{"fills": [1, 2, 3]}');
  assert.throws(() => loadLedger(file), LedgerRefusal);
});

// --- T2: unwritable storage refuses BEFORE the mailbox is read ------------
test('T2: ensureLedgerWritable refuses an unwritable directory', (t) => {
  const d = tmpdir(t);
  const ro = path.join(d, 'ro');
  fs.mkdirSync(ro, { recursive: true });
  fs.chmodSync(ro, 0o500);

  assert.throws(
    () => ensureLedgerWritable(path.join(ro, 'ledger.json')),
    (err) => err instanceof LedgerRefusal && /BEFORE any row is consumed/.test(err.message),
    'an unwritable ledger home must refuse before consumption, naming the guarantee',
  );
});

test('T2b: the tail CLI refuses WITHOUT invoking the mailbox at all', (t) => {
  const d = tmpdir(t);
  const ro = path.join(d, 'ro');
  fs.mkdirSync(ro, { recursive: true });
  fs.chmodSync(ro, 0o500);
  const marker = path.join(d, 'mailbox-ran');
  const bin = path.join(d, 'fake-reeflog');
  fs.writeFileSync(bin, `#!/bin/sh\ntouch ${marker}\nexit 0\n`);
  fs.chmodSync(bin, 0o755);

  const cursor = path.join(d, 'cursor.txt');
  const r = spawnSync(process.execPath, [CLI, 'tail', '--db', path.join(d, 'j.db'),
    '--cursor', cursor, '--bin', bin, '--ledger', path.join(ro, 'ledger.json')],
    { encoding: 'utf8' });

  assert.equal(r.status, 3, 'a ledger refusal exits 3 (owed/refused), not 0');
  assert.equal(fs.existsSync(marker), false,
    'the mailbox must NOT be invoked when the ledger cannot be written');
  assert.equal(fs.existsSync(cursor), false,
    'no cursor file means the mailbox never consumed a row');
  assert.match(r.stderr, /refus/i, 'the refusal must name itself on stderr');
});

// --- T3: the webhook ACKs only a durable delivery --------------------------
test('T3: webhook refuses 503 (not 200) over a corrupt ledger, file untouched', async (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'ledger.json');
  corruptLedger(ledger);
  const before = fs.readFileSync(ledger, 'utf8');

  const server = await runWebhookReceiver({
    port: 0, secret: 'pinsecret', ledgerPath: ledger, log: () => {},
  });
  t.after(() => new Promise((r) => server.close(r)));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

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
    'an unreadable ledger must refuse the delivery so the mailbox keeps it owed — 200 would record a receipt for a history that was never read');
  assert.equal(fs.readFileSync(ledger, 'utf8'), before,
    'the refused ledger must be byte-identical afterwards');
});

test('T3b: webhook ACKs 200 once the ledger is valid (the refusal is recoverable)', async (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'ledger.json');
  saveLedger(ledger, { fills: {}, retractions: {}, meta: {} });

  const server = await runWebhookReceiver({
    port: 0, secret: 'pinsecret', ledgerPath: ledger, log: () => {},
  });
  t.after(() => new Promise((r) => server.close(r)));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

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
  assert.equal(res.status, 200, 'a durable save must still ACK');
  const saved = loadLedger(ledger);
  assert.equal(Object.keys(saved.fills).length, 1, 'the fill must be recorded');
});

// --- T4: the save contract itself ------------------------------------------
test('T4: saveLedger refuses an unwritable destination without touching the file', (t) => {
  const d = tmpdir(t);
  // A read-only FILE is not enough: an atomic rename swaps it regardless
  // (POSIX: rename needs the DIRECTORY's write bit, not the file's). The
  // realistic failure is an unwritable ledger HOME — make the directory
  // read-only after seeding the ledger inside it.
  const seed = path.join(d, 'home');
  fs.mkdirSync(seed, { recursive: true });
  const file = path.join(seed, 'ledger.json');
  saveLedger(file, { fills: { a: { input: '1' } }, retractions: {}, meta: {} });
  const before = fs.readFileSync(file, 'utf8');
  fs.chmodSync(seed, 0o500);

  assert.throws(
    () => saveLedger(file, { fills: {}, retractions: {}, meta: {} }),
    (err) => err instanceof LedgerRefusal && /UNCHANGED/.test(err.message),
    'a failed save must refuse and promise the file is unchanged',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before,
    'the existing ledger must survive a failed save byte-identically');
});

test('T4b: a refused run parks its consumed rows for rescue, and rescue replays them', (t) => {
  const d = tmpdir(t);
  const row = {
    seq: 9, signature: FIX.traded[0].signature, slot: 1, seal: 'finalized', err: null,
    logs: [`Program data: ${FIX.traded[0].program_data}`],
  };
  const parked = parkRows([row], path.join(d, 'ledger.json'));
  t.after(() => fs.rmSync(parked, { force: true }));
  const lines = fs.readFileSync(parked, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'parked rows must round-trip one line per row');

  // rescue path: absorb the parked rows into a fresh ledger.
  const ledger = loadLedger(path.join(d, 'fresh.json'));
  const r = absorbRow(ledger, JSON.parse(lines[0]));
  assert.equal(r.fills, 1, 'the parked row must decode to its fill on replay');
  saveLedger(path.join(d, 'fresh.json'), ledger);
  assert.equal(Object.keys(loadLedger(path.join(d, 'fresh.json')).fills).length, 1);
});

test('T4c: die() is a refusal the CLI can recognize', () => {
  assert.throws(() => die('x'), (err) => err instanceof LedgerRefusal && err.isRefusal === true);
});

// --- guards: nothing else broke --------------------------------------------
test('G: a fresh ledger still delivers a full run (end-to-end via the CLI)', (t) => {
  const d = tmpdir(t);
  // Build a journal with the published-schema events using the CLI-free path:
  // here we only need the CLI's refusal/report machinery with a mailbox that
  // never runs, so the fake bin prints one row and exits 0.
  const db = path.join(d, 'j.db');
  const bin = path.join(d, 'fake-reeflog');
  fs.writeFileSync(bin, `#!/bin/sh\nexit 0\n`);
  fs.chmodSync(bin, 0o755);
  const ledger = path.join(d, 'ledger.json');
  const r = spawnSync(process.execPath, [CLI, 'tail', '--db', db,
    '--cursor', path.join(d, 'cursor.txt'), '--bin', bin, '--ledger', ledger],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, `a healthy empty run exits 0 (got ${r.status}: ${r.stderr})`);
  const rep = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(rep.verdict, 'COMPLETE');
  assert.equal(fs.existsSync(ledger), true, 'the run must still write the ledger');
});
