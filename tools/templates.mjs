// 從 good 側面影片挑標準模板，並用「留一人驗證」比較 good 與 bad 的分數
import fs from 'node:fs';
const APP = new URL('../js/', import.meta.url).href;
const { dtwDistance, resample } = await import(APP + 'dtw.js');
const clips = JSON.parse(fs.readFileSync(process.argv[2]));
const FEATS = process.env.FEATS ? Object.fromEntries(process.env.FEATS.split(';').map((x) => x.split('=')).map(([e, f]) => [e, f.split(',')])) : null;
if (FEATS) for (const c of clips) for (const r of c.reps) if (FEATS[c.exId]) r.seq = r.frames.map((f) => FEATS[c.exId].map((k) => f[k]));
// 資料集裡內容完全相同的影片（md5 相同）：good/bad 互相矛盾的整組排除，單純重複的只留一支
const EXCLUDE = new Set([
  'squat_good_023', 'squat_bad_023', 'pushup_good_019', 'pushup_bad_019', 'squat_bad_026', 'squat_good_015',
  'squat_good_006', 'squat_bad_006', 'pushup_good_013', 'pushup_bad_020',
]);
const N = 40, K = Number(process.argv[3] ?? 25), PER = Number(process.argv[4] ?? 2), NT = Number(process.argv[5] ?? 8);
const auc = (pos, neg) => { let s = 0; for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0; return s / (pos.length * neg.length); };
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const result = {};
for (const exId of ['squat', 'pushup']) {
  const cs = clips.filter((c) => c.exId === exId && !EXCLUDE.has(`${exId}_${c.label}_${c.subject}`));
  // 候選：good 影片中規則分 ≥ 90 的每一下
  const cand = [];
  for (const c of cs.filter((c) => c.label === 'good')) for (const r of c.reps) if (r.ruleScore >= 90) cand.push({ subject: c.subject, r, seq: resample(r.seq, N) });
  // 每一下和其他人的平均 DTW 距離，越小代表越「典型」
  for (const a of cand) { const others = cand.filter((b) => b.subject !== a.subject); a.typ = mean(others.map((b) => dtwDistance(a.seq, b.seq))); }
  // 每人取最典型的 PER 下，再取整體最典型的 NT 人
  const bySubj = {};
  for (const a of cand) (bySubj[a.subject] ??= []).push(a);
  const picks = Object.values(bySubj).map((l) => l.sort((x, y) => x.typ - y.typ).slice(0, PER)).sort((x, y) => mean(x.map((a) => a.typ)) - mean(y.map((a) => a.typ))).slice(0, NT).flat();
  // 留一人驗證：評分某人時，模板不含這個人
  const score = (seq, subj, pool) => { const ts = pool.filter((t) => t.subject !== subj); const d = Math.min(...ts.map((t) => dtwDistance(resample(seq, N), t.seq))); return { d, s: 100 * Math.exp(-d / K) }; };
  const rows = { good: [], bad: [] };
  for (const c of cs) for (const r of c.reps) { const { d, s } = score(r.seq, c.subject, picks); rows[c.label].push({ subject: c.subject, rule: r.ruleScore, d, dtw: s, total: 0.6 * r.ruleScore + 0.4 * s }); }
  const stat = (k) => ({ good: Math.round(mean(rows.good.map((x) => x[k])) * 10) / 10, bad: Math.round(mean(rows.bad.map((x) => x[k])) * 10) / 10, auc: Math.round(auc(rows.good.map((x) => x[k]), rows.bad.map((x) => x[k])) * 1000) / 1000 });
  const goodClips = new Set(cs.filter((c) => c.label === 'good' && c.reps.length).map((c) => c.subject)).size;
  const badClips = new Set(cs.filter((c) => c.label === 'bad' && c.reps.length).map((c) => c.subject)).size;
  console.log(exId, `candidates ${cand.length} from ${Object.keys(bySubj).length} subjects; templates ${picks.length} from subjects ${[...new Set(picks.map((p) => p.subject))].join(',')}`);
  console.log(`  reps good ${rows.good.length} (${goodClips} clips) bad ${rows.bad.length} (${badClips} clips)`);
  console.log('  rule ', JSON.stringify(stat('rule')));
  console.log('  dtw  ', JSON.stringify(stat('dtw')), 'mean distance good/bad', mean(rows.good.map((x) => x.d)).toFixed(1), mean(rows.bad.map((x) => x.d)).toFixed(1));
  console.log('  total', JSON.stringify(stat('total')));
  result[exId] = { picks: picks.map((p) => ({ subject: p.subject, index: p.r.index, ruleScore: p.r.ruleScore, seq: p.seq.map((v) => v.map((a) => Math.round(a))) })), rows };
}
if (process.argv[6]) fs.writeFileSync(process.argv[6], JSON.stringify(result));
