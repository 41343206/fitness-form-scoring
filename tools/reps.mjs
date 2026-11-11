// 用 App 本身的程式（關節點→角度→計次→評分）處理資料集的關節點檔，輸出每一下的資料
import fs from 'node:fs';
const APP = new URL('../js/', import.meta.url).href;
const { sideJoints, worldJoints, viewAngle, weight3D, blendMeasures, Smoother, HoldTimer, pickSide } = await import(APP + 'pose-math.js');
const { RepCounter } = await import(APP + 'rep-counter.js');
const { EXERCISES } = await import(APP + 'exercises.js');
const { scoreRep, repSequence } = await import(APP + 'scoring.js');

const [dir, outFile] = process.argv.slice(2);
const out = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
  const d = JSON.parse(fs.readFileSync(dir + '/' + f));
  const m0 = f.match(/subject_(\d+)_(squat|push_up)_(good|bad)_side/);
  if (!m0) continue;
  const [, subject, exName, label] = m0;
  const exId = exName === 'push_up' ? 'pushup' : 'squat';
  const ex = EXERCISES[exId];
  const frames = d.frames.filter((x) => x.l);
  if (frames.length < 10) { out.push({ file: f, subject, exId, label, reps: [], note: 'no pose' }); continue; }
  // 整支影片鎖定一側：取可見度平均較高的那側
  const votes = frames.reduce((s, x) => s + (pickSide(x.l.map((p) => ({ visibility: p[3] }))) === 'left' ? 1 : -1), 0);
  const side = votes >= 0 ? 'left' : 'right';
  const smoother = new Smoother(0.5);
  const counter = new RepCounter({ downAngle: ex.downAngle, upAngle: ex.upAngle });
  const cancelTimer = new HoldTimer(500);
  const reps = [];
  let views = [];
  for (const x of d.frames) {
    if (!x.l) { if (cancelTimer.update(true, x.t)) counter.cancel(); continue; }
    const lms = x.l.map((p) => ({ x: p[0], y: p[1], z: p[2], visibility: p[3] }));
    const world = x.w.map((p) => ({ x: p[0], y: p[1], z: p[2] }));
    const j = sideJoints(lms, side, d.width, d.height);
    const view = viewAngle(world);
    views.push(view);
    const m = blendMeasures(ex.measure(j), ex.measure(worldJoints(world, lms, side)), weight3D(view));
    const ok = m.visibility >= 0.5 && ex.valid(m);
    if (!ok) { if (cancelTimer.update(true, x.t)) counter.cancel(); continue; }
    cancelTimer.update(false, x.t);
    m.key = smoother.update('key', m.key);
    for (const k of Object.keys(m.extra)) m.extra[k] = smoother.update(k, m.extra[k]);
    const rep = counter.update(m.key, x.t, m.extra);
    if (rep) {
      const s = scoreRep(ex, rep, []);
      reps.push({ index: rep.index, minAngle: rep.minAngle, durationMs: rep.durationMs, descentMs: rep.descentMs,
        ruleScore: s.ruleScore, parts: Object.fromEntries(s.parts.map((p) => [p.id, Math.round(p.value * 10) / 10])),
        feedback: s.feedback?.id ?? null, seq: repSequence(ex, rep).map((v) => v.map((a) => Math.round(a * 10) / 10)),
        frames: rep.frames.map((fr) => Object.fromEntries(Object.entries(fr).filter(([k]) => k !== 't').map(([k, v]) => [k, Math.round(v * 10) / 10]))) });
    }
  }
  views.sort((a, b) => a - b);
  out.push({ file: f, subject, exId, label, side, medianView: Math.round(views[views.length >> 1]), reps });
}
fs.writeFileSync(outFile, JSON.stringify(out));
for (const c of out) console.log(c.exId, c.label, c.subject, 'view', c.medianView, 'reps', c.reps.length, c.reps.map((r) => r.ruleScore).join(','), c.note ?? '');
