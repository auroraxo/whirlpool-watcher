// PULS X — A DELIVERED LINE THE CONSUMER CANNOT READ IS DEBT, NOT NOISE.
//
// decode.mjs states the rule for ONE level down: "a consumer that silently
// drops `invalid` claims delivery it did not get." The line-level reader
// violates exactly that rule at its own level. Three mouths, measured on
// c176efc (the PULS Q tip) 2026-11-12:
//
//   D1 tail: stdout is split line-by-line and every `JSON.parse` failure is
//      swallowed (`catch { continue; }`). A mailbox that exits 0 — cursor
//      advanced past every row it printed — with one truncated line (a
//      crash mid-println, an EPIPE remainder, a shim logging into the same
//      pipe) loses that row FOREVER while the report says COMPLETE and the
//      process exits 0. Hand-measured: `rows: 2, verdict COMPLETE, exit 0`
//      with a third half-line on stdout (research/delivery-line-voice-*).
//   D2 tail: a line that PARSES but carries no identity is worse. A row
//      without `signature` is absorbed anyway: the dedup key becomes the
//      literal `undefined:pool:...` and the ledger mints a fill nothing can
//      ever retract — applyRetractions joins on `f.signature ===
//      row.signature`, and a real reorg (a string) can never name the
//      `undefined` fill. Hand-measured: fills 2, second key
//      `undefined:3B4L4HnF...`, exit 0.
//   D3 retract: the same `catch { continue; }` in watchRetractions. A
//      retraction is a VERDICT about an already-delivered fill; reeflog
//      advances the reorg cursor past every line it printed. Losing the
//      line loses the undo forever — the fill stays open beside a COMPLETE
//      report. This is the PULS Q defect class reopened by the transport
//      instead of the branch.
//   D4 rescue: the rescue file is the durable copy of rows the mailbox will
//      NOT redeliver. `map(parse).filter(Boolean)` drops every unreadable
//      line silently and `parked_rows` REPORTS ONLY WHAT SURVIVED.
//      Hand-measured: a 3-line rescue file (one corrupt) reports
//      `parked_rows: 2`, exit 0, verdict COMPLETE — the named repair
//      itself loses rows and misreports its own input.
//
// The fix's contract (the refusal IS the product, same discipline as
// PULS M/P/O): intact rows are still absorbed and saved (nothing delivered
// is lost); unreadable lines are parked VERBATIM (bytes, not re-serialised
// objects — including the corrupt one); the run refuses with exit 3 and
// names the channel, each ordinal + snippet, and the repair. `rescue`
// refuses BEFORE touching the ledger and leaves the file byte-identical.
//
// Guards (GREEN on both trees — say so explicitly):
//   GX1 the healthy path is untouched: all-parseable rows, exit 0,
//       COMPLETE, fills durable, no park file.
//   GX2 reeflog's own pending-payload row (`logs: null`, no `payload_state`
//       field issue) is a JSON object WITH identity — it must keep flowing
//       to absorbRow exactly as before (verdict carried from the mailbox).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;

function tmpdir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-pulsx-'));
  t.after(() => { fs.rmSync(d, { recursive: true, force: true }); });
  return d;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function eventRow(i, seq = i + 1) {
  return {
    seq,
    signature: FIX.traded[i].signature,
    slot: FIX.traded[i].slot,
    seal: 'finalized',
    err: null,
    logs: [`Program data: ${FIX.traded[i].program_data}`],
  };
}

function reorgRow(i, id = i + 1) {
  return {
    reorg_id: id,
    signature: FIX.traded[i].signature,
    slot: FIX.traded[i].slot,
    detected_at: 1,
    status_source: 'getTransaction',
    tx_source: 'rpc',
    detail: 'transaction reverted on a later check',
  };
}

// A fake mailbox that prints the given JSON values line by line, then appends
// raw text (the truncated line), then exits with the given code.
function scriptedBin(dir, name, { rows = [], rawTail = '', code = 0 }) {
  const file = path.join(dir, name);
  fs.writeFileSync(file,
    '#!/usr/bin/env node\n' +
    `const rows = ${JSON.stringify(rows)};\n` +
    "for (const r of rows) process.stdout.write(JSON.stringify(r) + '\\n');\n" +
    `process.stdout.write(${JSON.stringify(rawTail)});\n` +
    `process.exit(${code});\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

// Pull the park path out of a refusal message (the message is the API).
const parks = [];
function parkedFile(stderr) {
  const m = String(stderr).match(/parked(?: verbatim)? at (\S+)/);
  assert.ok(m, `refusal must name the parked file (got: ${stderr})`);
  parks.push(m[1]);
  return m[1];
}
test.after(() => { for (const p of parks) fs.rmSync(p, { force: true }); });

// --- the defect faces (RED on c176efc) --------------------------------------

test('D1: tail — a truncated line the mailbox already delivered is refused, never skipped', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'l1.json');
  const bin = scriptedBin(d, 'bin-d1', {
    rows: [eventRow(0), eventRow(1)],
    rawTail: '{"seq":3,"signature":"TRUNC', // half a row: crash mid-println
    code: 0,
  });
  const r = runCli(['tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'c.txt'), '--ledger', ledger, '--bin', bin]);
  assert.equal(r.status, 3,
    `an unreadable delivered line must ride exit 3, not COMPLETE/0 (got ${r.status})`);
  assert.match(r.stderr, /unreadable line/, 'the refusal must name what happened');
  assert.match(r.stderr, /line 3/, 'the refusal must name the ordinal of the line');
  // The intact rows are durable — the refusal must not lose what DID arrive.
  const led = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(Object.keys(led.fills).length, 2, 'the two intact fills stay durable');
  // The corrupt bytes are parked verbatim — they will never be redelivered.
  const parked = fs.readFileSync(parkedFile(r.stderr), 'utf8');
  assert.match(parked, /\{"seq":3,"signature":"TRUNC/,
    'the park file must hold the unreadable line BYTE-VERBATIM');
  assert.match(r.stderr, /will NOT redeliver|not redeliver/i,
    'the refusal must say the mailbox cursor already advanced past it');
});

test('D2: tail — a row without a signature cannot mint an `undefined` fill', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'l2.json');
  const noId = { seq: 2, slot: 463761714, seal: 'finalized', err: null,
    logs: [`Program data: ${FIX.traded[1].program_data}`] };
  const bin = scriptedBin(d, 'bin-d2', { rows: [eventRow(0), noId], code: 0 });
  const r = runCli(['tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'c.txt'), '--ledger', ledger, '--bin', bin]);
  assert.equal(r.status, 3,
    `a delivered row that cannot be named must refuse (got ${r.status})`);
  assert.match(r.stderr, /signature/, 'the refusal must name the missing field');
  const led = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  const keys = Object.keys(led.fills);
  assert.ok(!keys.some((k) => k.startsWith('undefined:')),
    `no fill may carry the literal identity undefined (keys: ${keys.join(', ')})`);
  assert.equal(keys.length, 1, 'the one intact fill survives; the unnamed row does not become a fill');
  // The unnamed row's bytes are still parked — a human can repair them.
  const parked = fs.readFileSync(parkedFile(r.stderr), 'utf8');
  assert.match(parked, /"seq":2/, 'the identity-less row is parked verbatim');
});

test('D3: retract — a lost retraction line is debt, not silence', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'l3.json');
  // Seed the ledger with the fill that the good reorg undoes AND the one
  // the truncated reorg would have undone.
  const seedLedger = { fills: {}, retractions: {}, meta: {} };
  // Build it through the product path: one tail pass over both fixtures.
  const tailBin = scriptedBin(d, 'bin-d3-seed', { rows: [eventRow(0), eventRow(1)], code: 0 });
  const seed = runCli(['tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'c0.txt'), '--ledger', ledger, '--bin', tailBin]);
  assert.equal(seed.status, 0, 'seed pass healthy');
  // Now the reorg channel: good reorg for row 1, truncated reorg for row 2.
  const reorgBin = scriptedBin(d, 'bin-d3', {
    rows: [reorgRow(0)],
    rawTail: '{"reorg_id":2,"signatu',
    code: 0,
  });
  const r = runCli(['retract', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'c1.txt'), '--ledger', ledger, '--bin', reorgBin]);
  assert.equal(r.status, 3,
    `a retraction the consumer cannot read must refuse, not COMPLETE/0 (got ${r.status})`);
  assert.match(r.stderr, /unreadable line/, 'named as a delivery-line refusal');
  assert.match(r.stderr, /reorg|retract/, 'the refusal names the CHANNEL');
  // The readable retraction still reaches the ledger (nothing intact lost).
  const led = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(Object.keys(led.retractions).length, 1,
    'the intact reorg is applied and durable');
  const parked = fs.readFileSync(parkedFile(r.stderr), 'utf8');
  assert.match(parked, /"reorg_id":2,"signatu/,
    'the lost verdict is parked verbatim — the undo cannot be conjured again');
});

test('D4: rescue — a corrupt parked line refuses BEFORE the ledger moves', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'l4.json');
  const file = path.join(d, 'parked.jsonl');
  const before =
    JSON.stringify(eventRow(0, 91)) + '\n' +
    '{"seq":92,"signature":"CORRU' + '\n' +
    JSON.stringify(eventRow(1, 93)) + '\n';
  fs.writeFileSync(file, before);
  const r = runCli(['rescue', '--file', file, '--ledger', ledger]);
  assert.equal(r.status, 3,
    `rescue must refuse over an unreadable parked line (got ${r.status})`);
  assert.match(r.stderr, /line 2/, 'the refusal names the ordinal');
  assert.ok(!fs.existsSync(ledger),
    'a refusing rescue run must not write a partial ledger');
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after, before, 'the rescue FILE is untouched (never rewritten by a refusing run)');
});

test('D2b: tail — a named row with no delivery position is refused, not absorbed', (t) => {
  // reeflog ALWAYS emits numeric `seq`; a row without it did not come from
  // this mailbox, and absorbing it stores a fill whose delivery position is
  // unknown — untraceable in `meta.failed_transactions`/`invalid_events`
  // and in any future exactly-once proof. Pinned by mutation M3.
  const d = tmpdir(t);
  const ledger = path.join(d, 'l2b.json');
  const noSeq = { signature: FIX.traded[1].signature, slot: FIX.traded[1].slot,
    seal: 'finalized', err: null, logs: [`Program data: ${FIX.traded[1].program_data}`] };
  const bin = scriptedBin(d, 'bin-d2b', { rows: [eventRow(0), noSeq], code: 0 });
  const r = runCli(['tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'c.txt'), '--ledger', ledger, '--bin', bin]);
  assert.equal(r.status, 3, `a row without a delivery position must refuse (got ${r.status})`);
  assert.match(r.stderr, /seq/, 'the refusal must name the missing field');
  const led = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(Object.keys(led.fills).length, 1, 'the intact row survives; the position-less row does not become a fill');
  const parked = fs.readFileSync(parkedFile(r.stderr), 'utf8');
  assert.match(parked, new RegExp(FIX.traded[1].signature), 'the refused row is parked verbatim');
});

test('D3b: retract — a reorg line that names no transaction is refused', (t) => {
  // `applyRetractions` joins on `f.signature === row.signature`; a reorg row
  // without a signature can never undo anything, yet the pre-fix reader
  // passed it through and the run reported COMPLETE. Pinned by mutation M6.
  const d = tmpdir(t);
  const ledger = path.join(d, 'l3b.json');
  const seedBin = scriptedBin(d, 'bin-d3b-seed', { rows: [eventRow(0)], code: 0 });
  assert.equal(runCli(['tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'c0.txt'), '--ledger', ledger, '--bin', seedBin]).status, 0);
  const reorgBin = scriptedBin(d, 'bin-d3b', {
    rows: [{ reorg_id: 7, slot: 463761714, detected_at: 1,
      status_source: 'getTransaction', tx_source: 'rpc', detail: 'no name' }],
    code: 0,
  });
  const r = runCli(['retract', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'c1.txt'), '--ledger', ledger, '--bin', reorgBin]);
  assert.equal(r.status, 3, `a reorg row that names nothing must refuse (got ${r.status})`);
  assert.match(r.stderr, /signature/, 'the refusal must name the missing field');
  const led = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(Object.keys(led.fills).length, 1, 'the fill stays open — nothing named it as undone');
  assert.equal(Object.keys(led.retractions).length, 0, 'no retraction was minted from an unnamed row');
});

test('D5: rescue — `parked_rows` counts the lines the file HOLDS, not what survived', (t) => {
  // The report field must never be smaller than the file's non-empty lines:
  // a repair tool under-reporting its own input teaches the operator that
  // the debt was smaller than it was. On a healthy file this guard is
  // green on both trees; on the corrupt file D4 refuses, so the metric is
  // pinned here as: when rescue DOES run clean, parked_rows === file lines.
  const d = tmpdir(t);
  const ledger = path.join(d, 'l5.json');
  const file = path.join(d, 'parked5.jsonl');
  fs.writeFileSync(file,
    JSON.stringify(eventRow(0, 81)) + '\n' + JSON.stringify(eventRow(1, 82)) + '\n');
  const r = runCli(['rescue', '--file', file, '--ledger', ledger]);
  assert.equal(r.status, 0);
  const rep = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(rep.parked_rows, 2);
});

// --- guards (GREEN on both trees) --------------------------------------------

test('GX1: tail — an all-readable batch keeps its healthy verdict untouched', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'gx1.json');
  const bin = scriptedBin(d, 'bin-gx1', { rows: [eventRow(0), eventRow(1)], code: 0 });
  const r = runCli(['tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'c.txt'), '--ledger', ledger, '--bin', bin]);
  assert.equal(r.status, 0, 'healthy path stays exit 0');
  const rep = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(rep.verdict, 'COMPLETE');
  assert.equal(rep.rows, 2);
  assert.equal(rep.fills, 2);
});

test('GX2: tail — a pending-payload row (logs null) is a readable row, not a line defect', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'gx2.json');
  const pending = { seq: 2, signature: FIX.traded[1].signature, slot: FIX.traded[1].slot,
    seal: 'confirmed', err: null, logs: null, payload_state: null };
  const bin = scriptedBin(d, 'bin-gx2', { rows: [eventRow(0), pending], code: 3 });
  const r = runCli(['tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'c.txt'), '--ledger', ledger, '--bin', bin]);
  assert.equal(r.status, 3, 'the mailbox verdict (OWED) still rides');
  const rep = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.equal(rep.verdict, 'OWED', 'carried verdict, not a line-refusal');
  assert.equal(rep.rows, 2, 'both rows counted — a logs:null row is readable');
});
