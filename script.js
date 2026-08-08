// Global Constants & Elements
const video = document.getElementById('webcam');
const drawCanvas = document.getElementById('drawCanvas');
const effectCanvas = document.getElementById('effectCanvas');
const threeCanvas = document.getElementById('threeCanvas');

const modeIndicator = document.getElementById('mode-indicator');
const colorChip = document.getElementById('color-chip');
const colorName = document.getElementById('color-name');
const worldStatus = document.getElementById('world-status');

const drawCtx = drawCanvas.getContext('2d');
const effectCtx = effectCanvas.getContext('2d');

let width = window.innerWidth;
let height = window.innerHeight;

function resize() {
  width = window.innerWidth;
  height = window.innerHeight;
  [drawCanvas, effectCanvas, threeCanvas].forEach(c => {
    c.width = width;
    c.height = height;
  });
}
window.addEventListener('resize', resize);
resize();

// Color Palette with Names
const palette = [
  { name: 'CYAN', hex: '#00f0ff' },
  { name: 'MAGENTA', hex: '#ff007f' },
  { name: 'LIME', hex: '#00ff66' },
  { name: 'GOLD', hex: '#ffd700' },
  { name: 'PURPLE', hex: '#a100ff' },
  { name: 'WHITE', hex: '#ffffff' }
];

let colorIndex = 0;
let isColorPinching = false;
let lastDrawPoint = null;

// Spark Particles Array for Drawing Effects
const particles = [];

class SparkParticle {
  constructor(x, y, color) {
    this.x = x;
    this.y = y;
    this.vx = (Math.random() - 0.5) * 4;
    this.vy = (Math.random() - 0.5) * 4;
    this.size = Math.random() * 4 + 2;
    this.color = color;
    this.alpha = 1;
  }

  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.alpha -= 0.03;
    this.size *= 0.95;
  }

  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = Math.max(this.alpha, 0);
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.shadowBlur = 8;
    ctx.shadowColor = this.color;
    ctx.fill();
    ctx.restore();
  }
}

// Landmark Smoothing Engine (Double EMA Filter)
const smoothedLandmarks = {};

function lerp(start, end, amt) {
  return (1 - amt) * start + amt * end;
}

function smoothPoint(raw, prevKey) {
  if (!smoothedLandmarks[prevKey]) {
    smoothedLandmarks[prevKey] = { x: raw.x, y: raw.y, z: raw.z || 0 };
  }
  const prev = smoothedLandmarks[prevKey];
  prev.x = lerp(prev.x, raw.x, 0.35);
  prev.y = lerp(prev.y, raw.y, 0.35);
  prev.z = lerp(prev.z, raw.z || 0, 0.35);
  return prev;
}

// THREE.JS 3D HOLOGRAM WORLD
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
camera.position.z = 6;

const renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, alpha: true, antialias: true });
renderer.setSize(width, height);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

// 3D Wireframe Cyber Core
const coreGeometry = new THREE.IcosahedronGeometry(1.6, 3);
const coreMaterial = new THREE.MeshBasicMaterial({
  color: 0x00f0ff,
  wireframe: true,
  transparent: true,
  opacity: 0.85
});
const cyberMesh = new THREE.Mesh(coreGeometry, coreMaterial);
scene.add(cyberMesh);

// Outer Ring
const ringGeo = new THREE.TorusGeometry(2.2, 0.02, 16, 100);
const ringMat = new THREE.MeshBasicMaterial({ color: 0xff007f, wireframe: true });
const ringMesh = new THREE.Mesh(ringGeo, ringMat);
scene.add(ringMesh);

// Floating Space Dust
const starCount = 400;
const starGeo = new THREE.BufferGeometry();
const starPositions = new Float32Array(starCount * 3);

for (let i = 0; i < starCount * 3; i++) {
  starPositions[i] = (Math.random() - 0.5) * 12;
}
starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
const starMat = new THREE.PointsMaterial({ size: 0.04, color: 0xffffff, transparent: true, opacity: 0.7 });
const starSystem = new THREE.Points(starGeo, starMat);
scene.add(starSystem);

let targetScale = 1;
let currentScale = 1;

// Gesture Analysis Helper
function getDistance(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

function analyzeHandGestures(landmarks, handIndex) {
  const thumb = smoothPoint(landmarks[4], `${handIndex}_thumb`);
  const index = smoothPoint(landmarks[8], `${handIndex}_index`);
  const middle = smoothPoint(landmarks[12], `${handIndex}_middle`);
  const ring = smoothPoint(landmarks[16], `${handIndex}_ring`);
  const pinky = smoothPoint(landmarks[20], `${handIndex}_pinky`);

  const indexUp = index.y < landmarks[6].y;
  const middleUp = middle.y < landmarks[10].y;
  const ringUp = ring.y < landmarks[14].y;
  const pinkyUp = pinky.y < landmarks[18].y;

  const isOpenPalm = indexUp && middleUp && ringUp && pinkyUp;
  const isOnlyIndex = indexUp && !middleUp && !ringUp && !pinkyUp;
  const isIndexAndMiddle = indexUp && middleUp && !ringUp && !pinkyUp;

  const thumbIndexDist = getDistance(thumb, index);
  const thumbMiddleDist = getDistance(thumb, middle);

  return {
    isOpenPalm,
    isOnlyIndex,
    isIndexAndMiddle,
    thumbIndexPinch: thumbIndexDist < 0.05,
    thumbMiddlePinch: thumbMiddleDist < 0.055,
    thumb,
    index,
    middle
  };
}

// Main Frame Loop / Results Callback
function onResults(results) {
  effectCtx.clearRect(0, 0, width, height);

  // Update Particle Sparks
  for (let i = particles.length - 1; i >= 0; i--) {
    particles[i].update();
    particles[i].draw(effectCtx);
    if (particles[i].alpha <= 0) particles.splice(i, 1);
  }

  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    modeIndicator.textContent = "SEARCHING...";
    modeIndicator.className = "hud-value highlight";
    threeCanvas.style.display = "none";
    worldStatus.textContent = "INACTIVE";
    worldStatus.className = "hud-value status-off";
    lastDrawPoint = null;
    return;
  }

  const hands = results.multiHandLandmarks.map((lm, idx) => analyzeHandGestures(lm, idx));

  // GESTURE 4: 3D Hologram World Activation (Both Hands Open Palm)
  const is3DActive = hands.length === 2 && hands[0].isOpenPalm && hands[1].isOpenPalm;

  if (is3DActive) {
    threeCanvas.style.display = "block";
    worldStatus.textContent = "ACTIVE";
    worldStatus.className = "hud-value status-on";
    modeIndicator.textContent = "3D HOLOGRAM CONTROL";

    // Distance between two hands controls overall scale
    const palmDist = getDistance(hands[0].index, hands[1].index);
    targetScale = Math.min(Math.max(palmDist * 3.2, 0.5), 2.8);

    // Fine Zoom In/Out via Thumb-Middle Pinch
    if (hands[0].thumbMiddlePinch || hands[1].thumbMiddlePinch) {
      targetScale *= 0.94;
    }

    currentScale = lerp(currentScale, targetScale, 0.12);
    cyberMesh.scale.setScalar(currentScale);
    ringMesh.scale.setScalar(currentScale * 1.1);
    starSystem.scale.setScalar(currentScale);

    // Continuous Rotation Effect
    cyberMesh.rotation.x += 0.008;
    cyberMesh.rotation.y += 0.012;
    ringMesh.rotation.z -= 0.01;

    renderer.render(scene, camera);
    lastDrawPoint = null;
    return;
  } else {
    threeCanvas.style.display = "none";
    worldStatus.textContent = "INACTIVE";
    worldStatus.className = "hud-value status-off";
  }

  const hand = hands[0];
  const indexPos = { x: hand.index.x * width, y: hand.index.y * height };

  // GESTURE 2: Change Color (Thumb + Index Pinch)
  if (hand.thumbIndexPinch) {
    if (!isColorPinching) {
      colorIndex = (colorIndex + 1) % palette.length;
      const activeColor = palette[colorIndex];
      colorChip.style.backgroundColor = activeColor.hex;
      colorChip.style.boxShadow = `0 0 12px ${activeColor.hex}`;
      colorName.textContent = activeColor.name;
      coreMaterial.color.set(activeColor.hex);
      isColorPinching = true;
    }

    modeIndicator.textContent = "COLOR CHANGED";

    // Visual Ripple Ring Effect
    effectCtx.beginPath();
    effectCtx.arc(indexPos.x, indexPos.y, 22, 0, Math.PI * 2);
    effectCtx.strokeStyle = palette[colorIndex].hex;
    effectCtx.lineWidth = 3;
    effectCtx.stroke();

    lastDrawPoint = null;
    return;
  } else {
    isColorPinching = false;
  }

  // GESTURE 1: Drawing Pencil Mode (Only Index Finger)
  if (hand.isOnlyIndex) {
    modeIndicator.textContent = "PENCIL DRAWING";

    // Add Glowing Particle Sparks
    for (let i = 0; i < 2; i++) {
      particles.push(new SparkParticle(indexPos.x, indexPos.y, palette[colorIndex].hex));
    }

    if (lastDrawPoint) {
      drawCtx.beginPath();
      drawCtx.moveTo(lastDrawPoint.x, lastDrawPoint.y);
      drawCtx.lineTo(indexPos.x, indexPos.y);
      drawCtx.strokeStyle = palette[colorIndex].hex;
      drawCtx.lineWidth = 5;
      drawCtx.lineCap = "round";
      drawCtx.shadowBlur = 12;
      drawCtx.shadowColor = palette[colorIndex].hex;
      drawCtx.stroke();
    }

    lastDrawPoint = indexPos;
    return;
  }

  // GESTURE 3: Eraser Mode (Index + Middle Finger)
  if (hand.isIndexAndMiddle) {
    modeIndicator.textContent = "ERASER ACTIVE";

    const eraseCenter = {
      x: ((hand.index.x + hand.middle.x) / 2) * width,
      y: ((hand.index.y + hand.middle.y) / 2) * height
    };

    // Futuristic Eraser Circle
    effectCtx.beginPath();
    effectCtx.arc(eraseCenter.x, eraseCenter.y, 28, 0, Math.PI * 2);
    effectCtx.strokeStyle = "#ff3b30";
    effectCtx.lineWidth = 2;
    effectCtx.setLineDash([6, 6]);
    effectCtx.stroke();

    // Erase Canvas Area
    drawCtx.clearRect(eraseCenter.x - 28, eraseCenter.y - 28, 56, 56);

    lastDrawPoint = null;
    return;
  }

  modeIndicator.textContent = "READY / HOVERING";
  lastDrawPoint = null;
}

// MediaPipe Setup
const hands = new Hands({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
});

hands.setOptions({
  maxNumHands: 2,
  modelComplexity: 1,
  minDetectionConfidence: 0.75,
  minTrackingConfidence: 0.75
});

hands.onResults(onResults);

// Webcam Feed Initialization
const cameraUtils = new Camera(video, {
  onFrame: async () => {
    await hands.send({ image: video });
  },
  width: 1280,
  height: 720
});

cameraUtils.start();