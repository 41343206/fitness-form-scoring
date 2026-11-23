import { pickSide, sideJoints, worldJoints, viewAngle, weight3D, blendMeasures, Smoother, HoldTimer, placement } from './pose-math.js';
import { RepCounter, HoldTracker } from './rep-counter.js';
import { EXERCISES, repThresholds } from './exercises.js';
import { scoreRep, summarize, repSequence } from './scoring.js';

// MediaPipe 在需要時才載入：CDN 連不上時首頁仍然能顯示、選課表
const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const MIN_VISIBILITY = 0.5;
const MAX_VIEW_ANGLE = 60; // 拍攝角度偏離正側面超過這個值才提醒側身（不擋計次）
const READY_HOLD_MS = 1000; // 在框內擺好預備姿勢要維持多久才開始計次
const INVALID_CANCEL_MS = 500; // 離開框或姿勢不對超過這麼久，丟掉進行中的這一下
const INVALID_PAUSE_MS = 3000; // 超過這麼久就暫停，要重新進框擺好姿勢才繼續
const GUIDE_MIN_GAP_MS = 2500; // 語音引導最短間隔，避免一直講
const GUIDE_REPEAT_MS = 8000; // 同一句引導多久重複一次
const TEMPLATE_REPS = 3; // 錄製標準動作要做幾下
const HOLD_FEEDBACK_MS = 1000; // 棒式姿勢跑掉超過這麼久才語音提醒
const HOLD_FEEDBACK_GAP_MS = 4000; // 棒式提醒的最短間隔
const HOLD_ANNOUNCE_S = 10; // 棒式每幾秒報一次時間

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

let landmarkerPromise = null;
let landmarker = null;
let exerciseId = null;
let counter = null;
const hold = new HoldTracker(); // 棒式計時
let holdBadSince = null;
let holdLastFeedback = 0;
let holdNextAnnounce = HOLD_ANNOUNCE_S;
const smoother = new Smoother(0.5);
const readyTimer = new HoldTimer(READY_HOLD_MS);
const invalidCancelTimer = new HoldTimer(INVALID_CANCEL_MS);
const invalidPauseTimer = new HoldTimer(INVALID_PAUSE_MS);
let facingMode = 'environment';
let stream = null;
let rafId = null;
let lastVideoTime = -1;
let fpsFrames = 0;
let fpsSince = performance.now();
let fromFile = false;
let wakeLock = null;

// phase：idle（鏡頭還沒開）→ ready（等使用者進框擺好姿勢）→ active（計次中）
//        active 離框太久 → ready；按「結束」→ done；按「再一組」→ ready
let phase = 'idle';
let lockedSide = null;
let lastGuide = { text: '', at: 0 };
let results = []; // 這一組每一下的評分
let templates = []; // DTW 比對用的標準動作
let recording = null; // 錄製標準動作時的暫存：{ reps: [] }
let holdIssueFrames = {}; // 靜態動作：每種錯誤出現的幀數（結果頁換算成秒數）
let holdBadFrames = 0;
let standardStreak = 0; // 連續幾下標準，用來偶爾稱讚
let leftAfterDone = false; // 做完一組後有沒有離開過框（只做一個動作時，走回框擺好姿勢就再來一組）

// 今日課表：使用者在首頁選的動作與目標，依序做完；每做完一組就存進訓練紀錄
const HISTORY_KEY = 'history';
const HISTORY_MAX = 30;
let selection = []; // 首頁選了哪些動作：[{ id, target }]，依點選順序
let plan = null; // 進行中的課表：{ items: [{ id, target }], index, session }
let reportSession = null; // 總結頁正在看的那一次訓練

// ---------- 頁面切換 ----------

function route() {
  const id = location.hash.slice(1);
  if (EXERCISES[id]) showWorkout(id);
  else if (id === 'report' && reportSession) showReport(reportSession);
  else showSelect();
}

function showPage(name) {
  for (const p of ['select', 'workout', 'report']) $(`page-${p}`).hidden = p !== name;
}

function showSelect() {
  stopAll();
  exerciseId = null;
  plan = null;
  renderHistory();
  showPage('select');
}

function showWorkout(id) {
  if (exerciseId === id && !$('page-workout').hidden) return;
  if (exerciseId !== id) stopAll();
  // 直接打開某個動作的網址（沒有經過首頁選課表）就當作只做這一個
  if (!plan || plan.items[plan.index]?.id !== id) plan = newPlan([{ id, target: EXERCISES[id].target }]);
  setupExercise(id);
  showPage('workout');
}

// 換到某個動作：更新畫面上的名稱、目標、提示與模板（鏡頭不用重開）
function setupExercise(id) {
  const ex = EXERCISES[id];
  exerciseId = id;
  $('workout-title').textContent = ex.name;
  $('plan-step').textContent = plan && plan.items.length > 1 ? `${plan.index + 1}/${plan.items.length}` : '';
  $('key-label').textContent = ex.keyLabel;
  // 棒式：大數字是「姿勢正確的秒數」，另一欄是正確比例；不用錄標準動作
  const isHold = ex.mode === 'hold';
  $('count-unit').textContent = isHold ? '秒' : '下';
  $('last-label').textContent = isHold ? '正確比例' : '上一下';
  $('record').hidden = isHold;
  $('tips').innerHTML = ex.tips.map((t) => `<li>${t}</li>`).join('');
  templates = loadTemplates(id);
  updateRecordButton();
  resetCounter();
}

// ---------- 模型與鏡頭 ----------

function loadModel() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { PoseLandmarker, FilesetResolver } = await import(VISION_URL);
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      const options = {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
      };
      try {
        landmarker = await PoseLandmarker.createFromOptions(fileset, options);
      } catch (err) {
        // 部分手機不支援 GPU，改用 CPU
        console.warn('GPU 初始化失敗，改用 CPU', err);
        options.baseOptions.delegate = 'CPU';
        landmarker = await PoseLandmarker.createFromOptions(fileset, options);
      }
      return landmarker;
    })();
    landmarkerPromise.catch(() => {
      landmarkerPromise = null;
    });
  }
  return landmarkerPromise;
}

async function startCamera() {
  stopStream();
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  video.classList.toggle('mirror', facingMode === 'user');
  canvas.classList.toggle('mirror', facingMode === 'user');
  await video.play();
}

function stopStream() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

// 做動作時人離手機有段距離，螢幕不能自己暗掉
async function keepScreenOn() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch (err) {
    console.warn('無法保持螢幕常亮', err);
  }
}

function releaseScreen() {
  if (wakeLock) wakeLock.release();
  wakeLock = null;
}

async function openSource(source) {
  const status = $('status');
  try {
    $('open-camera').disabled = true;
    status.textContent = landmarker ? '' : '載入模型中…';
    await loadModel();
    status.textContent = '開啟中…';
    if (source === 'camera') {
      fromFile = false;
      await startCamera();
    } else {
      fromFile = true;
      stopStream();
      video.srcObject = null;
      video.src = URL.createObjectURL(source);
      video.classList.remove('mirror');
      canvas.classList.remove('mirror');
      await video.play();
    }
    status.textContent = '';
    $('camera-panel').hidden = true;
    $('go').disabled = false;
    $('record').disabled = false;
    keepScreenOn();
    startSet();
    checkOrientation();
    if (rafId === null) rafId = requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    status.textContent = err.name === 'NotAllowedError' ? '沒有鏡頭權限，請在瀏覽器設定中允許。' : `啟動失敗：${err.message}`;
  } finally {
    $('open-camera').disabled = false;
  }
}

function stopAll() {
  phase = 'idle';
  stopStream();
  releaseScreen();
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  video.pause();
  video.removeAttribute('src');
  video.srcObject = null;
  lastVideoTime = -1;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setFrameState('');
  showHint('');
  showCenter('');
  hideSummary();
  $('camera-panel').hidden = false;
  $('go').disabled = true;
  $('record').disabled = true;
  stopRecording();
  $('status').textContent = '';
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

// 伏地挺身的框是橫的，手機直放時框會很小
function checkOrientation() {
  const ex = EXERCISES[exerciseId];
  const portrait = video.videoHeight > video.videoWidth;
  if (ex.orientation === 'landscape' && portrait) {
    flashCenter('建議把手機橫放', 2500, true);
    speak('建議把手機橫放');
  }
}

// ---------- 一組的開始與結束 ----------

function resetCounter() {
  const ex = EXERCISES[exerciseId];
  counter = new RepCounter({ downAngle: ex.downAngle ?? 0, upAngle: ex.upAngle ?? 180 });
  hold.reset();
  holdBadSince = null;
  holdLastFeedback = 0;
  holdNextAnnounce = HOLD_ANNOUNCE_S;
  smoother.reset();
  $('count').textContent = '0';
  $('last-score').textContent = '–';
  delete $('last-score').dataset.standard;
  results = [];
  holdIssueFrames = {};
  holdBadFrames = 0;
  standardStreak = 0;
  const target = plan?.items[plan.index]?.target;
  $('count-target').textContent = target ? `/${target}` : '';
  $('key-angle').textContent = '–';
  $('extra').innerHTML = '';
}

function startSet() {
  resetCounter();
  phase = 'ready';
  lockedSide = null;
  readyTimer.reset();
  invalidCancelTimer.reset();
  invalidPauseTimer.reset();
  lastGuide = { text: '', at: 0 };
  showCenter('');
  hideSummary();
  setGoButton('結束');
  $('redo').hidden = true;
  $('record').hidden = EXERCISES[exerciseId].mode === 'hold';
}

function finishSet() {
  phase = 'done';
  lockedSide = null;
  leftAfterDone = false;
  showHint('');
  setFrameState('');
  stopRecording();
  readyTimer.reset();
  showCenter('');
  const ex = EXERCISES[exerciseId];
  const record = setRecord();
  if (plan) {
    plan.session.sets.push(record);
    saveSession(plan.session);
  }
  showSummary(record);
  // 人離手機有段距離，用語音唸出重點：做了多少、最需要改的地方、下一步
  let say;
  if (ex.mode === 'hold') {
    say = `維持 ${record.totalSec} 秒，姿勢正確 ${record.goodSec} 秒`;
  } else {
    say = `完成 ${record.count} 下`;
    if (record.count) say += `，標準 ${record.standard} 下，平均 ${record.avg} 分`;
  }
  const top = record.issues.find((i) => i.id !== 'overall');
  say += top ? `。最需要注意${top.label}，${top.feedback}` : record.count || record.goodSec ? '。動作很標準，做得好' : '';
  const next = nextItem();
  if (next) say += `。下一個是${EXERCISES[next.id].name}，請到手機按下一個`;
  speak(say);
  updateDoneButtons();
}

// 這一組的紀錄（存進訓練紀錄、顯示在結果頁）
function setRecord() {
  const ex = EXERCISES[exerciseId];
  const base = { id: exerciseId, name: ex.name, mode: ex.mode ?? 'reps', target: plan?.items[plan.index]?.target ?? null, at: new Date().toISOString() };
  if (ex.mode === 'hold') {
    const badMs = hold.totalMs - hold.goodMs;
    const issues = Object.values(holdIssueFrames)
      .map((it) => ({ ...it, seconds: Math.round((badMs * it.frames) / Math.max(1, holdBadFrames) / 1000) }))
      .filter((it) => it.seconds >= 1)
      .sort((a, b) => b.seconds - a.seconds)
      .map(({ frames, ...it }) => it);
    return { ...base, totalSec: Math.round(hold.totalMs / 1000), goodSec: Math.round(hold.goodMs / 1000), percent: hold.percent(), issues };
  }
  const sum = summarize(results);
  return {
    ...base,
    count: counter.count,
    standard: sum.standard,
    nonStandard: sum.nonStandard,
    avg: sum.avg,
    issues: sum.issues,
    reps: results.map((r) => ({
      index: r.index,
      score: r.score,
      standard: r.standard,
      dtwScore: r.dtwScore,
      lost: r.parts.filter((p) => p.fraction < 1).map((p) => ({ label: p.label, points: Math.round(p.weight * (1 - p.fraction)) })),
    })),
  };
}

// 有沒有做了東西：自動結束只在做過至少一下（棒式至少 1 秒）之後才觸發
function hasProgress() {
  return EXERCISES[exerciseId].mode === 'hold' ? hold.goodMs >= 1000 : counter.count > 0;
}

// 做完一組的結果（錄影頁上）：上面是總結，接著是「哪裡要改」，最後列出每一下的分數與扣分
function showSummary(record) {
  const el = $('summary');
  el.innerHTML = setHTML(record);
  el.scrollTop = 0;
  el.hidden = false;
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 一組的結果 HTML，錄影頁和總結頁共用
function setHTML(r, { title = false } = {}) {
  const head = [];
  if (r.mode === 'hold') {
    head.push(`<div class="sum-big">維持 ${r.totalSec} 秒</div>`);
    head.push(`<div>姿勢正確 ${r.goodSec} 秒（${r.percent}%）${r.target ? ` · 目標 ${r.target} 秒` : ''}</div>`);
  } else {
    head.push(`<div class="sum-big">完成 ${r.count} 下</div>`);
    if (r.count) head.push(`<div>標準 ${r.standard} 下 · 不標準 ${r.nonStandard} 下 · 平均 ${r.avg} 分</div>`);
    else if (r.target) head.push(`<div>目標 ${r.target} 下</div>`);
  }
  let coach;
  if (r.issues.length) {
    coach = `<div class="coach"><h3>要改進的地方</h3>${r.issues
      .map(
        (i) =>
          `<div class="issue"><div class="issue-head"><b>${esc(i.label)}</b><span>${r.mode === 'hold' ? `${i.seconds} 秒` : `${i.times} 下`}</span></div>` +
          `<div class="issue-cue">「${esc(i.feedback)}」</div><p>${esc(i.tip)}</p></div>`,
      )
      .join('')}</div>`;
  } else if (r.count || r.goodSec) {
    coach = `<div class="coach good"><h3>做得很好</h3><p>每一下都符合標準，保持這個姿勢和速度。</p></div>`;
  } else {
    coach = '';
  }
  const rows = (r.reps ?? [])
    .map((rep) => {
      const lost = rep.lost.map((l) => `${l.label} −${l.points}`);
      if (rep.dtwScore !== null) lost.push(`動作曲線 ${rep.dtwScore} 分`);
      return `<li class="${rep.standard ? 'ok' : 'ng'}"><span class="sum-idx">第 ${rep.index} 下</span><b>${rep.score} 分</b><span class="sum-tag">${rep.standard ? '標準' : '不標準'}</span><span class="sum-detail">${esc(lost.join(' · ') || '沒有扣分')}</span></li>`;
    })
    .join('');
  const list = rows ? `<details class="sum-details"${title ? '' : ' open'}><summary>每一下的分數</summary><ol class="sum-reps">${rows}</ol></details>` : '';
  const name = title ? `<h3 class="set-name">${esc(r.name)}</h3>` : '';
  return `${name}<div class="sum-head">${head.join('')}</div>${coach}${list}`;
}

function hideSummary() {
  $('summary').hidden = true;
}

function setGoButton(label) {
  const btn = $('go');
  btn.textContent = label;
  btn.classList.toggle('stop', label === '結束');
}

// 課表的下一個動作（沒有就回傳 null）
function nextItem() {
  return plan && plan.index < plan.items.length - 1 ? plan.items[plan.index + 1] : null;
}

// 做完一組後的按鈕：主按鈕是「下一個動作」或「看今日總結」，旁邊是「再一組」
function updateDoneButtons() {
  const next = nextItem();
  setGoButton(next ? `下一個：${EXERCISES[next.id].name}` : '看今日總結');
  $('record').hidden = true;
  $('redo').hidden = false;
}

// ---------- 每一幀 ----------

function loop() {
  rafId = requestAnimationFrame(loop);
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const now = performance.now();
  const result = landmarker.detectForVideo(video, now);
  handleResult(result, now);
  updateFps(now);
  if (fromFile && video.ended && (phase === 'ready' || phase === 'active')) finishSet();
}

function handleResult(result, now) {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const ex = EXERCISES[exerciseId];
  const box = ex.box(w, h);
  const lms = result.landmarks?.[0];
  const world = result.worldLandmarks?.[0];

  // 計次中鎖定一側，避免左右判斷跳來跳去造成角度突變
  const side = lms ? lockedSide ?? pickSide(lms) : null;
  let m = null, joints = null, place = null;
  if (lms) {
    // 正側面用 2D 像素座標算角度最準；手機沒對準側面時，2D 會變形，逐漸改用 3D 世界座標
    joints = sideJoints(lms, side, w, h);
    const view = world ? viewAngle(world) : null;
    const w3 = weight3D(view);
    m = blendMeasures(ex.measure(joints), world && ex.measure(worldJoints(world, lms, side)), w3);
    m.view = view;
    // 斜拍時多用 3D，3D 會把伸直的腿量得比較彎，所以計次門檻跟著放寬（平滑避免門檻跳動）
    const th = repThresholds(ex, smoother.update('w3', w3));
    m.upAt = th.up;
    if (counter) {
      counter.downAngle = th.down;
      counter.upAngle = th.up;
    }
    place = placement(joints, box, { axis: ex.axis, fillRange: ex.fillRange, joints: ex.boxJoints });
    $('side').textContent =
      (side === 'left' ? '偵測：左側身體' : '偵測：右側身體') + (m.view === null ? '' : ` · 拍攝角度 ${Math.round(m.view)}°`);
  }
  const visible = m && m.visibility >= MIN_VISIBILITY;
  const inBox = visible && place.status === 'ok';

  if (visible) {
    m.key = smoother.update('key', m.key);
    for (const k of Object.keys(m.extra)) m.extra[k] = smoother.update(k, m.extra[k]);
    showAngles(m);
  }

  if (phase === 'done') {
    // 只做一個動作時：看完結果、離開框再走回來擺好預備姿勢，就自動再來一組。
    // 課表還有下一個動作時不自動開始（下一個動作可能要換手機方向），要按「下一個」。
    if (!inBox) leftAfterDone = true;
    const auto = !fromFile && leftAfterDone && !nextItem();
    const posed = auto && inBox && ex.ready(m);
    drawBox(box, posed ? 'good' : 'idle');
    if (lms) drawSkeleton(lms, side);
    if (readyTimer.update(posed, now)) startSet();
    return;
  }

  if (phase === 'ready') {
    const posed = inBox && ex.ready(m);
    const state = posed ? 'good' : inBox ? 'wait' : 'bad';
    drawBox(box, state);
    if (lms) drawSkeleton(lms, side);
    if (!inBox) drawArrow(box, place);
    setFrameState(state);
    guide(placementText(visible, place) ?? viewText(m) ?? ex.readyHint, now);

    if (readyTimer.update(posed, now)) {
      phase = 'active';
      lockedSide = side;
      counter.start();
      hold.start(now);
      invalidCancelTimer.reset();
      invalidPauseTimer.reset();
      showHint('');
      flashCenter('開始');
      speak('開始');
      lastGuide = { text: '開始', at: now };
    }
    return;
  }

  // phase === 'active'：人要在框內、姿勢合理才計次
  const ok = inBox && ex.valid(m);
  drawBox(box, ok ? 'active' : 'bad');
  if (lms) drawSkeleton(lms, side);
  if (!inBox) drawArrow(box, place);
  setFrameState(ok ? 'active' : 'bad');

  if (!ok) hold.skip(now); // 不在定位的時間不算進棒式
  if (invalidPauseTimer.update(!ok, now)) {
    counter.cancel();
    // 做完離開框（走去拿手機）超過 3 秒：自動結束並唸出總結，不用走回去按「結束」
    if (hasProgress()) {
      finishSet();
      return;
    }
    // 還沒做任何一下就離開：暫停，要重新進框擺好姿勢才繼續
    phase = 'ready';
    lockedSide = null;
    readyTimer.reset();
    speak('暫停');
    lastGuide = { text: '暫停', at: now };
    return;
  }
  if (invalidCancelTimer.update(!ok, now)) {
    counter.cancel();
    showHint(placementText(visible, place) ?? '姿勢跑掉了，這下不算');
    return;
  }
  if (!ok) return;
  showHint('');

  if (ex.mode === 'hold') {
    handleHold(ex, m, now);
    window.__app = { hold, phase, key: m.key, side, place };
    return;
  }

  const rep = counter.update(m.key, now, { ...m.extra, ...m.track });
  if (rep) onRep(rep, now);
  window.__app = { counter, phase, key: m.key, extra: m.extra, side, place };
}

// 棒式：累計姿勢正確的秒數；姿勢跑掉一陣子才提醒，每 10 秒報一次時間
function handleHold(ex, m, now) {
  const good = ex.holdGood(m);
  hold.update(good, now);
  const secs = Math.floor(hold.goodMs / 1000);
  $('count').textContent = String(secs);
  $('last-score').textContent = `${hold.percent()}%`;
  if (good) {
    holdBadSince = null;
  } else {
    if (holdBadSince === null) holdBadSince = now;
    const issue = ex.holdFeedback(m);
    holdBadFrames += 1;
    (holdIssueFrames[issue.id] ??= { ...issue, frames: 0 }).frames += 1;
    showHint(issue.feedback);
    if (now - holdBadSince >= HOLD_FEEDBACK_MS && now - holdLastFeedback >= HOLD_FEEDBACK_GAP_MS) {
      speak(issue.feedback);
      holdLastFeedback = now;
    }
  }
  const target = plan?.items[plan.index]?.target;
  if (target && secs >= target) {
    finishSet();
    return;
  }
  if (secs >= holdNextAnnounce) {
    speak(target ? `${secs} 秒，還有 ${target - secs} 秒` : `${secs} 秒`);
    holdNextAnnounce += HOLD_ANNOUNCE_S;
  }
}

// 角度用 3D 算，偏一點沒關係；偏太多時另一側被擋住，關節點會不準，才提醒
function viewText(m) {
  if (m?.view > MAX_VIEW_ANGLE) return '請再側身一點，讓側面對著鏡頭';
  return null;
}

function placementText(visible, place) {
  if (!visible) return '請站進框框裡，讓全身入鏡';
  switch (place.status) {
    case 'tooClose': return '請往後退一點';
    case 'tooFar': return '請靠近鏡頭一點';
    case 'off': return '請移到框框中間';
    default: return null;
  }
}

// 畫面文字＋語音引導；語音有間隔限制，避免一直講
function guide(text, now) {
  showHint(text);
  const changed = text !== lastGuide.text;
  const gap = now - lastGuide.at;
  if ((changed && gap >= GUIDE_MIN_GAP_MS) || gap >= GUIDE_REPEAT_MS) {
    speak(text);
    lastGuide = { text, at: now };
  }
}

function onRep(rep, now) {
  const ex = EXERCISES[exerciseId];
  $('count').textContent = String(rep.index);
  lastGuide = { text: '', at: now };

  if (recording) {
    // 錄製標準動作：只收規則部分完全沒問題的那幾下，存成 DTW 模板
    const check = scoreRep(ex, rep, []);
    if (!check.standard) {
      speak(`這下不標準，不列入，${check.feedback?.feedback ?? '再做一次'}`);
      return;
    }
    recording.reps.push(repSequence(ex, rep));
    if (recording.reps.length >= TEMPLATE_REPS) {
      templates = recording.reps;
      saveTemplates(exerciseId, templates);
      stopRecording();
      updateRecordButton();
      speak('標準動作已儲存');
    } else {
      showRecording();
      speak(`收到 ${recording.reps.length} 下`);
    }
    return;
  }

  const result = scoreRep(ex, rep, templates);
  results.push({ ...result, index: rep.index });
  $('last-score').textContent = `${result.score} 分`;
  $('last-score').dataset.standard = result.standard ? 'yes' : 'no';
  window.__results = results;
  const target = plan?.items[plan.index]?.target;
  if (target && rep.index >= target) {
    finishSet(); // 到目標次數自動結束，總結裡會講這一下
    return;
  }
  // 每一下報數；有問題就講這個動作專屬的提示，連續 3 下標準就稱讚一次
  standardStreak = result.standard ? standardStreak + 1 : 0;
  let say = String(rep.index);
  if (result.feedback) say += `，${result.feedback.feedback}`;
  else if (!result.standard) say += '，動作再完整一點';
  else if (standardStreak % 3 === 0) say += '，很好，保持';
  speak(say);
}

// ---------- 標準動作（DTW 模板） ----------

// 自己錄的存在瀏覽器裡（localStorage），會取代內建的模板
function loadTemplates(id) {
  try {
    const saved = JSON.parse(localStorage.getItem(`template:${id}`));
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {
    // 讀不到就用預設
  }
  // 沒錄過就用內建的資料集標準動作；沒有內建的用理想曲線；棒式（計時）不用模板
  const ex = EXERCISES[id];
  if (ex.builtinTemplates?.length) return ex.builtinTemplates;
  return ex.defaultTemplate ? [ex.defaultTemplate()] : [];
}

function saveTemplates(id, t) {
  try {
    localStorage.setItem(`template:${id}`, JSON.stringify(t));
  } catch (err) {
    console.warn('無法儲存標準動作', err);
  }
}

function hasCustomTemplate(id) {
  try {
    return !!localStorage.getItem(`template:${id}`);
  } catch {
    return false;
  }
}

function updateRecordButton() {
  $('record').textContent = recording ? '取消錄製' : hasCustomTemplate(exerciseId) ? '重錄標準' : '錄標準動作';
}

function startRecording() {
  recording = { reps: [] };
  showRecording();
  updateRecordButton();
  speak(`請做 ${TEMPLATE_REPS} 下標準動作`);
}

function stopRecording() {
  recording = null;
  $('rec').hidden = true;
  if (exerciseId) updateRecordButton();
}

function showRecording() {
  $('rec').hidden = false;
  $('rec').textContent = `● 錄製標準動作 ${recording.reps.length}/${TEMPLATE_REPS}`;
}

// ---------- 畫面 ----------

const STATE_COLORS = {
  bad: '#ff5a5f',
  wait: '#ffb020',
  good: '#3ddc84',
  active: '#3ddc84',
  idle: 'rgba(255,255,255,0.5)',
};

// 整個畫面外圈變色，離手機遠也看得到
function setFrameState(state) {
  $('stage').dataset.state = state;
}

function drawBox(box, state) {
  const lw = Math.max(4, canvas.width / 120);
  ctx.save();
  ctx.strokeStyle = STATE_COLORS[state];
  ctx.lineWidth = lw;
  ctx.setLineDash(state === 'active' ? [] : [lw * 3, lw * 2]);
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.restore();
}

// 大箭頭：指出要往哪個方向移動（畫面座標）
function drawArrow(box, place) {
  if (!place) return;
  let dx = place.dx, dy = place.dy;
  if (place.status !== 'off' || (dx === 0 && dy === 0)) return;
  const len = Math.hypot(dx, dy);
  dx /= len;
  dy /= len;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const size = Math.min(box.w, box.h) * 0.35;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.atan2(dy, dx));
  ctx.fillStyle = 'rgba(255,90,95,0.85)';
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(0, -size * 0.6);
  ctx.lineTo(0, -size * 0.25);
  ctx.lineTo(-size, -size * 0.25);
  ctx.lineTo(-size, size * 0.25);
  ctx.lineTo(0, size * 0.25);
  ctx.lineTo(0, size * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function showAngles(m) {
  const show = EXERCISES[exerciseId].showKey;
  $('key-angle').textContent = `${Math.round(show ? show(m.key) : m.key)}°`;
  $('extra').innerHTML = Object.entries(m.extra)
    .map(([k, v]) => `<div><span>${k}</span><b>${Number.isFinite(v) ? Math.round(v) + '°' : '–'}</b></div>`)
    .join('');
}

function showHint(text) {
  $('hint').textContent = text;
}

function showCenter(text, small = false) {
  const el = $('center');
  el.textContent = text;
  el.classList.toggle('small', small);
  el.hidden = !text;
}

function flashCenter(text, ms = 800, small = false) {
  showCenter(text, small);
  setTimeout(() => {
    if ($('center').textContent === text) showCenter('');
  }, ms);
}

// 語音：
// - iPhone Safari 一定要在「點擊」裡先講過一次，之後從畫面迴圈呼叫才會有聲音（unlockSpeech）
// - 指定中文語音，避免手機預設用英文語音唸中文而沒聲音
// - Chrome 在 cancel() 後立刻 speak() 有時會被吃掉，所以稍微延後
let zhVoice = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  zhVoice =
    vs.find((v) => /zh[-_]TW/i.test(v.lang)) ??
    vs.find((v) => /zh[-_](HK|Hant)/i.test(v.lang)) ??
    vs.find((v) => /^zh/i.test(v.lang)) ??
    null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

function utter(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = zhVoice?.lang ?? 'zh-TW';
  if (zhVoice) u.voice = zhVoice;
  return u;
}

let speechUnlocked = false;
function unlockSpeech() {
  if (speechUnlocked || !('speechSynthesis' in window) || !$('voice').checked) return;
  speechUnlocked = true;
  const u = utter('語音已開啟');
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

function speak(text) {
  if (!$('voice').checked || !('speechSynthesis' in window)) return;
  const u = utter(text);
  if (speechSynthesis.speaking || speechSynthesis.pending) {
    speechSynthesis.cancel();
    setTimeout(() => speechSynthesis.speak(u), 60);
  } else {
    speechSynthesis.resume();
    speechSynthesis.speak(u);
  }
}

function updateFps(now) {
  fpsFrames += 1;
  if (now - fpsSince >= 1000) {
    $('fps').textContent = `· ${Math.round((fpsFrames * 1000) / (now - fpsSince))} FPS`;
    fpsFrames = 0;
    fpsSince = now;
  }
}

const BONES = [
  ['Shoulder', 'Elbow'], ['Elbow', 'Wrist'], ['Shoulder', 'Hip'], ['Hip', 'Knee'],
  ['Knee', 'Ankle'], ['Ankle', 'Heel'], ['Heel', 'FootIndex'], ['Ankle', 'FootIndex'], ['Ear', 'Shoulder'],
];
const IDX = {
  Ear: [7, 8], Shoulder: [11, 12], Elbow: [13, 14], Wrist: [15, 16], Hip: [23, 24],
  Knee: [25, 26], Ankle: [27, 28], Heel: [29, 30], FootIndex: [31, 32],
};

function drawSkeleton(lms, activeSide) {
  const w = canvas.width, h = canvas.height;
  const lw = Math.max(2, w / 200);
  for (const side of ['left', 'right']) {
    const i = side === 'left' ? 0 : 1;
    const active = side === activeSide;
    ctx.strokeStyle = active ? '#3ddc84' : 'rgba(255,255,255,0.6)';
    ctx.lineWidth = active ? lw * 1.6 : lw;
    for (const [a, b] of BONES) {
      const p = lms[IDX[a][i]], q = lms[IDX[b][i]];
      ctx.beginPath();
      ctx.moveTo(p.x * w, p.y * h);
      ctx.lineTo(q.x * w, q.y * h);
      ctx.stroke();
    }
    if (active) {
      ctx.fillStyle = '#ffffff';
      for (const name of Object.keys(IDX)) {
        const p = lms[IDX[name][i]];
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, lw * 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

// ---------- 首頁：今日課表與訓練紀錄 ----------

const TARGET_STEP = { reps: 2, hold: 10 };
const TARGET_RANGE = { reps: [2, 50], hold: [10, 180] };
const kind = (id) => (EXERCISES[id].mode === 'hold' ? 'hold' : 'reps');
const unit = (id) => (kind(id) === 'hold' ? '秒' : '下');

function newPlan(items) {
  return { items: items.map((it) => ({ ...it })), index: 0, session: { at: new Date().toISOString(), sets: [] } };
}

function renderCards() {
  try {
    const saved = JSON.parse(localStorage.getItem('selection'));
    if (Array.isArray(saved)) selection = saved.filter((it) => EXERCISES[it.id] && Number.isFinite(it.target));
  } catch {
    // 讀不到就從空的開始
  }
  $('cards').innerHTML = Object.entries(EXERCISES)
    .map(
      ([id, ex]) => `
      <div class="card-wrap" data-exercise="${id}">
        <button class="card" aria-pressed="false">
          <span class="card-media">
            <img src="${ex.card.image}" alt="${ex.name}示範照片">
            <span class="chip">${ex.card.chip}</span>
            <span class="pick"></span>
          </span>
          <span class="card-title">${ex.name}</span>
          <span class="card-desc">${ex.card.desc}</span>
        </button>
        <div class="target" hidden>
          <span>目標</span>
          <button class="step" data-d="-1" aria-label="減少">−</button>
          <b class="target-value"></b>
          <button class="step" data-d="1" aria-label="增加">＋</button>
        </div>
      </div>`,
    )
    .join('');
  for (const wrap of document.querySelectorAll('.card-wrap')) {
    const id = wrap.dataset.exercise;
    wrap.querySelector('.card').addEventListener('click', () => {
      const i = selection.findIndex((it) => it.id === id);
      if (i >= 0) selection.splice(i, 1);
      else selection.push({ id, target: EXERCISES[id].target });
      renderSelection();
    });
    for (const b of wrap.querySelectorAll('.step')) {
      b.addEventListener('click', () => {
        const it = selection.find((x) => x.id === id);
        if (!it) return;
        const [lo, hi] = TARGET_RANGE[kind(id)];
        it.target = Math.min(hi, Math.max(lo, it.target + Number(b.dataset.d) * TARGET_STEP[kind(id)]));
        renderSelection();
      });
    }
  }
  renderSelection();
}

function renderSelection() {
  for (const wrap of document.querySelectorAll('.card-wrap')) {
    const id = wrap.dataset.exercise;
    const i = selection.findIndex((it) => it.id === id);
    const on = i >= 0;
    wrap.classList.toggle('selected', on);
    wrap.querySelector('.card').setAttribute('aria-pressed', String(on));
    wrap.querySelector('.pick').textContent = on ? `✓ 第 ${i + 1} 個` : '';
    wrap.querySelector('.target').hidden = !on;
    if (on) wrap.querySelector('.target-value').textContent = `${selection[i].target} ${unit(id)}`;
  }
  const btn = $('start-plan');
  btn.disabled = selection.length === 0;
  btn.textContent = selection.length
    ? `開始訓練：${selection.map((it) => EXERCISES[it.id].name).join('、')}`
    : '選好動作就可以開始';
  try {
    localStorage.setItem('selection', JSON.stringify(selection));
  } catch {
    // 存不了就算了，只是下次要重選
  }
}

// 訓練紀錄存在這支手機的瀏覽器（localStorage），不會上傳；之後若加上帳號，可以改存到雲端（見 docs/plan.md）
function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY));
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

function saveSession(session) {
  if (!session.sets.length) return;
  const h = loadHistory().filter((x) => x.at !== session.at);
  h.unshift(session);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, HISTORY_MAX)));
  } catch (err) {
    console.warn('無法儲存訓練紀錄', err);
  }
}

const fmtTime = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 一次訓練的一句話摘要：做了哪些動作、標準比例
function sessionLine(session) {
  const names = [...new Set(session.sets.map((r) => r.name))].join('、');
  const reps = session.sets.filter((r) => r.mode !== 'hold');
  const total = reps.reduce((n, r) => n + r.count, 0);
  const std = reps.reduce((n, r) => n + r.standard, 0);
  return total ? `${names} · 標準 ${std}/${total} 下` : names;
}

function renderHistory() {
  const h = loadHistory();
  $('history').hidden = h.length === 0;
  $('history-list').innerHTML = h
    .map((s, i) => `<li><button class="history-item" data-i="${i}"><span>${fmtTime(s.at)}</span><span>${esc(sessionLine(s))}</span></button></li>`)
    .join('');
  for (const b of document.querySelectorAll('.history-item')) {
    b.addEventListener('click', () => {
      reportSession = h[Number(b.dataset.i)];
      location.hash = 'report';
    });
  }
}

// 總結頁：這次訓練每個動作做得如何、哪裡要改
function showReport(session) {
  const reps = session.sets.filter((r) => r.mode !== 'hold');
  const total = reps.reduce((n, r) => n + r.count, 0);
  const std = reps.reduce((n, r) => n + r.standard, 0);
  const head = [`<div class="report-date">${fmtTime(session.at)}</div>`, `<div class="sum-big">完成 ${session.sets.length} 組動作</div>`];
  if (total) head.push(`<div>總共 ${total} 下，標準 ${std} 下（${Math.round((100 * std) / total)}%）</div>`);
  $('report').innerHTML =
    `<div class="sum-head">${head.join('')}</div>` +
    session.sets.map((r) => `<section class="set">${setHTML(r, { title: true })}</section>`).join('') +
    '<p class="report-note">這份紀錄只存在這支手機的瀏覽器裡，不會上傳；回到首頁的「訓練紀錄」可以再打開。</p>';
  showPage('report');
  $('report').scrollTop = 0;
}

// ---------- 事件 ----------

// 手機橫放時網址列會佔掉很多高度，支援的瀏覽器（Android Chrome）進入全螢幕；iPhone Safari 不支援就略過
function enterFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || !el.requestFullscreen) return;
  el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}
function exitFullscreen() {
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
}

$('start-plan').addEventListener('click', () => {
  if (!selection.length) return;
  enterFullscreen();
  unlockSpeech();
  plan = newPlan(selection);
  const id = plan.items[0].id;
  // 先設定好再改網址，route() 看到同一個動作就不會重設
  stopAll();
  setupExercise(id);
  showPage('workout');
  location.hash = id;
  // 在點擊事件裡直接開鏡頭，iOS 才會允許
  openSource('camera');
});
$('report-back').addEventListener('click', () => {
  location.hash = '';
});
$('back').addEventListener('click', () => {
  exitFullscreen();
  location.hash = '';
});
$('open-camera').addEventListener('click', () => {
  enterFullscreen();
  unlockSpeech();
  openSource('camera');
});
$('file').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) openSource(f);
  e.target.value = '';
});
$('go').addEventListener('click', () => {
  if (phase === 'done') {
    if (nextItem()) goNext();
    else finishPlan();
  } else if (phase === 'ready' || phase === 'active') {
    finishSet();
  }
});
$('redo').addEventListener('click', () => {
  if (phase !== 'done') return;
  startSet();
  restartFile();
});

function restartFile() {
  if (fromFile) {
    video.currentTime = 0;
    video.play();
  }
}

// 課表的下一個動作：鏡頭繼續開著，只換動作
function goNext() {
  plan.index += 1;
  const id = plan.items[plan.index].id;
  setupExercise(id);
  location.hash = id;
  startSet();
  restartFile();
  checkOrientation();
  const ex = EXERCISES[id];
  flashCenter(ex.name, 1500, true);
  speak(`${ex.name}，${ex.readyHint}`);
}

// 課表做完：到總結頁
function finishPlan() {
  const session = plan.session;
  saveSession(session);
  stopAll();
  plan = null;
  exerciseId = null;
  reportSession = session;
  location.hash = 'report';
  showReport(session);
}
$('record').addEventListener('click', () => {
  if (recording) {
    stopRecording();
    return;
  }
  if (phase === 'done') startSet();
  startRecording();
});
$('flip').addEventListener('click', async () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  if (stream) {
    try {
      await startCamera();
    } catch (err) {
      console.error(err);
    }
  }
});
// 切到別的 App 再回來時，螢幕常亮會被取消，要重新要求
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && phase !== 'idle') keepScreenOn();
});
window.addEventListener('hashchange', route);

if (!window.isSecureContext) {
  $('model-status').textContent = '需要 HTTPS 才能開啟鏡頭（本機測試請用 localhost）。';
}
// 在選動作的時候就先載入模型，進到錄影頁比較快
loadModel().catch((err) => {
  console.error(err);
  $('model-status').textContent = `模型載入失敗：${err.message}`;
});
renderCards();
route();
$('voice').addEventListener('change', () => {
  speechUnlocked = false;
  unlockSpeech();
});
