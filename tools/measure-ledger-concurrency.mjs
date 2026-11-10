// PULS N — the CONSUMER can lose another instance's history: two watcher
// instances, one ledger file.
//
// PULS M closed the corruption faces (a ledger destroyed by its OWN bad
// bytes). This tool measures the face PULS M's notes named as next: the
// ledger held no freshness and no per-process staging, so a second writer —
// a second `whirlpool-watcher` instance (or a crashed older one) pointing
// at the SAME --ledger path — could silently revert or tear it.
//
// Every face is driven through the REAL CLI (src/cli.mjs) or the real
// library entry points (loadLedger/saveLedger), never a paraphrase.
//
// Faces:
//   F1 two_instances_one_ledger: instance A starts first, its fake mailbox
//      is SLOW (1.2s); instance B (own cursor, own journal) starts +100ms
//      and finishes first, making ITS fills durable. A's late save then
//      finds a ledger newer than its own view ("absent"). Baseline: A exits
//      0 and reverts the file — B's fills vanish behind two healthy reports.
//      Fixed: A refuses (exit 3), B's fills survive, A's consumed rows are
//      parked, rescue merges to all four.
//   F2 foreign_stage_clobber: a `ledger.json.tmp` left by another process
//      must survive a save (fixed staging name is per-process; the baseline
//      staged into THAT name and renamed it away).
//   F3 foreign_probe_clobber: same for `${file}.writability-probe`.
//   F4 stale_view_save: loadLedger on an absent file, another writer makes
//      the file durable, then the stale view saves. Baseline: overwrites
//      silently. Fixed: refuses, file byte-identical.
//   G1 single_writer (guard): one CLI run from empty must deliver all four
//      fixture fills, exit 0, COMPLETE, and leave NO stage/probe residue.
//
// Usage:
//   node tools/measure-ledger-concurrency.mjs --expect violations|clean [--label NAME]
// contract: `violations` exits 0 only when at least one face violates
// (baseline tree); `clean` exits 0 only when no face violates (fixed tree).
// A tool whose faces all go the "wrong" way exits non-zero: a lying
// measurement, not a result.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const { loadLedger, saveLedger } = await import(path.join(ROOT, 'src', 'whirlpool-watcher.mjs'));

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const EXPECT = arg('--expect', '');
const LABEL = arg('--label', EXPECT || 'unlabeled');
const OUT = process.env.PULSE_N_OUT
  || path.join(ROOT, 'research', `ledger-concurrency-${LABEL}-2026-11-10.json`);

const CLI = path.join(ROOT, 'src', 'cli.mjs');
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures.json'), 'utf8'));
const CANARY = 'FOREIGN-STAGE-CANARY-PULS-N-do-not-touch';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- F1: two CLI instances, one ledger --------------------------------------
async function faceF1(dir) {
  const ledger = path.join(dir, 'f1-ledger.json');
  const mkBin = (idx, sleepMs) => {
    const rows = idx.map((i) => ({
      seq: i + 1, signature: FIX.traded[i].signature, slot: FIX.traded[i].slot,
      seal: 'finalized', err: null,
      logs: [`Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke [1]`,
        `Program data: ${FIX.traded[i].program_data}`,
        `Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc success`],
    }));
    const file = path.join(dir, `bin-${idx.join('')}`);
    fs.writeFileSync(file,
      `#!/usr/bin/env node\nconst rows = ${JSON.stringify(rows)};\n` +
      // Busy-wait, not await: the bin must stay plain CommonJS so module
      // detection never has to rescue it.
      `if (${sleepMs} > 0) { const end = Date.now() + ${sleepMs}; while (Date.now() < end) {} }\n` +
      `for (const r of rows) process.stdout.write(JSON.stringify(r) + '\\n');\n` +
      `process.exit(0);\n`);
    fs.chmodSync(file, 0o755);
    return file;
  };
  const run = (bin, cursor) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'tail', '--db', path.join(dir, 'j.db'),
      '--cursor', cursor, '--bin', bin, '--ledger', ledger]);
    let out = '', err = '';
    p.stdout.on('data', (x) => { out += x; });
    p.stderr.on('data', (x) => { err += x; });
    p.on('close', (code) => resolve({ code, out, err }));
  });

  const binA = mkBin([0, 1], 1200);
  const binB = mkBin([2, 3], 0);
  const rescueBefore = new Set(fs.readdirSync(os.tmpdir())
    .filter((n) => n.startsWith('whirlpool-watcher-rescue-')));

  const aP = run(binA, path.join(dir, 'a.cursor'));
  await sleep(100);
  const b = await run(binB, path.join(dir, 'b.cursor'));
  const a = await aP;

  const final = fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, 'utf8')) : null;
  const finalSigs = final ? Object.values(final.fills).map((f) => f.signature) : [];
  const bSigs = [FIX.traded[2].signature, FIX.traded[3].signature];
  const bSurvived = bSigs.every((s) => finalSigs.includes(s));
  const rescueNew = fs.readdirSync(os.tmpdir())
    .filter((n) => n.startsWith('whirlpool-watcher-rescue-') && !rescueBefore.has(n));

  let repairedFills = null;
  if (rescueNew.length) {
    const resc = spawnSync(process.execPath, [CLI, 'rescue', '--file',
      path.join(os.tmpdir(), rescueNew[0]), '--ledger', ledger], { encoding: 'utf8' });
    if (resc.status === 0 && fs.existsSync(ledger)) {
      repairedFills = Object.keys(JSON.parse(fs.readFileSync(ledger, 'utf8')).fills).length;
    }
  }

  // The violation: the slow instance reported success (exit 0) while the
  // fills the fast instance had made durable are gone from the file.
  const violated = b.code === 0 && a.code === 0 && !bSurvived;
  return {
    face: 'F1_two_instances_one_ledger',
    slow_exit: a.code, fast_exit: b.code,
    b_fills_survived_slow_save: bSurvived,
    final_fills: final ? Object.keys(final.fills).length : null,
    parked_rescue: rescueNew.length,
    fills_after_rescue: repairedFills,
    slow_stderr: (a.err || '').trim().slice(0, 400),
    violated,
    detail: violated
      ? 'the slow instance exited 0 and reverted the ledger to its own older view — the fast instance fills are gone behind two healthy reports'
      : `slow_exit=${a.code} fast_exit=${b.code} b_survived=${bSurvived} rescue=${rescueNew.length} repaired=${repairedFills}`,
  };
}

// --- F2: foreign stage file must survive a save -----------------------------
function faceF2(dir) {
  const ledger = path.join(dir, 'f2-ledger.json');
  const foreignTmp = `${ledger}.tmp`;
  fs.writeFileSync(foreignTmp, CANARY);
  const bin = path.join(dir, 'f2-bin');
  fs.writeFileSync(bin, '#!/usr/bin/env node\nprocess.exit(0);\n');
  fs.chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'tail', '--db', path.join(dir, 'j.db'),
    '--cursor', path.join(dir, 'f2.cursor'), '--bin', bin, '--ledger', ledger],
    { encoding: 'utf8' });
  const canaryIntact = fs.existsSync(foreignTmp)
    && fs.readFileSync(foreignTmp, 'utf8') === CANARY;
  const ledgerWritten = fs.existsSync(ledger);
  return {
    face: 'F2_foreign_stage_clobber',
    exit: r.status,
    foreign_tmp_intact: canaryIntact,
    ledger_written: ledgerWritten,
    violated: ledgerWritten && !canaryIntact,
    detail: ledgerWritten && !canaryIntact
      ? 'a save staged into the FIXED sibling name and renamed the foreign temp away — two instances collide on one temp path'
      : `exit=${r.status} intact=${canaryIntact} ledger=${ledgerWritten}`,
  };
}

// --- F3: foreign probe file must survive a run ------------------------------
function faceF3(dir) {
  const ledger = path.join(dir, 'f3-ledger.json');
  const foreignProbe = `${ledger}.writability-probe`;
  fs.writeFileSync(foreignProbe, CANARY);
  const bin = path.join(dir, 'f3-bin');
  fs.writeFileSync(bin, '#!/usr/bin/env node\nprocess.exit(0);\n');
  fs.chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'tail', '--db', path.join(dir, 'j.db'),
    '--cursor', path.join(dir, 'f3.cursor'), '--bin', bin, '--ledger', ledger],
    { encoding: 'utf8' });
  const canaryIntact = fs.existsSync(foreignProbe)
    && fs.readFileSync(foreignProbe, 'utf8') === CANARY;
  return {
    face: 'F3_foreign_probe_clobber',
    exit: r.status,
    foreign_probe_intact: canaryIntact,
    violated: !canaryIntact,
    detail: !canaryIntact
      ? 'the writability probe used a FIXED sibling name: a concurrent instance opened the foreign probe with \'w\' and removed it'
      : `exit=${r.status} intact=${canaryIntact}`,
  };
}

// --- F4: a stale view must refuse, not revert -------------------------------
function faceF4(dir) {
  const ledger = path.join(dir, 'f4-ledger.json');
  const stale = loadLedger(ledger); // view: ABSENT
  saveLedger(ledger, { fills: { 'leg-A': { input: '1' } }, retractions: {}, meta: {} });
  const before = fs.readFileSync(ledger, 'utf8');
  let refused = false;
  try {
    saveLedger(ledger, stale);
  } catch (err) {
    refused = /concurrent/i.test(err.message || '') && err.isRefusal === true;
  }
  const after = fs.readFileSync(ledger, 'utf8');
  return {
    face: 'F4_stale_view_save',
    refused,
    file_unchanged: before === after,
    leg_a_survived: after === before && after.includes('leg-A'),
    violated: !refused,
    detail: !refused
      ? 'a save over a file newer than this instance\u2019s view succeeded: the on-disk history was reverted with no refusal'
      : `refused=${refused} unchanged=${before === after}`,
  };
}

// --- G1 (guard): one instance, one ledger — the documented mode -------------
function faceG1(dir) {
  const ledger = path.join(dir, 'g1-ledger.json');
  const bin = path.join(dir, 'g1-bin');
  const rows = FIX.traded.map((t, i) => ({
    seq: i + 1, signature: t.signature, slot: t.slot, seal: 'finalized', err: null,
    logs: [`Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke [1]`,
      `Program data: ${t.program_data}`,
      `Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc success`],
  }));
  fs.writeFileSync(bin,
    `#!/usr/bin/env node\nconst rows = ${JSON.stringify(rows)};\n` +
    `for (const r of rows) process.stdout.write(JSON.stringify(r) + '\\n');\nprocess.exit(0);\n`);
  fs.chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'tail', '--db', path.join(dir, 'j.db'),
    '--cursor', path.join(dir, 'g1.cursor'), '--bin', bin, '--ledger', ledger],
    { encoding: 'utf8' });
  const rep = (() => {
    const s = (r.stdout || '').indexOf('{');
    return s >= 0 ? JSON.parse(r.stdout.slice(s)) : null;
  })();
  const fills = fs.existsSync(ledger)
    ? Object.keys(JSON.parse(fs.readFileSync(ledger, 'utf8')).fills).length : null;
  const residue = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => n.startsWith('g1-ledger.json') && n !== 'g1-ledger.json')
    : [];
  const ok = r.status === 0 && fills === 4 && rep && rep.verdict === 'COMPLETE' && residue.length === 0;
  return {
    face: 'G1_single_writer_guard',
    exit: r.status,
    verdict: rep ? rep.verdict : null,
    fills,
    residue,
    violated: !ok,
    detail: `exit=${r.status} verdict=${rep && rep.verdict} fills=${fills} residue=${residue.join(',') || 'none'}`,
  };
}

// --- run --------------------------------------------------------------------
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-n-'));
  const order = [faceF1, faceF2, faceF3, faceF4, faceG1];
  const faces = [];
  for (const f of order) {
    try {
      faces.push(f.name === 'faceF1' ? await f(dir) : f(dir));
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
    what: 'consumer-side concurrency: two whirlpool-watcher instances, one ledger file',
    seat: {
      kind: 'watcher tree (the defect lives entirely in this repo)',
      watcher_commit: (() => {
        const g = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
        return g.stdout.trim();
      })(),
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
