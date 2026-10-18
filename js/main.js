import { PoseLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
import { pickSide, sideJoints, Smoother, HoldTimer, placement } from './pose-math.js';
import { RepCounter } from './rep-counter.js';
import { EXERCISES } from './exercises.js';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const MIN_VISIBILITY = 0.5;
const READY_HOLD_MS = 1000; // 在框內擺好預備姿勢要維持多久才開始計次
const INVALID_CANCEL_MS = 500; // 離開框或姿勢不對超過這麼久，丟掉進行中的這一下
const INVALID_PAUSE_MS = 3000; // 超過這麼久就暫停，要重新進框擺好姿勢才繼續
const GUIDE_MIN_GAP_MS = 2500; // 語音引導最短間隔，避免一直講
const GUIDE_REPEAT_MS = 8000; // 同一句引導多久重複一次

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

let landmarkerPromise = null;
let landmarker = null;
let exerciseId = null;
let counter = null;
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

// ---------- 頁面切換 ----------

function route() {
  const id = location.hash.slice(1);
  if (EXERCISES[id]) showWorkout(id);
  else showSelect();
}

function showSelect() {
  stopAll();
  exerciseId = null;
  $('page-workout').hidden = true;
  $('page-select').hidden = false;
}

function showWorkout(id) {
  const ex = EXERCISES[id];
  if (exerciseId !== id) {
    stopAll();
    exerciseId = id;
  }
  $('workout-title').textContent = ex.name;
  $('key-label').textContent = ex.keyLabel;
  $('tips').innerHTML = ex.tips.map((t) => `<li>${t}</li>`).join('');
  resetCounter();
  $('page-select').hidden = true;
  $('page-workout').hidden = false;
}

// ---------- 模型與鏡頭 ----------

function loadModel() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
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
  $('camera-panel').hidden = false;
  $('go').disabled = true;
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
  counter = new RepCounter({ downAngle: ex.downAngle, upAngle: ex.upAngle });
  smoother.reset();
  $('count').textContent = '0';
  $('last-min').textContent = '–';
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
  setGoButton('結束');
}

function finishSet() {
  phase = 'done';
  lockedSide = null;
  showHint('');
  setFrameState('');
  showCenter(`完成 ${counter.count} 下`, true);
  speak(`完成 ${counter.count} 下`);
  setGoButton('再一組');
}

function setGoButton(label) {
  const btn = $('go');
  btn.textContent = label;
  btn.classList.toggle('stop', label === '結束');
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

  // 計次中鎖定一側，避免左右判斷跳來跳去造成角度突變
  const side = lms ? lockedSide ?? pickSide(lms) : null;
  let m = null, joints = null, place = null;
  if (lms) {
    joints = sideJoints(lms, side, w, h);
    m = ex.measure(joints);
    place = placement(joints, box, { axis: ex.axis, fillRange: ex.fillRange, joints: ex.boxJoints });
    $('side').textContent = side === 'left' ? '偵測：左側身體' : '偵測：右側身體';
  }
  const visible = m && m.visibility >= MIN_VISIBILITY;
  const inBox = visible && place.status === 'ok';

  if (visible) {
    m.key = smoother.update('key', m.key);
    for (const k of Object.keys(m.extra)) m.extra[k] = smoother.update(k, m.extra[k]);
    showAngles(m);
  }

  if (phase === 'done') {
    drawBox(box, 'idle');
    if (lms) drawSkeleton(lms, side);
    return;
  }

  if (phase === 'ready') {
    const posed = inBox && ex.ready(m);
    const state = posed ? 'good' : inBox ? 'wait' : 'bad';
    drawBox(box, state);
    if (lms) drawSkeleton(lms, side);
    if (!inBox) drawArrow(box, place);
    setFrameState(state);
    guide(placementText(visible, place) ?? ex.readyHint, now);

    if (readyTimer.update(posed, now)) {
      phase = 'active';
      lockedSide = side;
      counter.start();
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

  if (invalidPauseTimer.update(!ok, now)) {
    // 離開太久（走去拿手機、休息等），暫停；要重新進框擺好姿勢才繼續
    counter.cancel();
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

  const rep = counter.update(m.key, now, m.extra);
  if (rep) onRep(rep, now);
  window.__app = { counter, phase, key: m.key, extra: m.extra, side, place };
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
  $('count').textContent = String(rep.index);
  $('last-min').textContent = `${Math.round(rep.minAngle)}°`;
  speak(String(rep.index));
  lastGuide = { text: '', at: now };
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
  $('key-angle').textContent = `${Math.round(m.key)}°`;
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

function speak(text) {
  if (!$('voice').checked || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-TW';
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
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

// ---------- 事件 ----------

document.querySelectorAll('.card').forEach((card) =>
  card.addEventListener('click', () => {
    location.hash = card.dataset.exercise;
    // 在點擊事件裡直接開鏡頭，iOS 才會允許
    showWorkout(card.dataset.exercise);
    openSource('camera');
  }),
);
$('back').addEventListener('click', () => {
  location.hash = '';
});
$('open-camera').addEventListener('click', () => openSource('camera'));
$('file').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) openSource(f);
  e.target.value = '';
});
$('go').addEventListener('click', () => {
  if (phase === 'done') {
    startSet();
    if (fromFile) {
      video.currentTime = 0;
      video.play();
    }
  } else if (phase === 'ready' || phase === 'active') {
    finishSet();
  }
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
route();
