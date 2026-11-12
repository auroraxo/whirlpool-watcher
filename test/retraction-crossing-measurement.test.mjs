// Pin test for research/retraction-crossing-{prefix,fixed}-2026-11-12.json.
//
// The measurement tool (tools/measure-retraction-crossing.mjs) runs against
// both trees. This test pins the committed artifact literals, proves the
// ladder, and falsifies individual fields so a hand-edited artifact is
// refused.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PREFIX_PATH = path.join(ROOT, 'research', 'retraction-crossing-prefix-2026-11-12.json');
const FIXED_PATH = path.join(ROOT, 'research', 'retraction-crossing-fixed-2026-11-12.json');

const prefix = JSON.parse(fs.readFileSync(PREFIX_PATH, 'utf8'));
const fixed = JSON.parse(fs.readFileSync(FIXED_PATH, 'utf8'));

test('P1: the pre-fix artifact records exactly the three defect faces', () => {
  assert.equal(prefix.verdict, 'violations');
  assert.equal(prefix.summary.faces_violated, 3);
  assert.equal(prefix.summary.faces_total, 3);
  assert.deepEqual(prefix.summary.violated_faces, [
    'Y1_cli_retract_cursor_crosses_before_event',
    'Y2_webhook_reorg_before_event',
    'Y3_verdict_is_durable_not_counter_only',
  ]);
  assert.equal(prefix.summary.guards_violated, 0);
  assert.equal(prefix.summary.guards_total, 3);
  // Defect face Y1: the pre-fix CLI left the fill OPEN
  const y1 = prefix.faces.find((f) => f.face === 'Y1_cli_retract_cursor_crosses_before_event');
  assert.equal(y1.open_fills, 1);
  assert.equal(y1.retractions, 0);
  // Defect face Y2: the pre-fix webhook left the fill OPEN
  const y2 = prefix.faces.find((f) => f.face === 'Y2_webhook_reorg_before_event');
  assert.equal(y2.open_fills, 1);
  assert.equal(y2.retractions, 0);
});

test('P2: the fixed artifact closes every defect face cleanly', () => {
  assert.equal(fixed.verdict, 'clean');
  assert.equal(fixed.summary.faces_violated, 0);
  assert.equal(fixed.summary.faces_total, 3);
  assert.deepEqual(fixed.summary.violated_faces, []);
  assert.equal(fixed.summary.guards_violated, 0);
  assert.equal(fixed.summary.guards_total, 3);
  // Face Y1: fixed tree puts the fill in retractions, open_fills=0
  const y1 = fixed.faces.find((f) => f.face === 'Y1_cli_retract_cursor_crosses_before_event');
  assert.equal(y1.open_fills, 0);
  assert.equal(y1.retractions, 1);
  assert.equal(y1.tail_report.retraction_first_ignored, 1);
  // Face Y2: fixed tree puts the fill in retractions, open_fills=0
  const y2 = fixed.faces.find((f) => f.face === 'Y2_webhook_reorg_before_event');
  assert.equal(y2.open_fills, 0);
  assert.equal(y2.retractions, 1);
});

test('P3: both artifacts prove the same three guards hold without moving', () => {
  for (const [name, doc] of [['prefix', prefix], ['fixed', fixed]]) {
    assert.equal(doc.guards.length, 3, `${name} has 3 guards`);
    assert.ok(doc.guards.every((g) => !g.violated), `${name} guards must be clean`);
    const gNames = doc.guards.map((g) => g.face).sort();
    assert.deepEqual(gNames, [
      'G1_in_order_unchanged',
      'G2_scoped_undo_unchanged',
      'G3_dedup_unchanged',
    ]);
  }
});

test('P4: no host paths or ephemeral temp dirs leak into the artifacts', () => {
  for (const [name, doc] of [['prefix', prefix], ['fixed', fixed]]) {
    const raw = JSON.stringify(doc);
    assert.ok(!raw.includes('/home/aurora'), `${name} leaks home directory`);
    assert.ok(!raw.includes('/tmp/ww-'), `${name} leaks scratch directory`);
  }
});

test('P5 (falsification): tampering with a fixed artifact face fails the pin', () => {
  const tampered = JSON.parse(JSON.stringify(fixed));
  tampered.summary.faces_violated = 1;
  assert.throws(() => {
    assert.equal(tampered.summary.faces_violated, 0);
  });
});
