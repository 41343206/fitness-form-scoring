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

// 側拍時選擇比較靠近鏡頭（可見度較高）的那一側
export function pickSide(landmarks) {
  const avg = (side) => {
    const names = ['Shoulder', 'Elbow', 'Hip', 'Knee', 'Ankle'];
    return names.reduce((s, n) => s + (landmarks[LM[side + n]].visibility ?? 1), 0) / names.length;
  };
  return avg('left') >= avg('right') ? 'left' : 'right';
}

// a-b-c 在 b 點的夾角（度）
export function angle(a, b, c) {
  const abx = a.x - b.x, aby = a.y - b.y;
  const cbx = c.x - b.x, cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const mag = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (mag === 0) return NaN;
  const cos = Math.min(1, Math.max(-1, dot / mag));
  return (Math.acos(cos) * 180) / Math.PI;
}

// a→b 連線與垂直線的夾角（度），0 = 完全直立
export function angleFromVertical(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return (Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI;
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
