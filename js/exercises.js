import { angle, angleFromVertical, angleFromHorizontal, minVisibility, hipDrop } from './pose-math.js';
import { BUILTIN_TEMPLATES } from './templates.js';

// 每個動作：計次用的關鍵角度與門檻、畫面上顯示的其他角度，
// 以及兩個姿勢判斷：
//   ready：預備姿勢（站直 / 撐起），要維持一段時間才開始計次
//   valid：做動作過程中姿勢是否還合理（例如深蹲時人要是直立的），不合理就不計
// measure 會分別用 2D 像素座標和 3D 世界座標各算一次，再依拍攝角度混合（見 pose-math.js 的 weight3D），
// 所以這裡的計算要同時適用 2D（沒有 z）和 3D。
// rules：每一下的評分規則（見 scoring.js），value 從這一下的資料算出數值，
//   達到 full 得滿分、到 zero 得 0 分；feedback 是扣分最多時的語音提示（可以是依這一下資料決定的函式，
//   例如伏地挺身分「塌腰」和「翹臀」），tip 是結果頁上較完整的教練說明（為什麼要改、怎麼改）。
// dtwFeatures：DTW 比對用的特徵；builtinTemplates：資料集標準動作產生的內建模板（見 templates.js）；
// defaultTemplate：沒有內建模板時用的理想曲線（弓箭步目前還沒有資料集）。
// dtwK：DTW 換算分數的寬鬆程度，依資料集設定成「標準動作的中位數約 85 分」。
// mode: 'hold' 是靜態動作（棒式、靠牆深蹲），不計次，改成計時：holdGood 判斷這一幀姿勢對不對，
//   holdFeedback 回傳姿勢不對時的問題 { id, label, feedback（語音）, tip（結果頁說明）}。
// measure 回傳的 track 是每一幀要記下來、但不顯示在畫面上的數值（例如塌腰程度），評分時可以用。
// card：首頁卡片的照片、標籤和說明；target：今日課表的預設目標（次數或秒數）。
// downAngle 是「算一下」的最低門檻，刻意放寬：蹲不夠低也會計次，再由評分判斷標準與否（見 scoring.js 的 STANDARD_SCORE），
// 只擋掉兩下之間調整姿勢這類很小的動作。
// 門檻是起始參考值，之後要用實測資料調整（見 docs/plan.md 第 4 節）。

const maxOf = (rep, k) => Math.max(...rep.frames.map((f) => f[k]).filter(Number.isFinite));
const minOf = (rep, k) => Math.min(...rep.frames.map((f) => f[k]).filter(Number.isFinite));

// 伏地挺身身體最不直的那一幀是塌腰（正）還是翹臀（負）
function worstHipDrop(rep) {
  let worst = 0;
  for (const f of rep.frames) if (Number.isFinite(f.hipDrop) && Math.abs(f.hipDrop) > Math.abs(worst)) worst = f.hipDrop;
  return worst;
}

// 臀橋抬到最高（key 最小）那一幀的膝角
function kneeAtTop(rep) {
  let best = null;
  for (const f of rep.frames) if (Number.isFinite(f.膝角) && (best === null || f.key < best.key)) best = f;
  return best ? best.膝角 : 90;
}

// 一下理想動作的曲線：從 top 平滑降到 bottom 再回到 top
const curve = (n, top, bottom) =>
  Array.from({ length: n }, (_, i) => top - (top - bottom) * Math.sin((Math.PI * i) / (n - 1)));

// 趴著的動作共用的橫框：寬度佔畫面 90%，高度是寬度的 45%，位置偏下（人趴在地上）
function lyingBox(w, h) {
  const bw = w * 0.9;
  const bh = Math.min(h * 0.8, bw * 0.45);
  return { x: (w - bw) / 2, y: h - bh - h * 0.06, w: bw, h: bh };
}

// 依 3D 比重（0 = 全用 2D，1 = 全用 3D，見 pose-math.js 的 weight3D）算出這一幀的計次門檻
export function repThresholds(ex, w = 0) {
  const lerp = (a, b) => a + (b - a) * Math.min(1, Math.max(0, w));
  return { down: lerp(ex.downAngle, ex.downAngle3D ?? ex.downAngle), up: lerp(ex.upAngle, ex.upAngle3D ?? ex.upAngle) };
}

export const EXERCISES = {
  squat: {
    name: '深蹲',
    card: { image: 'img/squat.jpg', chip: '手機直放', desc: '判斷膝角、軀幹前傾' },
    target: 10,
    keyLabel: '膝角',
    downAngle: 140,
    upAngle: 160,
    // 斜拍、全用 3D 座標時的門檻：3D 會把站直的腿量成 158–167°，所以放寬（見 docs/view-angle-study.md）
    downAngle3D: 130,
    upAngle3D: 148,
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
      {
        id: 'depth', label: '深度', weight: 45, full: 90, zero: 125, value: (rep) => rep.minAngle,
        feedback: (rep) => (rep.minAngle > 115 ? '蹲太淺了，屁股往後坐，蹲到大腿接近平行地面' : '再蹲低一點，大腿接近平行地面'),
        tip: '蹲得不夠深，臀腿沒有完整出力。想像往後坐到椅子上，膝蓋彎到約 90 度、大腿接近和地面平行再站起來。',
      },
      {
        id: 'lean', label: '軀幹', weight: 30, full: 45, zero: 65, value: (rep) => maxOf(rep, '軀幹前傾'),
        feedback: '胸口挺起來，背不要往前倒',
        tip: '上半身往前倒太多，壓力會跑到下背。眼睛看前方、胸口挺起，重心放在腳跟到腳掌中間，不要壓在腳尖。',
      },
      {
        id: 'tempo', label: '節奏', weight: 25, full: 0.6, zero: 0.3, value: (rep) => rep.descentMs / 1000,
        feedback: '下蹲慢一點，心裡數兩秒',
        tip: '下蹲太快，靠慣性掉下去，膝蓋容易受衝擊。下去時慢慢數「一、二」，到底再穩穩站起來。',
      },
    ],
    dtwFeatures: (f) => [f.key, f.軀幹前傾],
    builtinTemplates: BUILTIN_TEMPLATES.squat,
    dtwK: 40,
    defaultTemplate() {
      const knee = curve(30, 170, 85), lean = curve(30, 8, 35);
      return knee.map((k, i) => [k, lean[i]]);
    },
    ready(m) {
      return m.upright && m.key >= (m.upAt ?? this.upAngle) && m.lean < 25;
    },
    valid(m) {
      return m.upright && m.lean < 60;
    },
  },
  pushup: {
    name: '伏地挺身',
    card: { image: 'img/pushup.jpg', chip: '手機橫放', desc: '判斷肘角、身體是否成一直線' },
    target: 10,
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
        // 正值＝塌腰，負值＝翹臀；用來分辨身體沒打直是哪一種
        track: { hipDrop: hipDrop(j) },
        bodyLine,
        // 肩到腳踝的連線要接近水平，才是趴著的姿勢
        tilt: angleFromHorizontal(j.shoulder, j.ankle),
        handsBelowShoulder: j.wrist.y > j.shoulder.y,
      };
    },
    rules: [
      {
        id: 'depth', label: '深度', weight: 40, full: 90, zero: 125, value: (rep) => rep.minAngle,
        feedback: '胸口再往下，手肘彎到約 90 度',
        tip: '下去的幅度不夠，胸肌和手臂練不到。身體整片往下，胸口接近地面、手肘彎到約 90 度再推起來。',
      },
      {
        id: 'line', label: '身體直線', weight: 40, full: 165, zero: 140, value: (rep) => minOf(rep, '身體直線'),
        feedback: (rep) => (worstHipDrop(rep) > 0 ? '腰塌下去了，收緊肚子和屁股' : '屁股翹太高，身體壓成一直線'),
        tip: '身體沒有成一直線。腰往下塌會壓迫下背，屁股翹高則是在偷力。收緊腹部和臀部，讓頭、肩、髖、腳踝在同一條線上。',
      },
      {
        id: 'tempo', label: '節奏', weight: 20, full: 0.4, zero: 0.2, value: (rep) => rep.descentMs / 1000,
        feedback: '下去慢一點，控制速度',
        tip: '下去太快，等於讓身體自己掉下去。用大約一秒慢慢下去，肩膀比較不容易受傷，肌肉也練得到。',
      },
    ],
    dtwFeatures: (f) => [f.key, f.身體直線],
    builtinTemplates: BUILTIN_TEMPLATES.pushup,
    dtwK: 20,
    defaultTemplate() {
      return curve(30, 165, 80).map((e) => [e, 175]);
    },
    ready(m) {
      return m.tilt < 35 && m.handsBelowShoulder && m.key >= (m.upAt ?? this.upAngle) && m.bodyLine >= 150;
    },
    valid(m) {
      return m.tilt < 45 && m.handsBelowShoulder;
    },
  },
  lunge: {
    name: '弓箭步',
    card: { image: 'img/lunge.jpg', chip: '手機直放', desc: '判斷前膝、後膝角度與上半身是否挺直' },
    target: 10,
    keyLabel: '前膝角',
    downAngle: 140,
    upAngle: 155,
    downAngle3D: 130,
    upAngle3D: 145,
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
      {
        id: 'depth', label: '前腳深度', weight: 40, full: 95, zero: 130, value: (rep) => rep.minAngle,
        feedback: '前腳再蹲低一點，前膝彎到約 90 度',
        tip: '前腳蹲得不夠低。身體垂直往下沉，前腳膝蓋彎到約 90 度、大腿接近和地面平行。',
      },
      {
        id: 'back', label: '後腳', weight: 25, full: 100, zero: 140, value: (rep) => minOf(rep, '後膝'),
        feedback: '後腳膝蓋往地板靠近',
        tip: '後腳幾乎沒彎，變成只有前腳在出力。往下時讓後腳膝蓋朝地板靠近，停在快碰到地的高度。',
      },
      {
        id: 'lean', label: '軀幹', weight: 20, full: 20, zero: 40, value: (rep) => maxOf(rep, '軀幹前傾'),
        feedback: '上半身挺直，不要往前倒',
        tip: '上半身往前倒，重心跑到前腳膝蓋。肩膀保持在髖部正上方，像有一條線把頭往上拉。',
      },
      {
        id: 'tempo', label: '節奏', weight: 15, full: 0.7, zero: 0.3, value: (rep) => rep.descentMs / 1000,
        feedback: '慢一點，控制速度',
        tip: '下去太快，膝蓋容易晃。往下時慢慢數兩秒，保持平衡再起身。',
      },
    ],
    dtwFeatures: (f) => [f.key, f.後膝],
    defaultTemplate() {
      const front = curve(30, 170, 90), back = curve(30, 170, 95);
      return front.map((k, i) => [k, back[i]]);
    },
    ready(m) {
      return m.upright && m.key >= (m.upAt ?? this.upAngle) && m.lean < 25;
    },
    valid(m) {
      return m.upright && m.lean < 45;
    },
  },
  plank: {
    name: '棒式',
    card: { image: 'img/plank.jpg', chip: '手機橫放 · 計時', desc: '判斷肩、髖、踝是否成一直線，計算維持秒數' },
    target: 30,
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
      return m.hipDrop > 0
        ? { id: 'sag', label: '塌腰', feedback: '核心收緊，不要塌腰', tip: '腰往下塌，下背在承受重量。肚子往內收、屁股夾緊，讓肩、髖、腳踝成一直線。' }
        : { id: 'pike', label: '翹臀', feedback: '屁股放低一點', tip: '屁股翹太高，核心在偷懶。把臀部放低到和肩膀、腳踝同一條線，感覺肚子在出力。' };
    },
    ready(m) {
      return m.tilt < 35 && m.elbowBelowShoulder && m.key >= 160;
    },
    valid(m) {
      return m.tilt < 45 && m.elbowBelowShoulder;
    },
  },
  bridge: {
    name: '臀橋',
    card: { image: 'img/bridge.jpg', chip: '手機橫放', desc: '判斷臀部抬起的高度、膝蓋角度' },
    target: 12,
    // 計次狀態機是「角度往下再回來」，臀橋是髖角往上打開再放下，所以 key 用 360 − 髖角（畫面上顯示髖角）
    keyLabel: '髖角',
    showKey: (k) => 360 - k,
    // 躺著時髖角約 135–150°（看腳放多遠），抬到頂約 170–180°
    downAngle: 197, // 髖角打開到 ≥ 163° 才算一下
    upAngle: 207, // 髖角回到 ≤ 153° 算放下
    tips: ['用手機支架把手機橫放在地上，鏡頭對著身體側面', '仰躺、膝蓋彎曲腳踩地，躺進框框，框變綠就會自動開始'],
    readyHint: '請仰躺，膝蓋彎起來腳踩地',
    orientation: 'landscape',
    axis: 'h',
    boxJoints: ['ear', 'shoulder', 'hip', 'knee', 'ankle', 'footIndex'],
    fillRange: [0.4, 0.9],
    box: lyingBox,
    measure(j) {
      const hip = angle(j.shoulder, j.hip, j.knee);
      return {
        key: 360 - hip,
        visibility: minVisibility(j.shoulder, j.hip, j.knee, j.ankle),
        extra: { 膝角: angle(j.hip, j.knee, j.ankle) },
        hip,
        knee: angle(j.hip, j.knee, j.ankle),
        // 肩到膝的連線接近水平才是躺著（臀橋頂端也只有約 30°）
        tilt: angleFromHorizontal(j.shoulder, j.knee),
      };
    },
    rules: [
      {
        id: 'height', label: '抬臀高度', weight: 50, full: 170, zero: 150, value: (rep) => 360 - rep.minAngle,
        feedback: '屁股再抬高一點，肩膀到膝蓋成一直線',
        tip: '臀部抬得不夠高，臀肌沒有收到最緊。用腳跟推地把屁股往上頂，頂端時肩、髖、膝成一直線，夾緊屁股停一下。',
      },
      {
        id: 'knee', label: '膝蓋角度', weight: 25, full: 15, zero: 40, value: (rep) => Math.abs(kneeAtTop(rep) - 90),
        feedback: (rep) => (kneeAtTop(rep) > 90 ? '腳往屁股靠近一點' : '腳離屁股遠一點'),
        tip: '腳的位置不對，頂端時膝蓋最好彎成約 90 度。腳太遠會變成大腿後側出力，太近則容易壓到膝蓋。',
      },
      {
        id: 'tempo', label: '節奏', weight: 25, full: 0.6, zero: 0.25, value: (rep) => rep.descentMs / 1000,
        feedback: '慢慢往上推，不要用甩的',
        tip: '往上推太快，靠腰的甩動把屁股帶上去。用大約一秒慢慢推上去，感覺是屁股在出力。',
      },
    ],
    dtwFeatures: (f) => [f.key, f.膝角],
    defaultTemplate() {
      const key = curve(30, 225, 188), knee = curve(30, 70, 90); // 髖角 135°→172°，膝角 70°→90°
      return key.map((k, i) => [k, knee[i]]);
    },
    ready(m) {
      return m.tilt < 35 && m.key >= (m.upAt ?? this.upAngle) && m.knee < 130;
    },
    valid(m) {
      return m.tilt < 45 && m.knee < 140;
    },
  },
  situp: {
    name: '仰臥起坐',
    card: { image: 'img/situp.jpg', chip: '手機橫放', desc: '判斷坐起的幅度、躺下是否有控制' },
    target: 12,
    keyLabel: '髖角',
    downAngle: 95,
    upAngle: 115,
    tips: ['用手機支架把手機橫放在地上，鏡頭對著身體側面', '仰躺、膝蓋彎曲腳踩地，躺進框框，框變綠就會自動開始'],
    readyHint: '請仰躺，膝蓋彎起來腳踩地',
    orientation: 'landscape',
    axis: 'h',
    boxJoints: ['ear', 'shoulder', 'hip', 'knee', 'ankle', 'footIndex'],
    fillRange: [0.4, 0.9],
    box: lyingBox,
    measure(j) {
      const knee = angle(j.hip, j.knee, j.ankle);
      return {
        key: angle(j.shoulder, j.hip, j.knee),
        visibility: minVisibility(j.shoulder, j.hip, j.knee, j.ankle),
        extra: { 膝角: knee },
        knee,
        // 上半身（髖到肩）和地面的夾角：躺平約 0°，坐起來約 60° 以上
        torso: angleFromHorizontal(j.hip, j.shoulder),
      };
    },
    rules: [
      {
        id: 'height', label: '坐起幅度', weight: 45, full: 70, zero: 100, value: (rep) => rep.minAngle,
        feedback: '再坐起來一點，胸口靠近大腿',
        tip: '坐起的幅度不夠，只做到一半。用腹部的力量把上半身捲起來，坐到胸口靠近大腿。',
      },
      {
        id: 'lower', label: '躺下控制', weight: 30, full: 0.8, zero: 0.3, value: (rep) => (rep.durationMs - rep.descentMs) / 1000,
        feedback: '躺下時慢慢放，不要直接倒下去',
        tip: '躺下時直接倒回地面，等於放掉了一半的訓練。往下時用腹部撐住，慢慢一節一節躺回去。',
      },
      {
        id: 'knee', label: '膝蓋彎曲', weight: 25, full: 100, zero: 140, value: (rep) => maxOf(rep, '膝角'),
        feedback: '膝蓋彎起來，腳掌踩穩地板',
        tip: '腳伸太直，會變成用大腿前側和腰的力量把身體拉起來。膝蓋彎到約 90 度、腳掌踩穩，腹部才會出力。',
      },
    ],
    dtwFeatures: (f) => [f.key, f.膝角],
    defaultTemplate() {
      return curve(30, 125, 65).map((k) => [k, 90]);
    },
    ready(m) {
      return m.torso < 30 && m.key >= (m.upAt ?? this.upAngle) && m.knee < 140;
    },
    valid(m) {
      return m.knee < 150;
    },
  },
  wallsit: {
    name: '靠牆深蹲',
    mode: 'hold',
    card: { image: 'img/wallsit.jpg', chip: '手機直放 · 計時', desc: '背靠牆蹲低維持，判斷膝角和背部是否貼牆' },
    target: 30,
    keyLabel: '膝角',
    tips: ['找一面牆，用手機支架把手機直放在身體側面，高度約在腰部', '背貼牆往下滑到大腿接近平行地面，框變綠就開始計時'],
    readyHint: '背貼牆往下蹲，大腿接近平行地面',
    orientation: 'portrait',
    axis: 'v',
    boxJoints: ['ear', 'shoulder', 'hip', 'knee', 'ankle', 'footIndex'],
    fillRange: [0.35, 0.8],
    // 蹲著比站著矮、比較寬
    box(w, h) {
      const bh = h * 0.8;
      const bw = Math.min(w * 0.9, bh * 0.75);
      return { x: (w - bw) / 2, y: h - bh - h * 0.07, w: bw, h: bh };
    },
    measure(j) {
      const lean = angleFromVertical(j.hip, j.shoulder);
      return {
        key: angle(j.hip, j.knee, j.ankle),
        visibility: minVisibility(j.shoulder, j.hip, j.knee, j.ankle),
        extra: { 背部傾斜: lean },
        lean,
        upright: j.shoulder.y < j.hip.y,
      };
    },
    // 膝角 75–110° 且背部接近垂直（貼牆）算姿勢正確
    holdGood(m) {
      return m.key >= 75 && m.key <= 110 && m.lean < 20;
    },
    holdFeedback(m) {
      if (m.lean >= 20)
        return { id: 'back', label: '背離開牆', feedback: '背貼回牆上，上半身挺直', tip: '上半身往前傾、背離開牆，壓力會跑到膝蓋和下背。整個背和後腦都貼著牆，只靠腿出力。' };
      if (m.key > 110)
        return { id: 'high', label: '蹲不夠低', feedback: '再往下蹲，大腿接近平行地面', tip: '蹲得太高，大腿幾乎沒出力。沿著牆往下滑，到膝蓋彎成約 90 度、大腿和地面平行。' };
      return { id: 'low', label: '蹲太低', feedback: '太低了，往上一點', tip: '蹲得比 90 度還低，膝蓋負擔變大。往上一點，停在大腿和地面平行的高度。' };
    },
    ready(m) {
      return m.upright && m.key <= 120 && m.lean < 25;
    },
    valid(m) {
      return m.upright && m.key < 150;
    },
  },
};
