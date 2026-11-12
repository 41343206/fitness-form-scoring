import { angle, angleFromVertical, angleFromHorizontal, minVisibility, hipDrop } from './pose-math.js';
import { BUILTIN_TEMPLATES } from './templates.js';

// 每個動作：計次用的關鍵角度與門檻、畫面上顯示的其他角度，
// 以及兩個姿勢判斷：
//   ready：預備姿勢（站直 / 撐起），要維持一段時間才開始計次
//   valid：做動作過程中姿勢是否還合理（例如深蹲時人要是直立的），不合理就不計
// measure 會分別用 2D 像素座標和 3D 世界座標各算一次，再依拍攝角度混合（見 pose-math.js 的 weight3D），
// 所以這裡的計算要同時適用 2D（沒有 z）和 3D。
// rules：每一下的評分規則（見 scoring.js），value 從這一下的資料算出數值，
//   達到 full 得滿分、到 zero 得 0 分；feedback 是扣分最多時的語音提示。
// dtwFeatures：DTW 比對用的特徵；builtinTemplates：資料集標準動作產生的內建模板（見 templates.js）；
// defaultTemplate：沒有內建模板時用的理想曲線（弓箭步目前還沒有資料集）。
// dtwK：DTW 換算分數的寬鬆程度，依資料集設定成「標準動作的中位數約 85 分」。
// mode: 'hold' 是靜態動作（棒式），不計次，改成計時：holdGood 判斷這一幀姿勢對不對，
//   holdFeedback 是姿勢不對時的語音提示。
// downAngle 是「算一下」的最低門檻，刻意放寬：蹲不夠低也會計次，再由評分判斷標準與否（見 scoring.js 的 STANDARD_SCORE），
// 只擋掉兩下之間調整姿勢這類很小的動作。
// 門檻是起始參考值，之後要用實測資料調整（見 docs/plan.md 第 4 節）。

const maxOf = (rep, k) => Math.max(...rep.frames.map((f) => f[k]).filter(Number.isFinite));
const minOf = (rep, k) => Math.min(...rep.frames.map((f) => f[k]).filter(Number.isFinite));

// 一下理想動作的曲線：從 top 平滑降到 bottom 再回到 top
const curve = (n, top, bottom) =>
  Array.from({ length: n }, (_, i) => top - (top - bottom) * Math.sin((Math.PI * i) / (n - 1)));

// 趴著的動作共用的橫框：寬度佔畫面 90%，高度是寬度的 45%，位置偏下（人趴在地上）
function lyingBox(w, h) {
  const bw = w * 0.9;
  const bh = Math.min(h * 0.8, bw * 0.45);
  return { x: (w - bw) / 2, y: h - bh - h * 0.06, w: bw, h: bh };
}

export const EXERCISES = {
  squat: {
    name: '深蹲',
    keyLabel: '膝角',
    downAngle: 140,
    upAngle: 160,
    tips: ['用手機支架把手機直放，高度約在腰部，鏡頭水平對著身體側面', '站進畫面中的框框，框變綠就會自動開始'],
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
    // 節奏的滿分門檻依資料集 good 動作下蹲時間的第 20 百分位設定（深蹲 0.6 秒、伏地挺身 0.4 秒）
    rules: [
      { id: 'depth', label: '深度', feedback: '再蹲低一點', weight: 45, full: 90, zero: 125, value: (rep) => rep.minAngle },
      { id: 'lean', label: '軀幹', feedback: '胸口挺起來', weight: 30, full: 45, zero: 65, value: (rep) => maxOf(rep, '軀幹前傾') },
      { id: 'tempo', label: '節奏', feedback: '下蹲慢一點', weight: 25, full: 0.6, zero: 0.3, value: (rep) => rep.descentMs / 1000 },
    ],
    dtwFeatures: (f) => [f.key, f.軀幹前傾],
    builtinTemplates: BUILTIN_TEMPLATES.squat,
    dtwK: 40,
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
    downAngle: 135,
    upAngle: 150,
    tips: ['用手機支架把手機橫放在地上，鏡頭對著身體側面', '趴進畫面中的框框，框變綠就會自動開始'],
    readyHint: '請撐起身體，手臂打直',
    orientation: 'landscape',
    axis: 'h',
    boxJoints: ['ear', 'shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle', 'footIndex'],
    fillRange: [0.45, 0.9],
    box: lyingBox,
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
      { id: 'tempo', label: '節奏', feedback: '慢一點，控制速度', weight: 20, full: 0.4, zero: 0.2, value: (rep) => rep.descentMs / 1000 },
    ],
    dtwFeatures: (f) => [f.key, f.身體直線],
    builtinTemplates: BUILTIN_TEMPLATES.pushup,
    dtwK: 20,
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
  lunge: {
    name: '弓箭步',
    keyLabel: '前膝角',
    downAngle: 140,
    upAngle: 155,
    tips: ['用手機支架把手機直放，高度約在腰部，鏡頭水平對著身體側面', '站進畫面中的框框，框變綠就會自動開始；前後腳都要入鏡'],
    readyHint: '請側身站直，準備開始',
    orientation: 'portrait',
    axis: 'v',
    // 前後腳都要在框內（knee2 等是另一隻腳）
    boxJoints: ['ear', 'shoulder', 'hip', 'knee', 'ankle', 'footIndex', 'knee2', 'ankle2', 'footIndex2'],
    fillRange: [0.45, 0.85],
    // 前後腳張開，框比深蹲寬
    box(w, h) {
      const bh = h * 0.86;
      const bw = Math.min(w * 0.94, bh * 0.85);
      return { x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh };
    },
    measure(j) {
      const k1 = angle(j.hip, j.knee, j.ankle);
      const k2 = angle(j.hip2, j.knee2, j.ankle2);
      const front = Math.min(k1, k2), back = Math.max(k1, k2);
      const lean = angleFromVertical(j.hip, j.shoulder);
      // 側拍時遠的那隻腳常被擋住，可見度偏低，放寬一點
      const far = Math.min(1, minVisibility(j.knee2, j.ankle2) + 0.2);
      return {
        // 不管哪隻腳在前，彎比較多的就是前腳
        key: front,
        visibility: Math.min(minVisibility(j.shoulder, j.hip, j.knee, j.ankle), far),
        extra: {
          前膝: front,
          後膝: back,
          軀幹前傾: lean,
        },
        upright: j.shoulder.y < j.hip.y && j.hip.y < j.ankle.y,
        lean,
      };
    },
    rules: [
      { id: 'depth', label: '前腳深度', feedback: '前腳再蹲低一點', weight: 40, full: 95, zero: 130, value: (rep) => rep.minAngle },
      { id: 'back', label: '後腳', feedback: '後腳膝蓋再往下', weight: 25, full: 100, zero: 140, value: (rep) => minOf(rep, '後膝') },
      { id: 'lean', label: '軀幹', feedback: '上半身挺直', weight: 20, full: 20, zero: 40, value: (rep) => maxOf(rep, '軀幹前傾') },
      { id: 'tempo', label: '節奏', feedback: '慢一點，控制速度', weight: 15, full: 0.7, zero: 0.3, value: (rep) => rep.descentMs / 1000 },
    ],
    dtwFeatures: (f) => [f.key, f.後膝],
    defaultTemplate() {
      const front = curve(30, 170, 90), back = curve(30, 170, 95);
      return front.map((k, i) => [k, back[i]]);
    },
    ready(m) {
      return m.upright && m.key >= this.upAngle && m.lean < 25;
    },
    valid(m) {
      return m.upright && m.lean < 45;
    },
  },
  plank: {
    name: '棒式',
    mode: 'hold',
    keyLabel: '身體直線',
    tips: ['用手機支架把手機橫放在地上，鏡頭對著身體側面', '用手肘撐地趴進框框，身體打直，框變綠就開始計時'],
    readyHint: '請用手肘撐起，身體打直',
    orientation: 'landscape',
    axis: 'h',
    boxJoints: ['ear', 'shoulder', 'elbow', 'hip', 'knee', 'ankle', 'footIndex'],
    fillRange: [0.45, 0.9],
    box: lyingBox,
    measure(j) {
      return {
        key: angle(j.shoulder, j.hip, j.ankle),
        visibility: minVisibility(j.shoulder, j.elbow, j.hip, j.ankle),
        extra: {},
        tilt: angleFromHorizontal(j.shoulder, j.ankle),
        elbowBelowShoulder: j.elbow.y > j.shoulder.y,
        // 正值＝塌腰，負值＝翹臀
        hipDrop: hipDrop(j),
      };
    },
    // 肩–髖–踝夾角 ≥ 165° 算姿勢正確
    holdGood(m) {
      return m.key >= 165;
    },
    holdFeedback(m) {
      return m.hipDrop > 0 ? '核心收緊，不要塌腰' : '臀部放低一點';
    },
    ready(m) {
      return m.tilt < 35 && m.elbowBelowShoulder && m.key >= 160;
    },
    valid(m) {
      return m.tilt < 45 && m.elbowBelowShoulder;
    },
  },
};
