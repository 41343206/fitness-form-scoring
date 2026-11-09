import { angle, angleFromVertical, angleFromHorizontal, minVisibility } from './pose-math.js';

// 每個動作：計次用的關鍵角度與門檻、畫面上顯示的其他角度，
// 以及兩個姿勢判斷：
//   ready：預備姿勢（站直 / 撐起），要維持一段時間才開始計次
//   valid：做動作過程中姿勢是否還合理（例如深蹲時人要是直立的），不合理就不計
// measure 會分別用 2D 像素座標和 3D 世界座標各算一次，再依拍攝角度混合（見 pose-math.js 的 weight3D），
// 所以這裡的計算要同時適用 2D（沒有 z）和 3D。
// rules：每一下的評分規則（見 scoring.js），value 從這一下的資料算出數值，
//   達到 full 得滿分、到 zero 得 0 分；feedback 是扣分最多時的語音提示。
// dtwFeatures：DTW 比對用的特徵；defaultTemplate：還沒錄製標準動作時用的理想曲線。
// 門檻是起始參考值，之後要用實測資料調整（見 docs/plan.md 第 4 節）。

const maxOf = (rep, k) => Math.max(...rep.frames.map((f) => f[k]).filter(Number.isFinite));
const minOf = (rep, k) => Math.min(...rep.frames.map((f) => f[k]).filter(Number.isFinite));

// 一下理想動作的曲線：從 top 平滑降到 bottom 再回到 top
const curve = (n, top, bottom) =>
  Array.from({ length: n }, (_, i) => top - (top - bottom) * Math.sin((Math.PI * i) / (n - 1)));

export const EXERCISES = {
  squat: {
    name: '深蹲',
    keyLabel: '膝角',
    downAngle: 100,
    upAngle: 160,
    tips: ['手機直放在地上或靠牆，從側面拍', '站進畫面中的框框，框變綠就會自動開始'],
    readyHint: '請側身站直，準備開始',
    orientation: 'portrait',
    axis: 'v',
    boxJoints: ['ear', 'shoulder', 'hip', 'knee', 'ankle', 'heel', 'footIndex'],
    fillRange: [0.45, 0.85],
    // 直立的框：高度佔畫面 86%，寬度是高度的一半
    box(w, h) {
      const bh = h * 0.86;
      const bw = Math.min(w * 0.9, bh * 0.55);
      return { x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh };
    },
    measure(j) {
      const lean = angleFromVertical(j.hip, j.shoulder);
      return {
        key: angle(j.hip, j.knee, j.ankle),
        visibility: minVisibility(j.shoulder, j.hip, j.knee, j.ankle),
        extra: {
          髖角: angle(j.shoulder, j.hip, j.knee),
          軀幹前傾: lean,
          // 大腿與地面的夾角，0° = 大腿平行地面；只看垂直方向，不受拍攝角度影響
          大腿角度: angleFromHorizontal(j.hip, j.knee),
        },
        // 影像 y 軸向下：肩在髖上方、髖在腳踝上方才算是站著
        upright: j.shoulder.y < j.hip.y && j.hip.y < j.ankle.y,
        lean,
      };
    },
    rules: [
      { id: 'depth', label: '深度', feedback: '再蹲低一點', weight: 45, full: 90, zero: 125, value: (rep) => rep.minAngle },
      { id: 'lean', label: '軀幹', feedback: '胸口挺起來', weight: 30, full: 45, zero: 65, value: (rep) => maxOf(rep, '軀幹前傾') },
      { id: 'tempo', label: '節奏', feedback: '下蹲慢一點', weight: 25, full: 0.8, zero: 0.3, value: (rep) => rep.descentMs / 1000 },
    ],
    dtwFeatures: (f) => [f.key, f.軀幹前傾],
    defaultTemplate() {
      const knee = curve(30, 170, 85), lean = curve(30, 8, 35);
      return knee.map((k, i) => [k, lean[i]]);
    },
    ready(m) {
      return m.upright && m.key >= this.upAngle && m.lean < 25;
    },
    valid(m) {
      return m.upright && m.lean < 60;
    },
  },
  pushup: {
    name: '伏地挺身',
    keyLabel: '肘角',
    downAngle: 100,
    upAngle: 150,
    tips: ['手機橫放在地上，從側面拍', '趴進畫面中的框框，框變綠就會自動開始'],
    readyHint: '請撐起身體，手臂打直',
    orientation: 'landscape',
    axis: 'h',
    boxJoints: ['ear', 'shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle', 'footIndex'],
    fillRange: [0.45, 0.9],
    // 橫的框：寬度佔畫面 90%，高度是寬度的 45%，位置偏下（人趴在地上）
    box(w, h) {
      const bw = w * 0.9;
      const bh = Math.min(h * 0.8, bw * 0.45);
      return { x: (w - bw) / 2, y: h - bh - h * 0.06, w: bw, h: bh };
    },
    measure(j) {
      const bodyLine = angle(j.shoulder, j.hip, j.ankle);
      return {
        key: angle(j.shoulder, j.elbow, j.wrist),
        visibility: minVisibility(j.shoulder, j.elbow, j.wrist, j.hip, j.ankle),
        extra: {
          身體直線: bodyLine,
        },
        bodyLine,
        // 肩到腳踝的連線要接近水平，才是趴著的姿勢
        tilt: angleFromHorizontal(j.shoulder, j.ankle),
        handsBelowShoulder: j.wrist.y > j.shoulder.y,
      };
    },
    rules: [
      { id: 'depth', label: '深度', feedback: '再往下一點', weight: 40, full: 90, zero: 125, value: (rep) => rep.minAngle },
      { id: 'line', label: '身體直線', feedback: '核心收緊，身體保持一直線', weight: 40, full: 165, zero: 140, value: (rep) => minOf(rep, '身體直線') },
      { id: 'tempo', label: '節奏', feedback: '慢一點，控制速度', weight: 20, full: 0.6, zero: 0.2, value: (rep) => rep.descentMs / 1000 },
    ],
    dtwFeatures: (f) => [f.key, f.身體直線],
    defaultTemplate() {
      return curve(30, 165, 80).map((e) => [e, 175]);
    },
    ready(m) {
      return m.tilt < 35 && m.handsBelowShoulder && m.key >= this.upAngle && m.bodyLine >= 150;
    },
    valid(m) {
      return m.tilt < 45 && m.handsBelowShoulder;
    },
  },
};
