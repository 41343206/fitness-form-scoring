import { dtwScore } from './dtw.js';

// 線性給分：value 達到 full 得滿分（1），到 zero 得 0 分，中間線性。
// full 可以大於或小於 zero（例如角度越小越好，或越大越好）。
export function linear(value, full, zero) {
  if (!Number.isFinite(value)) return 0;
  const f = (value - zero) / (full - zero);
  return Math.min(1, Math.max(0, f));
}

// 規則評分：每條規則依權重給分，加總為 0–100 分
export function ruleScore(rules, rep) {
  const parts = rules.map((r) => {
    const value = r.value(rep);
    const fraction = linear(value, r.full, r.zero);
    return { id: r.id, label: r.label, feedback: r.feedback, weight: r.weight, value, fraction, points: r.weight * fraction };
  });
  const total = parts.reduce((s, p) => s + p.weight, 0);
  const score = (100 * parts.reduce((s, p) => s + p.points, 0)) / total;
  return { score, parts };
}

// 每一下的特徵序列，給 DTW 用
export function repSequence(ex, rep) {
  return rep.frames.map((f) => ex.dtwFeatures(f));
}

// 綜合分數 = α × 規則分 + (1 − α) × DTW 分；沒有模板時只用規則分。
// 回饋取得分比例最低、且低於 0.8 的那條規則。
export function scoreRep(ex, rep, templates, { alpha = 0.6 } = {}) {
  const rule = ruleScore(ex.rules, rep);
  const dtw = dtwScore(repSequence(ex, rep), templates, { k: ex.dtwK ?? 25 });
  const score = dtw ? alpha * rule.score + (1 - alpha) * dtw.score : rule.score;
  const worst = rule.parts.reduce((a, b) => (b.fraction < a.fraction ? b : a));
  return {
    score: Math.round(score),
    ruleScore: Math.round(rule.score),
    dtwScore: dtw ? Math.round(dtw.score) : null,
    parts: rule.parts,
    feedback: worst.fraction < 0.8 ? worst : null,
  };
}

// 一組的總結：平均分數、最常出現的錯誤
export function summarize(results) {
  if (results.length === 0) return { count: 0, avg: null, topIssue: null };
  const avg = Math.round(results.reduce((s, r) => s + r.score, 0) / results.length);
  const counts = {};
  for (const r of results) if (r.feedback) counts[r.feedback.id] = (counts[r.feedback.id] ?? 0) + 1;
  const topId = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const topIssue = topId ? { ...results.find((r) => r.feedback?.id === topId).feedback, times: counts[topId] } : null;
  return { count: results.length, avg, topIssue };
}
