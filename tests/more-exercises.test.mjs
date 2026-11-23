import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRep, summarize } from '../js/scoring.js';
import { EXERCISES } from '../js/exercises.js';

const P = (x, y, v = 1) => ({ x, y, v });
const curve = (n, top, bottom) =>
  Array.from({ length: n }, (_, i) => top - (top - bottom) * Math.sin((Math.PI * i) / (n - 1)));

test('每個動作都有首頁卡片與預設目標', () => {
  for (const [id, ex] of Object.entries(EXERCISES)) {
    assert.ok(ex.card?.image && ex.card.chip && ex.card.desc, id);
    assert.ok(ex.target > 0, id);
  }
});

test('每條規則都有教練說明（tip）', () => {
  for (const [id, ex] of Object.entries(EXERCISES)) {
    for (const r of ex.rules ?? []) assert.ok(r.tip?.length > 10, `${id}.${r.id}`);
  }
});

test('伏地挺身：身體沒打直時分辨塌腰和翹臀', () => {
  const ex = EXERCISES.pushup;
  const elbow = curve(40, 165, 85);
  const rep = (drop) => ({
    minAngle: 85,
    descentMs: 700,
    durationMs: 1400,
    frames: elbow.map((e, i) => ({ t: i * 33, key: e, 身體直線: 145, hipDrop: drop })),
  });
  assert.equal(scoreRep(ex, rep(0.08), []).feedback.feedback, '腰塌下去了，收緊肚子和屁股');
  assert.equal(scoreRep(ex, rep(-0.08), []).feedback.feedback, '屁股翹太高，身體壓成一直線');
  // 伏地挺身的 measure 會帶出塌腰程度（不顯示在畫面上，給評分用）
  const m = ex.measure({ shoulder: P(100, 100), elbow: P(100, 140), wrist: P(100, 180), hip: P(200, 120), ankle: P(300, 100), knee: P(250, 110), ear: P(80, 95), footIndex: P(310, 105) });
  assert.ok(m.track.hipDrop > 0);
  assert.equal(m.extra.hipDrop, undefined);
});

test('summarize：問題清單帶出最常講的提示與教練說明', () => {
  const ex = EXERCISES.pushup;
  const elbow = curve(40, 165, 85);
  const rep = (line, drop) => ({ minAngle: 85, descentMs: 700, durationMs: 1400, frames: elbow.map((e, i) => ({ t: i * 33, key: e, 身體直線: line, hipDrop: drop })) });
  const rs = [rep(175, 0), rep(145, 0.08), rep(145, 0.08), rep(145, -0.08)].map((r) => scoreRep(ex, r, []));
  const s = summarize(rs);
  assert.equal(s.issues[0].label, '身體直線');
  assert.equal(s.issues[0].times, 3);
  assert.equal(s.issues[0].feedback, '腰塌下去了，收緊肚子和屁股');
  assert.ok(s.issues[0].tip.includes('一直線'));
  assert.equal(s.topIssue.id, 'line');
});
