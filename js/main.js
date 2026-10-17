import { PoseLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
import { pickSide, sideJoints, Smoother } from './pose-math.js';
import { RepCounter } from './rep-counter.js';
import { EXERCISES } from './exercises.js';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const MIN_VISIBILITY = 0.5;

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

let landmarker = null;
let exerciseId = 'squat';
let counter = null;
const smoother = new Smoother(0.5);
let facingMode = 'environment';
let stream = null;
let running = false;
let lastVideoTime = -1;
let fpsFrames = 0;
let fpsSince = performance.now();

function setStatus(text) {
  $('status').textContent = text;
}

function setExercise(id) {
  exerciseId = id;
  const ex = EXERCISES[id];
  counter = new RepCounter({ downAngle: ex.downAngle, upAngle: ex.upAngle });
  smoother.reset();
  $('key-label').textContent = ex.keyLabel;
  $('count').textContent = '0';
  $('last-min').textContent = '–';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.exercise === id));
}

async function loadModel() {
  if (landmarker) return;
  setStatus('載入模型中…');
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

async function start(source) {
  try {
    $('start').disabled = true;
    await loadModel();
    setStatus('開啟中…');
    if (source === 'camera') {
      await startCamera();
    } else {
      stopStream();
      video.srcObject = null;
      video.src = URL.createObjectURL(source);
      video.loop = false;
      video.classList.remove('mirror');
      canvas.classList.remove('mirror');
      await video.play();
    }
    $('start-panel').hidden = true;
    $('hud').hidden = false;
    if (!running) {
      running = true;
      requestAnimationFrame(loop);
    }
  } catch (err) {
    console.error(err);
    setStatus(err.name === 'NotAllowedError' ? '沒有鏡頭權限，請在瀏覽器設定中允許。' : `啟動失敗：${err.message}`);
  } finally {
    $('start').disabled = false;
  }
}

function loop() {
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const now = performance.now();
    const result = landmarker.detectForVideo(video, now);
    handleResult(result, now);
    updateFps(now);
  }
  requestAnimationFrame(loop);
}

function handleResult(result, now) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const lms = result.landmarks?.[0];
  if (!lms) {
    showHint('找不到人，請讓全身入鏡');
    return;
  }

  const side = pickSide(lms);
  const joints = sideJoints(lms, side, canvas.width, canvas.height);
  drawSkeleton(lms, side);

  const ex = EXERCISES[exerciseId];
  const m = ex.measure(joints);
  $('side').textContent = side === 'left' ? '偵測左側' : '偵測右側';

  if (m.visibility < MIN_VISIBILITY) {
    showHint('關節看不清楚，請側面拍、全身入鏡');
    return;
  }

  const key = smoother.update('key', m.key);
  const extra = {};
  for (const [k, v] of Object.entries(m.extra)) extra[k] = smoother.update(k, v);

  $('key-angle').textContent = `${Math.round(key)}°`;
  $('extra').innerHTML = Object.entries(extra)
    .map(([k, v]) => `<div><span>${k}</span><b>${Number.isFinite(v) ? Math.round(v) + '°' : '–'}</b></div>`)
    .join('');

  const rep = counter.update(key, now, extra);
  if (rep) onRep(rep);

  if (counter.state === 'waiting') {
    showHint(exerciseId === 'squat' ? '先站直準備' : '先撐起手臂準備');
  } else {
    showHint('');
  }
  window.__app = { counter, key, extra, side };
}

function onRep(rep) {
  $('count').textContent = String(rep.index);
  $('last-min').textContent = `${Math.round(rep.minAngle)}°`;
  if ($('voice').checked && 'speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(String(rep.index));
    u.lang = 'zh-TW';
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }
}

function showHint(text) {
  $('hint').textContent = text;
}

function updateFps(now) {
  fpsFrames += 1;
  if (now - fpsSince >= 1000) {
    $('fps').textContent = `${Math.round((fpsFrames * 1000) / (now - fpsSince))} FPS`;
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

// 事件
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setExercise(t.dataset.exercise)));
$('start').addEventListener('click', () => start('camera'));
$('file').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) start(f);
});
$('reset').addEventListener('click', () => setExercise(exerciseId));
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

if (!window.isSecureContext) {
  setStatus('需要 HTTPS 才能開啟鏡頭（本機測試請用 localhost）。');
}
setExercise('squat');
