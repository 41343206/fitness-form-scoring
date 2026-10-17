import { angle, angleFromVertical, angleFromHorizontal, minVisibility } from './pose-math.js';

// 每個動作：計次用的關鍵角度與門檻、畫面上顯示的其他角度，
// 以及兩個姿勢判斷：
//   ready：預備姿勢（站直 / 撐起），要維持一段時間才開始計次
//   valid：做動作過程中姿勢是否還合理（例如深蹲時人要是直立的），不合理就不計
// 門檻是起始參考值，之後要用實測資料調整（見 docs/plan.md 第 4 節）。
export const EXERCISES = {
  squat: {
    name: '深蹲',
    keyLabel: '膝角',
    downAngle: 100,
    upAngle: 160,
    tips: ['手機放地上或靠牆，從側面拍', '全身都要入鏡，包含腳'],
    readyHint: '請側身站直，準備開始',
    measure(j) {
      const lean = angleFromVertical(j.hip, j.shoulder);
      return {
        key: angle(j.hip, j.knee, j.ankle),
        visibility: minVisibility(j.shoulder, j.hip, j.knee, j.ankle),
        extra: {
          髖角: angle(j.shoulder, j.hip, j.knee),
          軀幹前傾: lean,
        },
        // 影像 y 軸向下：肩在髖上方、髖在腳踝上方才算是站著
        upright: j.shoulder.y < j.hip.y && j.hip.y < j.ankle.y,
        lean,
      };
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
    tips: ['手機放地上，從側面拍', '頭到腳都要入鏡'],
    readyHint: '請撐起身體，手臂打直',
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
    ready(m) {
      return m.tilt < 35 && m.handsBelowShoulder && m.key >= this.upAngle && m.bodyLine >= 150;
    },
    valid(m) {
      return m.tilt < 45 && m.handsBelowShoulder;
    },
  },
};
