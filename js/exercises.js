import { angle, angleFromVertical, minVisibility } from './pose-math.js';

// 每個動作：計次用的關鍵角度、門檻，以及畫面上顯示的其他角度。
// 門檻是起始參考值，之後要用實測資料調整（見 plan.md 第 4 節）。
export const EXERCISES = {
  squat: {
    name: '深蹲',
    keyLabel: '膝角',
    downAngle: 100,
    upAngle: 160,
    measure(j) {
      return {
        key: angle(j.hip, j.knee, j.ankle),
        visibility: minVisibility(j.hip, j.knee, j.ankle),
        extra: {
          髖角: angle(j.shoulder, j.hip, j.knee),
          軀幹前傾: angleFromVertical(j.hip, j.shoulder),
        },
      };
    },
  },
  pushup: {
    name: '伏地挺身',
    keyLabel: '肘角',
    downAngle: 100,
    upAngle: 150,
    measure(j) {
      return {
        key: angle(j.shoulder, j.elbow, j.wrist),
        visibility: minVisibility(j.shoulder, j.elbow, j.wrist),
        extra: {
          身體直線: angle(j.shoulder, j.hip, j.ankle),
        },
      };
    },
  },
};
