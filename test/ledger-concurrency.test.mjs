// PULS N pin — the ledger's DURABILITY (PULS M) must not cost the ledger
// its CONCURRENCY: staging names that are fixed per ledger path make two
// watcher instances of the same ledger destroy each other.
//
// RED first, written against the tree at f604cf3 (PULS M): the defect faces
// FAIL there, because saveLedger stages into a FIXED sibling `${file}.tmp`
// and ensureLedgerWritable probes a FIXED sibling `${file}.writability-probe`,
// and a save never checks whether the file changed since this instance read
// it:
//
//   C-N1 (foreign stage clobber): a `ledger.json.tmp` left by ANY other
//      process (crashed instance, foreign tool) is opened with 'w' by the
//      baseline save — its bytes are destroyed and the file itself is
//      renamed away. The fixed tree stages under a pid-unique name and must
//      leave the foreign bytes untouched.
//   C-N2 (stale overwrite / lost update): instance B read the ledger, then
//      instance A made a NEWER ledger durable. B's next save must REFUSE
//      (its view is stale) instead of silently swapping the file back to an
//      older history behind a successful exit.
//   C-N3 (probe collision): same fixed-name defect for the writability
//      probe — a foreign probe file's bytes are clobbered by 'w'.
//   C-N4 (webhook integration): the receiver must deliver (200) WITHOUT
//      touching a foreign stage file sitting next to its ledger.
//
// Guards (hold on BOTH trees, say so explicitly):
//   G-N1  single-writer round-trip stays clean, no residue;
//   G-N2  a failed save in an unwritable home still leaves the file
//         byte-identical (the PULS M contract survives the staging change).
//
// RED on baseline also:
//   G-N3  mergeLedger(disk, mine) — the repair named by the C-N2 refusal —
//         must exist and union both instances' fills (disk wins per key).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

import {
  loadLedger, saveLedger, ensureLedgerWritable, LedgerRefusal, die,
  runWebhookReceiver,
} from '../src/whirlpool-watcher.mjs';

function tmpdir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-pulsn-'));
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

const ledgerWith = (fills) => ({ fills, retractions: {}, meta: {} });
const CANARY = 'FOREIGN-STAGE-CANARY-PULS-N-do-not-touch';

// --- C-N1: staging must never adopt/destroy a foreign `${file}.tmp` --------
test('C-N1: saveLedger leaves a foreign ledger.json.tmp untouched', (t) => {
  const d = tmpdir(t);
  const file = path.join(d, 'ledger.json');
  const foreignTmp = `${file}.tmp`;
  fs.writeFileSync(foreignTmp, CANARY);

  saveLedger(file, ledgerWith({ 'leg-A': { input: '1' } }));

  assert.equal(fs.existsSync(foreignTmp), true,
    'a save that stages under the shared name `${file}.tmp` renames the foreign file away — two instances of this watcher collide on the stage path');
  assert.equal(fs.readFileSync(foreignTmp, 'utf8'), CANARY,
    'the foreign stage bytes must survive a save by another instance');
  assert.equal(Object.keys(loadLedger(file).fills).join(','), 'leg-A',
    'and the save itself must still land');
});

// --- C-N2: a stale view must refuse, not silently roll the file back -------
test('C-N2: saveLedger refuses when the file changed since THIS instance read it', (t) => {
  const d = tmpdir(t);
  const file = path.join(d, 'ledger.json');

  // B reads the (still missing) ledger — its view is "empty".
  const bView = loadLedger(file);
  // Meanwhile A records a fill and becomes durable.
  saveLedger(file, ledgerWith({ 'leg-A': { input: '1' } }));
  const before = fs.readFileSync(file, 'utf8');

  assert.throws(
    () => saveLedger(file, bView),
    (err) => err instanceof LedgerRefusal && /concurrent/i.test(err.message)
      && err.message.includes(file),
    'B must refuse to overwrite what A made durable — B\u2019s view is stale',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before,
    'the refused save must leave the file byte-identical');
  assert.equal(Object.keys(loadLedger(file).fills).join(','), 'leg-A',
    'A\u2019s durable fill must survive B\u2019s refused save');

  // The owner of a fresh view still saves: reload and save succeeds.
  const bFresh = loadLedger(file);
  saveLedger(file, bFresh);

  // Mid-run change: C reads, another writer lands, C saves -> refuse.
  const cView = loadLedger(file);
  saveLedger(file, ledgerWith({ 'leg-A': { input: '1' }, 'leg-X': { input: '9' } }));
  assert.throws(() => saveLedger(file, cView),
    (err) => err instanceof LedgerRefusal && /concurrent/i.test(err.message));
});

// --- C-N3: the writability probe must not clobber a foreign probe ----------
test('C-N3: ensureLedgerWritable leaves a foreign writability-probe untouched', (t) => {
  const d = tmpdir(t);
  const file = path.join(d, 'ledger.json');
  const foreignProbe = `${file}.writability-probe`;
  fs.writeFileSync(foreignProbe, CANARY);

  ensureLedgerWritable(file);

  assert.equal(fs.existsSync(foreignProbe), true,
    'the probe must not share a fixed name with other instances; it renamed/removed a foreign probe file');
  assert.equal(fs.readFileSync(foreignProbe, 'utf8'), CANARY,
    'the foreign probe bytes must survive');
  // The instance's own probe is cleaned up: no NEW residue.
  const residue = fs.readdirSync(d).filter((n) => n.startsWith('ledger.json')
    && n !== 'ledger.json.tmp' && n !== 'ledger.json.writability-probe');
  assert.deepEqual(residue, [], 'own probe must be removed');
});

// --- C-N4: webhook delivers without touching a foreign stage file ----------
test('C-N4: webhook answers 200 over a healthy ledger and leaves a foreign tmp alone', async (t) => {
  const d = tmpdir(t);
  const file = path.join(d, 'ledger.json');
  fs.writeFileSync(`${file}.tmp`, CANARY);
  saveLedger(file, ledgerWith({}));

  const secret = '***';
  const server = await runWebhookReceiver({ port: 0, secret, ledgerPath: file, log: () => {} });
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });
  const port = server.address().port;

  const body = JSON.stringify({
    type: 'event', seq: 1, signature: '5rTc4mPdFQ6z8wNfYh2gJxkVb3sLp9uE7aRqD1tHmWcXo0S6yBn4vKgZ',
    slot: 1, err: null, logs: null,
  });
  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-reeflog-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    },
    body,
  });
  assert.equal(res.status, 200, 'a durable delivery must still ACK');
  assert.equal(fs.existsSync(`${file}.tmp`), true,
    'the receiver must not adopt or destroy a foreign stage file');
  assert.equal(fs.readFileSync(`${file}.tmp`, 'utf8'), CANARY);
});

// --- C-N5: the refusal voice names the collision and the repair ------------
test('C-N5: the concurrency refusal carries the contract words', (t) => {
  const d = tmpdir(t);
  const file = path.join(d, 'ledger.json');
  saveLedger(file, ledgerWith({ 'leg-A': { input: '1' } }));
  const stale = loadLedger(file);
  saveLedger(file, ledgerWith({ 'leg-A': { input: '1' }, 'leg-B': { input: '2' } }));
  try {
    saveLedger(file, stale);
    assert.fail('the stale save must refuse');
  } catch (err) {
    assert.equal(err instanceof LedgerRefusal, true);
    assert.match(err.message, /concurrent/i);
    assert.match(err.message, /UNCHANGED/,
      'the refusal must promise the file was not touched');
    assert.match(err.message, /merge/i,
      'the refusal must name the repair (merge)');
    assert.equal(err.isRefusal, true, 'the CLI must be able to recognize it (exit 3 / 503)');
  }
});

// --- G-N1 (guard, GREEN on BOTH trees): single writer stays clean ----------
test('G-N1: single-writer save/load round-trip is byte-faithful and leaves no residue', (t) => {
  const d = tmpdir(t);
  const file = path.join(d, 'ledger.json');
  saveLedger(file, ledgerWith({
    'sig:pool:1:2:0': { signature: 'sig', input: '1', output: '2' },
  }));
  const back = loadLedger(file);
  assert.equal(back.fills['sig:pool:1:2:0'].output, '2');
  // A ledger whose on-disk bytes were written by ANOTHER tool (different
  // formatting) is the case where the freshness mark matters: the first
  // save normalizes the bytes, so the mark must be refreshed by the write
  // itself. Without the refresh (the M7 mutation) the SECOND save of the
  // SAME writer refuses itself — a single writer locking out.
  const foreign = path.join(d, 'foreign.json');
  fs.writeFileSync(foreign, JSON.stringify({ fills: { 'sig:pool:1:2:0': { signature: 'sig', input: '1', output: '2' } }, retractions: {}, meta: {} }));
  const foreignView = loadLedger(foreign);
  saveLedger(foreign, foreignView);
  try {
    saveLedger(foreign, foreignView);
  } catch (err) {
    assert.fail(`a single writer must be able to save its own view twice in a row (got: ${err.message})`);
  }
  // Same view, second save with CHANGED content: also legal for one writer.
  back.fills['second-leg'] = { signature: 'second', input: '3' };
  try {
    saveLedger(file, back);
  } catch (err) {
    assert.fail(`a single writer must be able to save its own view twice in a row (got: ${err.message})`);
  }
  assert.equal(Object.keys(loadLedger(file).fills).length, 2,
    'both saves must be durable');
  const residue = fs.readdirSync(d).filter((n) => n.startsWith('ledger.json') && n !== 'ledger.json');
  assert.deepEqual(residue, []);
});

// --- G-N2 (guard, GREEN on BOTH trees): PULS M save contract survives ------
test('G-N2: a failed save in an unwritable home leaves the ledger byte-identical', (t) => {
  const d = tmpdir(t);
  const home = path.join(d, 'home');
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'ledger.json');
  saveLedger(file, ledgerWith({ 'leg-A': { input: '1' } }));
  const before = fs.readFileSync(file, 'utf8');
  fs.chmodSync(home, 0o500);
  try {
    assert.throws(
      () => saveLedger(file, ledgerWith({ 'leg-B': { input: '2' } })),
      (err) => err instanceof LedgerRefusal && /UNCHANGED/.test(err.message),
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.chmodSync(home, 0o700);
  }
});

// --- G-N3 (RED on baseline): the named repair must exist --------------------
test('G-N3: mergeLedger(disk, mine) unions both instances\u2019 fills, disk wins per key', async () => {
  const mod = await import('../src/whirlpool-watcher.mjs');
  assert.equal(typeof mod.mergeLedger, 'function',
    'the documented repair (merge) must exist as mergeLedger(disk, mine)');
  const merged = mod.mergeLedger(
    ledgerWith({ 'leg-A': { input: '1' } }),
    ledgerWith({ 'leg-B': { input: '2' } }),
  );
  assert.deepEqual(Object.keys(merged.fills).sort(), ['leg-A', 'leg-B']);
  const merged2 = mod.mergeLedger(
    ledgerWith({ 'leg-A': { input: '9' } }),
    ledgerWith({ 'leg-A': { input: '1' } }),
  );
  assert.equal(merged2.fills['leg-A'].input, '9',
    'a leg already durable on disk keeps the disk copy');
});

// --- C-N7: two instances, one ledger — the card's named surface ------------
// Instance A starts at t0: it reads the (still absent) ledger, spawns its
// mailbox — which is SLOW (1.2s) — and saves at ~t+1.2s. Instance B starts
// at t+0.1s with its own cursor, finishes at ~t+0.3s and makes ITS fills
// durable first. A's in-memory view ("no ledger") is then STALE.
//
// Defect contract: whoever reports success must be durable. On the defect
// tree both runs exit 0 and A's save silently reverts the ledger to A's
// view — B's fills vanish behind two healthy reports.
// On the fixed tree the stale instance refuses (exit 3, naming the
// concurrent writer), parks its consumed rows for rescue, and the file
// keeps B's durable state; rescue then replays A's rows into the CURRENT
// ledger, so nothing is lost.
test('C-N7: a late save over a newer ledger refuses, parks rows, exits 3; rescue merges', { timeout: 60000 }, (t) => {
  const d = tmpdir(t);
  const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
  const ledger = path.join(d, 'ledger.json');
  const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;

  const mkBin = (fixtureIdx, sleepMs) => {
    const rows = fixtureIdx.map((i) => ({
      seq: i + 1, signature: FIX.traded[i].signature, slot: FIX.traded[i].slot,
      seal: 'finalized', err: null,
      logs: [`Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc invoke [1]`,
        `Program data: ${FIX.traded[i].program_data}`,
        `Program whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc success`],
    }));
    const file = path.join(d, `bin-${fixtureIdx.join('')}`);
    fs.writeFileSync(file,
      `#!/usr/bin/env node\nconst rows = ${JSON.stringify(rows)};\n` +
      `if (${sleepMs} > 0) { const end = Date.now() + ${sleepMs}; while (Date.now() < end) {} }\n` +
      `for (const r of rows) process.stdout.write(JSON.stringify(r) + '\\n');\n` +
      `process.exit(0);\n`);
    fs.chmodSync(file, 0o755);
    return file;
  };

  const run = (bin, cursor) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'tail', '--db', path.join(d, 'j.db'),
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

  return (async () => {
    const aPromise = run(binA, path.join(d, 'a.cursor'));
    await new Promise((r) => setTimeout(r, 100));
    const b = await run(binB, path.join(d, 'b.cursor'));
    const a = await aPromise;

    const final = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    const finalSigs = Object.values(final.fills).map((f) => f.signature);
    const bSigs = [FIX.traded[2].signature, FIX.traded[3].signature];
    const rescueNew = fs.readdirSync(os.tmpdir())
      .filter((n) => n.startsWith('whirlpool-watcher-rescue-') && !rescueBefore.has(n));

    assert.equal(b.code, 0, `B (fast) must complete cleanly (${b.err})`);
    assert.equal(a.code, 3,
      `A's save found a ledger NEWER than its view and must refuse with exit 3 — got ${a.code}\nstderr: ${a.err}`);
    assert.match(a.err, /concurrent/i,
      'A\u2019s refusal must name the concurrent writer');
    for (const sig of bSigs) {
      assert.equal(finalSigs.includes(sig), true,
        'B\u2019s durable fills must survive A\u2019s late save');
    }
    assert.equal(rescueNew.length, 1,
      `A's consumed rows must be parked for rescue (found: ${rescueNew.join(', ') || 'none'})`);
    const parked = fs.readFileSync(path.join(os.tmpdir(), rescueNew[0]), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(parked.length, 2, 'both consumed rows must be in the rescue file');

    const resc = spawnSync(process.execPath,
      [CLI, 'rescue', '--file', path.join(os.tmpdir(), rescueNew[0]), '--ledger', ledger],
      { encoding: 'utf8' });
    assert.equal(resc.status, 0, `rescue must replay (${resc.stderr})`);
    const merged = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    assert.equal(Object.keys(merged.fills).length, 4,
      'after rescue the ledger must hold BOTH instances\u2019 fills — nothing was lost');
  })();
});

// --- C-N6: die() still produces the CLI-recognizable refusal (PULS M pin) ---
test('C-N6: die() remains a refusal the CLI can recognize', () => {
  assert.throws(() => die('x'), (err) => err instanceof LedgerRefusal && err.isRefusal === true);
});
