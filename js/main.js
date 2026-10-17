import { PoseLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
import { pickSide, sideJoints, Smoother, HoldTimer, bodyScale, stillInPlace } from './pose-math.js';
import { RepCounter } from './rep-counter.js';
import { EXERCISES } from './exercises.js';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const MIN_VISIBILITY = 0.5;
const COUNTDOWN_SEC = 5; // 按開始後，留時間把手機放好、走到定位
const READY_HOLD_MS = 1000; // 預備姿勢要維持多久才開始計次
const INVALID_CANCEL_MS = 500; // 姿勢不對超過這麼久，丟掉進行中的這一下
const INVALID_PAUSE_MS = 3000; // 姿勢不對超過這麼久，回到「等待預備姿勢」

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

// phase：preview（只顯示骨架）→ countdown → ready（等預備姿勢）→ active（計次中）→ preview
let phase = 'preview';
let lockedSide = null;
let anchor = null; // 開始計次時的位置與身體大小
let countdownTimer = null;

// ---------- 頁面切換 ----------

function route() {
  const id = location.hash.slice(1);
  if (EXERCISES[id]) {
    showWorkout(id);
  } else {
    showSelect();
  }
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
      // 影片測試不需要倒數，直接等預備姿勢
      startSession(0);
    }
    status.textContent = '';
    $('camera-panel').hidden = true;
    $('go').disabled = false;
    if (rafId === null) rafId = requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    status.textContent = err.name === 'NotAllowedError' ? '沒有鏡頭權限，請在瀏覽器設定中允許。' : `啟動失敗：${err.message}`;
  } finally {
    $('open-camera').disabled = false;
  }
}

function stopAll() {
  stopSession();
  stopStream();
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  video.pause();
  video.removeAttribute('src');
  video.srcObject = null;
  lastVideoTime = -1;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $('camera-panel').hidden = false;
  $('go').disabled = true;
  $('status').textContent = '';
}

// ---------- 開始 / 結束一組 ----------

function resetCounter() {
  const ex = EXERCISES[exerciseId];
  counter = new RepCounter({ downAngle: ex.downAngle, upAngle: ex.upAngle });
  smoother.reset();
  $('count').textContent = '0';
  $('last-min').textContent = '–';
  $('key-angle').textContent = '–';
  $('extra').innerHTML = '';
}

function startSession(countdownSec = COUNTDOWN_SEC) {
  resetCounter();
  lockedSide = null;
  readyTimer.reset();
  invalidCancelTimer.reset();
  invalidPauseTimer.reset();
  setGoButton(true);

  if (countdownSec <= 0) {
    phase = 'ready';
    showCenter('');
    return;
  }
  phase = 'countdown';
  let left = countdownSec;
  showCenter(String(left));
  countdownTimer = setInterval(() => {
    left -= 1;
    if (left > 0) {
      showCenter(String(left));
    } else {
      clearInterval(countdownTimer);
      countdownTimer = null;
      phase = 'ready';
      showCenter('');
    }
  }, 1000);
}

function stopSession() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  const wasActive = phase === 'active' || phase === 'ready';
  phase = 'preview';
  lockedSide = null;
  setGoButton(false);
  showHint('');
  if (wasActive && counter) showCenter(`完成 ${counter.count} 下`, true);
  else showCenter('');
}

function setGoButton(running) {
  const btn = $('go');
  btn.textContent = running ? '結束' : '開始';
  btn.classList.toggle('stop', running);
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
  if (fromFile && video.ended && phase !== 'preview') stopSession();
}

function handleResult(result, now) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const ex = EXERCISES[exerciseId];
  const lms = result.landmarks?.[0];

  // 計次中鎖定一側，避免左右判斷跳來跳去造成角度突變
  const side = lms ? lockedSide ?? pickSide(lms) : null;
  let m = null;
  let joints = null;
  if (lms) {
    drawSkeleton(lms, side);
    joints = sideJoints(lms, side, canvas.width, canvas.height);
    m = ex.measure(joints);
    $('side').textContent = side === 'left' ? '左側' : '右側';
  }
  const visible = m && m.visibility >= MIN_VISIBILITY;

  if (visible) {
    m.key = smoother.update('key', m.key);
    for (const k of Object.keys(m.extra)) m.extra[k] = smoother.update(k, m.extra[k]);
    showAngles(m);
  }

  if (phase === 'preview' || phase === 'countdown') {
    if (phase === 'preview') showHint(visible ? '' : '請讓全身入鏡');
    else showHint(visible ? ex.readyHint : '請讓全身入鏡');
    return;
  }

  if (phase === 'ready') {
    if (!visible) {
      readyTimer.reset();
      showHint('請讓全身入鏡');
      return;
    }
    showHint(ex.readyHint);
    if (readyTimer.update(ex.ready(m), now)) {
      phase = 'active';
      lockedSide = side;
      anchor = { x: joints.hip.x, scale: bodyScale(joints) };
      counter.start();
      invalidCancelTimer.reset();
      invalidPauseTimer.reset();
      showHint('');
      flashCenter('開始');
      speak('開始');
    }
    return;
  }

  // phase === 'active'
  // 姿勢要合理，而且人還在原本的位置（沒有走近鏡頭、沒有走開）
  const ok = visible && ex.valid(m) && stillInPlace(anchor, joints);
  if (invalidPauseTimer.update(!ok, now)) {
    // 離開定位太久（站起來走開、趴下休息等），要重新擺好預備姿勢才繼續
    counter.cancel();
    phase = 'ready';
    lockedSide = null;
    readyTimer.reset();
    return;
  }
  if (invalidCancelTimer.update(!ok, now)) {
    counter.cancel();
    showHint(visible ? '姿勢跑掉了，這下不算' : '請讓全身入鏡');
    return;
  }
  if (!ok) return;
  showHint('');

  const rep = counter.update(m.key, now, m.extra);
  if (rep) onRep(rep);
  window.__app = { counter, phase, key: m.key, extra: m.extra, side };
}

function onRep(rep) {
  $('count').textContent = String(rep.index);
  $('last-min').textContent = `${Math.round(rep.minAngle)}°`;
  speak(String(rep.index));
}

// ---------- 畫面 ----------

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

function flashCenter(text) {
  showCenter(text);
  setTimeout(() => {
    if ($('center').textContent === text) showCenter('');
  }, 800);
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
  if (phase === 'preview') startSession(fromFile ? 0 : COUNTDOWN_SEC);
  else stopSession();
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
