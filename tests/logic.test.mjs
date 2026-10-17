import { test } from 'node:test';
import assert from 'node:assert/strict';
import { angle, angleFromVertical, Smoother } from '../js/pose-math.js';
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
