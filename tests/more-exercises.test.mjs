import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepCounter } from '../js/rep-counter.js';
import { scoreRep, summarize } from '../js/scoring.js';
import { EXERCISES } from '../js/exercises.js';

const P = (x, y, v = 1) => ({ x, y, v });
const curve = (n, top, bottom) =>
  Array.from({ length: n }, (_, i) => top - (top - bottom) * Math.sin((Math.PI * i) / (n - 1)));
const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

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

// 臀橋側面：肩 (100,300)、膝 (300,250)，髖往上抬
function bridgePose(hipY) {
  return { shoulder: P(100, 300), hip: P(200, hipY), knee: P(300, 240), ankle: P(300, 300), ear: P(80, 300), footIndex: P(320, 300) };
}

test('臀橋：key 是 360 − 髖角，畫面顯示髖角；抬起時 key 變小', () => {
  const ex = EXERCISES.bridge;
  const down = ex.measure(bridgePose(300));
  const up = ex.measure(bridgePose(270));
  near(ex.showKey(down.key), down.hip, 1e-9);
  assert.ok(down.hip < 150, `躺著髖角 ${down.hip}`);
  assert.ok(up.hip > 165, `抬起髖角 ${up.hip}`);
  assert.ok(up.key < down.key);
  assert.ok(ex.ready({ ...down, upAt: ex.upAngle }));
});

test('臀橋：用計次狀態機算得出一下', () => {
  const ex = EXERCISES.bridge;
  const c = new RepCounter({ downAngle: ex.downAngle, upAngle: ex.upAngle });
  c.start();
  const keys = curve(40, 225, 188); // 髖角 135° → 172° → 135°
  let rep = null;
  keys.forEach((k, i) => (rep = c.update(k, i * 40, { 膝角: 90 }) ?? rep));
  assert.ok(rep, '應該算一下');
  near(360 - rep.minAngle, 172, 0.5);
});

function bridgeRep({ top = 172, knee = 90, frames = 40 } = {}) {
  const keys = curve(frames, 225, 360 - top);
  return {
    minAngle: 360 - top,
    descentMs: (frames / 2) * 40,
    durationMs: frames * 40,
    frames: keys.map((k, i) => ({ t: i * 40, key: k, 膝角: knee })),
  };
}

test('臀橋評分：抬不夠高、腳太遠、腳太近各給不同提示', () => {
  const ex = EXERCISES.bridge;
  const good = scoreRep(ex, bridgeRep(), []);
  assert.equal(good.feedback, null);
  assert.ok(good.standard);
  const low = scoreRep(ex, bridgeRep({ top: 155 }), []);
  assert.equal(low.feedback.id, 'height');
  assert.equal(scoreRep(ex, bridgeRep({ knee: 125 }), []).feedback.feedback, '腳往屁股靠近一點');
  assert.equal(scoreRep(ex, bridgeRep({ knee: 55 }), []).feedback.feedback, '腳離屁股遠一點');
});

function situpRep({ top = 65, knee = 90, lowerMs = 1000 } = {}) {
  const keys = curve(40, 125, top);
  return { minAngle: top, descentMs: 800, durationMs: 800 + lowerMs, frames: keys.map((k, i) => ({ t: i * 40, key: k, 膝角: knee })) };
}

test('仰臥起坐評分：坐不夠高、直接倒下去、腳伸直各給不同提示', () => {
  const ex = EXERCISES.situp;
  assert.equal(scoreRep(ex, situpRep(), []).feedback, null);
  assert.equal(scoreRep(ex, situpRep({ top: 98 }), []).feedback.id, 'height');
  assert.equal(scoreRep(ex, situpRep({ lowerMs: 250 }), []).feedback.id, 'lower');
  assert.equal(scoreRep(ex, situpRep({ knee: 145 }), []).feedback.id, 'knee');
});

test('仰臥起坐：躺著時算預備姿勢，key 是肩–髖–膝夾角', () => {
  const ex = EXERCISES.situp;
  const m = ex.measure({ shoulder: P(100, 300), hip: P(200, 300), knee: P(260, 240), ankle: P(320, 300), ear: P(80, 300), footIndex: P(340, 300) });
  near(m.key, 135);
  assert.ok(m.torso < 5);
  assert.ok(ex.ready({ ...m, upAt: ex.upAngle }));
});

test('靠牆深蹲：膝角 90°、背貼牆算正確；蹲太高、背離牆各給提示', () => {
  const ex = EXERCISES.wallsit;
  assert.ok(ex.holdGood({ key: 92, lean: 5 }));
  assert.ok(!ex.holdGood({ key: 130, lean: 5 }));
  assert.equal(ex.holdFeedback({ key: 130, lean: 5 }).id, 'high');
  assert.equal(ex.holdFeedback({ key: 92, lean: 30 }).id, 'back');
  assert.equal(ex.holdFeedback({ key: 60, lean: 5 }).id, 'low');
  // 側面量：髖 (100,300)、膝 (200,300)、踝 (200,400) → 膝角 90°
  const m = ex.measure({ shoulder: P(100, 150), hip: P(100, 300), knee: P(200, 300), ankle: P(200, 400), ear: P(100, 120), footIndex: P(230, 400) });
  near(m.key, 90);
  near(m.lean, 0);
  assert.ok(ex.holdGood(m));
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
  const ex = EXERCISES.bridge;
  const rs = [bridgeRep(), bridgeRep({ knee: 125 }), bridgeRep({ knee: 125 }), bridgeRep({ top: 155 })].map((r) => scoreRep(ex, r, []));
  const s = summarize(rs);
  assert.equal(s.issues[0].label, '膝蓋角度');
  assert.equal(s.issues[0].times, 2);
  assert.equal(s.issues[0].feedback, '腳往屁股靠近一點');
  assert.ok(s.issues[0].tip.includes('90 度'));
  assert.equal(s.topIssue.id, 'knee');
});
