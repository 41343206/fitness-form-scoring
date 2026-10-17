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

export function minVisibility(...points) {
  return Math.min(...points.map((p) => p.v));
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
