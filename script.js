const video = document.getElementById('webcam');
const canvas = document.getElementById('detection-canvas');
const ctx = canvas.getContext('2d');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const emptyState = document.getElementById('empty-state');
const objectCount = document.getElementById('object-count');
const objectList = document.getElementById('object-list');
const resultSummary = document.getElementById('result-summary');
const toggleButton = document.getElementById('toggle-detection');

const MODEL_URL = 'models/yolo11n.onnx';
const MODEL_SIZE = 640;
const MIN_CONFIDENCE = 0.3;
const NMS_IOU = 0.45;
const MAX_OBJECTS = 20;
const DETECTION_INTERVAL = 100;
const TRACK_MATCH_IOU = 0.25;
const TRACK_MAX_MISSES = 3;
const BOX_SMOOTHING = 0.58;
const COLORS = ['#49e5ff', '#38e59b', '#ffcc66', '#ff78b5', '#a98cff', '#ff776d'];
const LABELS = [
  'person','bicycle','car','motorcycle','airplane','bus','train','truck','boat','traffic light',
  'fire hydrant','stop sign','parking meter','bench','bird','cat','dog','horse','sheep','cow',
  'elephant','bear','zebra','giraffe','backpack','umbrella','handbag','tie','suitcase','frisbee',
  'skis','snowboard','sports ball','kite','baseball bat','baseball glove','skateboard','surfboard',
  'tennis racket','bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple',
  'sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair','couch',
  'potted plant','bed','dining table','toilet','tv','laptop','mouse','remote','keyboard',
  'cell phone','microwave','oven','toaster','sink','refrigerator','book','clock','vase','scissors',
  'teddy bear','hair drier','toothbrush'
];

const inferenceCanvas = document.createElement('canvas');
inferenceCanvas.width = MODEL_SIZE;
inferenceCanvas.height = MODEL_SIZE;
const inferenceCtx = inferenceCanvas.getContext('2d', { willReadFrequently: true });

let session;
let stream;
let frameId;
let enabled = true;
let pending = false;
let lastDetection = 0;
let tracks = [];
let nextTrackId = 1;

function setStatus(message, type = 'ready') {
  statusText.textContent = message;
  statusDot.className = type === 'ready' ? '' : type;
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function videoPlacement() {
  const scale = Math.max(canvas.clientWidth / video.videoWidth, canvas.clientHeight / video.videoHeight);
  return {
    scale,
    offsetX: (canvas.clientWidth - video.videoWidth * scale) / 2,
    offsetY: (canvas.clientHeight - video.videoHeight * scale) / 2
  };
}

function intersectionOverUnion(first, second) {
  const [ax, ay, aw, ah] = first;
  const [bx, by, bw, bh] = second;
  const left = Math.max(ax, bx);
  const top = Math.max(ay, by);
  const right = Math.min(ax + aw, bx + bw);
  const bottom = Math.min(ay + ah, by + bh);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = aw * ah + bw * bh - intersection;
  return union > 0 ? intersection / union : 0;
}

function nonMaximumSuppression(detections) {
  const selected = [];
  const sorted = detections.sort((a, b) => b.score - a.score);
  while (sorted.length && selected.length < MAX_OBJECTS) {
    const best = sorted.shift();
    selected.push(best);
    for (let index = sorted.length - 1; index >= 0; index--) {
      if (sorted[index].class === best.class &&
          intersectionOverUnion(sorted[index].bbox, best.bbox) > NMS_IOU) {
        sorted.splice(index, 1);
      }
    }
  }
  return selected;
}

function smoothBox(previous, current) {
  return previous.map((value, index) => value + (current[index] - value) * BOX_SMOOTHING);
}

function updateTracks(predictions) {
  const available = new Set(tracks.map(track => track.id));
  const updated = [];

  for (const prediction of predictions) {
    let bestTrack = null;
    let bestIou = TRACK_MATCH_IOU;
    for (const track of tracks) {
      if (!available.has(track.id) || track.class !== prediction.class) continue;
      const iou = intersectionOverUnion(track.bbox, prediction.bbox);
      if (iou > bestIou) {
        bestIou = iou;
        bestTrack = track;
      }
    }

    if (bestTrack) {
      available.delete(bestTrack.id);
      bestTrack.bbox = smoothBox(bestTrack.bbox, prediction.bbox);
      bestTrack.score += (prediction.score - bestTrack.score) * 0.65;
      bestTrack.misses = 0;
      updated.push(bestTrack);
    } else {
      updated.push({ ...prediction, id: nextTrackId++, misses: 0 });
    }
  }

  for (const track of tracks) {
    if (!available.has(track.id)) continue;
    track.misses++;
    track.score *= 0.92;
    if (track.misses <= TRACK_MAX_MISSES) updated.push(track);
  }

  tracks = updated.sort((a, b) => b.score - a.score).slice(0, MAX_OBJECTS);
  return tracks;
}

function prepareInput() {
  const scale = Math.min(MODEL_SIZE / video.videoWidth, MODEL_SIZE / video.videoHeight);
  const width = Math.round(video.videoWidth * scale);
  const height = Math.round(video.videoHeight * scale);
  const padX = (MODEL_SIZE - width) / 2;
  const padY = (MODEL_SIZE - height) / 2;

  inferenceCtx.fillStyle = 'rgb(114,114,114)';
  inferenceCtx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
  inferenceCtx.drawImage(video, padX, padY, width, height);
  const rgba = inferenceCtx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const planeSize = MODEL_SIZE * MODEL_SIZE;
  const input = new Float32Array(planeSize * 3);

  for (let pixel = 0; pixel < planeSize; pixel++) {
    const source = pixel * 4;
    input[pixel] = rgba[source] / 255;
    input[planeSize + pixel] = rgba[source + 1] / 255;
    input[planeSize * 2 + pixel] = rgba[source + 2] / 255;
  }

  return {
    tensor: new ort.Tensor('float32', input, [1, 3, MODEL_SIZE, MODEL_SIZE]),
    scale,
    padX,
    padY
  };
}

function decodeOutput(output, transform) {
  const data = output.data;
  const dimensions = output.dims;
  const channelsFirst = dimensions[1] < dimensions[2];
  const attributes = channelsFirst ? dimensions[1] : dimensions[2];
  const candidates = channelsFirst ? dimensions[2] : dimensions[1];
  const classCount = Math.min(LABELS.length, attributes - 4);
  const valueAt = channelsFirst
    ? (candidate, attribute) => data[attribute * candidates + candidate]
    : (candidate, attribute) => data[candidate * attributes + attribute];
  const detections = [];

  for (let candidate = 0; candidate < candidates; candidate++) {
    let classId = 0;
    let score = 0;
    for (let classIndex = 0; classIndex < classCount; classIndex++) {
      const classScore = valueAt(candidate, classIndex + 4);
      if (classScore > score) {
        score = classScore;
        classId = classIndex;
      }
    }
    if (score < MIN_CONFIDENCE) continue;

    const centerX = valueAt(candidate, 0);
    const centerY = valueAt(candidate, 1);
    const width = valueAt(candidate, 2);
    const height = valueAt(candidate, 3);
    const x = Math.max(0, (centerX - width / 2 - transform.padX) / transform.scale);
    const y = Math.max(0, (centerY - height / 2 - transform.padY) / transform.scale);
    const right = Math.min(video.videoWidth, (centerX + width / 2 - transform.padX) / transform.scale);
    const bottom = Math.min(video.videoHeight, (centerY + height / 2 - transform.padY) / transform.scale);
    if (right <= x || bottom <= y) continue;

    detections.push({
      class: LABELS[classId],
      score,
      bbox: [x, y, right - x, bottom - y]
    });
  }
  return nonMaximumSuppression(detections);
}

function draw(predictions) {
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  if (!video.videoWidth) return;
  const placement = videoPlacement();

  predictions.forEach(item => {
    const [sourceX, sourceY, sourceWidth, sourceHeight] = item.bbox;
    const width = sourceWidth * placement.scale;
    const height = sourceHeight * placement.scale;
    const x = canvas.clientWidth - (sourceX * placement.scale + placement.offsetX + width);
    const y = sourceY * placement.scale + placement.offsetY;
    const color = COLORS[item.id % COLORS.length];
    const label = `${item.class} ${Math.round(item.score * 100)}%`;

    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, width, height);
    ctx.font = '700 15px Inter, system-ui, sans-serif';
    const labelWidth = ctx.measureText(label).width + 18;
    const labelY = Math.max(0, y - 30);
    ctx.fillStyle = color;
    ctx.fillRect(x, labelY, labelWidth, 30);
    ctx.fillStyle = '#06101a';
    ctx.fillText(label, x + 9, labelY + 20);
  });
}

function showList(predictions) {
  objectCount.textContent = predictions.length;
  resultSummary.textContent = predictions.length
    ? `${predictions.length} object${predictions.length === 1 ? '' : 's'} in view`
    : 'Scanning the camera';
  if (!predictions.length) {
    objectList.innerHTML = '<p class="none">No recognizable objects in view.</p>';
    return;
  }

  objectList.replaceChildren(...predictions.map(item => {
    const row = document.createElement('div');
    row.className = 'object-row';
    const main = document.createElement('div');
    main.className = 'object-main';
    const swatch = document.createElement('i');
    swatch.className = 'swatch';
    swatch.style.color = swatch.style.backgroundColor = COLORS[item.id % COLORS.length];
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.class;
    const score = document.createElement('span');
    score.className = 'confidence';
    score.textContent = `${Math.round(item.score * 100)}%`;
    main.append(swatch, name);
    row.append(main, score);
    return row;
  }));
}

async function detect(timestamp) {
  frameId = requestAnimationFrame(detect);
  if (!enabled || pending || !session || video.readyState < 2 ||
      timestamp - lastDetection < DETECTION_INTERVAL) return;
  pending = true;
  lastDetection = timestamp;

  try {
    const prepared = prepareInput();
    const results = await session.run({ [session.inputNames[0]]: prepared.tensor });
    const predictions = decodeOutput(results[session.outputNames[0]], prepared);
    const stablePredictions = updateTracks(predictions);
    draw(stablePredictions);
    showList(stablePredictions);
  } catch (error) {
    console.error('YOLO detection failed:', error);
    setStatus('Detection error', 'error');
  } finally {
    pending = false;
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not support camera access.');
  }
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  video.srcObject = stream;
  await video.play();
}

async function initialize() {
  try {
    if (!window.ort) throw new Error('ONNX Runtime failed to load. Check your internet connection.');
    setStatus('Loading YOLO11 AI and camera...', 'loading');
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
    // A single WASM thread works on ordinary localhost hosting without
    // requiring cross-origin-isolation response headers.
    ort.env.wasm.numThreads = 1;

    const [loadedSession] = await Promise.all([
      ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      }),
      startCamera()
    ]);
    session = loadedSession;
    resizeCanvas();
    emptyState.classList.add('hidden');
    toggleButton.disabled = false;
    setStatus('YOLO11 and camera are active');
    resultSummary.textContent = 'Scanning the camera';
    frameId = requestAnimationFrame(detect);
  } catch (error) {
    console.error('Initialization failed:', error);
    const message = error.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow camera access and reload.'
      : (error.message || 'Could not start YOLO object detection.');
    setStatus('Unable to start', 'error');
    emptyState.querySelector('p').textContent = message;
    resultSummary.textContent = 'Setup failed';
  }
}

toggleButton.addEventListener('click', () => {
  enabled = !enabled;
  toggleButton.textContent = enabled ? 'STOP DETECTION' : 'START DETECTION';
  setStatus(enabled ? 'YOLO11 and camera are active' : 'Detection paused', enabled ? 'ready' : 'loading');
  if (!enabled) {
    tracks = [];
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    objectCount.textContent = '0';
    resultSummary.textContent = 'Detection paused';
    objectList.innerHTML = '<p class="none">Press start to detect objects.</p>';
  }
});

window.addEventListener('resize', resizeCanvas);
window.addEventListener('beforeunload', () => {
  if (frameId) cancelAnimationFrame(frameId);
  stream?.getTracks().forEach(track => track.stop());
});

initialize();
