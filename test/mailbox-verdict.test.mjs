// PULS P — THE MAILBOX THAT NEVER RAN CANNOT BE COMPLETE: the consumer
// must carry the mailbox's verdict, never stamp its own.
//
// reeflog's exit codes ARE the product: 0 = the journal owes nothing for
// what this pass needed; 1 = a NAMED REFUSAL happened inside the mailbox
// (no journal, foreign cursor, corrupt db); 3 = payloads are owed
// (pending/unavailable). PULS J/M/N/O closed the faces where rows or the
// ledger lied; this file closes the last mouth: the `verdict` field itself.
//
// RED first, written against the tree at 729d048 (PULS O), where the CLI
// computed `verdict: owed ? 'OWED' : 'COMPLETE'` with owed = (exit === 3)
// only — so a mailbox that died with exit 1 or could not spawn AT ALL
// (exit null) was reported COMPLETE with process exit 0. Hand-measured
// 2026-11-11 against the PUBLISHED reeflog v0.7.14 binary (main 0f32da4,
// sha256 a50facf1…) plus fake bins: all four faces exited 0 with verdict
// COMPLETE.
//   X1 no journal:       `reeflog tail` exits 1 — "no journal at … run
//      `reeflog init --db … --program <pubkey>` first". Nothing about the
//      chain was ever checked; the watcher said COMPLETE.
//   X2 no binary:        spawn ENOENT, mailbox_exit null, no row ever
//      read — the strongest "we know nothing" — COMPLETE.
//   X3 foreign cursor:   reeflog's v0.7.13 provenance gate refuses a
//      cursor that names another journal (exit 1, "does not belong
//      here"). The mailbox's OWN refusal vanished into a COMPLETE report.
//   X4 retract + no journal: same lie in retraction mode: exit 0 with an
//      empty retractions array read as health.
//   X5 a refusing mailbox MINTS a ledger: the CLI saved `{fills:{}}`
//      before printing its verdict, so a run that never happened left
//      first-run state behind. PULS M's guarantee was "the run simply
//      never happened" — a file IS something that happened.
//
// Guards (GREEN on BOTH trees — say so explicitly):
//   GX1 the genuine healthy path keeps its verdict: exit 0, COMPLETE,
//       mailbox_exit 0, fills durable.
//   GX2 the genuine OWED pass is untouched: mailbox exit 3 stays exit 3
//       with verdict OWED (this guard also held before the fix).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

function tmpdir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-pulsp-'));
  t.after(() => { fs.rmSync(d, { recursive: true, force: true }); });
  return d;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function reportOf(stdout) {
  const s = (stdout || '').indexOf('{');
  assert.ok(s >= 0, `no JSON report on stdout (got: ${JSON.stringify(String(stdout).slice(0, 200))})`);
  return JSON.parse(stdout.slice(s));
}

function fixtureBin(dir, name, idx, code = 0, stderrNote = '') {
  const rows = idx.map((i) => ({
    seq: i + 1, signature: FIX.traded[i].signature, slot: FIX.traded[i].slot,
    seal: 'finalized', err: null,
    logs: [`Program ${WHIRLPOOL} invoke [1]`,
      `Program data: ${FIX.traded[i].program_data}`,
      `Program ${WHIRLPOOL} success`],
  }));
  const file = path.join(dir, name);
  fs.writeFileSync(file,
    `#!/usr/bin/env node\nconst rows = ${JSON.stringify(rows)};\n` +
    `for (const r of rows) process.stdout.write(JSON.stringify(r) + '\\n');\n` +
    (stderrNote ? `process.stderr.write(${JSON.stringify(stderrNote)});\n` : '') +
    `process.exit(${code});\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

// A bin that behaves like a missing reeflog journal: refuses (exit 1),
// names the repair, delivers nothing.
function refusingBin(dir, name, message) {
  const file = path.join(dir, name);
  fs.writeFileSync(file,
    `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(message)});\nprocess.exit(1);\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

// --- the defect faces (RED on 729d048) --------------------------------------

test('X1: a mailbox that refuses with exit 1 is REFUSED, not COMPLETE', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'l.json');
  const bin = refusingBin(d, 'bin-x1',
    'reeflog: error: no journal at /tmp/absent.db — run `reeflog init --db /tmp/absent.db --program <pubkey>` first\n');
  const r = runCli(['tail', '--db', path.join(d, 'absent.db'),
    '--cursor', path.join(d, 'c.txt'), '--ledger', ledger, '--bin', bin]);
  assert.equal(r.status, 3,
    `exit 3 (owed/refused): the mailbox refused before delivering anything (got ${r.status})`);
  const rep = reportOf(r.stdout);
  assert.equal(rep.verdict, 'REFUSED',
    `a mailbox exit 1 cannot be COMPLETE (got ${rep.verdict})`);
  assert.equal(rep.mailbox_exit, 1, 'the refusal exit code must be carried, not swallowed');
  assert.match(r.stderr, /no journal/, 'the mailbox refusal must reach the operator');
});

test('X2: a mailbox binary that never started is UNAVAILABLE, not COMPLETE', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'l.json');
  const r = runCli(['tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'c.txt'), '--ledger', ledger,
    '--bin', path.join(d, 'definitely-not-there')]);
  assert.equal(r.status, 2,
    `the CLI's own header promises exit 2 for "missing binary" (got ${r.status})`);
  const rep = reportOf(r.stdout);
  assert.equal(rep.verdict, 'UNAVAILABLE',
    `mailbox_exit null is "we know nothing", not COMPLETE (got ${rep.verdict})`);
  assert.equal(rep.mailbox_exit, null);
});

test('X3: the mailbox\'s own named refusal (foreign cursor) survives as REFUSED', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'l.json');
  // The same words the published v0.7.14 binary prints for a provenance
  // clash (hand-measured 2026-11-11); the fake bin only removes the need
  // for a built journal in CI.
  const bin = refusingBin(d, 'bin-x3',
    'reeflog: error: cursor /tmp/c3.txt does not belong here — it names journal NOT-THE-REAL-JOURNAL-ID and this journal is 2697dcb76e4c6e27 — refusing to read a position from another channel or journal\n');
  const r = runCli(['tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'c3.txt'), '--ledger', ledger, '--bin', bin]);
  assert.equal(r.status, 3, `exit 3 over a refusal (got ${r.status})`);
  const rep = reportOf(r.stdout);
  assert.equal(rep.verdict, 'REFUSED');
  assert.match(r.stderr, /does not belong here/,
    'the mailbox refusal text must be relayed — the operator needs the named repair');
});

test('X4: retract mode over a refusing mailbox is REFUSED, not exit 0', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'l.json');
  const bin = refusingBin(d, 'bin-x4',
    'reeflog: error: no journal at /tmp/absent.db — run `reeflog init --db /tmp/absent.db --program <pubkey>` first\n');
  const r = runCli(['retract', '--db', path.join(d, 'absent.db'),
    '--cursor', path.join(d, 'c.txt'), '--ledger', ledger, '--bin', bin]);
  assert.equal(r.status, 3,
    `a retraction pass whose mailbox died is not health (got ${r.status})`);
  const rep = reportOf(r.stdout);
  assert.equal(rep.verdict, 'REFUSED',
    `the retract verdict must carry the mailbox (got ${rep.verdict})`);
  assert.equal(rep.mailbox_exit, 1);
});

test('X5: a refusing mailbox writes no ledger — the run never happened', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'l.json');
  const bin = refusingBin(d, 'bin-x5', 'reeflog: error: no journal at /tmp/x.db\n');
  const r = runCli(['tail', '--db', path.join(d, 'absent.db'),
    '--cursor', path.join(d, 'c.txt'), '--ledger', ledger, '--bin', bin]);
  assert.equal(r.status, 3);
  assert.equal(fs.existsSync(ledger), false,
    'a mailbox that delivered nothing must leave no ledger behind (no fake first-run state)');
});

// --- guards (GREEN on BOTH trees) --------------------------------------------

test('GX1 (guard): the healthy run keeps exit 0 / COMPLETE / durable fills', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'l.json');
  const bin = fixtureBin(d, 'bin-g1', [0, 1, 2, 3]);
  const r = runCli(['tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'c.txt'), '--ledger', ledger, '--bin', bin]);
  assert.equal(r.status, 0, r.stderr);
  const rep = reportOf(r.stdout);
  assert.equal(rep.verdict, 'COMPLETE');
  assert.equal(rep.fills, 4);
  const saved = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(Object.keys(saved.fills).length, 4, 'healthy fills stay durable');
});

test('GX2 (guard): the genuine OWED pass stays exit 3 / OWED', (t) => {
  const d = tmpdir(t);
  const ledger = path.join(d, 'l.json');
  // reeflog's payload-owed verdict: rows delivered, but the journal still
  // owes pending payloads — exit 3 with output.
  const bin = fixtureBin(d, 'bin-g2', [0, 1], 3, 'reeflog: 2 row(s) carry pending payloads\n');
  const r = runCli(['tail', '--db', path.join(d, 'j.db'),
    '--cursor', path.join(d, 'c.txt'), '--ledger', ledger, '--bin', bin]);
  assert.equal(r.status, 3);
  const rep = reportOf(r.stdout);
  assert.equal(rep.verdict, 'OWED', 'the existing owed mapping must not move');
  assert.equal(rep.mailbox_exit, 3);
});
