import { test } from 'node:test';
import assert from 'node:assert/strict';
import { angle, angleFromVertical, Smoother, HoldTimer, placement } from '../js/pose-math.js';
import { EXERCISES } from '../js/exercises.js';
import { RepCounter } from '../js/rep-counter.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('angle：直角、直線、銳角', () => {
  near(angle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }), 90);
  near(angle({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 180);
  near(angle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }), 45);
  assert.ok(Number.isNaN(angle({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })));
});

test('angleFromVertical：直立為 0，水平為 90', () => {
  near(angleFromVertical({ x: 0, y: 10 }, { x: 0, y: 0 }), 0);
  near(angleFromVertical({ x: 0, y: 0 }, { x: 10, y: 0 }), 90);
});

test('Smoother：第一個值直接採用，之後做平均，NaN 不影響', () => {
  const s = new Smoother(0.5);
  assert.equal(s.update('k', 100), 100);
  assert.equal(s.update('k', 80), 90);
  assert.equal(s.update('k', NaN), 90);
});

// 產生一段模擬的角度序列：站直 → 蹲下到 minAngle → 站起，每幀 33ms
function rep(minAngle, frames = 30) {
  const out = [];
  for (let i = 0; i <= frames; i++) {
    const phase = Math.sin((Math.PI * i) / frames); // 0 → 1 → 0
    out.push(170 - (170 - minAngle) * phase);
  }
  return out;
}

function run(counter, angles, t0 = 0) {
  const reps = [];
  angles.forEach((a, i) => {
    const r = counter.update(a, t0 + i * 33);
    if (r) reps.push(r);
  });
  return reps;
}

test('RepCounter：三下標準深蹲計為 3 次，最低角度正確', () => {
  const c = new RepCounter({ downAngle: 100, upAngle: 160 });
  const seq = [170, 170, ...rep(80), ...rep(85), ...rep(90)];
  const reps = run(c, seq);
  assert.equal(c.count, 3);
  assert.equal(reps.length, 3);
  assert.ok(Math.abs(reps[0].minAngle - 80) < 1);
  assert.ok(reps[0].durationMs > 0 && reps[0].descentMs > 0);
});

test('RepCounter：蹲不夠深（沒到 downAngle）不算', () => {
  const c = new RepCounter({ downAngle: 100, upAngle: 160 });
  run(c, [170, ...rep(120), ...rep(110)]);
  assert.equal(c.count, 0);
});

test('RepCounter：在門檻附近抖動不會重複計次', () => {
  const c = new RepCounter({ downAngle: 100, upAngle: 160 });
  const jitter = [170, 140, 99, 101, 98, 102, 99, 130, 158, 162, 159, 161, 170];
  const spread = jitter.flatMap((a) => Array(3).fill(a));
  run(c, spread);
  assert.equal(c.count, 1);
});

test('RepCounter：還沒站直前不開始計次', () => {
  const c = new RepCounter({ downAngle: 100, upAngle: 160 });
  run(c, [90, 90, 150, 165]);
  assert.equal(c.count, 0);
  assert.equal(c.state, 'up');
});

test('RepCounter：太快的晃動（小於 minRepMs）不算', () => {
  const c = new RepCounter({ downAngle: 100, upAngle: 160, minRepMs: 400 });
  run(c, [170, 150, 90, 170]); // 約 100ms
  assert.equal(c.count, 0);
});

test('RepCounter：cancel 後要先回到「上」才會開始下一下', () => {
  const c = new RepCounter({ downAngle: 100, upAngle: 160 });
  c.start();
  run(c, [150, 120, 95]); // 蹲到一半姿勢跑掉
  c.cancel();
  run(c, [90, 120, 165], 1000); // 從底部直接站起來，不算
  assert.equal(c.count, 0);
  run(c, rep(85), 2000); // 之後完整的一下才算
  assert.equal(c.count, 1);
});

test('HoldTimer：要連續成立才觸發，中斷就重算', () => {
  const t = new HoldTimer(1000);
  assert.equal(t.update(true, 0), false);
  assert.equal(t.update(true, 900), false);
  assert.equal(t.update(false, 950), false);
  assert.equal(t.update(true, 1000), false);
  assert.equal(t.update(true, 2000), true);
});

// 側面站立的關節點（像素），scale 用來模擬走近或走遠鏡頭
function standing({ x = 300, scale = 1 } = {}) {
  const p = (dx, y) => ({ x: x + dx * scale, y: 100 + y * scale, v: 1 });
  return {
    ear: p(0, -40), shoulder: p(0, 0), elbow: p(0, 80), wrist: p(0, 150),
    hip: p(0, 160), knee: p(0, 320), ankle: p(0, 480), heel: p(-10, 490), footIndex: p(30, 490),
  };
}

test('placement：在框內為 ok，太近、太遠、偏出框都會判斷出來', () => {
  const box = { x: 150, y: 20, w: 300, h: 600 };
  const opts = { axis: 'v', fillRange: [0.45, 0.85] };
  // standing() 的 bodyScale = 480，框高 600 → fill 0.8
  assert.equal(placement(standing({ x: 300 }), box, opts).status, 'ok');
  assert.equal(placement(standing({ x: 300, scale: 1.4 }), box, opts).status, 'tooClose');
  assert.equal(placement(standing({ x: 300, scale: 0.5 }), box, opts).status, 'tooFar');
  const off = placement(standing({ x: 480 }), box, opts);
  assert.equal(off.status, 'off');
  assert.equal(off.dx, -1, '人在框右邊外面，要往左移');
});

test('深蹲：站直才算預備姿勢，躺著或彎腰不算', () => {
  const ex = EXERCISES.squat;
  const m = ex.measure(standing());
  assert.ok(ex.ready(m) && ex.valid(m));

  // 彎腰撿手機：上半身幾乎水平
  const bend = standing();
  bend.shoulder = { x: bend.hip.x + 150, y: bend.hip.y + 10, v: 1 };
  assert.ok(!ex.valid(ex.measure(bend)));
});

test('伏地挺身：身體水平且手臂打直才算預備姿勢；站著不算', () => {
  const ex = EXERCISES.pushup;
  const p = (x, y) => ({ x, y, v: 1 });
  const plank = {
    ear: p(80, 300), shoulder: p(100, 310), elbow: p(100, 380), wrist: p(100, 450),
    hip: p(260, 330), knee: p(380, 345), ankle: p(500, 360), heel: p(505, 350), footIndex: p(500, 380),
  };
  const m = ex.measure(plank);
  assert.ok(ex.ready(m) && ex.valid(m));
  assert.ok(!ex.valid(ex.measure(standing())), '站著時不是伏地挺身');
});
