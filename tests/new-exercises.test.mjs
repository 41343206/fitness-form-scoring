import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sideJoints, hipDrop, LM } from '../js/pose-math.js';
import { HoldTracker } from '../js/rep-counter.js';
import { scoreRep } from '../js/scoring.js';
import { EXERCISES } from '../js/exercises.js';

const P = (x, y, v = 1) => ({ x, y, v });
const curve = (n, top, bottom) =>
  Array.from({ length: n }, (_, i) => top - (top - bottom) * Math.sin((Math.PI * i) / (n - 1)));

test('sideJoints：同時取出另一隻腳（knee2 等）', () => {
  const lms = Array.from({ length: 33 }, (_, i) => ({ x: i, y: i, visibility: 1 }));
  const j = sideJoints(lms, 'left', 1, 1);
  assert.equal(j.knee.x, LM.leftKnee);
  assert.equal(j.knee2.x, LM.rightKnee);
  assert.equal(j.ankle2.x, LM.rightAnkle);
});

test('HoldTracker：累計正確時間，跳過不在定位的時間，卡頓只算上限', () => {
  const h = new HoldTracker(250);
  h.start(0);
  for (let t = 100; t <= 1000; t += 100) h.update(true, t); // 1 秒正確
  for (let t = 1100; t <= 2000; t += 100) h.update(false, t); // 1 秒錯誤
  h.skip(5000); // 離開框 3 秒，不算
  h.update(true, 5100);
  h.update(true, 8000); // 卡頓 2.9 秒，只算 250ms
  assert.equal(h.goodMs, 1000 + 100 + 250);
  assert.equal(h.totalMs, 2000 + 100 + 250);
  assert.equal(h.percent(), Math.round((100 * 1350) / 2350));
});

// 棒式側面：肩 (100,100)、踝 (300,100)，髖的高度決定塌腰或翹臀
function plank(hipY) {
  return {
    shoulder: P(100, 100), elbow: P(100, 140), hip: P(200, hipY), ankle: P(300, 100),
    ear: P(80, 95), knee: P(250, 100), footIndex: P(310, 105),
  };
}

test('hipDrop：髖在肩–踝連線下方為正（塌腰），上方為負（翹臀）', () => {
  assert.ok(Math.abs(hipDrop(plank(100))) < 1e-9);
  assert.ok(hipDrop(plank(130)) > 0);
  assert.ok(hipDrop(plank(70)) < 0);
});

test('棒式：直線算正確；塌腰、翹臀各給不同提示', () => {
  const ex = EXERCISES.plank;
  const straight = ex.measure(plank(102));
  assert.ok(ex.ready(straight) && ex.valid(straight) && ex.holdGood(straight));

  const sag = ex.measure(plank(130));
  assert.ok(ex.valid(sag) && !ex.holdGood(sag));
  assert.equal(ex.holdFeedback(sag), '核心收緊，不要塌腰');

  const pike = ex.measure(plank(65));
  assert.ok(!ex.holdGood(pike));
  assert.equal(ex.holdFeedback(pike), '臀部放低一點');

  // 站著（肩到踝是垂直的）不算棒式
  const standing = ex.measure({ ...plank(100), shoulder: P(200, 0), hip: P(200, 100), ankle: P(200, 200), elbow: P(200, 50) });
  assert.ok(!ex.valid(standing));
});

// 弓箭步側面：髖 (200,200)，一隻腳往前、一隻往後，膝角分別是 frontDeg、backDeg
function lunge(frontDeg, backDeg, frontIsMain = true) {
  const hip = P(200, 200);
  const leg = (dir, deg) => {
    const knee = P(200 + dir * 60, 280);
    // 膝→髖的方向轉 deg 度就是膝→踝的方向（往下轉）
    const a = Math.atan2(hip.y - knee.y, hip.x - knee.x) + dir * (deg * Math.PI) / 180;
    return { knee, ankle: P(knee.x + 100 * Math.cos(a), knee.y + 100 * Math.sin(a)) };
  };
  const f = leg(1, frontDeg), b = leg(-1, backDeg);
  const [m, o] = frontIsMain ? [f, b] : [b, f];
  return {
    ear: P(200, 50), shoulder: P(200, 80), hip,
    knee: m.knee, ankle: m.ankle, footIndex: P(m.ankle.x + 20, m.ankle.y),
    hip2: hip, knee2: o.knee, ankle2: o.ankle, footIndex2: P(o.ankle.x - 20, o.ankle.y),
  };
}

test('弓箭步：前膝取兩腳中彎比較多的那隻，不管哪隻腳在前', () => {
  const ex = EXERCISES.lunge;
  for (const frontIsMain of [true, false]) {
    const m = ex.measure(lunge(90, 110, frontIsMain));
    assert.ok(Math.abs(m.key - 90) < 1e-6, `前膝 ${m.key}`);
    assert.ok(Math.abs(m.extra.後膝 - 110) < 1e-6, `後膝 ${m.extra.後膝}`);
    assert.ok(m.upright && ex.valid(m) && !ex.ready(m));
  }
  // 站直（兩腳都直）才算預備姿勢
  assert.ok(ex.ready(ex.measure(lunge(175, 178))));
});

function lungeRep({ front = 90, back = 95, lean = 10, frames = 45 } = {}) {
  const f = curve(frames, 170, front), b = curve(frames, 170, back), l = curve(frames, 5, lean);
  return {
    minAngle: front,
    descentMs: frames * 33 * 0.5,
    frames: f.map((k, i) => ({ t: i * 33, key: k, 前膝: k, 後膝: b[i], 軀幹前傾: l[i] })),
  };
}

test('弓箭步評分：標準高分；前腳太淺、後膝沒下去各給提示', () => {
  const ex = EXERCISES.lunge;
  const good = scoreRep(ex, lungeRep(), [ex.defaultTemplate()]);
  assert.ok(good.score >= 85, `標準動作 ${good.score}`);
  assert.equal(good.feedback, null);

  const shallow = scoreRep(ex, lungeRep({ front: 125 }), [ex.defaultTemplate()]);
  assert.equal(shallow.feedback.feedback, '前腳再蹲低一點');
  assert.ok(shallow.score < good.score - 20);

  const backHigh = scoreRep(ex, lungeRep({ back: 140 }), [ex.defaultTemplate()]);
  assert.equal(backHigh.feedback.feedback, '後腳膝蓋再往下');
});
