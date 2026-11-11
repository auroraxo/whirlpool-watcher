#!/usr/bin/env node
// PULS P — the consumer must carry the mailbox's verdict.
//
// PULS J/M/N/O closed the faces where ROWS or the LEDGER lied. This tool
// measures the last mouth: the `verdict` field the CLI prints and the exit
// code it returns.
//
// Every face is driven through the REAL CLI (src/cli.mjs) with a fake
// mailbox bin that reproduces what the published reeflog v0.7.14 binary
// does in the same situation (hand-measured 2026-11-11 against main
// 0f32da4, sha256 a50facf1…):
//   X1 no journal:      reeflog exits 1 ("no journal at … run `reeflog init
//      --db … --program <pubkey>` first") and delivers no row.
//   X2 no binary:       the spawn fails (ENOENT) — mailbox_exit is null,
//      not even a verdict to carry.
//   X3 foreign cursor:  reeflog v0.7.13's provenance gate exits 1 ("does
//      not belong here — it names journal … and this journal is …").
//   X4 retract + X1:    the same lie in retraction mode.
//   X5 state:           a refusing mailbox must not MINT a ledger — a run
//      that never happened leaves no first-run state behind.
//
// Guards (must hold on BOTH trees):
//   GX1 healthy:        exit 0, COMPLETE, 4 durable fills, no residue.
//   GX2 owed:           reeflog exit 3 (pending payloads) stays exit 3 /
//       OWED — the pre-existing mapping must not move.
//
// Usage:
//   node tools/measure-mailbox-verdict.mjs --expect violations|clean [--label NAME]
// contract: `violations` exits 0 only when at least one face violates
// (the pre-fix tree); `clean` exits 0 only when no face violates (the
// fixed tree). A tool whose faces all go the "wrong" way exits non-zero:
// a lying measurement, not a result.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures.json'), 'utf8'));
const WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const EXPECT = arg('--expect', '');
const LABEL = arg('--label', EXPECT || 'unlabeled');
const OUT = process.env.PULSE_P_OUT
  || path.join(ROOT, 'research', `mailbox-verdict-${LABEL}-2026-11-11.json`);

const scrub = (s, dir) => String(s || '').split(dir).join('<tmpdir>');

function refusingBin(dir, name, message) {
  const file = path.join(dir, name);
  fs.writeFileSync(file,
    `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(message)});\nprocess.exit(1);\n`);
  fs.chmodSync(file, 0o755);
  return file;
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

function run(dir, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: dir });
  let rep = null;
  const s = (r.stdout || '').indexOf('{');
  if (s >= 0) { try { rep = JSON.parse(r.stdout.slice(s)); } catch { rep = null; } }
  return { r, rep };
}

// The contract a face must satisfy on the FIXED tree: the mailbox's verdict
// is carried verbatim, the CLI's exit code follows it, the refusal text
// reaches the operator, and nothing was written that should not be.
function face(name, dir, args, expect) {
  const { r, rep } = run(dir, args);
  const violated = [];
  if (r.status !== expect.exit) violated.push(`exit ${r.status} != ${expect.exit}`);
  if (!rep || rep.verdict !== expect.verdict) violated.push(`verdict ${rep && rep.verdict} != ${expect.verdict}`);
  if (rep && expect.mailbox_exit !== undefined && rep.mailbox_exit !== expect.mailbox_exit) {
    violated.push(`mailbox_exit ${rep.mailbox_exit} != ${expect.mailbox_exit}`);
  }
  if (expect.stderr && !/x/i.test(expect.stderr)) violated.push('unreachable');
  if (expect.stderrPattern && !new RegExp(expect.stderrPattern).test(r.stderr || '')) {
    violated.push('the mailbox refusal text did not reach stderr');
  }
  if (expect.noLedger && fs.existsSync(expect.noLedger)) violated.push('a ledger was minted by a run that never happened');
  if (expect.ledgerFills !== undefined) {
    const f = fs.existsSync(expect.ledger)
      ? Object.keys(JSON.parse(fs.readFileSync(expect.ledger, 'utf8')).fills).length
      : null;
    if (f !== expect.ledgerFills) violated.push(`ledger fills ${f} != ${expect.ledgerFills}`);
  }
  return {
    face: name,
    exit: r.status,
    verdict: rep ? rep.verdict : null,
    mailbox_exit: rep ? rep.mailbox_exit : null,
    rows: rep ? rep.rows : null,
    stderr: scrub((r.stderr || '').trim().slice(0, 300), dir),
    violated: violated.length > 0,
    detail: violated.length ? violated.join('; ')
      : `exit=${r.status} verdict=${rep && rep.verdict} mailbox_exit=${rep && rep.mailbox_exit}`,
  };
}

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-p-'));
  const faces = [];
  const ledgerFor = (n) => path.join(dir, `l-${n}.json`);

  // X1: a mailbox that refuses with exit 1.
  {
    const bin = refusingBin(dir, 'bin-x1', 'reeflog: error: no journal at /tmp/absent.db — run `reeflog init --db /tmp/absent.db --program <pubkey>` first\n');
    faces.push(face('X1_mailbox_refused_exit1', dir,
      ['tail', '--db', path.join(dir, 'absent.db'), '--cursor', path.join(dir, 'c1.txt'),
        '--ledger', ledgerFor('x1'), '--bin', bin],
      { exit: 3, verdict: 'REFUSED', mailbox_exit: 1, stderrPattern: 'no journal', noLedger: ledgerFor('x1') }));
  }
  // X2: the mailbox binary does not exist at all.
  {
    faces.push(face('X2_mailbox_never_spawned', dir,
      ['tail', '--db', path.join(dir, 'j.db'), '--cursor', path.join(dir, 'c2.txt'),
        '--ledger', ledgerFor('x2'), '--bin', path.join(dir, 'definitely-not-there')],
      { exit: 2, verdict: 'UNAVAILABLE', mailbox_exit: null, noLedger: ledgerFor('x2') }));
  }
  // X3: the mailbox's own named refusal (foreign cursor).
  {
    const bin = refusingBin(dir, 'bin-x3', 'reeflog: error: cursor /tmp/c3.txt does not belong here — it names journal NOT-THE-REAL-JOURNAL-ID and this journal is 2697dcb76e4c6e27 — refusing to read a position from another channel or journal\n');
    faces.push(face('X3_foreign_cursor_refusal', dir,
      ['tail', '--db', path.join(dir, 'j.db'), '--cursor', path.join(dir, 'c3.txt'),
        '--ledger', ledgerFor('x3'), '--bin', bin],
      { exit: 3, verdict: 'REFUSED', mailbox_exit: 1, stderrPattern: 'does not belong here', noLedger: ledgerFor('x3') }));
  }
  // X4: retraction mode over a refusing mailbox.
  {
    const bin = refusingBin(dir, 'bin-x4', 'reeflog: error: no journal at /tmp/absent.db — run `reeflog init --db /tmp/absent.db --program <pubkey>` first\n');
    faces.push(face('X4_retract_over_refusal', dir,
      ['retract', '--db', path.join(dir, 'absent.db'), '--cursor', path.join(dir, 'c4.txt'),
        '--ledger', ledgerFor('x4'), '--bin', bin],
      { exit: 3, verdict: 'REFUSED', mailbox_exit: 1, noLedger: ledgerFor('x4') }));
  }
  // X5: a refusing mailbox must not MINT a ledger. The X1 face already
  // refuses; this face isolates the state: a run that never happened
  // leaves no first-run state behind.
  {
    const ledger = path.join(dir, 'l-x5.json');
    const bin = refusingBin(dir, 'bin-x5', 'reeflog: error: no journal at /tmp/absent.db\n');
    faces.push(face('X5_no_state_from_a_run_that_never_happened', dir,
      ['tail', '--db', path.join(dir, 'absent.db'), '--cursor', path.join(dir, 'c5.txt'),
        '--ledger', ledger, '--bin', bin],
      { exit: 3, verdict: 'REFUSED', mailbox_exit: 1, noLedger: ledger }));
  }
  // GX1 (guard): the healthy path.
  {
    const ledger = ledgerFor('gx1');
    const bin = fixtureBin(dir, 'bin-gx1', [0, 1, 2, 3]);
    faces.push(face('GX1_healthy_guard', dir,
      ['tail', '--db', path.join(dir, 'j.db'), '--cursor', path.join(dir, 'cg1.txt'),
        '--ledger', ledger, '--bin', bin],
      { exit: 0, verdict: 'COMPLETE', mailbox_exit: 0, ledger, ledgerFills: 4 }));
  }
  // GX2 (guard): the owed path.
  {
    const bin = fixtureBin(dir, 'bin-gx2', [0, 1], 3, 'reeflog: 2 row(s) carry pending payloads\n');
    faces.push(face('GX2_owed_guard', dir,
      ['tail', '--db', path.join(dir, 'j.db'), '--cursor', path.join(dir, 'cg2.txt'),
        '--ledger', ledgerFor('gx2'), '--bin', bin],
      { exit: 3, verdict: 'OWED', mailbox_exit: 3 }));
  }

  const violated = faces.filter((x) => x.violated).map((x) => x.face);
  const consistent = !EXPECT
    ? true
    : EXPECT === 'violations' ? violated.length > 0 : violated.length === 0;

  const out = {
    measured_at: new Date().toISOString(),
    what: 'the consumer must carry the mailbox verdict: a refused or unreachable mailbox is never COMPLETE',
    seat: {
      kind: 'watcher tree (the defect lives entirely in this repo)',
      watcher_commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
      label: LABEL,
    },
    faces,
    summary: {
      total: faces.length,
      violated_count: violated.length,
      violated,
      expectation: EXPECT === 'violations'
        ? 'pre-fix tree: at least one face must violate'
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

main();
