// DTW（Dynamic Time Warping）：比較兩段速度不同的動作序列有多像。
// 序列的每個元素是一個特徵向量（例如 [膝角, 軀幹前傾]），單位是度。

// 把序列重新取樣成固定長度，讓快慢不同的動作可以公平比較，也讓計算量固定
export function resample(seq, n = 40) {
  if (seq.length === 0) return [];
  if (seq.length === 1) return Array.from({ length: n }, () => seq[0].slice());
  const out = [];
  for (let i = 0; i < n; i++) {
    const pos = (i * (seq.length - 1)) / (n - 1);
    const lo = Math.floor(pos), hi = Math.min(seq.length - 1, lo + 1), f = pos - lo;
    out.push(seq[lo].map((v, d) => v * (1 - f) + seq[hi][d] * f));
  }
  return out;
}

// 兩個特徵向量的距離（歐氏距離）
function dist(a, b) {
  let s = 0;
  for (let d = 0; d < a.length; d++) s += (a[d] - b[d]) ** 2;
  return Math.sqrt(s);
}

// DTW 距離，回傳「對齊後每一步的平均距離」（度），方便換算成分數。
// window：Sakoe-Chiba 視窗（佔長度的比例），避免不合理的對齊並加快計算。
export function dtwDistance(a, b, window = 0.25) {
  const n = a.length, m = b.length;
  if (n === 0 || m === 0) return Infinity;
  const w = Math.max(Math.ceil(Math.max(n, m) * window), Math.abs(n - m));
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  const steps = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  cost[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(1, i - w); j <= Math.min(m, i + w); j++) {
      const d = dist(a[i - 1], b[j - 1]);
      let best = cost[i - 1][j - 1], s = steps[i - 1][j - 1];
      if (cost[i - 1][j] < best) { best = cost[i - 1][j]; s = steps[i - 1][j]; }
      if (cost[i][j - 1] < best) { best = cost[i][j - 1]; s = steps[i][j - 1]; }
      cost[i][j] = best + d;
      steps[i][j] = s + 1;
    }
  }
  return cost[n][m] / steps[n][m];
}

// 和多個模板比對，取最像的一個，換算成 0–100 分。
// k：平均差多少度時分數降到約 37 分（e⁻¹），越大越寬鬆。
export function dtwScore(seq, templates, { n = 40, k = 25 } = {}) {
  if (!templates?.length || seq.length < 2) return null;
  const a = resample(seq, n);
  const d = Math.min(...templates.map((t) => dtwDistance(a, resample(t, n))));
  return { distance: d, score: 100 * Math.exp(-d / k) };
}
