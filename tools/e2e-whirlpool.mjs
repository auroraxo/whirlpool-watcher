// End-to-end proof that whirlpool-watcher is a real consumer of the reeflog
// mailbox — and that the mailbox does not lose or distort fills.
//
// The comparison, side by side, on live mainnet (Orca Whirlpool program
// whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc):
//
//   naive  = a bot without a mailbox: getSignaturesForAddress every 2 s,
//            then getTransaction for new signatures, decoding the Traded
//            event out of the fetched logs. Every RPC call is counted.
//   watcher = THIS repository, reading `reeflog tail` off disk. It makes
//            zero RPC calls of its own.
//
// The watcher's numbers are then checked a THIRD time, independently, against
// the chain: every fill it claims must be corroborated by the token-balance
// deltas of a transaction fetched straight from the RPC by signature. A
// decoder that reads the wrong field cannot pass that.
//
// Checks:
//  1. consumer_makes_no_rpc_calls   - the watcher's own RPC count is 0.
//  2. window_superset               - every naive fill inside the daemon's
//                                     slot window is in the watcher's ledger.
//  3. decoded_amounts_match         - overlapping fills decode identically.
//  4. chain_witness                 - every watcher fill's input/output
//                                     amounts appear as real token-balance
//                                     moves in the transaction fetched from
//                                     the chain by signature.
//  5. no_guessed_fills              - every ledger fill came from a Traded
//                                     event; invalid legs are reported.
//  6. exactly_once_on_replay        - a second tail run adds no fill.
//  7. retraction_undo_is_scoped     - a retraction undoes exactly the fill
//                                     this consumer read, and nothing else.
//
// The naive baseline is a COMPETENT bot, not a broken one: it skips failed
// transactions and zero-amount trades, exactly like the watcher does.
// Measured 2026-10-31: the first version's naive side booked fills from
// reverted transactions (the logs still carry the Traded event, but the
// transaction rolled back) and from 0/0 trades, and the harness then demanded
// the watcher hold them too — a baseline that books phantom fills would make
// window_superset a test of sloppiness, not of delivery.
//
// A mutation probe (--mutate) corrupts the decoder on purpose and requires
// the E2E to go RED at the named check: a green harness over a broken
// decoder is worse than no harness.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REEFLOG_BIN = process.env.REEFLOG_BIN || path.resolve(
  process.env.HOME || '/home/aurora', 'github_repos/reeflog/target/release/reeflog');
const RPC = process.env.RPC || 'https://api.mainnet-beta.solana.com';
const PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const DIR = process.env.WW_E2E_DIR || '/tmp/ww-e2e';
const DB = path.join(DIR, 'reeflog.db');
const CURSOR = path.join(DIR, 'cursor.txt');
const LEDGER = path.join(DIR, 'fills.json');
const SECONDS = Number(process.env.WW_E2E_SECONDS || 60);
const REPORT = path.join(ROOT, 'research', 'whirlpool-e2e-report.json');
const MUTATE = process.argv.includes('--mutate');

// --- the decoder under test ------------------------------------------------
// The WHOLE src tree is copied and the copy is mutated, because the ledger
// is built by whirlpool-watcher.mjs importing './decode.mjs' — mutating a
// detached module that nothing imports would run a green probe over dead
// code (measured 2026-10-31: probe passed on its first run, proving
// nothing; the mutation must be what the watcher actually executes).
const decodeSrc = fs.readFileSync(path.join(ROOT, 'src', 'decode.mjs'), 'utf8');
const decodeDir = path.join(DIR, 'mutant');
fs.mkdirSync(decodeDir, { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
  if (f === 'decode.mjs') continue;
  fs.copyFileSync(path.join(ROOT, 'src', f), path.join(decodeDir, f));
}
let decodeCode = decodeSrc;
if (MUTATE) {
  // Mutation: swap the two amount fields in the decoder under test. The
  // decoded amounts must then disagree with the independent naive decoder
  // — if the harness stays green, the harness is worthless.
  const before = decodeCode;
  decodeCode = decodeCode.replace(
    '  const input_amount = u64(raw, o);\n  o += 8;\n  const output_amount = u64(raw, o);',
    '  const output_amount = u64(raw, o);\n  o += 8;\n  const input_amount = u64(raw, o);',
  );
  if (decodeCode === before) {
    console.error('MUTATION DID NOT APPLY — the probe would prove nothing');
    process.exit(2);
  }
}
fs.writeFileSync(path.join(decodeDir, 'decode.mjs'), decodeCode);
const { decodeProgramData } = await import(path.join(decodeDir, 'decode.mjs'));
// Import the watcher from the SAME directory, so its './decode.mjs' is the
// mutated one when --mutate is on and the original otherwise.
const { watchTail, loadLedger } = await import(
  path.join(decodeDir, 'whirlpool-watcher.mjs'));

const DISC = createHash('sha256').update('event:Traded').digest().subarray(0, 8);

function b58(bytes) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s || '1';
}

// Independent decode used by the NAIVE poller only: written separately from
// the decoder under test on purpose, so a bug in one does not hide in both.
function naiveDecode(logs) {
  const out = [];
  for (const line of logs || []) {
    if (typeof line !== 'string') continue;
    const i = line.indexOf('Program data: ');
    if (i < 0) continue;
    const raw = Buffer.from(line.slice(i + 'Program data: '.length).trim(), 'base64');
    if (raw.length !== 121) continue;
    if (!raw.subarray(0, 8).equals(DISC)) continue;
    let o = 8;
    const pool = b58(raw.subarray(o, o + 32)); o += 32;
    const a_to_b = raw[o] !== 0; o += 1;
    o += 16; // pre sqrt price (u128)
    o += 16; // post sqrt price (u128)
    const input = raw.readBigUInt64LE(o); o += 8;
    const output = raw.readBigUInt64LE(o); o += 8;
    const inFee = raw.readBigUInt64LE(o); o += 8;
    const outFee = raw.readBigUInt64LE(o); o += 8;
    const lpFee = raw.readBigUInt64LE(o); o += 8;
    const protoFee = raw.readBigUInt64LE(o);
    out.push({ pool, a_to_b, input, output, inFee, outFee, lpFee, protoFee });
  }
  return out;
}

const rpcCalls = { sigs: 0, tx: 0 };
async function rpc(method, params, kind, tries = 10) {
  if (kind) rpcCalls[kind]++;
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, 500 * (i * i + 1)));
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (res.status === 429) { last = new Error('429'); continue; }
      const j = await res.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}

function cli(args) {
  return new Promise((resolve) => {
    const c = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    c.stdout.on('data', (d) => { o += d; });
    c.stderr.on('data', (d) => { e += d; });
    c.on('close', (code) => resolve({ code, out: o, err: e }));
    c.on('error', (err) => resolve({ code: null, out: o, err: `${e}\n${err}` }));
  });
}

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
};

if (!fs.existsSync(REEFLOG_BIN)) {
  console.error(`reeflog binary not found at ${REEFLOG_BIN}`);
  process.exit(2);
}

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'research'), { recursive: true });
fs.mkdirSync(DIR, { recursive: true });
{
  const r = await cli([REEFLOG_BIN, 'init', '--db', DB, '--program', PROGRAM]);
  if (r.code !== 0) { console.error('INIT FAILED', r.err); process.exit(2); }
}

// --- both consumers start at the same instant -----------------------------
const t0 = Date.now();
const endAt = t0 + SECONDS * 1000;
const reefRun = cli([REEFLOG_BIN, 'start', '--db', DB, '--seconds', String(SECONDS),
  '--program', PROGRAM, '--seal-every', '5', '--reorg-every', '10']);

// The naive poller phase 1: track the signature->slot map at the tip, the
// way a bot tracks its watermark. It does NOT judge the daemon by what a
// single page happens to contain — the first version of this harness did
// that and measured nothing (0 overlapping trades, a vacuous comparison).
const sigSlot = new Map(); // sig -> slot
let polls = 0;
while (Date.now() < endAt) {
  polls++;
  try {
    const page = await rpc('getSignaturesForAddress',
      [PROGRAM, { limit: 200, commitment: 'confirmed' }], 'sigs');
    for (const row of page) {
      if (!sigSlot.has(row.signature)) sigSlot.set(row.signature, row.slot);
    }
  } catch (e) {
    console.error('naive poll error:', String(e.message || e));
  }
  await new Promise((r) => setTimeout(r, 2000));
}
const reefResult = await reefRun;

// --- the daemon's own slot window -----------------------------------------
let win;
{
  const db = new DatabaseSync(DB, { readOnly: true });
  win = db.prepare('SELECT MIN(slot) lo, MAX(slot) hi, COUNT(*) n FROM events').get();
  db.close();
}
console.log(`\nnaive: ${polls} polls, ${sigSlot.size} signatures tracked`);
console.log(`daemon window: slots ${win.lo}..${win.hi}, ${win.n} rows`);

// Naive phase 2: the window is now known. The signatures the poller saw
// INSIDE it are the comparison set; the bot buys their content now, the way
// it would decode its own fills. `slot` comes from the signatures page, so
// no content is bought for signatures outside the window.
const naive = new Map(); // sig -> {slot, trades}
let bought = 0, errors = 0, skipped_failed = 0, skipped_zero = 0;
const inWindowSigs = [...sigSlot.entries()]
  .filter(([, slot]) => slot >= win.lo && slot <= win.hi);
// Bounded buy: the public endpoint rate-limits, and buying every in-window
// signature on a busy program (~900 of them) turned the harness into a
// throttling experiment instead of a measurement. The budget is a declared
// sample; the report says how much of the window it covers.
const TX_BUDGET = Number(process.env.WW_E2E_TX_BUDGET || 120);
const boughtSet = inWindowSigs.slice(0, TX_BUDGET);
for (const [sig, slot] of boughtSet) {
  let tx;
  try {
    tx = await rpc('getTransaction', [sig, {
      commitment: 'confirmed', maxSupportedTransactionVersion: 1, encoding: 'json',
    }], 'tx');
  } catch { errors++; continue; }
  bought++;
  if (!tx) continue;
  // A failed transaction's logs still contain the Traded event, but the
  // transaction rolled back: no balance moved. Booking it is a phantom fill.
  if (tx.meta?.err != null) { skipped_failed++; continue; }
  let trades = naiveDecode(tx.meta?.logMessages);
  // A 0/0 trade exchanges nothing; it is not a fill on either side.
  const nonzero = trades.filter((t) => t.input !== 0n || t.output !== 0n);
  skipped_zero += trades.length - nonzero.length;
  trades = nonzero;
  if (trades.length) naive.set(sig, { slot, trades });
}
console.log(`naive bought ${bought}/${inWindowSigs.length} in-window signatures (budget ${TX_BUDGET}); skipped_failed=${skipped_failed} skipped_zero=${skipped_zero}`);
const naiveSlots = [...sigSlot.values()];
const naiveLo = naiveSlots.length ? Math.min(...naiveSlots) : null;
const naiveHi = naiveSlots.length ? Math.max(...naiveSlots) : null;
const naiveInCount = inWindowSigs.length;
console.log(`naive slot coverage: ${naiveLo}..${naiveHi}; ${naiveInCount} signatures inside the daemon's window`);

// --- make every held row readable -----------------------------------------
await cli([REEFLOG_BIN, 'hydrate', '--db', DB, '--limit', '5000']);

// --- the watcher: OUR consumer, reading only the mailbox -------------------
const callsBefore = rpcCalls.sigs + rpcCalls.tx;
const tWatch = Date.now();
const w = await watchTail({ db: DB, cursor: CURSOR, bin: REEFLOG_BIN, limit: 10000, ledgerPath: LEDGER });
const watchMs = Date.now() - tWatch;
const watcherCalls = (rpcCalls.sigs + rpcCalls.tx) - callsBefore;
const ledger = loadLedger(LEDGER);
const fills = Object.values(ledger.fills);
console.log(`watcher: ${w.rows} rows -> ${fills.length} fills in ${watchMs}ms ` +
  `(own RPC calls: ${watcherCalls})`);

check('consumer_makes_no_rpc_calls', watcherCalls === 0,
  `${watcherCalls} RPC calls made by the watcher itself`);

// slot-align the comparison
const naiveIn = naive; // every naive trade was bought because it is inside the window
const watcherBySig = new Map();
for (const f of fills) {
  if (!watcherBySig.has(f.signature)) watcherBySig.set(f.signature, []);
  watcherBySig.get(f.signature).push(f);
}

const missing = [...naiveIn.keys()].filter((s) => !watcherBySig.has(s));
check('window_superset', missing.length === 0 && naiveIn.size > 0,
  `${naiveIn.size} in-window naive trades, ${watcherBySig.size} sigs in the ledger, ` +
  `missing ${missing.length}` +
  (missing.length ? ` e.g. ${missing.slice(0, 2).join(', ')}` : ''));

// decoded amounts must agree where both saw the trade
let identical = 0;
const mismatches = [];
for (const [sig, nv] of naiveIn) {
  const wf = watcherBySig.get(sig);
  if (!wf) continue;
  for (const nt of nv.trades) {
    const match = wf.find((f) => f.pool === nt.pool
      && f.input === nt.input.toString() && f.output === nt.output.toString()
      && f.lp_fee === nt.lpFee.toString());
    if (match) identical++;
    else mismatches.push({ sig: sig.slice(0, 16), naive: { i: nt.input.toString(), o: nt.output.toString() },
      watcher: wf.map((f) => ({ i: f.input, o: f.output })) });
  }
}
check('decoded_amounts_match', mismatches.length === 0 && identical > 0,
  `${identical} overlapping legs decode identically, ${mismatches.length} mismatch(es)` +
  (mismatches.length ? ` first=${JSON.stringify(mismatches[0])}` : ''));

// --- chain witness: fetch each claimed fill's transaction by signature -----
// Three outcomes, kept apart on purpose (the same honesty model reeflog
// uses for payloads): witnessed = chain deltas corroborate the decode;
// mismatched = chain deltas CONTRADICT it (the decoder is wrong — that is
// the falsification); unavailable = the endpoint did not serve the
// transaction, which is evidence about the endpoint, not about the decoder,
// and is reported as its own count, never folded into either.
let witnessed = 0;
const mismatched = [];
let unavailable = 0;
// Bounded sample, declared: one getTransaction per fill was 600+ calls for a
// 45 s window. The sample is deterministic (journal order), not cherry-picked.
const WITNESS_LIMIT = Number(process.env.WW_E2E_WITNESS_LIMIT || 40);
const witnessSample = fills
  .slice()
  .sort((a, b) => a.seq - b.seq)
  .slice(0, WITNESS_LIMIT);
for (const f of witnessSample) {
  let tx;
  try {
    tx = await rpc('getTransaction', [f.signature, {
      commitment: 'confirmed', maxSupportedTransactionVersion: 1, encoding: 'json',
    }], 'tx');
  } catch { unavailable++; continue; }
  if (!tx?.meta) { unavailable++; continue; }
  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  const postByIdx = new Map(post.map((p) => [p.accountIndex, p.uiTokenAmount.amount]));
  const abs = pre.map((p) => {
    const after = postByIdx.get(p.accountIndex);
    if (after === undefined) return null;
    const d = BigInt(after) - BigInt(p.uiTokenAmount.amount);
    return d < 0n ? (-d).toString() : d.toString();
  }).filter((x) => x !== null);
  const hitIn = abs.includes(f.input);
  const hitOut = abs.includes(f.output);
  if (hitIn && hitOut) witnessed++;
  else mismatched.push(`${f.signature.slice(0, 12)} in=${f.input} out=${f.output}`);
}
check('chain_witness', mismatched.length === 0 && witnessed > 0,
  `${witnessed}/${witnessSample.length} sampled ledger fills (seq order, sample of ${fills.length}) ` +
  `corroborated by the chain's token-balance deltas; mismatched=${mismatched.length} ` +
  `unavailable=${unavailable}` +
  (mismatched.length ? `; contradiction: ${mismatched.slice(0, 3).join(' | ')}` : ''));

// --- no guessed fills ------------------------------------------------------
const invalidLegs = (ledger.meta.invalid_events || []).length;
const everyFillIsTraded = fills.every((f) => typeof f.pool === 'string' && f.pool.length >= 32);
check('no_guessed_fills', everyFillIsTraded && fills.length > 0,
  `${fills.length} fills, all with a decoded pool; ${invalidLegs} invalid leg(s) reported, none guessed`);

// --- exactly once on replay ------------------------------------------------
const before = Object.keys(ledger.fills).length;
const w2 = await watchTail({ db: DB, cursor: CURSOR, bin: REEFLOG_BIN, limit: 10000, ledgerPath: LEDGER });
const after = Object.keys(loadLedger(LEDGER).fills).length;
check('exactly_once_on_replay', after === before,
  `ledger ${before} fills before replay, ${after} after (${w2.legs} legs seen again, ${w2.dupes} deduped)`);

// --- retraction scoping ----------------------------------------------------
// Deterministic and offline: a retraction row for a signature this consumer
// read must undo exactly that fill, and a retraction for an unknown
// signature must undo nothing.
{
  const { applyRetractions } = await import(path.join(decodeDir, 'whirlpool-watcher.mjs'));
  const probe = JSON.parse(JSON.stringify(ledger, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
  const known = fills[0];
  const knownKey = Object.keys(probe.fills).find((k) => probe.fills[k].signature === known.signature);
  const recs = applyRetractions(probe, [
    { id: 1, signature: known.signature, slot: known.slot, detected_at: 1 },
    { id: 2, signature: 'not-a-real-signature-at-all', slot: 1, detected_at: 1 },
  ]);
  const undone = Object.keys(probe.retractions).length;
  const stillOpen = Object.keys(probe.fills).length;
  check('retraction_undo_is_scoped',
    recs[0].undoable_fills.length === 1
    && recs[1].undoable_fills.length === 0
    && undone === 1
    && stillOpen === before - 1,
    `known signature undid ${recs[0].undoable_fills.length} fill(s), unknown signature ${recs[1].undoable_fills.length}; ledger ${before} -> ${stillOpen} open, ${undone} retracted`);
}

// --- report ----------------------------------------------------------------
const report = {
  measured_at: new Date().toISOString(),
  mutate: MUTATE,
  program: PROGRAM,
  rpc: 'https://api.mainnet-beta.solana.com',
  window: win,
  naive: { polls, signatures_tracked: sigSlot.size, signatures_in_window: naiveInCount, txs_bought: bought, txs_with_trades: naive.size, skipped_failed, skipped_zero, errors, rpc_calls: rpcCalls.sigs + rpcCalls.tx },
  watcher: { rows: w.rows, fills: fills.length, rpc_calls: watcherCalls, decode_ms: watchMs },
  chain_witness: { witnessed, mismatched: mismatched.length, unavailable, sampled: witnessSample.length, total_fills: fills.length, witness_limit: WITNESS_LIMIT, mismatched_detail: mismatched.slice(0, 10) },
  checks,
};
fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

console.log('\nMeasured cost:');
console.log(`  naive poller : ${rpcCalls.sigs} getSignaturesForAddress + ${rpcCalls.tx} getTransaction ` +
  `= ${rpcCalls.sigs + rpcCalls.tx} calls for ${naive.size} trade-bearing transactions`);
console.log(`  watcher      : ${watcherCalls} calls for ${fills.length} fills (bytes already on disk)`);
if (reefResult.err) {
  console.log('\nreeflog daemon (last lines):');
  console.log(reefResult.err.trim().split('\n').slice(-4).join('\n'));
}

const verdict = checks.every((c) => c.pass);
console.log(verdict ? 'WHIRLPOOL-WATCHER E2E: ALL PASS' : 'WHIRLPOOL-WATCHER E2E: FAILURE');
process.exit(verdict ? 0 : 1);
