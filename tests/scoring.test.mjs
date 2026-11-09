import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linear, scoreRep, summarize } from '../js/scoring.js';
import { dtwDistance, dtwScore, resample } from '../js/dtw.js';
import { EXERCISES } from '../js/exercises.js';

const curve = (n, top, bottom) =>
  Array.from({ length: n }, (_, i) => top - (top - bottom) * Math.sin((Math.PI * i) / (n - 1)));

// 模擬一下深蹲：frames 是每一幀的膝角與軀幹前傾，時間 33ms 一幀
function squatRep({ bottom = 85, maxLean = 30, frames = 45, descentShare = 0.5 } = {}) {
  const knee = curve(frames, 165, bottom);
  const lean = curve(frames, 8, maxLean);
  return {
    minAngle: bottom,
    descentMs: frames * 33 * descentShare,
    frames: knee.map((k, i) => ({ t: i * 33, key: k, 軀幹前傾: lean[i] })),
  };
}

test('linear：越接近 full 分數越高，兩個方向都可以', () => {
  assert.equal(linear(90, 90, 125), 1);
  assert.equal(linear(125, 90, 125), 0);
  assert.equal(linear(107.5, 90, 125), 0.5);
  assert.equal(linear(80, 90, 125), 1);
  assert.equal(linear(170, 165, 140), 1);
  assert.equal(linear(NaN, 1, 0), 0);
});

test('DTW：同一條曲線距離為 0；只是速度不同距離很小；深度不同距離變大', () => {
  const a = curve(30, 170, 85).map((v) => [v]);
  const slow = curve(60, 170, 85).map((v) => [v]);
  const shallow = curve(30, 170, 120).map((v) => [v]);
  assert.equal(dtwDistance(a, a), 0);
  const dSlow = dtwDistance(resample(a), resample(slow));
  const dShallow = dtwDistance(resample(a), resample(shallow));
  assert.ok(dSlow < 1, `速度不同 ${dSlow}`);
  assert.ok(dShallow > 10, `深度不同 ${dShallow}`);
  assert.equal(Math.round(dtwScore(a, [a]).score), 100);
  assert.equal(dtwScore(a, []), null);
});

test('深蹲評分：標準的一下高分、沒有回饋', () => {
  const ex = EXERCISES.squat;
  const r = scoreRep(ex, squatRep(), [ex.defaultTemplate()]);
  assert.ok(r.score >= 90, `分數 ${r.score}`);
  assert.equal(r.feedback, null);
});

test('深蹲評分：蹲不夠深 → 提示「再蹲低一點」，分數較低', () => {
  const ex = EXERCISES.squat;
  const good = scoreRep(ex, squatRep(), [ex.defaultTemplate()]);
  const shallow = scoreRep(ex, squatRep({ bottom: 118 }), [ex.defaultTemplate()]);
  assert.equal(shallow.feedback.id, 'depth');
  assert.equal(shallow.feedback.feedback, '再蹲低一點');
  assert.ok(shallow.score < good.score - 20, `${good.score} vs ${shallow.score}`);
});

test('深蹲評分：上半身太前傾 → 提示「胸口挺起來」；太快 → 提示「下蹲慢一點」', () => {
  const ex = EXERCISES.squat;
  assert.equal(scoreRep(ex, squatRep({ maxLean: 68 }), []).feedback.id, 'lean');
  assert.equal(scoreRep(ex, squatRep({ frames: 14 }), []).feedback.id, 'tempo');
});

test('伏地挺身評分：塌腰 → 提示保持一直線', () => {
  const ex = EXERCISES.pushup;
  const elbow = curve(40, 165, 85);
  const rep = (line) => ({
    minAngle: 85,
    descentMs: 700,
    frames: elbow.map((e, i) => ({ t: i * 33, key: e, 身體直線: line })),
  });
  const good = scoreRep(ex, rep(175), [ex.defaultTemplate()]);
  const sag = scoreRep(ex, rep(145), [ex.defaultTemplate()]);
  assert.equal(good.feedback, null);
  assert.equal(sag.feedback.id, 'line');
  assert.ok(sag.score < good.score);
});

test('沒有模板時只用規則分', () => {
  const ex = EXERCISES.squat;
  const r = scoreRep(ex, squatRep(), []);
  assert.equal(r.dtwScore, null);
  assert.equal(r.score, r.ruleScore);
});

test('summarize：平均分數與最常見的錯誤', () => {
  const ex = EXERCISES.squat;
  const rs = [squatRep(), squatRep({ bottom: 118 }), squatRep({ bottom: 120 })].map((r) => scoreRep(ex, r, []));
  const s = summarize(rs);
  assert.equal(s.count, 3);
  assert.equal(s.topIssue.id, 'depth');
  assert.equal(s.topIssue.times, 2);
  assert.equal(summarize([]).avg, null);
});
