// 關節點編號（MediaPipe Pose Landmarker，33 點）
export const LM = {
  nose: 0,
  leftEar: 7, rightEar: 8,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftHeel: 29, rightHeel: 30,
  leftFootIndex: 31, rightFootIndex: 32,
};

// 每一側會用到的關節名稱（不含 left/right 前綴）
const SIDE_JOINTS = ['Ear', 'Shoulder', 'Elbow', 'Wrist', 'Hip', 'Knee', 'Ankle', 'Heel', 'FootIndex'];

// 取得某一側的關節點，座標換成像素，避免畫面長寬比讓角度失真
export function sideJoints(landmarks, side, width, height) {
  const out = {};
  for (const name of SIDE_JOINTS) {
    const p = landmarks[LM[side + name]];
    out[name[0].toLowerCase() + name.slice(1)] = {
      x: p.x * width,
      y: p.y * height,
      v: p.visibility ?? 1,
    };
  }
  return out;
}

// 同一側的 3D 世界座標（MediaPipe worldLandmarks，單位公尺，原點在兩髖中點，
// 軸向和畫面一致：x 向右、y 向下、z 朝鏡頭外）。
// 3D 角度不會因為手機沒有正對側面而變形；拍攝角度偏的時候改用這組座標算（見 weight3D）。
// 可見度沿用 2D 關節點的值。
export function worldJoints(world, landmarks, side) {
  const out = {};
  for (const name of SIDE_JOINTS) {
    const i = LM[side + name];
    const p = world[i];
    out[name[0].toLowerCase() + name.slice(1)] = {
      x: p.x,
      y: p.y,
      z: p.z,
      v: landmarks[i].visibility ?? p.visibility ?? 1,
    };
  }
  return out;
}

// 拍攝角度：0° = 正側面，90° = 正面或背面。
// 用左右肩、左右髖的連線方向判斷：正側面時這條線指向鏡頭（z 方向），正面時是左右方向（x 方向）。
export function viewAngle(world) {
  const axis = (l, r) => ({ x: world[r].x - world[l].x, z: world[r].z - world[l].z });
  const s = axis(LM.leftShoulder, LM.rightShoulder);
  const h = axis(LM.leftHip, LM.rightHip);
  const x = Math.abs(s.x) + Math.abs(h.x);
  const z = Math.abs(s.z) + Math.abs(h.z);
  return (Math.atan2(x, z) * 180) / Math.PI;
}

// 2D 與 3D 角度的混合比例。
// 正側面時 2D 最準（MediaPipe 的深度 z 是估計值，會有誤差）；拍攝角度越偏，2D 投影變形越大，改用 3D。
// 拍攝角度 ≤ 15° 全用 2D，≥ 45° 全用 3D，中間線性過渡。
export function weight3D(view, from = 15, to = 45) {
  if (view === null || view === undefined || !Number.isFinite(view)) return 0;
  return Math.min(1, Math.max(0, (view - from) / (to - from)));
}

// 把兩次 measure 的結果依比例混合：數值欄位（含 extra）取加權平均，
// 其他欄位（可見度、上下位置的判斷）沿用 2D 的結果
export function blendMeasures(m2, m3, w) {
  if (!m3 || w <= 0) return m2;
  const mix = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? (1 - w) * a + w * b : a);
  const out = { ...m2, extra: { ...m2.extra } };
  for (const [k, v] of Object.entries(m2)) {
    if (k !== 'visibility' && typeof v === 'number') out[k] = mix(v, m3[k]);
  }
  for (const k of Object.keys(out.extra)) out.extra[k] = mix(m2.extra[k], m3.extra?.[k]);
  return out;
}

// 側拍時選擇比較靠近鏡頭（可見度較高）的那一側
export function pickSide(landmarks) {
  const avg = (side) => {
    const names = ['Shoulder', 'Elbow', 'Hip', 'Knee', 'Ankle'];
    return names.reduce((s, n) => s + (landmarks[LM[side + n]].visibility ?? 1), 0) / names.length;
  };
  return avg('left') >= avg('right') ? 'left' : 'right';
}

// a-b-c 在 b 點的夾角（度）；有 z 就算 3D 夾角
export function angle(a, b, c) {
  const abx = a.x - b.x, aby = a.y - b.y, abz = (a.z ?? 0) - (b.z ?? 0);
  const cbx = c.x - b.x, cby = c.y - b.y, cbz = (c.z ?? 0) - (b.z ?? 0);
  const dot = abx * cbx + aby * cby + abz * cbz;
  const mag = Math.hypot(abx, aby, abz) * Math.hypot(cbx, cby, cbz);
  if (mag === 0) return NaN;
  const cos = Math.min(1, Math.max(-1, dot / mag));
  return (Math.acos(cos) * 180) / Math.PI;
}

// a→b 連線與垂直線的夾角（度），0 = 完全直立；有 z 就把前後方向也算進水平分量，
// 所以人繞著垂直軸轉（手機沒對準側面）時結果不變
export function angleFromVertical(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = (b.z ?? 0) - (a.z ?? 0);
  return (Math.atan2(Math.hypot(dx, dz), Math.abs(dy)) * 180) / Math.PI;
}

// a→b 連線與水平線的夾角（度），0 = 完全水平
export function angleFromHorizontal(a, b) {
  return 90 - angleFromVertical(a, b);
}

// 身體大小：軀幹＋大腿＋小腿長度總和。深蹲時身體折起來，這個值也幾乎不變，
// 所以可以拿來判斷人有沒有走近或走遠鏡頭
export function bodyScale(j) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return d(j.shoulder, j.hip) + d(j.hip, j.knee) + d(j.knee, j.ankle);
}

// 判斷人是否站在定位框內。
// box：{ x, y, w, h }（像素）；axis：身體沿哪個方向延伸（'v' 站立、'h' 趴著）；
// fillRange：身體大小（bodyScale）佔框長邊的合理範圍。
// joints：哪些關節要在框內（深蹲時手可能往前伸，不一定要算進去）。
// 回傳 status：
//   'ok'        在框內、大小剛好
//   'tooClose'  太靠近鏡頭（身體比框大）
//   'tooFar'    離鏡頭太遠（身體太小）
//   'off'       有部分身體跑出框外，dx / dy 是要移動的方向（以畫面座標，-1 / 0 / 1）
export function placement(j, box, { axis = 'v', fillRange = [0.5, 0.9], margin = 0.04, joints = Object.keys(j) } = {}) {
  const pts = joints.map((name) => j[name]);
  const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
  const fill = bodyScale(j) / (axis === 'v' ? box.h : box.w);

  const mx = box.w * margin, my = box.h * margin;
  const outLeft = minX < box.x - mx, outRight = maxX > box.x + box.w + mx;
  const outTop = minY < box.y - my, outBottom = maxY > box.y + box.h + my;

  let status = 'ok';
  if (fill > fillRange[1] || (outLeft && outRight) || (outTop && outBottom)) status = 'tooClose';
  else if (outLeft || outRight || outTop || outBottom) status = 'off';
  else if (fill < fillRange[0]) status = 'tooFar';

  return {
    status,
    fill,
    dx: outLeft ? 1 : outRight ? -1 : 0,
    dy: outTop ? 1 : outBottom ? -1 : 0,
  };
}

export function minVisibility(...points) {
  return Math.min(...points.map((p) => p.v));
}

// 條件要連續成立 holdMs 才回傳 true；中間只要一幀不成立就重新計時
export class HoldTimer {
  constructor(holdMs) {
    this.holdMs = holdMs;
    this.since = null;
  }
  update(condition, timestamp) {
    if (!condition) {
      this.since = null;
      return false;
    }
    if (this.since === null) this.since = timestamp;
    return timestamp - this.since >= this.holdMs;
  }
  reset() {
    this.since = null;
  }
}

// 指數移動平均，用來減少關節點抖動
export class Smoother {
  constructor(alpha = 0.5) {
    this.alpha = alpha;
    this.values = {};
  }
  update(key, value) {
    if (!Number.isFinite(value)) return this.values[key];
    const prev = this.values[key];
    this.values[key] = prev === undefined ? value : this.alpha * value + (1 - this.alpha) * prev;
    return this.values[key];
  }
  reset() {
    this.values = {};
  }
}
