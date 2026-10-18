import { test } from 'node:test';
import assert from 'node:assert/strict';
import { angle, angleFromVertical, angleFromHorizontal, viewAngle, weight3D, blendMeasures, LM } from '../js/pose-math.js';
import { EXERCISES } from '../js/exercises.js';

// 模擬手機沒有正對側面：把 3D 姿勢繞垂直軸（y）轉 θ 度。
// 3D 算的角度應該不變；只用 2D（丟掉 z，等於投影到畫面）算的角度會跑掉。
const rotY = (p, deg) => {
  const t = (deg * Math.PI) / 180;
  return { x: p.x * Math.cos(t) + p.z * Math.sin(t), y: p.y, z: -p.x * Math.sin(t) + p.z * Math.cos(t), v: 1 };
};
const rotate = (j, deg) => Object.fromEntries(Object.entries(j).map(([k, p]) => [k, rotY(p, deg)]));
const flat = (j) => Object.fromEntries(Object.entries(j).map(([k, p]) => [k, { x: p.x, y: p.y, v: 1 }]));

// 深蹲最低點、正側面（身體朝 +x，y 向下，單位公尺）
const squatBottom = {
  ear: { x: 0.05, y: -0.62, z: 0.08 },
  shoulder: { x: 0.12, y: -0.48, z: 0.1 },
  elbow: { x: 0.3, y: -0.4, z: 0.1 },
  wrist: { x: 0.5, y: -0.42, z: 0.1 },
  hip: { x: 0, y: 0, z: 0.1 },
  knee: { x: 0.42, y: 0.02, z: 0.12 },
  ankle: { x: 0.3, y: 0.42, z: 0.12 },
  heel: { x: 0.25, y: 0.47, z: 0.12 },
  footIndex: { x: 0.45, y: 0.47, z: 0.13 },
};

for (const deg of [0, 30, 45, 60]) {
  test(`拍攝角度 ${deg}°：3D 膝角、軀幹前傾、大腿角度與正側面相同`, () => {
    const base = EXERCISES.squat.measure(squatBottom);
    const m = EXERCISES.squat.measure(rotate(squatBottom, deg));
    assert.ok(Math.abs(m.key - base.key) < 1e-6);
    for (const k of Object.keys(base.extra)) assert.ok(Math.abs(m.extra[k] - base.extra[k]) < 1e-6, k);
  });
}

test('對照：只用 2D 時，偏 60° 膝角與軀幹前傾都會明顯跑掉', () => {
  const two = (j) => ({
    knee: angle(j.hip, j.knee, j.ankle),
    lean: angleFromVertical(j.hip, j.shoulder),
  });
  const a0 = two(flat(squatBottom));
  const a60 = two(flat(rotate(squatBottom, 60)));
  // 這組姿勢：2D 膝角 76° → 86.5°，2D 軀幹前傾 14° → 7.1°
  assert.ok(Math.abs(a60.knee - a0.knee) > 8, `膝角 ${a0.knee.toFixed(1)} → ${a60.knee.toFixed(1)}`);
  assert.ok(Math.abs(a60.lean - a0.lean) > 5, `前傾 ${a0.lean.toFixed(1)} → ${a60.lean.toFixed(1)}`);
});

test('angleFromVertical / angleFromHorizontal 在 3D 下不受水平旋轉影響', () => {
  const a = { x: 0, y: 0, z: 0 }, b = { x: 0.3, y: -0.4, z: 0 };
  for (const deg of [0, 45, 90]) {
    const rb = rotY(b, deg);
    assert.ok(Math.abs(angleFromVertical(a, rb) - angleFromVertical(a, b)) < 1e-9);
    assert.ok(Math.abs(angleFromHorizontal(a, rb) - angleFromHorizontal(a, b)) < 1e-9);
  }
});

test('viewAngle：正側面約 0°，轉 45° 約 45°，正面約 90°', () => {
  const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  // 正側面：左右肩、左右髖的連線指向鏡頭（z 方向）
  world[LM.leftShoulder] = { x: 0, y: -0.5, z: -0.18 };
  world[LM.rightShoulder] = { x: 0, y: -0.5, z: 0.18 };
  world[LM.leftHip] = { x: 0, y: 0, z: -0.12 };
  world[LM.rightHip] = { x: 0, y: 0, z: 0.12 };
  const at = (deg) => viewAngle(world.map((p) => rotY(p, deg)));
  assert.ok(at(0) < 1);
  assert.ok(Math.abs(at(45) - 45) < 1);
  assert.ok(at(90) > 89);
});

test('weight3D：正側面用 2D，偏 45° 以上用 3D，中間過渡', () => {
  assert.equal(weight3D(0), 0);
  assert.equal(weight3D(15), 0);
  assert.equal(weight3D(30), 0.5);
  assert.equal(weight3D(60), 1);
  assert.equal(weight3D(null), 0);
});

test('blendMeasures：數值依比例混合，可見度與布林值沿用 2D', () => {
  const m2 = { key: 100, visibility: 0.9, upright: true, extra: { a: 10 } };
  const m3 = { key: 80, visibility: 0.2, upright: false, extra: { a: 30 } };
  const m = blendMeasures(m2, m3, 0.5);
  assert.equal(m.key, 90);
  assert.equal(m.extra.a, 20);
  assert.equal(m.visibility, 0.9);
  assert.equal(m.upright, true);
  assert.equal(blendMeasures(m2, m3, 0), m2);
});
