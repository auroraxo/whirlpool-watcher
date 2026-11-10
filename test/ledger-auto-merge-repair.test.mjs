// PULS O pin — the refusal named its repair, but NO CLI PATH COULD RUN IT.
//
// The freshness refusal (PULS N, a74594f) says verbatim:
//   "repair: load the current ledger, mergeLedger(disk, this view), then
//    save again"
// mergeLedger exists only as a LIBRARY export. In the real two-instance
// scenario the slow instance still ended with exit 3 and rows parked in an
// OS-temp file — durable history came back only if a HUMAN noticed and ran
// `rescue`. That is a half-automated contract: the measured C-N7 scenario
// shows it — after A's refusal the final ledger holds 2 fills, not 4,
// until someone replays the parked file.
//
// RED first, written against the tree at a74594f (PULS N): these defect
// faces FAIL there by BEHAVIOR:
//   MR1 (tail self-repair): two CLI instances, one ledger (the C-N7 race,
//       no human step). The slow instance must refuse its stale save,
//       perform the refusal's named repair ITSELF (reload disk, merge,
//       save once), exit 0 with `merge_repair: "applied"` — and ALL FOUR
//       fills durable with NO rescue file. Baseline: exit 3, 2 fills,
//       parked rows wait for a human.
//   MR2 (meta arrays survive the merge): mergeLedger(disk, mine) must
//       union `meta.failed_transactions` / `meta.invalid_events` by
//       (seq, signature) — the durable disk copy first, mine's unique
//       entries kept, shared entries not duplicated. Baseline: the disk
//       spread drops every array entry only `mine` had (the merge lost
//       reports while keeping fills).
//   MR3 (retract self-repair + retraction wins): a retraction that lands
//       while another writer saves must self-repair too, and a key moved
//       to `retractions` by either side must not reappear as an open fill
//       from the other side's copy (spread-union cannot express a
//       deletion — retractions must win). Baseline: exit 3, no repair.
//
// Guards (GREEN on BOTH trees, say so explicitly):
//   MG1 single-writer tail is untouched: exit 0, COMPLETE, no
//       merge_repair, no parked file, no residue.
//   MG2 a NON-freshness save failure (unwritable storage) must NOT be
//       auto-repaired: the row stays owed — refuse, park, exit 3 exactly
//       as PULS M/N established. (Merging cannot fix a broken disk.)
//   MG3 `rescue` remains available and idempotent for the refused_again
//       / parked case: replaying a parked file into the current ledger
//       adds its fills, re-running changes nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import {
  loadLedger, saveLedger, mergeLedger,
} from '../src/whirlpool-watcher.mjs';

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;

function tmpdir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-pulso-'));
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

const ledgerWith = (fills, meta = {}) => ({ fills, retractions: {}, meta });

function mkBin(dir, name, fixtureIdx, sleepMs, extraRows = []) {
  const rows = fixtureIdx.map((i) => ({
    seq: i + 1, signature: FIX.traded[i].signature, slot: FIX.traded[i].slot,
    seal: 'finalized', err: null,
    logs: ['Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke [1]',
      `Program data: ${FIX.traded[i].program_data}`,
      'Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc success'],
  })).concat(extraRows);
  const file = path.join(dir, name);
  fs.writeFileSync(file,
    `#!/usr/bin/env node\nconst rows = ${JSON.stringify(rows)};\n` +
    `if (${sleepMs} > 0) { const end = Date.now() + ${sleepMs}; while (Date.now() < end) {} }\n` +
    `for (const r of rows) process.stdout.write(JSON.stringify(r) + '\\n');\n` +
    `process.exit(0);\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function mkReorgBin(dir, name, signatures, sleepMs) {
  const rows = signatures.map((signature, i) => ({
    reorg_id: i + 1, signature, slot: 1,
    detected_at: 1, status_source: 'x', tx_source: 'y', detail: null,
  }));
  const file = path.join(dir, name);
  fs.writeFileSync(file,
    `#!/usr/bin/env node\nconst rows = ${JSON.stringify(rows)};\n` +
    `if (${sleepMs} > 0) { const end = Date.now() + ${sleepMs}; while (Date.now() < end) {} }\n` +
    `for (const r of rows) process.stdout.write(JSON.stringify(r) + '\\n');\n` +
    `process.exit(0);\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

const runTail = (dir, bin, cursor, ledger) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, 'tail', '--db', path.join(dir, 'j.db'),
    '--cursor', cursor, '--bin', bin, '--ledger', ledger]);
  let out = '', err = '';
  p.stdout.on('data', (x) => { out += x; });
  p.stderr.on('data', (x) => { err += x; });
  p.on('close', (code) => resolve({ code, out, err }));
});

const runRetract = (dir, bin, cursor, ledger) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, 'retract', '--db', path.join(dir, 'j.db'),
    '--cursor', cursor, '--bin', bin, '--ledger', ledger]);
  let out = '', err = '';
  p.stdout.on('data', (x) => { out += x; });
  p.stderr.on('data', (x) => { err += x; });
  p.on('close', (code) => resolve({ code, out, err }));
});

const parseReport = (out) => {
  const s = out.indexOf('{');
  return s >= 0 ? JSON.parse(out.slice(s)) : null;
};

const rescueFiles = (before) => fs.readdirSync(os.tmpdir())
  .filter((n) => n.startsWith('whirlpool-watcher-rescue-') && !before.has(n));

// --- MR1: the slow tail instance performs its refusal's named repair -------
test('MR1: two tail instances self-repair — 4/4 fills durable, exit 0, no rescue file', { timeout: 60000 }, async (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'ledger.json');
  const rescueBefore = new Set(fs.readdirSync(os.tmpdir())
    .filter((n) => n.startsWith('whirlpool-watcher-rescue-')));

  const binA = mkBin(d, 'bin-a', [0, 1], 1200);
  const binB = mkBin(d, 'bin-b', [2, 3], 0);

  const aP = runTail(d, binA, path.join(d, 'a.cursor'), ledger);
  await new Promise((r) => setTimeout(r, 100));
  const b = await runTail(d, binB, path.join(d, 'b.cursor'), ledger);
  const a = await aP;

  const rep = parseReport(a.out);
  const final = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  const sigs = Object.values(final.fills).map((f) => f.signature);

  assert.equal(b.code, 0, `B (fast) must complete cleanly (${b.err})`);
  assert.equal(a.code, 0,
    `A must run the repair its own refusal names and end durable — got ${a.code}\nstderr: ${a.err}\nreport: ${JSON.stringify(rep)}`);
  assert.equal(rep && rep.merge_repair, 'applied',
    'A\'s report must say the freshness refusal was auto-repaired (merge applied)');
  assert.equal(Object.keys(final.fills).length, 4,
    'both instances\u2019 fills must be durable without a human rescue step');
  for (const i of [0, 1, 2, 3]) {
    assert.equal(sigs.includes(FIX.traded[i].signature), true,
      `fixture fill ${i} must be in the final ledger`);
  }
  assert.deepEqual(rescueFiles(rescueBefore), [],
    'a successful self-repair must NOT park rows — rescue stays the fallback, not the routine');
  // A fresh load of the durable file must still be saveable by its reader.
  const reload = loadLedger(ledger);
  saveLedger(ledger, reload);
});

// --- MR2: mergeLedger must not lose either side's failure/invalid reports --
test('MR2: mergeLedger unions meta.failed_transactions/invalid_events by (seq,signature)', () => {
  const shared = { seq: 1, signature: 'SigShared', err: 'InstructionError', trades_in_logs: 0 };
  const disk = ledgerWith({ 'k1': { signature: 'SigD' } }, {
    failed_transactions: [shared, { seq: 2, signature: 'SigDisk', err: 'e', trades_in_logs: 1 }],
    invalid_events: [{ seq: 3, signature: 'SigDisk', invalid: ['bad'] }],
  });
  const mine = ledgerWith({ 'k2': { signature: 'SigMine' } }, {
    failed_transactions: [shared, { seq: 4, signature: 'SigMine', err: 'e', trades_in_logs: 2 }],
    invalid_events: [{ seq: 5, signature: 'SigMine', invalid: ['bad2'] }],
  });
  const merged = mergeLedger(disk, mine);

  assert.deepEqual(Object.keys(merged.fills).sort(), ['k1', 'k2'],
    'the fill union must stay exactly as PULS N established');
  const failSigs = (merged.meta.failed_transactions || []).map((e) => e.signature);
  assert.ok(failSigs.includes('SigDisk'), 'the durable disk report must survive');
  assert.ok(failSigs.includes('SigMine'),
    'a failed-transaction report only MINE made must survive the merge — baseline: disk spread dropped every such entry');
  assert.equal(failSigs.filter((s) => s === 'SigShared').length, 1,
    'the entry both sides recorded for the same (seq,signature) must not duplicate');
  const invSigs = (merged.meta.invalid_events || []).map((e) => e.signature);
  assert.ok(invSigs.includes('SigDisk') && invSigs.includes('SigMine'),
    'invalid-event reports follow the same union rule');
});

// --- MR3: retract refuses, self-repairs, and retractions win over fills ----
test('MR3: a retract save over a concurrently-changed ledger self-repairs; a retracted key is never an open fill', { timeout: 60000 }, async (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'ledger.json');
  const rescueBefore = new Set(fs.readdirSync(os.tmpdir())
    .filter((n) => n.startsWith('whirlpool-watcher-rescue-')));

  // Seed a ledger holding fixture 0 as an open fill.
  const seedBin = mkBin(d, 'bin-seed', [0], 0);
  const seed = await runTail(d, seedBin, path.join(d, 'seed.cursor'), ledger);
  assert.equal(seed.code, 0, seed.err);

  // A retracts the seeded fill; its mailbox is SLOW. B lands a NEW fill first.
  const binA = mkReorgBin(d, 'bin-retract', [FIX.traded[0].signature], 1200);
  const binB = mkBin(d, 'bin-tail', [1], 0);
  const aP = runRetract(d, binA, path.join(d, 'r.cursor'), ledger);
  await new Promise((r) => setTimeout(r, 100));
  const b = await runTail(d, binB, path.join(d, 'b.cursor'), ledger);
  const a = await aP;
  assert.equal(b.code, 0, b.err);

  const rep = parseReport(a.out);
  assert.equal(a.code, 0,
    `the slow retract instance must run the named repair instead of parking — got ${a.code}\nstderr: ${a.err}`);
  assert.equal(rep && rep.merge_repair, 'applied', 'the report must say the merge repair was applied');

  const final = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  const open = Object.values(final.fills).map((f) => f.signature);
  const retracted = Object.values(final.retractions).map((f) => f.signature);
  assert.equal(open.includes(FIX.traded[0].signature), false,
    'a fill either side retracted must NOT reappear as open from the other side\u2019s disk copy (spread-union cannot express a deletion — retractions must win)');
  assert.equal(retracted.includes(FIX.traded[0].signature), true,
    'the retraction itself must be durable');
  assert.equal(open.includes(FIX.traded[1].signature), true,
    'B\u2019s concurrently durable new fill must survive the merged save');
  assert.deepEqual(rescueFiles(rescueBefore), [], 'self-repair must not park rows');
});

// --- MR4: mergeLedger must keep the DISABLE copy per key -------------------
// The durable disk copy won each key (it was already delivered to whoever
// consumed the ledger). PULS N's G-N3 asserted this on the pre-repair merge;
// PULS O rewrote mergeLedger (retractions-win, meta union), so the pin
// lives in this file too — mutation M3 (mine wins per key) must go RED
// here.
test('MR4: mergeLedger keeps the durable disk copy per key', () => {
  const disk = { fills: { 'leg-A': { input: '9', signature: 'D' } }, retractions: {}, meta: {} };
  const mine = { fills: { 'leg-A': { input: '1', signature: 'M' } }, retractions: {}, meta: {} };
  const merged = mergeLedger(disk, mine);
  assert.equal(merged.fills['leg-A'].input, '9',
    'a leg already durable on disk keeps the disk copy — the stale instance must not overwrite delivered history through the repair');
});

// --- MG1 (guard, GREEN on both trees): single writer untouched -------------
test('MG1: a single tail run never triggers the repair path', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'ledger.json');
  const rescueBefore = new Set(fs.readdirSync(os.tmpdir())
    .filter((n) => n.startsWith('whirlpool-watcher-rescue-')));
  const bin = mkBin(d, 'bin', [0, 1, 2, 3], 0);
  const r = spawnSync(process.execPath, [CLI, 'tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'c.cursor'), '--bin', bin, '--ledger', ledger],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, `clean single run exits 0 (${r.stderr})`);
  const rep = parseReport(r.stdout);
  assert.equal(rep.verdict, 'COMPLETE');
  assert.equal(rep.fills, 4);
  assert.ok(rep.merge_repair === null || rep.merge_repair === undefined,
    'a run without any refusal must not claim a repair');
  assert.deepEqual(rescueFiles(rescueBefore), []);
  const residue = fs.readdirSync(d).filter((n) => n.startsWith('ledger.json') && n !== 'ledger.json');
  assert.deepEqual(residue, []);
});

// --- MG2 (guard, GREEN on both trees): broken storage is NOT auto-repaired -
// Merging cannot fix an unwritable directory; PULS M's park+exit-3 contract
// must stay exactly intact on the non-freshness failure face.
test('MG2: a write failure (not a freshness clash) still refuses, parks, and exits 3', (t) => {
  const d = tmpdir(t);
  const home = path.join(d, 'home');
  fs.mkdirSync(home, { recursive: true });
  const ledger = path.join(home, 'ledger.json');
  // Make the ledger durable while writable, then break the directory.
  const seedBin = mkBin(d, 'bin-seed', [0], 0);
  const seed = spawnSync(process.execPath, [CLI, 'tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 's.cursor'), '--bin', seedBin, '--ledger', ledger],
    { encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  fs.chmodSync(home, 0o500);
  t.after(() => { try { fs.chmodSync(home, 0o700); } catch { /* tmpdir cleanup raced */ } });

  const bin = mkBin(d, 'bin', [1, 2, 3], 0);
  const r = spawnSync(process.execPath, [CLI, 'tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'c.cursor'), '--bin', bin, '--ledger', ledger],
    { encoding: 'utf8' });
  assert.equal(r.status, 3,
    'an unwritable save must stay a refusal (exit 3) — auto-repair is for freshness clashes only');
  const after = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(Object.keys(after.fills).length, 1,
    'the ledger must still hold exactly the seeded fill — nothing was clobbered');
});

// --- MG3 (guard, GREEN on both trees): rescue stays the documented fallback -
test('MG3: rescue replays parked rows into the current ledger and is idempotent', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'ledger.json');
  // Park fixture 1 via the library (the refused_again path uses parkRows).
  const row = {
    seq: 2, signature: FIX.traded[1].signature, slot: FIX.traded[1].slot,
    seal: 'finalized', err: null,
    logs: [`Program data: ${FIX.traded[1].program_data}`],
  };
  const parked = path.join(d, 'parked.jsonl');
  fs.writeFileSync(parked, JSON.stringify(row) + '\n');
  // The current ledger already holds fixture 0 (as if B won the race).
  const seedBin = mkBin(d, 'bin-seed', [0], 0);
  const seed = spawnSync(process.execPath, [CLI, 'tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 's.cursor'), '--bin', seedBin, '--ledger', ledger],
    { encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);

  const resc = spawnSync(process.execPath, [CLI, 'rescue', '--file', parked, '--ledger', ledger],
    { encoding: 'utf8' });
  assert.equal(resc.status, 0, resc.stderr);
  const rep = parseReport(resc.stdout);
  assert.equal(rep.fills, 1);

  const resc2 = spawnSync(process.execPath, [CLI, 'rescue', '--file', parked, '--ledger', ledger],
    { encoding: 'utf8' });
  assert.equal(resc2.status, 0, resc2.stderr);
  const rep2 = parseReport(resc2.stdout);
  assert.equal(rep2.duplicates_ignored, 1,
    'the replayed row must be recognized as a duplicate, not recorded twice');
  assert.equal(rep2.open_fills, 2, 'the re-run must not grow the ledger');
  const final = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(Object.keys(final.fills).length, 2,
    'after rescue the ledger holds both instances\u2019 fills');
});
