// PULS O — the refusal named a repair that NO CLI PATH COULD RUN.
//
// PULS N (a74594f) made a save over a concurrently-changed ledger refuse:
// the file stays byte-identical, the CLI exits 3, and the refusal names the
// repair verbatim ("load the current ledger, mergeLedger(disk, this view),
// then save again"). But mergeLedger existed only as a LIBRARY export, and
// the CLI's own end state was "exit 3 + rows parked in an OS-temp file" —
// the history was only complete if a HUMAN noticed the parked file and ran
// `rescue`.
//
// This tool measures that half of the contract, end to end through the
// REAL CLI (src/cli.mjs), never a paraphrase:
//
//   F1 tail_self_repair: two CLI instances, one ledger (the C-N7 race, no
//      human step). The slow instance must perform its own refusal's named
//      repair: exit 0, `merge_repair: "applied"`, and ALL FOUR fills
//      durable with NO parked file. Baseline (a74594f): exit 3, two fills,
//      one parked file — the repair waits for a human.
//   F2 retract_self_repair: a retraction that lands while another writer
//      saves must self-repair too, and a key either side retracted must
//      NOT reappear as an open fill from the other side's copy — a
//      spread-union cannot express a deletion. Baseline: exit 3.
//   F3 merge_keeps_reports: mergeLedger(disk, mine) must union the meta
//      REPORTS (failed_transactions / invalid_events) by (seq, signature):
//      the disk side AND the side-only entries, no duplicates. Baseline:
//      the plain spread kept only the disk side and dropped every report
//      only the other side had — the merge kept the fills and lost the
//      account of what went wrong.
//   G1 (guard) single_writer: one CLI run from empty must deliver all four
//      fixture fills, exit 0, COMPLETE, `merge_repair: null`, and leave NO
//      stage/probe/rescue residue.
//
// Usage:
//   node tools/measure-ledger-auto-repair.mjs --expect violations|clean [--label NAME]
// contract: `violations` exits 0 only when at least one face violates
// (baseline tree); `clean` exits 0 only when no face violates (fixed tree).
// A tool whose faces all go the "wrong" way exits non-zero: a lying
// measurement, not a result.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const { mergeLedger } = await import(path.join(ROOT, 'src', 'whirlpool-watcher.mjs'));

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const EXPECT = arg('--expect', '');
const LABEL = arg('--label', EXPECT || 'unlabeled');
const OUT = process.env.PULSE_O_OUT
  || path.join(ROOT, 'research', `ledger-auto-repair-${LABEL}-2026-11-10.json`);

const CLI = path.join(ROOT, 'src', 'cli.mjs');
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures.json'), 'utf8'));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const rescueSet = () => new Set(fs.readdirSync(os.tmpdir())
  .filter((n) => n.startsWith('whirlpool-watcher-rescue-')));

const newRescues = (before) => fs.readdirSync(os.tmpdir())
  .filter((n) => n.startsWith('whirlpool-watcher-rescue-') && !before.has(n));

function tradeRow(i) {
  return {
    seq: i + 1, signature: FIX.traded[i].signature, slot: FIX.traded[i].slot,
    seal: 'finalized', err: null,
    logs: ['Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke [1]',
      `Program data: ${FIX.traded[i].program_data}`,
      'Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc success'],
  };
}

function mkBin(dir, name, idx, sleepMs) {
  const rows = idx.map(tradeRow);
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

function run(mode, dir, bin, cursor, ledger) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, mode, '--db', path.join(dir, 'j.db'),
      '--cursor', cursor, '--bin', bin, '--ledger', ledger]);
    let out = '', err = '';
    p.stdout.on('data', (x) => { out += x; });
    p.stderr.on('data', (x) => { err += x; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

const report = (out) => {
  const s = out.indexOf('{');
  return s >= 0 ? JSON.parse(out.slice(s)) : null;
};

// Host paths must never land in a committed artifact (PULS L lesson):
// the refusal message names the ledger file, which sits under the run's
// temp dir. Keep the message, drop the machine-specific prefix.
const scrub = (s, dir) => String(s || '').split(dir).join('<tmpdir>');

// --- F1: the tail run performs its own refusal's named repair --------------
async function faceF1(dir) {
  const ledger = path.join(dir, 'f1-ledger.json');
  const before = rescueSet();
  const binA = mkBin(dir, 'f1-bin-a', [0, 1], 1200);
  const binB = mkBin(dir, 'f1-bin-b', [2, 3], 0);

  const aP = run('tail', dir, binA, path.join(dir, 'a.cursor'), ledger);
  await sleep(100);
  const b = await run('tail', dir, binB, path.join(dir, 'b.cursor'), ledger);
  const a = await aP;

  const final = fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, 'utf8')) : null;
  const fills = final ? Object.keys(final.fills).length : 0;
  const rep = report(a.out);
  const parked = newRescues(before);

  // The violation: the history is only complete if a human acts. The
  // durable copy must hold BOTH instances' fills, the slow run must say
  // it repaired itself, and NOTHING may wait in a parked file.
  const violated = !(a.code === 0 && fills === 4
    && rep && rep.merge_repair === 'applied' && parked.length === 0);
  return {
    face: 'F1_tail_self_repair',
    slow_exit: a.code, fast_exit: b.code,
    merge_repair: rep ? rep.merge_repair : null,
    final_fills: fills,
    parked_rescue: parked.length,
    slow_stderr: scrub((a.err || '').trim().slice(0, 300), dir),
    violated,
    detail: violated
      ? `the slow instance ended at exit ${a.code} with ${fills} durable fills and ${parked.length} parked file(s) — the named repair is not run by any CLI path, the history waits for a human`
      : `slow_exit=${a.code} fills=${fills} merge_repair=${rep && rep.merge_repair} parked=${parked.length}`,
  };
}

// --- F2: the retract run self-repairs, and retractions win over fills ------
async function faceF2(dir) {
  const ledger = path.join(dir, 'f2-ledger.json');
  const before = rescueSet();
  // Seed an open fill.
  const seed = await run('tail', dir, mkBin(dir, 'f2-bin-seed', [0], 0),
    path.join(dir, 'seed.cursor'), ledger);
  if (seed.code !== 0) {
    return { face: 'F2_retract_self_repair', violated: null, error: `seed failed: ${seed.err}` };
  }
  // A retracts the seeded fill (slow mailbox); B lands a new fill first.
  const binA = mkReorgBin(dir, 'f2-bin-retract', [FIX.traded[0].signature], 1200);
  const binB = mkBin(dir, 'f2-bin-tail', [1], 0);
  const aP = run('retract', dir, binA, path.join(dir, 'r.cursor'), ledger);
  await sleep(100);
  const b = await run('tail', dir, binB, path.join(dir, 'b.cursor'), ledger);
  const a = await aP;

  const final = fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, 'utf8')) : null;
  const open = final ? Object.values(final.fills).map((f) => f.signature) : [];
  const undone = final ? Object.values(final.retractions).map((f) => f.signature) : [];
  const rep = report(a.out);
  const parked = newRescues(before);

  const retractedResurrected = open.includes(FIX.traded[0].signature);
  const bSurvived = open.includes(FIX.traded[1].signature);
  const retracted = undone.includes(FIX.traded[0].signature);
  const violated = !(a.code === 0 && retracted && bSurvived
    && !retractedResurrected && rep && rep.merge_repair === 'applied' && parked.length === 0);
  return {
    face: 'F2_retract_self_repair',
    slow_exit: a.code, fast_exit: b.code,
    merge_repair: rep ? rep.merge_repair : null,
    retracted_durable: retracted,
    retracted_resurrected_as_open: retractedResurrected,
    other_instance_fill_survived: bSurvived,
    parked_rescue: parked.length,
    slow_stderr: scrub((a.err || '').trim().slice(0, 300), dir),
    violated,
    detail: violated
      ? `the slow retract ended at exit ${a.code}: retracted=${retracted} resurrected=${retractedResurrected} other_fill=${bSurvived} — a retraction is a DELETION, a spread-union cannot express it`
      : `slow_exit=${a.code} retracted=${retracted} resurrected=${retractedResurrected} other=${bSurvived}`,
  };
}

// --- F3: the merge must not lose either side's reports --------------------
function faceF3(dir) {
  const shared = { seq: 1, signature: 'SigShared', err: 'InstructionError', trades_in_logs: 0 };
  const disk = {
    fills: { k1: { signature: 'SigD' } }, retractions: {},
    meta: {
      failed_transactions: [shared, { seq: 2, signature: 'SigDisk', err: 'e', trades_in_logs: 1 }],
      invalid_events: [{ seq: 3, signature: 'SigDisk', invalid: ['bad'] }],
    },
  };
  const mine = {
    fills: { k2: { signature: 'SigMine' } }, retractions: {},
    meta: {
      failed_transactions: [shared, { seq: 4, signature: 'SigMine', err: 'e', trades_in_logs: 2 }],
      invalid_events: [{ seq: 5, signature: 'SigMine', invalid: ['bad2'] }],
    },
  };
  const merged = mergeLedger(disk, mine);
  const failSigs = (merged.meta.failed_transactions || []).map((e) => e.signature);
  const invSigs = (merged.meta.invalid_events || []).map((e) => e.signature);
  const keptDisk = failSigs.includes('SigDisk');
  const keptMine = failSigs.includes('SigMine');
  const dupes = failSigs.filter((s) => s === 'SigShared').length;
  const invKept = invSigs.includes('SigDisk') && invSigs.includes('SigMine');
  const violated = !(keptDisk && keptMine && dupes === 1 && invKept);
  return {
    face: 'F3_merge_keeps_reports',
    kept_disk_report: keptDisk,
    kept_other_side_report: keptMine,
    shared_entry_duplicates: dupes,
    invalid_events_kept_both: invKept,
    violated,
    detail: violated
      ? 'the merge kept the fills but dropped the failure/invalid reports only one side had — the ledger lost the account of what went wrong'
      : `disk=${keptDisk} mine=${keptMine} dupes=${dupes} invalid=${invKept}`,
  };
}

// --- G1 (guard): one instance, one ledger — the documented mode ------------
function faceG1(dir) {
  const ledger = path.join(dir, 'g1-ledger.json');
  const before = rescueSet();
  const bin = mkBin(dir, 'g1-bin', [0, 1, 2, 3], 0);
  const r = spawnSync(process.execPath, [CLI, 'tail', '--db', path.join(dir, 'j.db'),
    '--cursor', path.join(dir, 'g1.cursor'), '--bin', bin, '--ledger', ledger],
    { encoding: 'utf8' });
  const rep = report(r.stdout);
  const fills = fs.existsSync(ledger)
    ? Object.keys(JSON.parse(fs.readFileSync(ledger, 'utf8')).fills).length : null;
  const residue = fs.readdirSync(dir)
    .filter((n) => n.startsWith('g1-ledger.json') && n !== 'g1-ledger.json');
  const parked = newRescues(before);
  const ok = r.status === 0 && fills === 4 && rep && rep.verdict === 'COMPLETE'
    && !rep.merge_repair && residue.length === 0 && parked.length === 0;
  return {
    face: 'G1_single_writer_guard',
    exit: r.status,
    verdict: rep ? rep.verdict : null,
    merge_repair: rep ? rep.merge_repair : null,
    fills,
    residue,
    parked_rescue: parked.length,
    violated: !ok,
    detail: `exit=${r.status} verdict=${rep && rep.verdict} fills=${fills} merge_repair=${rep && rep.merge_repair} residue=${residue.join(',') || 'none'} parked=${parked.length}`,
  };
}

// --- run --------------------------------------------------------------------
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-o-'));
  const faces = [];
  for (const f of [faceF1, faceF2, faceF3, faceG1]) {
    try {
      faces.push(await f(dir));
    } catch (e) {
      faces.push({ face: f.name, violated: null, error: String(e && e.message) });
    }
  }

  const violated = faces.filter((x) => x.violated === true).map((x) => x.face);
  const expectation = EXPECT
    ? (EXPECT === 'violations' ? 'baseline tree: at least one face must violate'
      : 'fixed tree: no face may violate')
    : 'none (report only)';
  const consistent = !EXPECT
    ? true
    : EXPECT === 'violations' ? violated.length > 0 : violated.length === 0;

  const out = {
    measured_at: new Date().toISOString(),
    what: 'the refusal named a repair (mergeLedger) that no CLI path could run — the consumer now performs it itself',
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
      expectation,
      measurement_consistent: consistent,
    },
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
  process.exit(consistent ? 0 : 1);
}

main();
