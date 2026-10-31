'use strict';

/* =========================================================================
   IRON SIEGE — top-down tank arena
   A dependency-free canvas game: waves of AI tanks, cover, pickups, juice.
   ========================================================================= */

// ---------- tiny math toolkit ----------

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

function angleDelta(a, b) {
  let d = (b - a + Math.PI) % TAU;
  if (d < 0) d += TAU;
  return d - Math.PI;
}

function turnTowards(current, target, maxStep) {
  return current + clamp(angleDelta(current, target), -maxStep, maxStep);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rng = mulberry32((Date.now() ^ 0x9e3779b9) >>> 0);
const rand = (a, b) => a + (b - a) * rng();
const pick = (arr) => arr[Math.floor(rng() * arr.length)];

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// ---------- DOM ----------

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d', { alpha: false });
const mini = $('minimap');
const miniCtx = mini.getContext('2d');
const damageEl = $('damage');
const feedEl = $('feed');
const bannerEl = $('banner');
const introEl = $('intro');
const pauseEl = $('pause');
const overEl = $('gameover');

const ui = {
  score: $('score'),
  best: $('best'),
  wave: $('waveNum'),
  enemies: $('enemyCount'),
  armorFill: $('armorFill'),
  armorVal: $('armorVal'),
  shieldFill: $('shieldFill'),
  shieldChip: document.querySelector('[data-buff="shield"]'),
  rapidChip: document.querySelector('[data-buff="rapid"]'),
  reloadFill: $('reloadFill'),
  weaponState: $('weaponState'),
  bannerKicker: $('bannerKicker'),
  bannerTitle: $('bannerTitle'),
  bannerSub: $('bannerSub'),
  introBest: $('introBest'),
  goWave: $('goWave'),
  goKills: $('goKills'),
  goScore: $('goScore'),
  goBest: $('goBest'),
  muteBtn: $('muteBtn'),
  pauseBtn: $('pauseBtn'),
  playBtn: $('playBtn'),
  againBtn: $('againBtn'),
  resumeBtn: $('resumeBtn'),
};

// ---------- audio ----------

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.muted = false;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.42;
    this.master.connect(this.ctx.destination);

    const length = Math.floor(this.ctx.sampleRate * 1.2);
    this.noiseBuf = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }

  setMuted(value) {
    this.muted = value;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(value ? 0 : 0.42, this.ctx.currentTime, 0.02);
    }
  }

  tone(f0, f1, dur, gain, type = 'sine', delay = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(22, f0), t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(22, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  noise(dur, gain, f0, f1, type = 'lowpass', delay = 0, q = 0.8) {
    if (!this.ctx || !this.noiseBuf) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(Math.max(30, f0), t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.03);
  }

  cannon() {
    this.noise(0.16, 0.3, 2800, 260, 'lowpass', 0, 1.1);
    this.tone(140, 44, 0.22, 0.3, 'triangle');
    this.tone(70, 34, 0.3, 0.18, 'sine', 0.02);
  }

  enemyShot() {
    this.noise(0.11, 0.13, 1900, 300, 'lowpass', 0, 1);
    this.tone(110, 40, 0.16, 0.12, 'triangle');
  }

  boom(size = 1) {
    const s = clamp(size, 0.5, 2.6);
    this.noise(0.26 + s * 0.2, 0.26 * s, 1300, 60, 'lowpass', 0, 0.95);
    this.tone(96, 28, 0.32 + s * 0.16, 0.26 * s, 'sine');
    this.tone(52, 24, 0.42 + s * 0.22, 0.18 * s, 'triangle', 0.03);
    this.noise(0.5 + s * 0.3, 0.08 * s, 500, 80, 'lowpass', 0.04, 0.7);
  }

  hit() {
    this.tone(320, 90, 0.07, 0.08, 'square');
    this.noise(0.07, 0.06, 3000, 800, 'highpass', 0, 0.7);
  }

  playerHit() {
    this.noise(0.24, 0.22, 900, 120, 'lowpass', 0, 0.8);
    this.tone(84, 36, 0.28, 0.24, 'sawtooth');
  }

  pickup() {
    this.tone(520, 780, 0.1, 0.12, 'sine');
    this.tone(780, 1180, 0.16, 0.09, 'sine', 0.07);
  }

  wave(clear = false) {
    if (clear) {
      this.tone(330, 440, 0.18, 0.1, 'triangle');
      this.tone(440, 660, 0.3, 0.1, 'triangle', 0.12);
      this.tone(660, 880, 0.38, 0.08, 'sine', 0.26);
    } else {
      this.tone(92, 76, 0.5, 0.18, 'sawtooth');
      this.tone(138, 112, 0.5, 0.09, 'triangle', 0.03);
      this.noise(0.45, 0.05, 500, 120, 'lowpass', 0, 0.8);
    }
  }
}

const audio = new AudioEngine();

// ---------- constants & global state ----------

const WORLD = { w: 2600, h: 1900, pad: 62 };
const MAX_PARTICLES = 460;

const PLAYER_STATS = {
  radius: 24,
  len: 54,
  width: 42,
  speed: 252,
  maxHp: 100,
  damage: 38,
  shellSpeed: 1040,
  fireDelay: 0.4,
  rapidDelay: 0.165,
};

const ENEMY_TYPES = {
  scout: {
    label: 'SCOUT', hp: 58, radius: 20, len: 44, width: 34, speed: 186,
    fireDelay: 1.6, shellSpeed: 560, damage: 7, range: 300, score: 100,
    accuracy: 0.14, turretTurn: 3.2, color: '#a5523f', dark: '#4b2923', accent: '#ff9a62',
  },
  gunner: {
    label: 'GUNNER', hp: 104, radius: 24, len: 51, width: 40, speed: 132,
    fireDelay: 1.3, shellSpeed: 630, damage: 10, range: 385, score: 165,
    accuracy: 0.1, turretTurn: 2.7, color: '#8d4637', dark: '#3e2620', accent: '#ff7a4f',
  },
  heavy: {
    label: 'HEAVY', hp: 218, radius: 30, len: 64, width: 50, speed: 86,
    fireDelay: 2.2, shellSpeed: 520, damage: 17, range: 330, score: 300,
    accuracy: 0.07, turretTurn: 2.0, color: '#6b3c31', dark: '#2d1d19', accent: '#ff5d42',
  },
};

const bestKey = 'ironsiege.best';
function loadBest() {
  try { return Number(localStorage.getItem(bestKey)) || 0; } catch { return 0; }
}
function saveBest(value) {
  try { localStorage.setItem(bestKey, String(value)); } catch { /* private mode */ }
}

const game = {
  state: 'menu',
  score: 0,
  kills: 0,
  wave: 0,
  best: loadBest(),
  waveActive: false,
  waveClearTimer: 0,
  queue: [],
  deathTimer: 0,
  hitFlash: 0,
  time: 0,
  muted: false,
};

const camera = { x: WORLD.w / 2, y: WORLD.h / 2, zoom: 1, targetZoom: 1, shake: 0 };

let player = null;
let enemies = [];
let shells = [];
let pickups = [];
let particles = [];
let texts = [];
let obstacles = [];
let terrain = null;

let W = window.innerWidth;
let H = window.innerHeight;
let DPR = 1;

// ---------- input ----------

const keys = new Set();
const mouse = { x: W * 0.5, y: H * 0.4, down: false, seen: false };
const sticks = {
  left: { active: false, id: null, bx: 0, by: 0, dx: 0, dy: 0, mag: 0 },
  right: { active: false, id: null, bx: 0, by: 0, dx: 0, dy: 0, mag: 0 },
};
let touchMode = window.matchMedia('(pointer: coarse)').matches;

function stickDefaults() {
  const r = 96;
  return {
    left: { x: r, y: H - r - 20 },
    right: { x: W - r, y: H - r - 20 },
  };
}

function screenToWorld(x, y) {
  return {
    x: camera.x + (x - W / 2) / camera.zoom,
    y: camera.y + (y - H / 2) / camera.zoom,
  };
}

function handleKeyDown(e) {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
    e.preventDefault();
  }
  keys.add(e.code);

  if (e.code === 'Enter' && (game.state === 'menu' || game.state === 'gameover')) {
    startGame();
    return;
  }
  if (e.code === 'KeyR' && game.state === 'gameover') {
    startGame();
    return;
  }
  if ((e.code === 'KeyP' || e.code === 'Escape') && (game.state === 'playing' || game.state === 'paused')) {
    togglePause();
  }
}

function handlePointerDown(e) {
  audio.init();
  if (e.pointerType === 'mouse') {
    if (e.button !== 0) return;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.down = true;
    mouse.seen = true;
    return;
  }
  touchMode = true;
  if (game.state !== 'playing') return;
  if (e.clientY < H * 0.3) return;

  const stick = e.clientX < W * 0.5 ? sticks.left : sticks.right;
  if (stick.active) return;
  stick.active = true;
  stick.id = e.pointerId;
  stick.bx = e.clientX;
  stick.by = e.clientY;
  stick.dx = 0;
  stick.dy = 0;
  stick.mag = 0;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  e.preventDefault();
}

function handlePointerMove(e) {
  if (e.pointerType === 'mouse') {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.seen = true;
    return;
  }
  const stick = sticks.left.id === e.pointerId ? sticks.left : sticks.right.id === e.pointerId ? sticks.right : null;
  if (!stick || !stick.active) return;
  const R = 48;
  let dx = e.clientX - stick.bx;
  let dy = e.clientY - stick.by;
  const len = Math.hypot(dx, dy);
  if (len > R) {
    dx = (dx / len) * R;
    dy = (dy / len) * R;
  }
  stick.dx = dx / R;
  stick.dy = dy / R;
  stick.mag = clamp(len / R, 0, 1);
  e.preventDefault();
}

function releasePointer(e) {
  if (e.pointerType === 'mouse') {
    if (e.button === 0) mouse.down = false;
    return;
  }
  for (const stick of [sticks.left, sticks.right]) {
    if (stick.id === e.pointerId) {
      stick.active = false;
      stick.id = null;
      stick.dx = 0;
      stick.dy = 0;
      stick.mag = 0;
    }
  }
}

window.addEventListener('keydown', handleKeyDown);
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); mouse.down = false; });
canvas.addEventListener('pointerdown', handlePointerDown);
canvas.addEventListener('pointermove', handlePointerMove);
canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.state === 'playing') togglePause();
});

function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(W * DPR);
  canvas.height = Math.floor(H * DPR);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  camera.targetZoom = targetZoom();
  if (!player) camera.zoom = camera.targetZoom;
}

function targetZoom() {
  return clamp(Math.sqrt((W * H) / (1220 * 790)), 0.66, 1.3);
}

// ---------- terrain ----------

function buildTerrain() {
  const c = document.createElement('canvas');
  c.width = WORLD.w;
  c.height = WORLD.h;
  const g = c.getContext('2d');

  g.fillStyle = '#282d22';
  g.fillRect(0, 0, WORLD.w, WORLD.h);

  // Broad earth mottling.
  for (let i = 0; i < 110; i++) {
    const x = rand(0, WORLD.w);
    const y = rand(0, WORLD.h);
    const r = rand(90, 330);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const tone = pick(['255,220,160', '180,200,130', '70,82,54', '120,96,62']);
    grad.addColorStop(0, `rgba(${tone},${rand(0.025, 0.075).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${tone},0)`);
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Oil and scorch stains.
  for (let i = 0; i < 22; i++) {
    const x = rand(120, WORLD.w - 120);
    const y = rand(120, WORLD.h - 120);
    const r = rand(28, 100);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(8,10,7,${rand(0.12, 0.3).toFixed(2)})`);
    grad.addColorStop(0.7, 'rgba(8,10,7,0.08)');
    grad.addColorStop(1, 'rgba(8,10,7,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(x, y, r, r * rand(0.5, 0.9), rand(0, TAU), 0, TAU);
    g.fill();
  }

  // Fine grit.
  for (let i = 0; i < 9000; i++) {
    const shade = rand(0, 1);
    g.fillStyle = shade > 0.55
      ? `rgba(190,200,150,${rand(0.025, 0.1).toFixed(3)})`
      : `rgba(5,8,4,${rand(0.03, 0.12).toFixed(3)})`;
    const s = rand(0.7, 2.6);
    g.fillRect(rand(0, WORLD.w), rand(0, WORLD.h), s, s);
  }

  // Subtle survey grid.
  g.strokeStyle = 'rgba(220,228,180,0.045)';
  g.lineWidth = 1;
  for (let x = 0; x <= WORLD.w; x += 130) {
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, WORLD.h);
    g.stroke();
  }
  for (let y = 0; y <= WORLD.h; y += 130) {
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(WORLD.w, y + 0.5);
    g.stroke();
  }

  // Central painted drop-zone marking.
  const cx = WORLD.w / 2;
  const cy = WORLD.h / 2;
  g.save();
  g.translate(cx, cy);
  g.strokeStyle = 'rgba(255,180,94,0.09)';
  g.lineWidth = 3;
  g.setLineDash([18, 14]);
  g.beginPath();
  g.arc(0, 0, 196, 0, TAU);
  g.stroke();
  g.setLineDash([]);
  g.strokeStyle = 'rgba(255,180,94,0.06)';
  g.lineWidth = 1;
  g.beginPath();
  g.arc(0, 0, 160, 0, TAU);
  g.stroke();
  g.beginPath();
  g.moveTo(-210, 0);
  g.lineTo(210, 0);
  g.moveTo(0, -210);
  g.lineTo(0, 210);
  g.stroke();
  g.fillStyle = 'rgba(238,231,212,0.045)';
  g.font = '800 92px "Arial Narrow", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('07', 0, 6);
  g.restore();

  // Perimeter wall / hazard band.
  const band = 34;
  g.fillStyle = '#12160f';
  g.fillRect(0, 0, WORLD.w, band);
  g.fillRect(0, WORLD.h - band, WORLD.w, band);
  g.fillRect(0, 0, band, WORLD.h);
  g.fillRect(WORLD.w - band, 0, band, WORLD.h);

  g.save();
  g.beginPath();
  g.rect(0, 0, WORLD.w, WORLD.h);
  g.rect(band, band, WORLD.w - band * 2, WORLD.h - band * 2);
  g.clip('evenodd');
  g.strokeStyle = 'rgba(255,180,94,0.16)';
  g.lineWidth = 16;
  for (let i = -WORLD.h; i < WORLD.w + WORLD.h; i += 62) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + WORLD.h, WORLD.h);
    g.stroke();
  }
  g.restore();

  g.strokeStyle = 'rgba(255,180,94,0.25)';
  g.lineWidth = 2;
  g.strokeRect(band, band, WORLD.w - band * 2, WORLD.h - band * 2);

  // Corner stencils.
  g.fillStyle = 'rgba(238,231,212,0.09)';
  g.font = '600 20px ui-monospace, monospace';
  g.textAlign = 'left';
  g.fillText('SECTOR 07 // LIVE FIRE ZONE', 58, 78);
  g.textAlign = 'right';
  g.fillText('RESTRICTED', WORLD.w - 58, WORLD.h - 54);

  terrain = c;
}

function createObstacle(kind, x, y, w, h) {
  const obstacle = {
    kind, x, y, dead: false, hp: Infinity, maxHp: Infinity,
    shape: kind === 'barrier' || kind === 'crate' ? 'rect' : 'circle',
    w, h, r: 0, sortY: y,
  };
  if (obstacle.shape === 'rect') {
    obstacle.r = Math.hypot(w, h) * 0.5;
    obstacle.sortY = y + h * 0.5;
  } else {
    obstacle.r = w * 0.5;
    obstacle.bw = w;
    obstacle.bh = h;
    obstacle.sortY = y + obstacle.r * 0.7;
  }
  if (kind === 'crate') {
    obstacle.hp = 95;
    obstacle.maxHp = 95;
  }
  if (kind === 'barrel') {
    obstacle.hp = 34;
    obstacle.maxHp = 34;
  }
  if (kind === 'rock') {
    obstacle.points = [];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const rr = obstacle.r * rand(0.76, 1.12);
      obstacle.points.push([Math.cos(a) * rr, Math.sin(a) * rr]);
    }
  }
  return obstacle;
}

function pathOverlap(a, b) {
  const ar = a.shape === 'rect' ? Math.max(a.w, a.h) * 0.5 : a.r;
  const br = b.shape === 'rect' ? Math.max(b.w, b.h) * 0.5 : b.r;
  return Math.hypot(a.x - b.x, a.y - b.y) < ar + br + 36;
}

function generateObstacles() {
  const out = [];
  const cx = WORLD.w / 2;
  const cy = WORLD.h / 2;

  function place(kind, w, h) {
    for (let attempt = 0; attempt < 90; attempt++) {
      const x = rand(150, WORLD.w - 150);
      const y = rand(150, WORLD.h - 150);
      const clearR = kind === 'barrier' ? 160 : 110;
      if (Math.hypot(x - cx, y - cy) < 205 + clearR) continue;
      const candidate = createObstacle(kind, x, y, w, h);
      let bad = false;
      for (const other of out) {
        if (pathOverlap(candidate, other)) { bad = true; break; }
      }
      // A couple of hand-placed landmarks keep the map readable.
      if (!bad) {
        out.push(candidate);
        return true;
      }
    }
    return false;
  }

  // Pre-designed cover around the drop zone.
  out.push(createObstacle('barrier', cx - 420, cy - 300, 190, 42));
  out.push(createObstacle('barrier', cx + 330, cy + 270, 42, 210));
  out.push(createObstacle('crate', cx - 300, cy + 250, 56, 56));
  out.push(createObstacle('crate', cx + 265, cy - 255, 56, 56));
  out.push(createObstacle('rock', cx + 480, cy - 390, 68, 68));
  out.push(createObstacle('rock', cx - 500, cy + 420, 76, 76));

  for (let i = 0; i < 9; i++) {
    const wide = rng() > 0.5;
    const w = wide ? rand(140, 250) : rand(38, 52);
    const h = wide ? rand(38, 52) : rand(140, 250);
    place('barrier', w, h);
  }
  for (let i = 0; i < 8; i++) {
    const s = rand(44, 62);
    place('crate', s, s);
  }
  for (let i = 0; i < 5; i++) {
    const r = rand(46, 76);
    place('rock', r, r);
  }
  for (let i = 0; i < 6; i++) {
    place('barrel', 30, 30);
  }

  // Keep obstacles out of the direct player spawn.
  return out.filter((o) => Math.hypot(o.x - cx, o.y - cy) > 92);
}

// ---------- collision helpers ----------

function pointRectDistanceSq(x, y, o) {
  const nx = clamp(x, o.x - o.w / 2, o.x + o.w / 2);
  const ny = clamp(y, o.y - o.h / 2, o.y + o.h / 2);
  const dx = x - nx;
  const dy = y - ny;
  return { d2: dx * dx + dy * dy, nx, ny };
}

function circleHitsObstacle(x, y, r, o) {
  if (o.dead) return false;
  if (o.shape === 'rect') {
    return pointRectDistanceSq(x, y, o).d2 < r * r;
  }
  const dx = x - o.x;
  const dy = y - o.y;
  const rr = r + o.r;
  return dx * dx + dy * dy < rr * rr;
}

function isBlockedCircle(x, y, r) {
  if (x < WORLD.pad + r || x > WORLD.w - WORLD.pad - r || y < WORLD.pad + r || y > WORLD.h - WORLD.pad - r) {
    return true;
  }
  for (const o of obstacles) {
    if (circleHitsObstacle(x, y, r, o)) return true;
  }
  return false;
}

function resolveTankTerrain(t) {
  t.x = clamp(t.x, WORLD.pad + t.radius, WORLD.w - WORLD.pad - t.radius);
  t.y = clamp(t.y, WORLD.pad + t.radius, WORLD.h - WORLD.pad - t.radius);

  for (const o of obstacles) {
    if (o.dead) continue;
    if (o.shape === 'rect') {
      const { d2, nx, ny } = pointRectDistanceSq(t.x, t.y, o);
      if (d2 < t.radius * t.radius) {
        const dx = t.x - nx;
        const dy = t.y - ny;
        const d = Math.hypot(dx, dy);
        if (d > 0.001) {
          const push = t.radius - d;
          t.x += (dx / d) * push;
          t.y += (dy / d) * push;
        } else {
          const ox = o.w / 2 + t.radius - Math.abs(t.x - o.x);
          const oy = o.h / 2 + t.radius - Math.abs(t.y - o.y);
          if (ox < oy) t.x += Math.sign(t.x - o.x || 1) * ox;
          else t.y += Math.sign(t.y - o.y || 1) * oy;
        }
      }
    } else {
      const dx = t.x - o.x;
      const dy = t.y - o.y;
      const d = Math.hypot(dx, dy);
      const min = t.radius + o.r;
      if (d < min && d > 0.001) {
        const push = min - d;
        t.x += (dx / d) * push;
        t.y += (dy / d) * push;
      }
    }
  }
}

function segmentHitsRect(x1, y1, x2, y2, o, pad = 0) {
  const minX = o.x - o.w / 2 - pad;
  const maxX = o.x + o.w / 2 + pad;
  const minY = o.y - o.h / 2 - pad;
  const maxY = o.y + o.h / 2 + pad;
  const dx = x2 - x1;
  const dy = y2 - y1;
  let tmin = 0;
  let tmax = 1;

  for (let axis = 0; axis < 2; axis++) {
    const p = axis === 0 ? x1 : y1;
    const d = axis === 0 ? dx : dy;
    const lo = axis === 0 ? minX : minY;
    const hi = axis === 0 ? maxX : maxY;
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return false;
    } else {
      let t1 = (lo - p) / d;
      let t2 = (hi - p) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return true;
}

function segmentHitsCircle(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 1e-9) t = clamp(((cx - x1) * dx + (cy - y1) * dy) / len2, 0, 1);
  const px = x1 + dx * t;
  const py = y1 + dy * t;
  const ddx = cx - px;
  const ddy = cy - py;
  return ddx * ddx + ddy * ddy <= r * r;
}

function segmentHitsObstacle(x1, y1, x2, y2, o, pad = 0) {
  if (o.dead) return false;
  if (o.shape === 'rect') return segmentHitsRect(x1, y1, x2, y2, o, pad);
  return segmentHitsCircle(x1, y1, x2, y2, o.x, o.y, o.r + pad);
}

function lineClear(x1, y1, x2, y2, pad = 4) {
  for (const o of obstacles) {
    if (o.dead) continue;
    if (segmentHitsObstacle(x1, y1, x2, y2, o, pad)) return false;
  }
  return true;
}

function avoidDirection(t, dx, dy) {
  const base = Math.atan2(dy, dx);
  const reach = t.radius + 52;
  const offsets = [0, 0.34, -0.34, 0.72, -0.72, 1.16, -1.16, 1.65, -1.65, 2.3, -2.3, Math.PI];
  for (const off of offsets) {
    const a = base + off;
    let ok = true;
    for (const d of [reach, reach * 1.9]) {
      if (isBlockedCircle(t.x + Math.cos(a) * d, t.y + Math.sin(a) * d, t.radius * 0.9)) {
        ok = false;
        break;
      }
    }
    if (ok) return [Math.cos(a), Math.sin(a)];
  }
  return [-Math.cos(base), -Math.sin(base)];
}

function addShake(amount) {
  camera.shake = Math.min(28, camera.shake + amount);
}

// ---------- entity creation ----------

function createPlayer() {
  return {
    isPlayer: true,
    x: WORLD.w / 2,
    y: WORLD.h / 2,
    vx: 0,
    vy: 0,
    angle: -Math.PI / 2,
    turretAngle: -Math.PI / 2,
    radius: PLAYER_STATS.radius,
    len: PLAYER_STATS.len,
    width: PLAYER_STATS.width,
    hp: PLAYER_STATS.maxHp,
    maxHp: PLAYER_STATS.maxHp,
    shield: 0,
    rapid: 0,
    reload: 0,
    flash: 0,
    dead: false,
    color: '#78885d',
    dark: '#3e4a30',
    accent: '#ffb45e',
    treadPhase: 0,
    trackAcc: 0,
    trackTimer: 0,
  };
}

function spawnEnemy(type, x, y) {
  const b = ENEMY_TYPES[type];
  const hpScale = 1 + (game.wave - 1) * 0.055;
  const dmgScale = 1 + (game.wave - 1) * 0.035;
  const enemy = {
    type,
    isPlayer: false,
    x,
    y,
    vx: 0,
    vy: 0,
    angle: rand(0, TAU),
    turretAngle: Math.atan2(player.y - y, player.x - x),
    radius: b.radius,
    len: b.len,
    width: b.width,
    hp: b.hp * hpScale,
    maxHp: b.hp * hpScale,
    speed: b.speed * (1 + (game.wave - 1) * 0.018),
    fireDelay: b.fireDelay * Math.max(0.66, 1 - (game.wave - 1) * 0.024),
    shellSpeed: b.shellSpeed,
    damage: b.damage * dmgScale,
    range: b.range,
    score: b.score,
    accuracy: b.accuracy,
    turretTurn: b.turretTurn,
    color: b.color,
    dark: b.dark,
    accent: b.accent,
    reload: rand(0.8, 1.8),
    flash: 0,
    dead: false,
    spawning: 0.95,
    strafeSign: rng() > 0.5 ? 1 : -1,
    strafeTimer: rand(2.2, 5),
    treadPhase: rand(0, 1),
    trackAcc: 0,
  };
  enemies.push(enemy);
  addRing(x, y, 'rgba(255,93,66,0.75)', 86, 0.55);
  addSparks(x, y, 8, 100, '#ff9a62');
}

function composeWave(n) {
  if (n === 1) return ['scout', 'scout', 'gunner'];
  const count = Math.min(12, 3 + Math.ceil(n * 0.85));
  const list = [];
  const heavyChance = n >= 3 ? Math.min(0.38, 0.07 + n * 0.032) : 0;
  for (let i = 0; i < count; i++) {
    const roll = rng();
    if (roll < heavyChance) list.push('heavy');
    else if (roll < 0.6) list.push('gunner');
    else list.push('scout');
  }
  if (n >= 4 && !list.includes('heavy')) list[0] = 'heavy';
  if (n === 2) list[0] = 'gunner';
  return list;
}

function startWave(n) {
  game.wave = n;
  game.waveActive = true;
  const list = composeWave(n);
  game.queue = list.map((type, i) => ({ type, t: 0.35 + i * 0.55, done: false }));
  showBanner('INCOMING', `WAVE ${String(n).padStart(2, '0')}`, `${list.length} HOSTILES DETECTED`, false);
  audio.wave(false);
}

function findSpawnPosition() {
  for (let i = 0; i < 100; i++) {
    const a = rand(0, TAU);
    const d = rand(420, 790);
    const x = clamp(player.x + Math.cos(a) * d, WORLD.pad + 60, WORLD.w - WORLD.pad - 60);
    const y = clamp(player.y + Math.sin(a) * d, WORLD.pad + 60, WORLD.h - WORLD.pad - 60);
    if (isBlockedCircle(x, y, 34)) continue;
    if (Math.hypot(x - player.x, y - player.y) < 320) continue;
    return { x, y };
  }
  return { x: 200, y: 200 };
}

function updateWave(dt) {
  if (!game.waveActive) {
    if (game.wave > 0 && game.state === 'playing') {
      game.waveClearTimer -= dt;
      if (game.waveClearTimer <= 0) startWave(game.wave + 1);
    }
    return;
  }

  for (const item of game.queue) {
    if (item.done) continue;
    item.t -= dt;
    if (item.t <= 0) {
      item.done = true;
      const pos = findSpawnPosition();
      spawnEnemy(item.type, pos.x, pos.y);
    }
  }
  game.queue = game.queue.filter((item) => !item.done);

  const alive = enemies.filter((e) => !e.dead);
  if (game.queue.length === 0 && alive.length === 0) {
    game.waveActive = false;
    game.waveClearTimer = 4.3;
    const bonus = game.wave * 125;
    game.score += bonus;
    player.hp = Math.min(player.maxHp, player.hp + 18);
    spawnPickup('repair', player.x + rand(-60, 60), player.y + rand(-60, 60));
    showBanner('SECTOR CLEARED', `WAVE ${String(game.wave).padStart(2, '0')}`, `+${bonus} BONUS · ARMOR PATCHED`, true);
    audio.wave(true);
  }
}

// ---------- projectiles ----------

function spawnShell(x, y, angle, owner, damage, speed) {
  shells.push({
    x, y, px: x, py: y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    angle, owner, damage, speed,
    life: 2.35,
    radius: 3.6,
    dead: false,
    trail: [],
  });
}

function playerFire() {
  if (!player || player.dead || player.reload > 0) return;
  const delay = player.rapid > 0 ? PLAYER_STATS.rapidDelay : PLAYER_STATS.fireDelay;
  player.reload = delay;
  const angle = player.turretAngle + rand(-0.014, 0.014);
  const muzzle = player.len * 0.73 + 10;
  const mx = player.x + Math.cos(angle) * muzzle;
  const my = player.y + Math.sin(angle) * muzzle;
  spawnShell(mx, my, angle, 'player', PLAYER_STATS.damage, PLAYER_STATS.shellSpeed);
  player.flash = 0.085;
  player.vx -= Math.cos(angle) * 16;
  player.vy -= Math.sin(angle) * 16;
  addSparks(mx, my, 7, 150, '#ffd9a0');
  addSmoke(mx, my, 1);
  addShake(2.4);
  audio.cannon();
}

function enemyFire(e) {
  const angle = e.turretAngle + rand(-e.accuracy, e.accuracy);
  const muzzle = e.len * 0.72 + 9;
  spawnShell(
    e.x + Math.cos(angle) * muzzle,
    e.y + Math.sin(angle) * muzzle,
    angle,
    'enemy',
    e.damage,
    e.shellSpeed
  );
  e.flash = 0.075;
  e.reload = e.fireDelay * rand(0.85, 1.25);
  addSparks(e.x + Math.cos(angle) * muzzle, e.y + Math.sin(angle) * muzzle, 4, 100, '#ff8a5c');
  audio.enemyShot();
}

function updateShells(dt) {
  for (const s of shells) {
    if (s.dead) continue;
    s.px = s.x;
    s.py = s.y;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.life -= dt;

    if (s.trail.length > 4) s.trail.pop();
    s.trail.unshift({ x: s.x, y: s.y });

    if (s.life <= 0 ||
        s.x < WORLD.pad || s.x > WORLD.w - WORLD.pad ||
        s.y < WORLD.pad || s.y > WORLD.h - WORLD.pad) {
      s.dead = true;
      continue;
    }

    for (const o of obstacles) {
      if (o.dead) continue;
      if (segmentHitsObstacle(s.px, s.py, s.x, s.y, o, s.radius)) {
        shellImpact(s);
        hitObstacle(o, s);
        s.dead = true;
        break;
      }
    }
    if (s.dead) continue;

    if (s.owner === 'player') {
      for (const e of enemies) {
        if (e.dead || e.spawning > 0) continue;
        if (segmentHitsCircle(s.px, s.py, s.x, s.y, e.x, e.y, e.radius + s.radius)) {
          s.dead = true;
          shellImpact(s);
          damageEnemy(e, s.damage, s.x, s.y);
          break;
        }
      }
    } else if (player && !player.dead) {
      if (segmentHitsCircle(s.px, s.py, s.x, s.y, player.x, player.y, player.radius + s.radius)) {
        s.dead = true;
        shellImpact(s);
        damagePlayer(s.damage);
      }
    }
  }

  shells = shells.filter((s) => !s.dead);
  enemies = enemies.filter((e) => !e.dead);
  obstacles = obstacles.filter((o) => !o.dead);
}

function shellImpact(s) {
  addSparks(s.x, s.y, 5, 130, '#ffd8a0');
  addSmoke(s.x, s.y, 1);
  addShake(0.7);
}

function hitObstacle(o, shell) {
  shellImpact(shell);
  if (o.kind === 'barrel') {
    o.hp -= shell.damage;
    if (o.hp <= 0) explodeBarrel(o, 0);
    return;
  }
  if (o.kind === 'crate') {
    o.hp -= shell.damage * 1.45;
    if (o.hp <= 0) {
      o.dead = true;
      addDebris(o.x, o.y, 8, '#6c5838');
      boom(o.x, o.y, 0.75);
      addText(o.x, o.y - 20, 'CRATE DOWN', '#c9c0a4');
      if (rng() < 0.16) spawnPickup(pick(['repair', 'shield', 'rapid']), o.x, o.y);
    }
  }
  addSparks(shell.x, shell.y, 3, 80, '#ffce8f');
}

function explodeBarrel(barrel, depth) {
  if (barrel.dead || depth > 4) return;
  barrel.dead = true;
  boom(barrel.x, barrel.y, 2.1);
  addRing(barrel.x, barrel.y, 'rgba(255,138,61,0.9)', 190, 0.42);

  const radius = 158;
  for (const e of enemies) {
    if (e.dead) continue;
    const d = Math.hypot(e.x - barrel.x, e.y - barrel.y);
    if (d < radius) damageEnemy(e, 34 + 86 * (1 - d / radius), e.x, e.y);
  }
  if (player && !player.dead) {
    const d = Math.hypot(player.x - barrel.x, player.y - barrel.y);
    if (d < radius) damagePlayer(30 + 34 * (1 - d / radius));
  }
  for (const o of obstacles) {
    if (o === barrel || o.dead) continue;
    const d = Math.hypot(o.x - barrel.x, o.y - barrel.y);
    if (d > radius) continue;
    if (o.kind === 'barrel') explodeBarrel(o, depth + 1);
    else if (o.kind === 'crate') {
      o.hp -= 90 * (1 - d / radius);
      if (o.hp <= 0) {
        o.dead = true;
        addDebris(o.x, o.y, 6, '#6c5838');
        boom(o.x, o.y, 0.65);
      }
    }
  }
}

// ---------- damage & death ----------

function damageEnemy(e, amount, hx, hy) {
  if (!e || e.dead || e.spawning > 0) return;
  e.hp -= amount;
  e.flash = 1;
  addSparks(hx, hy, 6, 190, '#ffc37a');
  addText(hx + rand(-8, 8), hy - 12, `-${Math.round(amount)}`, '#ffd9a0', 0.5);
  addShake(0.8);
  audio.hit();
  if (e.hp <= 0) killEnemy(e);
}

function killEnemy(e) {
  if (e.dead) return;
  e.dead = true;
  const points = e.score;
  game.score += points;
  game.kills += 1;
  const heavy = e.type === 'heavy';
  boom(e.x, e.y, heavy ? 2.1 : 1.25);
  addDebris(e.x, e.y, heavy ? 13 : 8, e.dark);
  addText(e.x, e.y - 34, `+${points}`, '#ffcf7d', 1.1);
  dropPickup(e);
  feed(`YOU DESTROYED <b>${ENEMY_TYPES[e.type].label}</b> <span class="pts">+${points}</span>`);
  addShake(heavy ? 10 : 5);
}

function damagePlayer(amount) {
  if (!player || player.dead || game.state !== 'playing') return;
  let dmg = amount;
  if (player.shield > 0) {
    const absorbed = Math.min(player.shield, dmg);
    player.shield -= absorbed;
    dmg -= absorbed;
    addSparks(player.x, player.y, 10, 160, '#8be7ff');
  }
  if (dmg > 0) {
    player.hp = Math.max(0, player.hp - dmg);
    game.hitFlash = Math.min(1, game.hitFlash + 0.4 + dmg / 70);
    addShake(4 + dmg * 0.25);
    addSparks(player.x, player.y, 12, 220, '#ff8a5c');
    audio.playerHit();
  }
  if (player.hp <= 0) killPlayer();
}

function killPlayer() {
  if (!player || player.dead) return;
  player.dead = true;
  game.state = 'dying';
  game.deathTimer = 2.1;
  boom(player.x, player.y, 2.8);
  addDebris(player.x, player.y, 18, player.dark);
  addRing(player.x, player.y, 'rgba(255,120,70,0.9)', 240, 0.6);
  addShake(24);
  audio.boom(2.4);
  feed('SIGNAL LOST — TANK DESTROYED', true);
}

// ---------- pickups ----------

function spawnPickup(type, x, y) {
  pickups.push({
    type, x, y, dead: false, phase: rand(0, TAU), life: 22, vx: 0, vy: 0,
  });
  addRing(x, y, type === 'repair' ? 'rgba(168,212,123,.8)' : type === 'shield' ? 'rgba(139,231,255,.8)' : 'rgba(255,180,94,.8)', 46, 0.4);
}

function dropPickup(e) {
  if (rng() > 0.4) return;
  let type = pick(['repair', 'shield', 'rapid']);
  if (player.hp < 55 && rng() < 0.55) type = 'repair';
  const a = rand(0, TAU);
  spawnPickup(type, e.x + Math.cos(a) * 26, e.y + Math.sin(a) * 26);
}

function updatePickups(dt) {
  for (const p of pickups) {
    if (p.dead) continue;
    p.life -= dt;
    p.phase += dt * 3.4;
    if (p.life <= 0) { p.dead = true; continue; }
    if (!player || player.dead) continue;

    const dx = player.x - p.x;
    const dy = player.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d < 112 && d > 0.01) {
      const pull = 340 * (1 - d / 112);
      p.x += (dx / d) * pull * dt;
      p.y += (dy / d) * pull * dt;
    }
    if (d < player.radius + 17) {
      p.dead = true;
      if (p.type === 'repair') {
        player.hp = Math.min(player.maxHp, player.hp + 30);
        addText(player.x, player.y - 34, '+30 ARMOR', '#a8d47b', 1);
      } else if (p.type === 'shield') {
        player.shield = Math.min(60, player.shield + 45);
        addText(player.x, player.y - 34, 'SHIELD UP', '#8be7ff', 1);
      } else {
        player.rapid = 8;
        addText(player.x, player.y - 34, 'OVERDRIVE', '#ffb45e', 1);
      }
      addRing(p.x, p.y, p.type === 'repair' ? 'rgba(168,212,123,.8)' : p.type === 'shield' ? 'rgba(139,231,255,.8)' : 'rgba(255,180,94,.8)', 80, 0.4);
      audio.pickup();
    }
  }
  pickups = pickups.filter((p) => !p.dead);
}

// ---------- particles & floating text ----------

function addParticle(p) {
  if (particles.length >= MAX_PARTICLES) return;
  particles.push(p);
}

function addSparks(x, y, count, speed, color) {
  for (let i = 0; i < count; i++) {
    const a = rand(0, TAU);
    const v = rand(0.25, 1) * speed;
    addParticle({
      type: 'spark', x, y,
      vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      life: rand(0.16, 0.48), maxLife: 0.48,
      size: rand(1, 2.4), color, drag: 3.2,
    });
  }
}

function addSmoke(x, y, count, opts = {}) {
  for (let i = 0; i < count; i++) {
    addParticle({
      type: 'smoke', x: x + rand(-8, 8), y: y + rand(-8, 8),
      vx: rand(-22, 22), vy: rand(-28, 12),
      life: rand(0.5, 1.4), maxLife: 1.4,
      size: rand(7, 16), grow: rand(0.8, 2.2),
      color: opts.color || '#22251e', alpha: opts.alpha ?? 0.4, drag: 1.4,
    });
  }
}

function addDebris(x, y, count, color) {
  for (let i = 0; i < count; i++) {
    const a = rand(0, TAU);
    const v = rand(70, 260);
    addParticle({
      type: 'debris', x, y,
      vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      life: rand(0.5, 1.25), maxLife: 1.25,
      size: rand(2, 5.5), color, rot: rand(0, TAU), vr: rand(-9, 9), drag: 2.2,
    });
  }
}

function addRing(x, y, color, maxR, life) {
  addParticle({ type: 'ring', x, y, vx: 0, vy: 0, life, maxLife: life, size: 6, maxR, color });
}

function addText(x, y, text, color = '#ffd9a0', life = 0.8) {
  texts.push({ x, y, text, color, life, maxLife: life });
}

function boom(x, y, power = 1) {
  const p = clamp(power, 0.5, 3);
  addShake(6 + p * 7);
  audio.boom(p);
  addParticle({
    type: 'flash', x, y, vx: 0, vy: 0,
    life: 0.16, maxLife: 0.16, size: 22 + p * 30, color: '#ffd18a',
  });
  addRing(x, y, 'rgba(255,176,96,0.95)', 36 + p * 70, 0.38 + p * 0.08);
  addSparks(x, y, Math.floor(14 + p * 15), 240 + p * 130, '#ffc06e');
  addSmoke(x, y, Math.floor(7 + p * 7), { alpha: 0.45 });
  addDebris(x, y, Math.floor(5 + p * 5), '#403a2c');
  for (let i = 0; i < Math.floor(4 + p * 4); i++) {
    const a = rand(0, TAU);
    addParticle({
      type: 'ember', x: x + Math.cos(a) * rand(0, 10), y: y + Math.sin(a) * rand(0, 10),
      vx: Math.cos(a) * rand(30, 150), vy: Math.sin(a) * rand(30, 150),
      life: rand(0.4, 1.1), maxLife: 1.1, size: rand(1.5, 3.4), color: '#ff9b55', drag: 1.6,
    });
  }
}

function updateParticles(dt) {
  for (const p of particles) {
    p.life -= dt;
    if (p.life <= 0) continue;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= Math.exp(-(p.drag || 0) * dt);
    p.vy *= Math.exp(-(p.drag || 0) * dt);
    if (p.vr) p.rot += p.vr * dt;
    if (p.type === 'smoke') {
      p.size += p.grow * dt * 9;
      p.vx += 3 * dt;
      p.vy -= 6 * dt;
    }
  }
  particles = particles.filter((p) => p.life > 0);
}

function updateTexts(dt) {
  for (const t of texts) {
    t.life -= dt;
    t.y -= 30 * dt;
  }
  texts = texts.filter((t) => t.life > 0);
}

// ---------- tank AI & movement ----------

function addTrackMarks(t, moved) {
  if (!terrain || moved < 0.1) return;
  t.trackAcc += moved;
  if (t.trackAcc < 6) return;
  t.trackAcc = 0;
  const g = terrain.getContext('2d');
  g.save();
  g.translate(t.x - Math.cos(t.angle) * 8, t.y - Math.sin(t.angle) * 8);
  g.rotate(t.angle);
  g.fillStyle = 'rgba(8,10,7,0.15)';
  const half = t.width * 0.34;
  const tw = t.width * 0.24;
  g.fillRect(-5, -half - tw / 2, 10, tw);
  g.fillRect(-5, half - tw / 2, 10, tw);
  g.restore();
}

function updatePlayer(dt) {
  if (!player || player.dead) return;

  let ix = 0;
  let iy = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) iy -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) iy += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) ix -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
  if (sticks.left.active && sticks.left.mag > 0.08) {
    ix += sticks.left.dx;
    iy += sticks.left.dy;
  }

  const inputLen = Math.hypot(ix, iy);
  if (inputLen > 1) { ix /= inputLen; iy /= inputLen; }

  const accel = 1 - Math.exp(-11 * dt);
  player.vx += (ix * PLAYER_STATS.speed - player.vx) * accel;
  player.vy += (iy * PLAYER_STATS.speed - player.vy) * accel;

  const oldX = player.x;
  const oldY = player.y;
  player.x += player.vx * dt;
  player.y += player.vy * dt;
  resolveTankTerrain(player);

  const moved = Math.hypot(player.x - oldX, player.y - oldY);
  if (moved > 0.08) {
    player.angle = turnTowards(player.angle, Math.atan2(player.y - oldY, player.x - oldX), dt * 8);
    player.treadPhase = (player.treadPhase + moved * 0.035) % 1;
    addTrackMarks(player, moved);
  }

  let aim = player.turretAngle;
  if (touchMode && sticks.right.active && sticks.right.mag > 0.1) {
    aim = Math.atan2(sticks.right.dy, sticks.right.dx);
  } else if (mouse.seen) {
    const wp = screenToWorld(mouse.x, mouse.y);
    aim = Math.atan2(wp.y - player.y, wp.x - player.x);
  }
  player.turretAngle = turnTowards(player.turretAngle, aim, dt * 13);

  player.reload = Math.max(0, player.reload - dt);
  player.flash = Math.max(0, player.flash - dt * 9);
  player.rapid = Math.max(0, player.rapid - dt);

  const stickFire = touchMode && sticks.right.active && sticks.right.mag > 0.26;
  const wantFire = mouse.down || keys.has('Space') || stickFire;
  if (wantFire) playerFire();
}

function separateTanks() {
  const all = [];
  if (player && !player.dead && game.state === 'playing') all.push(player);
  for (const e of enemies) if (!e.dead) all.push(e);

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const min = a.radius + b.radius;
      if (d < min && d > 0.001) {
        const push = (min - d) / 2;
        const nx = dx / d;
        const ny = dy / d;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
      }
    }
  }
}

function updateEnemy(e, dt) {
  e.flash = Math.max(0, e.flash - dt * 8);
  e.reload -= dt;

  if (e.spawning > 0) {
    e.spawning -= dt;
    e.turretAngle += dt * 0.9;
    if (e.spawning <= 0) {
      addRing(e.x, e.y, 'rgba(255,93,66,0.5)', 60, 0.35);
      addSmoke(e.x, e.y, 3);
    }
    return;
  }

  const dx = player.x - e.x;
  const dy = player.y - e.y;
  const dist = Math.hypot(dx, dy) || 0.001;
  const nx = dx / dist;
  const ny = dy / dist;

  const eta = Math.min(0.9, dist / e.shellSpeed);
  const leadX = player.x + player.vx * eta * 0.72;
  const leadY = player.y + player.vy * eta * 0.72;
  const aimAngle = Math.atan2(leadY - e.y, leadX - e.x);
  e.turretAngle = turnTowards(e.turretAngle, aimAngle, dt * e.turretTurn);

  const los = lineClear(e.x, e.y, player.x, player.y, 5);

  e.strafeTimer -= dt;
  if (e.strafeTimer <= 0) {
    e.strafeSign *= -1;
    e.strafeTimer = rand(2.4, 5.4);
  }

  let mvx;
  let mvy;
  if (!los || dist > e.range + 85) {
    mvx = nx;
    mvy = ny;
  } else if (dist < e.range - 95) {
    mvx = -nx - ny * e.strafeSign * 0.6;
    mvy = -ny + nx * e.strafeSign * 0.6;
  } else {
    mvx = -ny * e.strafeSign + nx * 0.2;
    mvy = nx * e.strafeSign + ny * 0.2;
  }

  // Keep a little personal space from other armor.
  for (const other of enemies) {
    if (other === e || other.dead) continue;
    const ox = e.x - other.x;
    const oy = e.y - other.y;
    const od = Math.hypot(ox, oy);
    const desired = e.radius + other.radius + 28;
    if (od < desired && od > 0.001) {
      const w = (1 - od / desired) * 1.7;
      mvx += (ox / od) * w;
      mvy += (oy / od) * w;
    }
  }

  const [ax, ay] = avoidDirection(e, mvx, mvy);
  const targetVx = ax * e.speed;
  const targetVy = ay * e.speed;
  const accel = 1 - Math.exp(-4.6 * dt);
  e.vx += (targetVx - e.vx) * accel;
  e.vy += (targetVy - e.vy) * accel;

  const oldX = e.x;
  const oldY = e.y;
  e.x += e.vx * dt;
  e.y += e.vy * dt;
  resolveTankTerrain(e);

  const moved = Math.hypot(e.x - oldX, e.y - oldY);
  if (moved > 0.08) {
    e.angle = turnTowards(e.angle, Math.atan2(e.y - oldY, e.x - oldX), dt * 4.2);
    e.treadPhase = (e.treadPhase + moved * 0.03) % 1;
    addTrackMarks(e, moved);
  }

  if (los && dist < 690 && e.reload <= 0 && Math.abs(angleDelta(e.turretAngle, aimAngle)) < 0.135) {
    enemyFire(e);
  }
}

function updateEnemies(dt) {
  for (const e of enemies) {
    if (!e.dead) updateEnemy(e, dt);
  }
  separateTanks();
}

// ---------- camera & loop ----------

function updateCamera(dt) {
  camera.targetZoom = targetZoom();
  camera.zoom = lerp(camera.zoom, camera.targetZoom, 1 - Math.exp(-3.5 * dt));

  let tx = player ? player.x : WORLD.w / 2;
  let ty = player ? player.y : WORLD.h / 2;
  if (mouse.seen && game.state === 'playing') {
    const wp = screenToWorld(mouse.x, mouse.y);
    tx += (wp.x - tx) * 0.07;
    ty += (wp.y - ty) * 0.07;
  }

  const viewW = W / camera.zoom;
  const viewH = H / camera.zoom;
  if (viewW < WORLD.w) tx = clamp(tx, viewW / 2, WORLD.w - viewW / 2);
  else tx = WORLD.w / 2;
  if (viewH < WORLD.h) ty = clamp(ty, viewH / 2, WORLD.h - viewH / 2);
  else ty = WORLD.h / 2;

  const follow = 1 - Math.exp(-6 * dt);
  camera.x = lerp(camera.x, tx, follow);
  camera.y = lerp(camera.y, ty, follow);
  camera.shake *= Math.pow(0.002, dt);
  if (camera.shake < 0.05) camera.shake = 0;
}

function updateGame(dt) {
  game.time += dt;
  game.hitFlash = Math.max(0, game.hitFlash - dt * 2.1);

  if (game.state === 'playing') {
    updatePlayer(dt);
    if (game.state === 'playing') updateEnemies(dt);
    if (game.state === 'playing') updateShells(dt);
    if (game.state === 'playing') updatePickups(dt);
    if (game.state === 'playing') updateWave(dt);
  } else if (game.state === 'dying') {
    game.deathTimer -= dt;
    updateShells(dt);
    if (game.deathTimer <= 0) endGame();
  } else if (game.state === 'gameover' || game.state === 'menu') {
    if (game.state === 'gameover') updateShells(dt);
  }

  if (game.state !== 'paused') {
    updateParticles(dt);
    updateTexts(dt);
  }
  updateCamera(dt);
  damageEl.style.opacity = String(Math.min(1, game.hitFlash));
  updateHud(dt);
}

// ---------- rendering ----------

function inView(x, y, pad = 90) {
  const hw = W / (2 * camera.zoom) + pad;
  const hh = H / (2 * camera.zoom) + pad;
  return x > camera.x - hw && x < camera.x + hw && y > camera.y - hh && y < camera.y + hh;
}

function drawTank(t) {
  const L = t.len;
  const Wd = t.width;
  const R = t.radius;

  ctx.save();
  ctx.translate(t.x, t.y);

  if (t.isPlayer) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,180,94,0.28)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 7]);
    ctx.beginPath();
    ctx.arc(0, 0, R + 11, game.time * 0.5, game.time * 0.5 + TAU);
    ctx.stroke();
    ctx.restore();
  }

  if (t.spawning > 0) {
    const k = clamp(1 - t.spawning / 0.95, 0, 1);
    ctx.save();
    ctx.globalAlpha = 0.5 + Math.sin(game.time * 26) * 0.2;
    ctx.strokeStyle = '#ff5d42';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.arc(0, 0, 28 + (1 - k) * 24, game.time * 2, game.time * 2 + TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, -42);
    ctx.lineTo(8, -28);
    ctx.lineTo(-8, -28);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,93,66,0.8)';
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 0.25 + k * 0.75;
    const s = 0.72 + k * 0.28;
    ctx.scale(s, s);
  }

  // Ground shadow.
  ctx.save();
  ctx.rotate(t.angle);
  ctx.translate(5, 6);
  ctx.fillStyle = 'rgba(0,0,0,0.34)';
  roundRect(ctx, -L / 2, -Wd / 2, L, Wd, 10);
  ctx.fill();
  ctx.restore();

  // Tracks and hull.
  ctx.save();
  ctx.rotate(t.angle);
  const tw = Wd * 0.25;
  for (const side of [-1, 1]) {
    const ty = side * (Wd / 2 - tw / 2);
    ctx.fillStyle = '#11140e';
    roundRect(ctx, -L / 2 - 2, ty - tw / 2, L + 4, tw, 5);
    ctx.fill();

    ctx.save();
    roundRect(ctx, -L / 2 - 2, ty - tw / 2, L + 4, tw, 5);
    ctx.clip();
    ctx.strokeStyle = 'rgba(220,225,190,0.12)';
    ctx.lineWidth = 1.3;
    const shift = t.treadPhase * 7;
    for (let x = -L / 2 - 8 + shift; x < L / 2 + 8; x += 7) {
      ctx.beginPath();
      ctx.moveTo(x, ty - tw / 2 + 1);
      ctx.lineTo(x, ty + tw / 2 - 1);
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1;
    roundRect(ctx, -L / 2 - 2, ty - tw / 2, L + 4, tw, 5);
    ctx.stroke();
  }

  if (t.type === 'heavy') {
    ctx.fillStyle = '#2c211c';
    roundRect(ctx, -L * 0.36, -Wd * 0.62, L * 0.56, Wd * 0.13, 3);
    ctx.fill();
    roundRect(ctx, -L * 0.36, Wd * 0.49, L * 0.56, Wd * 0.13, 3);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,93,66,0.35)';
    ctx.fillRect(-L * 0.3, -Wd * 0.61, L * 0.08, 2);
    ctx.fillRect(-L * 0.3, Wd * 0.56, L * 0.08, 2);
  }

  const hg = ctx.createLinearGradient(0, -Wd / 2, 0, Wd / 2);
  hg.addColorStop(0, t.isPlayer ? '#98a97e' : t.color);
  hg.addColorStop(0.48, t.color);
  hg.addColorStop(1, t.dark);
  ctx.beginPath();
  ctx.moveTo(-L * 0.5, -Wd * 0.4);
  ctx.lineTo(L * 0.16, -Wd * 0.5);
  ctx.lineTo(L * 0.4, -Wd * 0.3);
  ctx.lineTo(L * 0.5, 0);
  ctx.lineTo(L * 0.4, Wd * 0.3);
  ctx.lineTo(L * 0.16, Wd * 0.5);
  ctx.lineTo(-L * 0.5, Wd * 0.4);
  ctx.closePath();
  ctx.fillStyle = hg;
  ctx.fill();
  ctx.strokeStyle = 'rgba(5,8,4,0.7)';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.fillStyle = t.accent;
  ctx.globalAlpha *= 0.9;
  ctx.beginPath();
  ctx.moveTo(L * 0.3, -Wd * 0.28);
  ctx.lineTo(L * 0.36, -Wd * 0.14);
  ctx.lineTo(L * 0.3, -Wd * 0.1);
  ctx.lineTo(L * 0.24, -Wd * 0.24);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(L * 0.3, Wd * 0.28);
  ctx.lineTo(L * 0.36, Wd * 0.14);
  ctx.lineTo(L * 0.3, Wd * 0.1);
  ctx.lineTo(L * 0.24, Wd * 0.24);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  for (let i = 0; i < 3; i++) {
    ctx.fillRect(-L * 0.44 + i * 5, -Wd * 0.24, 3, Wd * 0.48);
  }

  ctx.fillStyle = 'rgba(238,231,212,0.2)';
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(-L * 0.18 + i * 8, -Wd * 0.3, 1.1, 0, TAU);
    ctx.fill();
  }
  ctx.restore();

  // Turret.
  ctx.save();
  ctx.rotate(t.turretAngle);
  const barrel = L * 0.72;

  ctx.fillStyle = 'rgba(0,0,0,0.24)';
  roundRect(ctx, 8, -2, barrel + 13, 8, 2);
  ctx.fill();

  ctx.fillStyle = '#1e231a';
  roundRect(ctx, 8, -4.6, barrel, 9.2, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.lineWidth = 1.1;
  ctx.stroke();
  ctx.fillStyle = t.accent;
  ctx.globalAlpha *= 0.7;
  ctx.fillRect(8 + barrel * 0.5, -4.6, 4, 9.2);
  ctx.globalAlpha = 1;

  ctx.fillStyle = t.dark;
  roundRect(ctx, 8 + barrel - 9, -7, 16, 14, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.stroke();

  const tr = L * 0.235;
  const tg = ctx.createLinearGradient(0, -tr, 0, tr);
  tg.addColorStop(0, t.isPlayer ? '#a1b087' : t.color);
  tg.addColorStop(0.55, t.color);
  tg.addColorStop(1, t.dark);
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8;
    const px = Math.cos(a) * tr;
    const py = Math.sin(a) * tr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = tg;
  ctx.fill();
  ctx.strokeStyle = 'rgba(5,8,4,0.68)';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(-2, 0, tr * 0.38, 0, TAU);
  ctx.fillStyle = 'rgba(10,13,8,0.78)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(238,231,212,0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = t.accent;
  ctx.globalAlpha *= 0.75;
  ctx.fillRect(-tr * 0.55, -tr - 1.5, tr * 0.9, 3);
  ctx.globalAlpha = 1;

  if (t.flash > 0 && t.spawning <= 0) {
    const f = clamp(t.flash / 0.085, 0, 1);
    ctx.translate(8 + barrel + 7, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = f;
    ctx.fillStyle = '#ffd18a';
    ctx.beginPath();
    ctx.arc(0, 0, 8 + f * 5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,120,50,0.55)';
    ctx.beginPath();
    ctx.arc(0, 0, 18 + f * 8, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#fff0bd';
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(18 + f * 12, 0);
    ctx.lineTo(0, 5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  if (t.isPlayer && t.shield > 0) {
    const a = clamp(t.shield / 60, 0.15, 1);
    ctx.save();
    ctx.strokeStyle = `rgba(139,231,255,${0.25 + a * 0.5})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([13, 8]);
    ctx.lineDashOffset = -game.time * 28;
    ctx.beginPath();
    ctx.arc(0, 0, R + 14, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();

  if (!t.isPlayer && t.spawning <= 0) {
    const bw = clamp(L * 0.8, 36, 58);
    const ratio = clamp(t.hp / t.maxHp, 0, 1);
    const y = t.y - R - 17;
    ctx.save();
    ctx.translate(t.x, y);
    ctx.fillStyle = 'rgba(4,6,3,0.72)';
    ctx.fillRect(-bw / 2 - 1, -1, bw + 2, 5);
    ctx.fillStyle = ratio > 0.5 ? '#ffca7a' : ratio > 0.25 ? '#ff8a5c' : '#ff5d42';
    ctx.fillRect(-bw / 2, 0, bw * ratio, 3);
    ctx.restore();
  }
}

function drawObstacle(o) {
  if (o.dead) return;
  const w = o.w;
  const h = o.h;

  if (o.kind === 'barrier') {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    roundRect(ctx, -w / 2 + 6, -h / 2 + 7, w, h, 7);
    ctx.fill();

    const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    g.addColorStop(0, '#83836e');
    g.addColorStop(0.36, '#666957');
    g.addColorStop(1, '#454a3b');
    roundRect(ctx, -w / 2, -h / 2, w, h, 4);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(5,8,4,0.62)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    roundRect(ctx, -w / 2 + 4, -h / 2 + 4, w - 8, h - 8, 3);
    ctx.fillStyle = 'rgba(230,232,200,0.09)';
    ctx.fill();

    if (w > h) {
      ctx.fillStyle = 'rgba(14,17,12,0.5)';
      ctx.fillRect(-w / 2 + 9, -h / 2 + 4, 9, h - 8);
      ctx.fillRect(w / 2 - 18, -h / 2 + 4, 9, h - 8);
      ctx.fillStyle = 'rgba(255,180,94,0.24)';
      ctx.fillRect(-w / 2 + 10, -h / 2 + 4, 3, h - 8);
      ctx.fillRect(w / 2 - 13, -h / 2 + 4, 3, h - 8);
    } else {
      ctx.fillStyle = 'rgba(14,17,12,0.5)';
      ctx.fillRect(-w / 2 + 4, -h / 2 + 9, w - 8, 9);
      ctx.fillRect(-w / 2 + 4, h / 2 - 18, w - 8, 9);
      ctx.fillStyle = 'rgba(255,180,94,0.24)';
      ctx.fillRect(-w / 2 + 4, -h / 2 + 10, w - 8, 3);
      ctx.fillRect(-w / 2 + 4, h / 2 - 13, w - 8, 3);
    }

    ctx.fillStyle = 'rgba(230,232,200,0.18)';
    for (const sx of [-w / 2 + 9, w / 2 - 9]) {
      for (const sy of [-h / 2 + 9, h / 2 - 9]) {
        ctx.beginPath();
        ctx.arc(sx, sy, 1.6, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
    return;
  }

  if (o.kind === 'crate') {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    roundRect(ctx, -w / 2 + 5, -h / 2 + 6, w, h, 4);
    ctx.fill();

    const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    g.addColorStop(0, '#786443');
    g.addColorStop(0.5, '#5e4c32');
    g.addColorStop(1, '#413422');
    roundRect(ctx, -w / 2, -h / 2, w, h, 3);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(5,7,4,0.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.strokeStyle = 'rgba(25,22,14,0.62)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + 4, -h / 2 + 4);
    ctx.lineTo(w / 2 - 4, h / 2 - 4);
    ctx.moveTo(w / 2 - 4, -h / 2 + 4);
    ctx.lineTo(-w / 2 + 4, h / 2 - 4);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,180,94,0.68)';
    ctx.fillRect(-7, -7, 14, 14);
    ctx.fillStyle = 'rgba(18,20,13,0.8)';
    ctx.fillRect(-4, -1.5, 8, 3);
    ctx.fillRect(-1.5, -4, 3, 8);

    if (o.hp < o.maxHp) {
      const wear = 1 - o.hp / o.maxHp;
      ctx.strokeStyle = `rgba(10,12,8,${0.3 + wear * 0.5})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-w * 0.18, -h / 2 + 3);
      ctx.lineTo(-w * 0.06, -h * 0.14);
      ctx.lineTo(-w * 0.2, h * 0.04);
      ctx.lineTo(-w * 0.08, h * 0.24);
      ctx.stroke();
      if (wear > 0.5) {
        ctx.beginPath();
        ctx.moveTo(w * 0.22, -h * 0.3);
        ctx.lineTo(w * 0.08, -h * 0.1);
        ctx.lineTo(w * 0.24, h * 0.1);
        ctx.stroke();
      }
    }
    ctx.restore();
    return;
  }

  if (o.kind === 'rock') {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.ellipse(5, 7, o.r * 1.05, o.r * 0.8, 0, 0, TAU);
    ctx.fill();

    ctx.beginPath();
    o.points.forEach(([px, py], i) => {
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    const g = ctx.createLinearGradient(0, -o.r, 0, o.r);
    g.addColorStop(0, '#5a5e4d');
    g.addColorStop(0.55, '#45493b');
    g.addColorStop(1, '#303329');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(7,9,5,0.68)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.beginPath();
    o.points.forEach(([px, py], i) => {
      const fx = px * 0.64 - 2;
      const fy = py * 0.64 - 3;
      if (i === 0) ctx.moveTo(fx, fy);
      else ctx.lineTo(fx, fy);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(220,225,190,0.09)';
    ctx.fill();
    ctx.restore();
    return;
  }

  if (o.kind === 'barrel') {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.beginPath();
    ctx.ellipse(4, 5, o.r * 1.05, o.r * 0.88, 0, 0, TAU);
    ctx.fill();

    const g = ctx.createRadialGradient(-o.r * 0.35, -o.r * 0.4, 2, 0, 0, o.r);
    g.addColorStop(0, '#d07048');
    g.addColorStop(0.55, '#9c432b');
    g.addColorStop(1, '#5b2719');
    ctx.beginPath();
    ctx.arc(0, 0, o.r, 0, TAU);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,8,5,0.7)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.strokeStyle = 'rgba(20,15,10,0.45)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, o.r * 0.7, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, o.r * 0.38, 0, TAU);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,180,94,0.85)';
    ctx.beginPath();
    ctx.moveTo(0, -o.r * 0.34);
    ctx.lineTo(o.r * 0.28, o.r * 0.2);
    ctx.lineTo(-o.r * 0.28, o.r * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function drawPickup(p) {
  const colors = {
    repair: { c: '#a8d47b', rgb: '168,212,123' },
    shield: { c: '#8be7ff', rgb: '139,231,255' },
    rapid: { c: '#ffb45e', rgb: '255,180,94' },
  };
  const col = colors[p.type];
  const bob = Math.sin(p.phase) * 2;
  const blink = p.life < 4 ? 0.45 + Math.abs(Math.sin(p.life * 9)) * 0.55 : 1;

  ctx.save();
  ctx.translate(p.x, p.y + bob);
  ctx.globalAlpha = blink;

  const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 31);
  glow.addColorStop(0, `rgba(${col.rgb},0.34)`);
  glow.addColorStop(1, `rgba(${col.rgb},0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(-32, -32, 64, 64);

  ctx.fillStyle = '#0d120b';
  ctx.strokeStyle = col.c;
  ctx.lineWidth = 1.5;
  roundRect(ctx, -13, -13, 26, 26, 3);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = col.c;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  if (p.type === 'repair') {
    ctx.beginPath();
    ctx.moveTo(-6, 0);
    ctx.lineTo(6, 0);
    ctx.moveTo(0, -6);
    ctx.lineTo(0, 6);
    ctx.stroke();
  } else if (p.type === 'shield') {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU - Math.PI / 2;
      const px = Math.cos(a) * 7;
      const py = Math.sin(a) * 7;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(-7, -5);
    ctx.lineTo(0, 0);
    ctx.lineTo(-7, 5);
    ctx.moveTo(1, -5);
    ctx.lineTo(8, 0);
    ctx.lineTo(1, 5);
    ctx.stroke();
  }
  ctx.restore();
}

function drawShell(s) {
  const col = s.owner === 'player' ? '255,208,138' : '255,106,69';
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  const tx = s.trail.length > 1 ? s.trail[s.trail.length - 1].x : s.px;
  const ty = s.trail.length > 1 ? s.trail[s.trail.length - 1].y : s.py;
  ctx.strokeStyle = `rgba(${col},0.18)`;
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(s.x, s.y);
  ctx.stroke();

  ctx.strokeStyle = `rgba(${col},0.72)`;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(s.px, s.py);
  ctx.lineTo(s.x, s.y);
  ctx.stroke();

  ctx.fillStyle = `rgba(${col},0.95)`;
  ctx.beginPath();
  ctx.arc(s.x, s.y, 3.6, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawParticles() {
  for (const p of particles) {
    const a = clamp(p.life / p.maxLife, 0, 1);
    if (p.type === 'smoke') {
      ctx.globalAlpha = a * (p.alpha || 0.35);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
    } else if (p.type === 'spark' || p.type === 'ember') {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.size;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.018, p.y - p.vy * 0.018);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    } else if (p.type === 'debris') {
      ctx.globalAlpha = Math.min(1, a * 1.6);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot || 0);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
      ctx.restore();
    } else if (p.type === 'ring') {
      ctx.globalAlpha = a * 0.75;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1 + a * 2.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size + (1 - a) * p.maxR, 0, TAU);
      ctx.stroke();
    } else if (p.type === 'flash') {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a * 0.9;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.45 + a * 0.75), 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function drawTexts() {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const t of texts) {
    const a = clamp(t.life / t.maxLife, 0, 1);
    ctx.globalAlpha = a;
    ctx.font = '700 12px ui-monospace, monospace';
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, t.x, t.y);
  }
  ctx.globalAlpha = 1;
}

function drawThreatIndicators() {
  if (game.state !== 'playing' && game.state !== 'dying') return;
  const margin = 34;
  for (const e of enemies) {
    if (e.dead) continue;
    if (inView(e.x, e.y, 0)) continue;
    const dx = (e.x - camera.x) * camera.zoom;
    const dy = (e.y - camera.y) * camera.zoom;
    const halfW = W / 2 - margin;
    const halfH = H / 2 - margin;
    const k = Math.min(
      Math.abs(dx) > 0.01 ? halfW / Math.abs(dx) : Infinity,
      Math.abs(dy) > 0.01 ? halfH / Math.abs(dy) : Infinity
    );
    if (!Number.isFinite(k)) continue;
    const sx = W / 2 + dx * k;
    const sy = H / 2 + dy * k;
    const angle = Math.atan2(dy, dx);

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(angle);
    ctx.globalAlpha = e.spawning > 0 ? 0.32 : 0.6;
    ctx.fillStyle = '#ff5d42';
    ctx.beginPath();
    ctx.moveTo(12, 0);
    ctx.lineTo(-5, -7);
    ctx.lineTo(-1, 0);
    ctx.lineTo(-5, 7);
    ctx.closePath();
    ctx.fill();
    if (e.type === 'heavy') {
      ctx.globalAlpha *= 0.55;
      ctx.fillRect(-12, -2, 6, 4);
    }
    ctx.restore();
  }
}

function drawCrosshair() {
  if (!mouse.seen || touchMode || game.state !== 'playing' || !player) return;
  const x = mouse.x;
  const y = mouse.y;
  const ready = player.reload <= 0;
  const color = ready ? 'rgba(255,180,94,0.92)' : 'rgba(238,231,212,0.5)';

  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;

  const gap = 7;
  const len = 7;
  ctx.beginPath();
  ctx.moveTo(-gap - len, 0);
  ctx.lineTo(-gap, 0);
  ctx.moveTo(gap, 0);
  ctx.lineTo(gap + len, 0);
  ctx.moveTo(0, -gap - len);
  ctx.lineTo(0, -gap);
  ctx.moveTo(0, gap);
  ctx.lineTo(0, gap + len);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, 0, 1.5, 0, TAU);
  ctx.fill();

  if (!ready) {
    const delay = player.rapid > 0 ? PLAYER_STATS.rapidDelay : PLAYER_STATS.fireDelay;
    const progress = clamp(1 - player.reload / delay, 0, 1);
    ctx.strokeStyle = 'rgba(255,180,94,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 19, -Math.PI / 2, -Math.PI / 2 + TAU * progress);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSticks() {
  if (!touchMode || game.state !== 'playing') return;
  const defaults = stickDefaults();
  const pairs = [
    [sticks.left, defaults.left, 'MOVE'],
    [sticks.right, defaults.right, 'AIM · FIRE'],
  ];
  for (const [stick, def, label] of pairs) {
    const active = stick.active;
    const bx = active ? stick.bx : def.x;
    const by = active ? stick.by : def.y;
    const alpha = active ? 0.42 : 0.16;
    const R = 48;

    ctx.save();
    ctx.translate(bx, by);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(10,14,8,0.8)';
    ctx.beginPath();
    ctx.arc(0, 0, R + 6, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#eee7d4';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.stroke();

    ctx.globalAlpha = alpha * 0.8;
    ctx.strokeStyle = '#ffb45e';
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.62, 0, TAU);
    ctx.stroke();

    ctx.globalAlpha = active ? 0.8 : 0.28;
    const kx = active ? stick.dx * R : 0;
    const ky = active ? stick.dy * R : 0;
    ctx.fillStyle = 'rgba(255,180,94,0.35)';
    ctx.beginPath();
    ctx.arc(kx, ky, 20, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#ffb45e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(kx, ky, 20, 0, TAU);
    ctx.stroke();

    ctx.globalAlpha = active ? 0.75 : 0.3;
    ctx.fillStyle = '#eee7d4';
    ctx.font = '600 9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, R + 20);
    ctx.restore();
  }
}

function drawMinimap() {
  if (!miniCtx) return;
  const cw = mini.width;
  const ch = mini.height;
  miniCtx.clearRect(0, 0, cw, ch);
  miniCtx.fillStyle = '#080b07';
  miniCtx.fillRect(0, 0, cw, ch);

  const scale = Math.min((cw - 14) / WORLD.w, (ch - 14) / WORLD.h);
  const ox = (cw - WORLD.w * scale) / 2;
  const oy = (ch - WORLD.h * scale) / 2;

  miniCtx.strokeStyle = 'rgba(238,231,212,0.06)';
  miniCtx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    miniCtx.beginPath();
    miniCtx.moveTo(ox + (WORLD.w * scale * i) / 4, oy);
    miniCtx.lineTo(ox + (WORLD.w * scale * i) / 4, oy + WORLD.h * scale);
    miniCtx.stroke();
    miniCtx.beginPath();
    miniCtx.moveTo(ox, oy + (WORLD.h * scale * i) / 4);
    miniCtx.lineTo(ox + WORLD.w * scale, oy + (WORLD.h * scale * i) / 4);
    miniCtx.stroke();
  }

  for (const o of obstacles) {
    if (o.dead) continue;
    miniCtx.fillStyle = o.kind === 'barrel' ? 'rgba(255,93,66,0.65)' : 'rgba(150,156,128,0.32)';
    if (o.shape === 'rect') {
      miniCtx.fillRect(ox + (o.x - o.w / 2) * scale, oy + (o.y - o.h / 2) * scale, Math.max(1.5, o.w * scale), Math.max(1.5, o.h * scale));
    } else {
      miniCtx.beginPath();
      miniCtx.arc(ox + o.x * scale, oy + o.y * scale, Math.max(1.2, o.r * scale), 0, TAU);
      miniCtx.fill();
    }
  }

  for (const p of pickups) {
    if (p.dead) continue;
    miniCtx.fillStyle = p.type === 'repair' ? '#a8d47b' : p.type === 'shield' ? '#8be7ff' : '#ffb45e';
    miniCtx.beginPath();
    miniCtx.arc(ox + p.x * scale, oy + p.y * scale, 2.2, 0, TAU);
    miniCtx.fill();
  }

  for (const e of enemies) {
    if (e.dead) continue;
    miniCtx.fillStyle = e.spawning > 0 ? 'rgba(255,93,66,0.45)' : '#ff5d42';
    miniCtx.beginPath();
    miniCtx.arc(ox + e.x * scale, oy + e.y * scale, e.type === 'heavy' ? 3 : 2.2, 0, TAU);
    miniCtx.fill();
  }

  if (player) {
    const px = ox + player.x * scale;
    const py = oy + player.y * scale;
    miniCtx.save();
    miniCtx.translate(px, py);
    miniCtx.rotate(player.turretAngle);
    miniCtx.fillStyle = '#ffd9a0';
    miniCtx.beginPath();
    miniCtx.moveTo(6, 0);
    miniCtx.lineTo(-4, 4);
    miniCtx.lineTo(-4, -4);
    miniCtx.closePath();
    miniCtx.fill();
    miniCtx.restore();
  }

  // Camera viewport bracket.
  const vw = (W / camera.zoom) * scale;
  const vh = (H / camera.zoom) * scale;
  miniCtx.strokeStyle = 'rgba(255,180,94,0.2)';
  miniCtx.lineWidth = 1;
  miniCtx.strokeRect(ox + (camera.x - W / (2 * camera.zoom)) * scale, oy + (camera.y - H / (2 * camera.zoom)) * scale, vw, vh);

  miniCtx.strokeStyle = 'rgba(238,231,212,0.12)';
  miniCtx.strokeRect(0.5, 0.5, cw - 1, ch - 1);
}

function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#080b07';
  ctx.fillRect(0, 0, W, H);

  const shakeX = (Math.random() * 2 - 1) * camera.shake;
  const shakeY = (Math.random() * 2 - 1) * camera.shake;

  ctx.save();
  ctx.translate(W / 2 + shakeX, H / 2 + shakeY);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  if (terrain) ctx.drawImage(terrain, 0, 0);

  for (const p of pickups) {
    if (!p.dead && inView(p.x, p.y, 40)) drawPickup(p);
  }

  const drawList = [];
  for (const o of obstacles) {
    if (o.dead) continue;
    if (inView(o.x, o.y, Math.max(o.w, o.h) * 0.5 + 60)) {
      drawList.push({ y: o.sortY, kind: 'obstacle', obj: o });
    }
  }
  for (const e of enemies) {
    if (e.dead) continue;
    if (inView(e.x, e.y, 80)) drawList.push({ y: e.y + e.radius * 0.7, kind: 'tank', obj: e });
  }
  if (player && !player.dead && inView(player.x, player.y, 90)) {
    drawList.push({ y: player.y + player.radius * 0.7, kind: 'tank', obj: player });
  }
  drawList.sort((a, b) => a.y - b.y);
  for (const item of drawList) {
    if (item.kind === 'obstacle') drawObstacle(item.obj);
    else drawTank(item.obj);
  }

  for (const s of shells) {
    if (inView(s.x, s.y, 60)) drawShell(s);
  }

  drawParticles();
  drawTexts();
  ctx.restore();

  drawThreatIndicators();
  drawCrosshair();
  drawSticks();
  drawMinimap();
}

// ---------- HUD, feed, banners ----------

function setText(el, value) {
  if (el && el.textContent !== value) el.textContent = value;
}

function updateHud() {
  if (!player) return;
  const hp = Math.max(0, Math.round(player.hp));
  const pct = clamp((hp / player.maxHp) * 100, 0, 100);

  setText(ui.score, game.score.toLocaleString('en-US'));
  setText(ui.best, Math.max(game.best, game.score).toLocaleString('en-US'));
  setText(ui.wave, String(Math.max(1, game.wave)).padStart(2, '0'));

  let remaining = game.queue.length;
  for (const e of enemies) if (!e.dead) remaining++;
  setText(ui.enemies, String(remaining));

  ui.armorFill.style.width = `${pct}%`;
  ui.armorFill.classList.toggle('mid', pct <= 55 && pct > 25);
  ui.armorFill.classList.toggle('low', pct <= 25);
  setText(ui.armorVal, String(hp));
  ui.shieldFill.style.width = `${clamp((player.shield / 60) * 100, 0, 100)}%`;

  ui.shieldChip.classList.toggle('on', player.shield > 0.5);
  const shieldValue = ui.shieldChip.querySelector('b');
  if (shieldValue) setText(shieldValue, String(Math.ceil(player.shield)));

  ui.rapidChip.classList.toggle('on', player.rapid > 0.05);
  const rapidValue = ui.rapidChip.querySelector('b');
  if (rapidValue) setText(rapidValue, player.rapid.toFixed(1));

  const delay = player.rapid > 0 ? PLAYER_STATS.rapidDelay : PLAYER_STATS.fireDelay;
  const progress = clamp(1 - player.reload / delay, 0, 1);
  ui.reloadFill.style.width = `${progress * 100}%`;
  setText(
    ui.weaponState,
    player.rapid > 0 ? 'OVERDRIVE' : progress >= 0.999 ? 'READY' : 'CYCLING'
  );
}

function feed(html, hostile = false) {
  const el = document.createElement('div');
  el.className = 'feed-item' + (hostile ? ' hostile' : '');
  el.innerHTML = html;
  feedEl.prepend(el);
  while (feedEl.children.length > 4) feedEl.lastElementChild.remove();
  setTimeout(() => el.classList.add('out'), 2700);
  setTimeout(() => el.remove(), 3400);
}

let bannerTimer = 0;
function showBanner(kicker, title, sub, clear = false) {
  ui.bannerKicker.textContent = kicker;
  ui.bannerTitle.textContent = title;
  ui.bannerSub.textContent = sub;
  bannerEl.classList.toggle('clear', clear);
  bannerEl.classList.remove('show');
  void bannerEl.offsetWidth;
  bannerEl.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => bannerEl.classList.remove('show'), 2600);
}

// ---------- flow ----------

function resetGame() {
  rng = mulberry32((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
  game.score = 0;
  game.kills = 0;
  game.wave = 0;
  game.waveActive = false;
  game.waveClearTimer = 0;
  game.queue = [];
  game.deathTimer = 0;
  game.hitFlash = 0;
  game.time = 0;

  buildTerrain();
  obstacles = generateObstacles();
  player = createPlayer();
  enemies = [];
  shells = [];
  pickups = [];
  particles = [];
  texts = [];

  camera.x = player.x;
  camera.y = player.y;
  camera.zoom = targetZoom();
  camera.targetZoom = camera.zoom;
  camera.shake = 0;

  feedEl.innerHTML = '';
  bannerEl.classList.remove('show');
  damageEl.style.opacity = '0';
  updateHud();
  drawMinimap();
}

function startGame() {
  audio.init();
  audio.setMuted(game.muted);
  resetGame();
  document.body.classList.remove('in-menu');
  introEl.classList.add('hidden');
  overEl.classList.add('hidden');
  pauseEl.classList.add('hidden');
  keys.clear();
  mouse.down = false;
  game.state = 'playing';
  startWave(1);
  lastFrame = performance.now();
}

function endGame() {
  game.state = 'gameover';
  if (game.score > game.best) {
    game.best = game.score;
    saveBest(game.best);
  }
  ui.goWave.textContent = String(game.wave);
  ui.goKills.textContent = String(game.kills);
  ui.goScore.textContent = game.score.toLocaleString('en-US');
  ui.goBest.textContent = game.best.toLocaleString('en-US');
  ui.introBest.textContent = game.best.toLocaleString('en-US');
  updateHud();
  keys.clear();
  mouse.down = false;
  overEl.classList.remove('hidden');
}

function togglePause() {
  if (game.state === 'playing') {
    game.state = 'paused';
    pauseEl.classList.remove('hidden');
    keys.clear();
    mouse.down = false;
  } else if (game.state === 'paused') {
    game.state = 'playing';
    pauseEl.classList.add('hidden');
    lastFrame = performance.now();
  }
}

function toggleMute() {
  game.muted = !game.muted;
  audio.setMuted(game.muted);
  ui.muteBtn.classList.toggle('muted', game.muted);
  ui.muteBtn.setAttribute('aria-pressed', game.muted ? 'true' : 'false');
  ui.muteBtn.setAttribute('aria-label', game.muted ? 'Unmute audio' : 'Mute audio');
  try { localStorage.setItem('ironsiege.muted', game.muted ? '1' : '0'); } catch { /* ignore */ }
}

ui.playBtn.addEventListener('click', startGame);
ui.againBtn.addEventListener('click', startGame);
ui.resumeBtn.addEventListener('click', togglePause);
ui.pauseBtn.addEventListener('click', () => {
  if (game.state === 'playing') togglePause();
});
ui.muteBtn.addEventListener('click', toggleMute);

// ---------- boot ----------

function init() {
  document.body.classList.add('in-menu');
  try {
    game.muted = localStorage.getItem('ironsiege.muted') === '1';
  } catch {
    game.muted = false;
  }
  audio.muted = game.muted;
  ui.muteBtn.classList.toggle('muted', game.muted);
  ui.muteBtn.setAttribute('aria-pressed', game.muted ? 'true' : 'false');
  ui.muteBtn.setAttribute('aria-label', game.muted ? 'Unmute audio' : 'Mute audio');

  resize();
  resetGame();
  game.state = 'menu';
  ui.introBest.textContent = game.best.toLocaleString('en-US');
  ui.best.textContent = game.best.toLocaleString('en-US');
  updateHud();
  drawMinimap();

  lastFrame = performance.now();
  requestAnimationFrame(frame);
}

let lastFrame = performance.now();

function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  updateGame(dt);
  render();
  requestAnimationFrame(frame);
}

init();

