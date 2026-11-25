import * as THREE from 'three';

// =====================================================================
//  3D 축구 — 리팩터링 버전
//  · 60Hz 고정 시뮬레이션 (모니터 주사율과 무관하게 같은 속도)
//  · 마그누스 효과(= 전류의 자기작용과 같은 꼴의 힘)로 감아차기/드롭슛 구현
//      전류가 자기장에서 받는 힘   F = I(L × B)   (플레밍 왼손 법칙)
//      회전하는 공이 받는 힘        F = k(ω × v)
//    → 힘이 항상 속도에 수직이라 공의 '속력'은 그대로, '방향'만 휜다.
// =====================================================================

// ===== DOM =====
const $ = id => document.getElementById(id);
const wrap = $('game-wrap');
const scoreText = $('score-text');
const matchTimeEl = $('match-time');
const halfLabel = $('half-label');
const msgEl = $('msg');
const overlay = $('overlay');
const overlayTitle = $('overlay-title');
const overlaySub = $('overlay-sub');
const spaceHint = $('space-hint');
const statsBox = $('stats-box');
const setpieceHint = $('setpiece-hint');
const setpieceUi = $('setpiece-ui');
const setpieceKickType = $('setpiece-kick-type');
const setpiecePowerFill = $('setpiece-power-fill');
const stamPos = $('stam-pos');
const stamName = $('stam-name');
const stamFill = $('stam-fill');
const stamPct = $('stam-pct');
const replayBadge = $('replay-badge');

// ===== 상수 =====
const FIELD_W = 115;  // 실제 규격(105)보다 조금 넓게 — 선수 간격이 여유 있게 보이도록
const FIELD_H = 74;
const FSCALE = FIELD_W / 105; // 포메이션 좌표(105m 기준)를 넓어진 경기장에 맞춤
const GOAL_W = 7.32;
const GOAL_D = 2.5;
const GOAL_H = 2.44;
const PEN_W = 16.5;
const PEN_H = 40.32;
const SIX_W = 5.5;
const SIX_H = 18.32;
const PEN_SPOT = 11;
const CIRCLE_R = 9.15;
const PLAYER_R = 0.55;
const BALL_R = 0.22;
const POST_R = 0.08;
const WALK = 0.11475;
const SPRINT = 0.2023;
const THROW_CLEAR = 2;      // 규칙상 스로인 수비 거리 2m
const SET_CLEAR = 9.15;     // 프리킥/코너 9.15m

const FIXED_DT = 1 / 60;
const TIME_SCALE = 0.8;
let simScale = 0.8;
/** 게이지·조준처럼 '실제 시간' 기준으로 움직여야 하는 것의 보정값 */
function realK() { return TIME_SCALE / simScale; } // 전체 게임 속도 80% (모든 움직임과 시계가 20% 느림)
const GRAVITY = 0.022;
const AIR_DRAG = 0.993;
const ROLL_FRICTION = 0.97;
const MAGNUS_K = 0.012;     // ω×v 비례상수 (자기장 세기 B 같은 역할)
const SPIN_DECAY = 0.988;

const SHOT_SPEED_SCALE = 0.88; // 슛 기본 파워 상향
const PSHOT_FRAMES = 63; // 파워슛 게이지가 끝까지 도는 프레임 (이전 76보다 20% 빠르게)
const CHARGE_FRAMES = 21;   // 패스/로빙/스루/슛 게이지가 가득 차는 프레임
const LOFT_KINDS = new Set(['lob', 'long', 'lobThrough']); // 띄운 패스 (받는 쪽은 가슴 · 발로 트래핑)
const CHARGE_KEYS = { KeyA: 'lob', KeyW: 'through', KeyS: 'ground', KeyD: 'shoot' };
/** 조합 키 동작이 어느 키를 떼면 나가는지 */
const ACTION_KEY = { long: 'KeyS', lobThrough: 'KeyW', finesse: 'KeyD' };
const actionHeld = a => !!keys[ACTION_KEY[a] || Object.keys(CHARGE_KEYS).find(c => CHARGE_KEYS[c] === a)];

// menu | team_select | squad_setup | play | kickoff | goal_pause | halftime | setpiece | ended | et_offer
let phase = 'menu';
let half = 1; // 1,2,3(ET1),4(ET2)
let clockPaused = false;

// ===== Three.js =====
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x7fb2dc);
scene.fog = new THREE.Fog(0x7fb2dc, 170, 340);

const viewW = () => wrap?.offsetWidth || innerWidth;
const viewH = () => wrap?.offsetHeight || innerHeight;
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 400);
camera.position.set(0, 28, 32);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
if ('outputColorSpace' in renderer && THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
wrap.insertBefore(renderer.domElement, wrap.firstChild);
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;

function srgb(tex) {
  if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

scene.add(new THREE.HemisphereLight(0xffffff, 0x3a5a2a, 0.9));
const sun = new THREE.DirectionalLight(0xfff2d6, 1.15);
sun.position.set(30, 60, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
Object.assign(sun.shadow.camera, { left: -62, right: 62, top: 42, bottom: -42, near: 1, far: 160 });
scene.add(sun);

// ===== 경기장 =====
let crowdMesh = null;
const crowdParts = []; // 관중 인스턴스 묶음들 [{ mesh, base }]
// 긴 쪽 관중석 두 묶음: 카메라가 그쪽 관중석 쪽으로 가면 시야를 가리지 않게 투명하게 사라짐
const standGroups = { far: new THREE.Group(), near: new THREE.Group() };
for (const g of Object.values(standGroups)) { g.userData.op = 1; scene.add(g); }
let crowdBase = null;     // Float32Array [x, y, z, phase] * n
let crowdSection = null;  // 0 일반 · 1 홈 서포터즈 · 2 원정 서포터즈
const stadiumAnim = { ribbons: [], flags: [], boards: [], tifo: null, lastBoard: '', boardT: 0 };
let crowdExcite = 0;      // 0~1, 골 직후 1
const crowdDummy = new THREE.Object3D();

function makePitchTexture() {
  const PX = 18;
  const W = FIELD_W + 10;
  const H = FIELD_H + 10;
  const c = document.createElement('canvas');
  c.width = Math.round(W * PX);
  c.height = Math.round(H * PX);
  const g = c.getContext('2d');
  const X = x => (x + W / 2) * PX;
  const Z = z => (z + H / 2) * PX;

  // 실제 경기장 잔디: 깎은 방향이 다른 줄무늬(밝은 줄 · 어두운 줄) + 넓은 얼룩 + 잔디 잎 결 + 골문 앞 · 센터 마모
  g.fillStyle = '#3a8f3a';
  g.fillRect(0, 0, c.width, c.height);
  const bands = 18;
  const bw = FIELD_W / bands;
  for (let i = -3; i < bands + 3; i++) {
    const x0 = X(-FIELD_W / 2 + i * bw), w = bw * PX;
    const gr = g.createLinearGradient(x0, 0, x0 + w, 0);
    if (i % 2) { gr.addColorStop(0, '#2f7d33'); gr.addColorStop(0.5, '#2c7831'); gr.addColorStop(1, '#2f7d33'); }
    else { gr.addColorStop(0, '#3c943c'); gr.addColorStop(0.5, '#409a3f'); gr.addColorStop(1, '#3c943c'); }
    g.fillStyle = gr;
    g.fillRect(x0, 0, w, c.height);
  }
  // 넓은 얼룩 (햇빛 · 물기 · 잔디 밀도 차이)
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * c.width, y = Math.random() * c.height, r = (4 + Math.random() * 14) * PX;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    const dark = Math.random() < 0.55;
    rg.addColorStop(0, dark ? 'rgba(20,60,20,0.07)' : 'rgba(150,200,110,0.05)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // 잔디 잎: 짧은 선을 아주 많이 (색 · 방향 조금씩 다르게)
  const blades = ['rgba(90,160,70,0.16)', 'rgba(40,100,40,0.18)', 'rgba(120,180,90,0.10)', 'rgba(25,80,30,0.16)', 'rgba(70,140,55,0.14)'];
  g.lineWidth = 1;
  for (let b = 0; b < blades.length; b++) {
    g.strokeStyle = blades[b];
    g.beginPath();
    for (let i = 0; i < 26000; i++) {
      const x = Math.random() * c.width, y = Math.random() * c.height, l = 1.5 + Math.random() * 3.5, a = -1.2 + Math.random() * 0.8;
      g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    }
    g.stroke();
  }
  // 마모: 골문 앞 · 페널티 지점 · 센터 서클 (조금 누렇고 밝게)
  const wear = (x, z, rx, rz, a) => {
    g.save(); g.translate(X(x), Z(z)); g.scale(rx / rz, 1);
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, rz * PX);
    rg.addColorStop(0, `rgba(150,140,80,${a})`); rg.addColorStop(0.6, `rgba(140,140,80,${a * 0.45})`); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(-rz * PX, -rz * PX, rz * PX * 2, rz * PX * 2); g.restore();
  };
  for (const sd of [-1, 1]) { wear(sd * (FIELD_W / 2 - 2.5), 0, 3.2, 4.2, 0.22); wear(sd * (FIELD_W / 2 - PEN_SPOT), 0, 1.2, 1.2, 0.12); }
  wear(0, 0, 4, 4, 0.08);

  g.strokeStyle = 'rgba(250,250,245,0.9)';
  g.fillStyle = 'rgba(250,250,245,0.9)';
  g.lineWidth = 0.12 * PX;
  g.shadowColor = 'rgba(255,255,255,0.35)'; g.shadowBlur = 2; // 페인트 선 가장자리가 살짝 번진 느낌
  const rect = (x0, z0, x1, z1) => g.strokeRect(X(x0), Z(z0), (x1 - x0) * PX, (z1 - z0) * PX);
  const arc = (x, z, r, a0, a1) => { g.beginPath(); g.arc(X(x), Z(z), r * PX, a0, a1); g.stroke(); };
  const dot = (x, z, r) => { g.beginPath(); g.arc(X(x), Z(z), r * PX, 0, Math.PI * 2); g.fill(); };

  const hw = FIELD_W / 2;
  const hh = FIELD_H / 2;
  rect(-hw, -hh, hw, hh);
  g.beginPath(); g.moveTo(X(0), Z(-hh)); g.lineTo(X(0), Z(hh)); g.stroke();
  arc(0, 0, CIRCLE_R, 0, Math.PI * 2);
  dot(0, 0, 0.22);

  const arcA = Math.acos((PEN_W - PEN_SPOT) / CIRCLE_R);
  for (const s of [-1, 1]) {
    const gl = s * hw;
    rect(Math.min(gl, gl - s * PEN_W), -PEN_H / 2, Math.max(gl, gl - s * PEN_W), PEN_H / 2);
    rect(Math.min(gl, gl - s * SIX_W), -SIX_H / 2, Math.max(gl, gl - s * SIX_W), SIX_H / 2);
    const spotX = gl - s * PEN_SPOT;
    dot(spotX, 0, 0.2);
    if (s < 0) arc(spotX, 0, CIRCLE_R, -arcA, arcA);
    else arc(spotX, 0, CIRCLE_R, Math.PI - arcA, Math.PI + arcA);
  }
  arc(-hw, -hh, 1, 0, Math.PI / 2);
  arc(hw, -hh, 1, Math.PI / 2, Math.PI);
  arc(hw, hh, 1, Math.PI, Math.PI * 1.5);
  arc(-hw, hh, 1, Math.PI * 1.5, Math.PI * 2);

  g.shadowBlur = 0;
  const tex = srgb(new THREE.CanvasTexture(c));
  tex.anisotropy = MAX_ANISO;
  return { tex, W, H };
}
/** 잔디 결 요철 (작게 반복) — 가까이서 볼 때 잔디가 평평한 색칠처럼 보이지 않게 */
function makeGrassBump() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#808080'; g.fillRect(0, 0, 256, 256);
  g.lineWidth = 1;
  for (let i = 0; i < 9000; i++) {
    const v = 90 + Math.floor(Math.random() * 120);
    g.strokeStyle = `rgb(${v},${v},${v})`;
    const x = Math.random() * 256, y = Math.random() * 256, l = 2 + Math.random() * 5, a = -1.3 + Math.random() * 0.9;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = MAX_ANISO;
  return t;
}

const nets = [];
let netPrevBall = null;
/** 그물 출렁임: 공이 닿은 곳은 공 모양대로 밀려나고, 떨어지면 스프링처럼 찰랑이며 돌아옴 (실제 경기·리플레이 공통) */
function updateNets() {
  if (!nets.length) return;
  const bx = ball.x, by = ball.y, bz = ball.z;
  const pv = netPrevBall || { x: bx, y: by, z: bz };
  const bspd = Math.min(1.2, Math.hypot(bx - pv.x, by - pv.y, bz - pv.z));
  netPrevBall = { x: bx, y: by, z: bz };
  const nearGoal = Math.abs(bx) > FIELD_W / 2 - 1.5 && Math.abs(bz) < GOAL_W / 2 + 1.5 && by < GOAL_H + 1.5;
  for (const net of nets) {
    let touch = false, lx = 0, ly = 0, push = 0;
    if (nearGoal) {
      [lx, ly, push] = net.toLocal(bx, by, bz);
      const sideOk = !net.needInsideSide || net.needInsideSide * (bx - net.needInsideSide * FIELD_W / 2) > 0.05;
      // push: 공 중심이 그물면 안쪽에서 얼마나 떨어졌는지 (BALL_R보다 작으면 닿음)
      touch = sideOk && push < BALL_R + 0.02 && push > -0.7 && Math.abs(lx) < net.W / 2 + 0.2 && Math.abs(ly) < net.H / 2 + 0.2;
    }
    if (!touch && net.active <= 0) continue;
    net.active = touch ? 240 : net.active - 1;
    const { nu, nv, off, vel, pos } = net;
    const row = nu + 1;
    // 스프링 + 이웃 결합(물결) + 감쇠
    for (let j = 1; j < nv; j++) for (let i = 1; i < nu; i++) {
      const k = j * row + i;
      const nb = (off[k - 1] + off[k + 1] + off[k - row] + off[k + row]) * 0.25;
      vel[k] += (nb - off[k]) * 0.34 - off[k] * 0.03;
      vel[k] *= 0.94;
    }
    for (let k = 0; k < off.length; k++) { off[k] += vel[k]; if (off[k] > 1.05) { off[k] = 1.05; vel[k] *= -0.3; } else if (off[k] < -0.4) { off[k] = -0.4; vel[k] *= -0.3; } }
    if (touch) {
      const depth = BALL_R - push; // 그물을 밖으로 밀어낸 정도
      const R = 0.8 + Math.min(0.6, Math.max(0, depth) * 0.9);
      for (let j = 1; j < nv; j++) for (let i = 1; i < nu; i++) {
        const k = j * row + i;
        const vx = (i / nu - 0.5) * net.W, vy = (0.5 - j / nv) * net.H;
        const d = Math.hypot(vx - lx, vy - ly);
        if (d > R) continue;
        const f = Math.cos((d / R) * Math.PI / 2);
        const want = Math.max(0, depth) * 1.35 * f * f;
        if (off[k] < want) { vel[k] = Math.min(0.14, Math.max(vel[k], (want - off[k]) * 0.45) + bspd * 0.03 * f); off[k] = want; }
      }
    }
    const a = pos.array;
    for (let k = 0; k < off.length; k++) a[k * 3 + 2] = net.outSign * off[k];
    pos.needsUpdate = true;
    if (net.active <= 0) { off.fill(0); vel.fill(0); for (let k = 0; k < off.length; k++) a[k * 3 + 2] = 0; pos.needsUpdate = true; }
  }
}

/** 골 그물: 실제 경기장처럼 마름모(다이아몬드) 그물코 · 매듭 · 살짝 회색빛 흰 줄 */
function makeNetTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (!g) return c;
  g.lineCap = 'round';
  const line = (w, col) => {
    g.strokeStyle = col; g.lineWidth = w;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(64, 64); g.moveTo(64, 0); g.lineTo(0, 64);
    // 가장자리에서 이어지도록 반대편 조각도
    g.moveTo(-32, 32); g.lineTo(32, 96); g.moveTo(32, -32); g.lineTo(96, 32); g.moveTo(96, 32); g.lineTo(32, 96); g.moveTo(32, -32); g.lineTo(-32, 32);
    g.stroke();
  };
  line(4.5, 'rgba(0,0,0,0.18)');          // 줄 그림자
  line(2.6, 'rgba(236,238,240,0.92)');    // 그물 줄
  g.fillStyle = 'rgba(250,250,250,0.95)'; // 매듭
  for (const [x, y] of [[0, 0], [64, 0], [0, 64], [64, 64], [32, 32]]) { g.beginPath(); g.arc(x, y, 2.6, 0, Math.PI * 2); g.fill(); }
  return c;
}

function makeAdTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 64;
  const g = c.getContext('2d');
  const slots = [
    ['#0f172a', '#facc15', 'FAIR PLAY'],
    ['#1d4ed8', '#ffffff', '3D FOOTBALL'],
    ['#b91c1c', '#ffffff', 'KICK OFF'],
    ['#065f46', '#d9f99d', 'GOAL!'],
  ];
  slots.forEach(([bg, fg, text], i) => {
    g.fillStyle = bg;
    g.fillRect(i * 256, 0, 256, 64);
    g.fillStyle = fg;
    g.font = 'bold 34px "Segoe UI", "Malgun Gothic", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, i * 256 + 128, 34);
  });
  return c;
}

function makeStadium() {
  // 바깥 지면
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(320, 260),
    new THREE.MeshStandardMaterial({ color: 0x3f4a3c, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);

  const { tex, W, H } = makePitchTexture();
  const bump = makeGrassBump();
  if (bump && bump.repeat) bump.repeat.set(W / 1.6, H / 1.6);
  const pitch = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshStandardMaterial(bump ? { map: tex, roughness: 0.92, bumpMap: bump, bumpScale: 0.35 } : { map: tex, roughness: 0.95 })
  );
  pitch.rotation.x = -Math.PI / 2;
  pitch.receiveShadow = true;
  scene.add(pitch);

  // 골대
  const postMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.2, roughness: 0.35 });
  const netCanvas = makeNetTexture();
  function netMat(rx, ry) {
    const t = new THREE.CanvasTexture(netCanvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    t.anisotropy = MAX_ANISO;
    return new THREE.MeshLambertMaterial({ map: t, transparent: true, alphaTest: 0.04, side: THREE.DoubleSide, depthWrite: false });
  }
  const CELL = 0.24; // 마름모 그물코 하나 (텍스처 한 칸에 마름모 2개)
  function addNet(mesh, nu, nv, W, H, outSign, toLocal, needInsideSide = 0) {
    const pos = mesh.userData.netGeo?.attributes?.position;
    if (!pos || !(pos.array instanceof Float32Array)) return; // (테스트 환경)
    const n = (nu + 1) * (nv + 1);
    nets.push({ mesh, pos, nu, nv, W, H, outSign, toLocal, needInsideSide,
      off: new Float32Array(n), vel: new Float32Array(n), active: 0 });
  }
  function makeGoal(side) {
    const g = new THREE.Group();
    const postGeo = new THREE.CylinderGeometry(POST_R, POST_R, GOAL_H, 12);
    for (const z of [-GOAL_W / 2, GOAL_W / 2]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(0, GOAL_H / 2, z);
      post.castShadow = true;
      g.add(post);
      const back = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, GOAL_H, 6), postMat);
      back.position.set(side * GOAL_D, GOAL_H / 2, z);
      g.add(back);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(POST_R, POST_R, GOAL_W + POST_R * 2, 12), postMat);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(0, GOAL_H, 0);
    bar.castShadow = true;
    g.add(bar);
    // 실제 골대처럼: 뒤쪽 위 가로대 · 바닥 프레임(양옆 · 뒤) · 그물 지지대 (회색 철제)
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, metalness: 0.5, roughness: 0.4 });
    const rod = (len, r = 0.025) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), frameMat);
    const topBack = rod(GOAL_W);
    topBack.rotation.x = Math.PI / 2;
    topBack.position.set(side * GOAL_D, GOAL_H, 0);
    const groundBack = rod(GOAL_W, 0.03);
    groundBack.rotation.x = Math.PI / 2;
    groundBack.position.set(side * GOAL_D, 0.03, 0);
    g.add(topBack, groundBack);
    for (const z of [-GOAL_W / 2, GOAL_W / 2]) {
      const gs = rod(GOAL_D, 0.03);
      gs.rotation.z = Math.PI / 2;
      gs.position.set(side * GOAL_D / 2, 0.03, z);
      const ts = rod(GOAL_D, 0.022);
      ts.rotation.z = Math.PI / 2;
      ts.position.set(side * GOAL_D / 2, GOAL_H - 0.02, z);
      g.add(gs, ts);
    }
    // 골대 밑동 (잔디에 박힌 부분)
    for (const z of [-GOAL_W / 2, GOAL_W / 2]) {
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(POST_R * 1.15, POST_R * 1.15, 0.04, 12), postMat);
      foot.position.set(0, 0.02, z);
      g.add(foot);
    }

    // 그물은 잘게 나눈 면으로 만들어 공이 닿으면 늘어나고 출렁이게 함 (updateNets)
    const gx = side * (FIELD_W / 2);
    const backNetGeo = new THREE.PlaneGeometry(GOAL_W, GOAL_H, 28, 12);
    const backNet = new THREE.Mesh(backNetGeo, netMat(GOAL_W / CELL, GOAL_H / CELL));
    backNet.rotation.y = Math.PI / 2;
    backNet.position.set(side * GOAL_D, GOAL_H / 2, 0);
    backNet.userData.netGeo = backNetGeo;
    addNet(backNet, 28, 12, GOAL_W, GOAL_H, side,
      (bx, by, bz) => [-bz, by - GOAL_H / 2, side * (side * GOAL_D - (bx - gx))]);
    const topNetGeo = new THREE.PlaneGeometry(GOAL_D, GOAL_W, 10, 28);
    const topNet = new THREE.Mesh(topNetGeo, netMat(GOAL_D / CELL, GOAL_W / CELL));
    topNet.rotation.x = -Math.PI / 2;
    topNet.position.set(side * GOAL_D / 2, GOAL_H, 0);
    topNet.userData.netGeo = topNetGeo;
    addNet(topNet, 10, 28, GOAL_D, GOAL_W, 1,
      (bx, by, bz) => [(bx - gx) - side * GOAL_D / 2, -bz, GOAL_H - by]);
    g.add(backNet, topNet);
    for (const z of [-GOAL_W / 2, GOAL_W / 2]) {
      const sideNetGeo = new THREE.PlaneGeometry(GOAL_D, GOAL_H, 10, 12);
    const sideNet = new THREE.Mesh(sideNetGeo, netMat(GOAL_D / CELL, GOAL_H / CELL));
      sideNet.position.set(side * GOAL_D / 2, GOAL_H / 2, z);
      const sz = Math.sign(z);
        sideNet.userData.netGeo = sideNetGeo;
      addNet(sideNet, 10, 12, GOAL_D, GOAL_H, sz,
        (bx, by, bz) => [(bx - gx) - side * GOAL_D / 2, by - GOAL_H / 2, sz * (z - bz)], side);
      g.add(sideNet);
    }
    g.position.x = side * (FIELD_W / 2);
    scene.add(g);
  }
  makeGoal(-1);
  makeGoal(1);

  // 코너 플래그
  const flagPoleGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6);
  const flagGeo = new THREE.BufferGeometry();
  flagGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 1.5, 0, 0, 1.15, 0, 0.45, 1.33, 0]), 3));
  flagGeo.computeVertexNormals();
  const flagMat = new THREE.MeshBasicMaterial({ color: 0xfacc15, side: THREE.DoubleSide });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const pole = new THREE.Mesh(flagPoleGeo, postMat);
    pole.position.set(sx * FIELD_W / 2, 0.75, sz * FIELD_H / 2);
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.position.set(sx * FIELD_W / 2, 0, sz * FIELD_H / 2);
    scene.add(pole, flag);
  }

  // 광고판
  const adCanvas = makeAdTexture();
  function adBoard(x, z, len, rotY) {
    const t = srgb(new THREE.CanvasTexture(adCanvas));
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.set(len / 32, 1);
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(len, 0.9, 0.15),
      [
        new THREE.MeshStandardMaterial({ color: 0x111827 }),
        new THREE.MeshStandardMaterial({ color: 0x111827 }),
        new THREE.MeshStandardMaterial({ color: 0x111827 }),
        new THREE.MeshStandardMaterial({ color: 0x111827 }),
        new THREE.MeshBasicMaterial({ map: t }),
        new THREE.MeshStandardMaterial({ color: 0x111827 }),
      ]
    );
    m.position.set(x, 0.45, z);
    m.rotation.y = rotY;
    scene.add(m);
  }
  // 먼 쪽 광고판은 가운데(선수 입장 터널)를 비워 둠
  adBoard(-(FIELD_W / 2 + 9) / 2, -FIELD_H / 2 - 4, FIELD_W / 2 + 3, 0);
  adBoard((FIELD_W / 2 + 9) / 2, -FIELD_H / 2 - 4, FIELD_W / 2 + 3, 0);
  adBoard(0, FIELD_H / 2 + 4, FIELD_W + 12, Math.PI);
  adBoard(-FIELD_W / 2 - 4.5, 0, FIELD_H + 4, Math.PI / 2);
  adBoard(FIELD_W / 2 + 4.5, 0, FIELD_H + 4, -Math.PI / 2);

  // ===== 관중석: 1층(4면+코너 곡선) · 2층(본부석·양 끝·먼 쪽 코너) · 지붕 · 서포터즈석 · 전광판 =====
  const crowdPts = [];
  const crowdCols = [];
  const crowdSec = [];  // 0 일반, 1 홈 서포터즈, 2 원정 서포터즈
  const shirtPalette = [0xef4444, 0x3b82f6, 0xf59e0b, 0x22c55e, 0xa855f7, 0xf8fafc, 0x06b6d4, 0x1f2937, 0xf472b6, 0xe5e7eb];
  // 관중석 묶음: common(양 끝) · far(본부석 쪽 -z) · near(카메라 쪽 +z) — 카메라를 가리는 쪽은 투명하게 사라짐
  let SG = 'common';
  const boxesBy = { common: [], far: [], near: [] };
  const box = (x, y, z, sx, sy, sz, ry, color, rx = 0) => boxesBy[SG].push([x, y, z, sx, sy, sz, ry, rx, color]);
  const fansBy = { common: { pts: [], cols: [] }, far: { pts: [], cols: [] }, near: { pts: [], cols: [] } };
  const DEPTH = 0.95;
  const SEAT_A = 0x1e3a8a, SEAT_B = 0x1e40af;       // 일반 좌석 (남색)
  const SEAT_UA = 0x334155, SEAT_UB = 0x3b4a61;     // 2층 좌석
  const CONC = 0x4b5563, CONC_D = 0x374151, ROOF = 0xe2e8f0, STEEL = 0x94a3b8;
  const lineInfo = []; // 리본 LED 위치

  /** 로컬 좌표(lx: 앞줄을 따라, lz: 피치 반대쪽)를 월드로 */
  const toWorld = (cx, cz, ry, lx, lz) => [cx + lx * Math.cos(ry) + lz * Math.sin(ry), cz - lx * Math.sin(ry) + lz * Math.cos(ry)];
  function addFan(wx, y, wz, sec) {
    const col = shirtPalette[Math.floor(Math.random() * shirtPalette.length)];
    if (SG !== 'common') { fansBy[SG].pts.push(wx, y, wz, Math.random() * Math.PI * 2); fansBy[SG].cols.push(col); return; }
    crowdPts.push(wx, y, wz, Math.random() * Math.PI * 2);
    crowdCols.push(col);
    crowdSec.push(sec);
  }
  /** 직선 관중석 한 층. secFn(lx) → 서포터즈 구역 번호 */
  function tier(cx, cz, len, ry, o) {
    const { rows, rise, y0 = 0, dist0 = 0, seat = [SEAT_A, SEAT_B], fill = 0.88, secFn = () => 0, ground = y0 === 0 } = o;
    for (let r = 0; r < rows; r++) {
      const top = y0 + 0.6 + rise * r;
      const h = ground ? top : rise + 0.9;
      const [wx, wz] = toWorld(cx, cz, ry, 0, dist0 + r * DEPTH + DEPTH / 2);
      box(wx, top - h / 2, wz, len, h, DEPTH, ry, r % 2 ? seat[0] : seat[1]);
      for (let lx = -len / 2 + 0.45; lx < len / 2 - 0.4; lx += 0.72) {
        const sec = secFn(lx, r);
        if (Math.random() > (sec ? 0.98 : fill)) continue;
        const [fx, fz] = toWorld(cx, cz, ry, lx, dist0 + r * DEPTH + DEPTH * 0.45 + (Math.random() - 0.5) * 0.1);
        addFan(fx, top + 0.38, fz, sec);
      }
    }
    const topY = y0 + 0.6 + rise * rows;
    const backD = dist0 + rows * DEPTH;
    // 뒷벽
    const wallH = topY + 2.4 - (ground ? 0 : y0 - 1.5);
    const [bx, bz] = toWorld(cx, cz, ry, 0, backD + 0.3);
    box(bx, topY + 2.4 - wallH / 2, bz, len, wallH, 0.6, ry, CONC_D);
    if (!ground) {
      // 2층 아래 경사 받침 · 앞쪽 펜스(리본 LED 자리)
      const slabLen = Math.hypot(rows * DEPTH, rise * rows);
      const [sx, sz] = toWorld(cx, cz, ry, 0, dist0 + rows * DEPTH / 2);
      box(sx, y0 + rise * rows / 2 - 0.2, sz, len, 0.5, slabLen, ry, CONC, -Math.atan2(rise * rows, rows * DEPTH));
      lineInfo.push({ cx, cz, ry, len, dist0, y: y0 - 0.1, g: SG });
    }
    return { topY, backD };
  }
  /** 코너: 부채꼴 곡선 관중석 (θ: 바깥 방향 각도 범위) */
  function cornerTier(cx, cz, th0, th1, o) {
    const { rows, rise, y0 = 0, dist0 = 0, seat = [SEAT_A, SEAT_B], fill = 0.88, sec = 0, ground = y0 === 0 } = o;
    for (let r = 0; r < rows; r++) {
      const top = y0 + 0.6 + rise * r;
      const h = ground ? top : rise + 0.9;
      const R = dist0 + r * DEPTH + DEPTH / 2;
      const seg = Math.max(3, Math.ceil(((th1 - th0) * R) / 1.6));
      for (let i = 0; i < seg; i++) {
        const th = th0 + (th1 - th0) * (i + 0.5) / seg;
        const segLen = ((th1 - th0) * R) / seg + 0.12;
        box(cx + Math.sin(th) * R, top - h / 2, cz + Math.cos(th) * R, segLen, h, DEPTH, th, r % 2 ? seat[0] : seat[1]);
      }
      const n = Math.floor(((th1 - th0) * R) / 0.72);
      for (let i = 0; i < n; i++) {
        if (Math.random() > (sec ? 0.98 : fill)) continue;
        const th = th0 + (th1 - th0) * (i + 0.5) / n;
        const rr = R - DEPTH * 0.05;
        addFan(cx + Math.sin(th) * rr, top + 0.38, cz + Math.cos(th) * rr, sec);
      }
    }
    const topY = y0 + 0.6 + rise * rows, backR = dist0 + rows * DEPTH + 0.3;
    const seg = Math.ceil(((th1 - th0) * backR) / 2);
    for (let i = 0; i < seg; i++) {
      const th = th0 + (th1 - th0) * (i + 0.5) / seg;
      const wallH = topY + 2.4 - (ground ? 0 : y0 - 1.5);
      box(cx + Math.sin(th) * backR, topY + 2.4 - wallH / 2, cz + Math.cos(th) * backR, ((th1 - th0) * backR) / seg + 0.2, wallH, 0.6, th, CONC_D);
    }
    return { topY };
  }
  /** 지붕: 앞쪽 가장자리에 조명 줄 */
  const roofLights = [];
  function roofStraight(cx, cz, len, ry, y, d0, d1) {
    const [rx, rz] = toWorld(cx, cz, ry, 0, (d0 + d1) / 2);
    box(rx, y, rz, len, 0.35, d1 - d0, ry, ROOF, 0.06);
    const [fx, fz] = toWorld(cx, cz, ry, 0, d0);
    box(fx, y - 0.6, fz, len, 1.1, 0.5, ry, STEEL);        // 앞쪽 트러스
    for (let lx = -len / 2 + 3; lx < len / 2 - 2; lx += 5.5) {
      const [lx2, lz2] = toWorld(cx, cz, ry, lx, d0 + 0.2);
      roofLights.push([lx2, y - 1.3, lz2, ry, SG]);
    }
    for (let lx = -len / 2 + 2; lx <= len / 2 - 2; lx += 16) { // 뒤쪽 기둥
      const [px, pz] = toWorld(cx, cz, ry, lx, d1 - 0.3);
      box(px, y / 2, pz, 0.8, y, 0.8, ry, STEEL);
    }
  }
  function roofCorner(cx, cz, th0, th1, y, d0, d1) {
    const seg = 7;
    for (let i = 0; i < seg; i++) {
      const th = th0 + (th1 - th0) * (i + 0.5) / seg;
      const Rm = (d0 + d1) / 2;
      box(cx + Math.sin(th) * Rm, y, cz + Math.cos(th) * Rm, ((th1 - th0) * d1) / seg + 0.4, 0.35, d1 - d0, th, ROOF, 0.06);
      box(cx + Math.sin(th) * d0, y - 0.6, cz + Math.cos(th) * d0, ((th1 - th0) * d0) / seg + 0.3, 1.1, 0.5, th, STEEL);
      if (i % 2 === 0) roofLights.push([cx + Math.sin(th) * (d0 + 0.2), y - 1.3, cz + Math.cos(th) * (d0 + 0.2), th, SG]);
    }
  }

  const HW = FIELD_W / 2 + 7, HH = FIELD_H / 2 + 7; // 1층 앞줄 위치
  const LOW = { rows: 13, rise: 0.6 };
  const UP = { rows: 13, rise: 0.8, y0: 12.6, dist0: 9.2, seat: [SEAT_UA, SEAT_UB], fill: 0.8 };
  const PI = Math.PI;
  // 홈 서포터즈: 왼쪽(-x) 골대 뒤 1층 전체 · 원정 서포터즈: 오른쪽(+x) 골대 뒤 1층의 먼 쪽 절반
  // 양 끝(골대 뒤): 항상 보임
  SG = 'common';
  tier(-HW, 0, FIELD_H + 14, -PI / 2, { ...LOW, secFn: () => 1 });      // 홈 서포터즈
  tier(HW, 0, FIELD_H + 14, PI / 2, { ...LOW, secFn: lx => (lx > 6 ? 2 : 0) }); // 원정 서포터즈 (먼 쪽)
  tier(-HW, 0, FIELD_H + 14, -PI / 2, UP);
  const up = tier(HW, 0, FIELD_H + 14, PI / 2, UP);
  const roofY = up.topY + 4.5;
  for (const [cx, cz, len, ry] of [[-HW, 0, FIELD_H + 14, -PI / 2], [HW, 0, FIELD_H + 14, PI / 2]]) {
    const [wx, wz] = toWorld(cx, cz, ry, 0, LOW.rows * DEPTH + 0.6);
    box(wx, (0.6 + LOW.rise * LOW.rows + UP.y0) / 2, wz, len, UP.y0 - 0.6 - LOW.rise * LOW.rows + 2.5, 0.8, ry, CONC);
  }
  roofStraight(-HW, 0, FIELD_H + 14, -PI / 2, roofY, 3, up.backD + 1.5);
  roofStraight(HW, 0, FIELD_H + 14, PI / 2, roofY, 3, up.backD + 1.5);
  // 긴 쪽 관중석(본부석 -z · 카메라 쪽 +z): 1층 · 2층 · 코너 · 콘코스 벽 · 지붕 (두 쪽 모두 똑같이)
  for (const [g, zs] of [['far', -1], ['near', 1]]) {
    SG = g;
    const ry = zs < 0 ? PI : 0;
    tier(0, zs * HH, FIELD_W + 14, ry, LOW);
    tier(0, zs * HH, FIELD_W + 14, ry, UP);
    const cA = zs < 0 ? [[HW, PI / 2, PI], [-HW, PI, PI * 1.5]] : [[HW, 0, PI / 2], [-HW, PI * 1.5, PI * 2]];
    for (const [cx, t0, t1] of cA) {
      cornerTier(cx, zs * HH, t0, t1, cx < 0 && zs < 0 ? { ...LOW, sec: 1 } : LOW);
      cornerTier(cx, zs * HH, t0, t1, UP);
      roofCorner(cx, zs * HH, t0, t1, roofY, 3, up.backD + 1.5);
    }
    const [wx, wz] = toWorld(0, zs * HH, ry, 0, LOW.rows * DEPTH + 0.6);
    box(wx, (0.6 + LOW.rise * LOW.rows + UP.y0) / 2, wz, FIELD_W + 14, UP.y0 - 0.6 - LOW.rise * LOW.rows + 2.5, 0.8, ry, CONC);
    roofStraight(0, zs * HH, FIELD_W + 14, ry, roofY, 3, up.backD + 1.5);
  }
  SG = 'common';

  // 박스들을 한 번에 그림 (묶음마다 하나씩)
  const holder = g => (g === 'common' ? scene : standGroups[g]);
  for (const g of ['common', 'far', 'near']) {
    const boxes = boxesBy[g];
    const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.85 }), boxes.length);
    const d = new THREE.Object3D();
    d.rotation.order = 'YXZ';
    const c = new THREE.Color();
    boxes.forEach(([x, y, z, sx, sy, sz, ry, rx, color], i) => {
      d.position.set(x, y, z);
      d.rotation.set(rx, ry, 0);
      d.scale.set(sx, sy, sz);
      d.updateMatrix();
      m.setMatrixAt(i, d.matrix);
      m.setColorAt(i, c.setHex(color));
    });
    m.receiveShadow = true;
    holder(g).add(m);
  }
  // 지붕 조명
  for (const g of ['common', 'far', 'near']) {
    const L = roofLights.filter(r => r[4] === g);
    const lm = new THREE.InstancedMesh(new THREE.BoxGeometry(2.6, 0.9, 0.5), new THREE.MeshBasicMaterial({ color: 0xfffbe6 }), L.length);
    const d = new THREE.Object3D();
    L.forEach(([x, y, z, ry], i) => { d.position.set(x, y, z); d.rotation.set(-0.5, ry, 0, 'YXZ'); d.updateMatrix(); lm.setMatrixAt(i, d.matrix); });
    holder(g).add(lm);
  }
  // 긴 쪽 관중 (본부석 · 카메라 쪽)
  for (const g of ['far', 'near']) {
    const F = fansBy[g], n = F.cols.length;
    const fm = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.2, 0.32, 1, 6), new THREE.MeshStandardMaterial({ roughness: 0.8 }), n);
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      crowdDummy.position.set(F.pts[i * 4], F.pts[i * 4 + 1], F.pts[i * 4 + 2]);
      crowdDummy.updateMatrix();
      fm.setMatrixAt(i, crowdDummy.matrix);
      fm.setColorAt(i, col.setHex(F.cols[i]));
    }
    standGroups[g].add(fm);
    crowdParts.push({ mesh: fm, base: new Float32Array(F.pts) });
  }
  // 2층 앞 펜스: 흐르는 LED 리본 광고
  const ribbonCanvas = makeAdTexture();
  for (const L of lineInfo) {
    const t = srgb(new THREE.CanvasTexture(ribbonCanvas));
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.set(L.len / 24, 1);
    stadiumAnim.ribbons.push(t);
    const rb = new THREE.Mesh(new THREE.PlaneGeometry(L.len, 1.3), new THREE.MeshBasicMaterial({ map: t }));
    const [rx, rz] = toWorld(L.cx, L.cz, L.ry, 0, L.dist0 - 0.05);
    rb.position.set(rx, L.y, rz);
    rb.rotation.y = L.ry + Math.PI; // 피치 쪽을 바라봄
    holder(L.g || 'common').add(rb);
  }

  // 관중
  const n = crowdCols.length;
  crowdBase = new Float32Array(crowdPts);
  crowdSection = Uint8Array.from(crowdSec);
  crowdMesh = new THREE.InstancedMesh(
    new THREE.CapsuleGeometry(0.2, 0.32, 1, 6),
    new THREE.MeshStandardMaterial({ roughness: 0.8 }),
    n
  );
  const col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    crowdDummy.position.set(crowdBase[i * 4], crowdBase[i * 4 + 1], crowdBase[i * 4 + 2]);
    crowdDummy.updateMatrix();
    crowdMesh.setMatrixAt(i, crowdDummy.matrix);
    crowdMesh.setColorAt(i, col.setHex(crowdCols[i]));
  }
  crowdMesh.instanceMatrix.needsUpdate = true;
  scene.add(crowdMesh);
  crowdParts.unshift({ mesh: crowdMesh, base: crowdBase });

  // 서포터즈 깃발 (홈: 왼쪽 골대 뒤 · 원정: 오른쪽 먼 쪽)
  const flagGeoS = new THREE.PlaneGeometry(1.6, 1.0);
  const poleGeo = new THREE.CylinderGeometry(0.025, 0.025, 2.4, 5);
  const addFlag = (x, y, z, home) => {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.8 });
    const pole = new THREE.Mesh(poleGeo, postMat);
    pole.position.set(x, y + 1.2, z);
    const f = new THREE.Mesh(flagGeoS, mat);
    f.position.set(x, y + 1.9, z + 0.8);
    scene.add(pole, f);
    stadiumAnim.flags.push({ mesh: f, mat, home, ph: Math.random() * 6, x, z });
  };
  for (let i = 0; i < 16; i++) {
    const z = -FIELD_H / 2 - 4 + i * ((FIELD_H + 8) / 15);
    const r = 2 + (i % 3) * 3;
    addFlag(-HW - r * DEPTH - 0.4, 0.6 + 0.6 * r + 0.5, z, true);
  }
  for (let i = 0; i < 6; i++) {
    const z = -FIELD_H / 2 - 4 + i * 5.5;
    const r = 2 + (i % 3) * 3;
    addFlag(HW + r * DEPTH + 0.4, 0.6 + 0.6 * r + 0.5, z, false);
  }
  // 홈 서포터즈 대형 걸개(티포): 2층 펜스 아래
  {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 160;
    const t = srgb(new THREE.CanvasTexture(c));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(40, 5.5), new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide }));
    m.position.set(-HW - UP.dist0 + 0.2, UP.y0 - 3.2, 0);
    m.rotation.y = Math.PI / 2;
    scene.add(m);
    stadiumAnim.tifo = { c, t };
  }

  // 전광판 2개: 먼 쪽 양 코너 지붕 위
  for (const sx of [-1, 1]) {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 400;
    const t = srgb(new THREE.CanvasTexture(c));
    const grp = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(23, 10, 1.2), new THREE.MeshStandardMaterial({ color: 0x0b1120, roughness: 0.5 }));
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(21.6, 8.6), new THREE.MeshBasicMaterial({ map: t }));
    scr.position.z = 0.62;
    const legs = new THREE.Mesh(new THREE.BoxGeometry(14, 0.6, 0.6), new THREE.MeshStandardMaterial({ color: 0x64748b }));
    legs.position.y = -5.4;
    grp.add(frame, scr, legs);
    for (const lx of [-6, 6]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.6, 4, 0.6), new THREE.MeshStandardMaterial({ color: 0x64748b }));
      leg.position.set(lx, -7, 0);
      grp.add(leg);
    }
    grp.position.set(sx * (HW + 11), roofY + 6.5, -(HH + 11));
    grp.lookAt(0, 6, 0);
    scene.add(grp);
    stadiumAnim.boards.push({ c, t });
  }

  // 선수 입장 터널: 본부석 가운데, 반원 지붕 + 안쪽은 어둡게
  {
    const T0 = -HH, T1 = -FIELD_H / 2 - 1.6, TW = 2.4, TH = 3.1;
    const len = T1 - T0;
    const tunMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.4, metalness: 0.3, side: THREE.DoubleSide });
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(TW, TW, len, 20, 1, true, Math.PI / 2, Math.PI), tunMat);
    roof.rotation.x = Math.PI / 2;
    roof.position.set(0, TH - TW * 0.35, (T0 + T1) / 2);
    roof.scale.set(1, 1, 0.75);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 });
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.25, TH - TW * 0.35, len), wallMat);
      w.position.set(sx * TW, (TH - TW * 0.35) / 2, (T0 + T1) / 2);
      scene.add(w);
      // 입구 양옆 LED 띠
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.08, TH - 0.4, 0.08), new THREE.MeshBasicMaterial({ color: 0x4cc9ff }));
      led.position.set(sx * (TW - 0.05), (TH - 0.4) / 2, T1 + 0.05);
      scene.add(led);
    }
    // 터널 안쪽(어두운 통로)
    const mouth = new THREE.Mesh(new THREE.PlaneGeometry(TW * 2, TH + 0.4), new THREE.MeshBasicMaterial({ color: 0x020409 }));
    mouth.position.set(0, (TH + 0.4) / 2, T0 + 0.35);
    // 입구 위 간판
    const c = document.createElement('canvas'); c.width = 512; c.height = 96;
    const g = c.getContext && c.getContext('2d');
    if (g) {
      g.fillStyle = '#0b1120'; g.fillRect(0, 0, 512, 96);
      g.fillStyle = '#4cc9ff'; g.fillRect(0, 88, 512, 8);
      g.fillStyle = '#fff'; g.font = '900 52px "Segoe UI", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('APEX FOOTBALL', 256, 46);
    }
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(TW * 2.2, 0.9), new THREE.MeshBasicMaterial({ map: srgb(new THREE.CanvasTexture(c)) }));
    sign.position.set(0, TH + 0.25, T1 + 0.02);
    scene.add(roof, mouth, sign);
  }

  // 벤치(더그아웃): 먼 쪽 하프라인 양옆
  for (const sx of [-1, 1]) {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.BoxGeometry(9, 2.2, 2.2), new THREE.MeshStandardMaterial({ color: 0x1f2937, transparent: true, opacity: 0.55 }));
    shell.position.y = 1.1;
    const seat = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.5, 0.8), new THREE.MeshStandardMaterial({ color: sx < 0 ? 0x1d4ed8 : 0xb91c1c }));
    seat.position.set(0, 0.5, -0.5);
    g.add(shell, seat);
    g.position.set(sx * 9, 0, -FIELD_H / 2 - 2.6);
    scene.add(g);
  }

}
makeStadium();

/** 경기 시작 때: 서포터즈석·깃발·걸개를 두 팀 색으로 */
function paintStadium(homeHex, awayHex) {
  if (crowdMesh && crowdSection) {
    const c = new THREE.Color();
    for (let i = 0; i < crowdSection.length; i++) {
      const sec = crowdSection[i];
      if (!sec) continue;
      const r = Math.random();
      const hex = r < 0.72 ? (sec === 1 ? homeHex : awayHex) : r < 0.9 ? 0xf8fafc : 0x111827;
      crowdMesh.setColorAt(i, c.setHex(hex));
    }
    if (crowdMesh.instanceColor) crowdMesh.instanceColor.needsUpdate = true;
  }
  for (const f of stadiumAnim.flags) f.mat.color.setHex(f.home ? homeHex : awayHex);
  const T = stadiumAnim.tifo;
  if (T && T.c.getContext) {
    const g = T.c.getContext('2d');
    if (g) {
      const css = '#' + homeHex.toString(16).padStart(6, '0');
      for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? css : '#0b1120'; g.fillRect(i * 64, 0, 64, 160); }
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 30, 1024, 100);
      g.fillStyle = '#fff';
      g.font = '900 72px "Segoe UI", "Malgun Gothic", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(`${teamName(true)} ULTRAS`, 512, 82);
      T.t.needsUpdate = true;
    }
  }
  stadiumAnim.lastBoard = '';
}

/** 매 프레임: LED 리본 흐름 · 깃발 펄럭임 · 전광판 갱신 */
function updateStadium(now) {
  for (const t of stadiumAnim.ribbons) t.offset.x = (now / 9000) % 1;
  const cheer = 1 + crowdExcite * 1.5;
  for (const f of stadiumAnim.flags) {
    f.mesh.rotation.y = Math.sin(now / 260 * cheer + f.ph) * 0.45;
    f.mesh.rotation.z = Math.sin(now / 410 + f.ph) * 0.08;
  }
  if (!stadiumAnim.boards.length || now - stadiumAnim.boardT < 250) return;
  stadiumAnim.boardT = now;
  const menus = inMenus();
  const home = menus ? 'APEX' : teamName(true), away = menus ? 'FOOTBALL' : teamName(false).replace(/ \(.*\)$/, '');
  const mm = Math.floor(matchMinute);
  const line1 = menus ? 'WELCOME' : fkMode ? `FREE KICK ${fkState.goals}/${fkState.tries}`
    : inPens && penState ? `PK ${penState.blueGoals} : ${penState.redGoals}` : `${mm}'`;
  const key = `${home}|${away}|${score[0]}|${score[1]}|${line1}|${phase === 'goal_pause' || phase === 'replay' ? 'G' : ''}`;
  if (key === stadiumAnim.lastBoard) return;
  stadiumAnim.lastBoard = key;
  const goalFlash = !menus && (phase === 'goal_pause' || (phase === 'replay' && replay?.kind === 'goal'));
  const hc = colorById(userSetup.colorId || 'blue').css, ac = colorById(userSetup.oppColorId || 'red').css;
  for (const b of stadiumAnim.boards) {
    const g = b.c.getContext && b.c.getContext('2d');
    if (!g) continue;
    const W = 1024, H = 400;
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0b1730'); bg.addColorStop(1, '#030712');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.fillStyle = '#facc15'; g.fillRect(0, 0, W, 54);
    g.fillStyle = '#0b1120'; g.font = '900 34px "Segoe UI", "Malgun Gothic", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(menus ? 'APEX FOOTBALL' : `APEX FOOTBALL · ${compName()}`, W / 2, 28);
    if (goalFlash) {
      g.fillStyle = '#facc15'; g.font = '900 170px "Segoe UI", sans-serif';
      g.fillText('GOAL!', W / 2, 200);
      g.fillStyle = '#fff'; g.font = '800 52px "Segoe UI", "Malgun Gothic", sans-serif';
      g.fillText(`${score[0]} - ${score[1]}`, W / 2, 330);
    } else {
      const nameFit = (t) => (t.length > 11 ? t.slice(0, 10) + '…' : t);
      g.fillStyle = hc; g.fillRect(40, 92, 16, 150);
      g.fillStyle = ac; g.fillRect(W - 56, 92, 16, 150);
      g.fillStyle = '#fff'; g.font = '800 46px "Segoe UI", "Malgun Gothic", sans-serif';
      g.textAlign = 'left'; g.fillText(nameFit(home), 74, 130);
      g.textAlign = 'right'; g.fillText(nameFit(away), W - 74, 130);
      g.textAlign = 'center';
      if (!menus) { g.font = '900 120px "Segoe UI", sans-serif'; g.fillText(`${score[0]}  :  ${score[1]}`, W / 2, 230); }
      g.fillStyle = '#22d3ee'; g.font = '800 58px "Segoe UI", "Malgun Gothic", sans-serif';
      g.fillText(line1, W / 2, 335);
    }
    b.t.needsUpdate = true;
  }
}

function setCrowdStanding(standing) {
  crowdExcite = standing ? 1 : 0;
  if (!standing) updateCrowd(0, true);
}

function updateCrowd(t, force = false) {
  if (!crowdMesh || (!force && crowdExcite <= 0)) return;
  for (const C of crowdParts) {
    if (!C.mesh.visible || (C.mesh.parent && !C.mesh.parent.visible)) continue;
    const base = C.base, n = base.length / 4;
    for (let i = 0; i < n; i++) {
      const ph = base[i * 4 + 3];
      const jump = crowdExcite > 0 ? 0.25 + Math.abs(Math.sin(t * 0.012 + ph)) * 0.5 * crowdExcite : 0;
      crowdDummy.position.set(base[i * 4], base[i * 4 + 1] + jump, base[i * 4 + 2]);
      crowdDummy.updateMatrix();
      C.mesh.setMatrixAt(i, crowdDummy.matrix);
    }
    C.mesh.instanceMatrix.needsUpdate = true;
  }
}

function clearCelebrations() {
  setCrowdStanding(false);
}


// ===== 선수 모델 =====
const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
const HAIR = [0x1f1300, 0x3b2a1a, 0x5a3825, 0x0f0f0f, 0xb7862b];
const PGEO = {
  torso: new THREE.CapsuleGeometry(0.25, 0.36, 4, 10),
  shorts: new THREE.CylinderGeometry(0.27, 0.25, 0.3, 10),
  leg: new THREE.CapsuleGeometry(0.095, 0.46, 3, 6),
  sock: new THREE.CapsuleGeometry(0.1, 0.24, 3, 6),
  boot: new THREE.BoxGeometry(0.14, 0.09, 0.28),
  arm: new THREE.CapsuleGeometry(0.07, 0.42, 3, 6),
  sleeve: new THREE.CapsuleGeometry(0.09, 0.1, 3, 6),
  head: new THREE.SphereGeometry(0.2, 14, 12),
  hair: new THREE.SphereGeometry(0.212, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
  number: new THREE.PlaneGeometry(0.34, 0.34),
};
const kitCache = new Map();
const matCache = new Map();
function solidMat(hex, rough = 0.6) {
  const k = `${hex}-${rough}`;
  if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial({ color: hex, roughness: rough }));
  return matCache.get(k);
}
function luminance(hex) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
function kitFor(shirtHex) {
  if (kitCache.has(shirtHex)) return kitCache.get(shirtHex);
  const light = luminance(shirtHex) > 0.6;
  const kit = {
    shirt: solidMat(shirtHex, 0.55),
    shorts: solidMat(light ? 0x1e293b : 0xf8fafc, 0.6),
    socks: solidMat(shirtHex, 0.6),
    numberColor: light ? '#111827' : '#ffffff',
  };
  kitCache.set(shirtHex, kit);
  return kit;
}
const bootMat = solidMat(0x111111, 0.4);
const gloveMat = solidMat(0xf8fafc, 0.5);

function makeLabelCanvas(num, pos, gauge = 0, showGauge = false, canvas = null) {
  const c = canvas || document.createElement('canvas');
  c.width = 128;
  c.height = 80;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 80);
  g.fillStyle = 'rgba(15,23,42,0.55)';
  g.beginPath();
  if (g.roundRect) g.roundRect(24, 26, 80, 46, 10); else g.rect(24, 26, 80, 46);
  g.fill();
  g.fillStyle = '#fff';
  g.font = 'bold 24px "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.fillText(String(num), 64, 50);
  g.font = 'bold 13px "Segoe UI", sans-serif';
  g.fillStyle = '#fde68a';
  g.fillText(pos, 64, 66);
  if (showGauge) {
    g.fillStyle = 'rgba(0,0,0,0.7)';
    g.fillRect(14, 6, 100, 12);
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.strokeRect(14, 6, 100, 12);
    const v = clamp(gauge, 0, 1);
    g.fillStyle = v > 0.92 ? '#ef4444' : v > 0.8 ? '#f59e0b' : '#22c55e';
    g.fillRect(14, 6, 100 * v, 12);
  }
  return c;
}

function makeNumberTexture(num, color) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.font = 'bold 44px "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(num), 32, 36);
  return srgb(new THREE.CanvasTexture(c));
}

function createPlayerMesh(shirtHex, num, posLabel, isGk = false) {
  const kit = kitFor(shirtHex);
  const skin = solidMat(SKIN[(num * 7) % SKIN.length], 0.7);
  const hair = solidMat(HAIR[(num * 3) % HAIR.length], 0.9);
  const group = new THREE.Group();
  const rig = new THREE.Group();
  rig.scale.setScalar(0.93);
  group.add(rig);

  const torso = new THREE.Mesh(PGEO.torso, kit.shirt);
  torso.position.y = 1.36;
  torso.scale.set(1.12, 1, 0.78);
  torso.castShadow = true;
  const shorts = new THREE.Mesh(PGEO.shorts, kit.shorts);
  shorts.position.y = 0.92;
  shorts.castShadow = true;
  const head = new THREE.Mesh(PGEO.head, skin);
  head.position.y = 1.98;
  head.castShadow = true;
  const hairM = new THREE.Mesh(PGEO.hair, hair);
  hairM.position.y = 2.0;
  hairM.rotation.x = -0.25;
  const numTex = makeNumberTexture(num, kit.numberColor);
  const back = new THREE.Mesh(PGEO.number, new THREE.MeshBasicMaterial({ map: numTex, transparent: true }));
  back.position.set(0, 1.42, -0.205);
  back.rotation.y = Math.PI;
  rig.add(torso, shorts, head, hairM, back);

  function limb(x, y, kind) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    if (kind === 'leg') {
      const leg = new THREE.Mesh(PGEO.leg, skin);
      leg.position.y = -0.33;
      const sock = new THREE.Mesh(PGEO.sock, kit.socks);
      sock.position.y = -0.62;
      const boot = new THREE.Mesh(PGEO.boot, bootMat);
      boot.position.set(0, -0.84, 0.05);
      leg.castShadow = sock.castShadow = true;
      pivot.add(leg, sock, boot);
    } else {
      const sleeve = new THREE.Mesh(PGEO.sleeve, kit.shirt);
      sleeve.position.y = -0.06;
      const arm = new THREE.Mesh(PGEO.arm, skin);
      arm.position.y = -0.3;
      pivot.add(sleeve, arm);
      if (isGk) {
        const glove = new THREE.Mesh(PGEO.head, gloveMat);
        glove.scale.setScalar(0.42);
        glove.position.y = -0.58;
        pivot.add(glove);
      }
    }
    rig.add(pivot);
    return pivot;
  }
  const legL = limb(-0.13, 0.9, 'leg');
  const legR = limb(0.13, 0.9, 'leg');
  const armL = limb(-0.34, 1.66, 'arm');
  const armR = limb(0.34, 1.66, 'arm');
  armL.rotation.z = -0.12;
  armR.rotation.z = 0.12;

  const canvas = makeLabelCanvas(num, posLabel, 0, false);
  const tex = srgb(new THREE.CanvasTexture(canvas));
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(1.45, 0.9, 1);
  sprite.position.y = 2.55;
  sprite.renderOrder = 10;
  group.add(sprite);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.7, 0.85, 28),
    new THREE.MeshBasicMaterial({ color: 0xfacc15, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  ring.visible = false;
  group.add(ring);

  Object.assign(group.userData, {
    ring, sprite, tex, canvas, numTex, rig, legL, legR, armL, armR,
    num, label: posLabel, lastGauge: -1,
  });
  scene.add(group);
  return group;
}

function disposePlayerMesh(mesh) {
  scene.remove(mesh);
  const u = mesh.userData;
  u.tex?.dispose();
  u.numTex?.dispose();
  u.sprite?.material?.dispose();
  u.ring?.geometry?.dispose();
  u.ring?.material?.dispose();
}

function updatePlayerGauge(p, gauge, show) {
  const u = p.mesh.userData;
  const key = show ? Math.round(gauge * 40) : -1;
  if (u.lastGauge === key) return; // 값이 바뀔 때만 캔버스 다시 그림
  u.lastGauge = key;
  makeLabelCanvas(p.num, p.label, gauge, show, u.canvas);
  u.tex.needsUpdate = true;
}

function animatePlayer(p) {
  const u = p.mesh.userData;
  const spd = Math.hypot(p.vx, p.vz);
  p.animPhase = (p.animPhase || 0) + spd * 1.9;
  const amp = clamp(spd * 4.4, 0, 0.95);
  const s = Math.sin(p.animPhase);
  u.legL.rotation.x = s * amp;
  u.legR.rotation.x = -s * amp;
  u.armL.rotation.x = -s * amp * 0.8;
  u.armR.rotation.x = s * amp * 0.8;
  if (p.shake > 0) u.armR.rotation.x = -1.15; // 악수
  if (p.whistle) { u.armR.rotation.x = -2.6; u.armR.rotation.z = 0.25; } // 휘슬 불며 팔을 들어 지점 가리킴
  else if (p.isReferee) u.armR.rotation.z = 0.12;
  if (phase === 'sp_intro' && spIntro && spIntro.taker === p && spIntro.t <= 132) { u.armL.rotation.x = -1.2; u.armR.rotation.x = -1.2; } // 공을 두 손으로 듦
  if (p.kickAnim > 0) {
    const t = 1 - p.kickAnim / 14;
    const swing = -1.35 * Math.sin(t * Math.PI);
    (p.preferredFoot === 'left' ? u.legL : u.legR).rotation.x = swing;
  }
  // 키퍼 다이빙: 몸을 옆으로 날리며 두 팔을 머리 위(날아가는 쪽)로 쭉 뻗음 · 높은 공은 덜 눕고 더 높이
  if (p.role === 'GK') {
    if (p.gkPoseT > 0) p.gkPoseT--; else p.gkPose = null;
    const spread = p.gkPose === 'spread', up = p.gkPose === 'up';
    u.armL.rotation.z = lerp(u.armL.rotation.z, spread ? -1.35 : up ? -0.15 : -0.12, 0.35);
    u.armR.rotation.z = lerp(u.armR.rotation.z, spread ? 1.35 : up ? 0.15 : 0.12, 0.35);
    u.legL.rotation.z = lerp(u.legL.rotation.z, spread ? -0.45 : 0, 0.35);
    u.legR.rotation.z = lerp(u.legR.rotation.z, spread ? 0.45 : 0, 0.35);
    if (up) u.armL.rotation.x = u.armR.rotation.x = -3.05;
    if (spread) u.armL.rotation.x = u.armR.rotation.x = -0.3;
  }
  if (p.dive > 0) {
    const t = p.dive / 30;
    u.rig.rotation.z = lerp(u.rig.rotation.z, (p.diveDir ?? 1) * (p.diveHigh ? 1.15 : 1.45) * Math.min(1, t * 2), 0.3);
    u.armL.rotation.x = u.armR.rotation.x = -2.95;
    u.armL.rotation.z = u.armR.rotation.z = 0;
  } else {
    u.rig.rotation.z *= 0.8;
  }
  u.rig.position.y = p.jumpY || 0;
  if (p.cheer > 0) {
    const w = Math.sin(simTime / 140 + p.num) * 0.25;
    u.armL.rotation.x = -2.7 * Math.min(1, p.cheer) + w;
    u.armR.rotation.x = -2.7 * Math.min(1, p.cheer) - w;
  }
  if (p.lying > 0) {
    u.rig.rotation.z = p.lying * 1.5;
    u.rig.position.y += p.lying * 0.6;
  }
  const slideLean = p.tackle?.kind === 'slide' ? -1.2 : p.stun > 0 ? -0.9 : 0;
  if (slideLean || Math.abs(u.rig.rotation.x) > 0.01) {
    u.rig.rotation.x = lerp(u.rig.rotation.x, slideLean, 0.35);
    u.rig.position.y -= Math.abs(u.rig.rotation.x) * 0.38;
  }
  if (p.tackle) (p.preferredFoot === 'left' ? u.legL : u.legR).rotation.x = p.tackle.kind === 'slide' ? -1.5 : -1.1;
  if (p.crouch > 0) {
    u.rig.position.y -= p.crouch * 0.42;
    u.rig.rotation.x = p.crouch * 0.55;
    u.legL.rotation.x = u.legR.rotation.x = -p.crouch * 1.1;
    u.armL.rotation.x = u.armR.rotation.x = -p.crouch * 1.3;
  } else if (u.rig.rotation.x) u.rig.rotation.x *= 0.7;
}

// ===== 공 =====
function makeBallTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#111827';
  const spots = [[32, 30], [96, 30], [160, 30], [224, 30], [0, 78], [64, 78], [128, 78], [192, 78], [256, 78], [48, 118], [176, 118], [112, 6]];
  for (const [x, y] of spots) {
    g.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      g.lineTo(x + Math.cos(a) * 15, y + Math.sin(a) * 13);
    }
    g.closePath();
    g.fill();
  }
  return srgb(new THREE.CanvasTexture(c));
}
const _ballTex = makeSoccerBallTextures();
const ballMesh = new THREE.Mesh(
  new THREE.SphereGeometry(BALL_R, 40, 28),
  _ballTex
    ? new THREE.MeshStandardMaterial({ map: _ballTex.map, bumpMap: _ballTex.bump, bumpScale: 0.004, roughness: 0.32, metalness: 0.02 })
    : new THREE.MeshStandardMaterial({ map: makeBallTexture(), roughness: 0.4 })
);
ballMesh.castShadow = true;
scene.add(ballMesh);

// 공 바로 아래 그림자 (뜬 공 높이 판단용)
const ballShadow = new THREE.Mesh(
  new THREE.CircleGeometry(BALL_R * 1.1, 20),
  new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })
);
ballShadow.rotation.x = -Math.PI / 2;
ballShadow.position.y = 0.03;
scene.add(ballShadow);
const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();

const dirArrow = new THREE.Group();
const dirHead = new THREE.Mesh(
  new THREE.ConeGeometry(0.16, 0.46, 3),
  new THREE.MeshBasicMaterial({ color: 0xffe566 })
);
dirHead.rotation.x = Math.PI / 2;
dirHead.position.set(0, 0.08, 1.2);
dirArrow.add(dirHead);
dirArrow.visible = false;
scene.add(dirArrow);

// 세트피스 궤적 미리보기 (마그누스 효과까지 반영된 실제 경로)
const TRAJ_N = 160;
const trajGeo = new THREE.BufferGeometry();
trajGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAJ_N * 3), 3));
const kickGuide = new THREE.Line(trajGeo, new THREE.LineDashedMaterial({ color: 0x7dd3fc, dashSize: 0.5, gapSize: 0.3 }));
kickGuide.frustumCulled = false;
kickGuide.visible = false;
scene.add(kickGuide);

// 띄운 공(로빙 · 크로스 · 코너 등) 낙하지점 표시
const landMarker = new THREE.Group();
{
  const mk = (r0, r1, op) => new THREE.Mesh(new THREE.RingGeometry(r0, r1, 32), new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: op, side: THREE.DoubleSide, depthWrite: false }));
  const outer = mk(0.62, 0.8, 0.9), inner = mk(0, 0.16, 0.95);
  outer.rotation.x = inner.rotation.x = -Math.PI / 2;
  landMarker.add(outer, inner);
  landMarker.userData.outer = outer;
}
landMarker.visible = false;
scene.add(landMarker);
function updateLandMarker() {
  const v = ball.loftMark && !ball.owner && !ball.holdByGk && !ball.lastShot && (phase === 'play' || phase === 'goal_pause') ? predictLanding() : null;
  if (!v) { landMarker.visible = false; if (ball.loftMark && (ball.owner || ball.holdByGk || ball.y <= BALL_R + 0.3)) ball.loftMark = false; return; }
  landMarker.visible = true;
  landMarker.position.set(clamp(v.x, -FIELD_W / 2 - 3, FIELD_W / 2 + 3), 0.06, v.z);
  const k = 1 + Math.sin(simFrame * 0.25) * 0.12; // 살짝 맥박처럼
  landMarker.userData.outer.scale.set(k, k, 1);
}

const penAim = new THREE.Group();
{
  const mat = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.26, 0.34, 28), mat);
  const h = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.06), mat);
  const v = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.5), mat);
  penAim.add(ring, h, v);
  penAim.renderOrder = 20;
}
penAim.visible = false;
scene.add(penAim);

const kickAimRing = new THREE.Mesh(
  new THREE.RingGeometry(0.45, 0.65, 28),
  new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
);
kickAimRing.rotation.x = -Math.PI / 2;
kickAimRing.visible = false;
scene.add(kickAimRing);

const kickCone = new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })
);
kickCone.visible = false;
scene.add(kickCone);

function setKickCone(fromX, fromZ, dirX, dirZ, len, spread = 0.16) {
  const [dx, dz] = norm2(dirX, dirZ);
  const px = -dz;
  const pz = dx;
  const tipW = Math.max(0.8, len * spread);
  const verts = new Float32Array([
    fromX, 0.05, fromZ,
    fromX + dx * len + px * tipW, 0.05, fromZ + dz * len + pz * tipW,
    fromX + dx * len - px * tipW, 0.05, fromZ + dz * len - pz * tipW,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex([0, 1, 2]);
  kickCone.geometry.dispose();
  kickCone.geometry = geo;
}

function setpieceKickLabel(action) {
  if (action === 'lob') return '띄워 차기';
  if (action === 'shoot') return '파워 슛 (드롭)';
  if (action === 'through') return '스루패스';
  if (action === 'ground') return '짧은 패스';
  return '프리킥 조준';
}

function syncSetpieceUi() {
  const aimed = phase === 'setpiece' && setpiece &&
    (setpiece.type === 'corner' || setpiece.type === 'freekick') && setpiece.teamBlue;
  if (!setpieceUi) return;
  if (!aimed) {
    setpieceUi.classList.remove('show');
    const dl = $('goal-dist');
    if (dl) dl.style.display = 'none';
    return;
  }
  setpieceUi.classList.add('show');
  const kk = SET_KICKS[setKickIdx];
  if (setpieceKickType) setpieceKickType.textContent = `${kk.name} — ${kk.desc}`;
  const info = $('setpiece-info');
  const tk = setpiece.taker;
  if (info && tk) {
    const goalDist = Math.hypot(FIELD_W / 2 - ball.x, ball.z).toFixed(1);
    const st = k => Math.round(statMul(tk, k) * 100);
    const key = `${kk.id}|${tk.num}|${goalDist}|${Math.round(setLoft * 10)}|${charge.action}`;
    if (info.dataset.k !== key) {
      info.dataset.k = key;
      const loftTxt = setLoft > 0.15 ? `높게 +${Math.round(setLoft * 100)}` : setLoft < -0.15 ? `낮게 ${Math.round(setLoft * 100)}` : '보통';
      info.innerHTML = `
        <div class="sp-row"><span>키커</span><b>${tk.num}번 ${tk.label} · 프리킥 능력 ${fkRating(tk)}</b></div>
        <div class="sp-row"><span>능력치</span><b>프리킥 ${st('freekick')} · 커브 ${st('curve')} · 슛파워 ${st('shotPower')}</b></div>
        <div class="sp-row"><span>골문까지</span><b>${goalDist}m</b></div>
        <div class="sp-row"><span>높이</span><b>${loftTxt}</b></div>
        <div class="sp-keys"><kbd>C</kbd> 킥 종류 · <kbd>↑</kbd><kbd>↓</kbd> 높이 · <kbd>←</kbd><kbd>→</kbd> 조준 · <kbd>Tab</kbd> 키커 변경<br><kbd>D</kbd> 슛 · <kbd>A</kbd> 띄워 차기 · <kbd>S</kbd> 짧은 패스</div>`;
    }
  }
  // 골대 위 거리 표시 (화면 좌표로 변환)
  const dl = $('goal-dist');
  if (dl && camera && camera.position) {
    const v = new THREE.Vector3(FIELD_W / 2, GOAL_H + 1.6, 0);
    if (v.project) {
      v.project(camera);
      if (typeof v.x === 'number' && v.z < 1) {
        dl.style.display = 'grid';
        dl.style.left = `${(v.x * 0.5 + 0.5) * viewW()}px`;
        dl.style.top = `${(-v.y * 0.5 + 0.5) * viewH()}px`;
        dl.textContent = `${Math.hypot(FIELD_W / 2 - ball.x, ball.z).toFixed(1)}m`;
      }
    }
  }
  if (setpiecePowerFill) {
    setpiecePowerFill.style.width = `${Math.round((charge.action ? charge.power : 0) * 100)}%`;
  }
}

// ===== 심판 =====
function createReferee() {
  // 심판: 노란 상의 · 검정 반바지 · 검정 양말/축구화 (선수와 같은 관절 구조라 걷고 뛰는 모션이 있음)
  const shirt = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.5 });
  const black = solidMat(0x111111, 0.6);
  const skin = solidMat(0xe0ac69, 0.7);
  const hairMat = solidMat(0x2b1a10, 0.9);
  const group = new THREE.Group();
  const rig = new THREE.Group();
  rig.scale.setScalar(0.93);
  group.add(rig);
  const torso = new THREE.Mesh(PGEO.torso, shirt);
  torso.position.y = 1.36; torso.scale.set(1.12, 1, 0.78); torso.castShadow = true;
  // 검정 칼라 · 옆구리 라인 · 가슴 배지
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.028, 6, 14), black);
  collar.rotation.x = Math.PI / 2; collar.position.y = 1.78;
  const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.5, 0.2), black);
  sideL.position.set(-0.275, 1.34, 0);
  const sideR = sideL.clone(); sideR.position.x = 0.275;
  const badge = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.09, 0.02), black);
  badge.position.set(-0.11, 1.55, 0.2);
  const shorts = new THREE.Mesh(PGEO.shorts, black);
  shorts.position.y = 0.92; shorts.castShadow = true;
  const head = new THREE.Mesh(PGEO.head, skin);
  head.position.y = 1.98; head.castShadow = true;
  const hair = new THREE.Mesh(PGEO.hair, hairMat);
  hair.position.y = 2.0; hair.rotation.x = -0.25;
  rig.add(torso, collar, sideL, sideR, badge, shorts, head, hair);
  const limb = (x, y, kind) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    if (kind === 'leg') {
      const leg = new THREE.Mesh(PGEO.leg, skin); leg.position.y = -0.33;
      const sock = new THREE.Mesh(PGEO.sock, black); sock.position.y = -0.62;
      const boot = new THREE.Mesh(PGEO.boot, bootMat); boot.position.set(0, -0.84, 0.05);
      leg.castShadow = sock.castShadow = true;
      pivot.add(leg, sock, boot);
    } else {
      const sleeve = new THREE.Mesh(PGEO.sleeve, shirt); sleeve.position.y = -0.06;
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.092, 0.092, 0.03, 10), black); cuff.position.y = -0.16;
      const arm = new THREE.Mesh(PGEO.arm, skin); arm.position.y = -0.3;
      pivot.add(sleeve, cuff, arm);
    }
    rig.add(pivot);
    return pivot;
  };
  const legL = limb(-0.13, 0.9, 'leg'), legR = limb(0.13, 0.9, 'leg');
  const armL = limb(-0.34, 1.66, 'arm'), armR = limb(0.34, 1.66, 'arm');
  armL.rotation.z = -0.12; armR.rotation.z = 0.12;
  // 목에 건 호루라기
  const whistle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.07), solidMat(0xcbd5e1, 0.3));
  whistle.position.set(0.06, 1.62, 0.22);
  rig.add(whistle);
  Object.assign(group.userData, { rig, legL, legR, armL, armR });
  scene.add(group);
  return { x: 0, z: 8, vx: 0, vz: 0, mesh: group, shirt, foulTimer: 0, num: 0, isReferee: true };
}
const referee = createReferee();

// ===== 상태 =====
const keys = {};
let paused = false;
/** Esc 일시정지 */
function canPause() { return !inMenus() && phase !== 'ended' && phase !== 'intro' && phase !== 'pen_order'; }
function setPaused(on) {
  paused = on;
  if (on) pshot = null;
  const el = $('pause');
  if (!el) return;
  el.classList.toggle('show', on);
  if (on) {
    $('pause-main').style.display = 'block';
    $('pause-confirm').style.display = 'none';
    const mm = Math.floor(matchMinute);
    $('pause-sub').textContent = fkMode ? `프리킥 연습 · ${fkState.goals}/${fkState.tries}`
      : inPens && penState ? `승부차기 ${penState.blueGoals} : ${penState.redGoals}`
      : `${teamName(true)} ${score[0]} : ${score[1]} · ${mm}'`;
    $('btn-abort').textContent = fkMode ? '연습 끝내기' : '경기 중단하기';
  } else {
    for (const k in keys) keys[k] = false; // 누르고 있던 키 초기화
    charge = { action: null, power: 0 };
  }
}
function abortMatch() {
  setPaused(false);
  celeb = null; replay = null; penRun = null; fkRun = null; fkCam = null; setpiece = null; spIntro = null;
  clearCelebrations();
  setCrowdStanding(false);
  replayBadge.classList.remove('show');
  replayBadge.textContent = 'REPLAY';
  setpieceHint.style.display = 'none';
  if (setpieceUi) setpieceUi.classList.remove('show');
  $('cine')?.classList.remove('show');
  $('pen-order')?.classList.remove('show');
  penOrderUi = null;
  setMatchHudVisible(true);
  if (apcOpp) { inPens = false; const lg = apcOpp.kind === 'league'; $('lineup')?.classList.remove('show'); $('prematch-hint')?.classList.remove('show'); if (lg) openLeagueSelect('season'); else openApc(); return; }
  exitToLobby();
}
let charge = { action: null, power: 0 };
let kickCooldown = 0;
let switchLock = 0;
let pendingReceiver = null;
let score = [0, 0];
let matchMinute = 0;
let aiDebug = false;
let thirdPersonCam = false;
let fkCam = null; // 프리킥 찬 뒤 고정 카메라
let fkRun = null;  // 프리킥 도움닫기
let runRec = -1, runKickRec = -2; // 도움닫기 시작 녹화 위치 / 그 킥의 녹화 위치
let setAimX = 1;
let setAimZ = 0;
let setAimYaw = 0;
const aimHold = { yaw: 0, loft: 0 };
// 세트피스 킥 종류 (C로 변경) · 높이 (↑↓)
const SET_KICKS = [
  { id: 'inside', name: '인사이드 커브 킥', desc: '안쪽으로 휘어 들어감' },
  { id: 'outside', name: '아웃사이드 킥', desc: '바깥쪽으로 휘어 나감' },
  { id: 'knuckle', name: '무회전 킥', desc: '회전 없이 흔들리며 빠르게' },
  { id: 'drop', name: '드롭 킥', desc: '높게 떠서 뚝 떨어짐' },
];
let setKickIdx = 0;
let setLoft = 0; // -1 ~ 1
let penAimZ = 0;  // 페널티킥 조준 (골문 좌우 위치)
let simTime = 0;

// ===== 팀/스탯 커스텀 =====
const STAT_REF = 100;
const STAT_BASE = 90;

/** roles: 'all' | 'outfield' | 'gk' */
const STAT_DEFS = [
  { key: 'speed', label: '속도', group: '공통', roles: 'all' },
  { key: 'accel', label: '가속도', group: '공통', roles: 'all' },
  { key: 'staminaRegen', label: '체력 회복', group: '공통', roles: 'all' },
  { key: 'pass', label: '패스', group: '필드', roles: 'outfield' },
  { key: 'shortPass', label: '짧은 패스', group: '필드', roles: 'outfield' },
  { key: 'longPass', label: '긴 패스', group: '필드', roles: 'outfield' },
  { key: 'crossing', label: '크로스', group: '필드', roles: 'outfield' },
  { key: 'vision', label: '시야', group: '필드', roles: 'outfield' },
  { key: 'shotPower', label: '슛 파워', group: '필드', roles: 'outfield' },
  { key: 'finishing', label: '골 결정력', group: '필드', roles: 'outfield' },
  { key: 'penalty', label: '페널티 킥', group: '필드', roles: 'outfield' },
  { key: 'freekick', label: '프리킥', group: '필드', roles: 'outfield' },
  { key: 'curve', label: '커브', group: '필드', roles: 'outfield' },
  { key: 'dribbling', label: '드리블', group: '필드', roles: 'outfield' },
  { key: 'defense', label: '수비', group: '필드', roles: 'outfield' },
  { key: 'positioning', label: '위치선정', group: '필드', roles: 'outfield' },
  { key: 'heading', label: '헤딩', group: '필드', roles: 'outfield' },
  { key: 'volleys', label: '발리슛', group: '필드', roles: 'outfield' },
  { key: 'reaction', label: '반응속도', group: '키퍼', roles: 'gk' },
  { key: 'gkPositioning', label: '위치선정', group: '키퍼', roles: 'gk' },
  { key: 'diving', label: '다이빙', group: '키퍼', roles: 'gk' },
  { key: 'handling', label: '핸들링', group: '키퍼', roles: 'gk' },
  { key: 'gkKicking', label: '골킥', group: '키퍼', roles: 'gk' },
];

const TEAM_COLORS = [
  { id: 'blue', name: '블루', hex: 0x2563eb, css: '#2563eb' },
  { id: 'red', name: '레드', hex: 0xdc2626, css: '#dc2626' },
  { id: 'white', name: '화이트', hex: 0xe8eef7, css: '#e8eef7' },
  { id: 'black', name: '블랙', hex: 0x1e293b, css: '#1e293b' },
  { id: 'green', name: '그린', hex: 0x16a34a, css: '#16a34a' },
  { id: 'orange', name: '오렌지', hex: 0xea580c, css: '#ea580c' },
  { id: 'yellow', name: '옐로', hex: 0xca8a04, css: '#ca8a04' },
  { id: 'cyan', name: '시안', hex: 0x0891b2, css: '#0891b2' },
];
// 키퍼 유니폼은 양 팀 필드 선수와 겹치지 않는 색에서 고름 (규칙)
const GK_KITS = [0x84cc16, 0xf472b6, 0x8b5cf6, 0xfde047, 0x14b8a6, 0x9ca3af];

// 리그: 상대 AI 기본 능력치와 판단력(iq, 1 = 가장 똑똑함)
// 리그: 상대 구단 선수들의 강화 단계(enh) · 훈련 레벨(tr) · AI 판단력(iq) — 올라갈수록 팀 평균 오버롤이 높아짐
// 아마추어(1강 · 훈련 0) ~ APL(10강 · 훈련 10) 사이에서 팀 평균 오버롤이 고르게 오르도록 고른 조합 (약 65 → 94, 단계마다 약 +2.6)
const LEAGUES = [
  { id: 'amateur', tier: 'amateur', name: '아마추어', enh: 1, tr: 0 },
  { id: 'semi3', tier: 'semi', n: 3, name: '세미프로 3부', enh: 2, tr: 8 },
  { id: 'semi2', tier: 'semi', n: 2, name: '세미프로 2부', enh: 4, tr: 1 },
  { id: 'semi1', tier: 'semi', n: 1, name: '세미프로 1부', enh: 5, tr: 0 },
  { id: 'pro3', tier: 'pro', n: 3, name: '프로 3부', enh: 6, tr: 0 },
  { id: 'pro2', tier: 'pro', n: 2, name: '프로 2부', enh: 6, tr: 10 },
  { id: 'pro1', tier: 'pro', n: 1, name: '프로 1부', enh: 7, tr: 9 },
  { id: 'master3', tier: 'master', n: 3, name: '마스터 3부', enh: 8, tr: 2 },
  { id: 'master2', tier: 'master', n: 2, name: '마스터 2부', enh: 9, tr: 0 },
  { id: 'master1', tier: 'master', n: 1, name: '마스터 1부', enh: 9, tr: 8 },
  { id: 'challenger', tier: 'challenger', name: '챌린저', enh: 10, tr: 0 },
  { id: 'apl', tier: 'apl', name: 'Apex Premier League', short: 'APL', enh: 10, tr: 10 },
];
// AI 판단력(iq): 아마추어 0.15 → APL 1 (고르게)
LEAGUES.forEach((lg, i) => { lg.iq = Math.round((0.15 + 0.85 * i / (LEAGUES.length - 1)) * 100) / 100; });
// 리그 보상 배율: 아마추어 1배 → APL 4배
const LEAGUE_MULT = LEAGUES.map((_, i) => Math.round(Math.pow(4, i / (LEAGUES.length - 1)) * 100) / 100);

// ===== 리그 표지 (SVG) — 아마추어: 동 원형 A · 세미프로: 은 삼각형 · 프로: 금 사각형 · 마스터: 에메랄드 오각형 · 챌린저: 다이아 육각형 · APL: 검정+금 왕관 =====
const LG_TIER = {
  amateur: { c: ['#ffd7b0', '#c9773a', '#6e3510'], shape: 'circle' },
  semi: { c: ['#ffffff', '#a8b4c4', '#3f4b5c'], shape: 'tri' },
  pro: { c: ['#fff3b0', '#f5a623', '#8a4b00'], shape: 'sq' },
  master: { c: ['#c9ffe9', '#19c48a', '#04553b'], shape: 'pent' },
  challenger: { c: ['#f0fdff', '#6fe3f5', '#1c6f8a'], shape: 'hex' },
  apl: { c: ['#fde68a', '#d4a017', '#1a1406'], shape: 'hex' },
};
const LG_SHAPES = {
  circle: null,
  tri: [[6, 14], [94, 14], [50, 94]],
  sq: [[16, 12], [90, 18], [84, 92], [10, 86]],
  pent: [[50.0, 8.0], [93.7, 39.8], [77.0, 91.2], [23.0, 91.2], [6.3, 39.8]],
  hex: [[50.0, 3.0], [90.7, 26.5], [90.7, 73.5], [50.0, 97.0], [9.3, 73.5], [9.3, 26.5]],
};
function lgShape(shape, sc = 1, attrs = '') {
  if (shape === 'circle') return `<circle cx="50" cy="50" r="${45 * sc}" ${attrs}/>`;
  const pts = LG_SHAPES[shape], cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return `<polygon points="${pts.map(([x, y]) => `${(cx + (x - cx) * sc).toFixed(1)},${(cy + (y - cy) * sc).toFixed(1)}`).join(' ')}" ${attrs}/>`;
}
const lgEmblemCache = {};
let lgEmbSeq = 0;
function leagueEmblem(lg) {
  // SVG 그라데이션 id가 화면에 겹치면(숨겨진 표지가 먼저 있으면) 색이 안 나오므로 그릴 때마다 고유 id
  if (lgEmblemCache[lg.id]) return lgEmblemCache[lg.id].replaceAll('__ID__', 'lge' + (++lgEmbSeq));
  const T = LG_TIER[lg.tier] || LG_TIER.amateur, [c1, c2, c3] = T.c, id = '__ID__';
  const apl = lg.tier === 'apl';
  const label = lg.tier === 'amateur' ? 'A' : lg.tier === 'challenger' ? 'C' : String(lg.n || '');
  const ty = T.shape === 'tri' ? 54 : 52;
  const inner = apl
    ? `<path d="M27 62 L23 34 L38 47 L50 26 L62 47 L77 34 L73 62 Z" fill="url(#${id}-g)" stroke="#5c4300" stroke-width="2" stroke-linejoin="round"/><rect x="27" y="65" width="46" height="8" rx="2" fill="url(#${id}-g)" stroke="#5c4300" stroke-width="2"/><circle cx="50" cy="26" r="3.6" fill="#fff7d6"/><circle cx="23" cy="34" r="3" fill="#fff7d6"/><circle cx="77" cy="34" r="3" fill="#fff7d6"/><text x="50" y="88" text-anchor="middle" font-family="'Black Han Sans', sans-serif" font-size="13" fill="url(#${id}-g)" letter-spacing="2">APL</text>`
    : `<text x="52.5" y="${ty + 3.5}" text-anchor="middle" dominant-baseline="middle" font-family="'Black Han Sans', sans-serif" font-size="46" fill="${c3}" opacity="0.85">${label}</text><text x="50" y="${ty}" text-anchor="middle" dominant-baseline="middle" font-family="'Black Han Sans', sans-serif" font-size="46" fill="url(#${id}-t)" stroke="${c3}" stroke-width="1.2">${label}</text>`;
  const svg = `<svg class="lg-emb ${lg.tier}" viewBox="0 0 100 100"><defs>
      <linearGradient id="${id}-o" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${apl ? '#52525b' : c1}"/><stop offset="0.45" stop-color="${apl ? '#18181b' : c2}"/><stop offset="1" stop-color="${apl ? '#000' : c3}"/></linearGradient>
      <linearGradient id="${id}-i" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${apl ? '#3f3f46' : c2}"/><stop offset="1" stop-color="${apl ? '#09090b' : c3}"/></linearGradient>
      <linearGradient id="${id}-t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${c1}"/></linearGradient>
      <linearGradient id="${id}-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff7d6"/><stop offset="0.5" stop-color="#f5c542"/><stop offset="1" stop-color="#a86f00"/></linearGradient>
      <pattern id="${id}-p" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="3" height="7" fill="${apl ? '#d4a017' : '#ffffff'}" opacity="${apl ? 0.18 : 0.16}"/></pattern>
      <clipPath id="${id}-c">${lgShape(T.shape, 0.8)}</clipPath></defs>
    ${lgShape(T.shape, 1.04, `fill="${apl ? '#d4a017' : c3}" transform="translate(2.5 3.5)" opacity="0.55"`)}
    ${lgShape(T.shape, 1, `fill="url(#${id}-o)" stroke="${apl ? '#f5c542' : c1}" stroke-width="${apl ? 3.2 : 2}" stroke-linejoin="round"`)}
    ${lgShape(T.shape, 0.8, `fill="url(#${id}-i)" stroke="${apl ? '#a86f00' : c1}" stroke-opacity="0.7" stroke-width="1.5" stroke-linejoin="round"`)}
    <g clip-path="url(#${id}-c)"><rect width="100" height="100" fill="url(#${id}-p)"/><path d="M0 0H100V38Q50 48 0 30Z" fill="#fff" opacity="0.12"/></g>
    ${inner}</svg>`;
  lgEmblemCache[lg.id] = svg;
  return svg.replaceAll('__ID__', 'lge' + (++lgEmbSeq));
}
// 리그 상대 팀 평균 오버롤 (구단마다 조금씩 다름 → 8구단 평균)
for (const lg of LEAGUES) Object.defineProperty(lg, 'base', { get() { return lg._b ?? (lg._b = Math.round(TEAM_COLORS.reduce((a, c) => a + clubXI(c.id, '4-3-3', lg).ovr, 0) / TEAM_COLORS.length)); } });
function leagueById(id) { return LEAGUES.find(l => l.id === id) || LEAGUES[0]; }
function currentLeague() { return leagueById(userSetup.leagueId); }
let apcOpp = null; // APC 경기 중일 때 상대 팀 {name, colorId, base, iq}
function oppBase() { return apcOpp ? apcOpp.base : currentLeague().base; }
/** 구단 선수로 상대 선발 11명 구성: 포메이션 자리마다 그 자리 오버롤이 가장 높은 선수 · 리그 강화 · 훈련 반영 */
function clubXI(colorId, formation, lg) {
  const slots = getFormationSlots(formation || '4-3-3');
  const pool = clubPlayers(colorId);
  const boosted = pool.map(t => {
    const fo = { ...t.fo };
    const keys = posKeys(t.pos);
    for (let i = 0; i < (lg?.tr || 0) * 2; i++) fo[keys[i % keys.length]] += 1; // 훈련: 레벨당 주요 능력치 +2
    const e = ENH_BONUS[clamp(lg?.enh || 1, 1, ENH_MAX)];
    for (const k of FO_KEYS) fo[k] += e;                                      // 강화: 전체 능력치
    return { t, fo };
  });
  const used = new Set();
  const ovrAt = (x, pos) => { const ks = posKeys(pos); return ks.reduce((a, k) => a + x.fo[k], 0) / ks.length; };
  const pick = slots.map(f => {
    let best = null, bs = -1;
    for (const x of boosted) { if (used.has(x)) continue; const v = ovrAt(x, f.position) - (x.t.pos === f.position ? 0 : 3); if (v > bs) { bs = v; best = x; } }
    used.add(best);
    return { x: best, ovr: Math.round(ovrAt(best, f.position)), ovrF: ovrAt(best, f.position), f };
  });
  return {
    stats: pick.map(p => gameStats(p.x.fo, p.f.role === 'GK')),
    pids: pick.map(p => p.x.t.num),
    bodies: pick.map(p => ({ height: p.x.t.height, weight: p.x.t.weight })),
    names: pick.map(p => p.x.t.name),
    ovr: Math.round(pick.reduce((a, p) => a + p.ovrF, 0) / pick.length),
  };
}
function oppIQ() { return apcOpp ? apcOpp.iq : currentLeague().iq; }
function compName() {
  if (apcOpp?.kind === 'league') return `${currentLeague().name} · ${(userSetup.season?.round ?? 0) + 1}라운드`;
  return apcOpp ? `APC 에펙컵 · ${['8강', '4강', '결승'][userSetup.apc?.round] || ''}` : currentLeague().name;
}
const isApc = () => apcOpp && apcOpp.kind !== 'league';
/** AI 판단력: 우리 팀 AI 동료는 항상 1, 상대 팀은 리그에 따라 */
function aiIQ(p) { return p?.isBlue ? 1 : oppIQ(); }
/** 낮은 리그일수록 커지는 실수 배율 (APL = 0) */
function dumb(p) { return 1 - aiIQ(p); }

function emptyBoosts() {
  const o = {};
  for (const d of STAT_DEFS) o[d.key] = 0;
  return o;
}

function statsForRole(isGk) {
  return STAT_DEFS.filter(d => d.roles === 'all' || d.roles === (isGk ? 'gk' : 'outfield'));
}

const userSetup = {
  colorId: null,
  oppColorId: null,
  formation: '4-3-3',
  cpuFormation: '4-3-3',
  leagueId: 'semi1',
  clubName: '',
  selectedIdx: 0,
  boosts: Array.from({ length: 11 }, () => emptyBoosts()),
};

// ===== 계정 (이 브라우저에만 저장되는 로컬 계정) =====
const ACC_KEY = 'apexFootball.accounts.v1';
const LAST_KEY = 'apexFootball.lastUser';
// 모든 계정 초기화: 이 숫자를 올리면 다음 실행 때 저장된 계정 · 구단이 한 번 전부 지워짐 (설정 · 키 배치는 유지)
const ACCOUNT_RESET_V = 1;
const RESET_KEY = 'apexFootball.accountResetV';
try {
  if (Number(localStorage.getItem(RESET_KEY)) !== ACCOUNT_RESET_V) {
    localStorage.removeItem(ACC_KEY);
    localStorage.removeItem(LAST_KEY);
    localStorage.setItem(RESET_KEY, String(ACCOUNT_RESET_V));
  }
} catch (e) { /* 저장 불가 환경 */ }
let currentUser = null;
function readAccounts() {
  try { return JSON.parse(localStorage.getItem(ACC_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function writeAccounts(a) {
  try { localStorage.setItem(ACC_KEY, JSON.stringify(a)); } catch (e) { /* 저장 불가 환경 */ }
}
function lastUserId() { try { return localStorage.getItem(LAST_KEY); } catch (e) { return null; } }
/** 비밀번호를 그대로 저장하지 않도록 간단한 해시 (진짜 보안용은 아님) */
function hashPw(id, pw) {
  const str = `apex:${id}:${pw}`;
  let h1 = 0x811c9dc5, h2 = 0x9e3779b1;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ (c + i), 2246822519) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
function resetUserSetup() {
  userSetup.colorId = null;
  userSetup.oppColorId = null;
  userSetup.clubName = '';
  userSetup.formation = '4-3-3';
  activeFormation = '4-3-3';
  userSetup.leagueId = 'semi1';
  userSetup.selectedIdx = 0;
  userSetup.boosts = Array.from({ length: 11 }, () => emptyBoosts());
  userSetup.inv = null;
  userSetup.train = null;
  userSetup.pids = null;
  userSetup.roster = null;
  userSetup.rosterV = 0;
  userSetup.lineup = null;
  userSetup.club = null;
}
function applySetup(d) {
  if (!d) return;
  if (d.colorId && TEAM_COLORS.some(c => c.id === d.colorId)) userSetup.colorId = d.colorId;
  if (typeof d.clubName === 'string') userSetup.clubName = d.clubName.slice(0, 14);
  if (d.formation && FORMATIONS[d.formation]) { userSetup.formation = d.formation; activeFormation = d.formation; }
  if (d.leagueId && LEAGUES.some(l => l.id === d.leagueId)) userSetup.leagueId = d.leagueId;
  userSetup.boosts = Array.from({ length: 11 }, () => emptyBoosts()); // 강화 포인트 시스템 삭제
  userSetup.pids = Array.isArray(d.pids) ? d.pids.slice(0, 11) : null;
  userSetup.coins = Math.max(0, Math.floor(Number(d.coins) || 0));
  userSetup.apc = d.apc && Array.isArray(d.apc.teams) && d.apc.teams.length === 8 ? d.apc : null;
  userSetup.season = d.season && Array.isArray(d.season.teams) && d.season.teams.length === 8 && Array.isArray(d.season.sched) ? d.season : null;
  if (d.inv && typeof d.inv === 'object') userSetup.inv = d.inv;
  if (Array.isArray(d.train) && d.train.length >= 11) userSetup.train = d.train.map(t => ({ lv: clamp(Math.floor(t?.lv || 0), 0, 10), brk: clamp(Math.floor(t?.brk || 0), 0, 5), exp: Math.max(0, Math.floor(t?.exp || 0)), brkFail: clamp(Math.floor(t?.brkFail || 0), 0, 100), bonus: migrateFo(t?.bonus), sp: migrateFo(t?.sp), enh: clamp(Math.floor(t?.enh || 1), 1, 10), lb: clamp(Math.floor(t?.lb || 0), 0, 5), lbExp: Math.max(0, Math.floor(t?.lbExp || 0)) }));
  userSetup.rosterV = d.rosterV || 0;
  userSetup.roster = Array.isArray(d.roster) && d.roster.length >= 11 ? d.roster.map(x => (Number.isInteger(x?.tid) ? { uid: String(x.uid || Math.random()), tid: x.tid, season: x.season || CARD_SEASON, type: x.type || CARD_TYPE } : null)) : null;
  if (userSetup.roster && userSetup.roster.some(x => !x)) userSetup.roster = null;
  userSetup.lineup = d.lineup && typeof d.lineup === 'object' ? d.lineup : null;
  userSetup.tactics = d.tactics && typeof d.tactics === 'object' ? d.tactics : null;
  userSetup.club = d.club && typeof d.club === 'object' ? d.club : null;
  userSetup.fkKicker = Number.isInteger(d.fkKicker) ? d.fkKicker : null;
  if (Array.isArray(d.pkOrder)) userSetup.pkOrder = d.pkOrder.filter(n => Number.isInteger(n) && n >= 1 && n <= 99).slice(0, 11);
  if (userSetup.colorId) userSetup.oppColorId = pickOppColor(userSetup.colorId);
}
/** 지금 계정의 구단 · 리그 · 포메이션 · 선수별 강화를 저장 */
let dataVer = 0; // 저장할 때마다 +1 (화면 캐시 무효화용)
function saveSetup() {
  dataVer++;
  if (!currentUser) return;
  const a = readAccounts();
  if (!a[currentUser]) return;
  a[currentUser].setup = {
    colorId: userSetup.colorId,
    clubName: userSetup.clubName,
    formation: squadEdit ? squadEdit.formation : userSetup.formation, // 라인업 편집 중엔 저장된(확정) 라인업을 씀
    leagueId: userSetup.leagueId,
    boosts: userSetup.boosts,
    pkOrder: userSetup.pkOrder,
    coins: userSetup.coins || 0,
    apc: userSetup.apc || null,
    season: userSetup.season || null,
    inv: userSetup.inv || null,
    train: userSetup.train || null,
    pids: userSetup.pids || null,
    roster: userSetup.roster || null,
    rosterV: userSetup.rosterV || 0,
    lineup: (squadEdit ? squadEdit.lineup : userSetup.lineup) || null,
    tactics: userSetup.tactics || null,
    club: userSetup.club || null,
    fkKicker: userSetup.fkKicker ?? null,
  };
  writeAccounts(a);
}
function validId(id) { return /^[A-Za-z0-9가-힣_]{2,12}$/.test(id); }
function loginAccount(id, pw) {
  if (!id || !pw) return { ok: false, msg: '아이디와 비밀번호를 입력하세요.' };
  const a = readAccounts();
  const acc = a[id];
  if (!acc) return { ok: false, msg: '없는 아이디입니다. "새 계정 만들기"를 눌러 주세요.' };
  if (acc.pw !== hashPw(id, pw)) return { ok: false, msg: '비밀번호가 틀렸습니다.' };
  currentUser = id;
  resetUserSetup();
  applySetup(acc.setup);
  try { localStorage.setItem(LAST_KEY, id); } catch (e) { /* 무시 */ }
  return { ok: true };
}
function registerAccount(id, pw) {
  if (!validId(id)) return { ok: false, msg: '아이디는 2~12자 한글·영문·숫자·_ 만 됩니다.' };
  if (pw.length < 4) return { ok: false, msg: '비밀번호는 4자 이상이어야 합니다.' };
  const a = readAccounts();
  if (a[id]) return { ok: false, msg: '이미 있는 아이디입니다. 로그인해 주세요.' };
  a[id] = { pw: hashPw(id, pw), setup: null, created: Date.now() };
  writeAccounts(a);
  currentUser = id;
  resetUserSetup();
  try { localStorage.setItem(LAST_KEY, id); } catch (e) { /* 무시 */ }
  return { ok: true };
}

function colorById(id) {
  return TEAM_COLORS.find(c => c.id === id) || TEAM_COLORS[0];
}

function pickOppColor(myId) {
  // 대비가 큰 색을 상대에게
  const me = colorById(myId);
  let best = null, bestD = -1;
  for (const c of TEAM_COLORS) {
    if (c.id === myId) continue;
    const r1 = (me.hex >> 16) & 255, g1 = (me.hex >> 8) & 255, b1 = me.hex & 255;
    const r2 = (c.hex >> 16) & 255, g2 = (c.hex >> 8) & 255, b2 = c.hex & 255;
    let d = Math.hypot(r1 - r2, g1 - g2, b1 - b2);
    if (c.id === 'red' || c.id === 'blue') d += 40; // 클래식 매치업 선호
    if (d > bestD) { bestD = d; best = c; }
  }
  return best?.id || 'red';
}

function teamName(blue) {
  if (blue) return userSetup.clubName || `${colorById(userSetup.colorId || 'blue').name} FC`;
  if (apcOpp) return apcOpp.name;
  const lg = currentLeague();
  return `${colorById(userSetup.oppColorId || 'red').name} CPU (${lg.short || lg.name})`;
}


function statValue(boosts, key, base = STAT_BASE) {
  return base + (boosts?.[key] || 0);
}

function buildCustomStats(boosts, base = STAT_BASE) {
  const o = {};
  for (const d of STAT_DEFS) o[d.key] = statValue(boosts, d.key, base);
  return o;
}

/** 체력 구간별 전체 스탯 감소량 (내 팀·상대 팀 똑같이 적용)
 *  90% 이하 -1 · 80% 이하 -2 · 70% 이하 -4 · 60% 이하 -8 · 50% 이하 -12 · 40% 이하 -16
 *  · 30% 이하 -20 · 20% 이하 -24 · 10% 이하 -28 */
const STAMINA_STEPS = [[90, 1], [80, 2], [70, 4], [60, 8], [50, 12], [40, 16], [30, 20], [20, 24], [10, 28]];
function staminaPenalty(p) {
  const st = p?.stamina ?? 100;
  let pen = 0;
  for (const [lim, v] of STAMINA_STEPS) if (st <= lim) pen = v;
  return pen;
}

function statMul(p, key) {
  const v = (p?.customStats?.[key] ?? STAT_BASE) - staminaPenalty(p);
  return Math.max(40, v) / STAT_REF;
}
const teamAi = {
  poss: null,
  possFlip: 0,
  bluePress: null,
  redPress: null,
  bluePressT: 0,
  redPressT: 0,
  blueCover: null,
  redCover: null,
};
let activeIdx = 9;
let lastToucher = null;
let setpiece = null;
let goalPauseTimer = 0;
let lastGoalBlue = true;
let replayMode = null;
// 리플레이: 매 프레임 위치를 저장해 두었다가 골이 나면 다른 각도로 두 번 재생
const REC_N = 420; // 7초
const recBuf = new Array(REC_N);
let recHead = 0, recCount = 0, goalRecLeft = 0;
let recTotal = 0, lastKickRec = -1; // 녹화 총 프레임 수, 마지막으로 공을 찬 순간
let replay = null;
const REPLAY_ANGLES = {
  tv: '중계 카메라', reverse: '반대편 카메라', shooter: '슈터 시점', goal: '골대 뒤 카메라', gk: '키퍼 시점', high: '하늘 카메라', side45: '측면 카메라',
};
let replayGoalSide = 1;
let inPens = false;
let fkMode = false;     // 프리킥 연습 모드
const fkState = { tries: 0, goals: 0, watch: 0, wait: 0, resolved: false };
let penState = null;
let foulCd = 0;
let simFrame = 0;
/** 개발자 그라운드용 스위치 (일반 게임에서는 모두 꺼짐) */
const devFlags = { on: false, noFouls: false, noOffside: false, oppAi: 'ai', mateAi: 'ai', speed: 1, autoReset: false, infStamina: true };
let devTick = null; // 개발자 그라운드가 매 프레임 호출
let headingCd = 0;

const stats = {
  passes: [0, 0],
  possession: [0, 0],
  shots: [0, 0],
  shotsOnTarget: [0, 0],
  goals: [0, 0],
  fouls: [0, 0],
  yellows: [0, 0],
  reds: [0, 0],
};

const ball = {
  x: 0, z: 0, y: BALL_R,
  vx: 0, vz: 0, vy: 0,
  wx: 0, wy: 0, wz: 0,  // 회전(스핀) 벡터 ω
  owner: null,
  holdByGk: null,
  lastShot: false,
  shotTeamBlue: null,
  fromThrow: false,
  blockedShot: false,
  inGoal: 0,
};

function showMsg(text, ms = 1600) {
  msgEl.textContent = text;
  msgEl.classList.add('show');
  clearTimeout(showMsg._t);
  showMsg._t = setTimeout(() => msgEl.classList.remove('show'), ms);
}
function dist2(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function norm2(x, z) {
  const l = Math.hypot(x, z);
  return l > 0.0001 ? [x / l, z / l] : [0, 0];
}
function powerRange(min, max, p) { return lerp(min, max, clamp(p, 0, 1)); }

const FORMATIONS = {
  '4-3-3': [
    { ox: 3, oz: 0, role: 'GK', position: 'GK', label: 'GK', foot: 'right' },
    { ox: 22, oz: -0.78, role: 'FB', position: 'LB', label: 'LB', foot: 'left' },
    { ox: 20, oz: -0.28, role: 'CB', position: 'CB', label: 'CB', foot: 'right' },
    { ox: 20, oz: 0.28, role: 'CB', position: 'CB', label: 'CB', foot: 'left' },
    { ox: 22, oz: 0.78, role: 'FB', position: 'RB', label: 'RB', foot: 'right' },
    { ox: 32, oz: 0, role: 'MF', position: 'CDM', label: 'CDM', foot: 'right' },
    { ox: 38, oz: -0.42, role: 'MF', position: 'CM', label: 'CM', foot: 'left' },
    { ox: 38, oz: 0.42, role: 'MF', position: 'CM', label: 'CM', foot: 'right' },
    { ox: 48, oz: -0.72, role: 'WG', position: 'LW', label: 'LW', foot: 'right' },
    { ox: 50, oz: 0, role: 'ST', position: 'ST', label: 'ST', foot: 'right' },
    { ox: 48, oz: 0.72, role: 'WG', position: 'RW', label: 'RW', foot: 'left' },
  ],
  '4-2-3-1': [
    { ox: 3, oz: 0, role: 'GK', position: 'GK', label: 'GK', foot: 'right' },
    { ox: 22, oz: -0.78, role: 'FB', position: 'LB', label: 'LB', foot: 'left' },
    { ox: 20, oz: -0.28, role: 'CB', position: 'CB', label: 'CB', foot: 'right' },
    { ox: 20, oz: 0.28, role: 'CB', position: 'CB', label: 'CB', foot: 'left' },
    { ox: 22, oz: 0.78, role: 'FB', position: 'RB', label: 'RB', foot: 'right' },
    { ox: 32, oz: -0.28, role: 'MF', position: 'CDM', label: 'CDM', foot: 'left' },
    { ox: 32, oz: 0.28, role: 'MF', position: 'CDM', label: 'CDM', foot: 'right' },
    { ox: 44, oz: -0.62, role: 'WG', position: 'LW', label: 'LW', foot: 'right' },
    { ox: 44, oz: 0, role: 'MF', position: 'CAM', label: 'CAM', foot: 'right' },
    { ox: 44, oz: 0.62, role: 'WG', position: 'RW', label: 'RW', foot: 'left' },
    { ox: 50, oz: 0, role: 'ST', position: 'ST', label: 'ST', foot: 'right' },
  ],
  '4-4-2': [
    { ox: 3, oz: 0, role: 'GK', position: 'GK', label: 'GK', foot: 'right' },
    { ox: 22, oz: -0.78, role: 'FB', position: 'LB', label: 'LB', foot: 'left' },
    { ox: 20, oz: -0.28, role: 'CB', position: 'CB', label: 'CB', foot: 'right' },
    { ox: 20, oz: 0.28, role: 'CB', position: 'CB', label: 'CB', foot: 'left' },
    { ox: 22, oz: 0.78, role: 'FB', position: 'RB', label: 'RB', foot: 'right' },
    { ox: 36, oz: -0.72, role: 'WG', position: 'LW', label: 'LM', foot: 'left' },
    { ox: 34, oz: -0.24, role: 'MF', position: 'CM', label: 'CM', foot: 'right' },
    { ox: 34, oz: 0.24, role: 'MF', position: 'CM', label: 'CM', foot: 'left' },
    { ox: 36, oz: 0.72, role: 'WG', position: 'RW', label: 'RM', foot: 'right' },
    { ox: 49, oz: -0.18, role: 'ST', position: 'ST', label: 'ST', foot: 'right' },
    { ox: 49, oz: 0.18, role: 'ST', position: 'ST', label: 'ST', foot: 'left' },
  ],
  '4-1-4-1': [
    { ox: 3, oz: 0, role: 'GK', position: 'GK', label: 'GK', foot: 'right' },
    { ox: 22, oz: -0.78, role: 'FB', position: 'LB', label: 'LB', foot: 'left' },
    { ox: 20, oz: -0.28, role: 'CB', position: 'CB', label: 'CB', foot: 'left' },
    { ox: 20, oz: 0.28, role: 'CB', position: 'CB', label: 'CB', foot: 'right' },
    { ox: 22, oz: 0.78, role: 'FB', position: 'RB', label: 'RB', foot: 'right' },
    { ox: 30, oz: 0, role: 'MF', position: 'CDM', label: 'CDM', foot: 'right' },
    { ox: 40, oz: -0.72, role: 'WG', position: 'LW', label: 'LM', foot: 'left' },
    { ox: 38, oz: -0.26, role: 'MF', position: 'CM', label: 'CM', foot: 'left' },
    { ox: 38, oz: 0.26, role: 'MF', position: 'CM', label: 'CM', foot: 'right' },
    { ox: 40, oz: 0.72, role: 'WG', position: 'RW', label: 'RM', foot: 'right' },
    { ox: 50, oz: 0, role: 'ST', position: 'ST', label: 'ST', foot: 'right' },
  ],
  '4-3-1-2': [
    { ox: 3, oz: 0, role: 'GK', position: 'GK', label: 'GK', foot: 'right' },
    { ox: 22, oz: -0.78, role: 'FB', position: 'LB', label: 'LB', foot: 'left' },
    { ox: 20, oz: -0.28, role: 'CB', position: 'CB', label: 'CB', foot: 'left' },
    { ox: 20, oz: 0.28, role: 'CB', position: 'CB', label: 'CB', foot: 'right' },
    { ox: 22, oz: 0.78, role: 'FB', position: 'RB', label: 'RB', foot: 'right' },
    { ox: 34, oz: -0.4, role: 'MF', position: 'CM', label: 'CM', foot: 'left' },
    { ox: 32, oz: 0, role: 'MF', position: 'CDM', label: 'CDM', foot: 'right' },
    { ox: 34, oz: 0.4, role: 'MF', position: 'CM', label: 'CM', foot: 'right' },
    { ox: 43, oz: 0, role: 'MF', position: 'CAM', label: 'CAM', foot: 'right' },
    { ox: 49, oz: -0.2, role: 'ST', position: 'ST', label: 'ST', foot: 'left' },
    { ox: 49, oz: 0.2, role: 'ST', position: 'ST', label: 'ST', foot: 'right' },
  ],
  '3-5-2': [
    { ox: 3, oz: 0, role: 'GK', position: 'GK', label: 'GK', foot: 'right' },
    { ox: 20, oz: -0.4, role: 'CB', position: 'CB', label: 'CB', foot: 'left' },
    { ox: 19, oz: 0, role: 'CB', position: 'CB', label: 'CB', foot: 'right' },
    { ox: 20, oz: 0.4, role: 'CB', position: 'CB', label: 'CB', foot: 'right' },
    { ox: 32, oz: -0.82, role: 'FB', position: 'LB', label: 'LWB', foot: 'left' },
    { ox: 31, oz: -0.2, role: 'MF', position: 'CDM', label: 'CDM', foot: 'left' },
    { ox: 31, oz: 0.2, role: 'MF', position: 'CDM', label: 'CDM', foot: 'right' },
    { ox: 32, oz: 0.82, role: 'FB', position: 'RB', label: 'RWB', foot: 'right' },
    { ox: 42, oz: 0, role: 'MF', position: 'CAM', label: 'CAM', foot: 'right' },
    { ox: 49, oz: -0.2, role: 'ST', position: 'ST', label: 'ST', foot: 'left' },
    { ox: 49, oz: 0.2, role: 'ST', position: 'ST', label: 'ST', foot: 'right' },
  ],
  '3-4-3': [
    { ox: 3, oz: 0, role: 'GK', position: 'GK', label: 'GK', foot: 'right' },
    { ox: 20, oz: -0.4, role: 'CB', position: 'CB', label: 'CB', foot: 'left' },
    { ox: 19, oz: 0, role: 'CB', position: 'CB', label: 'CB', foot: 'right' },
    { ox: 20, oz: 0.4, role: 'CB', position: 'CB', label: 'CB', foot: 'right' },
    { ox: 33, oz: -0.8, role: 'FB', position: 'LB', label: 'LM', foot: 'left' },
    { ox: 34, oz: -0.24, role: 'MF', position: 'CM', label: 'CM', foot: 'left' },
    { ox: 34, oz: 0.24, role: 'MF', position: 'CM', label: 'CM', foot: 'right' },
    { ox: 33, oz: 0.8, role: 'FB', position: 'RB', label: 'RM', foot: 'right' },
    { ox: 47, oz: -0.62, role: 'WG', position: 'LW', label: 'LW', foot: 'left' },
    { ox: 50, oz: 0, role: 'ST', position: 'ST', label: 'ST', foot: 'right' },
    { ox: 47, oz: 0.62, role: 'WG', position: 'RW', label: 'RW', foot: 'right' },
  ],
  '5-3-2': [
    { ox: 3, oz: 0, role: 'GK', position: 'GK', label: 'GK', foot: 'right' },
    { ox: 24, oz: -0.82, role: 'FB', position: 'LB', label: 'LWB', foot: 'left' },
    { ox: 19, oz: -0.38, role: 'CB', position: 'CB', label: 'CB', foot: 'left' },
    { ox: 18, oz: 0, role: 'CB', position: 'CB', label: 'CB', foot: 'right' },
    { ox: 19, oz: 0.38, role: 'CB', position: 'CB', label: 'CB', foot: 'right' },
    { ox: 24, oz: 0.82, role: 'FB', position: 'RB', label: 'RWB', foot: 'right' },
    { ox: 34, oz: -0.36, role: 'MF', position: 'CM', label: 'CM', foot: 'left' },
    { ox: 32, oz: 0, role: 'MF', position: 'CDM', label: 'CDM', foot: 'right' },
    { ox: 34, oz: 0.36, role: 'MF', position: 'CM', label: 'CM', foot: 'right' },
    { ox: 48, oz: -0.2, role: 'ST', position: 'ST', label: 'ST', foot: 'left' },
    { ox: 48, oz: 0.2, role: 'ST', position: 'ST', label: 'ST', foot: 'right' },
  ],
};
let activeFormation = '4-3-3';

function getFormationSlots(name = activeFormation) {
  return FORMATIONS[name] || FORMATIONS['4-3-3'];
}

function attrsFor(position) {
  const table = {
    GK: { speed: 0.45, accel: 0.5, pass: 0.55, vision: 0.6, positioning: 0.8, defense: 0.85 },
    CB: { speed: 0.62, accel: 0.6, pass: 0.58, vision: 0.55, positioning: 0.75, defense: 0.86 },
    LB: { speed: 0.78, accel: 0.75, pass: 0.64, vision: 0.6, positioning: 0.68, defense: 0.7 },
    RB: { speed: 0.78, accel: 0.75, pass: 0.64, vision: 0.6, positioning: 0.68, defense: 0.7 },
    CDM: { speed: 0.68, accel: 0.66, pass: 0.74, vision: 0.72, positioning: 0.78, defense: 0.8 },
    CM: { speed: 0.74, accel: 0.72, pass: 0.78, vision: 0.76, positioning: 0.72, defense: 0.62 },
    CAM: { speed: 0.76, accel: 0.74, pass: 0.8, vision: 0.82, positioning: 0.74, defense: 0.42 },
    LW: { speed: 0.86, accel: 0.84, pass: 0.7, vision: 0.68, positioning: 0.7, defense: 0.4 },
    RW: { speed: 0.86, accel: 0.84, pass: 0.7, vision: 0.68, positioning: 0.7, defense: 0.4 },
    ST: { speed: 0.82, accel: 0.8, pass: 0.62, vision: 0.66, positioning: 0.8, defense: 0.28 },
  };
  return { ...(table[position] || table.CM) };
}

function scaleAttrs(a, k) {
  const o = {};
  for (const key in a) o[key] = a[key] * k;
  return o;
}

function makeTeam(isHome, side, opts = {}) {
  const color = opts.color ?? (isHome ? 0x2563eb : 0xdc2626);
  const gkColor = opts.gkColor ?? 0x84cc16;
  const slots = getFormationSlots(opts.formation || activeFormation);
  const dir = side === 'left' ? 1 : -1;
  const baseX = side === 'left' ? -FIELD_W / 2 : FIELD_W / 2;
  return slots.map((f, i) => {
    const x = baseX + dir * f.ox * FSCALE;
    // 오른쪽 팀은 z도 뒤집어야 LB가 실제로 그 팀의 왼쪽에 선다
    const z = (FIELD_H / 2 - 4) * f.oz * dir;
    const isGk = f.role === 'GK';
    const pno = opts.pids?.[i] ?? i + 1;
    const mesh = createPlayerMesh(isGk ? gkColor : color, pno, f.label, isGk);
    mesh.position.set(x, 0, z);
    const b = opts.boosts?.[i] || emptyBoosts();
    return {
      x, z, vx: 0, vz: 0,
      faceX: dir, faceZ: 0,
      num: pno, role: f.role, position: f.position, label: f.label, isBlue: isHome,
      teamId: isHome ? 'home' : 'away',
      homeX: x, homeZ: z, homePosition: { x, z }, mesh,
      slotDepth: f.ox * FSCALE, // 자기 골라인에서의 기본 거리 (대형 유지용)
      targetPosition: { x, z },
      currentAction: 'HOLD_POSITION',
      actionLock: 0,
      actionScores: {},
      preferredFoot: f.foot || 'right',
      playerAttributes: scaleAttrs(attrsFor(f.position), (opts.statBase ?? STAT_BASE) / STAT_BASE),
      customStats: opts.homeStats?.[i] ? { ...opts.homeStats[i] } : buildCustomStats(b, opts.statBase ?? STAT_BASE),
      tacticalInstructions: {
        width: f.position === 'LW' || f.position === 'RW' || f.position === 'LB' || f.position === 'RB' ? 1 : 0.55,
        press: f.position === 'ST' ? 0.35 : f.position === 'CDM' || f.position === 'CM' ? 0.8 : 0.6,
        overlap: f.position === 'LB' || f.position === 'RB',
      },
      aiTimer: 0, tackleCd: 0, dispossessCd: 0,
      height: opts.bodies?.[i]?.height ?? 181, weight: opts.bodies?.[i]?.weight ?? 76,
      tacRole: opts.roles?.[i] || null,
      stamina: 100,
      sprinting: false,
      yellowCards: 0,
      redCard: false,
      sentOff: false,
      holdTicks: 0,
      jumpY: 0,
      kickAnim: 0,
      dive: 0,
      animPhase: Math.random() * 6,
    };
  });
}

let teamA = [];
let teamB = [];

function allPlayers() { return [...teamA, ...teamB]; }
function fieldPlayers(team) { return team.filter(p => !p.sentOff); }
function getActive() {
  const p = teamA[activeIdx];
  if (p && !p.sentOff) return p;
  for (let i = 0; i < teamA.length; i++) {
    if (!teamA[i].sentOff && teamA[i].role !== 'GK') { activeIdx = i; return teamA[i]; }
  }
  return teamA[0];
}
function setActive(p) {
  if (!p || p.sentOff) return;
  const cur = teamA[activeIdx];
  // 내가 공을 몰고 있으면 다른 선수로 바뀌지 않음
  if (cur && cur !== p && !cur.sentOff && (ball.owner === cur || ball.holdByGk === cur) && phase === 'play') return;
  const i = teamA.indexOf(p);
  if (i >= 0) { activeIdx = i; switchLock = 18; }
}

function clearTeamsMeshes() {
  for (const p of allPlayers()) disposePlayerMesh(p.mesh);
}

function resetBall(x = 0, z = 0) {
  ball.x = x; ball.z = z; ball.y = BALL_R;
  ball.vx = ball.vz = ball.vy = 0;
  ball.wx = ball.wy = ball.wz = 0;
  ball.owner = null; ball.holdByGk = null;
  ball.lastShot = false;
  ball.shotTeamBlue = null;
  ball.fromThrow = false;
  ball.blockedShot = false;
  ball.inGoal = 0;
}

/** 팀을 새로 만들지 않고 킥오프 대형으로만 되돌림 (체력·카드 유지, 메모리 누수 없음) */
function recordFrame() {
  const ps = allPlayers();
  const need = 3 + ps.length * 10 + 2;
  let f = recBuf[recHead];
  if (!f || f.length !== need) f = recBuf[recHead] = new Float32Array(need);
  writeFrame(f, ps);
  recTotal++;
  recHead = (recHead + 1) % REC_N;
  recCount = Math.min(REC_N, recCount + 1);
}

function writeFrame(f, ps) {
  f[0] = ball.x; f[1] = ball.y; f[2] = ball.z;
  let i = 3;
  for (const p of ps) {
    f[i++] = p.x; f[i++] = p.z; f[i++] = p.faceX; f[i++] = p.faceZ; f[i++] = p.vx; f[i++] = p.vz;
    f[i++] = p.jumpY || 0; f[i++] = p.kickAnim || 0; f[i++] = p.dive || 0; f[i++] = p.diveDir || 1;
  }
  f[i++] = referee.x; f[i++] = referee.z;
}

/** 세리머니 시작 후에도 공이 그물까지 들어가는(튕겨 나가는) 장면을 리플레이에 이어 붙임:
 *  선수들은 마지막 녹화 자세에서 착지만 하고, 공만 실제로 계속 움직임 */
function recordPenTail() {
  if (recCount < 2) return;
  const prev = recAt(recCount - 1);
  let f = recBuf[recHead];
  if (!f || f.length !== prev.length) f = recBuf[recHead] = new Float32Array(prev.length);
  f.set(prev);
  f[0] = ball.x; f[1] = ball.y; f[2] = ball.z;
  for (let i = 3; i + 9 < f.length - 2; i += 10) { f[i + 4] *= 0.85; f[i + 5] *= 0.85; f[i + 6] *= 0.85; f[i + 7] = 0; }
  recTotal++;
  recHead = (recHead + 1) % REC_N;
  recCount = Math.min(REC_N, recCount + 1);
}
function recAt(k) { return recBuf[(recHead - recCount + k + REC_N * 2) % REC_N]; }

function applyRecFrame(f0, f1, a) {
  const L = (i) => f0[i] + (f1[i] - f0[i]) * a;
  ball.x = L(0); ball.y = L(1); ball.z = L(2);
  ball.owner = null; ball.holdByGk = null;
  const ps = allPlayers();
  let i = 3;
  for (const p of ps) {
    p.x = L(i); p.z = L(i + 1); p.faceX = f0[i + 2]; p.faceZ = f0[i + 3];
    p.vx = f0[i + 4]; p.vz = f0[i + 5]; p.jumpY = f0[i + 6]; p.kickAnim = f0[i + 7]; p.dive = f0[i + 8]; p.diveDir = f0[i + 9];
    i += 10;
  }
  referee.x = L(i); referee.z = L(i + 1);
}

function startReplay() {
  if (recCount < 30) return finishGoalSequence();
  const end = recCount - 1;
  // 마지막 슛(킥·헤딩) 순간을 녹화 안에서 찾아 조금 앞부터
  const kickAgo = lastKickRec >= 0 ? recTotal - lastKickRec : 120;
  // 2번째(슬로): 공을 차기 0.9초(54프레임) 전부터
  const shotStart = clamp(end - kickAgo - 54, 0, Math.max(0, end - 30));
  const runStart = runRec >= 0 && lastKickRec === runKickRec ? clamp(end - (recTotal - runRec) - 4, 0, Math.max(0, end - 30)) : -1;
  // 도움닫기가 있는 킥(프리킥 등): 슬로는 도움닫기 중간부터
  const slowStart = runStart >= 0 ? clamp(Math.round((runStart + (end - kickAgo)) / 2), 0, Math.max(0, end - 30)) : shotStart;
  const first = ['tv', 'reverse', 'shooter', 'high'];
  const a1 = first[Math.floor(Math.random() * first.length)];
  const second = ['goal', 'side45', 'shooter', 'reverse'].filter(a => a !== a1);
  const a2 = second[Math.floor(Math.random() * second.length)];
  replay = {
    pass: 0,
    passes: [
      { angle: a1, start: runStart >= 0 ? runStart : Math.max(0, end - 300), speed: 1 },     // 1번째: 정상 속도
      { angle: a2, start: slowStart, speed: 0.3 },               // 2번째: 슛 차는 장면부터 슬로모션
    ],
    t: 0, end, kind: 'goal',
  };
  replay.t = replay.passes[0].start;
  phase = 'replay';
  clearCelebrations();
  replayBadge.classList.add('show');
  setReplayBadge();
  snapReplayCam = true;
}

let snapReplayCam = false;
function setReplayBadge() {
  const ps = replay.passes[replay.pass];
  const n = replay.passes.length;
  const title = replay.kind === 'save' ? '선방 REPLAY' : `REPLAY ${replay.pass + 1}/${n}`;
  replayBadge.textContent = `${title} · ${REPLAY_ANGLES[ps.angle]}${ps.speed < 1 ? ' · 슬로' : ''} — SPACE 건너뛰기`;
}

function updateReplay() {
  const ps = replay.passes[replay.pass];
  replay.t += ps.speed;
  if (replay.t >= replay.end) {
    replay.pass++;
    if (replay.pass >= replay.passes.length) return replay.kind === 'save' ? finishSaveReplay() : replay.kind === 'pen' ? finishPenReplay() : finishGoalSequence();
    replay.t = replay.passes[replay.pass].start;
    setReplayBadge();
    snapReplayCam = true;
  }
  const k = Math.floor(replay.t);
  const a = replay.t - k;
  applyRecFrame(recAt(k), recAt(Math.min(replay.end, k + 1)), a);
}

// ----- 선방 리플레이: 지금 경기 상태를 저장해 두고, 재생 후 그대로 이어서 진행 -----
let saveReplayPending = 0;
/** 지금 위치 상태를 녹화 프레임과 같은 형식으로 복사 */
function captureFrame() {
  const ps = allPlayers();
  const f = new Float32Array(3 + ps.length * 10 + 2);
  writeFrame(f, ps);
  return f;
}
let liveSnap = null;
function triggerSaveReplay() {
  return; // 선방 리플레이는 쓰지 않음 (골 리플레이만)
  if (inPens || fkMode || phase !== 'play') return;
  saveReplayPending = 40; // 선방 직후 장면까지 조금 더 녹화
}
function startSaveReplay() {
  if (recCount < 60) return;
  const end = recCount - 1;
  // 지금 상태 저장
  liveSnap = {
    f: captureFrame(),
    ball: { vx: ball.vx, vy: ball.vy, vz: ball.vz, wx: ball.wx, wy: ball.wy, wz: ball.wz, owner: ball.owner, holdByGk: ball.holdByGk, lastShot: ball.lastShot, blockedShot: ball.blockedShot, inGoal: ball.inGoal },
    phase, clockPaused, activeIdx, pendingReceiver,
  };
  const angle = Math.random() < 0.5 ? 'side45' : 'goal';
  const runStart = runRec >= 0 && lastKickRec === runKickRec ? clamp(end - (recTotal - runRec) - 4, 0, end - 30) : -1;
  const kickAt = end - (recTotal - lastKickRec);
  const slowStart = runStart >= 0 ? clamp(Math.round((runStart + kickAt) / 2), 0, end - 30) : Math.max(0, end - 170);
  replay = { pass: 0, passes: [{ angle, start: slowStart, speed: 0.35 }], t: 0, end, kind: 'save' };
  replay.t = replay.passes[0].start;
  replayGoalSide = ball.holdByGk ? (ball.holdByGk.isBlue ? -1 : 1) : (ball.x > 0 ? 1 : -1);
  phase = 'replay';
  clockPaused = true;
  replayBadge.classList.add('show');
  setReplayBadge();
  snapReplayCam = true;
}
/** 승부를 끝낸 골 / 선방 / 실축 리플레이 (슬로모션 1번) */
let penWinnerName = null;
/** 세리머니가 끝난 뒤: 승부를 결정지은 킥을 키퍼가 키커를 바라보는 시점으로 슬로 재생 */
function startPenReplay() {
  const last = penState?.lastKick;
  if (!last || recCount < 30) { endMatch(penWinnerName); return; }
  const end = recCount - 1;
  replay = { pass: 0, passes: [{ angle: 'gkview', start: 0, speed: 0.32 }], t: 0, end, kind: 'pen' };
  replay.cornerZ = Math.sign(recAt(end)[2]) || 1; // 공이 마지막에 있던 쪽 (골이 들어간/막힌 쪽)
  replayGoalSide = last.blue ? 1 : -1;
  phase = 'replay';
  replayBadge.classList.add('show');
  setReplayBadge();
  replayBadge.textContent = `${last.scored ? '결승골' : '결정적 선방'} REPLAY · 골문 안 카메라 · 슬로 — SPACE 건너뛰기`;
  snapReplayCam = true;
}
function finishPenReplay() {
  replay = null;
  replayBadge.classList.remove('show');
  replayBadge.textContent = 'REPLAY';
  clearCelebrations();
  endMatch(penWinnerName);
}

function finishSaveReplay() {
  replay = null;
  replayBadge.classList.remove('show');
  replayBadge.textContent = 'REPLAY';
  if (!liveSnap) return;
  applyRecFrame(liveSnap.f, liveSnap.f, 0);
  Object.assign(ball, liveSnap.ball);
  phase = liveSnap.phase;
  clockPaused = liveSnap.clockPaused;
  activeIdx = liveSnap.activeIdx;
  pendingReceiver = liveSnap.pendingReceiver;
  liveSnap = null;
}

/** 골 장면(세리머니 + 리플레이) 끝내고 킥오프 */
function finishGoalSequence() {
  replay = null;
  clearCelebrations();
  replayBadge.classList.remove('show');
  replayBadge.textContent = 'REPLAY';
  replayMode = null;
  if (fkMode) { nextFreeKick(); return; }
  beginKickoff(!lastGoalBlue);
}

// ===== 프리킥 연습 =====
/** 프리킥 모드: 먼저 찰 선수 고르기 */
const fkScore = f => Math.round(f.freekick * 0.6 + f.curve * 0.25 + f.shotPower * 0.15);
function openFkPick() {
  const el = $('fkpick');
  if (!el) { startFreeKickMode(); return; }
  const slots = getFormationSlots(userSetup.formation);
  const list = slots.map((f, i) => ({ i, s: slotStats(i) })).filter(x => !x.s.isGk)
    .sort((a, b) => fkScore(b.s.fo) - fkScore(a.s.fo) || a.i - b.i);
  const best = list[0]?.i;
  el.innerHTML = `<div class="fkp-box"><div class="fkp-h"><span>프리킥 키커 선택</span><button type="button" id="fkp-x">✕</button></div>
    <div class="fkp-sub">프리킥을 찰 선수를 고르세요. 연습 중에도 <kbd>Tab</kbd>으로 바꿀 수 있어요.</div>
    <div class="fkp-grid">${list.map(({ i, s }) => `<button type="button" class="fkp-it ${i === userSetup.fkKicker ? 'last' : ''}" data-i="${i}">
      ${fcCard(i, s)}
      <div class="fkp-st"><div><span>프리킥</span><b>${s.fo.freekick}</b></div><div><span>커브</span><b>${s.fo.curve}</b></div><div><span>슛 파워</span><b>${s.fo.shotPower}</b></div></div>
      <div class="fkp-r">키커 능력 <b>${fkScore(s.fo)}</b>${i === best ? '<em>추천</em>' : ''}</div></button>`).join('')}</div></div>`;
  el.classList.add('show');
  $('fkp-x')?.addEventListener('click', () => el.classList.remove('show'));
  el.querySelectorAll('.fkp-it').forEach(b => b.addEventListener('click', () => {
    el.classList.remove('show');
    userSetup.fkKicker = Number(b.dataset.i);
    saveSetup();
    startFreeKickMode(userSetup.fkKicker);
  }));
}
function startFreeKickMode(kicker = null) {
  fkState.kicker = Number.isInteger(kicker) ? kicker : null;
  if (!userSetup.colorId) userSetup.colorId = 'blue';
  userSetup.oppColorId = pickOppColor(userSetup.colorId);
  if (menuRoot) menuRoot.classList.remove('show');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  resetMatch();
  fkMode = true;
  fkState.tries = 0;
  fkState.goals = 0;
  nextFreeKick();
}

/** 골문 앞 18~32m, 정면~측면 아무 곳에 새 프리킥 */
function nextFreeKick() {
  for (const p of allPlayers()) { p.sentOff = false; p.stamina = 100; p.yellowCards = 0; }
  placeForKickoff(true);
  const goalX = FIELD_W / 2;
  const d = 18 + Math.random() * 14;
  const a = (Math.random() - 0.5) * 1.3;
  const x = goalX - Math.cos(a) * d;
  const z = clamp(Math.sin(a) * d, -FIELD_H / 2 + 6, FIELD_H / 2 - 6);
  const pickT = fkState.kicker != null ? teamA[fkState.kicker] : null;
  if (pickT) { pickT.sentOff = false; pickT.mesh.visible = true; }
  beginSetpiece('freekick', true, x, z, pickT ? { fk: true, taker: pickT } : { fk: true });
  // 키커 · 수비벽 · 상대 키퍼만 남기고 나머지는 경기장 밖으로
  const keep = new Set([setpiece.taker, ...(setpiece.wall || []).map(w => w.p)]);
  const gk = teamB.find(p => p.role === 'GK');
  if (gk) { keep.add(gk); gk.x = FIELD_W / 2 - 0.6; gk.z = clamp(z * 0.12, -1.5, 1.5); }
  for (const p of allPlayers()) {
    if (keep.has(p)) continue;
    p.sentOff = true;
    p.mesh.visible = false;
    p.x = p.isBlue ? -FIELD_W / 2 - 20 : FIELD_W / 2 + 20;
  }
  fkState.watch = 0;
  fkState.wait = 0;
  fkState.resolved = false;
  clockPaused = true;
  setpieceHint.style.display = 'block';
  setpieceHint.textContent = `프리킥 연습 ${fkState.goals}/${fkState.tries} · Esc 일시정지`;
  updateHud();
}

/** 이번 프리킥 결과 처리 후 잠깐 쉬었다 다음 프리킥 */
function fkResult(scored, why = '') {
  if (fkState.resolved) return;
  fkState.resolved = true;
  fkState.tries++;
  if (scored) fkState.goals++;
  if (!scored) {
    showMsg(why || '실패!', 1100);
    phase = 'fk_wait';
    fkState.wait = 75;
  }
  updateHud();
}

function watchFreeKick() {
  if (!fkMode || phase !== 'play' || fkState.resolved) return;
  fkState.watch++;
  const slow = Math.hypot(ball.vx, ball.vz) < 0.03 && ball.y <= BALL_R + 0.02;
  if (ball.holdByGk) fkResult(false, '키퍼 선방!');
  else if (ball.owner && !ball.owner.isBlue) fkResult(false, '막혔다!');
  else if (fkState.watch > 200 || (fkState.watch > 40 && slow)) fkResult(false, '실패!');
}

function exitToLobby() {
  fkMode = false;
  inPens = false;
  showTitleMenu();
}

function placeForKickoff(kickoffBlue = true) {
  fkCam = null;
  recCount = 0;
  saveReplayPending = 0;
  replay = null;
  for (const p of allPlayers()) {
    p.vx = p.vz = 0;
    p.jumpY = 0;
    p.dive = 0;
    p.kickAnim = 0;
    p.holdTicks = 0;
    p.currentAction = 'HOLD_POSITION';
    p.actionLock = 0;
    p.faceX = p.isBlue ? 1 : -1;
    p.faceZ = 0;
    if (p.sentOff) {
      p.mesh.visible = false;
      p.x = p.isBlue ? -FIELD_W / 2 - 20 : FIELD_W / 2 + 20;
      p.z = 0;
      continue;
    }
    p.mesh.visible = true;
    // 자기 진영 + 수비팀은 센터서클 밖
    let x = p.isBlue ? Math.min(p.homeX, -0.6) : Math.max(p.homeX, 0.6);
    let z = p.homeZ;
    const defending = p.isBlue !== kickoffBlue;
    if (defending && Math.hypot(x, z) < CIRCLE_R + 0.5) {
      const [nx, nz] = norm2(x || (p.isBlue ? -1 : 1), z);
      x = nx * (CIRCLE_R + 0.5);
      z = nz * (CIRCLE_R + 0.5);
    }
    p.x = x; p.z = z;
    p.targetPosition = { x, z };
  }
  resetBall(0, 0);
  pendingReceiver = null;
  charge = { action: null, power: 0 };
  kickCooldown = 0;
  setpiece = null;
  setpieceHint.style.display = 'none';
  if (setpieceUi) setpieceUi.classList.remove('show');
  kickAimRing.visible = false;
  kickCone.visible = false;
  kickGuide.visible = false;
  clearCelebrations();
  replayBadge.classList.remove('show');
  replayMode = null;
  thirdPersonCam = false;

  const team = kickoffBlue ? teamA : teamB;
  const kicker = team.find(p => !p.sentOff && p.role === 'ST') || team.find(p => !p.sentOff && p.role !== 'GK');
  if (kicker) {
    const s = kickoffBlue ? 1 : -1;
    kicker.x = -s * 0.75;
    kicker.z = 0;
    kicker.faceX = s;
    ball.owner = kicker;
    lastToucher = kicker;
    if (kickoffBlue) setActive(kicker);
  }
  if (!kickoffBlue || !kicker) {
    const st = teamA.findIndex(p => !p.sentOff && p.role === 'ST');
    if (st >= 0) activeIdx = st;
  }
}

function setMatchHudVisible(vis) {
  const scoreboard = $('scoreboard');
  const stam = $('stamina-panel');
  const controls = $('controls');
  if (scoreboard) scoreboard.style.display = vis ? '' : 'none';
  if (stam) stam.style.display = vis ? '' : 'none';
  if (controls) controls.style.display = vis ? '' : 'none';
  const mm = $('minimap-wrap');
  if (mm) mm.style.display = vis ? '' : 'none';
}

function applyScoreboardColors() {
  const home = colorById(userSetup.colorId || 'blue');
  const away = colorById(userSetup.oppColorId || 'red');
  const homeLogo = $('home-logo');
  const awayLogo = $('away-logo');
  const homeName = $('home-name');
  const awayName = $('away-name');
  if (homeLogo) {
    homeLogo.style.background = home.css;
    homeLogo.style.color = luminance(home.hex) > 0.6 ? '#111' : '#fff';
    homeLogo.textContent = home.name.slice(0, 2);
  }
  if (awayLogo) {
    awayLogo.style.background = away.css;
    awayLogo.style.color = luminance(away.hex) > 0.6 ? '#111' : '#fff';
    awayLogo.textContent = 'CPU';
  }
  if (homeName) homeName.textContent = teamName(true);
  if (awayName) awayName.textContent = teamName(false);
}

function showKickoffWait() {
  phase = 'kickoff';
  thirdPersonCam = false;
  clockPaused = true;
  overlay.classList.remove('show');
  statsBox.style.display = 'none';
  setMatchHudVisible(true);
  setpieceHint.style.display = 'block';
  setpieceHint.textContent = '킥오프 대기 — SPACE로 경기 시작';
}

function startKickoff() {
  overlay.classList.remove('show');
  beginKickoff(true);
}

/** 센터에서 킥오프 대기. 키커가 패스를 하는 순간 경기(시계)가 다시 시작됨 */
function beginKickoff(kickoffBlue) {
  placeForKickoff(kickoffBlue);
  const team = kickoffBlue ? teamA : teamB;
  const taker = ball.owner || team.find(p => !p.sentOff && p.role !== 'GK');
  phase = 'setpiece';
  clockPaused = true;
  setpiece = { type: 'kickoff', teamBlue: kickoffBlue, x: 0, z: 0, taker, wall: null };
  ball.owner = taker;
  if (kickoffBlue) setActive(taker);
  else taker.aiTimer = 55 + Math.floor(Math.random() * 25);
  setpieceHint.style.display = 'block';
  setpieceHint.textContent = kickoffBlue
    ? `${teamName(true)} 킥오프 — S / A / W 로 패스하면 시작`
    : `${teamName(false)} 킥오프`;
}

function rebuildTeamsFromSetup() {
  activeFormation = userSetup.formation || '4-3-3';
  const homeHex = colorById(userSetup.colorId || 'blue').hex;
  const awayHex = colorById(userSetup.oppColorId || pickOppColor(userSetup.colorId)).hex;
  const gkPool = GK_KITS.filter(c => c !== homeHex && c !== awayHex);
  clearTeamsMeshes();
  teamA = makeTeam(true, 'left', {
    color: homeHex,
    gkColor: gkPool[0],
    formation: activeFormation,
    homeStats: Array.from({ length: 11 }, (_, i) => slotStats(i).o),
    pids: ensurePids(),
    bodies: Array.from({ length: 11 }, (_, i) => { const t = cardTpl(xiR(i)); return { height: t.height, weight: t.weight }; }),
    roles: Array.from({ length: 11 }, (_, i) => tacRoleOf(i)),
  });
  teamB = makeTeam(false, 'right', {
    color: awayHex,
    gkColor: gkPool[1],
    formation: userSetup.cpuFormation || activeFormation,
    boosts: Array.from({ length: 11 }, () => emptyBoosts()),
    statBase: oppBase(),
    // APC가 아니면 상대 = 그 팀 컬러 구단의 선수들 (지금 리그의 강화 · 훈련 적용)
    ...(apcOpp?.kind === 'apc' && !apcOpp.enh ? {} : (() => { const X = clubXI(userSetup.oppColorId || pickOppColor(userSetup.colorId), userSetup.cpuFormation || activeFormation, apcOpp?.kind === 'apc' ? { enh: apcOpp.enh, tr: apcOpp.tr } : currentLeague()); return { homeStats: X.stats, pids: X.pids, bodies: X.bodies }; })()),
  });
  // 심판 유니폼이 팀과 겹치면 형광색으로
  const dark = c => luminance(c) < 0.2;
  referee.shirt.color.setHex(0xfacc15); // 심판은 항상 노란 상의
  paintStadium(homeHex, awayHex);
  applyScoreboardColors();
}

function resetMatch() {
  fkMode = false;
  pkOnly = false;
  score = [0, 0];
  matchGoals = []; lastPossessor = prevPossessor = null;
  matchMinute = 0;
  half = 1;
  inPens = false;
  penState = null;
  Object.assign(stats, {
    passes: [0, 0], possession: [0, 0], shots: [0, 0], shotsOnTarget: [0, 0], goals: [0, 0],
    fouls: [0, 0], yellows: [0, 0], reds: [0, 0],
  });
  rebuildTeamsFromSetup();
  referee.mesh.visible = true;
  thirdPersonCam = false;
  overlay.classList.remove('show');
  statsBox.style.display = 'none';
  setMatchHudVisible(true);
  beginKickoff(true); // 스페이스 대기 없이 바로 킥오프 자리 — 패스하면 시작
  updateHud();
}

let penBoardKey = '';
/** 중계 화면처럼: 팀별 득점 수 + 1~5번 키커 결과 (초록 성공, 빨강 실패) */
function renderPenBoard() {
  const el = $('pen-board');
  if (!el) return;
  const show = penState && (inPens || phase === 'ended' || (phase === 'replay' && replay?.kind === 'pen')) && !inMenus();
  if (!show) { if (el.style.display !== 'none') { el.style.display = 'none'; penBoardKey = ''; } return; }
  const bh = penState.blueHist || [], rh = penState.redHist || [];
  const key = bh.join() + '|' + rh.join() + '|' + penState.kickerBlue + phase;
  if (key === penBoardKey) return;
  penBoardKey = key;
  // 5칸만 보여주고, 6번째 키커부터는 2~6, 3~7 ... 으로 밀려감
  const nextIdx = inPens ? (penState.kickerBlue ? bh.length : rh.length) + 1 : 0;
  const last = Math.max(5, bh.length, rh.length, nextIdx);
  const first = last - 4;
  const row = (blue, hist, goals) => {
    const c = colorById(blue ? userSetup.colorId || 'blue' : userSetup.oppColorId || 'red').css;
    let dots = '';
    for (let i = first - 1; i < last; i++) {
      const r = hist[i];
      const cls = r === true ? 'ok' : r === false ? 'no' : (hist.length === i && penState.kickerBlue === blue && inPens ? 'next' : '');
      dots += `<span class="pk ${cls}">${r === true ? '✓' : r === false ? '✕' : i + 1}</span>`;
    }
    return `<div class="pb-row"><span class="pb-dot" style="background:${c}"></span><span class="pb-name">${escapeHtml(teamName(blue))}</span><span class="pb-score">${goals}</span>${dots}</div>`;
  };
  el.innerHTML = `<div class="pb-title">승부차기${penState.sudden ? ' · 서든데스' : ''}</div>` +
    row(true, bh, penState.blueGoals) + row(false, rh, penState.redGoals);
  el.style.display = 'block';
}

let hudCache = '';
function updateHud() {
  renderPenBoard();
  let sc = fkMode ? `${fkState.goals} / ${fkState.tries}` : `${score[0]} - ${score[1]}`;
  if (penState) sc += ` (PK ${penState.blueGoals}-${penState.redGoals})`;
  const totalSec = Math.max(0, Math.floor(matchMinute * 60 + 1e-4));
  const m = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  let hl;
  if (fkMode) hl = 'FREE KICK';
  else if (phase === 'replay') hl = 'REPLAY';
  else if (phase === 'pen_celebrate') hl = 'PENS';
  else if (phase === 'halftime') hl = 'HALF TIME';
  else if (phase === 'et_offer') hl = 'FULL TIME';
  else if (phase === 'kickoff') hl = 'KICK OFF';
  else if (phase === 'ended') hl = penState ? 'PENS' : 'FULL TIME';
  else if (inPens) hl = 'PENS';
  else if (half === 3) hl = 'ET 1ST';
  else if (half === 4) hl = 'ET 2ND';
  else hl = half === 1 ? '1ST HALF' : '2ND HALF';

  const p = getActive();
  const st = p ? Math.round(p.stamina) : 0;
  const key = `${sc}|${m}:${sec}|${hl}|${p?.num}|${p?.yellowCards}|${st}|${p ? staminaPenalty(p) : 0}`;
  if (key === hudCache) return; // 바뀐 게 없으면 DOM 건드리지 않음
  hudCache = key;
  scoreText.textContent = sc;
  matchTimeEl.textContent = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  halfLabel.textContent = hl;
  if (!p) return;
  stamPos.textContent = p.label;
  const cardMark = p.yellowCards >= 1 ? ' 🟨' : '';
  stamName.textContent = `${p.num}번 ${p.label}${cardMark}`;
  stamFill.style.width = `${st}%`;
  stamFill.style.background = st > 50
    ? 'linear-gradient(90deg,#22c55e,#a3e635)'
    : st > 25
      ? 'linear-gradient(90deg,#eab308,#f59e0b)'
      : 'linear-gradient(90deg,#ef4444,#f97316)';
  const pen = staminaPenalty(p);
  stamPct.textContent = pen ? `체력 ${st}% · 전체 스탯 -${pen}` : `체력 ${st}%`;
}

// ===== 입력 =====
// 조작 키 바꾸기: 실제 누른 키(물리 키) → 게임 안의 기본 키 이름으로 바꿔서 처리
const KEY_ACTIONS = [
  ['shoot', '슛', 'KeyD'], ['ground', '짧은 패스', 'KeyS'], ['lob', '로빙 패스', 'KeyA'], ['through', '스루 패스', 'KeyW'],
  ['sprint', '질주', 'KeyE'], ['power', '파워 슛 (+슛)', 'KeyF'], ['modZ', '감아차기·긴 패스 (Z)', 'KeyZ'], ['modQ', '로빙 스루 (Q)', 'KeyQ'],
];
const KEY_DEFAULT = Object.fromEntries(KEY_ACTIONS.map(([a, , k]) => [a, k]));
let phys2log = {};
function rebuildKeymap() {
  phys2log = {};
  const km = Object.assign({}, KEY_DEFAULT, settings.keymap || {});
  for (const [a, , def] of KEY_ACTIONS) phys2log[km[a]] = def;
  // 다른 키로 옮긴 기본 키는 (다른 동작에 쓰이지 않으면) 아무 동작 안 함
  for (const [a, , def] of KEY_ACTIONS) if (km[a] !== def && !(def in phys2log)) phys2log[def] = 'Unbound_' + def;
}
const keyCodeOf = code => phys2log[code] || code;
const keyEv = ev => ({ code: keyCodeOf(ev.code), key: ev.key, repeat: ev.repeat, target: ev.target, preventDefault: () => ev.preventDefault() });
const keyName = c => ({ ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ShiftLeft: '왼 Shift', ShiftRight: '오른 Shift', ControlLeft: '왼 Ctrl', ControlRight: '오른 Ctrl', AltLeft: '왼 Alt', AltRight: '오른 Alt', Space: 'Space', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=' }[c] || c.replace(/^Key|^Digit/, '').replace(/^Numpad/, '숫자패드 '));
// 설정 화면: 지금 실제로 눌려 있는 키 표시 (키보드가 동시에 몇 개까지 읽는지 확인용) · 키 바꾸기
const heldPhys = new Set();
let keyCapture = null;
function showHeld() { const el = $('set-held'); if (el) el.textContent = heldPhys.size ? [...heldPhys].map(keyName).join(' + ') : '없음'; }
window.addEventListener('keydown', ev => {
  heldPhys.add(ev.code); showHeld();
  if (!keyCapture) return;
  ev.preventDefault(); ev.stopImmediatePropagation();
  const a = keyCapture; keyCapture = null;
  if (ev.code === 'Escape') { renderKeySettings(); return; }
  if (/^Arrow|^Tab$|^Escape$|^Space$|^Enter$|^KeyN$/.test(ev.code)) { renderKeySettings('방향키 · Tab · Space · Enter · N은 쓸 수 없어요'); return; }
  const km = Object.assign({}, KEY_DEFAULT, settings.keymap || {});
  const other = Object.keys(km).find(b => b !== a && km[b] === ev.code);
  if (other) km[other] = km[a]; // 이미 쓰는 키면 서로 바꿈
  km[a] = ev.code;
  settings.keymap = km; saveSettings(); rebuildKeymap(); renderKeySettings();
}, true);
window.addEventListener('keyup', ev => { heldPhys.delete(ev.code); showHeld(); }, true);
window.addEventListener('blur', () => { heldPhys.clear(); showHeld(); });
function renderKeySettings(msg) {
  const box = $('set-keys');
  if (!box) return;
  const km = Object.assign({}, KEY_DEFAULT, settings.keymap || {});
  box.innerHTML = KEY_ACTIONS.map(([a, label]) => `<div class="sk-row"><span>${label}</span><button type="button" class="sk-btn${keyCapture === a ? ' wait' : ''}" data-a="${a}">${keyCapture === a ? '키를 누르세요' : keyName(km[a])}</button></div>`).join('');
  const m = $('set-keymsg'); if (m) m.textContent = msg || '';
}
$('set-keys')?.addEventListener('click', e => { const b = e.target.closest('.sk-btn'); if (!b) return; keyCapture = b.dataset.a; renderKeySettings(); b.blur(); });
$('btn-keys-reset')?.addEventListener('click', () => { settings.keymap = {}; saveSettings(); rebuildKeymap(); renderKeySettings(); });

window.addEventListener('keydown', ev => {
  const e = keyEv(ev);
  if (e.target && e.target.tagName === 'INPUT') return; // 아이디·구단 이름 입력 중
  if (phase === 'menu' && e.code === 'KeyM' && !e.repeat) devTap();
  if (e.code === 'Escape') { for (const id of ['fkpick', 'pmenu', 'pinfo', 'redist', 'result-pop']) { const m = $(id); if (m?.classList.contains('show')) { m.classList.remove('show'); return; } } }
  if (phase === 'intro') { showLogin(); return; }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Space'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (e.code === 'Escape' && $('guide')?.classList.contains('show')) { $('guide').classList.remove('show'); return; }
  if (e.code === 'Escape' && $('settings')?.classList.contains('show')) { $('settings').classList.remove('show'); return; }
  if (paused) {
    if (e.code === 'Escape') {
      if ($('pause-confirm').style.display === 'block') { $('pause-main').style.display = 'block'; $('pause-confirm').style.display = 'none'; }
      else setPaused(false);
    }
    return; // 일시정지 중엔 다른 키 무시
  }
  if (phase === 'pen_order') { penOrderKey(e.code); return; }
  if (phase === 'sp_intro') { if (e.code === 'Space' || e.code === 'Enter') endSpIntro(); else if (e.code === 'Escape' && canPause()) setPaused(true); return; }
  if (phase === 'prematch') { if (e.code === 'Space') preNext(); else if (e.code === 'Enter') endPreMatch(); else if (e.code === 'Escape' && canPause()) setPaused(true); return; }
  if (e.code === 'Escape' && canPause()) { setPaused(true); return; }
  keys[e.code] = true;

  if (e.code === 'Space' || e.code === 'Enter') {
    if (inMenus()) return;
    if (e.code !== 'Space') return;
    if (phase === 'replay' && replay?.kind === 'save') { finishSaveReplay(); return; }
    if (phase === 'replay' && replay?.kind === 'pen') { finishPenReplay(); return; }
    if (phase === 'pen_celebrate') { finishPenCelebration(); return; }
    if (phase === 'setpiece' && setpiece?.cut) { endPenCut(); return; }
    if ((phase === 'replay' || phase === 'goal_pause') && !inPens) { finishGoalSequence(); return; }
    if (phase === 'kickoff') startKickoff();
    else if (phase === 'halftime') {
      if (half === 1) startSecondHalf();
      else if (half === 3) startEtSecond();
    } else if (phase === 'et_offer') startExtraTime();
    else if (phase === 'ended') { if (apcOpp?.kind === 'league') openLeagueSelect('season'); else if (apcOpp) openApc(); else showTitleMenu(); }
    return;
  }
  if (e.code === 'Escape' && $('guide')?.classList.contains('show')) {
    $('guide').classList.remove('show');
    return;
  }
  if (inMenus()) return;
  if (e.code === 'KeyN' && !inMenus()) {
    showAllTags = !showAllTags;
    showMsg(showAllTags ? '이름표: 전체 선수 표시' : '이름표: 조작 선수만', 1000);
    return;
  }
  if (e.code === 'F3') {
    e.preventDefault();
    aiDebug = !aiDebug;
    const box = $('ai-debug');
    if (box) box.style.display = aiDebug ? 'block' : 'none';
    return;
  }
  if (phase !== 'play' && phase !== 'setpiece') return;

  if (phase === 'setpiece' && setpiece?.teamBlue && (setpiece.type === 'freekick' || setpiece.type === 'corner')) {
    if (e.code === 'KeyC') { setKickIdx = (setKickIdx + 1) % SET_KICKS.length; return; }
    if (e.code === 'Tab') { changeKicker(); return; }
  }
  if (e.code === 'Tab') manualSwitch();

  if (e.code === 'KeyD' && userGkInPens()) { if (!setpiece?.cut) userGkDive(); return; }
  // 파워 슛: 게이지가 도는 중에 D를 다시 누르는 타이밍
  if (e.code === 'KeyD' && pshot) { firePowerShot(); return; } // 게이지가 도는 중 D 한 번 더 = 슛
  if (e.code === 'KeyS' && pshot) { pshot = null; return; } // S = 취소
  // 파워 슛 시작: F를 누른 채 D → 게이지 시작. 이때 바라보던 방향으로 몸 방향 고정
  if (e.code === 'KeyD' && keys.KeyF && phase === 'play' && !charge.action) {
    const p = getActive();
    if (p && !p.sentOff && (ball.owner === p || shotBufferable(p))) {
      const [fx, fz] = norm2(p.faceX || (p.isBlue ? 1 : -1), p.faceZ || 0);
      pshot = { t: 0, p, fx, fz };
      return;
    }
  }
  // 수비 중: S = 스탠딩 태클 · D = 슬라이딩 태클
  if (phase === 'play' && (e.code === 'KeyS' || e.code === 'KeyD') && !keys.KeyF) {
    const p = getActive();
    const mine = ball.owner === p || ball.holdByGk === p;
    const receiving = pendingReceiver === p && !ball.owner;
    const aerial = !ball.owner && ball.y > 0.9;
    const ourLoose = shotBufferable(p); // 우리 공을 받으러 가는 중: S · D = 다이렉트 패스 · 슛 선입력
    if (p && !mine && !receiving && !aerial && !ourLoose && !(ball.owner && ball.owner.isBlue)) { if (startTackle(p, e.code === 'KeyS' ? 'stand' : 'slide')) return; }
  }
  if (CHARGE_KEYS[e.code] && !charge.action && !setpiece?.cut) {
    const p = getActive();
    const can = (ball.owner === p || ball.holdByGk === p) ||
      (phase === 'setpiece' && setpiece && setpiece.taker === p);
    // 선입력: 공이 아직 발에 없거나(받는 중 · 굴러오는 우리 공) 직전 킥 직후여도 슛 · 패스를 미리 눌러 둘 수 있음 → 공을 잡는 순간 바로 (다이렉트)
    const shotKey = phase === 'play' && p && !p.sentOff && ball.holdByGk !== p && (ball.owner === p || shotBufferable(p));
    if ((can && kickCooldown <= 0 && !p.sentOff) || shotKey) {
      if (phase === 'setpiece' && setpiece) {
        if (setpiece.type === 'throw' && e.code !== 'KeyS' && e.code !== 'KeyA') return;
        if (setpiece.type === 'kickoff' && e.code === 'KeyD') return;
        if (setpiece.type === 'penalty' && e.code !== 'KeyD') return;
      }
      charge.action = CHARGE_KEYS[e.code];
      if (charge.action === 'shoot' && keys.KeyZ && phase === 'play') charge.action = 'finesse'; // Z+D 감아차기
      if (charge.action === 'ground' && keys.KeyZ && phase === 'play') charge.action = 'long';    // Z+S 긴 패스
      if (charge.action === 'through' && keys.KeyQ && phase === 'play') charge.action = 'lobThrough'; // Q+W 로빙 스루
      charge.power = 0;
    }
  }
});
window.addEventListener('keyup', ev => {
  const e = keyEv(ev);
  keys[e.code] = false;
  if (charge.action && e.code === (ACTION_KEY[charge.action] || Object.keys(CHARGE_KEYS).find(c => CHARGE_KEYS[c] === charge.action))) {
    releaseAction(charge.action, charge.power);
    charge.action = null;
    charge.power = 0;
  }
});
// 창 포커스를 잃으면 눌린 키가 '눌린 채로' 남는 버그 방지
window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
  charge.action = null;
  charge.power = 0;
});
window.addEventListener('resize', () => applyAspect());

function getInputDir() {
  if (inputDirOverride) return inputDirOverride;
  let dx = 0, dz = 0;
  if (keys.ArrowLeft) dx -= 1;
  if (keys.ArrowRight) dx += 1;
  if (keys.ArrowUp) dz -= 1;
  if (keys.ArrowDown) dz += 1;
  // 후반: 카메라가 반대편이므로 화면 기준 방향 = 경기장 좌표 반대
  if (phase === 'play' || (phase === 'setpiece' && !(setpiece && ['corner', 'freekick', 'penalty'].includes(setpiece.type)))) { const cs = camSideNow(); dx *= cs; dz *= cs; }
  return norm2(dx, dz);
}

function turnToward(px, pz, tx, tz, rate) {
  let cur = Math.atan2(px || 0, pz || 1);
  const target = Math.atan2(tx, tz);
  let diff = target - cur;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  cur += diff * clamp(rate, 0, 1);
  return [Math.sin(cur), Math.cos(cur)];
}

function refreshSetAim(teamBlue, from) {
  const gx = (teamBlue ? 1 : -1) * (FIELD_W / 2);
  const [bx, bz] = norm2(gx - from.x, 0 - from.z);
  const c = Math.cos(setAimYaw);
  const s = Math.sin(setAimYaw);
  setAimX = bx * c - bz * s;
  setAimZ = bx * s + bz * c;
}

function pointSetAimAtGoal(teamBlue, from) {
  setAimYaw = 0;
  refreshSetAim(teamBlue, from);
}

function manualSwitch() {
  const cur = getActive();
  if (ball.owner === cur || ball.holdByGk === cur) return; // 공 가진 선수는 교체 불가
  if (ball.holdByGk?.isBlue && ball.holdByGk !== cur) {
    setActive(ball.holdByGk);
    return;
  }
  let best = null, bestD = Infinity;
  for (const p of teamA) {
    if (p.role === 'GK' || p === cur || p.sentOff) continue;
    const d = dist2(p, ball);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best) setActive(best);
}

function nearestTeammate(from, team = teamA) {
  let best = null, bestD = Infinity;
  for (const p of team) {
    if (p === from || p.role === 'GK' || p.sentOff) continue;
    const d = dist2(from, p);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function findPassTarget(from) {
  const [dirX, dirZ] = getInputDir();
  const vision = statMul(from, 'vision');
  const maxDist = 48 + vision * 22;
  let best = null, bestScore = -Infinity;
  for (const t of teamA) {
    if (t === from || t.sentOff) continue;
    const isGk = t.role === 'GK';
    if (isGk && !(dirX || dirZ)) continue; // 키퍼에게는 방향키로 키퍼 쪽을 눌렀을 때만 (실수로 백패스 방지)
    const d = dist2(from, t);
    if (d < 1.5 || d > maxDist) continue;
    const [tx, tz] = norm2(t.x - from.x, t.z - from.z);
    if (isGk && tx * dirX + tz * dirZ < 0.8) continue;
    let s = 80 - d * (1.05 - vision * 0.25) - (isGk ? 12 : 0);
    if (dirX || dirZ) {
      const dot = tx * dirX + tz * dirZ;
      if (dot < 0.05) continue;
      s += dot * (48 + vision * 12);
    } else {
      s += (t.x - from.x) * 0.45;
      s += (1 / (d + 1)) * 25;
      s += vision * 8;
    }
    if (s > bestScore) { bestScore = s; best = t; }
  }
  return best || nearestTeammate(from);
}

function passLeadPoint(from, target, power) {
  const d = dist2(from, target);
  const lead = 0.45 + power * 0.85;
  const [fx, fz] = norm2(target.faceX || target.vx || 0.01, target.faceZ || target.vz || 0);
  return {
    x: target.x + fx * lead,
    z: target.z + fz * lead,
    power: clamp(0.26 + d * 0.018 + power * 0.22, 0.38, 1.0),
  };
}

/** 스루패스 목표: 받는 선수 '앞의 빈 공간'. 선수가 전력으로 뛰어 도착하는 시간에 공도 도착하게 */
/** 스루패스 목표 = 받는 선수 '앞의 빈 공간'.
 *  · 수비 라인이 앞에 있으면 그 뒤 공간으로 찌른다
 *  · 앞/대각선 여러 방향 중 상대가 가장 늦게 닿는 곳을 고른다
 *  · 공은 선수가 그 공간에 뛰어 들어가는 시간에 맞춰 도착한다 */
function throughLeadPoint(from, t, power, inputDir = [0, 0]) {
  // 받는 선수 '바로 앞'(상대 골문 방향) 공간. 방향키·패서 위치와 상관없이 받는 선수 기준
  const atk = from.isBlue ? 1 : -1;
  const goalX = atk * FIELD_W / 2;
  const line = offsideLineX(from.isBlue);
  const behind = (line - t.x) * atk; // 수비 라인이 받는 선수보다 얼마나 앞에 있나
  const runSpd = SPRINT * 0.9 * statMul(t, 'speed') * sprintMult(t);
  // 기본은 정면(x축). 터치라인에 붙어 있으면 골문 쪽으로 조금만 안쪽
  let dz = 0;
  if (Math.abs(t.z) > FIELD_H / 2 - 12) dz = -Math.sign(t.z) * 0.22;
  const dx = atk;
  const n = Math.hypot(dx, dz);
  const ux = dx / n, uz = dz / n;
  let L = 7 + power * 11;
  if (behind > -1 && behind < 20) L = Math.max(L, behind + 4 + power * 6); // 수비 라인 뒤까지
  L = Math.min(L, 26, Math.max(4, (goalX - t.x) * atk - 5));                 // 키퍼에게 바로 가지 않게
  const x = clamp(t.x + ux * L, -FIELD_W / 2 + 3, FIELD_W / 2 - 3);
  const z = clamp(t.z + uz * L, -FIELD_H / 2 + 3, FIELD_H / 2 - 3);
  const runFrames = Math.hypot(x - t.x, z - t.z) / runSpd;
  let oppT = Infinity;
  for (const o of fieldPlayers(from.isBlue ? teamB : teamA)) {
    const os = (o.role === 'GK' ? SPRINT * 0.45 : SPRINT * 0.85) * statMul(o, 'speed');
    oppT = Math.min(oppT, Math.max(0, Math.hypot(o.x - x, o.z - z) - 1) / os);
  }
  return { x, z, runFrames, oppT };
}

/** 스로인 받을 동료: 던질 수 있는 거리 안에서 고름 */
function findThrowTarget(from, maxD) {
  const [dirX, dirZ] = from.isBlue ? getInputDir() : [0, 0];
  let best = null, bestS = -Infinity;
  for (const t of matesOf(from)) {
    if (t === from || t.role === 'GK') continue;
    const d = dist2(from, t);
    if (d < 3 || d > maxD + 14) continue;
    let s = -Math.abs(d - maxD * 0.6) * (d > maxD ? 1.6 : 1) + Math.min(nearestOppDist(t.x, t.z, from.isBlue), 6) * 1.5;
    if (dirX || dirZ) {
      const [tx, tz] = norm2(t.x - from.x, t.z - from.z);
      s += (tx * dirX + tz * dirZ) * 20;
    }
    if (s > bestS) { bestS = s; best = t; }
  }
  return best;
}

/** 스로인: 손으로 던지므로 짧고 낮게 */
function throwIn(p, t, long, power = 0.5) {
  const maxD = long ? 15 : 10;
  let tx, tz;
  // 받는 선수 발 앞 (살짝 앞쪽)으로 부드럽게
  if (t) { tx = t.x + (t.faceX || 0) * 0.5; tz = t.z + (t.faceZ || 0) * 0.5; }
  else { tx = ball.x + (p.isBlue ? 1 : -1) * 6; tz = ball.z - Math.sign(ball.z) * 4; }
  // 옆(터치라인 방향)으로 던져도 공이 라인 밖에 머물며 바로 아웃되지 않게: 항상 경기장 안쪽으로 최소 2.5m
  const side = Math.sign(ball.z) || 1;
  const inner = FIELD_H / 2 - 2.5;
  if (side * tz > inner) tz = side * inner;
  let d = Math.hypot(tx - ball.x, tz - ball.z);
  if (d > maxD) { const k = maxD / d; tx = ball.x + (tx - ball.x) * k; tz = ball.z + (tz - ball.z) * k; d = maxD; }
  if (side * tz > inner) tz = side * inner;
  // 손을 떠나는 위치는 터치라인 바로 위 (라인 밖 0.2m에서 출발하면 옆으로 던질 때 그대로 아웃 판정)
  ball.z = side * (FIELD_H / 2);
  d = Math.hypot(tx - ball.x, tz - ball.z);
  // 천천히: 체공을 길게, 받는 선수 무릎 높이(0.45m)로 도착 → 바로 트래핑
  const T = clamp(14 + d * 1.3, 18, 36);
  const vy = (0.6 - 2.0 + GRAVITY * T * (T - 1) / 2) / T + 0.06;
  const spd = Math.max(0.15, d) * (1 - AIR_DRAG) / (1 - Math.pow(AIR_DRAG, T));
  kickFrom(p, spd, tx, tz, { vy: vy - 0.06 });
  stats.passes[p.isBlue ? 0 : 1]++;
  if (t) {
    t.expectPass = 80;
    t.lobLand = { x: tx, z: tz, ttl: Math.ceil(T + 20) }; // 낙하 지점에서 기다림
    ball.throwTo = t; ball.throwTtl = Math.ceil(T + 6); // 날아가는 동안 상대는 못 끊음
  }
}

function findThroughTarget(from) {
  const [dirX, dirZ] = getInputDir();
  let best = null, bestScore = -Infinity;
  for (const t of teamA) {
    if (t === from || t.role === 'GK' || t.role === 'CB' || t.sentOff) continue;
    if (t.x < from.x - 1) continue;
    let s = (t.role === 'ST' || t.role === 'WG' ? 22 : 8) + (t.x - from.x);
    if (dirX || dirZ) {
      const [tx, tz] = norm2(t.x - from.x, t.z - from.z);
      const dot = tx * dirX + tz * dirZ;
      if (dot < 0.05) continue;
      s += dot * 30;
    }
    if (s > bestScore) { bestScore = s; best = t; }
  }
  return best || findPassTarget(from);
}

/** 오프사이드: 패스 순간 리시버가 상대 진영에서 공·두 번째 마지막 수비수보다 골에 가까우면 */
function isOffsideAtPass(passer, receiver) {
  if (devFlags.noOffside) return false;
  if (!passer || !receiver || passer.role === 'GK') return false;
  const attackBlue = passer.isBlue;
  const opp = attackBlue ? teamB : teamA;
  if (attackBlue && receiver.x <= 0) return false;
  if (!attackBlue && receiver.x >= 0) return false;
  const byGoal = [...fieldPlayers(opp)].sort((a, b) => attackBlue ? b.x - a.x : a.x - b.x);
  const secondLast = byGoal[1] || byGoal[0];
  if (!secondLast) return false;
  if (attackBlue) return receiver.x > ball.x + 0.5 && receiver.x > secondLast.x + 0.35;
  return receiver.x < ball.x - 0.5 && receiver.x < secondLast.x - 0.35;
}

function callOffside(passer, receiver) {
  showMsg('오프사이드!', 1400);
  // 간접 프리킥: 오프사이드 위치에서 수비팀 재개
  beginSetpiece('freekick', !passer.isBlue, receiver.x, receiver.z, { indirect: true });
}

// =====================================================================
//  공 물리 — 마그누스 효과
//  전류의 자기작용: F = I L × B   (전류 방향 × 자기장 방향 → 수직인 힘)
//  회전하는 공   : F = k ω × v   (회전축 × 진행 방향 → 수직인 힘)
//   · 옆회전(ω가 위아래 축)   → 좌우로 휨 = 감아차기
//   · 탑스핀(ω가 왼쪽 축)     → 아래로 꺾임 = 드롭슛
//   · 백스핀(ω가 오른쪽 축)   → 위로 뜨는 힘 = 오래 뜨는 로빙
//  힘이 속도에 항상 수직이라 일을 하지 않음 → 속력은 그대로, 방향만 변함
// =====================================================================
function applyMagnus(b) {
  const ax = MAGNUS_K * (b.wy * b.vz - b.wz * b.vy);
  const ay = MAGNUS_K * (b.wz * b.vx - b.wx * b.vz);
  const az = MAGNUS_K * (b.wx * b.vy - b.wy * b.vx);
  b.vx += ax;
  b.vy += ay;
  b.vz += az;
}

/** 진행 방향(dx,dz) 기준 스핀을 ω 벡터로. side>0 이면 왼쪽으로 휨, top>0 이면 아래로 꺾임 */
function spinVector(dx, dz, side = 0, top = 0) {
  // 왼쪽 벡터 L = up × d = (dz, 0, -dx) — 탑스핀의 회전축
  return { wx: dz * top, wy: side, wz: -dx * top };
}

/** 골대(기둥/크로스바/그물) 충돌. 기둥·크로스바에 맞으면 true */
function collideGoalFrame(b) {
  let hit = false;
  const r = POST_R + BALL_R;
  for (const side of [-1, 1]) {
    const gx = side * (FIELD_W / 2);
    if (Math.abs(b.x - gx) > GOAL_D + 1.5) continue;
    for (const pz of [-GOAL_W / 2, GOAL_W / 2]) {
      if (b.y > GOAL_H + r) continue;
      const dx = b.x - gx, dz = b.z - pz;
      const d = Math.hypot(dx, dz);
      if (d < r && d > 1e-5) {
        const nx = dx / d, nz = dz / d;
        const vn = b.vx * nx + b.vz * nz;
        if (vn < 0) {
          b.vx -= 1.7 * vn * nx;
          b.vz -= 1.7 * vn * nz;
          hit = true;
        }
        b.x = gx + nx * r;
        b.z = pz + nz * r;
      }
    }
    if (Math.abs(b.z) < GOAL_W / 2) {
      const dx = b.x - gx, dy = b.y - GOAL_H;
      const d = Math.hypot(dx, dy);
      if (d < r && d > 1e-5) {
        const nx = dx / d, ny = dy / d;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
          b.vx -= 1.6 * vn * nx;
          b.vy -= 1.6 * vn * ny;
          hit = true;
        }
        b.x = gx + nx * r;
        b.y = GOAL_H + ny * r;
      }
    }
    // 골문 입구로 들어오면 그물 안에 가둠
    const behind = side > 0 ? b.x > gx : b.x < gx;
    if (!b.inGoal && behind && Math.abs(b.z) < GOAL_W / 2 && b.y < GOAL_H) b.inGoal = side;
    // 그물 안에 있을 때만 가둠 (골라인 밖 경기장 쪽으로 굴러 나오면 그대로 자유롭게)
    if (b.inGoal === side && side * (b.x - gx) > 0) {
      const depth = side * (b.x - gx); // 골라인에서 그물 안쪽으로 들어간 깊이
      const lim = GOAL_D - BALL_R;
      if (depth > lim) {
        // 뒷그물: 공이 그물을 밀고 들어가며 급감속 → 늘어난 그물이 살짝 되밀어냄
        const over = depth - lim;
        if (b.vx * side > 0) b.vx *= 0.66;
        b.vx -= side * over * 0.1;
        b.vz *= 0.86; b.vy *= 0.86;
        if (over > 0.75) { b.x = gx + side * (lim + 0.75); b.vx = -side * Math.abs(b.vx) * 0.3; }
      }
      const limZ = GOAL_W / 2 - BALL_R, overZ = Math.abs(b.z) - limZ;
      if (overZ > 0) {
        const sz = Math.sign(b.z);
        if (b.vz * sz > 0) b.vz *= 0.6;
        b.vz -= sz * overZ * 0.12;
        b.vx *= 0.9;
        if (overZ > 0.45) { b.z = sz * (limZ + 0.45); b.vz = -sz * Math.abs(b.vz) * 0.3; }
      }
      if (b.y > GOAL_H - BALL_R) {
        const overY = b.y - (GOAL_H - BALL_R);
        if (b.vy > 0) b.vy *= 0.5;
        b.vy -= overY * 0.15;
        b.vx *= 0.9; b.vz *= 0.9;
        if (overY > 0.4) { b.y = GOAL_H - BALL_R + 0.4; b.vy = -Math.abs(b.vy) * 0.3; }
      }
    }
  }
  return hit;
}

/** 공 1프레임 물리 (실제 진행과 궤적 미리보기에서 같은 함수 사용) */
function stepBallPhysics(b) {
  const airborne = b.y > BALL_R + 0.02;
  if (airborne) applyMagnus(b);
  if (airborne && b.knuckle) {
    b.kt = (b.kt || 0) + 1;
    const sp = Math.hypot(b.vx, b.vz);
    b.vz += Math.sin(b.kt * 0.31 + b.kph) * 0.0065 * sp;
    b.vy += Math.cos(b.kt * 0.27 + b.kph * 1.7) * 0.004 * sp;
  } else if (!airborne) b.knuckle = false;
  b.x += b.vx;
  b.z += b.vz;
  b.y += b.vy;
  b.vx *= AIR_DRAG;
  b.vz *= AIR_DRAG;
  b.vy -= GRAVITY;
  if (b.y < BALL_R) {
    b.y = BALL_R;
    b.vy *= -0.35;
    if (Math.abs(b.vy) < 0.04) b.vy = 0;
    b.vx *= ROLL_FRICTION;
    b.vz *= ROLL_FRICTION;
    // 땅에 닿으면 스핀이 마찰로 빠르게 줄어듦
    b.wx *= 0.8; b.wy *= 0.85; b.wz *= 0.8;
  }
  b.wx *= SPIN_DECAY; b.wy *= SPIN_DECAY; b.wz *= SPIN_DECAY;
  return collideGoalFrame(b);
}

const ROLL_F = AIR_DRAG * ROLL_FRICTION; // 굴러갈 때 프레임당 속도 유지율

/** 띄운 공이 정확히 d 미터 앞에 떨어지도록 속도/수직속도 계산.
 *  예전 로빙은 위로만 높이 떴는데, 이제 거리에 맞춰 낮고 빠른 포물선으로 앞으로 나감 */
function loftedLaunch(d, power = 0.5) {
  const T = clamp((19 + d * 0.72) * lerp(1.1, 0.88, power), 21, 70); // 더 높이 띄움 // 체공 프레임 (세게 찰수록 낮고 빠름)
  const vy = GRAVITY * (T - 1) / 2;
  const spd = Math.max(0.2, d) * (1 - AIR_DRAG) / (1 - Math.pow(AIR_DRAG, T));
  return { spd, vy, T };
}

/** 땅볼이 d 미터를 frames 프레임에 도착하도록 하는 초속 */
function groundPassSpeed(d, frames = null) {
  d = Math.max(0, d);
  let v;
  if (frames) v = d * (1 - ROLL_F) / (1 - Math.pow(ROLL_F, Math.max(4, frames)));
  else v = 0.13 + d * (1 - ROLL_F); // 도착할 때 0.13 정도만 남게 (부드럽게 굴러가는 패스)
  return clamp(Math.max(v, d * (1 - ROLL_F) + 0.05), 0.26, 1.0);
}

/** 로빙 패스: 받는 선수가 공이 떨어질 때 서 있을 곳(발 바로 앞)으로 */
function lobToFeet(p, t, power) {
  const moving = Math.hypot(t.vx, t.vz) > 0.04;
  let tx = t.x, tz = t.z, L = null;
  for (let i = 0; i < 3; i++) {
    const d = Math.hypot(tx - p.x, tz - p.z) - 0.9;
    L = loftedLaunch(d, power * 0.6);
    // 뛰고 있으면 공이 떨어질 때쯤의 위치 + 발 앞 0.6m
    const run = moving ? Math.min(L.T, 60) : 0;
    const [fx, fz] = norm2(t.vx || t.faceX || 0.01, t.vz || t.faceZ || 0);
    tx = t.x + t.vx * run + fx * 0.6;
    tz = t.z + t.vz * run + fz * 0.6;
  }
  // 정확도: 패스 능력·체력에 따라 아주 약간만 흔들림
  const err = (1.02 - statMul(p, 'pass')) * 2 + staminaFatigue(p) * 1.2;
  tx += (Math.random() - 0.5) * err;
  tz += (Math.random() - 0.5) * err;
  tx = clamp(tx, -FIELD_W / 2 + 1, FIELD_W / 2 - 1);
  tz = clamp(tz, -FIELD_H / 2 + 1, FIELD_H / 2 - 1);
  const sx = phase === 'setpiece' ? ball.x : p.x, sz = phase === 'setpiece' ? ball.z : p.z;
  const off = phase === 'setpiece' ? 0 : 0.9;
  const d = Math.hypot(tx - sx, tz - sz) - off;
  L = loftedLaunch(d, power * 0.6);
  // 실제 물리로 한 번 굴려 보고 낙하 거리가 정확히 맞도록 속도 보정
  let spd = L.spd;
  for (let i = 0; i < 2; i++) {
    const st = makeLaunch(0, 0, BALL_R + 0.05, 1, 0, spd, L.vy, null);
    let k = 0, air = false;
    while (k < 120) { stepBallPhysics(st); k++; if (st.y > BALL_R + 0.1) air = true; if (air && st.y <= BALL_R + 0.01) break; }
    if (st.x > 0.5) spd *= d / st.x;
  }
  return { x: tx, z: tz, spd, vy: L.vy, T: L.T };
}

function makeLaunch(ox, oz, y, dx, dz, spd, vy, spin) {
  const w = spinVector(dx, dz, spin?.side || 0, spin?.top || 0);
  return { x: ox, z: oz, y, vx: dx * spd, vz: dz * spd, vy, ...w, inGoal: 0 };
}

/** 감아차기 기본 방향: 오른발 인사이드 → 왼쪽으로 휨 (+1) */
function curlSignFor(p) {
  if (!p) return 1;
  const base = p.preferredFoot === 'left' ? -1 : 1;
  return base;
}

/** (dx,dz)로 찬 공이 (wantX,wantZ) 쪽으로 휘려면 side 부호가 무엇인지 */
function curlToward(dx, dz, wantX, wantZ) {
  return Math.sign(dz * wantX - dx * wantZ) || 1;
}

function kickFrom(owner, power, tx, tz, opts = {}) {
  const fromSet = phase === 'setpiece';
  const wasThrow = fromSet && setpiece?.type === 'throw';
  const ox = fromSet ? ball.x : owner.x;
  const oz = fromSet ? ball.z : owner.z;
  const [dx, dz] = norm2(tx - ox, tz - oz);
  const startX = fromSet ? ball.x : owner.x + dx * 0.9;
  const startZ = fromSet ? ball.z : owner.z + dz * 0.9;
  const startY = (wasThrow ? 2.0 : BALL_R) + (opts.lift || 0);
  if (opts.isShot) power *= SHOT_SPEED_SCALE; // 슛 속도 전체적으로 낮춤
  ball.knuckle = !!opts.knuckle;
  lastKickRec = recTotal;
  ball.kt = 0;
  ball.kph = Math.random() * Math.PI * 2;
  const st = makeLaunch(startX, startZ, startY, dx, dz, power, (opts.vy || 0) + (wasThrow ? 0.06 : 0), opts.spin);
  ball.owner = null;
  ball.holdByGk = null;
  Object.assign(ball, st);
  ball.lastShot = !!opts.isShot;
  ball.shotX0 = ball.x; ball.shotZ0 = ball.z; // 슛 위치 (키퍼 선방률: 먼 슛일수록 잘 막음)
  sndKick(Math.min(1.4, power / 1.3));
  if (opts.isShot && !inPens && phase !== 'setpiece') { if (opts.powerShot) comm.power(); else comm.shot(); }
  ball.netSnd = false;
  ball.oohDone = false;
  ball.throwTo = null; ball.throwTtl = 0; ball.trap = null;
  ball.airContest = undefined;
  ball.curl = opts.curl || 0;
  ball.powerShot = !!opts.powerShot;
  ball.shotTeamBlue = opts.isShot ? !!owner.isBlue : null;
  ball.blockedShot = false;
  ball.fromThrow = wasThrow || !!opts.fromThrow;
  ball.indirect = fromSet && !!setpiece?.indirect;
  ball.indirectTeam = ball.indirect ? owner.isBlue : null;
  kickCooldown = 14;
  lastToucher = owner;
  ball.loftMark = !opts.isShot && !wasThrow && (opts.vy || 0) > 0.08; // 띄운 패스 · 크로스 → 낙하지점 표시
  owner.faceX = dx;
  owner.faceZ = dz;
  owner.kickAnim = 14;
  if (owner.role === 'GK') owner.holdTicks = 0;
  if (fromSet) {
    // 프리킥: 찬 뒤에도 차기 전 카메라 화면을 그대로 유지
    fkCam = setpiece?.type === 'freekick' ? { pos: camera.position.clone(), look: camLook.clone(), t: 0, kicker: owner } : null;
    thirdPersonCam = false;
    phase = 'play';
    setpiece = null;
    setpieceHint.style.display = 'none';
    if (setpieceUi) setpieceUi.classList.remove('show');
    kickAimRing.visible = false;
    kickCone.visible = false;
    kickGuide.visible = false;
    clockPaused = inPens || fkMode;
  }
  if (inPens && penState) {
    penState.waiting = true;
    penState.shotTimer = 0;
  }
}

/** 코너/프리킥 조준 킥 파라미터 (실제 킥과 궤적 미리보기가 공유) */
function setpieceKickParams(p, action, power, preview = false) {
  const dist = action === 'lob'
    ? (16 + power * 30)
    : action === 'through'
      ? 12 + power * 16
      : action === 'shoot'
        ? 18 + power * 24
        : 10 + power * 14;
  const tx = ball.x + setAimX * dist;
  const tz = ball.z + setAimZ * dist;
  const cross = action === 'lob';
  const shot = action === 'shoot';
  let spd = clamp(dist * 0.03, 0.42, shot ? 1.35 : cross ? 1.05 : 0.95) * (cross ? 0.95 : 1);
  if (shot) spd *= 0.88 + statMul(p, 'shotPower') * 0.2;
  else spd *= (0.92 + statMul(p, 'pass') * 0.1) * 0.85;
  const top = shot ? 0.35 + power * 0.35 : 0;
  // 킥 종류에 따른 회전 (마그누스 효과로 휘거나 떨어짐)
  const kind = p.isBlue ? SET_KICKS[setKickIdx].id : 'inside';
  const foot = curlSignFor(p);              // 오른발 = +1 (왼쪽으로 휨)
  const curveK = 0.55 + statMul(p, 'curve') * 0.6; // 커브 능력이 높을수록 더 크게 휨
  let side = 0, spinTop = 0, vyAdd = 0, spdK = 1, knuckle = false;
  if (kind === 'inside') { side = foot * curveK * (0.75 + power * 0.35); spinTop = 0.25; }
  else if (kind === 'outside') { side = -foot * curveK * (0.55 + power * 0.25); spinTop = 0.2; }
  else if (kind === 'knuckle') { side = 0; spinTop = 0.05; spdK = 1.08; knuckle = true; }
  else if (kind === 'drop') { side = 0; spinTop = 1.05; vyAdd = 0.05; spdK = 0.97; }
  const loftAdj = p.isBlue ? setLoft * 0.09 : 0;
  if (cross) {
    const L = loftedLaunch(dist, power);
    return {
      tx, tz, spd: L.spd * (0.96 + statMul(p, 'pass') * 0.04) * (kind === 'knuckle' ? 1.03 : 1),
      lift: 0.05, vy: L.vy + loftAdj, isShot: false,
      spin: { side: side * 0.8, top: kind === 'drop' ? 0.5 : -0.05 }, knuckle,
    };
  }
  if (shot) {
    // 프리킥 슛: 게이지 절반 이상이면 벽(2m)을 넘고, 탑스핀으로 크로스바 아래로 떨어짐
    // 프리킥 능력이 낮을수록 조준이 조금씩 빗나감
    const fkErr = preview ? 0 : gauss() * Math.max(0, 1.0 - statMul(p, 'freekick')) * 0.06; // 미리보기 궤적엔 오차 없음 (조준점 고정)
    const ex = tx - ball.x, ez = tz - ball.z, ce = Math.cos(fkErr), se = Math.sin(fkErr);
    return {
      tx: ball.x + ex * ce - ez * se, tz: ball.z + ex * se + ez * ce,
      spd: lerp(0.95, 1.35, power) * (0.88 + statMul(p, 'shotPower') * 0.2) * spdK,
      lift: 0.12,
      vy: lerp(0.2, 0.42, power) + vyAdd + loftAdj,
      isShot: true,
      spin: { side, top: 0.5 + power * 0.5 + spinTop - 0.25 },
      knuckle,
      curl: Math.min(1, Math.abs(side) * statMul(p, 'curve')),
    };
  }
  return {
    tx, tz, spd,
    lift: 0,
    vy: 0,
    isShot: false,
    spin: { side: 0, top },
  };
}

function fkRating(p) {
  return Math.round((statMul(p, 'freekick') * 0.6 + statMul(p, 'curve') * 0.25 + statMul(p, 'shotPower') * 0.15) * 100);
}
/** 게이지(0~1) → 골라인에서의 공 높이. 0.88 넘게 누르면 크로스바 위로 */
function penHeight(power) {
  if (power <= 0.88) return lerp(0.15, 2.2, power / 0.88);
  return 2.2 + (power - 0.88) * 9;
}
function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) / 0.5; }

/** 페널티킥: 조준한 곳(좌우) + 게이지(높이)로 정확히 날아가되, 골 결정력이 낮을수록 / 구석·높게 찰수록 오차가 커짐 */
let penRun = null;
let penCam = null; // 승부차기 카메라 기준점 (공을 찬 뒤에도 화면이 안 바뀌게)
/** 슛 키를 떼면 키커가 공까지 몇 걸음 달려와서 찬다 */
function startPenRun(p, power, aimZ) {
  if (penRun) return;
  const gs = p.isBlue ? 1 : -1;
  penRun = {
    p, power, aimZ, t: 0, T: 30, // 도움닫기 (빠르게)
    fx: p.x, fz: p.z,
    tx: ball.x - gs * 0.75, tz: ball.z + gs * 0.3,
  };
  runRec = recTotal;
}
/** 키퍼는 등 뒤(자기 골문)를 돌아보지 않음 · 골이 들어간 뒤엔 정면(경기장 쪽)을 봄 */
function keepersFaceForward() {
  for (const p of allPlayers()) {
    if (p.role !== 'GK' || p.sentOff) continue;
    const out = p.isBlue ? 1 : -1;
    // 다이빙 중: 뛰는 순간의 방향으로 몸을 고정 (공을 따라 몸이 돌아가지 않음)
    if (p.dive > 0) {
      if (!p.diveFace) {
        let fx = p.faceX, fz = p.faceZ;
        if (fx * out < 0.6) { fx = out * 0.6; fz = Math.sign(fz || 1) * 0.8; }
        p.diveFace = norm2(fx, fz);
      }
      [p.faceX, p.faceZ] = p.diveFace;
      continue;
    }
    p.diveFace = null;
    if (p === getActive() && p.isBlue && !inPens) continue;
    if (ball.owner === p || ball.holdByGk === p) continue;
    const ownGoalNear = Math.abs(p.x) > FIELD_W / 2 - 20;
    if (!ownGoalNear) continue;
    if (phase === 'goal_pause' || ball.inGoal) {
      [p.faceX, p.faceZ] = turnToward(p.faceX || out, p.faceZ || 0, out, 0, 0.12);
    } else if (p.faceX * out < 0.55) {
      // 공이 등 뒤로 가도 골문 쪽을 돌아보지 않고 앞을 본 채로 (뒷걸음질)
      [p.faceX, p.faceZ] = norm2(out * 0.55, Math.sign(p.faceZ || 1) * 0.835);
    }
  }
}
/** 프리킥 도움닫기: 몇 걸음 달려와 발이 공에 닿는 순간 킥 */
function startFkRun(p, k) {
  const [dx, dz] = norm2(k.tx - ball.x, k.tz - ball.z);
  const side = p.foot === 'left' ? 1 : -1;
  fkRun = {
    p, k, t: 0, T: 38, fx: p.x, fz: p.z,
    // 디딤발 자리: 공 바로 뒤 옆
    tx: ball.x - dx * 0.7 - dz * side * 0.32, tz: ball.z - dz * 0.7 + dx * side * 0.32,
  };
  runRec = recTotal;
}
function updateFkRun() {
  if (!fkRun) return;
  if (phase !== 'setpiece' || setpiece?.type !== 'freekick') { fkRun = null; return; }
  const r = fkRun;
  r.t++;
  const k = Math.min(1, r.t / r.T);
  const e = k * k * (3 - 2 * k) * 0.35 + k * 0.65;
  const nx = lerp(r.fx, r.tx, e), nz = lerp(r.fz, r.tz, e);
  r.p.vx = nx - r.p.x; r.p.vz = nz - r.p.z;
  r.p.x = nx; r.p.z = nz;
  [r.p.faceX, r.p.faceZ] = norm2(ball.x - r.p.x, ball.z - r.p.z);
  if (r.t === r.T - 7) r.p.kickAnim = 14;
  if (r.t >= r.T) {
    fkRun = null;
    runKickRec = recTotal;
    kickFrom(r.p, r.k.spd, r.k.tx, r.k.tz, r.k);
    if (r.k.isShot) stats.shots[0]++;
    else stats.passes[0]++;
    pendingReceiver = null;
  }
}
function updatePenRun() {
  if (!penRun) return;
  if (phase !== 'setpiece' || setpiece?.type !== 'penalty') { penRun = null; return; }
  const r = penRun;
  r.t++;
  const k = Math.min(1, r.t / r.T);
  const e = k * k * (3 - 2 * k) * 0.25 + k * 0.75; // 살짝 가속하며 달려옴
  const nx = lerp(r.fx, r.tx, e), nz = lerp(r.fz, r.tz, e);
  r.p.vx = nx - r.p.x;
  r.p.vz = nz - r.p.z;
  r.p.x = nx; r.p.z = nz;
  [r.p.faceX, r.p.faceZ] = norm2(ball.x - r.p.x + (r.p.isBlue ? 0.6 : -0.6), ball.z - r.p.z);
  if (r.t === r.T - 7) r.p.kickAnim = 14; // 다리를 뒤로 뺐다가
  if (r.t >= r.T) {                       // 발이 공에 닿는 순간 슛
    penRun = null;
    runKickRec = recTotal;
    penaltyShot(r.p, r.power, r.aimZ);
  }
}

function userGkInPens() {
  if (!inPens || !penState || penState.kickerBlue) return null;
  const gk = teamA.find(p => p.role === 'GK' && !p.sentOff);
  return gk && teamA[activeIdx] === gk ? gk : null;
}
/** 키퍼 조작: ←→ 골라인 따라 이동(화면 기준), D 다이빙(방향키 누른 쪽, 없으면 제자리 점프) */
function userPenGk(p) {
  const gs = penCam ? penCam.gs : -1;         // 키커가 차는 방향
  const lineX = gs * (FIELD_W / 2 - 0.3);
  const scr = keys.ArrowLeft ? -1 : keys.ArrowRight ? 1 : 0;
  const worldZ = scr * gs;                    // 키커 뒤 카메라 기준 오른쪽 = gs * +z
  if (p.dive > 0) {
    p.z = lerp(p.z, clamp(p.diveZ, -GOAL_W / 2 - 0.5, GOAL_W / 2 + 0.5), 0.16);
    const prog = 1 - p.dive / 40;
    p.jumpY = Math.max(0, Math.sin(Math.PI * clamp(prog * 1.4, 0, 1)) * (p.diveHigh ? 0.8 : 0.35));
    const reachH = p.diveHigh ? 2.8 : 2.1;
    if (p.userSave && !ball.owner && !ball.holdByGk && ball.lastShot && dist2(p, ball) < (ball.y < 0.7 ? 1.55 : 1.3) && ball.y < reachH) {
      p.userSave = false;
      executeSave(p);
    }
  } else {
    // 골문을 세로 4칸으로 나눴을 때 2~3번째 칸(가운데 절반) 안에서만 이동
    if (!p.diveUsed) p.z = clamp(p.z + worldZ * 0.055 * realK(), -GOAL_W / 4, GOAL_W / 4);
    p.jumpY = 0;
    // 다이빙 안 해도 몸 근처로 오는 공은 자동으로 잡거나 쳐냄
    if (!p.autoSaved && !ball.owner && !ball.holdByGk && ball.lastShot && dist2(p, ball) < (ball.y < 0.7 ? 1.45 : 1.25) && ball.y < 2.3) { // 손 + 발
      p.autoSaved = true;
      executeSave(p);
    }
  }
  p.x = lineX;
  p.faceX = -gs; p.faceZ = 0;
  p.vx = 0; p.vz = 0;
  if (setpiece?.type === 'penalty') setpiece.gkZ = p.z;
}
function userGkDive() {
  const p = userGkInPens();
  if (!p || p.dive > 0 || p.diveUsed) return;
  if (phase !== 'play' || !ball.lastShot) return; // 키커가 공을 찬 뒤에만 다이빙 가능
  const gs = penCam ? penCam.gs : -1;
  const scr = keys.ArrowLeft ? -1 : keys.ArrowRight ? 1 : 0;
  const dz = scr * gs;
  p.dive = 40;
  p.diveUsed = true;
  p.diveZ = dz ? clamp(p.z + dz * 3.3, -GOAL_W / 2 - 0.4, GOAL_W / 2 + 0.4) : p.z;
  p.diveDir = dz ? Math.sign((p.diveZ - p.z) * (p.isBlue ? 1 : -1)) : 0;
  p.diveHigh = !dz || keys.ArrowUp;
  p.userSave = true;
}

function penaltyShot(p, power, aimZ) {
  const goalSign = p.isBlue ? 1 : -1;
  const goalX = goalSign * FIELD_W / 2;
  const fin = statMul(p, 'penalty') * 0.65 + statMul(p, 'finishing') * 0.35; // 페널티 정확도
  let h = penHeight(power);
  let sd = 0.1 + Math.max(0, 1 - fin) * 3.2 + staminaFatigue(p) * 0.4;
  if (Math.abs(aimZ) > GOAL_W / 2 - 0.7) sd += 0.28;  // 구석을 노리면 빗나갈 위험
  if (h > 1.8) sd += 0.18;                             // 높게 차면 위험
  const tz = aimZ + gauss() * sd;
  const ty = Math.max(BALL_R + 0.05, h + gauss() * sd * 0.6);
  // 공이 골라인에 ty 높이로 도착하도록 수직 속도 계산 (공기저항 반영)
  const D = Math.hypot(goalX - ball.x, tz - ball.z);
  const v = lerp(1.0, 1.42, power) * (0.88 + statMul(p, 'shotPower') * 0.2) * (inPens ? 0.85 : 1); // 승부차기는 공을 보고 반응할 수 있게 살짝 느리게
  const frac = D * (1 - AIR_DRAG) / v;
  const T = frac < 0.95 ? Math.log(1 - frac) / Math.log(AIR_DRAG) : D / v;
  const vy = (ty - BALL_R + GRAVITY * T * (T - 1) / 2) / T;
  [p.faceX, p.faceZ] = norm2(goalX - p.x, tz - p.z);
  kickFrom(p, v / SHOT_SPEED_SCALE, goalX, tz, { vy, isShot: true });
  p.kickAnim = Math.max(p.kickAnim, 7);
  // 키퍼: 반응속도만큼 늦게, 맞히거나 틀린 쪽으로 몸을 날림
  const gk = fieldPlayers(p.isBlue ? teamB : teamA).find(o => o.role === 'GK');
  if (gk && gk !== userGkInPens()) {
    const react = statMul(gk, 'reaction');
    const readIt = Math.random() < clamp(0.12 + react * 0.3 + (1 - fin) * 0.3, 0.15, 0.6); // 실제 키퍼도 반쯤은 방향을 못 읽음
    const stay = Math.random() < 0.12;
    const side = readIt ? Math.sign(tz || 1) : (Math.random() < 0.5 ? -1 : 1);
    gk.penDive = { delay: 4 + Math.floor((1.1 - react) * 10), z: stay ? 0 : side * (1.6 + Math.random() * 1.6), high: ty > 1.4 };
  }
  stats.shots[p.isBlue ? 0 : 1]++;
  pendingReceiver = null;
}

function changeKicker() {
  if (!setpiece || !setpiece.teamBlue || charge.action) return;
  const cur = setpiece.taker;
  const cands = teamA.filter(p => p.role !== 'GK' && (!p.sentOff || fkMode) && !p.redCard)
    .sort((a, b) => fkRating(b) - fkRating(a) || a.num - b.num);
  if (cands.length < 2) return;
  const next = cands[(cands.indexOf(cur) + 1) % cands.length];
  if (!next || next === cur) return;
  if (fkMode) fkState.kicker = teamA.indexOf(next);
  const tx = cur.x, tz = cur.z, fx = cur.faceX, fz = cur.faceZ;
  if (fkMode) {
    next.sentOff = false;
    next.mesh.visible = true;
    cur.sentOff = true;
    cur.mesh.visible = false;
    cur.x = -FIELD_W / 2 - 20;
  } else {
    cur.x = tx - fx * 2.5 + fz * 2;
    cur.z = tz - fz * 2.5 - fx * 2;
  }
  next.x = tx; next.z = tz; next.faceX = fx; next.faceZ = fz; next.vx = next.vz = 0;
  setpiece.taker = next;
  ball.owner = next;
  activeIdx = teamA.indexOf(next);
}

// =====================================================================
//  공통 패스 시스템
//  짧은 패스 · 긴 패스 · 로빙(크로스) · 스루 · 로빙 스루 모두 doPass() 하나를 거침
//  (사람 · AI 공통). 종류별로 '받을 선수 고르기 · 목표 지점 · 공 궤적 · 정확도'만 다름
// =====================================================================
/** 조정값 — 개발자 그라운드에서 실시간으로 바꿀 수 있음 */
const TUNE = {
  short: { gMin: 5, gMax: 34, arrive: 0, minSpd: 0.5, err: 0.12, errPerM: 0.01 },
  long: { gMin: 14, gMax: 58, minD: 14, maxD: 62, arrive: 0, minSpd: 0.75, err: 0.28, errPerM: 0.022, lead: 2.6, maxSpd: 1.2, cone: 0.35 },
  lob: { gMin: 8, gMax: 55, minD: 8, maxD: 55, apex: 2.6, err: 0.3, errPerM: 0.02, cone: 0.3 },
  cross: { gMin: 12, gMax: 50, apex: 2.4, err: 0.4, errPerM: 0.02 },
  through: { gMin: 8, gMax: 42, err: 0.25, errPerM: 0.015, cone: 0.25 },
  lobThrough: { gMin: 12, gMax: 55, apex: 3.6, err: 0.4, errPerM: 0.025, beyond: 4, cone: 0.25 },
  moveErr: 0.6,   // 패스하는 선수가 빠를수록 오차 (전력질주 = +60%)
  dirErr: 0.5,    // 입력 방향과 실제 패스 방향이 어긋날수록 오차
  aiErr: 1.0,     // AI 오차 배율
  tackle: { standReach: 1.05, slideReach: 1.75, standBase: 0.5, slideBase: 0.56, front: 0.12, sideMul: 0.72, backMul: 0.25, shieldMul: 0.75, alignW: 0.35, standCd: 40, slideCd: 75, slideStun: 30, standT: 12, slideT: 26 },
  claimLock: 6,
  gk: { react: 1, reactStat: 7, readErr: 0.55, standReach: 0.95, stepSpd: 0.08, diveSpd: 0.2, diveMax: 2.6, diveArm: 1.15, closeT: 9, jumpH: 0.55, saveBase: 0.84, edgeLoss: 0.55, speedLoss: 0.3, farFrom: 14, farSpan: 14, farSave: 0.3, farReach: 0.22, nearTo: 12, nearLoss: 0.35 },   // 소유권이 바뀐 뒤 다른 선수가 다시 뺏을 수 없는 프레임
  shot: { lowY: 0.35, inMax: 0.7, highY: 2.05, barMax: 0.75, barY: 2.6, overK: 18 }, // 일반 슛(D) 높이: 게이지 → 골라인 높이
  gauge: { charge: CHARGE_FRAMES, pshot: PSHOT_FRAMES, y1: 0.12, g1: 0.46, g2: 0.66, y2: 0.72 }, // 게이지: 가득 차는 프레임 · 파워슛 초록/노랑 구간 폭
};
let passSeq = 0;
/** 점 (px,pz)와 선분 (ax,az)-(bx,bz) 사이 거리 */
function segPointDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
  const t = L > 1e-9 ? clamp(((px - ax) * dx + (pz - az) * dz) / L, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}
let onGameEvent = null; // 개발자 그라운드가 연결
const gameEvents = [];
let lastPossTeam = null, nextTouchCause = null;
function emitEvent(type, data = {}) {
  const e = { type, t: Math.round(simTime), ...data };
  gameEvents.push(e);
  if (gameEvents.length > 300) gameEvents.shift();
  if (typeof onGameEvent === 'function') onGameEvent(e);
}
const PASS_NAME = { short: '짧은 패스', long: '긴 패스', lob: '로빙 패스', cross: '크로스', through: '스루패스', lobThrough: '로빙 스루패스' };
const pname2 = p => p ? `${p.isBlue ? '블루' : '상대'} ${p.num}번 ${p.label}` : '-';

/** 패스 방향: 방향키 > 조작 선수가 움직이는 방향 > 바라보는 방향 */
function passDir(p, useInput = true) {
  const [ix, iz] = useInput && p.isBlue ? getInputDir() : [0, 0];
  if (ix || iz) return { dir: [ix, iz], input: true };
  if (Math.hypot(p.vx, p.vz) > 0.03) return { dir: norm2(p.vx, p.vz), input: false };
  return { dir: norm2(p.faceX || (p.isBlue ? 1 : -1), p.faceZ || 0), input: false };
}
const openness = (t, passerBlue) => Math.min(nearestOppDist(t.x, t.z, passerBlue), 10);
const fwdSpeed = (t, atk) => t.vx * atk;

/** 받을 선수 고르기 (종류마다 점수 기준이 다름) */
function selectPassTarget(p, kind, dir, hasInput) {
  const atk = p.isBlue ? 1 : -1;
  const goalX = atk * FIELD_W / 2;
  const line = offsideLineX(p.isBlue);
  const flank = Math.abs(p.z) > 13 && (goalX - p.x) * atk < 30;
  let best = null, bs = -Infinity;
  const cfg = TUNE[kind === 'cross' ? 'lob' : kind];
  for (const t of (p.isBlue ? teamA : teamB)) {
    if (t === p || t.sentOff) continue;
    const isGk = t.role === 'GK';
    const d = dist2(p, t);
    const [ux, uz] = norm2(t.x - p.x, t.z - p.z);
    const dot = ux * dir[0] + uz * dir[1];
    if (isGk) { // 키퍼에게는 짧은/긴 패스로, 방향키로 키퍼를 정확히 가리킬 때만
      if (!hasInput || (kind !== 'short' && kind !== 'long') || dot < 0.8) continue;
    }
    if (kind === 'short' ? hasInput && dot < 0.05 : dot < (cfg?.cone ?? 0.25)) continue;
    const open = openness(t, p.isBlue);
    const prog = (t.x - p.x) * atk;
    let s;
    if (kind === 'short') {
      // 짧은 패스(S): 예전처럼 거리 제한 없이 방향키 쪽 동료에게 (뒤로 돌리는 먼 패스도 가능)
      const vision = statMul(p, 'vision');
      if (d < 1.5 || d > 48 + vision * 22) continue;
      s = 80 - d * (1.05 - vision * 0.25) + (hasInput ? dot * (48 + vision * 12) : (t.x - p.x) * atk * 0.45 + 25 / (d + 1) + vision * 8);
    } else if (kind === 'long') {
      if (d < TUNE.long.minD || d > TUNE.long.maxD) continue;
      s = dot * 55 + d * 0.6 + open * 2.2 + prog * 0.3;
    } else if (kind === 'lob' || kind === 'cross') {
      if (d < TUNE.lob.minD || d > TUNE.lob.maxD) continue;
      s = dot * 50 + open * 2.5 - Math.abs(d - 25) * 0.3;
      if (flank && inPenaltyBox(t.x, t.z, !p.isBlue)) s += 45; // 측면 → 박스 안 공격수 우선
    } else if (kind === 'through' || kind === 'lobThrough') {
      if (isGk || d < 4 || d > 55) continue;
      if (prog < -3 && !(hasInput && dir[0] * atk < 0)) continue;
      const run = Math.max(0, fwdSpeed(t, atk));          // 앞으로 침투하는 속도
      const ahead = nearestOppDistAhead(t, atk);            // 앞쪽 빈 공간
      s = dot * 40 + run * 140 + Math.min(ahead, 14) * 1.6 + (t.role === 'ST' || t.role === 'WG' ? 10 : 0) - d * 0.25;
      if (kind === 'lobThrough') {
        const toLine = (line - t.x) * atk;                  // 수비 라인까지 거리 (+ = 라인이 앞에)
        s += toLine > -2 && toLine < 14 ? 25 - toLine : -10; // 라인 바로 앞에서 뛰어드는 선수
      }
    } else continue;
    if (s > bs) { bs = s; best = t; }
  }
  return best;
}
/** t 앞쪽(공격 방향 반원)에서 가장 가까운 상대까지 거리 */
function nearestOppDistAhead(t, atk) {
  let best = 30;
  for (const o of fieldPlayers(t.isBlue ? teamB : teamA)) {
    if ((o.x - t.x) * atk < -1) continue;
    best = Math.min(best, Math.hypot(o.x - t.x, o.z - t.z));
  }
  return best;
}

/** 땅볼: 초속 v0로 d m 가는 데 걸리는 프레임 */
function groundFrames(d, v0) {
  const k = 1 - d * (1 - ROLL_F) / v0;
  return k <= 0.02 ? 999 : Math.log(k) / Math.log(ROLL_F);
}
/** 땅볼: d m 지점에서 속도가 arrive가 되는 초속 (도착 직전 자연스럽게 감속) */
const groundV0 = (d, arrive) => Math.max(0, d) * (1 - ROLL_F) + arrive;
// 짧은 패스 최고 속도: 가까우면 0.95, 먼 동료(뒤로 돌리는 패스 등)는 닿을 만큼 더 세게 (최대 1.6)
/** 땅볼이 d(m) 굴러가서 멈추게 하는 출발 속도 — 실제 공 물리로 계산 (이분 탐색) */
const _rollMemo = new Map();
function rollDist(v0) {
  // 골대와 안 부딪히게 중앙선(x=0)을 따라 z 방향으로 굴려 봄
  const b = { x: 0, z: 0, y: BALL_R, vx: 0, vz: v0, vy: 0, wx: 0, wy: 0, wz: 0, knuckle: false };
  for (let i = 0; i < 900; i++) { stepBallPhysics(b); if (Math.abs(b.vz) < 0.01) break; }
  return b.z;
}
function rollV0(d) {
  const key = Math.round(d * 4);
  if (_rollMemo.has(key)) return _rollMemo.get(key);
  let lo = 0.05, hi = 4;
  for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (rollDist(m) < d) lo = m; else hi = m; }
  _rollMemo.set(key, hi);
  return hi;
}
// 유저 패스 게이지 → 거리(m): [게이지 0일 때, 가득일 때]
const PASS_GAUGE = new Proxy({}, { get: (_, k) => TUNE[k] && TUNE[k].gMax ? [TUNE[k].gMin, TUNE[k].gMax] : undefined }); // 조정값(TUNE)의 gMin~gMax
const shortCap = d => Math.max(0.95, Math.min(1.6, groundV0(d, 0.15)));

/** 띄운 공: (sx,sz)에서 (tx,tz)에 떨어지게. 정점 높이 apex 이상, 체공 T0 이상. 실제 물리로 보정 */
function loftTo(sx, sz, tx, tz, apex, T0 = 0) {
  const d = Math.max(0.5, Math.hypot(tx - sx, tz - sz));
  const vyMin = Math.sqrt(2 * GRAVITY * apex);
  const T = Math.max(T0, 2 * vyMin / GRAVITY + 1);
  const vy = GRAVITY * (T - 1) / 2;
  let spd = d * (1 - AIR_DRAG) / (1 - Math.pow(AIR_DRAG, T));
  for (let i = 0; i < 2; i++) {
    const st = makeLaunch(0, 0, BALL_R + 0.05, 1, 0, spd, vy, null);
    let k = 0, air = false;
    while (k < 160) { stepBallPhysics(st); k++; if (st.y > BALL_R + 0.1) air = true; if (air && st.y <= BALL_R + 0.01) break; }
    if (st.x > 0.5) spd *= d / st.x;
  }
  return { spd, vy, T };
}

/** 정확도: 종류 기본값 + 거리 · 패스 능력 · 이동 속도 · 방향 정확도 · 체력 */
/** 패스 종류별로 쓰는 능력치 (능력치 설명 기준)
 *  짧은 패스 = 짧은 패스 · 긴 패스/로빙 = 긴 패스 · 크로스 = 크로스 · 스루 = 시야 + 짧은 패스 · 로빙 스루 = 시야 + 긴 패스 */
function passSkill(p, kind) {
  const m = k => statMul(p, k);
  switch (kind) {
    case 'short': return m('shortPass') * 0.8 + m('vision') * 0.2;
    case 'long': case 'lob': return m('longPass') * 0.8 + m('vision') * 0.2;
    case 'cross': return m('crossing') * 0.85 + m('curve') * 0.15;
    case 'through': return m('vision') * 0.55 + m('shortPass') * 0.45;
    case 'lobThrough': return m('vision') * 0.5 + m('longPass') * 0.5;
    default: return m('pass');
  }
}
function passError(p, kind, d, align, power, aiExtra = 0) {
  const c = TUNE[kind];
  const skill = clamp(1.35 - passSkill(p, kind) * 0.6, 0.55, 1.4);
  const mv = 1 + TUNE.moveErr * clamp(Math.hypot(p.vx, p.vz) / SPRINT, 0, 1.2);
  const dirK = 1 + TUNE.dirErr * (1 - clamp(align, 0, 1));
  const fat = 1 + staminaFatigue(p) * 1.5;
  const over = power > 0.92 ? 1 + (power - 0.92) * 20 : 1; // 너무 세게 = 크게 빗나감
  return (c.err + d * c.errPerM) * skill * mv * dirK * fat * over * (1 + aiExtra);
}
function jitter(x, z, dx, dz, amp) {
  const lat = (Math.random() - 0.5) * 2 * amp, lon = (Math.random() - 0.5) * 1.4 * amp;
  return { x: x - dz * lat + dx * lon, z: z + dx * lat + dz * lon };
}
const inField = (x, z, m = 1) => ({ x: clamp(x, -FIELD_W / 2 + m, FIELD_W / 2 - m), z: clamp(z, -FIELD_H / 2 + m, FIELD_H / 2 - m) });

/** 받는 선수가 공이 도착할 때 있을 곳 (현재 위치 + 속도 × 시간, 발 앞 0.6m) */
function predictAt(t, frames, k = 0.45, maxLead = 3) {
  // 받는 선수는 공을 향해 마중 나오므로 미래 위치는 일부만 반영 (너무 앞에 주면 상대가 먼저 닿음)
  let lx = t.vx * Math.min(frames, 90) * k, lz = t.vz * Math.min(frames, 90) * k;
  const L = Math.hypot(lx, lz);
  if (L > maxLead) { lx *= maxLead / L; lz *= maxLead / L; }
  const [fx, fz] = norm2(t.vx || t.faceX || 0.01, t.vz || t.faceZ || 0);
  return { x: t.x + lx + fx * 0.6, z: t.z + lz + fz * 0.6 };
}

/** 로빙 스루: 수비 라인 뒤, 공격수가 달려가 공 낙하 시점에 닿을 곳 */
function lobThroughPoint(p, t, inputDir) {
  const atk = p.isBlue ? 1 : -1;
  const goalX = atk * FIELD_W / 2;
  const line = offsideLineX(p.isBlue);
  const runSpd = SPRINT * 0.92 * statMul(t, 'speed');
  let [rx, rz] = Math.hypot(t.vx, t.vz) > 0.05 && t.vx * atk > 0 ? norm2(t.vx, t.vz) : [atk, 0];
  if (inputDir) { rx = rx * 0.6 + inputDir[0] * 0.4; rz = rz * 0.6 + inputDir[1] * 0.4; [rx, rz] = norm2(rx, rz); }
  if (rx * atk < 0.35) { rx = atk * 0.35; [rx, rz] = norm2(rx, rz); } // 앞으로는 가야 함
  let best = null, bs = -Infinity;
  for (let L = 5; L <= 30; L += 1) {
    const q = inField(t.x + rx * L, t.z + rz * L, 3);
    q.x = atk > 0 ? Math.min(q.x, goalX - 7) : Math.max(q.x, goalX + 7); // 키퍼 품으로 바로 가지 않게
    const fl = loftTo(p.x, p.z, q.x, q.z, TUNE.lobThrough.apex);
    const runT = Math.max(0, Math.hypot(q.x - t.x, q.z - t.z) - 1) / runSpd;
    let oppT = Infinity;
    for (const o of fieldPlayers(p.isBlue ? teamB : teamA)) {
      const os = (o.role === 'GK' ? SPRINT * 0.8 : SPRINT * 0.85) * statMul(o, 'speed');
      oppT = Math.min(oppT, Math.max(0, Math.hypot(o.x - q.x, o.z - q.z) - 1.2) / os);
    }
    const beyond = (q.x - line) * atk;
    let s = -Math.abs(fl.T + 4 - runT) * 1.2;           // 공 낙하와 공격수 도착을 맞춤
    s += Math.min(oppT - runT, 30) * 0.8;                // 수비보다 먼저
    s += beyond >= TUNE.lobThrough.beyond ? 12 : beyond * 2; // 라인 뒤 공간
    if (s > bs) { bs = s; best = { x: q.x, z: q.z, T: fl.T, runFrames: runT }; }
  }
  return best;
}

/**
 * 공통 패스 실행. kind: short | long | lob | cross | through | lobThrough
 * opts.target: 받을 선수를 이미 정한 경우 (AI) · opts.lead: 스루 목표 (AI)
 * 반환: 받을 선수 (못 하면 null)
 */
function doPass(p, kind, power = 0.5, opts = {}) {
  if (!p || p.sentOff) return null;
  const hasBall = ball.owner === p || ball.holdByGk === p || (phase === 'setpiece' && setpiece?.taker === p);
  if (!hasBall) return null; // 1. 공을 가진 선수만
  const isUser = p.isBlue && !opts.target;
  const { dir, input } = passDir(p, isUser);
  const atk = p.isBlue ? 1 : -1;
  const goalX = atk * FIELD_W / 2;
  if (kind === 'lob' && !opts.target && Math.abs(p.z) > 13 && (goalX - p.x) * atk < 30) kind = 'cross';
  let t = opts.target || selectPassTarget(p, kind, dir, input);
  if (!t && (kind === 'through' || kind === 'lobThrough')) t = selectPassTarget(p, kind, [atk, 0], false); // 앞쪽 침투 선수
  if (!t && kind === 'long') t = selectPassTarget(p, 'short', dir, input);
  if (!t && !opts.target) t = selectPassTarget(p, 'short', dir, false) || nearestTeammate(p, p.isBlue ? teamA : teamB);
  if (!t) return null;
  if (phase === 'play' && isOffsideAtPass(p, t)) { callOffside(p, t); return null; }

  const sx = phase === 'setpiece' ? ball.x : p.x, sz = phase === 'setpiece' ? ball.z : p.z;
  const off = phase === 'setpiece' ? 0 : 0.9;
  const aiExtra = p.isBlue && !isUser ? 0 : (!p.isBlue ? dumb(p) * 1.6 * TUNE.aiErr : 0);
  let aim, kick, landT = 0, runTarget = null;
  // 띄운 공은 발 앞 0.9m에서 출발하므로 그만큼 빼고 계산 (낙하지점이 밀리지 않게)
  const Lf = (tx, tz, apex, T0 = 0) => { const [dx, dz] = norm2(tx - sx, tz - sz); return loftTo(sx + dx * off, sz + dz * off, tx, tz, apex, T0); };

  if (kind === 'short' || kind === 'long') {
    const c = TUNE[kind];
    const arrive = c.arrive;
    let a = { x: t.x, z: t.z }, v0 = 0.3, n = 20;
    for (let i = 0; i < 3; i++) {
      a = predictAt(t, n);
      if (kind === 'long') { // 긴 패스: 받는 선수 앞 빈 공간까지 활용
        const mv = Math.hypot(t.vx, t.vz) > 0.05;
        let [lx, lz] = mv ? norm2(t.vx, t.vz) : norm2(atk + (t.z - nearestOppZ(t)) * 0.02, 0);
        a.x += lx * c.lead; a.z += lz * c.lead;
      }
      const d = Math.hypot(a.x - sx, a.z - sz) - off;
      v0 = clamp(groundV0(d, arrive), c.minSpd, kind === 'long' ? c.maxSpd : shortCap(d));
      n = groundFrames(d, v0);
      if (n > 200) n = 200;
    }
    const d = Math.hypot(a.x - sx, a.z - sz);
    const [dx, dz] = norm2(a.x - sx, a.z - sz);
    const align = input ? dx * dir[0] + dz * dir[1] : 0.8;
    aim = inField(...Object.values(jitter(a.x, a.z, dx, dz, passError(p, kind, d, align, power, aiExtra))), 0.6);
    const d2 = Math.hypot(aim.x - sx, aim.z - sz) - off;
    // 가까워도 너무 느리지 않게 최소 출발 속도 · 게이지(세기)와 패스 능력치만큼 빠르게
    v0 = clamp(groundV0(d2, arrive), c.minSpd, 9) * lerp(0.92, 1.1, power) * (0.9 + passSkill(p, kind) * 0.12);
    v0 = Math.min(v0, kind === 'long' ? c.maxSpd : shortCap(d2));
    kick = [v0, aim.x, aim.z, {}];
  } else if (kind === 'lob') {
    const lob = lobToFeet(p, t, power);
    const fl = Lf(lob.x, lob.z, TUNE.lob.apex, lob.T);
    const [dx, dz] = norm2(lob.x - sx, lob.z - sz);
    aim = inField(...Object.values(jitter(lob.x, lob.z, dx, dz, passError(p, 'lob', Math.hypot(lob.x - sx, lob.z - sz), input ? dx * dir[0] + dz * dir[1] : 0.8, power, aiExtra))));
    const f2 = Lf(aim.x, aim.z, TUNE.lob.apex, lob.T * clamp(1.12 - passSkill(p, 'lob') * 0.15, 0.9, 1.1));
    kick = [f2.spd, aim.x, aim.z, { lift: 0.05, vy: f2.vy }]; landT = f2.T;
  } else if (kind === 'cross') {
    // 박스 안 공격수가 공 떨어질 때 있을 곳 (골 쪽으로 살짝 앞)
    let a = { x: t.x, z: t.z }, T = 40;
    for (let i = 0; i < 3; i++) {
      a = predictAt(t, T, 0.8, 7);
      a.x += atk * 1.2;
      const fl = Lf(a.x, a.z, TUNE.cross.apex, 24 + Math.hypot(a.x - sx, a.z - sz) * 0.45);
      T = fl.T;
    }
    const [dx, dz] = norm2(a.x - sx, a.z - sz);
    aim = inField(...Object.values(jitter(a.x, a.z, dx, dz, passError(p, 'cross', Math.hypot(a.x - sx, a.z - sz), input ? dx * dir[0] + dz * dir[1] : 0.8, power, aiExtra))));
    const f2 = Lf(aim.x, aim.z, TUNE.cross.apex, 24 + Math.hypot(aim.x - sx, aim.z - sz) * 0.45);
    kick = [f2.spd, aim.x, aim.z, { lift: 0.05, vy: f2.vy }]; landT = f2.T;
  } else if (kind === 'through') {
    const lead = opts.lead || throughLeadPoint(p, t, power, input ? dir : [0, 0]);
    const [dx, dz] = norm2(lead.x - sx, lead.z - sz);
    const d = Math.hypot(lead.x - sx, lead.z - sz);
    aim = inField(...Object.values(jitter(lead.x, lead.z, dx, dz, passError(p, 'through', d, input ? dx * dir[0] + dz * dir[1] : 0.8, Math.min(power, 0.9), aiExtra))), 2);
    const spd = groundPassSpeed(Math.hypot(aim.x - sx, aim.z - sz) - off, lead.runFrames + 8) * (0.96 + statMul(p, 'pass') * 0.04);
    kick = [spd, aim.x, aim.z, {}];
    runTarget = { x: lead.x, z: lead.z, ttl: Math.ceil(lead.runFrames + 40) };
  } else if (kind === 'lobThrough') {
    const q = lobThroughPoint(p, t, input ? dir : null);
    if (!q) return null;
    const [dx, dz] = norm2(q.x - sx, q.z - sz);
    aim = inField(...Object.values(jitter(q.x, q.z, dx, dz, passError(p, 'lobThrough', Math.hypot(q.x - sx, q.z - sz), input ? dx * dir[0] + dz * dir[1] : 0.8, power, aiExtra))), 2);
    const f2 = Lf(aim.x, aim.z, TUNE.lobThrough.apex);
    kick = [f2.spd, aim.x, aim.z, { lift: 0.05, vy: f2.vy }]; landT = f2.T;
    runTarget = { x: q.x, z: q.z, ttl: Math.ceil(q.T + 40) };
  } else return null;

  // 유저 패스: 세기와 거리는 받는 선수까지의 거리가 아니라 '게이지'로 정함 (방향만 받는 선수 쪽)
  if (isUser && phase === 'play' && PASS_GAUGE[kind]) {
    const [g0, g1] = PASS_GAUGE[kind];
    let dg = lerp(g0, g1, clamp(power, 0, 1)) * (0.96 + passSkill(p, kind) * 0.05);
    // 받을 동료가 게이지 거리보다 훨씬 멀면 조금만 보정 (모자란 거리의 20%, 최대 6m)
    const dWant = Math.hypot(aim.x - sx, aim.z - sz);
    if (dWant > dg) dg += Math.min(6, (dWant - dg) * 0.2);
    const [ux, uz] = norm2(aim.x - sx, aim.z - sz);
    aim = inField(sx + ux * dg, sz + uz * dg, 0.6);
    const d3 = Math.hypot(aim.x - sx, aim.z - sz);
    if (kind === 'short' || kind === 'long' || kind === 'through') {
      kick = [rollV0((d3 - off) * 1.25 + 3), aim.x, aim.z, {}]; // 게이지 거리에 힘 있게 도착하고 조금 더 굴러가 멈추도록 (실제 물리로 계산)
    } else {
      const f3 = Lf(aim.x, aim.z, TUNE[kind].apex);
      kick = [f3.spd, aim.x, aim.z, { lift: 0.05, vy: f3.vy }]; landT = f3.T;
    }
    if (runTarget) runTarget = { x: aim.x, z: aim.z, ttl: runTarget.ttl };
  }
  kickFrom(p, kick[0], kick[1], kick[2], kick[3]);
  stats.passes[p.isBlue ? 0 : 1]++;
  ball.pass = { id: ++passSeq, kind, from: p, to: t, team: p.isBlue, x: aim.x, z: aim.z, t0: simTime };
  emitEvent('pass', { kind, from: p, to: t, msg: `${PASS_NAME[kind]} ${pname2(p)} → ${pname2(t)}` });
  // 5. 받는 선수는 도착 예상 지점으로
  t.expectPass = 110;
  if (landT) t.lobLand = { x: aim.x, z: aim.z, ttl: Math.ceil(landT + 20) };
  if (runTarget) t.runTarget = runTarget;
  if (p.isBlue) { pendingReceiver = t; if (isUser) setActive(t); }
  return t;
}
function nearestOppZ(t) {
  let best = null, bd = Infinity;
  for (const o of fieldPlayers(t.isBlue ? teamB : teamA)) { const d = Math.hypot(o.x - t.x, o.z - t.z); if (d < bd) { bd = d; best = o; } }
  return best ? best.z : t.z;
}
/** 패스 결과: success(받을 선수) · success_other(우리 다른 선수) · intercept · out */
function resolvePass(result, by = null) {
  const ps = ball.pass;
  if (!ps) return;
  ball.pass = null;
  const ti = ps.team ? 0 : 1;
  stats.passOk = stats.passOk || [0, 0];
  stats.intercepts = stats.intercepts || [0, 0];
  if (result === 'success' || result === 'success_other') stats.passOk[ti]++;
  if (result === 'intercept') stats.intercepts[ti ? 0 : 1]++;
  const txt = { success: '성공', success_other: '성공 (다른 동료)', intercept: '가로채기', out: '실패 (아웃)' }[result];
  emitEvent('pass_result', { kind: ps.kind, result, by, msg: `${PASS_NAME[ps.kind]} ${txt}${by ? ` — ${pname2(by)}` : ''}` });
}

// =====================================================================
//  공 탈취 · 태클
// =====================================================================
/** 탈취 성공 확률: 능력치 · 위치(정면/옆/뒤) · 태클 방향과 공 방향 · 공 보호 */
function tackleChance(p, o, kind, tdir = null) {
  const c = TUNE.tackle;
  const [fx, fz] = norm2(o.faceX, o.faceZ);
  const [rx, rz] = norm2(p.x - o.x, p.z - o.z);
  const front = fx * rx + fz * rz; // 1 정면 · 0 옆 · -1 뒤
  let ch = (kind === 'slide' ? c.slideBase : kind === 'stand' ? c.standBase : 0.42) + (statMul(p, 'defense') - statMul(o, 'dribbling')) * 1.3;
  if (front > 0.35) ch += c.front;
  else if (front > -0.25) ch *= c.sideMul;
  else ch *= c.backMul;
  if (tdir) {
    const [bx, bz] = norm2(ball.x - p.x, ball.z - p.z);
    const align = Math.max(0, tdir[0] * bx + tdir[1] * bz);
    ch *= 1 - c.alignW + c.alignW * align;
  }
  // 공 보호: 천천히 움직이며 몸으로 공을 가리고 있으면
  const shield = Math.hypot(o.vx, o.vz) < 0.06 && Math.hypot(ball.x - p.x, ball.z - p.z) > Math.hypot(o.x - p.x, o.z - p.z);
  if (shield) ch *= c.shieldMul;
  ch *= bodyStrengthMul(p) / bodyStrengthMul(o); // 몸무게 차이 (아주 미세)
  return { chance: clamp(ch, 0.05, 0.85), front };
}
/** 개발자 그라운드: AI 대신 허수아비(제자리) · 압박(공으로 돌진) */
function devAiOverride(p, mode) {
  if (mode === 'dummy') { p.vx *= 0.7; p.vz *= 0.7; if (ball.owner !== p) [p.faceX, p.faceZ] = norm2(ball.x - p.x, ball.z - p.z); return true; }
  if (mode === 'press' && ball.owner !== p) { moveToward(p, ball.x, ball.z, SPRINT * 0.85); p.lunge = dist2(p, ball) < 2 ? 18 : 0; return true; }
  return false;
}
function startTackle(p, kind) {
  if (!p || p.sentOff || p.tackle || p.tackleCd > 0 || p.stun > 0 || p.role === 'GK') return false;
  if (ball.owner === p || ball.holdByGk === p) return false;
  let [dx, dz] = getInputDir();
  if (!dx && !dz) [dx, dz] = norm2(ball.x - p.x, ball.z - p.z);
  p.tackle = { kind, t: kind === 'slide' ? TUNE.tackle.slideT : TUNE.tackle.standT, dx, dz, hit: false };
  p.faceX = dx; p.faceZ = dz;
  emitEvent('tackle_start', { kind, by: p, msg: `${kind === 'slide' ? '슬라이딩' : '스탠딩'} 태클 시도 — ${pname2(p)}` });
  return true;
}
/** 태클 중 이동 + 판정. 처리했으면 true (일반 이동 대신) */
function updateTackle(p) {
  const T = p.tackle;
  if (!T) return false;
  const c = TUNE.tackle;
  const slide = T.kind === 'slide';
  const total = slide ? c.slideT : c.standT;
  const age = total - T.t;
  const sp = slide ? SPRINT * 1.35 * Math.max(0.1, 1 - age / (total - 4)) : SPRINT * (age < 6 ? 0.85 : 0.3);
  p.vx = T.dx * sp * statMul(p, 'speed');
  p.vz = T.dz * sp * statMul(p, 'speed');
  if (!T.hit && phase === 'play') resolveTackle(p, T);
  if (--T.t <= 0) {
    p.tackle = null;
    if (!T.hit) emitEvent('tackle_miss', { kind: T.kind, by: p, msg: `태클 헛발 — ${pname2(p)}` });
    p.tackleCd = T.won ? 16 : slide ? c.slideCd : c.standCd;
    if (slide) p.stun = T.won ? 10 : c.slideStun;
  }
  return true;
}
function resolveTackle(p, T) {
  const c = TUNE.tackle;
  const slide = T.kind === 'slide';
  if (ball.holdByGk || ball.y > 0.9) return; // 공중 · 키퍼 손 = 지상 태클 없음
  const reach = PLAYER_R + (slide ? c.slideReach : c.standReach);
  const d = Math.hypot(ball.x - p.x, ball.z - p.z);
  if (d > reach) return;
  const [bx, bz] = norm2(ball.x - p.x, ball.z - p.z);
  if (T.dx * bx + T.dz * bz < (slide ? 0.2 : -0.1)) return; // 태클 방향 앞에 있어야
  if ((ball.lockT || 0) > 0) return;
  const o = ball.owner;
  if (o && o.isBlue === p.isBlue) return;
  T.hit = true;
  if (!o) { // 자유 공: 태클로 건드림
    pokeBall(p, T, slide ? 0.3 : 0.18);
    if (!slide) { takeBall(p, 'tackle'); }
    emitEvent('tackle_loose', { kind: T.kind, by: p, msg: `태클로 자유 공 처리 — ${pname2(p)}` });
    T.won = true;
    return;
  }
  const { chance, front } = tackleChance(p, o, T.kind, [T.dx, T.dz]);
  const won = Math.random() < chance;
  const back = front < -0.25;
  if (tackleFoulExt(p, o, won, slide, back)) { T.won = false; return; }
  stats.tackles = stats.tackles || [0, 0];
  if (!won) {
    emitEvent('tackle_fail', { kind: T.kind, by: p, victim: o, chance, msg: `태클 실패 (${Math.round(chance * 100)}%) — ${pname2(p)} → ${pname2(o)}` });
    return;
  }
  T.won = true;
  stats.tackles[p.isBlue ? 0 : 1]++;
  o.dispossessCd = 42;
  // 4. 공 분리: 태클 방향으로 자연스럽게 (스탠딩은 절반 확률로 바로 내 공)
  if (!slide && Math.random() < 0.55) {
    takeBall(p, 'tackle');
  } else {
    ball.owner = null;
    pokeBall(p, T, slide ? 0.2 + Math.random() * 0.06 : 0.15);
    nextTouchCause = 'tackle';
    touchBall(p);
    ball.lockT = TUNE.claimLock;
  }
  emitEvent('tackle_win', { kind: T.kind, by: p, victim: o, chance, msg: `태클 성공 (${Math.round(chance * 100)}%) — ${pname2(p)} ← ${pname2(o)}` });
}
function pokeBall(p, T, spd) {
  ball.owner = null; ball.holdByGk = null;
  const [dx, dz] = norm2(T.dx * 0.7 + (ball.x - p.x) * 0.3, T.dz * 0.7 + (ball.z - p.z) * 0.3);
  ball.vx = dx * spd; ball.vz = dz * spd; ball.vy = 0.02;
  ball.y = BALL_R;
  ball.wx = ball.wy = ball.wz = 0;
  ball.lastShot = false;
  if (pendingReceiver && pendingReceiver.isBlue !== p.isBlue) pendingReceiver = null;
}
/** 소유권 넘기기 (한 곳에서만) */
function takeBall(p, cause) {
  ball.owner = p; ball.holdByGk = null;
  ball.fromThrow = false; ball.lastShot = false;
  ball.vy = 0; ball.wx = ball.wy = ball.wz = 0;
  nextTouchCause = cause;
  touchBall(p);
  ball.lockT = TUNE.claimLock;
  if (pendingReceiver && pendingReceiver !== p) pendingReceiver = null;
  if (p.isBlue) setActive(p); else p.aiTimer = 10 + Math.random() * 15;
}
/** 태클 파울: 뒤에서 · 슬라이딩 · 실패일수록 위험 */
function tackleFoulExt(p, o, won, slide, back) {
  if (!slide && !back) return tackleFoul(p, o, won);
  if (foulCd > 0 || phase !== 'play') return false;
  if (devFlags.noFouls) return false;
  let ch = (slide ? 0.12 : 0.05) + (back ? 0.35 : 0) - statMul(p, 'defense') * 0.05;
  if (won) ch *= 0.3;
  if (Math.random() >= clamp(ch, 0.01, 0.6)) return false;
  awardFoul(p, o, o.x, o.z, back && (slide || Math.random() < 0.4));
  return true;
}
/** 공이 떨어질 곳 (띄운 공일 때) — 프레임마다 1번만 계산 */
let landCache = { f: -1, v: null };
function predictLanding() {
  if (landCache.f === simFrame) return landCache.v;
  let v = null;
  if (!ball.owner && !ball.holdByGk && ball.y > BALL_R + 0.3) {
    const b = { ...ball };
    for (let i = 1; i < 150; i++) { stepBallPhysics(b); if (b.y <= BALL_R + 0.05 && b.vy <= 0.001) { v = { x: b.x, z: b.z, t: i }; break; } }
  }
  landCache = { f: simFrame, v };
  return v;
}

function releaseAction(action, power) {
  if (phase !== 'play' && phase !== 'setpiece') return;
  if (penRun || fkRun || setpiece?.cut) return;
  const p = getActive();
  const has = ball.owner === p || ball.holdByGk === p ||
    (phase === 'setpiece' && setpiece && setpiece.taker === p);
  if (!has || kickCooldown > 0 || p.sentOff) {
    if (phase === 'play' && p && !p.sentOff && (ball.owner === p || shotBufferable(p)))
      queuedKick = { action, power, p, ttl: 45, dir: getInputDir() }; // 공이 발에 오면 바로 찬다 (다이렉트 슛 · 패스)
    return;
  }

  if (phase === 'setpiece' && setpiece && (setpiece.type === 'corner' || setpiece.type === 'freekick')) {
    const k = setpieceKickParams(p, action === 'long' ? 'ground' : action === 'lobThrough' ? 'lob' : action, power);
    if (k.isShot && setpiece.indirect) showMsg('간접 프리킥 — 바로 넣으면 무효', 1200);
    if (setpiece.type === 'freekick') { startFkRun(p, k); return; }
    kickFrom(p, k.spd, k.tx, k.tz, k);
    if (k.isShot) stats.shots[0]++;
    else stats.passes[0]++;
    pendingReceiver = null;
    return;
  }

  if (phase === 'setpiece' && setpiece?.type === 'throw') {
    const t = findThrowTarget(p, action === 'lob' ? 26 : 16);
    throwIn(p, t, action === 'lob', power);
    if (t) { pendingReceiver = t; setActive(t); }
    return;
  }

  const PASS_OF = { ground: 'short', long: 'long', lob: 'lob', through: 'through', lobThrough: 'lobThrough' };
  if (PASS_OF[action]) {
    if (phase === 'setpiece' && setpiece?.type === 'throw') return;
    doPass(p, PASS_OF[action], power);
  } else if (action === 'finesse') {
    finesseShot(p, power);
  } else if (action === 'shoot') {
    if (phase === 'setpiece' && setpiece?.type === 'throw') return;
    if (phase === 'setpiece' && setpiece?.type === 'penalty') { startPenRun(p, power, penAimZ); return; }
    const goalX = p.isBlue ? FIELD_W / 2 : -FIELD_W / 2;
    const skill = skillMult(p);
    const fatigue = staminaFatigue(p);
    const edge = powerRange(0.12, 0.72, power) * (1.05 + (1 - skill) * 0.55);
    let goalZ = 0;
    const penalty = phase === 'setpiece' && setpiece?.type === 'penalty';
    if (penalty) {
      // 키커 뒤 카메라 기준: ← 왼쪽 구석, → 오른쪽 구석 (↑↓는 높이)
      const sd = keys.ArrowLeft ? -1 : keys.ArrowRight ? 1 : 0;
      goalZ = sd * GOAL_W * (0.2 + power * 0.2);
    } else if (keys.ArrowUp) goalZ = -GOAL_W * edge;
    else if (keys.ArrowDown) goalZ = GOAL_W * edge;
    else if (keys.ArrowLeft) goalZ = -GOAL_W * edge * 0.55;
    else if (keys.ArrowRight) goalZ = GOAL_W * edge * 0.55;
    else goalZ = (Math.random() - 0.5) * GOAL_W * fatigue * 0.35;
    if (!penalty) goalZ *= camSideNow(); // 후반엔 화면 위 = 경기장 반대쪽

    const dE = directErr(p); // 다이렉트 슛은 덜 정확
    goalZ += (Math.random() - 0.5) * GOAL_W * (0.04 + fatigue * 0.42) * dE;

    const shotPow = statMul(p, 'shotPower');
    const finish = statMul(p, 'finishing');
    if (setpiece?.type === 'goalkick') {
      const spdG = powerRange(0.55, 1.15, power) * (0.9 + shotPow * 0.15);
      kickFrom(p, spdG, goalX, goalZ, { lift: 0.05, vy: powerRange(0.15, 0.4, power), isShot: false, spin: { side: 0, top: -0.15 } });
      pendingReceiver = null;
      return;
    }
    // D를 얼마나 눌렀는지 = 골라인에서의 공 높이 (거리와 상관없이 같음)
    //  게이지 4칸 기준: ~2.8칸(0.70)까지 골문 안 · 2.8~3칸(0.70~0.75) 크로스바 언저리 · 그 이상은 위로 벗어남
    const G = TUNE.shot;
    let ty;
    if (power <= G.inMax) ty = lerp(G.lowY, G.highY, power / G.inMax);
    else if (power <= G.barMax) ty = lerp(G.highY, G.barY, (power - G.inMax) / (G.barMax - G.inMax));
    else ty = G.barY + (power - G.barMax) * G.overK;
    ty += gauss() * (0.1 + fatigue * 0.5) * clamp(1.4 - finish, 0.4, 1.2) * dE;
    if (penalty) {
      if (keys.ArrowUp) ty += 0.4;
      else if (keys.ArrowDown) ty *= 0.5;
    }
    let spd = powerRange(0.85, 1.55, Math.min(power, 0.85)) * (0.9 + 0.1 * skill);
    spd *= 0.88 + shotPow * 0.2;
    goalZ *= clamp(1.55 - finish * 0.55, 0.55, 1.35);
    goalZ += (Math.random() - 0.5) * GOAL_W * (0.08 + fatigue * 0.2) * clamp(1.4 - finish, 0.35, 1.2) * dE;
    if (power > G.barMax) goalZ += Math.sign(goalZ || (Math.random() - 0.5)) * GOAL_W * (power - G.barMax) * 0.8; // 너무 세면 옆으로도 조금
    const top = 0.3 + Math.min(power, 0.8) * 0.55; // 탑스핀 (궤적은 아래 계산에 포함)
    const spin = { side: 0, top };
    const sol = solveShot(p, goalX, goalZ, Math.max(0.15, ty), spd, 0.12, spin);
    kickFrom(p, spd, goalX, sol.aimZ, { vy: sol.vy, isShot: true, spin });
    if (setpiece?.type !== 'goalkick') stats.shots[0]++;
    pendingReceiver = null;
  }
}

// ===== 감아차기 · 파워 슛 =====
/** 공이 골라인을 지날 때 (z, y) — 실제 물리로 미리 계산 */
function simGoalCross(ox, oz, y0, dx, dz, spd, vy, spin, goalX) {
  const b = makeLaunch(ox, oz, y0, dx, dz, spd, vy, spin);
  for (let i = 0; i < 160; i++) {
    stepBallPhysics(b);
    if ((goalX > 0 && b.x >= goalX) || (goalX < 0 && b.x <= goalX)) return { z: b.z, y: b.y, t: i + 1 };
  }
  return { z: b.z, y: b.y, t: 160 };
}
/** 목표 (tz, ty)에 정확히 들어가도록 조준점과 띄우는 힘을 맞춤 */
function solveShot(p, goalX, tz, ty, spd, vy0, spin) {
  let aimZ = tz, vy = vy0;
  for (let it = 0; it < 10; it++) {
    const [dx, dz] = norm2(goalX - p.x, aimZ - p.z);
    const sx = p.x + dx * 0.9, sz = p.z + dz * 0.9;
    const c = simGoalCross(sx, sz, BALL_R, dx, dz, spd * SHOT_SPEED_SCALE, vy, spinVectorArgs(dx, dz, spin), goalX);
    aimZ += (tz - c.z) * 0.95;
    vy += (ty - c.y) / Math.max(8, c.t) * 0.9;
  }
  return { aimZ, vy };
}
function spinVectorArgs(dx, dz, spin) { return spin; }

/** Z+D 감아차기: 먼 쪽 구석 바깥을 보고 차서 안쪽으로 휘어 들어감. 커브가 좋을수록 더 크게 휘고 정확함 */
function finesseShot(p, power) {
  const goalX = p.isBlue ? FIELD_W / 2 : -FIELD_W / 2;
  const curve = statMul(p, 'curve'), finish = statMul(p, 'finishing'), fatigue = staminaFatigue(p);
  let sgn = keys.ArrowUp ? -camSideNow() : keys.ArrowDown ? camSideNow() : -(Math.sign(p.z) || (Math.random() < 0.5 ? -1 : 1)); // 기본: 먼 쪽 포스트
  const tz = sgn * (GOAL_W / 2 - 0.55);
  const ty = clamp(0.5 + power * 1.55, 0.4, 2.15);
  const spd = lerp(0.98, 1.22, power) * (0.88 + statMul(p, 'shotPower') * 0.15);
  // 안쪽(골대 가운데)으로 휘게: 커브 능력만큼 회전
  const [ddx, ddz] = norm2(goalX - p.x, tz - p.z);
  const sideMag = 0.2 + curve * 0.55;
  const side = curlToward(ddx, ddz, 0, -sgn) * sideMag;
  const spin = { side, top: 0.15 };
  const sol = solveShot(p, goalX, tz, ty, spd, 0.16 + power * 0.12, spin);
  // 실수: 결정력·커브·체력 + 너무 세게 누르면 뜸
  const err = (0.15 + Math.max(0, 1 - finish) * 2.2 + Math.max(0, 1 - curve) * 1.6 + fatigue * 1.0) * directErr(p);
  let aimZ = sol.aimZ + gauss() * err;
  let vy = sol.vy + gauss() * err * 0.012 + (power > 0.88 ? (power - 0.88) * 0.9 : 0);
  kickFrom(p, spd, goalX, aimZ, { vy, isShot: true, spin, curl: Math.min(1, sideMag * curve * 1.4) });
  stats.shots[0]++;
  pendingReceiver = null;
}

// 파워 슛: F+D로 시작 → 게이지(빨-노-초-노-빨)가 지나가는 동안 D를 다시 눌러 타이밍
let pshot = null;
const _pv = new THREE.Vector3();
let camZoom = 0; // 0~1 (파워 슛 준비 중 살짝 줌인)
function pshotZone(t) {
  const g = TUNE.gauge; // 빨강 → 노랑(길게) → 초록 → 노랑(짧게) → 빨강
  return t >= g.g1 && t < g.g2 ? 'green' : t >= g.y1 && t < g.y2 ? 'yellow' : 'red';
}
/** 달리면서 공이 아직 발에 오기 전(받는 중 · 우리 편이 마지막으로 건드린 굴러오는 공)에도 슛을 미리 입력할 수 있는지 */
function shotBufferable(p, keep = false) {
  if (!p || phase !== 'play' || ball.holdByGk) return false;
  if (ball.owner === p) return true;
  if (ball.owner) return false;
  if ((pendingReceiver === p || ball.pass?.to === p) && dist2(p, ball) < 35) return true; // 우리 패스를 받는 중 (원터치 슛)
  if (dist2(p, ball) >= (keep ? 12 : 9)) return false;
  // 우리 편이 마지막으로 건드린 굴러다니는 공: 상대 골문 쪽(40m 안)에서만 — 수비 지역에선 D = 슬라이딩 태클 그대로
  const atk = p.isBlue ? 1 : -1;
  return !!lastToucher && lastToucher.isBlue === p.isBlue && (atk * FIELD_W / 2 - p.x) * atk < 40;
}
let queuedKick = null;
function updateQueuedKick() {
  const q = queuedKick;
  if (!q) return;
  if (--q.ttl <= 0 || phase !== 'play' || getActive() !== q.p || ball.holdByGk || (ball.owner && ball.owner !== q.p)) { queuedKick = null; return; }
  if (ball.owner !== q.p || kickCooldown > 0) return;
  queuedKick = null;
  directKick = true; // 선입력으로 받자마자 찬 공 = 다이렉트
  inputDirOverride = q.dir || null; // 패스 방향은 뗄 때 누르고 있던 방향키
  try {
    if (q.action === 'power') firePowerShot(q.ps);
    else releaseAction(q.action, q.power);
  } finally { directKick = false; inputDirOverride = null; }
}
let directKick = false, inputDirOverride = null;
/** 다이렉트 슛 오차 배율: 잡고 찰 때보다 40% 부정확, 발리슛 능력치가 좋을수록 덜함 */
function directErr(p) { return directKick ? 1 + 0.4 * clamp(2 - statMul(p, 'volleys'), 0.25, 1.25) : 1; }
function updatePowerShot() {
  if (!pshot) return;
  const p = pshot.p;
  if (phase !== 'play' || getActive() !== p || (ball.owner !== p && !shotBufferable(p, true))) { pshot = null; return; }
  pshot.t += realK() / TUNE.gauge.pshot;
  if (pshot.t >= 1) { pshot.t = 1; firePowerShot(); }
}
function firePowerShot(queued) {
  const ps = queued || pshot;
  if (!queued) pshot = null;
  if (!ps) return;
  const p = ps.p;
  if (phase !== 'play') return;
  if (ball.owner !== p || kickCooldown > 0) {
    if (!queued && shotBufferable(p, true)) queuedKick = { action: 'power', ps, p, ttl: 45 };
    return;
  }
  const zone = pshotZone(ps.t);
  const goalX = p.isBlue ? FIELD_W / 2 : -FIELD_W / 2;
  const shotPow = statMul(p, 'shotPower'), finish = statMul(p, 'finishing');
  let tz = (keys.ArrowUp ? -GOAL_W * 0.33 : keys.ArrowDown ? GOAL_W * 0.33 : keys.ArrowLeft ? -GOAL_W * 0.18 : keys.ArrowRight ? GOAL_W * 0.18 : (Math.random() - 0.5) * GOAL_W * 0.4) * camSideNow();
  let ty = 0.9 + Math.random() * 0.8;
  const side = Math.random() < 0.5 ? -1 : 1;
  const dE = directErr(p);
  if (zone === 'green') {
    tz += gauss() * (0.12 + (1 - finish) * 0.6) * dE;
    ty += gauss() * 0.15 * dE;
  } else if (zone === 'yellow') {
    // 조금 벗어남: 포스트 근처 · 크로스바 근처
    if (Math.random() < 0.6) tz = side * (GOAL_W / 2 - 0.2 + Math.random() * 1.3);   // 포스트 옆으로 살짝
    else ty = GOAL_H - 0.1 + Math.random() * 0.9;                                    // 크로스바 위로 살짝
    tz += gauss() * 0.2 * dE;
  } else {
    // 완전히 빗나감: 붕 뜨거나 옆으로
    if (Math.random() < 0.5) { ty = GOAL_H + 1.5 + Math.random() * 3; tz += gauss() * 1.5; }
    else { tz = side * (GOAL_W / 2 + 1.5 + Math.random() * 3.5); ty = 0.6 + Math.random() * 1.6; }
  }
  const spd = 1.62 * 1.128 * (0.88 + shotPow * 0.22); // 파워 슛 공 속도
  const spin = { side: 0, top: 0.35 };
  const sol = solveShot(p, goalX, tz, ty, spd, 0.14, spin);
  kickFrom(p, spd, goalX, sol.aimZ, { vy: sol.vy, isShot: true, spin, powerShot: true });
  stats.shots[0]++;
  pendingReceiver = null;
}
function updatePowerShotUi() {
  const bar = $('pshot');
  if (!bar) return;
  const on = !!pshot;
  bar.classList.toggle('show', on);
  if (on) {
    $('pshot-mark').style.left = `${(pshot.t * 100).toFixed(1)}%`;
    // 초록/노랑 구간 폭도 조정값대로 그림
    const G = TUNE.gauge, q = v => (v * 100).toFixed(1);
    const bg = `linear-gradient(90deg, #dc2626 0%, #dc2626 ${q(G.y1)}%, #facc15 ${q(G.y1)}%, #facc15 ${q(G.g1)}%, #22c55e ${q(G.g1)}%, #22c55e ${q(G.g2)}%, #facc15 ${q(G.g2)}%, #facc15 ${q(G.y2)}%, #dc2626 ${q(G.y2)}%, #dc2626 100%)`;
    const pb = bar.querySelector('.ps-bar');
    if (pb && pb.dataset.bg !== bg) { pb.style.background = bg; pb.dataset.bg = bg; }
    bar.dataset.zone = pshotZone(pshot.t);
    // 선수 머리 위에 표시
    const p = pshot.p;
    _pv.set(ix(p, 'x', 'px'), 3.1, ix(p, 'z', 'pz')).project(camera);
    bar.style.left = `${((_pv.x + 1) / 2 * viewW()).toFixed(0)}px`;
    bar.style.top = `${((1 - _pv.y) / 2 * viewH()).toFixed(0)}px`;
  }
}

// ===== AI =====
/** 키퍼 위치: 골라인 중앙과 공(가진 선수)을 잇는 직선 위.
 *  공이 가까울수록 그 선을 따라 조금 앞으로 나와 각도를 좁힘 */
function roleTargetGk(p) {
  const attackSign = p.isBlue ? 1 : -1;
  const ownGoalX = -attackSign * (FIELD_W / 2);
  const carrier = ball.owner || ball.holdByGk;
  const boxMinX = p.isBlue ? -FIELD_W / 2 : FIELD_W / 2 - PEN_W;
  const boxMaxX = p.isBlue ? -FIELD_W / 2 + PEN_W : FIELD_W / 2;
  const threatX = carrier && carrier !== p ? carrier.x : ball.x;
  const threatZ = carrier && carrier !== p ? carrier.z : ball.z;
  const [ldx, ldz] = norm2(threatX - ownGoalX, threatZ);
  const dist = Math.hypot(threatX - ownGoalX, threatZ);
  const gkPos = statMul(p, 'gkPositioning');
  // 멀면 골라인 1~2m 앞, 가까워지면 최대 6m까지 선을 따라 전진 (상대와는 1.5m 이상 거리)
  let adv = dist > 40 ? 1.5 : dist > 20 ? 1.5 + (40 - dist) * 0.1 : 3.5 + (20 - dist) * 0.15;
  adv *= 0.85 + gkPos * 0.2;
  if (p.tacRole === 'sweeper') adv += dist > 25 ? 4 : 1.5;   // 스위퍼 키퍼: 더 앞에서 뒷공간 커버
  adv = clamp(Math.min(adv, dist - 1.5), 0.5, p.tacRole === 'sweeper' ? 10 : 6.5);
  let tx = ownGoalX + ldx * adv;
  let tz = ldz * adv;
  tx = clamp(tx, boxMinX + 0.3, boxMaxX - 0.3);
  const shotComing = !ball.owner && ball.lastShot;
  const close = dist < 20;
  const baseSpd = WALK * 0.5 * (shotComing ? 0.6 : close ? 0.9 : 0.55) * statMul(p, 'speed') * (0.9 + gkPos * 0.15);
  // 띄운 패스가 우리 박스 안에 떨어지면, 먼저 닿을 수 있을 때 낙하지점으로 나가서 잡음
  const land = !ball.lastShot ? predictLanding() : null;
  if (land && inPenaltyBox(land.x, land.z, p.isBlue)) {
    const gkT = Math.max(0, Math.hypot(land.x - p.x, land.z - p.z) - 1) / (SPRINT * 0.8 * statMul(p, 'speed'));
    if (gkT < land.t + 6) return { tx: land.x, tz: land.z, speed: SPRINT * 0.85, boxMinX, boxMaxX };
  }
  return { tx, tz, speed: baseSpd, boxMinX, boxMaxX };
}

/** 키 · 몸무게 체감 (아주 미세하게): 무거울수록 최고 속도 · 가속이 아주 조금 느리지만 몸싸움이 조금 강함 · 키가 클수록 공중볼에 조금 유리 */
const bodySpeedMul = p => clamp(1 - ((p.weight || 76) - 76) * 0.0009 - ((p.height || 181) - 181) * 0.0004, 0.975, 1.02);
const bodyStrengthMul = p => clamp(1 + ((p.weight || 76) - 76) * 0.002, 0.96, 1.04);
const bodyReachAdd = p => clamp(((p.height || 181) - 181) * 0.004, -0.06, 0.06);
function maxRunSpeed(p) {
  return (p.role === 'GK' ? SPRINT * 0.88 : SPRINT) * statMul(p, 'speed') * sprintMult(p) * bodySpeedMul(p);
}

function moveToward(p, tx, tz, speed) {
  speed = Math.min(speed, maxRunSpeed(p));
  const [dx, dz] = norm2(tx - p.x, tz - p.z);
  const d = Math.hypot(tx - p.x, tz - p.z);
  if (d < 0.4) { p.vx *= 0.7; p.vz *= 0.7; return; }
  p.vx = dx * speed; p.vz = dz * speed;
  p.faceX = dx; p.faceZ = dz;
}

function inPenaltyBox(x, z, blueBox) {
  if (blueBox) return x <= -FIELD_W / 2 + PEN_W && Math.abs(z) <= PEN_H / 2;
  return x >= FIELD_W / 2 - PEN_W && Math.abs(z) <= PEN_H / 2;
}

let lastPossessor = null, prevPossessor = null;
let matchGoals = [];
function touchBall(p) {
  lastToucher = p;
  ball.loftMark = false;
  let cause = nextTouchCause;
  if (ball.pass && p !== ball.pass.from) {
    const r = p.isBlue === ball.pass.team ? (p === ball.pass.to ? 'success' : 'success_other') : 'intercept';
    if (r === 'intercept') cause = 'intercept';
    resolvePass(r, p);
  }
  if (lastPossTeam !== null && p.isBlue !== lastPossTeam) {
    const why = { intercept: '패스 가로채기', tackle: '태클', loose: '루즈볼' }[cause || 'loose'] || cause;
    emitEvent('turnover', { by: p, cause: cause || 'loose', msg: `소유권 변경 (${why}) → ${pname2(p)}` });
  }
  lastPossTeam = p.isBlue;
  nextTouchCause = null;
  if (p !== lastPossessor) { prevPossessor = lastPossessor; lastPossessor = p; }
  if (ball.indirect && p !== ball.indirectKicker) ball.indirect = false;
}

function registerSave(gk) {
  if (!ball.lastShot) return;
  sndOoh(1.1);
  if (inPens) comm.pkMiss(); else comm.save();
  const shooter = ball.shotTeamBlue === true ? 0 : ball.shotTeamBlue === false ? 1 : (gk.isBlue ? 1 : 0);
  stats.shotsOnTarget[shooter]++;
}

function aiGk(p) {
  if (p.sentOff) return;
  const t = roleTargetGk(p);

  if (ball.holdByGk === p && !p.isBlue) {
    const edge = FIELD_W / 2 - PEN_W + 3;
    moveToward(p, edge, clamp(p.z * 0.7, -GOAL_W, GOAL_W), WALK * 0.35);
    p.x = clamp(p.x, t.boxMinX + 0.5, t.boxMaxX - 0.5);
    p.z = clamp(p.z, -PEN_H / 2 + 1, PEN_H / 2 - 1);
    p.faceX = -1;
    return;
  }

  // 경기 중 슛 대응 (승부차기 · 페널티 제외): 보고 판단 → 제자리 선방 / 타이밍 맞춰 다이빙 / 빗나가는 슛은 지켜봄
  if (!inPens && !p.penDive && gkShotLogic(p)) return;
  if (p.gs) p.gs = null;

  moveToward(p, t.tx, t.tz, t.speed);
  p.x = clamp(p.x, t.boxMinX + 0.5, t.boxMaxX - 0.5);
  p.z = clamp(p.z, -PEN_H / 2 + 1, PEN_H / 2 - 1);

  // 페널티: 정해 둔 쪽으로 반응 시간 뒤에 다이빙
  if (p.penDive) {
    if (p.penDive.delay-- > 0) return;
    const pd = p.penDive;
    p.penDive = null;
    p.dive = 40;
    p.diveZ = pd.z;
    p.diveDir = Math.sign((pd.z - p.z) * (p.isBlue ? 1 : -1)) || 0;
    p.diveHigh = pd.high;
    p.saveRoll = true; // 공이 손 닿는 곳으로 오면 막음
  }
  // 다이빙 중: 예측 지점으로 몸을 날리고, 성공 판정이면 공이 손에 닿을 때 처리
  if (p.dive > 0 && p.diveZ != null) {
    p.z = lerp(p.z, clamp(p.diveZ, -GOAL_W / 2 - 0.5, GOAL_W / 2 + 0.5), inPens ? 0.16 : 0.11);
    const prog = 1 - p.dive / 40;
    p.jumpY = Math.max(0, Math.sin(Math.PI * clamp(prog * 1.4, 0, 1)) * (p.diveHigh ? 0.75 : 0.35));
    const reachH = p.diveHigh ? 2.7 : 2.1;
    if (p.saveRoll && !ball.owner && !ball.holdByGk && dist2(p, ball) < (inPens ? (ball.y < 0.7 ? 1.35 : 1.15) : 1.35) && ball.y < reachH) {
      p.saveRoll = false;
      executeSave(p);
    }
    return;
  }

  if (inPens && !ball.owner && !ball.holdByGk && ball.lastShot && ball.shotTeamBlue !== p.isBlue) {
    const reaction = statMul(p, 'reaction');
    const diving = statMul(p, 'diving');
    const ownGoalX = p.isBlue ? -FIELD_W / 2 : FIELD_W / 2;
    const toLine = ball.vx !== 0 ? (ownGoalX - ball.x) / ball.vx : -1;
    if (toLine <= 0 || toLine > 40) return;
    const d = dist2(p, ball);
    if (d > 9) return;
    const crossZ = ball.z + ball.vz * toLine;
    const crossY = ball.y + ball.vy * toLine - 0.5 * GRAVITY * toLine * toLine;
    if (Math.abs(crossZ) > GOAL_W / 2 + 0.4 || crossY > GOAL_H + 0.3) return; // 빗나가는 슛은 지켜봄
    const reactFrames = 2 + (1.1 - reaction) * 10;
    const gap = Math.abs(crossZ - p.z);
    const reach = 1.2 + diving * 2.5 + Math.max(0, toLine - reactFrames) * WALK * 0.3;
    const spd = Math.hypot(ball.vx, ball.vz);
    let chance = gap > reach ? 0 : clamp(1 - gap / (reach + 0.4), 0.05, 0.95) * (0.55 + reaction * 0.4);
    chance *= clamp(1.35 - spd * 0.35, 0.55, 1.05);
    if (crossY > 1.9) chance *= 0.75;          // 위쪽 구석은 막기 어렵다
    if (toLine < reactFrames) chance *= 0.4;   // 너무 가까운 슛
    if (ball.curl) chance *= 1 - ball.curl * 0.5; // 크게 휘어 들어오는 공은 예측이 어려움
    if (ball.powerShot) chance *= 0.75;          // 파워 슛은 빨라서 막기 어려움
    p.dive = 30;
    p.diveZ = crossZ;
    p.diveDir = Math.sign((crossZ - p.z) * (p.isBlue ? 1 : -1)) || 1;
    p.saveRoll = Math.random() < chance;
  }
}

/** 공이 키퍼가 서 있는 x 평면(또는 골라인)에 올 때의 z · y · 남은 프레임 — 실제 물리로 미리 계산 */
function predictShotAt(planeX, goalX) {
  const b = { ...ball };
  const dir = Math.sign(goalX) || 1;
  let atPlane = null;
  for (let i = 1; i < 150; i++) {
    stepBallPhysics(b);
    if (!atPlane && dir * b.x >= dir * planeX) atPlane = { z: b.z, y: b.y, t: i };
    if (dir * b.x >= dir * goalX) return { plane: atPlane || { z: b.z, y: b.y, t: i }, line: { z: b.z, y: b.y, t: i } };
    if (Math.hypot(b.vx, b.vz) < 0.05) break;
  }
  return atPlane ? { plane: atPlane, line: null } : null;
}
/**
 * 키퍼 슛 대응 (실제 키퍼처럼)
 *  1) 반응 시간 동안은 그대로 (반응 속도 능력치)
 *  2) 공 궤적을 보고 판단: 빗나가면 지켜봄 · 몸 가까이 오면 제자리에서 손으로 · 멀면 타이밍 맞춰 다이빙
 *  3) 손이 실제로 공에 닿아야 선방 — 끝으로 겨우 닿을수록 · 빠를수록 놓치기 쉬움
 */
function gkShotLogic(p) {
  const shot = !ball.owner && !ball.holdByGk && ball.lastShot && ball.shotTeamBlue !== p.isBlue;
  if (!shot) return false;
  const G = TUNE.gk;
  const goalX = p.isBlue ? -FIELD_W / 2 : FIELD_W / 2;
  const toward = Math.sign(goalX) * ball.vx > 0.05;
  if (!toward) return false;
  let S = p.gs;
  if (!S || S.id !== ball.kph) {
    const reaction = statMul(p, 'reaction');
    S = p.gs = { id: ball.kph, read: Math.max(1, Math.round(G.react + (1.1 - reaction) * G.reactStat)), mode: 'read', done: false, diveT: 0, err: gauss() * G.readErr * clamp(1.5 - reaction * 0.5, 0.7, 1.1) }; // 궤적을 읽는 오차(사람이니까)
  }
  p.vx *= 0.6; p.vz *= 0.6;
  if (S.read > 0) { S.read--; return true; } // 아직 반응 전
  const pr = predictShotAt(p.x, goalX);
  if (!pr) return true;
  const { plane, line } = pr;
  const onTarget = line && Math.abs(line.z) < GOAL_W / 2 + 0.3 && line.y < GOAL_H + 0.25;
  const diving = statMul(p, 'diving');
  const gap = plane.z + S.err * clamp(plane.t / 25, 0.3, 1) - p.z, ag = Math.abs(gap); // 멀리서 온 공일수록 판단 오차가 남음 (가까울수록 눈으로 보고 보정)
  const standR = G.standReach;
  const diveSpd = G.diveSpd * (0.75 + diving * 0.3);       // 프레임당 옆으로 날아가는 거리
  // 슛 거리: 가까운 슛은 잘 들어가고, 먼 슛은 볼 시간이 많아 잘 막음
  const shotD = Math.hypot((ball.shotX0 ?? ball.x) - goalX, ball.shotZ0 ?? ball.z);
  const farK = clamp((shotD - G.farFrom) / G.farSpan, 0, 1), nearK = clamp((G.nearTo - shotD) / G.nearTo, 0, 1);
  const diveMax = G.diveMax * (0.8 + diving * 0.25) * (1 + farK * G.farReach); // 다이빙으로 커버하는 최대 거리
  if (S.mode !== 'dive' && S.mode !== 'spread' && S.mode !== 'jump') {
    if (!onTarget && !S.locked) {
      // 빗나가는 슛: 몸만 살짝 따라가며 지켜봄
      p.z += clamp(clamp(plane.z, -GOAL_W / 2, GOAL_W / 2) - p.z, -0.04, 0.04);
      return true;
    }
    S.locked = true;
    if (ag <= standR + 0.55 && plane.y >= 1.95 && plane.y < 3.1) {
      // 몸 근처 높은 공: 제자리에서 두 팔을 뻗고 점프 (타이밍 맞춰 뜀)
      p.z += clamp(gap, -G.stepSpd, G.stepSpd);
      if (plane.t <= 9) { S.mode = 'jump'; S.jt = 0; }
      else S.mode = 'set';
    } else if (ag <= standR && plane.y < 1.95) {
      // 몸 가까이: 다이빙 없이 옆걸음으로 맞춰 손으로
      S.mode = 'set';
      p.z += clamp(gap, -G.stepSpd, G.stepSpd);
    } else if (plane.t <= G.closeT && ag <= standR + 1.2 && plane.y < 2.0) {
      // 아주 가까운 거리에서 빠르게 온 슛: 몸을 날리지 않고 팔다리를 벌려 막음 (반사 블록)
      S.mode = 'spread'; S.dir = Math.sign(gap) || 1; S.jt = 0;
    } else if (ag <= standR + diveMax + 0.4) {
      // 다이빙: 날아가는 데 걸리는 시간에 맞춰 출발 (너무 일찍 뜨지 않음)
      const need = Math.max(4, (ag - 0.4) / diveSpd);
      if (plane.t < 4) {
        // 너무 가까이서 빠르게: 몸을 날릴 틈도 없음 — 움찔하고 끝
        S.mode = 'beaten';
      } else if (plane.t <= need + 4) {
        S.mode = 'dive'; S.dir = Math.sign(gap) || 1; S.high = plane.y > 1.35; S.left = Math.min(ag - 0.35, diveMax);
        p.dive = 30; p.diveDir = Math.sign(S.dir * (p.isBlue ? 1 : -1)) || 1; p.diveHigh = S.high;
      } else p.z += clamp(gap, -G.stepSpd, G.stepSpd); // 그 전엔 옆걸음으로 조금씩
    } else {
      // 닿을 수 없는 구석: 한두 걸음만
      S.mode = 'beaten';
      p.z += clamp(gap, -G.stepSpd, G.stepSpd);
    }
  }
  if (S.mode === 'dive') {
    S.diveT++;
    const mv = Math.min(diveSpd, Math.max(0, S.left));
    p.z += S.dir * mv; S.left -= mv;
    // 높은 쪽은 몸을 띄워 손을 위로 뻗음
    p.jumpY = Math.max(p.jumpY || 0, Math.sin(Math.PI * clamp(S.diveT / 26, 0, 1)) * (S.high ? 1.0 : 0.3));
  }
  if (S.mode === 'jump') { S.jt++; p.jumpY = Math.max(p.jumpY || 0, Math.sin(Math.PI * clamp(S.jt / 22, 0, 1)) * G.jumpH); }
  if (S.mode === 'spread') { S.jt++; p.z += S.dir * Math.min(0.05, Math.abs(gap)); }
  p.gkPose = S.mode === 'jump' ? 'up' : S.mode === 'spread' ? 'spread' : null;
  p.gkPoseT = 20;
  p.z = clamp(p.z, -GOAL_W / 2 - 1.6, GOAL_W / 2 + 1.6);
  // 손이 닿았나: 이번 프레임 공이 지나갈 선분이 키퍼 앞뒤 0.7m 안을 지날 때 손 위치와 비교
  if (!S.done && !ball.owner) {
    const nx = ball.x + ball.vx, nz = ball.z + ball.vz;
    const near = Math.min(Math.abs(ball.x - p.x), Math.abs(nx - p.x)) < 0.7 || Math.sign(ball.x - p.x) !== Math.sign(nx - p.x);
    if (near) {
      const k = Math.abs(ball.vx) > 1e-4 ? clamp((p.x - ball.x) / ball.vx, 0, 1) : 0;
      const bz = ball.z + ball.vz * k, by = ball.y + ball.vy * k;
      const dz = bz - p.z;
      let reachZ, reachLo, reachHi;
      if (S.mode === 'dive') {
        const side = Math.sign(dz) === S.dir ? G.diveArm + (S.high ? 0.1 : 0) : 0.45; // 날아간 쪽으로 팔이 뻗어 있음
        reachZ = side; reachLo = S.high ? 0.5 : 0; reachHi = S.high ? 2.6 + (p.jumpY || 0) * 0.35 : 1.6;
      } else if (S.mode === 'jump') { reachZ = 0.85; reachLo = 0.9; reachHi = 2.45 + (p.jumpY || 0); }  // 위로 뻗은 손
      else if (S.mode === 'spread') { reachZ = 1.4; reachLo = 0; reachHi = 1.9; }                      // 팔다리를 벌린 블록
      else { reachZ = 0.95; reachLo = 0; reachHi = 2.35; }
      if (Math.abs(dz) <= reachZ && by >= reachLo && by <= reachHi) {
        S.done = true;
        const edge = Math.abs(dz) / reachZ;                            // 1에 가까울수록 손끝
        const spd = Math.hypot(ball.vx, ball.vz);
        let ch = clamp(G.saveBase - edge * G.edgeLoss, 0.3, 0.97);
        ch *= clamp(1.3 - spd * G.speedLoss, 0.55, 1);
        if (ball.powerShot) ch *= 0.88;
        if (ball.curl) ch *= 1 - ball.curl * 0.15;
        ch *= 0.88 + statMul(p, 'handling') * 0.12;
        ch = clamp(ch * (1 + farK * G.farSave - nearK * G.nearLoss), 0.05, 0.97);
        if (Math.random() < ch) { ball.x = p.x; ball.z = bz; ball.y = Math.max(BALL_R, by); executeSave(p); }
        else { ball.vx *= 0.92; ball.vz += (Math.random() - 0.5) * 0.06; } // 손끝을 스치고 들어감
      } else if (Math.sign(ball.x - p.x) !== Math.sign(nx - p.x)) S.done = true; // 지나감
    }
  }
  return true;
}

function executeSave(p) {
  const handling = statMul(p, 'handling');
  const spd = Math.hypot(ball.vx, ball.vz);
  registerSave(p);
  triggerSaveReplay();
  touchBall(p);
  ball.fromThrow = false;
  ball.wx = ball.wy = ball.wz = 0;
  if (Math.random() < clamp(0.3 + handling * 0.45 - spd * 0.12, 0.2, 0.85)) {
    ball.holdByGk = p;
    ball.owner = p;
    ball.vx = ball.vz = ball.vy = 0;
    ball.y = 1.0;
    ball.lastShot = false;
    p.holdTicks = 0;
    if (p.isBlue) setActive(p);
  } else {
    // 펀칭: 옆으로 쳐냄
    ball.vx = -ball.vx * 0.3;
    ball.vz = Math.sign(ball.z - p.z || 1) * (0.35 + Math.random() * 0.25);
    ball.vy = 0.28;
    ball.lastShot = false;
    ball.blockedShot = true;
  }
  if (inPens && penState) {
    penState.pendingResult = false;
    phase = 'goal_pause';
    goalPauseTimer = penWouldEnd(false) ? 1 : 55; // 끝내기 선방: 바로 세리머니
  }
}

function matchSituation(p) {
  const carrier = ball.owner || ball.holdByGk;
  if (!carrier) return 'loose';
  return carrier.isBlue === p.isBlue ? 'attack' : 'defend';
}

function offsideLineX(isBlue) {
  const opp = isBlue ? teamB : teamA;
  const sorted = fieldPlayers(opp).sort((a, b) => isBlue ? b.x - a.x : a.x - b.x);
  const second = sorted[1] || sorted[0];
  if (!second) return isBlue ? 10 : -10;
  return second.x;
}

function nearestOpp(p) {
  const opp = p.isBlue ? teamB : teamA;
  let best = null, bestD = Infinity;
  for (const o of opp) {
    if (o.sentOff) continue;
    const d = dist2(p, o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

function markTarget(p) {
  const opp = fieldPlayers(p.isBlue ? teamB : teamA).filter(o => o.role !== 'GK');
  const leftZ = p.isBlue ? -1 : 1; // 그 팀 기준 왼쪽의 z 부호
  let best = null, bestS = -Infinity;
  for (const o of opp) {
    const lane = Math.abs((o.homeZ || o.z) - p.homeZ);
    let s = 20 - lane * 0.8 - Math.abs(o.z - p.z) * 0.15;
    if (p.position === 'LB' || p.position === 'LW') s += Math.sign(o.z) === leftZ ? 6 : -4;
    if (p.position === 'RB' || p.position === 'RW') s += Math.sign(o.z) === -leftZ ? 6 : -4;
    if ((p.position === 'CB' || p.position === 'CDM') && o.role === 'ST') s += 8;
    if (s > bestS) { bestS = s; best = o; }
  }
  return best || opp[0] || null;
}

function dangerousRunner(p) {
  const atk = p.isBlue ? 1 : -1;
  const opp = fieldPlayers(p.isBlue ? teamB : teamA);
  let best = null, bestS = 0;
  for (const o of opp) {
    if (o.role === 'GK') continue;
    const ahead = (o.x - ball.x) * atk < -1;
    if (!ahead) continue;
    const s = Math.abs(o.x - ball.x) - Math.abs(o.z - p.homeZ) * 0.3;
    if (s > bestS) { bestS = s; best = o; }
  }
  return best;
}

function runLaneOpen(p) {
  const atk = p.isBlue ? 1 : -1;
  const opp = p.isBlue ? teamB : teamA;
  let blockers = 0;
  for (const o of opp) {
    if (o.sentOff || o.role === 'GK') continue;
    const inFront = (o.x - p.x) * atk > 0 && Math.abs(o.x - p.x) < 18;
    if (inFront && Math.abs(o.z - p.z) < 7) blockers++;
  }
  return blockers < 2;
}

// ===================== 전술 =====================
const DEF_STYLES = [
  { id: 'deep', name: '뒤로 물러서기', desc: '수비 라인을 낮추고 촘촘하게 — 뒷공간을 안 내줌' },
  { id: 'balance', name: '밸런스', desc: '기본 높이 · 상황에 맞춰 압박' },
  { id: 'press', name: '강한 압박', desc: '라인을 올리고 2명이 공을 몰아붙임 — 체력 소모 큼' },
  { id: 'zonal', name: '지역 수비', desc: '사람보다 공간을 지킴 — 대형 유지, 옆으로 덜 쏠림' },
];
const ATK_STYLES = [
  { id: 'possession', name: '점유율', desc: '가까이 붙어 짧은 패스로 풀어 감' },
  { id: 'balance', name: '밸런스', desc: '기본' },
  { id: 'counter', name: '빠른 역습', desc: '공을 뺏으면 공격진이 바로 뒷공간으로 침투' },
  { id: 'wing', name: '측면 공격', desc: '넓게 벌리고 풀백 오버래핑 · 크로스 위주' },
  { id: 'direct', name: '직선적 공격', desc: '최전방 침투를 자주 — 길게 연결' },
];
// 포지션별 선수 역할: atk/def = 행동 점수 가감, da/dd = 공격/수비 시 깊이(m), w = 공격 시 폭 배율
const TAC_ROLES = {
  ST: [
    { id: 'poacher', name: '포처', desc: '박스 안에서 마무리 — 수비 가담 적음', atk: { BOX_RUN: 12, MAKE_RUN: 4 }, def: { HOLD_POSITION: 6, PRESS_BALL: -3 }, da: 2 },
    { id: 'false9', name: '가짜 공격수', desc: '내려와서 연계 · 공간 만들기', atk: { FIND_SPACE: 14, SUPPORT_ATTACK: 10, MAKE_RUN: -10, BOX_RUN: -10 }, da: -8 },
    { id: 'runner', name: '침투형', desc: '수비 뒷공간으로 계속 침투', atk: { MAKE_RUN: 14, BOX_RUN: 6 }, da: 4 },
    { id: 'target', name: '타깃형', desc: '중앙에서 버티며 공중볼 · 등지는 플레이', atk: { HOLD_POSITION: 10, MAKE_RUN: -6, BOX_RUN: 8 }, w: 0.6 },
    { id: 'pressfw', name: '압박형 공격수', desc: '최전방부터 수비 압박', def: { PRESS_BALL: 10 }, dd: 4 },
  ],
  WG: [
    { id: 'winger', name: '윙어', desc: '측면에 붙어 돌파 · 크로스', atk: { MOVE_WIDE: 12 }, w: 1.1 },
    { id: 'inside', name: '인사이드 포워드', desc: '안쪽으로 파고들어 슈팅', atk: { BOX_RUN: 12, MAKE_RUN: 6, MOVE_WIDE: -8 }, w: 0.75 },
    { id: 'wingdef', name: '수비형 윙어', desc: '수비 가담 많이', def: { MARK_OPPONENT: 8, RECOVER_DEFENSIVE_SHAPE: 8 }, dd: -4 },
  ],
  CAM: [
    { id: 'playmaker', name: '플레이메이커', desc: '공간을 찾아 공을 받고 뿌림', atk: { FIND_SPACE: 10, MAKE_RUN: -4 }, da: -2 },
    { id: 'shadow', name: '섀도 스트라이커', desc: '최전방 뒤에서 박스로 침투', atk: { BOX_RUN: 12, MAKE_RUN: 8 }, da: 4 },
  ],
  CM: [
    { id: 'b2b', name: '박스 투 박스', desc: '공수 양쪽 다 뛰어다님', atk: { SUPPORT_ATTACK: 6, BOX_RUN: 6 }, def: { PRESS_BALL: 4 } },
    { id: 'deeplying', name: '딥라잉 플레이메이커', desc: '뒤에서 공을 받아 경기 조율', atk: { HOLD_POSITION: 6, FIND_SPACE: 6, MAKE_RUN: -8, BOX_RUN: -10 }, da: -5 },
    { id: 'mezzala', name: '메찰라', desc: '측면 하프스페이스로 침투', atk: { MAKE_RUN: 10, MOVE_WIDE: 6 }, da: 3, w: 1.15 },
  ],
  CDM: [
    { id: 'anchor', name: '앵커', desc: '수비진 앞을 지킴', atk: { HOLD_POSITION: 10, MAKE_RUN: -8 }, def: { COVER_SPACE: 8 }, da: -3 },
    { id: 'ballwinner', name: '볼 위닝', desc: '적극적으로 공을 뺏으러 감', def: { PRESS_BALL: 10, MARK_OPPONENT: 6 }, dd: 2 },
    { id: 'regista', name: '레지스타', desc: '깊은 곳에서 공격 전개', atk: { FIND_SPACE: 10, SUPPORT_ATTACK: 6 } },
  ],
  FB: [
    { id: 'attfb', name: '공격적 풀백', desc: '자주 오버래핑', atk: { OVERLAP: 14, MOVE_WIDE: 6, SUPPORT_ATTACK: 6 }, da: 5 },
    { id: 'deffb', name: '수비적 풀백', desc: '자리를 지키며 수비 우선', atk: { HOLD_POSITION: 10, OVERLAP: -20 }, da: -5 },
    { id: 'invfb', name: '인버티드 풀백', desc: '공격 시 중앙으로 좁혀 미드필더처럼', atk: { SUPPORT_ATTACK: 8, MOVE_WIDE: -10, OVERLAP: -10 }, w: 0.5 },
  ],
  CB: [
    { id: 'stopper', name: '스토퍼', desc: '앞으로 나가 상대 공격수를 막음', def: { MARK_OPPONENT: 8, PRESS_BALL: 4 }, dd: 2 },
    { id: 'cover', name: '커버', desc: '뒤에 남아 뒷공간 커버', def: { COVER_SPACE: 8, TRACK_RUNNER: 6 }, dd: -2 },
    { id: 'bpd', name: '볼 플레잉 수비수', desc: '공격 시 조금 올라가 전개에 참여', atk: { SUPPORT_ATTACK: 6 }, da: 3 },
  ],
  GK: [
    { id: 'linegk', name: '라인 키퍼', desc: '골라인 근처를 지킴' },
    { id: 'sweeper', name: '스위퍼 키퍼', desc: '앞으로 나와 뒷공간 커버' },
  ],
};
const roleGroup = pos => ({ ST: 'ST', LW: 'WG', RW: 'WG', CAM: 'CAM', CM: 'CM', CDM: 'CDM', LB: 'FB', RB: 'FB', CB: 'CB', GK: 'GK' }[pos] || 'CM');
const TAC_ROLE_BY_ID = Object.fromEntries(Object.values(TAC_ROLES).flat().map(r => [r.id, r]));
function ensureTactics() {
  const T = userSetup.tactics = userSetup.tactics || {};
  if (!DEF_STYLES.some(x => x.id === T.def)) T.def = 'balance';
  if (!ATK_STYLES.some(x => x.id === T.atk)) T.atk = 'balance';
  if (!T.roles || typeof T.roles !== 'object') T.roles = {};
  return T;
}
/** 선발 i번 자리의 역할 (그 자리 포지션에 맞는 것만, 없으면 기본 첫 번째) */
function tacRoleOf(i) {
  const T = ensureTactics();
  const slot = getFormationSlots(userSetup.formation)[i];
  const list = TAC_ROLES[roleGroup(slot?.position)] || [];
  return (list.find(r => r.id === T.roles[i]) || list[0])?.id || null;
}
const teamTac = isBlue => (isBlue ? ensureTactics() : { def: 'balance', atk: 'balance' });

/** 팀 전체가 하나의 블록처럼 움직이는 기본 자리.
 *  · 수비 라인 높이가 공 위치에 따라 오르내리고, 미드필더·공격수는 그 위에 일정 간격으로 선다
 *  · 수비할 땐 세로로 촘촘하고 좁게, 공격할 땐 넓고 길게
 *  · 블록 전체가 공 쪽으로 옆으로 미끄러짐 */
function shapePoint(p, situation) {
  const atk = p.isBlue ? 1 : -1;
  const ownGoal = -atk * FIELD_W / 2;
  const posStat = statMul(p, 'positioning');
  const car = ball.owner || ball.holdByGk;
  // 우리 팀이 몰고 올라가면 1초쯤 뒤 공 위치를 기준으로 미리 같이 올라감
  const leadX = car && car.isBlue === p.isBlue ? car.vx * 45 : 0;
  const ballDepth = (ball.x + leadX - ownGoal) * atk;   // 우리 골라인에서 공까지 거리
  const attack = situation === 'attack';
  const TT = teamTac(p.isBlue), R = TAC_ROLE_BY_ID[p.tacRole] || {};
  // 수비 스타일: 라인 높이 · 촘촘함
  const dLine = TT.def === 'deep' ? -6 : TT.def === 'press' ? 6 : 0;
  const lineDepth = attack
    ? clamp(ballDepth - 24 + (TT.atk === 'counter' ? -3 : 0), 14, FIELD_W * 0.55)
    : clamp(ballDepth - 15 + dLine, 9, FIELD_W * (TT.def === 'press' ? 0.5 : TT.def === 'deep' ? 0.34 : 0.42));
  const compact = attack ? (TT.atk === 'possession' ? 0.72 : 0.82) : (TT.def === 'deep' ? 0.5 : 0.6);
  const backDepth = 21 * FSCALE;                        // 포백의 기본 깊이
  let depth = lineDepth + ((p.slotDepth ?? backDepth) - backDepth) * compact;
  if (p.role === 'ST' && !attack) depth = Math.min(depth, Math.max(lineDepth + 30, ballDepth - 3)); // 최전방은 공 근처에서 대기
  depth += (posStat - 0.9) * 6;
  depth += attack ? (R.da || 0) + (TT.atk === 'counter' && (p.role === 'ST' || p.role === 'WG') ? 5 : 0) : (R.dd || 0); // 역할 · 역습
  // 약간의 자유로움: 선수마다 천천히 다른 방향으로 흔들림
  const wander = Math.sin(simTime / 2300 + p.num * 1.7) * (1.5 + dumb(p) * 6);
  const x = ownGoal + atk * (depth + wander);
  const width = (attack ? (TT.atk === 'wing' ? 1.12 : TT.atk === 'possession' ? 0.92 : 1.0) * (R.w || 1) : (TT.def === 'zonal' ? 0.8 : 0.72));
  const slide = attack ? 0.16 : (TT.def === 'zonal' ? 0.2 : 0.32);
  const z = p.homeZ * width + ball.z * slide + Math.cos(simTime / 2900 + p.num) * 1.2;
  return {
    x: clamp(x, -FIELD_W / 2 + 3, FIELD_W / 2 - 3),
    z: clamp(z, -FIELD_H / 2 + 2.5, FIELD_H / 2 - 2.5),
  };
}

/** 자기 자리에서 너무 멀리 가지 않게 (포지션마다 허용 반경) */
const LEASH = { CB: 9, FB: 15, MF: 15, WG: 16, ST: 16 };
const FREE_ACTIONS = new Set(['PRESS_BALL', 'RECEIVE_BALL', 'RUN_IN_BEHIND', 'OVERLAP', 'BOX_RUN', 'SCREEN', 'MAKE_RUN', 'FIND_SPACE']);
function leashPoint(p, action, tx, tz, shape) {
  if (FREE_ACTIONS.has(action)) return [tx, tz];
  const r = (LEASH[p.role] || 14) * (action === 'TRACK_RUNNER' ? 1.4 : 1) * (1 + dumb(p) * 0.8);
  const dx = tx - shape.x, dz = tz - shape.z;
  const d = Math.hypot(dx, dz);
  if (d <= r) return [tx, tz];
  return [shape.x + dx / d * r, shape.z + dz / d * r];
}

function separatePoint(p, tx, tz) {
  const mates = p.isBlue ? teamA : teamB;
  for (const m of mates) {
    if (m === p || m.sentOff || m.role === 'GK') continue;
    const dx = tx - m.x, dz = tz - m.z;
    const d = Math.hypot(dx, dz);
    if (d < 5 && d > 0.05) {
      tx += (dx / d) * (5 - d) * 0.6;
      tz += (dz / d) * (5 - d) * 0.6;
    }
  }
  return {
    x: clamp(tx, -FIELD_W / 2 + 2, FIELD_W / 2 - 2),
    z: clamp(tz, -FIELD_H / 2 + 2, FIELD_H / 2 - 2),
  };
}

function pickPresser(isBlue) {
  const keyT = isBlue ? 'bluePressT' : 'redPressT';
  const keyP = isBlue ? 'bluePress' : 'redPress';
  const carrier = ball.owner || ball.holdByGk;
  const theyHave = !carrier || carrier.isBlue !== isBlue;
  if (!theyHave && carrier) {
    teamAi[keyP] = null;
    return null;
  }
  teamAi[keyT] = Math.max(0, teamAi[keyT] - 1);
  const team = fieldPlayers(isBlue ? teamA : teamB).filter(p => p.role !== 'GK');
  const keyC = isBlue ? 'blueCover' : 'redCover';
  if (!carrier) {
    // 루즈볼: 공에 가장 빨리 닿는 선수가 간다 (예측 궤적 기준)
    let best = null, second = null, bk = Infinity, sk = Infinity;
    for (const p of team) {
      if (isBlue && p === getActive()) continue;
      const k = predictIntercept(p).k;
      if (k < bk) { second = best; sk = bk; best = p; bk = k; }
      else if (k < sk) { second = p; sk = k; }
    }
    teamAi[keyP] = best;
    teamAi[keyC] = second;
    teamAi[keyT] = 10;
    return best;
  }
  // 공 가진 상대를 '골문 쪽에서' 가장 빨리 막을 수 있는 선수가 압박
  const atk = isBlue ? 1 : -1;
  const ownGoalX = -atk * FIELD_W / 2;
  const danger = Math.hypot(carrier.x - ownGoalX, carrier.z) < 32; // 우리 골문 근처
  const carrierDepth = (carrier.x - ownGoalX) * atk;
  if (carrierDepth > FIELD_W * 0.68 && !carrier.role?.includes?.('GK')) {
    // 상대가 자기 진영 깊은 곳에서 공을 돌리면 대형 유지 (가까운 1명만 견제)
    let near = null, nd = 12;
    for (const p of team) {
      if (isBlue && p === getActive()) continue;
      const d = dist2(p, carrier);
      if (d < nd) { nd = d; near = p; }
    }
    teamAi[keyP] = near;
    teamAi[keyC] = null;
    teamAi.danger = teamAi.danger || {};
    teamAi.danger[isBlue ? 'blue' : 'red'] = false;
    return near;
  }
  const look = isBlue ? 12 : 12 * oppIQ();
  const fx = carrier.x + carrier.vx * look, fz = carrier.z + carrier.vz * look;
  const [gx, gz] = norm2(ownGoalX - fx, -fz);
  const px = fx + gx * 1.2, pz = fz + gz * 1.2;
  let best = null, bestS = -Infinity, second = null, secondS = -Infinity;
  for (const p of team) {
    if (isBlue && p === getActive()) continue;
    const spd = SPRINT * 0.85 * statMul(p, 'speed') * sprintMult(p);
    const t = Math.hypot(px - p.x, pz - p.z) / spd;
    let sc = -t;
    if ((carrier.x - p.x) * atk > -0.5) sc += 10;          // 이미 골문 쪽에 있음
    if (!danger && p.role === 'CB') sc -= 18;              // 멀 땐 센터백은 라인 유지
    if (!danger && p.role === 'ST') sc -= 8;
    sc += (p.playerAttributes?.defense || 0.5) * 6;
    if ((p.stamina || 0) < 25 && !danger) sc -= 20;
    if (p === teamAi[keyP] && teamAi[keyT] > 0) sc += 12;   // 담당 자주 안 바뀌게
    if (sc > bestS) { second = best; secondS = bestS; bestS = sc; best = p; }
    else if (sc > secondS) { secondS = sc; second = p; }
  }
  if (best !== teamAi[keyP]) teamAi[keyT] = 40;
  teamAi[keyP] = best;
  teamAi[keyC] = second;
  teamAi.danger = teamAi.danger || {};
  teamAi.danger[isBlue ? 'blue' : 'red'] = danger;
  return teamAi[keyP];
}

function updateTeamAi() {
  const carrier = ball.owner || ball.holdByGk;
  const poss = !carrier ? 'loose' : carrier.isBlue ? 'blue' : 'red';
  if (poss !== teamAi.poss) {
    teamAi.poss = poss;
    teamAi.possFlip = 10;
    teamAi.blueOverlap = null;
    teamAi.redOverlap = null;
  } else if (teamAi.possFlip > 0) teamAi.possFlip--;
  teamAi.bluePress = pickPresser(true);
  teamAi.redPress = pickPresser(false);
}

const ATTACK_WEIGHT = {
  ST: { MAKE_RUN: 26, FIND_SPACE: 20, SUPPORT_ATTACK: 12, HOLD_POSITION: 4, MOVE_WIDE: 2 },
  LW: { MOVE_WIDE: 24, MAKE_RUN: 14, FIND_SPACE: 14, SUPPORT_ATTACK: 10, HOLD_POSITION: 4 },
  RW: { MOVE_WIDE: 24, MAKE_RUN: 14, FIND_SPACE: 14, SUPPORT_ATTACK: 10, HOLD_POSITION: 4 },
  CM: { SUPPORT_ATTACK: 22, FIND_SPACE: 18, MAKE_RUN: 8, HOLD_POSITION: 8, COVER_SPACE: 4 },
  CAM: { FIND_SPACE: 22, SUPPORT_ATTACK: 16, MAKE_RUN: 14, HOLD_POSITION: 4 },
  CDM: { HOLD_POSITION: 20, COVER_SPACE: 18, SUPPORT_ATTACK: 10, MAKE_RUN: 2, FIND_SPACE: 6 },
  CB: { HOLD_POSITION: 26, RECOVER_DEFENSIVE_SHAPE: 14, SUPPORT_ATTACK: 3, MAKE_RUN: 1 },
  LB: { MOVE_WIDE: 16, SUPPORT_ATTACK: 14, HOLD_POSITION: 12, MAKE_RUN: 7, COVER_SPACE: 6 },
  RB: { MOVE_WIDE: 16, SUPPORT_ATTACK: 14, HOLD_POSITION: 12, MAKE_RUN: 7, COVER_SPACE: 6 },
};
const DEFEND_WEIGHT = {
  ST: { HOLD_POSITION: 14, PRESS_BALL: 4, COVER_SPACE: 4, FIND_SPACE: 6 },
  LW: { MOVE_WIDE: 10, HOLD_POSITION: 10, PRESS_BALL: 4, MARK_OPPONENT: 6 },
  RW: { MOVE_WIDE: 10, HOLD_POSITION: 10, PRESS_BALL: 4, MARK_OPPONENT: 6 },
  CM: { COVER_SPACE: 16, PRESS_BALL: 6, MARK_OPPONENT: 8, RECOVER_DEFENSIVE_SHAPE: 8 },
  CAM: { COVER_SPACE: 10, PRESS_BALL: 6, FIND_SPACE: 6, HOLD_POSITION: 8 },
  CDM: { COVER_SPACE: 24, MARK_OPPONENT: 10, RECOVER_DEFENSIVE_SHAPE: 12, PRESS_BALL: 4 },
  CB: { COVER_SPACE: 22, MARK_OPPONENT: 16, TRACK_RUNNER: 18, RECOVER_DEFENSIVE_SHAPE: 14, PRESS_BALL: 2 },
  LB: { MARK_OPPONENT: 20, TRACK_RUNNER: 12, COVER_SPACE: 10, PRESS_BALL: 4, RECOVER_DEFENSIVE_SHAPE: 8 },
  RB: { MARK_OPPONENT: 20, TRACK_RUNNER: 12, COVER_SPACE: 10, PRESS_BALL: 4, RECOVER_DEFENSIVE_SHAPE: 8 },
};

function scoreAction(p, situation, presser) {
  const scores = {
    HOLD_POSITION: 6, SUPPORT_ATTACK: 0, MAKE_RUN: 0, MOVE_WIDE: 0, FIND_SPACE: 0,
    PRESS_BALL: 0, COVER_SPACE: 0, MARK_OPPONENT: 0, RECOVER_DEFENSIVE_SHAPE: 0,
    RECEIVE_BALL: 0, TRACK_RUNNER: 0, OVERLAP: 0, BOX_RUN: 0,
  };
  const table = situation === 'defend' ? DEFEND_WEIGHT : ATTACK_WEIGHT;
  const row = table[p.position] || table.CM || {};
  for (const [k, v] of Object.entries(row)) scores[k] += v;
  // 전술: 선수 역할 · 팀 공격/수비 스타일
  const R = TAC_ROLE_BY_ID[p.tacRole], TT = teamTac(p.isBlue);
  if (R) for (const [k, v] of Object.entries((situation === 'defend' ? R.def : R.atk) || {})) scores[k] = (scores[k] || 0) + v;
  if (situation === 'attack') {
    if (TT.atk === 'possession') { scores.FIND_SPACE += 8; scores.SUPPORT_ATTACK += 6; scores.MAKE_RUN -= 6; }
    if (TT.atk === 'counter' && (p.role === 'ST' || p.role === 'WG')) scores.MAKE_RUN += 10;
    if (TT.atk === 'wing') { scores.MOVE_WIDE += p.role === 'WG' || p.role === 'FB' ? 10 : 0; scores.OVERLAP += p.role === 'FB' ? 10 : 0; }
    if (TT.atk === 'direct' && (p.role === 'ST' || p.position === 'CAM')) { scores.MAKE_RUN += 10; scores.BOX_RUN += 6; }
  } else if (situation === 'defend') {
    if (TT.def === 'press' && p.role !== 'CB' && dist2(p, ball) < 13) scores.PRESS_BALL += 16; // 두 번째 압박
    if (TT.def === 'deep') { scores.PRESS_BALL -= 4; scores.COVER_SPACE += 6; scores.RECOVER_DEFENSIVE_SHAPE += 6; }
    if (TT.def === 'zonal') { scores.MARK_OPPONENT -= 10; scores.COVER_SPACE += 10; }
  }
  if (situation === 'loose') {
    scores.RECEIVE_BALL += p === presser ? 18 : 2;
    scores.PRESS_BALL += p === presser ? 10 : -8;
    scores.HOLD_POSITION += p.position === 'CB' || p.position === 'CDM' ? 8 : 0;
  }
  if (situation === 'attack') {
    scores.PRESS_BALL -= 12;
    if (!runLaneOpen(p)) scores.MAKE_RUN -= 16;
    else if (p.position === 'ST' || p.position === 'LW' || p.position === 'RW' || p.position === 'CAM') scores.MAKE_RUN += 6;
    const carrier = ball.owner || ball.holdByGk;
    if (carrier && carrier !== p) {
      const passDist = dist2(p, carrier);
      if (passDist > 8 && passDist < 28) scores.FIND_SPACE += 6;
      if (passDist < 5) scores.SUPPORT_ATTACK -= 8;
      const atk = p.isBlue ? 1 : -1;
      // 공 가진 동료가 압박받으면 가까운 두 명이 빈 공간으로 빠져 패스길을 만들어 줌
      const pressOn = nearestOppDist(carrier.x, carrier.z, carrier.isBlue) < 4.5;
      if (pressOn) {
        const helpers = fieldPlayers(p.isBlue ? teamA : teamB)
          .filter(m => m !== carrier && m.role !== 'GK')
          .sort((a, b) => dist2(a, carrier) - dist2(b, carrier)).slice(0, 2);
        if (helpers.includes(p)) scores.FIND_SPACE += 32;
      }
      // 동료가 앞으로 몰고 올라가면 공격진은 침투, 미드필더는 따라붙음
      const forward = carrier.vx * atk > 0.05;
      if (forward) {
        if (p.role === 'ST' || p.role === 'WG' || p.position === 'CAM') scores.MAKE_RUN += 16;
        if (p.role === 'MF') scores.FIND_SPACE += 10;
        if (p.role !== 'CB') scores.HOLD_POSITION -= 8;
      }
      if (carrier.x * atk > 0 && p.role !== 'CB' && p.role !== 'GK') scores.HOLD_POSITION -= 6;
      const goalX = atk * FIELD_W / 2;
      const side = Math.sign(p.homeZ) || 1;
      const cz = carrier.z;
      // 오버래핑: 같은 쪽 측면에서 공 가진 동료를 바깥으로 돌아 앞질러 감
      const key = p.isBlue ? 'blueOverlap' : 'redOverlap';
      if (p.role === 'FB' && Math.sign(cz) === side && Math.abs(cz) > 5 &&
          (carrier.x - p.x) * atk > 0 && carrier.x * atk > -14 && (p.stamina || 0) > 40 &&
          (!teamAi[key] || teamAi[key] === p)) {
        scores.OVERLAP += 42;
      }
      // 마지막 3분의 1 지역: 박스 안으로 침투
      if ((goalX - carrier.x) * atk < 34) {
        if (p.role === 'ST') scores.BOX_RUN += 34;
        if (p.role === 'WG' && Math.sign(p.homeZ) !== Math.sign(cz || 1)) scores.BOX_RUN += 30;
        if (p.position === 'CAM') scores.BOX_RUN += 20;
        if (p.position === 'CM' && p.num % 2 === 0) scores.BOX_RUN += 16;
      }
    }
  }
  if (situation === 'defend') {
    if (p === presser) scores.PRESS_BALL += 28;
    else scores.PRESS_BALL -= 18;
    if (dangerousRunner(p)) scores.TRACK_RUNNER += p.position === 'CB' || p.position === 'LB' || p.position === 'RB' ? 10 : 2;
  }
  const stam = (p.stamina || 100) / 100;
  if (stam < 0.55) {
    scores.MAKE_RUN -= 8;
    scores.PRESS_BALL -= 6;
    scores.FIND_SPACE -= 4;
    scores.HOLD_POSITION += 6;
  }
  if (stam < 0.35) {
    scores.MAKE_RUN -= 14;
    scores.PRESS_BALL -= 16;
    scores.TRACK_RUNNER -= 8;
    scores.FIND_SPACE -= 8;
    scores.HOLD_POSITION += 16;
    scores.COVER_SPACE += 6;
  }
  if (stam < 0.22) {
    scores.PRESS_BALL = -40;
    scores.MAKE_RUN = -30;
    scores.HOLD_POSITION += 20;
  }
  scores[p.currentAction] = (scores[p.currentAction] || 0) + (teamAi.possFlip > 0 ? 0 : 7);
  p.actionScores = scores;
  let best = p.currentAction || 'HOLD_POSITION';
  let bestS = -Infinity;
  for (const [k, v] of Object.entries(scores)) {
    if (v > bestS) { bestS = v; best = k; }
  }
  return best;
}

// 공 궤적 예측 (매 프레임 1번 계산해서 모든 선수가 공유)
const BALL_PATH_N = 100;
const ballPath = new Float32Array(BALL_PATH_N * 3);
let ballPathLen = 0;
function computeBallPath() {
  ballPathLen = 0;
  if (ball.owner || ball.holdByGk) return;
  const s = { x: ball.x, y: ball.y, z: ball.z, vx: ball.vx, vy: ball.vy, vz: ball.vz, wx: ball.wx, wy: ball.wy, wz: ball.wz, inGoal: ball.inGoal };
  for (let i = 0; i < BALL_PATH_N; i++) {
    stepBallPhysics(s);
    ballPath[i * 3] = s.x;
    ballPath[i * 3 + 1] = s.y;
    ballPath[i * 3 + 2] = s.z;
    ballPathLen++;
    if (Math.abs(s.x) > FIELD_W / 2 + 2 || Math.abs(s.z) > FIELD_H / 2 + 2) break;
  }
}

/** 이 선수가 공을 가장 빨리 따라잡을 수 있는 지점과 프레임 */
function predictIntercept(p, forwardOnly = false) {
  if (!ballPathLen) return { x: ball.x, z: ball.z, k: dist2(p, ball) / (SPRINT * 0.9) };
  const spd = (p.role === 'GK' ? SPRINT * 0.85 : SPRINT * 0.92) * statMul(p, 'speed') * sprintMult(p);
  // 받는 선수: 공이 뒤에서 날아오면 뒤로 돌아가지 말고, 공이 가는 방향(앞쪽)에서 만남
  const bs = Math.hypot(ball.vx, ball.vz);
  const fwd = forwardOnly && bs > 0.12;
  const bdx = fwd ? ball.vx / bs : 0, bdz = fwd ? ball.vz / bs : 0;
  for (let k = 0; k < ballPathLen; k++) {
    const x = ballPath[k * 3], y = ballPath[k * 3 + 1], z = ballPath[k * 3 + 2];
    if (y > 2.1) continue;
    if (fwd && (x - p.x) * bdx + (z - p.z) * bdz < -0.4) continue; // 선수 뒤쪽 지점은 건너뜀
    if (Math.hypot(x - p.x, z - p.z) - 0.8 <= spd * (k + 1)) return { x, z, k: k + 1 };
  }
  const k = ballPathLen - 1;
  const x = ballPath[k * 3], z = ballPath[k * 3 + 2];
  return { x, z, k: ballPathLen + Math.hypot(x - p.x, z - p.z) / spd };
}

/** 공 가진 동료가 패스하기 좋은 '빈 공간' — 상대와 멀고, 패스길이 열려 있고, 되도록 앞쪽 */
function findOpenSpot(p, carrier) {
  if (p.openSpot && p.openSpotT > 0) { p.openSpotT--; return p.openSpot; }
  const atk = p.isBlue ? 1 : -1;
  const opps = fieldPlayers(p.isBlue ? teamB : teamA);
  const mates = fieldPlayers(p.isBlue ? teamA : teamB);
  const line = offsideLineX(p.isBlue);
  const cap = p.isBlue ? Math.max(line, ball.x) - 0.7 : Math.min(line, ball.x) + 0.7;
  let best = null, bestS = -Infinity;
  for (const r of [9, 13, 18]) {
    for (let deg = -120; deg <= 120; deg += 30) {
      const a = deg * Math.PI / 180;
      let x = carrier.x + Math.cos(a) * atk * r;
      let z = carrier.z + Math.sin(a) * r;
      x = p.isBlue ? Math.min(x, cap) : Math.max(x, cap);          // 오프사이드 안 걸리게
      x = clamp(x, -FIELD_W / 2 + 3, FIELD_W / 2 - 3);
      z = clamp(z, -FIELD_H / 2 + 2.5, FIELD_H / 2 - 2.5);
      let oppD = 99;
      for (const o of opps) oppD = Math.min(oppD, Math.hypot(o.x - x, o.z - z));
      let mateCrowd = 0;
      for (const m of mates) if (m !== p && m !== carrier && Math.hypot(m.x - x, m.z - z) < 7) mateCrowd++;
      const risk = laneRisk(carrier.x, carrier.z, x, z, 0.7, p.isBlue);
      const sc = Math.min(oppD, 10) * 1.6 - risk * 12 + (x - carrier.x) * atk * 0.35
        - Math.hypot(x - p.x, z - p.z) * 0.25 - mateCrowd * 6;
      if (sc > bestS) { bestS = sc; best = { x, z }; }
    }
  }
  p.openSpot = best;
  p.openSpotT = 12;
  return best;
}

/** 상대 수비 라인에서 가장 넓게 벌어진 틈 (침투할 통로) */
function findChannelZ(p) {
  const atk = p.isBlue ? 1 : -1;
  const line = offsideLineX(p.isBlue);
  const zs = fieldPlayers(p.isBlue ? teamB : teamA)
    .filter(o => o.role !== 'GK' && Math.abs(o.x - line) < 10).map(o => o.z).sort((a, b) => a - b);
  const edges = [-FIELD_H / 2 + 4, ...zs, FIELD_H / 2 - 4];
  let best = p.z, bestS = -Infinity;
  for (let i = 0; i < edges.length - 1; i++) {
    const w = edges[i + 1] - edges[i];
    const mid = (edges[i] + edges[i + 1]) / 2;
    const sc = w - Math.abs(mid - p.z) * 0.45 - Math.abs(mid) * 0.08;
    if (sc > bestS) { bestS = sc; best = mid; }
  }
  return best;
}

function receivePoint(p) {
  const m = predictIntercept(p, true);
  return {
    x: clamp(m.x, -FIELD_W / 2 + 0.5, FIELD_W / 2 - 0.5),
    z: clamp(m.z, -FIELD_H / 2 + 0.5, FIELD_H / 2 - 0.5),
  };
}

function desiredTarget(p, action) {
  const atk = p.isBlue ? 1 : -1;
  const pos = p.position;
  const carrier = ball.owner || ball.holdByGk;
  const side = p.homeZ < 0 ? -1 : 1;
  const situation = matchSituation(p);
  const shape = shapePoint(p, situation);
  let tx = shape.x;
  let tz = shape.z;
  const line = offsideLineX(p.isBlue);

  if (action === 'MOVE_WIDE') {
    tx = shape.x + atk * 3;
    tz = side * (FIELD_H / 2 - 6.5);
    // 같은 쪽 풀백이 오버래핑 중이면 윙어는 안쪽으로
    const fb = (p.isBlue ? teamA : teamB).find(m => m !== p && m.role === 'FB' && Math.sign(m.homeZ) === side);
    if (fb && (fb.x - p.homeX) * atk > 6 && p.role === 'WG') tz = side * 10;
  } else if (action === 'MAKE_RUN') {
    const cap = p.isBlue ? line - 1.1 : line + 1.1;
    tx = p.x + atk * (8 + (p.playerAttributes?.positioning || 0.5) * 4 * (0.85 + statMul(p, 'positioning') * 0.25));
    tx = p.isBlue ? Math.min(tx, cap, FIELD_W / 2 - 8) : Math.max(tx, cap, -FIELD_W / 2 + 8);
    // 수비수 사이 빈 틈으로 대각선 침투, 라인에 붙어서 스루패스를 기다림
    tz = lerp(p.z, findChannelZ(p), 0.7);
  } else if (action === 'FIND_SPACE') {
    if (carrier && carrier.isBlue === p.isBlue) {
      const spot = findOpenSpot(p, carrier);
      tx = spot.x; tz = spot.z;
    } else {
      const cx = carrier ? carrier.x : ball.x;
      const cz = carrier ? carrier.z : ball.z;
      tx = cx + atk * (pos === 'CDM' ? -5 : 7);
      tz = cz + side * (pos === 'ST' ? 3.5 : 8);
    }
  } else if (action === 'SUPPORT_ATTACK') {
    const cx = carrier ? carrier.x : ball.x;
    const cz = carrier ? carrier.z : ball.z;
    tx = cx - atk * 5;
    tz = cz + side * 6.5;
  } else if (action === 'PRESS_BALL') {
    // 골문 쪽으로 돌아가 길을 막고(jockey), 가까워지면 공을 향해 태클
    const own = -atk * (FIELD_W / 2);
    const c = ball.owner || null;
    const lead = c ? clamp(dist2(p, ball) / 0.18, 0, 14) : 0;
    const fx = ball.x + (c ? c.vx * lead : 0), fz = ball.z + (c ? c.vz * lead : 0);
    const [gx, gz] = norm2(own - fx, -fz);
    const goalSide = (ball.x - p.x) * atk > -0.3;
    if (p.lunge > 0 || (!c && dist2(p, ball) < 1.9)) { tx = ball.x; tz = ball.z; } // 태클 들어감
    else {
      // 골문 쪽에서 일정 거리를 두고 같이 움직이며 길을 막음
      const keep = !goalSide ? 0.8 : teamAi.danger?.[p.isBlue ? 'blue' : 'red'] ? 1.7 : 2.6;
      tx = fx + gx * keep; tz = fz + gz * keep;
    }
  } else if (action === 'OVERLAP') {
    const c = carrier || ball;
    const cap = p.isBlue ? Math.max(line, ball.x) - 0.8 : Math.min(line, ball.x) + 0.8;
    tx = c.x + atk * 10;
    tx = p.isBlue ? Math.min(tx, cap, FIELD_W / 2 - 6) : Math.max(tx, cap, -FIELD_W / 2 + 6);
    tz = side * (FIELD_H / 2 - 4);
  } else if (action === 'BOX_RUN') {
    const goalX = atk * FIELD_W / 2;
    const cz = Math.sign((carrier || ball).z || 1);
    if (p.role === 'ST') { tx = goalX - atk * 6.5; tz = cz * 2.5; }            // 니어 포스트
    else if (p.role === 'WG') { tx = goalX - atk * 7.5; tz = -cz * 5; }          // 파 포스트
    else if (p.position === 'CAM') { tx = goalX - atk * 12; tz = -cz * 1; }      // 페널티 스팟
    else { tx = goalX - atk * 19; tz = -cz * 4; }                                 // 박스 바깥 세컨볼
    const cap = p.isBlue ? Math.max(line, ball.x) - 0.6 : Math.min(line, ball.x) + 0.6;
    tx = p.isBlue ? Math.min(tx, cap) : Math.max(tx, cap);
  } else if (action === 'RUN_IN_BEHIND') {
    tx = p.runTarget ? p.runTarget.x : tx;
    tz = p.runTarget ? p.runTarget.z : tz;
  } else if (action === 'SCREEN') {
    // 2번째 수비수: 공과 골문 사이 + 가장 위험한 패스 길목
    const own = -atk * (FIELD_W / 2);
    const [gx, gz] = norm2(own - ball.x, -ball.z);
    const danger = dangerousRunner(p) || markTarget(p);
    const near = teamAi.danger?.[p.isBlue ? 'blue' : 'red'];
    const gap = near ? 3 : 6;
    tx = ball.x + gx * gap;
    tz = ball.z + gz * gap;
    if (danger && !near) { tx = lerp(tx, (ball.x + danger.x) / 2, 0.5); tz = lerp(tz, (ball.z + danger.z) / 2, 0.5); }
  } else if (action === 'COVER_SPACE') {
    const own = -atk * (FIELD_W / 2);
    tx = lerp(shape.x, (ball.x * 0.45 + own * 0.55), 0.55);
    tz = lerp(shape.z, ball.z * 0.28, 0.45);
  } else if (action === 'MARK_OPPONENT') {
    const mark = markTarget(p);
    if (mark) { tx = mark.x - atk * 1.8; tz = mark.z; }
  } else if (action === 'TRACK_RUNNER') {
    const runner = dangerousRunner(p);
    if (runner) { tx = runner.x - atk * 2.2; tz = runner.z; }
  } else if (action === 'RECEIVE_BALL') {
    // 띄운 패스는 낙하지점으로, 땅볼은 공과 만날 지점으로
    if (p.lobLand && p.lobLand.ttl > 0) p.lobLand.ttl--;
    const meet = p.lobLand && p.lobLand.ttl > 0 && !ball.owner && (ball.y > 0.5 || Math.hypot(ball.vx, ball.vz) > 0.15 && dist2(p, ball) > 3) ? p.lobLand : receivePoint(p);
    if (p.lobLand && (ball.owner || ball.holdByGk || p.lobLand.ttl <= 0)) p.lobLand = null;
    tx = meet.x;
    tz = meet.z;
  } else if (action === 'RECOVER_DEFENSIVE_SHAPE' || action === 'HOLD_POSITION') {
    tx = shape.x;
    tz = shape.z;
  }
  if (action === 'PRESS_BALL' || action === 'RECEIVE_BALL' || action === 'SCREEN' || action === 'RUN_IN_BEHIND') {
    return {
      x: clamp(tx, -FIELD_W / 2 + 1, FIELD_W / 2 - 1),
      z: clamp(tz, -FIELD_H / 2 + 1, FIELD_H / 2 - 1),
    };
  }
  [tx, tz] = leashPoint(p, action, tx, tz, shape);
  return separatePoint(p, tx, tz);
}

function canAiSprint(p, urgency = 0.5) {
  const st = p.stamina || 0;
  if (st < 28) return false;
  if (st < 42 && urgency < 0.75) return false;
  if (st < 58 && urgency < 0.45) return false;
  return true;
}

/** 붙어서 기다리다가 기회가 오면 태클 (상대가 등을 돌림 / 터치가 길어짐 / 골문 근처 / 오래 버팀) */
function decideLunge(p) {
  if (p.lunge > 0) { p.lunge--; return; }
  const c = ball.owner;
  if (!c || c.isBlue === p.isBlue) return;
  const d = dist2(p, c);
  if (d > 3.4) { p.containT = 0; return; }
  p.containT = (p.containT || 0) + 1;
  const atk = p.isBlue ? 1 : -1;
  const ownGoal = -atk * FIELD_W / 2;
  const [gx, gz] = norm2(ownGoal - c.x, -c.z);
  const facingAway = (c.faceX * gx + c.faceZ * gz) < -0.2;          // 공격수가 골문을 등짐
  const looseTouch = dist2(c, ball) > 0.7 && Math.hypot(c.vx, c.vz) > 0.15; // 빠르게 몰면서 공이 발에서 멂
  const danger = teamAi.danger?.[p.isBlue ? 'blue' : 'red'];
  const def = statMul(p, 'defense');
  let chance = 0.006 + def * 0.006 + dumb(p) * 0.03; // 낮은 리그는 성급하게 몸을 날림
  if (facingAway) chance += 0.03;
  if (looseTouch) chance += 0.025;
  if (danger) chance += 0.02;
  if (p.containT > 70) chance += 0.03;
  if (Math.random() < chance) { p.lunge = 18; p.containT = 0; }
}

function steerOutfield(p) {
  if (p.role === 'GK' || p.sentOff) return;
  if (!p.targetPosition) p.targetPosition = { x: p.homeX, z: p.homeZ };
  const situation = matchSituation(p);
  const presser = p.isBlue ? teamAi.bluePress : teamAi.redPress;
  p.actionLock = (p.actionLock || 0) - 1;
  if (p.actionLock <= 0 || teamAi.possFlip > 0) {
    p.currentAction = scoreAction(p, situation, presser);
    p.actionLock = (teamAi.possFlip > 0 ? 8 : 20) * (1 + dumb(p) * 1.5);
  }
  const cover = p.isBlue ? teamAi.blueCover : teamAi.redCover;
  if (p.expectPass > 0) {
    p.expectPass--;
    if (ball.owner || ball.holdByGk) p.expectPass = 0;
  }
  if (p.runTarget && (ball.owner || ball.holdByGk || p.runTarget.ttl <= 0)) p.runTarget = null;
  if (p.runTarget && !ball.owner) {
    p.runTarget.ttl--;
    if (dist2(p, ball) < 4.5 || Math.hypot(p.runTarget.x - p.x, p.runTarget.z - p.z) < 1.2) {
      p.runTarget = null;
      p.currentAction = 'RECEIVE_BALL';
    } else p.currentAction = 'RUN_IN_BEHIND';
  } else if (pendingReceiver === p || (p.expectPass > 0 && !ball.owner)) p.currentAction = 'RECEIVE_BALL';
  else if (p === presser && situation === 'loose') p.currentAction = 'RECEIVE_BALL';
  else if (p === presser && situation === 'defend') {
    p.currentAction = 'PRESS_BALL';
    decideLunge(p);
  }
  else if (p === cover && situation === 'defend') p.currentAction = 'SCREEN';
  if (p.currentAction !== 'PRESS_BALL') p.lunge = 0;
  // 오버래핑은 한 팀에 한 명만
  const ovKey = p.isBlue ? 'blueOverlap' : 'redOverlap';
  if (p.currentAction === 'OVERLAP') teamAi[ovKey] = p;
  else if (teamAi[ovKey] === p) teamAi[ovKey] = null;
  // 세트피스 중엔 공에 달려들지 않음
  if (phase === 'setpiece' && (p.currentAction === 'PRESS_BALL' || p.currentAction === 'RECEIVE_BALL')) p.currentAction = 'MARK_OPPONENT';
  const goal = desiredTarget(p, p.currentAction || 'HOLD_POSITION');
  const snap = ['RECEIVE_BALL', 'PRESS_BALL', 'RUN_IN_BEHIND'].includes(p.currentAction) ? 0.5 : p.currentAction === 'SCREEN' ? 0.25 : 0.1;
  p.targetPosition.x = lerp(p.targetPosition.x, goal.x, snap);
  p.targetPosition.z = lerp(p.targetPosition.z, goal.z, snap);
  const d = Math.hypot(p.targetPosition.x - p.x, p.targetPosition.z - p.z);
  const attr = p.playerAttributes?.speed || 0.75;
  const spdStat = statMul(p, 'speed');
  const accStat = statMul(p, 'accel');
  let spd = WALK * (0.9 + attr * 0.45) * sprintMult(p) * spdStat;
  p.sprinting = false;

  const act = p.currentAction;
  let urgency = 0;
  if (act === 'PRESS_BALL') urgency = dist2(p, ball) < 11 ? 1 : 0.7;
  else if (act === 'RECEIVE_BALL') urgency = p.lobLand || p.runTarget ? 1 : dist2(p, ball) > 6 ? 0.85 : 0.4;
  else if (act === 'TRACK_RUNNER') urgency = 0.8;
  else if (act === 'MAKE_RUN') urgency = 0.75;
  else if (act === 'FIND_SPACE') urgency = d > 5 ? 0.6 : 0.3;
  else if (act === 'SCREEN') urgency = 0.6;
  else if (act === 'OVERLAP') urgency = 0.8;
  else if (act === 'BOX_RUN') urgency = 0.7;
  else if (act === 'RUN_IN_BEHIND') urgency = 1;

  if (situation === 'attack') {
    // 팀이 올라가는데 내 자리보다 6m 이상 뒤에 있으면 뛰어서 따라붙음
    const sp = shapePoint(p, situation);
    if ((sp.x - p.x) * (p.isBlue ? 1 : -1) > 6) urgency = Math.max(urgency, 0.7);
  }
  if (urgency >= 0.45 && canAiSprint(p, urgency) && d > 3.5) {
    const sprintBoost = 0.68 + attr * 0.22;
    spd = Math.min(SPRINT * sprintMult(p) * sprintBoost * spdStat * (0.92 + accStat * 0.1), spd * 1.28);
    p.sprinting = true;
  }
  const hurryLob = act === 'RECEIVE_BALL' && p.lobLand && d > 0.8; // 낙하지점까지는 감속 없이
  if (urgency >= 0.45 && hurryLob && !p.sprinting && canAiSprint(p, urgency)) { spd = SPRINT * sprintMult(p) * spdStat * 0.85; p.sprinting = true; }
  if (act !== 'PRESS_BALL' && act !== 'RUN_IN_BEHIND' && !hurryLob) spd *= clamp(d / (5.5 / Math.max(0.7, accStat)), 0.28, 1);
  if (act === 'PRESS_BALL') {
    const c = ball.owner;
    const cSpd = c ? Math.hypot(c.vx, c.vz) : 0;
    const db = dist2(p, ball);
    spd = Math.max(spd, WALK * 1.1 * spdStat, Math.min(cSpd, maxRunSpeed(p)));
    if (db > 2.2 && (canAiSprint(p, 1) || teamAi.danger?.[p.isBlue ? 'blue' : 'red'])) {
      spd = Math.max(spd, SPRINT * sprintMult(p) * 0.9 * spdStat);
      p.sprinting = true;
    }
    if (db < 0.4) spd *= 0.5;
  }

  moveToward(p, p.targetPosition.x, p.targetPosition.z, spd);
  if (p.currentAction === 'RECEIVE_BALL' && ball.y > 1.05 && dist2(p, ball) < 4) {
    p.jumpY = Math.min(0.55, (p.jumpY || 0) + 0.08);
  }
}

function aiTeammate(p) {
  if (p.sentOff) return;
  if (devFlags.on && p.role !== 'GK' && devAiOverride(p, devFlags.mateAi)) return;
  if (p.role === 'GK') { aiGk(p); return; }
  steerOutfield(p);
}

function pickAiPassTarget(from, team) {
  const atk = from.isBlue ? 1 : -1;
  let best = null;
  let bestS = -Infinity;
  for (const m of fieldPlayers(team)) {
    if (m === from || m.role === 'GK') continue;
    const d = dist2(from, m);
    if (d < 3 || d > 42) continue;
    const ahead = (m.x - from.x) * atk;
    let s = ahead * 1.1 - d * 0.35;
    s += (m.actionScores?.FIND_SPACE || 0) * 0.35;
    s += (m.actionScores?.MAKE_RUN || 0) * 0.25;
    s += (m.actionScores?.SUPPORT_ATTACK || 0) * 0.2;
    if (m.position === 'ST' || m.position === 'CAM') s += 6;
    if (m.position === 'LW' || m.position === 'RW') s += 4;
    const marked = nearestOpp(m);
    if (marked && dist2(m, marked) < 5) s -= 10;
    // 패스 길목에 상대가 있으면 감점
    const [lx, lz] = norm2(m.x - from.x, m.z - from.z);
    for (const o of fieldPlayers(from.isBlue ? teamB : teamA)) {
      const t = (o.x - from.x) * lx + (o.z - from.z) * lz;
      if (t < 1 || t > d - 1) continue;
      const perp = Math.abs((o.x - from.x) * lz - (o.z - from.z) * lx);
      if (perp < 1.6) s -= 14;
    }
    if (phase === 'play' && isOffsideAtPass(from, m)) s -= 60;
    if (s > bestS) { bestS = s; best = m; }
  }
  return best || nearestTeammate(from, team);
}

// ===== AI 판단용 헬퍼 =====
function oppsOf(p) { return fieldPlayers(p.isBlue ? teamB : teamA); }
function matesOf(p) { return fieldPlayers(p.isBlue ? teamA : teamB); }

function nearestOppDist(x, z, isBlue) {
  let best = Infinity;
  for (const o of fieldPlayers(isBlue ? teamB : teamA)) {
    const d = Math.hypot(o.x - x, o.z - z);
    if (d < best) best = d;
  }
  return best;
}

/** 패스길 위험도: 공이 지나가는 동안 상대가 길목에 닿을 수 있으면 위험 */
function laneRisk(fromX, fromZ, toX, toZ, ballSpd, isBlue) {
  const D = Math.hypot(toX - fromX, toZ - fromZ);
  if (D < 0.1) return 0;
  const lx = (toX - fromX) / D, lz = (toZ - fromZ) / D;
  let risk = 0;
  for (const o of fieldPlayers(isBlue ? teamB : teamA)) {
    const t = (o.x - fromX) * lx + (o.z - fromZ) * lz;
    if (t < 0.5 || t > D + 1) continue;
    const perp = Math.abs((o.x - fromX) * lz - (o.z - fromZ) * lx);
    const frames = t / Math.max(0.3, ballSpd);
    const reach = (o.role === 'GK' ? 1.6 : 1.0) + frames * WALK * 0.9;
    if (perp < reach) risk += (reach - perp) / reach;
  }
  return risk;
}

/** 슛 기대값 비슷한 점수: 골문이 보이는 각도, 거리, 슛 길목의 수비수 */
function shotQuality(p, x = p.x, z = p.z) {
  const atk = p.isBlue ? 1 : -1;
  const goalX = atk * FIELD_W / 2;
  if ((goalX - x) * atk <= 0) return 0;
  const dx = Math.abs(goalX - x);
  const d = Math.hypot(dx, z);
  if (d > 34) return 0;
  const angle = Math.abs(Math.atan2(GOAL_W / 2 - z, dx) - Math.atan2(-GOAL_W / 2 - z, dx));
  let q = angle * 1.6 / (1 + d * 0.06);
  for (const o of fieldPlayers(p.isBlue ? teamB : teamA)) {
    if (o.role === 'GK') continue;
    const t = ((o.x - x) * (goalX - x) + (o.z - z) * (0 - z)) / (d * d);
    if (t <= 0 || t >= 1) continue;
    const px = x + (goalX - x) * t, pz = z - z * t;
    if (Math.hypot(o.x - px, o.z - pz) < 1.0 + t * 1.6) q *= 0.55;
  }
  return q * (0.8 + statMul(p, 'finishing') * 0.25);
}

/** 앞쪽으로 가장 길게 뚫려 있는 드리블 방향 */
function bestDribbleDir(p) {
  const atk = p.isBlue ? 1 : -1;
  let best = [atk, 0], bestS = -Infinity, bestFree = 0;
  for (const a of [-1.2, -0.7, -0.35, 0, 0.35, 0.7, 1.2]) {
    const dx = Math.cos(a) * atk, dz = Math.sin(a);
    let free = 15;
    for (const o of oppsOf(p)) {
      const t = (o.x - p.x) * dx + (o.z - p.z) * dz;
      if (t <= 0 || t > 15) continue;
      const perp = Math.abs((o.x - p.x) * dz - (o.z - p.z) * dx);
      if (perp < 2.4) free = Math.min(free, t - (2.4 - perp));
    }
    if (Math.abs(p.z + dz * 6) > FIELD_H / 2 - 2) free -= 8;
    if (Math.abs(p.x + dx * 6) > FIELD_W / 2 - 2) free -= 8;
    const s = free + Math.cos(a) * 3;
    if (s > bestS) { bestS = s; best = [dx, dz]; bestFree = free; }
  }
  return { dir: best, free: bestFree };
}

/** 공 가진 AI의 선택지(슛/패스/로빙/스루/크로스/드리블)를 점수로 비교 */
function aiDecide(p, pressDist) {
  const atk = p.isBlue ? 1 : -1;
  const goalX = atk * FIELD_W / 2;
  const opts = [];
  const q = shotQuality(p);
  if (q > 0.08) opts.push({ kind: 'shot', u: q * 160 - 12 });

  for (const m of matesOf(p)) {
    if (m === p || m.role === 'GK') continue;
    const d = dist2(p, m);
    if (d < 4 || d > 50) continue;
    const offside = isOffsideAtPass(p, m);
    const progress = (m.x - p.x) * atk;
    const open = Math.min(nearestOppDist(m.x, m.z, p.isBlue), 9);
    const runBonus = m.currentAction === 'OVERLAP' ? 8 : m.currentAction === 'BOX_RUN' ? 5 : 0;
    const base = progress * 0.8 + open * 2 - d * 0.1 + shotQuality(m) * 45 + runBonus;
    if (!offside) {
      const v = groundPassSpeed(d);
      const risk = laneRisk(p.x, p.z, m.x, m.z, (v + 0.3) / 2, p.isBlue);
      if (risk < 0.7 && d < 36) opts.push({ kind: 'pass', mate: m, lofted: false, u: base - risk * 12 });
      if (d > 14) opts.push({ kind: 'pass', mate: m, lofted: true, u: base - Math.max(0, 4.5 - open) * 4 - 7 });
    }
    // 스루: 받을 선수 앞 공간에 상대보다 먼저 닿을 수 있으면
    if (m.role !== 'CB' && progress > -3 && !offside && Math.random() < 0.25 + aiIQ(p) * 0.75) {
      const lead = throughLeadPoint(p, m, 0.45);
      const oppT = (nearestOppDist(lead.x, lead.z, p.isBlue) - 1) / (SPRINT * 0.9);
      if (oppT > lead.runFrames * 0.9 && (lead.x - p.x) * atk > 4) {
        const lr = laneRisk(p.x, p.z, lead.x, lead.z, 0.8, p.isBlue);
        opts.push({ kind: 'through', mate: m, lead, u: (lead.x - p.x) * atk + 10 + shotQuality(m, lead.x, lead.z) * 60 - lr * 10 });
      }
    }
  }
  // 측면에서 박스 안으로 크로스
  if (Math.abs(p.z) > 13 && (goalX - p.x) * atk < 26 && Math.random() < 0.35 + aiIQ(p) * 0.65) {
    for (const m of matesOf(p)) {
      if (m === p || m.role === 'GK') continue;
      if ((goalX - m.x) * atk < 15 && Math.abs(m.z) < 11) {
        opts.push({ kind: 'cross', mate: m, u: 20 + Math.min(nearestOppDist(m.x, m.z, p.isBlue), 5) * 2.5 });
      }
    }
  }
  const dr = bestDribbleDir(p);
  let du = dr.free * 1.4 + dr.dir[0] * atk * 4 + statMul(p, 'dribbling') * 4 - 4;
  if (pressDist < 2.2) du -= 12;
  opts.push({ kind: 'dribble', dir: dr.dir, free: dr.free, u: du });

  let best = opts[0];
  for (const o of opts) {
    o.u += Math.random() * (3 + dumb(p) * 28);
    if (o.u > best.u) best = o;
  }
  return best;
}

function aiExecutePass(p, mate, lofted = false) {
  if (!mate) return false;
  if (phase === 'play' && isOffsideAtPass(p, mate)) { callOffside(p, mate); return true; }
  const kind = lofted ? 'lob' : dist2(p, mate) > 28 ? 'long' : 'short';
  return !!doPass(p, kind, 0.5, { target: mate });
}

function aiThroughPass(p, mate, lead) {
  if (phase === 'play' && isOffsideAtPass(p, mate)) { callOffside(p, mate); return; }
  doPass(p, 'through', 0.45, { target: mate, lead });
}

function aiCross(p, mate) {
  doPass(p, 'cross', 0.75, { target: mate });
}

function aiTryShot(p, force = false) {
  const atk = p.isBlue ? 1 : -1;
  const goalX = atk * FIELD_W / 2;
  const dist = Math.hypot(p.x - goalX, p.z);
  if (!force && shotQuality(p) < 0.12) return false;
  const finish = statMul(p, 'finishing');
  const shotPow = statMul(p, 'shotPower');
  const fatigue = staminaFatigue(p);
  const gk = oppsOf(p).find(o => o.role === 'GK');
  // 키퍼가 비운 쪽, 각도가 좁으면 먼 포스트
  let side = gk ? (gk.z > 0.3 ? -1 : gk.z < -0.3 ? 1 : (Math.random() < 0.5 ? -1 : 1)) : (Math.random() < 0.5 ? -1 : 1);
  if (Math.abs(p.z) > 6) side = -Math.sign(p.z);
  let aimZ = side * (GOAL_W / 2 - 0.75);
  const err = GOAL_W * (0.26 - finish * 0.15 + fatigue * 0.22 + dist * 0.004 + dumb(p) * 0.22);
  aimZ += (Math.random() - 0.5) * 2 * err;
  const spd = clamp(1.0 + dist * 0.012, 1.0, 1.45) * (0.88 + shotPow * 0.2);
  const low = Math.random() < 0.55;
  const vy = ((low ? 0.05 + dist * 0.002 : 0.1 + dist * 0.006) + fatigue * 0.06) * 1.12;
  kickFrom(p, spd, goalX, aimZ, { lift: 0.08, vy, isShot: true, spin: { side: 0, top: 0.45 } });
  stats.shots[p.isBlue ? 0 : 1]++;
  return true;
}

/** 공 가진 AI: 짧게 판단 → 실행, 드리블 중엔 뚫린 방향으로 */
function aiCarrier(p) {
  const presser = nearestOpp(p);
  const pressDist = presser ? dist2(p, presser) : 99;
  p.targetPosition = p.targetPosition || { x: p.x, z: p.z };
  if (pressDist < 2.2 && p.aiTimer > 5) p.aiTimer = 5; // 압박 오면 빨리 판단

  if (p.aiTimer <= 0 && kickCooldown <= 0) {
    const plan = aiDecide(p, pressDist);
    if (plan.kind === 'shot') { aiTryShot(p, true); p.aiTimer = 30; return; }
    if (plan.kind === 'pass') { aiExecutePass(p, plan.mate, plan.lofted); p.aiTimer = 30; return; }
    if (plan.kind === 'through') { aiThroughPass(p, plan.mate, plan.lead); p.aiTimer = 30; return; }
    if (plan.kind === 'cross') { aiCross(p, plan.mate); p.aiTimer = 30; return; }
    p.dribDir = plan.dir;
    p.dribFree = plan.free;
    p.aiTimer = (pressDist < 4 ? 7 : 13) * (1 + dumb(p) * 1.3);
  }
  const atk = p.isBlue ? 1 : -1;
  const [dx, dz] = p.dribDir || [atk, 0];
  const tx = clamp(p.x + dx * 6, -FIELD_W / 2 + 2, FIELD_W / 2 - 2);
  const tz = clamp(p.z + dz * 6, -FIELD_H / 2 + 2.5, FIELD_H / 2 - 2.5);
  p.targetPosition.x = lerp(p.targetPosition.x, tx, 0.3);
  p.targetPosition.z = lerp(p.targetPosition.z, tz, 0.3);
  const open = (p.dribFree || 0) > 7;
  const wantSprint = canAiSprint(p, open ? 0.8 : pressDist < 5 ? 1 : 0.3) && (open || pressDist < 5);
  p.sprinting = wantSprint;
  const spdStat = statMul(p, 'speed');
  const accStat = statMul(p, 'accel');
  const drib = 0.9 + statMul(p, 'dribbling') * 0.08;
  const spd = (wantSprint
    ? SPRINT * sprintMult(p) * (0.72 + (p.playerAttributes?.speed || 0.7) * 0.2) * spdStat * (0.92 + accStat * 0.1)
    : WALK * (1.0 + (p.playerAttributes?.accel || 0.7) * 0.12) * spdStat * (0.9 + accStat * 0.12)) * drib;
  moveToward(p, p.targetPosition.x, p.targetPosition.z, spd);
}

function aiSetpieceKick(p) {
  if (setpiece.type === 'kickoff') {
    const mates = matesOf(p).filter(m => m !== p && m.role !== 'GK' && (m.x - p.x) * (p.isBlue ? 1 : -1) < 2)
      .sort((a, b) => dist2(a, p) - dist2(b, p));
    const mate = mates[Math.floor(Math.random() * Math.min(2, mates.length))];
    if (mate) aiExecutePass(p, mate, false);
    else kickFrom(p, 0.5, p.x - (p.isBlue ? 8 : -8), p.z);
    return;
  }
  if (setpiece.type === 'penalty') {
    const aim = (Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 2.3);
    startPenRun(p, 0.3 + Math.random() * 0.5, aim);
  } else if (setpiece.type === 'freekick') {
    const near = Math.hypot(ball.x + FIELD_W / 2, ball.z) < 30;
    if (near && !setpiece.indirect && Math.random() < 0.62) {
      // 벽을 넘겨 감아차기 — 마그누스 효과로 골문 쪽으로 휨
      const aimZ = (Math.random() < 0.5 ? -1 : 1) * GOAL_W * 0.35;
      const [dx, dz] = norm2(-FIELD_W / 2 - ball.x, aimZ - ball.z);
      const side = curlToward(dx, dz, 0, -ball.z || 1) * 0.7;
      // 휘는 만큼 반대쪽으로 겨냥 (왼쪽 벡터 L=(dz,-dx) 반대)
      kickFrom(p, 1.12, -FIELD_W / 2, aimZ + Math.sign(side) * dx * 1.8, {
        lift: 0.18, vy: 0.34, isShot: true, spin: { side, top: 0.5 },
      });
      stats.shots[1]++;
    } else {
      aiExecutePass(p, pickAiPassTarget(p, teamB), true);
    }
  } else if (setpiece.type === 'corner') {
    // 박스 안에서 가장 자유로운 공격수에게 띄움
    const inBox = teamB.filter(m => !m.sentOff && m !== p && m.x < -FIELD_W / 2 + 16 && Math.abs(m.z) < 12);
    let mate = null, bestOpen = -1;
    for (const m of inBox) {
      const o = nearestOppDist(m.x, m.z, false) + Math.random();
      if (o > bestOpen) { bestOpen = o; mate = m; }
    }
    if (mate) aiCross(p, mate);
    else {
      const tx = -FIELD_W / 2 + 8, tz = (Math.random() - 0.5) * 10;
      const L = loftedLaunch(Math.hypot(tx - ball.x, tz - ball.z), 0.7);
      kickFrom(p, L.spd, tx, tz, { lift: 0.05, vy: L.vy });
      stats.passes[1]++;
    }
  } else if (setpiece.type === 'throw') {
    const long = Math.random() < 0.3;
    throwIn(p, findThrowTarget(p, long ? 26 : 16), long);
  } else if (setpiece.type === 'goalkick') {
    const mate = pickAiPassTarget(p, teamB);
    const upfield = true;
    if (mate && dist2(p, mate) > 6) {
      aiExecutePass(p, mate, upfield && dist2(p, mate) > 16);
    } else {
      const tx = ball.x - (upfield ? 30 : 12), tz = clamp(ball.z * 0.6, -FIELD_H / 2 + 3, FIELD_H / 2 - 3);
      const L = loftedLaunch(Math.hypot(tx - ball.x, tz - ball.z), 0.5);
      kickFrom(p, L.spd, tx, tz, { lift: 0.05, vy: L.vy });
      stats.passes[1]++;
    }
  }
}

function aiOpponent(p) {
  if (p.sentOff) return;
  if (devFlags.on && p.role !== 'GK' && devAiOverride(p, devFlags.oppAi)) return;
  p.aiTimer--;

  if (phase === 'setpiece' && setpiece && setpiece.taker === p && !setpiece.teamBlue) {
    if (setpiece.cut) return;
    p.vx = 0;
    p.vz = 0;
    if (p.aiTimer <= 0) {
      aiSetpieceKick(p);
      p.aiTimer = 40;
    }
    return;
  }

  if (p.role === 'GK') { aiGk(p); return; }

  if (ball.owner === p) {
    p.currentAction = 'SUPPORT_ATTACK';
    aiCarrier(p);
    return;
  }
  steerOutfield(p);
}

// ===== 헤딩 =====
function tryHeading(p, force = false) {
  if (headingCd > 0 || phase !== 'play' || p.sentOff) return false;
  if (ball.owner || ball.holdByGk) return false;
  if (ball.y < 1.1 || ball.y > 2.3 + clamp((statMul(p, 'heading') - 0.85) * 2.5, 0, 0.45) + bodyReachAdd(p)) return false; // 점프 높이까지 (키가 크면 아주 조금 더)
  if (dist2(p, ball) > PLAYER_R + 1.35) return false;

  const isActive = p.isBlue && p === getActive();
  const isPending = pendingReceiver === p;
  if (!force && !isActive && !isPending && Math.random() > 0.12) return false;

  ball.fromThrow = false;
  touchBall(p);
  headingCd = 18;
  p.jumpY = 0.5;

  let tx, tz;
  const attackSign = p.isBlue ? 1 : -1;
  const [idx, idz] = getInputDir();
  const nearGoal = Math.abs(attackSign * (FIELD_W / 2) - p.x) < 22;
  if (isActive && keys.KeyD) {
    tx = attackSign * (FIELD_W / 2);
    tz = clamp(idz * GOAL_W * 0.4, -GOAL_W / 2, GOAL_W / 2);
  } else if (isActive && (idx || idz)) {
    tx = p.x + idx * 25;
    tz = p.z + idz * 25;
  } else {
    const mate = nearestTeammate(p, p.isBlue ? teamA : teamB);
    if (!nearGoal && mate && dist2(p, mate) < 28) {
      tx = mate.x; tz = mate.z;
    } else if (nearGoal) {
      tx = attackSign * (FIELD_W / 2);
      tz = (Math.random() - 0.5) * GOAL_W * 0.6;
    } else {
      // 자기 진영이면 걷어내기
      tx = p.x + attackSign * 25;
      tz = p.z + (Math.random() - 0.5) * 15;
    }
  }

  const towardGoal = Math.abs(tx) > FIELD_W / 2 - 5 && Math.sign(tx) === attackSign;
  ball.owner = null;
  ball.holdByGk = null;
  const [dx, dz] = norm2(tx - ball.x, tz - ball.z);
  const headPow = 0.85 + statMul(p, 'heading') * 0.25;
  ball.vx = dx * (towardGoal ? 0.8 : 0.6) * headPow;
  ball.vz = dz * (towardGoal ? 0.8 : 0.6) * headPow;
  ball.vy = towardGoal ? -0.02 : 0.12; // 골을 노린 헤딩은 아래로 내려찍기
  ball.wx = ball.wy = ball.wz = 0;
  ball.y = Math.max(ball.y, 1.4);
  ball.lastHeader = true;
  lastKickRec = recTotal;
  ball.lastShot = towardGoal;
  ball.shotX0 = ball.x; ball.shotZ0 = ball.z;
  ball.blockedShot = false;
  if (ball.lastShot) {
    ball.shotTeamBlue = p.isBlue;
    stats.shots[p.isBlue ? 0 : 1]++;
  }
  pendingReceiver = null;
  p.kickAnim = 0;
  if (p.isBlue) setActive(p);
  return true;
}

// ===== 소유 / 드리블 =====
function gkCatch(p) {
  if (ball.lastShot && ball.shotTeamBlue !== p.isBlue) { registerSave(p); triggerSaveReplay(); }
  ball.holdByGk = p;
  ball.owner = p;
  ball.vx = ball.vz = ball.vy = 0;
  ball.wx = ball.wy = ball.wz = 0;
  ball.y = 1.0;
  ball.lastShot = false;
  ball.fromThrow = false;
  touchBall(p);
  p.holdTicks = 0;
  if (pendingReceiver) pendingReceiver = null;
  if (p.isBlue) setActive(p);
}

function tryPossess(p) {
  if (p.sentOff || phase !== 'play') return;
  // 찬 직후: 처음 3프레임은 아무도, 그 뒤엔 찬 선수만 못 건드림 (상대는 패스 길목에서 바로 끊을 수 있음)
  if (kickCooldown > 11 || (kickCooldown > 0 && (p === lastToucher || ball.lastShot))) return; // 슛은 블록 판정으로만
  // 스로인 공이 우리 선수에게 가는 동안 상대는 가로챌 수 없음
  if (ball.throwTo && !ball.owner && ball.throwTtl > 0 && p.isBlue !== ball.throwTo.isBlue) return;
  if (inPens && p.role !== 'GK') return;
  if (p.dispossessCd > 0) return;
  if (ball.holdByGk) return;
  if (ball.lockT > 0) return; // 소유권이 막 바뀐 직후 (중복 판정 방지)
  if (p.stun > 0 || p.tackle) return;

  const gkInBox = p.role === 'GK' && inPenaltyBox(ball.x, ball.z, p.isBlue);
  const fastShot = ball.lastShot && !inPens && Math.hypot(ball.vx, ball.vz) > 0.35; // 빠른 슛은 키퍼 손 판정(gkShotLogic)으로만
  if (gkInBox && !ball.owner && ball.y < 2.6 && dist2(p, ball) <= PLAYER_R + 0.95 && !(inPens && ball.lastShot) && !fastShot) { // 승부차기 슛은 선방 판정으로만
    const wrongWay = p.dive > 0 && !p.saveRoll;
    // 백패스 규칙: 같은 팀이 발로 일부러 준 공은 손으로 잡을 수 없음
    const backpass = lastToucher && lastToucher !== p && lastToucher.isBlue === p.isBlue && !ball.lastHeader && !ball.fromThrow;
    if (!wrongWay && !backpass) {
      gkCatch(p);
      return;
    }
  }

  if (fastShot && gkInBox) return; // 키퍼는 빠른 슛을 발로 '소유'하지 않음 (손 판정으로만)
  // 스로인 받는 선수: 머리로 튕기지 않고 가슴·발로 바로 잡음
  if (ball.throwTo === p && !ball.owner && ball.y < 2.0 && ball.vy <= 0 && dist2(p, ball) <= PLAYER_R + 1.0) {
    ball.owner = p;
    ball.fromThrow = false;
    ball.throwTo = null; ball.throwTtl = 0;
    ball.vy = 0; ball.wx = ball.wy = ball.wz = 0;
    touchBall(p);
    if (pendingReceiver === p) pendingReceiver = null;
    if (p.isBlue && switchLock <= 0) setActive(p);
    return;
  }
  if (ball.throwTo && !ball.owner && ball.throwTo.isBlue === p.isBlue && ball.y >= 1.0) return;
  // 로빙·패스를 받기로 한 선수: 떨어지는 공은 머리로 튕기지 않고 가슴·발로 받아 냄
  // 우리 편 띄운 패스(로빙 · 긴 패스 · 로빙 스루): 받기로 한 선수뿐 아니라 우리 선수는 머리로 튕기지 않고 가슴 · 발로 잡음
  // (D를 누르고 있으면 헤딩) · 빠르게 떨어지는 공도 이번 프레임에 지나갈 선분 전체로 검사 · 볼 컨트롤이 좋을수록 넓게
  const loft = ball.pass && ball.pass.team === p.isBlue && LOFT_KINDS.has(ball.pass.kind);
  const wantHead = p.isBlue && p === getActive() && keys.KeyD;
  const rcvMe = pendingReceiver === p || (p.lobLand && p.lobLand.ttl > 0) || ball.pass?.to === p;
  if (!ball.owner && !wantHead && (rcvMe || loft) && ball.y < 2.5 && ball.vy <= 0.16) {
    const ctl = clamp(statMul(p, 'dribbling'), 0.6, 1.3);
    const reach = PLAYER_R + (rcvMe ? 1.05 : 0.8) + (ctl - 0.85) * 0.5;
    const nx = ball.x + ball.vx, nz = ball.z + ball.vz;
    if (Math.min(dist2(p, ball), segPointDist(p.x, p.z, ball.x, ball.z, nx, nz)) <= reach) {
      ball.owner = p;
      ball.lockT = 4;
      ball.fromThrow = false;
      ball.vy = 0; ball.wx = ball.wy = ball.wz = 0;
      ball.lastShot = false; ball.lastHeader = false;
      p.lobLand = null;
      if (!p.isBlue) p.aiTimer = 10 + Math.random() * 14;
      // 몸 쪽으로 받아 냄: 공이 날아온 방향으로 계속 달리던 속도는 조금 줄임 · 공은 몇 프레임에 걸쳐 발 앞으로
      p.vx *= 0.8; p.vz *= 0.8;
      if (ball.y > 0.5 || dist2(p, ball) > PLAYER_R + 0.5) ball.trap = { p, t: 0, T: Math.round(6 + Math.min(ball.y, 2.2) * 3 + (1.2 - ctl) * 4), x: ball.x, z: ball.z, y: ball.y };
      touchBall(p);
      if (pendingReceiver === p) pendingReceiver = null;
      if (p.isBlue && switchLock <= 0) setActive(p);
      return;
    }
  }
  if (!ball.owner && !wantHead && (rcvMe || loft) && ball.y >= 1.1) return; // 아직 안 닿음 — 머리로 건드리지 말고 떨어지길 기다림

  if (!gkInBox && ball.y >= 1.1 && ball.y <= 2.75) {
    // 우리 편에게 가는 띄운 패스를 상대가 머리로 끊는 건 한 번의 경합으로만 (40%)
    // 공중볼 경합: 받을 선수와 수비수가 함께 닿으면 한 번만 판정 (헤딩 능력 · 공까지 거리)
    const rcv = ball.pass?.to || pendingReceiver;
    if (rcv && !ball.owner && rcv.isBlue !== p.isBlue) {
      if (dist2(p, ball) > PLAYER_R + 1.35 || headingCd > 0 || ball.y > 2.3 + clamp((statMul(p, 'heading') - 0.85) * 2.5, 0, 0.45) + bodyReachAdd(p)) return; // 닿을 때만 경합
      if (ball.airContest === undefined) {
        const ps = statMul(p, 'heading') - dist2(p, ball) * 0.22 + bodyReachAdd(p) * 0.5;
        const rs = statMul(rcv, 'heading') - dist2(rcv, ball) * 0.22 + 0.08 + bodyReachAdd(rcv) * 0.5; // 받기로 한 선수가 조금 유리
        ball.airContest = Math.random() < clamp(0.45 + (ps - rs) * 1.4, 0.1, 0.8);
        emitEvent('aerial', { by: p, won: ball.airContest, msg: `공중볼 경합 — ${pname2(p)} vs ${pname2(rcv)}: ${ball.airContest ? '수비 승' : '공격 승'}` });
      }
      if (!ball.airContest) return;
      tryHeading(p, true);
      return;
    }
    tryHeading(p);
    return;
  }
  if (ball.y > 1.35) return;
  const contest = ball.owner && ball.owner !== p && ball.owner.isBlue !== p.isBlue;
  // 빠른 공은 이번 프레임에 지나갈 '선분' 전체로 검사 (선수를 뚫고 지나가지 않게)
  const reachD = ball.owner ? dist2(p, ball) : Math.min(dist2(p, ball), segPointDist(p.x, p.z, ball.x, ball.z, ball.x + ball.vx, ball.z + ball.vz));
  if (reachD > PLAYER_R + (contest ? 1.2 : 0.85)) return;

  if (ball.owner && ball.owner !== p) {
    if (ball.owner.isBlue === p.isBlue) return; // 같은 팀 공은 뺏지 않음
    if (p.tackleCd > 0) return;
    const userCtrl = p.isBlue && p === teamA[activeIdx];
    if (!userCtrl && !(p.lunge > 0) && dist2(p, ball) > PLAYER_R + 0.6) return; // AI는 기다리다 태클 타이밍에만
    if (Math.hypot(p.vx, p.vz) > 0.02 || dist2(p, ball) < PLAYER_R + 0.75) {
      const prev = ball.owner;
      // 공을 가진 선수 기준으로 태클하는 선수가 어디 있나 (앞 / 옆 / 뒤)
      const [fx, fz] = norm2(prev.faceX, prev.faceZ);
      const [rx, rz] = norm2(p.x - prev.x, p.z - prev.z);
      const front = fx * rx + fz * rz; // 1 = 정면, 0 = 옆, -1 = 바로 뒤
      if (front < -0.25) {
        // 등 뒤에서는 공에 발이 닿지 않음 → 뺏을 수 없고, 무리하면 파울
        if (p.lunge > 0 || (userCtrl && p.sprinting)) tackleFoul(p, prev, false);
        p.tackleCd = 24;
        p.lunge = 0;
        return;
      }
      // 공(발 앞)에 충분히 가까워야 함
      if (dist2(p, ball) > PLAYER_R + (userCtrl ? 0.8 : 0.6)) return;
      const winChance = tackleChance(p, prev, 'auto').chance; // 몸으로 붙어서 뺏기 (태클 버튼 없이)
      const won = Math.random() <= winChance;
      if (tackleFoul(p, prev, won)) return;
      if (!won) {
        p.tackleCd = 30;
        p.lunge = 0;
        return;
      }
      ball.owner = p; ball.holdByGk = null;
      ball.fromThrow = false;
      ball.lockT = TUNE.claimLock;
      nextTouchCause = 'tackle';
      if (!p.isBlue) p.aiTimer = 10 + Math.random() * 15;
      p.tackleCd = 18;
      prev.dispossessCd = 42;
      const [ax, az] = norm2(prev.x - p.x, prev.z - p.z);
      prev.vx = ax * 0.06;
      prev.vz = az * 0.06;
      if (pendingReceiver && pendingReceiver !== p) pendingReceiver = null;
      if (p.isBlue) setActive(p);
      touchBall(p);
    }
    return;
  }

  if (!ball.owner) {
    ball.owner = p;
    ball.lockT = 4;
    if (!p.isBlue) p.aiTimer = 14 + Math.random() * 22; // 첫 터치 후 판단 시간 (원터치 남발 방지)
    ball.fromThrow = false;
    ball.lastShot = false;
    ball.wx = ball.wy = ball.wz = 0;
    touchBall(p);
    if (pendingReceiver === p) pendingReceiver = null;
    if (p.isBlue && switchLock <= 0) setActive(p);
  }
}

function updateDribble() {
  const owner = ball.owner || ball.holdByGk;
  if (!owner) return;
  if (phase === 'setpiece') {
    // 세트피스: 공은 지점에 고정, 스로인만 손 위
    if (setpiece?.type === 'throw' && setpiece.taker) {
      ball.x = setpiece.taker.x + (setpiece.taker.faceX || 0) * 0.15;
      ball.z = setpiece.taker.z + (setpiece.taker.faceZ || 0) * 0.15;
      ball.y = 2.15;
    }
    ball.vx = ball.vz = ball.vy = 0;
    return;
  }
  if (ball.holdByGk === owner) {
    ball.x = owner.x + owner.faceX * 0.5;
    ball.z = owner.z + owner.faceZ * 0.5;
    ball.y = 1.05;
    ball.vx = ball.vz = ball.vy = 0;
    return;
  }
  const [fx, fz] = norm2(owner.faceX || owner.vx, owner.faceZ || owner.vz);
  const footX = owner.x + fx * 0.75, footZ = owner.z + fz * 0.75;
  const tr = ball.trap;
  if (tr && tr.p === owner && tr.t < tr.T) {
    // 띄운 공 트래핑: 가슴 · 허벅지에서 발 앞으로 부드럽게 떨어뜨림 (순간이동 없이)
    tr.t++;
    const k = tr.t / tr.T, e = k * k * (3 - 2 * k);
    tr.x += owner.vx; tr.z += owner.vz;
    ball.x = lerp(tr.x, footX, e);
    ball.z = lerp(tr.z, footZ, e);
    ball.y = Math.max(BALL_R, lerp(tr.y, BALL_R, k * k) + Math.sin(k * Math.PI) * 0.12 * (tr.y > 0.8 ? 1 : 0));
    ball.vx = owner.vx; ball.vz = owner.vz; ball.vy = 0;
    return;
  }
  ball.trap = null;
  ball.x = footX;
  ball.z = footZ;
  ball.y = BALL_R;
  ball.vx = owner.vx; ball.vz = owner.vz; ball.vy = 0;
}

// 체력에 따른 저하는 statMul(스탯 감소)에서 처리하므로 여기서는 추가 감속 없음
function sprintMult(p) { return 1; }
function skillMult(p) { return 1; }
/** 슛/패스 흔들림용 피로도 (0~0.47). 스탯 감소량에 비례 */
function staminaFatigue(p) { return staminaPenalty(p) / 60; }

function applyPassInaccuracy(from, tx, tz, power) {
  const fatigue = staminaFatigue(from);
  const skill = skillMult(from);
  const vision = statMul(from, 'vision');
  const missAmp = Math.min(0.45, (1.02 - skill) * 0.55) * clamp(1.35 - vision * 0.4, 0.55, 1.25);
  let ox = (Math.random() - 0.5) * missAmp;
  let oz = (Math.random() - 0.5) * missAmp;
  let vy = 0;
  let lift = 0;
  let powerMult = 1;
  let overMiss = false;

  if (power > 0.92) {
    const over = (power - 0.92) / 0.08;
    overMiss = Math.random() < 0.25 + over * 0.3;
    const side = Math.sign(oz || (Math.random() - 0.5));
    oz += side * (0.35 + over * 1.0);
    ox += (Math.random() - 0.5) * (0.3 + over * 0.7);
    if (Math.random() < 0.15 + over * 0.2) {
      vy = 0.06 + over * 0.12;
      lift = 0.04 + over * 0.08;
      powerMult = 1.03 + over * 0.08;
    } else {
      powerMult = 1.04 + over * 0.1;
    }
  } else if (power > 0.8) {
    const hot = (power - 0.8) / 0.12;
    powerMult = 1 + hot * 0.05;
    oz += (Math.random() - 0.5) * hot * 0.3;
  }

  ox += (Math.random() - 0.5) * fatigue * 0.18;
  oz += (Math.random() - 0.5) * fatigue * 0.18;
  return { x: tx + ox, z: tz + oz, vy, lift, powerMult, overMiss };
}

function updateStamina(p, dtSec, isSprinting, isControlled) {
  if (fkMode) { p.stamina = 100; return; } // 프리킥 모드: 체력 소모 없음
  const regen = statMul(p, 'staminaRegen');
  if (isSprinting) {
    p.stamina = Math.max(0, p.stamina - 2.7 * dtSec);
    return;
  }
  if (isControlled) {
    p.stamina = Math.max(0, p.stamina - 0.096 * dtSec);
    return;
  }
  p.stamina = Math.min(100, p.stamina + 1.68 * regen * dtSec);
}

// ===== 파울 / 카드 =====
function issueCard(offender, isYellow) {
  const ti = offender.isBlue ? 0 : 1;
  if (isYellow) {
    offender.yellowCards++;
    stats.yellows[ti]++;
    if (offender.yellowCards >= 2) {
      offender.redCard = true;
      stats.reds[ti]++;
      showMsg(`경고 누적 퇴장 — ${offender.num}번`, 1900);
      comm.red(offender.num);
      sendOffPlayer(offender);
    } else {
      showMsg(`옐로카드 — ${offender.num}번`, 1400);
      comm.yellow(offender.num);
    }
  } else {
    offender.redCard = true;
    stats.reds[ti]++;
    showMsg(`레드카드 — ${offender.num}번`, 1900);
    comm.red(offender.num);
    sendOffPlayer(offender);
  }
}

function sendOffPlayer(p) {
  p.sentOff = true;
  p.vx = p.vz = 0;
  p.x = p.isBlue ? -FIELD_W / 2 - 20 : FIELD_W / 2 + 20;
  p.z = 0;
  p.mesh.visible = false;
  if (ball.owner === p) ball.owner = null;
  if (ball.holdByGk === p) ball.holdByGk = null;
  if (pendingReceiver === p) pendingReceiver = null;
  if (p.isBlue && teamA[activeIdx] === p) manualSwitch();
}

/** 명백한 득점 기회 저지(DOGSO): 골 30m 이내, 공격자 앞을 막는 수비수가 없음 */
function isDogso(offender, victim) {
  const atkSign = victim.isBlue ? 1 : -1;
  const goalX = atkSign * FIELD_W / 2;
  if (Math.hypot(goalX - victim.x, victim.z) > 30) return false;
  if (ball.owner !== victim) return false;
  const defenders = fieldPlayers(offender.isBlue ? teamA : teamB).filter(d => d !== offender && d.role !== 'GK');
  return !defenders.some(d => (d.x - victim.x) * atkSign > 0 && Math.abs(d.z - victim.z) < 10);
}

/** 태클 순간 파울 판정. 뒤에서 / 전력질주로 들어갈수록 위험 */
function tackleFoul(tackler, carrier, won) {
  if (foulCd > 0 || phase !== 'play' || tackler.role === 'GK') return false;
  const [cfx, cfz] = norm2(carrier.faceX, carrier.faceZ);
  const [tx, tz] = norm2(carrier.x - tackler.x, carrier.z - tackler.z);
  const fromBehind = tx * cfx + tz * cfz > 0.5;
  const def = statMul(tackler, 'defense');
  let chance = 0.03 + (tackler.sprinting ? 0.06 : 0) + (fromBehind ? 0.15 : 0) - def * 0.02;
  if (won) chance *= 0.35;
  if (Math.random() >= clamp(chance, 0.005, 0.3)) return false;
  let yellow;
  if (fromBehind && tackler.sprinting) yellow = Math.random() < 0.55;
  else if (fromBehind) yellow = Math.random() < 0.25;
  else yellow = Math.random() < 0.06;
  awardFoul(tackler, carrier, carrier.x, carrier.z, yellow);
  return true;
}

function awardFoul(offender, victim, atX, atZ, yellow = false) {
  foulCd = 40;
  stats.fouls[offender.isBlue ? 0 : 1]++;
  sndWhistle('short');
  referee.foulTimer = 50;
  referee.x = atX + 1.5;
  referee.z = atZ + 1.2;
  const inBox = inPenaltyBox(atX, atZ, offender.isBlue);
  const dogso = isDogso(offender, victim);

  if (dogso && !inBox) issueCard(offender, false);       // 레드
  else if (dogso && inBox) issueCard(offender, true);    // 박스 안: 페널티 + 경고 (삼중 처벌 완화 규칙)
  else if (yellow) issueCard(offender, true);

  if (inBox) {
    setTimeout(() => showMsg('페널티킥!', 1600), 900);
    const penX = offender.isBlue ? -FIELD_W / 2 + PEN_SPOT : FIELD_W / 2 - PEN_SPOT;
    beginSetpiece('penalty', victim.isBlue, penX, 0);
    return;
  }
  if (!yellow && !dogso) showMsg('파울 — 프리킥', 1200);
  beginSetpiece('freekick', victim.isBlue, clamp(atX, -FIELD_W / 2 + 3, FIELD_W / 2 - 3), clamp(atZ, -FIELD_H / 2 + 3, FIELD_H / 2 - 3));
}

/** 공 없는 몸싸움: 볼 캐리어를 뒤에서 전력으로 들이받으면 차징 파울 */
function checkFouls() {
  if (phase !== 'play' || foulCd > 0) return;
  const carrier = ball.owner;
  if (!carrier || ball.holdByGk) return;
  const opp = fieldPlayers(carrier.isBlue ? teamB : teamA);
  for (const a of opp) {
    if (a.role === 'GK' || !a.sprinting) continue;
    if (dist2(a, carrier) > PLAYER_R * 1.9) continue;
    a.chargeCd = (a.chargeCd || 0) - 1;
    if (a.chargeCd > 0) continue;
    a.chargeCd = 30;
    const [cfx, cfz] = norm2(carrier.faceX, carrier.faceZ);
    const [tx, tz] = norm2(carrier.x - a.x, carrier.z - a.z);
    if (tx * cfx + tz * cfz > 0.55 && Math.random() < 0.3) {
      awardFoul(a, carrier, carrier.x, carrier.z, Math.random() < 0.2);
      return;
    }
  }
}

function updatePlayer(p, isActive, dtSec) {
  if (p.sentOff) {
    p.vx = 0; p.vz = 0;
    return;
  }
  if (p.tackleCd > 0) p.tackleCd--;
  if (p.dispossessCd > 0) p.dispossessCd--;
  if (p.kickAnim > 0) p.kickAnim--;
  if (p.dive > 0) p.dive--;
  if (p.dive <= 0 && p.role === 'GK' && !p.penDive && p.jumpY > 0) p.jumpY = Math.max(0, p.jumpY - 0.05);
  p.sprinting = false;
  if (p.jumpY > 0) p.jumpY = Math.max(0, p.jumpY - 0.04);
  if (phase !== 'play') { p.tackle = null; p.stun = 0; }
  if (p.stun > 0 || p.tackle) {
    // 태클 중엔 태클 방향으로 미끄러지고, 실패한 슬라이딩 뒤엔 잠시 일어나는 중
    if (!updateTackle(p)) { p.stun--; p.vx *= 0.8; p.vz *= 0.8; }
    p.x = clamp(p.x + p.vx, -FIELD_W / 2 - 1.5, FIELD_W / 2 + 1.5);
    p.z = clamp(p.z + p.vz, -FIELD_H / 2 - 1.5, FIELD_H / 2 + 1.5);
    return;
  }

  if (p === userGkInPens() && (phase === 'setpiece' || phase === 'play')) {
    userPenGk(p);
  } else if (phase === 'kickoff') {
    p.vx = 0; p.vz = 0;
  } else if (phase === 'halftime' || phase === 'ended' || phase === 'goal_pause' || phase === 'et_offer') {
    p.vx *= 0.8; p.vz *= 0.8;
  } else if (phase === 'setpiece') {
    const penGk = setpiece?.type === 'penalty' && p.role === 'GK' && p.isBlue !== setpiece.teamBlue;
    const penWall = setpiece?.type === 'penalty' && p !== setpiece.taker && !penGk;
    const koWait = setpiece?.type === 'kickoff' && p !== setpiece.taker;
    if (penWall || penGk || koWait) {
      p.vx = 0; p.vz = 0;
    } else if (isActive && setpiece?.taker === p) {
      const aimed = setpiece.type === 'corner' || setpiece.type === 'freekick';
      const [dx, dz] = getInputDir();
      if (aimed) {
        // 세밀 조준: 살짝 누르면 아주 조금, 계속 누르고 있으면 점점 빨라짐
        const yawHeld = !fkRun && (keys.ArrowLeft || keys.ArrowRight), loftHeld = !fkRun && (keys.ArrowUp || keys.ArrowDown);
        aimHold.yaw = yawHeld ? aimHold.yaw + dtSec : 0;
        aimHold.loft = loftHeld ? aimHold.loft + dtSec : 0;
        const ramp = (h) => h < 0.35 ? 0.12 : Math.min(0.75, 0.12 + (h - 0.35) * 0.55);
        const yawSpeed = ramp(aimHold.yaw) * dtSec * realK();
        if (yawHeld && keys.ArrowLeft) setAimYaw -= yawSpeed;
        if (yawHeld && keys.ArrowRight) setAimYaw += yawSpeed;
        setAimYaw = clamp(setAimYaw, -0.9, 0.9);
        const loftSpeed = ramp(aimHold.loft) * 1.4 * dtSec * realK();
        if (loftHeld && keys.ArrowUp) setLoft = Math.min(1, setLoft + loftSpeed);
        if (loftHeld && keys.ArrowDown) setLoft = Math.max(-1, setLoft - loftSpeed);
        if (!fkRun) {
          refreshSetAim(setpiece.teamBlue, setpiece.type === 'freekick' ? ball : p);
          p.faceX = setAimX;
          p.faceZ = setAimZ;
        }
      } else if (setpiece.type === 'penalty') {
        // 키커 뒤 카메라 기준: ← 왼쪽, → 오른쪽으로 조준점 이동. 몸은 공을 봄
        const gs = setpiece.teamBlue ? 1 : -1;
        const mv = 3.2 * dtSec * realK();
        if (keys.ArrowLeft) penAimZ -= mv * gs;
        if (keys.ArrowRight) penAimZ += mv * gs;
        penAimZ = clamp(penAimZ, -GOAL_W / 2 - 0.8, GOAL_W / 2 + 0.8);
        [p.faceX, p.faceZ] = norm2(ball.x - p.x, ball.z - p.z);
      } else if (setpiece.type === 'kickoff') {
        [p.faceX, p.faceZ] = [setpiece.teamBlue ? 1 : -1, 0];
      } else if (dx || dz) {
        const rate = 1 - Math.pow(0.9, dtSec * 60);
        [p.faceX, p.faceZ] = turnToward(p.faceX, p.faceZ, dx, dz, rate);
      }
      p.vx = 0; p.vz = 0;
    } else if (setpiece?.taker === p && p.isBlue) {
      p.vx = 0; p.vz = 0;
    } else if (setpiece?.wall?.some(w => w.p === p)) {
      p.vx = 0; p.vz = 0;
    } else if (p.isBlue) aiTeammate(p);
    else aiOpponent(p);
  } else if (isActive) {
    if (pendingReceiver === p && ((ball.owner && ball.owner !== p) || ball.holdByGk)) pendingReceiver = null;
    const chasingPass = pendingReceiver === p && !ball.owner && !ball.holdByGk;
    if (chasingPass) {
      p.receiveTicks = (p.receiveTicks || 0) + 1;
      if (p.receiveTicks > 200) pendingReceiver = null;
    } else p.receiveTicks = 0;
    if (chasingPass && p.receiveTicks <= 200) {
      let meet = receivePoint(p);
      if (p.lobLand && p.lobLand.ttl-- > 0 && ball.y > 0.5) meet = p.lobLand; // 로빙 낙하지점에서 기다림
      else if (p.lobLand && ball.y <= 0.5 && ball.vy <= 0 && kickCooldown <= 0) p.lobLand = null; // 착지한 뒤에만 (차는 순간엔 공이 아직 땅에 있음)
      const rt = p.runTarget;
      if (rt && rt.ttl > 0) {
        // 공이 이미 출발했으면 '공이 실제로 지나갈 길'에서 앞쪽으로 만나는 지점으로 뜀
        // (침투 목표까지 갔다가 공이 덜 와서 되돌아오거나, 왔다 갔다 하지 않게)
        rt.ttl--;
        if (!ballPathLen) { if (Math.hypot(rt.x - p.x, rt.z - p.z) > 1.2) meet = rt; else p.runTarget = null; }
        else p.runTarget = null;
      }
      const dMeet = Math.hypot(meet.x - p.x, meet.z - p.z);
      const [mx, mz] = norm2(meet.x - p.x, meet.z - p.z);
      const [dx, dz] = getInputDir();
      let ix = mx;
      let iz = mz;
      if ((dx || dz) && dMeet > 0.3) {
        const dot = dx * mx + dz * mz;
        if (dot > 0.2 || dist2(p, ball) < 2.4) {
          ix = mx * 0.62 + dx * 0.38;
          iz = mz * 0.62 + dz * 0.38;
          const n = Math.hypot(ix, iz) || 1;
          ix /= n;
          iz /= n;
        }
      }
      if (dMeet > 0.55) {
        const rate = 1 - Math.pow(0.82, dtSec * 60);
        [p.faceX, p.faceZ] = turnToward(p.faceX || ix, p.faceZ || iz, ix, iz, rate);
        // E를 누르고 있거나 공이 멀면 전력질주 — 가까워졌다고 갑자기 걷지 않음
        p.sprinting = (keys.KeyE || keys.ShiftLeft || keys.ShiftRight || dist2(p, ball) > 7 || (p.runTarget && p.runTarget.ttl > 0)) && p.stamina > 3;
        const want = (p.sprinting ? SPRINT * sprintMult(p) : WALK * 1.3) * statMul(p, 'speed');
        const cur = Math.hypot(p.vx, p.vz);
        const spd = want >= cur ? lerp(cur, want, 0.35) : lerp(cur, want, 0.12); // 감속은 천천히
        p.vx = p.faceX * spd;
        p.vz = p.faceZ * spd;
      } else {
        p.vx *= 0.7;
        p.vz *= 0.7;
      }
    } else {
      const [dx, dz] = getInputDir();
      const wantSprint = (keys.KeyE || keys.ShiftLeft || keys.ShiftRight) && p.stamina > 1 && (dx || dz);
      p.sprinting = !!wantSprint;
      const spdStat = statMul(p, 'speed');
      const accStat = statMul(p, 'accel');
      const base = (p.role === 'GK' ? WALK * 0.95 : WALK) * spdStat;
      const sprint = (p.role === 'GK' ? SPRINT * 0.88 : SPRINT) * spdStat;
      // 공을 몰고 있으면 드리블 스탯만큼 조금 느려짐
      const dribPenalty = ball.owner === p ? 0.9 + statMul(p, 'dribbling') * 0.08 : 1;
      const targetSpd = (wantSprint ? sprint * sprintMult(p) : base) * dribPenalty;
      if (pshot && pshot.p === p && ball.owner === p) {
        // 파워 슛 게이지 중: 몸 방향 고정 (뒤돌 수 없음) · 방향키를 누르고 있으면 그 방향 그대로 계속 달림
        p.faceX = pshot.fx; p.faceZ = pshot.fz;
        const cur = Math.hypot(p.vx, p.vz);
        const next = (dx || dz) ? lerp(cur, targetSpd, 0.2) : cur * 0.75;
        p.vx = p.faceX * next; p.vz = p.faceZ * next;
      } else if (dx || dz) {
        const turnRate = 1 - Math.pow(0.9, dtSec * 60 * (0.85 + accStat * 0.3));
        [p.faceX, p.faceZ] = turnToward(p.faceX || dx, p.faceZ || dz, dx, dz, turnRate);
        const cur = Math.hypot(p.vx, p.vz);
        const blend = clamp(0.2 + accStat * 0.55, 0.25, 0.85);
        const next = lerp(cur, targetSpd, blend);
        p.vx = p.faceX * next;
        p.vz = p.faceZ * next;
      } else { p.vx *= 0.75; p.vz *= 0.75; }
    }
  } else if (p.isBlue) aiTeammate(p);
  else aiOpponent(p);

  updateStamina(p, dtSec, p.sprinting, isActive);

  p.x += p.vx;
  p.z += p.vz;
  p.x = clamp(p.x, -FIELD_W / 2 - 1.5, FIELD_W / 2 + 1.5);
  p.z = clamp(p.z, -FIELD_H / 2 - 1.5, FIELD_H / 2 + 1.5);
  if (p.role === 'GK') {
    // 키퍼도 박스 밖으로 나올 수 있음(규칙). AI 키퍼만 박스 안에 머물게 함
    if (!isActive) {
      if (p.isBlue) p.x = clamp(p.x, -FIELD_W / 2 + 0.3, -FIELD_W / 2 + PEN_W - 1);
      else p.x = clamp(p.x, FIELD_W / 2 - PEN_W + 1, FIELD_W / 2 - 0.3);
      p.z = clamp(p.z, -PEN_H / 2 + 1, PEN_H / 2 - 1);
    } else if (ball.holdByGk === p) {
      // 손으로 잡은 채 박스 밖으로 나가면 핸드볼 → 박스 경계에서 멈춤
      if (p.isBlue) p.x = Math.min(p.x, -FIELD_W / 2 + PEN_W - 0.6);
      p.z = clamp(p.z, -PEN_H / 2 + 0.6, PEN_H / 2 - 0.6);
    }
  }

  if (phase === 'play') tryPossess(p);
}

/** 선수끼리 겹치지 않게 밀어냄 */
/** 선수끼리 겹치지 않게 밀어냄 (몸통 지름 + 여유 = 1.1m) */
const BODY_GAP = 1.1;
function separatePlayers() {
  const list = allPlayers().filter(p => !p.sentOff);
  const locked = new Set();
  if (phase === 'setpiece' && setpiece) {
    if (setpiece.taker) locked.add(setpiece.taker);
    for (const w of setpiece.wall || []) locked.add(w.p);
  }
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        let dx = b.x - a.x, dz = b.z - a.z;
        let d = Math.hypot(dx, dz);
        if (d >= BODY_GAP) continue;
        if (d < 1e-4) { dx = Math.random() - 0.5; dz = Math.random() - 0.5; d = Math.hypot(dx, dz); }
        const nx = dx / d, nz = dz / d;
        const lockA = locked.has(a), lockB = locked.has(b);
        if (lockA && lockB) continue;
        const over = BODY_GAP - d;
        // 공 가진 선수는 덜 밀림 (몸싸움에서 공을 지킴)
        let wa = lockA ? 0 : ball.owner === a ? 0.3 : 1;
        let wb = lockB ? 0 : ball.owner === b ? 0.3 : 1;
        const sum = wa + wb || 1;
        a.x -= nx * over * (wa / sum); a.z -= nz * over * (wa / sum);
        b.x += nx * over * (wb / sum); b.z += nz * over * (wb / sum);
        // 서로를 향해 달리던 속도 성분은 줄임 (계속 파고드는 것 방지)
        const ra = a.vx * nx + a.vz * nz;
        if (ra > 0 && !lockA) { a.vx -= nx * ra * 0.5; a.vz -= nz * ra * 0.5; }
        const rb = b.vx * nx + b.vz * nz;
        if (rb < 0 && !lockB) { b.vx -= nx * rb * 0.5; b.vz -= nz * rb * 0.5; }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function updateReferee() {
  if (phase === 'kickoff') { referee.vx = referee.vz = 0; return; }
  if (referee.foulTimer > 0) {
    referee.foulTimer--;
    referee.vx = referee.vz = 0;
    return;
  }
  const ox = 3.5 + Math.sin(simTime / 900) * 1.2;
  const oz = -6 + Math.cos(simTime / 1100) * 1.5;
  const tx = clamp(ball.x + ox, -FIELD_W / 2 + 3, FIELD_W / 2 - 3);
  const tz = clamp(ball.z + oz, -FIELD_H / 2 + 3, FIELD_H / 2 - 3);
  const d = Math.hypot(tx - referee.x, tz - referee.z);
  if (d < 0.3) { referee.vx = referee.vz = 0; return; }
  const [dx, dz] = norm2(tx - referee.x, tz - referee.z);
  const spd = WALK * (d > 10 ? 1.3 : 0.85);
  referee.vx = dx * spd;
  referee.vz = dz * spd;
  referee.x += referee.vx;
  referee.z += referee.vz;
}

function releaseOpponentGk() {
  const gk = teamB.find(p => p.role === 'GK' && !p.sentOff);
  if (!gk || inPens || phase !== 'play') return;
  const holding = ball.holdByGk === gk || ball.owner === gk;
  if (!holding) {
    gk.holdTicks = 0;
    return;
  }
  gk.faceX = -1;
  gk.holdTicks = (gk.holdTicks || 0) + 1;
  const needed = ball.holdByGk === gk ? 50 : 12;
  if (gk.holdTicks < needed || kickCooldown > 0) return;

  const mates = teamB.filter(m => m !== gk && !m.sentOff && m.role !== 'GK');
  let best = null;
  let bestS = -Infinity;
  for (const m of mates) {
    const d = dist2(gk, m);
    if (d < 6 || d > 38) continue;
    let s = (gk.x - m.x) * 0.55 - d * 0.08;
    if (teamA.some(o => !o.sentOff && dist2(o, m) < 7)) s -= 12;
    if (m.position === 'CB' || m.position === 'CDM' || m.position === 'LB' || m.position === 'RB') s += 5;
    if (s > bestS) { bestS = s; best = m; }
  }
  let tx, tz, loft = false;
  if (best) {
    tx = best.x - 2;
    tz = best.z;
    loft = dist2(gk, best) > 18;
  } else {
    tx = gk.x - 26;
    tz = clamp(gk.z * 0.4 + (Math.random() - 0.5) * 12, -FIELD_H / 2 + 4, FIELD_H / 2 - 4);
    loft = true;
  }
  tx = clamp(tx, -FIELD_W / 2 + 6, FIELD_W / 2 - 6);
  tz = clamp(tz, -FIELD_H / 2 + 3, FIELD_H / 2 - 3);
  const kickStat = statMul(gk, 'gkKicking');
  if (best) {
    aiExecutePass(gk, best, loft);
  } else {
    const L = loftedLaunch(Math.hypot(tx - gk.x, tz - gk.z) * (0.9 + kickStat * 0.1), 0.6);
    kickFrom(gk, L.spd, tx, tz, { lift: 0.05, vy: L.vy });
    stats.passes[1]++;
  }
  gk.holdTicks = 0;
}

/** 내 키퍼가 손으로 6초 넘게 들고 있으면 자동 킥 (6초 룰) */
function releaseUserGk() {
  const gk = ball.holdByGk;
  if (!gk || !gk.isBlue || inPens || phase !== 'play') return;
  gk.holdTicks = (gk.holdTicks || 0) + 1;
  if (gk.holdTicks === 300) showMsg('6초 룰 — 공을 내보내세요!', 1200);
  if (gk.holdTicks >= 390 && kickCooldown <= 0) {
    const mate = pickAiPassTarget(gk, teamA);
    if (mate) {
      aiExecutePass(gk, mate, dist2(gk, mate) > 16);
      setActive(mate);
    }
    gk.holdTicks = 0;
  }
}

// ===== 세트피스 배치 =====
function buildPenaltyWall(teamBlue, taker, gk) {
  const goalSign = teamBlue ? 1 : -1;
  const wall = [];
  const others = allPlayers().filter(p => p !== taker && p !== gk && !p.sentOff);
  if (inPens) {
    // 승부차기: 나머지는 센터서클에 모임
    others.forEach((p, i) => {
      const x = (i % 2 ? 1.2 : -1.2);
      const z = -((others.length - 1) * 0.5) + i;
      wall.push({ p, x, z });
    });
  } else {
    // 페널티 박스 + 아크 밖에 대기
    const edgeX = goalSign * (FIELD_W / 2 - PEN_W) - goalSign * 2.2;
    const atk = others.filter(p => p.isBlue === teamBlue && p.role !== 'GK');
    const def = others.filter(p => p.isBlue !== teamBlue && p.role !== 'GK');
    const place = (list, xOff) => list.forEach((p, i) => {
      const z = -((list.length - 1) * 1.6) / 2 + i * 1.6;
      wall.push({ p, x: edgeX + xOff, z: Math.abs(z) < CIRCLE_R - 4 ? z + Math.sign(z || 1) * 5 : z });
    });
    place(atk, 0);
    place(def, -goalSign * 1.3);
    // 키커 팀 키퍼는 자기 골문 앞
    const ownGk = others.find(p => p.isBlue === teamBlue && p.role === 'GK');
    if (ownGk) wall.push({ p: ownGk, x: -goalSign * (FIELD_W / 2 - 3), z: 0 });
  }
  for (const w of wall) {
    w.p.x = w.x; w.p.z = w.z;
    w.p.vx = w.p.vz = 0;
    w.p.faceX = goalSign; w.p.faceZ = 0;
  }
  return wall;
}

/** 프리킥 수비벽: 공과 골 사이 9.15m, 거리에 따라 2~5명 */
function buildFreeKickWall(teamBlue, ballX, ballZ) {
  const goalX = (teamBlue ? 1 : -1) * (FIELD_W / 2);
  const distGoal = Math.hypot(goalX - ballX, ballZ);
  if (distGoal > 35) return [];
  const [dx, dz] = norm2(goalX - ballX, -ballZ);
  const wallDist = Math.min(SET_CLEAR, distGoal - 2);
  // 벽 중심은 가까운 골대 쪽으로 약간 치우침
  const cx = ballX + dx * wallDist;
  const cz = ballZ + dz * wallDist - Math.sign(ballZ) * 0.5;
  const px = -dz;
  const pz = dx;
  const count = distGoal < 22 ? 5 : distGoal < 28 ? 4 : 3;
  const defenders = (teamBlue ? teamB : teamA)
    .filter(p => p.role !== 'GK' && !p.sentOff)
    .sort((a, b) => dist2(a, { x: cx, z: cz }) - dist2(b, { x: cx, z: cz }))
    .slice(0, count);
  const gap = 0.75;
  const wall = [];
  defenders.forEach((p, i) => {
    const off = -((defenders.length - 1) * gap) / 2 + i * gap;
    const x = clamp(cx + px * off, -FIELD_W / 2 + 0.5, FIELD_W / 2 - 0.5);
    const z = clamp(cz + pz * off, -FIELD_H / 2 + 1, FIELD_H / 2 - 1);
    wall.push({ p, x, z });
    p.x = x;
    p.z = z;
    p.vx = 0;
    p.vz = 0;
    p.faceX = -dx;
    p.faceZ = -dz;
  });
  return wall;
}

function placeCornerPlayers(teamBlue, ballZ) {
  const goalSign = teamBlue ? 1 : -1;
  const atkTeam = teamBlue ? teamA : teamB;
  const defTeam = teamBlue ? teamB : teamA;
  const attackers = atkTeam.filter(p => !p.sentOff && p !== setpiece?.taker &&
    (p.role === 'ST' || p.role === 'WG' || p.role === 'CB' || p.position === 'CAM' || p.position === 'CM')).slice(0, 5);
  const spots = [[6, -3], [8, 2.5], [10.5, -0.5], [7, 5.5], [12, 4]];
  attackers.forEach((p, i) => {
    const [ox, oz] = spots[i];
    p.x = goalSign * (FIELD_W / 2 - ox);
    p.z = oz * Math.sign(ballZ || 1) * -1;
    p.vx = p.vz = 0;
    p.faceX = goalSign;
  });
  // 수비는 공격수를 골대 쪽에서 맨마킹 + 니어포스트 1명
  const defenders = defTeam.filter(p => !p.sentOff && p.role !== 'GK')
    .sort((a, b) => Math.abs(a.x - goalSign * FIELD_W / 2) - Math.abs(b.x - goalSign * FIELD_W / 2));
  attackers.forEach((a, i) => {
    const d = defenders[i];
    if (!d) return;
    d.x = a.x + goalSign * 0.9;
    d.z = a.z + (Math.random() - 0.5) * 0.6;
    d.vx = d.vz = 0;
    d.faceX = -goalSign;
  });
  const near = defenders[attackers.length];
  if (near) {
    near.x = goalSign * (FIELD_W / 2 - 1);
    near.z = Math.sign(ballZ || 1) * (GOAL_W / 2 + 0.5);
  }
}

function pushClear(p, x, z, minD) {
  let dx = p.x - x;
  let dz = p.z - z;
  let d = Math.hypot(dx, dz);
  if (d >= minD) return;
  if (d < 0.001) { dx = 0; dz = 1; d = 1; }
  p.x = x + (dx / d) * minD;
  p.z = z + (dz / d) * minD;
  p.vx = 0;
  p.vz = 0;
}

function enforceClearance() {
  if (phase !== 'setpiece' || !setpiece) {
    // 키퍼가 손으로 잡고 있을 땐 바로 앞에서 방해 못 하게
    if (ball.holdByGk && phase === 'play') {
      for (const p of allPlayers()) {
        if (p.sentOff || p.isBlue === ball.holdByGk.isBlue) continue;
        pushClear(p, ball.holdByGk.x, ball.holdByGk.z, 3);
      }
    }
    return;
  }
  const side = setpiece.teamBlue;
  const wallSet = new Set((setpiece.wall || []).map(w => w.p));
  for (const p of allPlayers()) {
    if (p.sentOff || p.isBlue === side || p === setpiece.taker || wallSet.has(p)) continue;
    if (setpiece.type === 'throw') pushClear(p, ball.x, ball.z, THROW_CLEAR);
    else if (setpiece.type === 'freekick' || setpiece.type === 'corner') pushClear(p, ball.x, ball.z, SET_CLEAR);
    else if (setpiece.type === 'goalkick') {
      // 골킥: 상대는 페널티 박스 밖
      const blueBox = side;
      if (inPenaltyBox(p.x, p.z, blueBox)) {
        p.x = blueBox ? -FIELD_W / 2 + PEN_W + 1 : FIELD_W / 2 - PEN_W - 1;
        p.vx = p.vz = 0;
      }
    }
  }
}

function enforceSetpieceShape() {
  if (phase !== 'setpiece' || !setpiece) return;
  for (const spot of setpiece.wall || []) {
    spot.p.x = spot.x;
    spot.p.z = spot.z;
    spot.p.vx = 0;
    spot.p.vz = 0;
  }
  if (setpiece.type === 'penalty' && setpiece.gk && !(setpiece.gk.dive > 0)) {
    setpiece.gk.x = setpiece.gkX;
    setpiece.gk.z = setpiece.gkZ ?? 0;
    setpiece.gk.vx = 0;
    setpiece.gk.vz = 0;
  }
}

// ===== 아웃 / 세트피스 =====
const SETPIECE_LABEL = {
  throw: '스로인',
  corner: '코너킥',
  goalkick: '골킥',
  freekick: '프리킥',
  penalty: '페널티킥',
};

function beginSetpiece(type, teamBlue, x, z, opts = {}) {
  if (ball.pass) resolvePass(type === 'throw' || type === 'corner' || type === 'goalkick' ? 'out' : 'fail');
  fkCam = null;
  fkRun = null;
  runRec = -1;
  if (fkMode && !opts.fk) { fkResult(false, type === 'goalkick' || type === 'corner' ? '골문 밖!' : '실패!'); return; }
  phase = 'setpiece';
  recCount = 0;
  thirdPersonCam = type === 'corner' || type === 'freekick';
  clockPaused = true;
  pendingReceiver = null;
  charge = { action: null, power: 0 };
  resetBall(x, z);
  ball.fromThrow = type === 'throw';
  if (type === 'throw') ball.y = 2.15;

  const team = teamBlue ? teamA : teamB;
  let taker = opts.taker || null;
  if (!taker && type === 'goalkick') taker = team.find(p => p.role === 'GK' && !p.sentOff);
  if (!taker) {
    let bestD = Infinity;
    for (const p of team) {
      if (p.role === 'GK' || p.sentOff) continue;
      const d = dist2(p, { x, z });
      if (d < bestD) { bestD = d; taker = p; }
    }
  }
  if (!taker) taker = team.find(p => !p.sentOff);
  if (!taker) return;

  const goalSign = teamBlue ? 1 : -1;
  if (type === 'goalkick') {
    ball.x = teamBlue ? -FIELD_W / 2 + SIX_W : FIELD_W / 2 - SIX_W;
    ball.z = clamp(z, -SIX_H / 2 + 1, SIX_H / 2 - 1);
  }
  // 키커는 공 뒤에 선다
  if (type === 'throw') {
    taker.x = ball.x;
    taker.z = ball.z + (ball.z > 0 ? 0.3 : -0.3);
    taker.faceX = 0;
    taker.faceZ = ball.z > 0 ? -1 : 1;
  } else {
    const [bx, bz] = norm2(ball.x - goalSign * (FIELD_W / 2), ball.z);
    const back = type === 'goalkick' ? 1.6 : 1.35;
    const [ux, uz] = type === 'goalkick' ? [-goalSign, 0] : [bx, bz];
    taker.x = ball.x + ux * back;
    taker.z = ball.z + uz * back;
    taker.faceX = -ux;
    taker.faceZ = -uz;
  }
  taker.vx = taker.vz = 0;
  ball.owner = taker;

  if (type === 'penalty') {
    const gk = (teamBlue ? teamB : teamA).find(pl => pl.role === 'GK' && !pl.sentOff);
    const gkX = teamBlue ? FIELD_W / 2 - 0.3 : -FIELD_W / 2 + 0.3;
    if (gk) {
      gk.x = gkX;
      gk.z = 0;
      gk.vx = gk.vz = 0;
      gk.faceX = teamBlue ? -1 : 1;
      gk.dive = 0;
    }
    setpiece = { type, teamBlue, x: ball.x, z: ball.z, taker, gk, gkX };
    setpiece.wall = buildPenaltyWall(teamBlue, taker, gk);
    taker.x = ball.x - goalSign * 3.6;
    taker.z = ball.z + goalSign * 3.2;
    [taker.faceX, taker.faceZ] = norm2(ball.x - taker.x, ball.z - taker.z);
    penAimZ = 0;
    penRun = null;
    if (gk) { gk.penDive = null; gk.jumpY = 0; }
  } else {
    setpiece = { type, teamBlue, x: ball.x, z: ball.z, taker, wall: null, indirect: !!opts.indirect };
    if (type === 'freekick') setpiece.wall = buildFreeKickWall(teamBlue, ball.x, ball.z);
    if (type === 'freekick' && teamBlue) {
      const [ux, uz] = norm2(ball.x - goalSign * (FIELD_W / 2), ball.z); // 공 → 내 쪽
      const side = taker.foot === 'left' ? 1 : -1;
      taker.x = ball.x + ux * 3.0 + uz * side * 1.5;
      taker.z = ball.z + uz * 3.0 - ux * side * 1.5;
      [taker.faceX, taker.faceZ] = norm2(ball.x - taker.x, ball.z - taker.z);
      setpiece.standX = taker.x; setpiece.standZ = taker.z;
    }
    else if (type === 'corner') placeCornerPlayers(teamBlue, ball.z);
  }
  if (teamBlue) setActive(taker);
  else taker.aiTimer = 40 + Math.floor(Math.random() * 25);

  const label = SETPIECE_LABEL[type] || type;
  setpieceHint.style.display = 'block';
  let hint = `${teamName(teamBlue)} ${label}${setpiece.indirect ? ' (간접)' : ''}`;
  if (teamBlue) {
    if (type === 'throw') hint += ' — 방향키로 받을 선수 · S 짧게(16m) / A 길게(26m)';
    else if (type === 'corner') hint += ' — ←→ 조준 · A 띄우기 / S 패스 / D 슛';
    else if (type === 'goalkick') hint += ' — S/A/W/D';
    else if (type === 'freekick') hint += ' — ←→ 조준 · A 띄우기 / S 패스 / D 슛';
    else if (type === 'penalty') hint += ' — 방향키 + D로 슛';
  }
  if (type === 'penalty') hint = teamBlue ? '방향키 + D 슛' : (userGkInPens() ? '방향키 + D 다이빙' : '');
  setpieceHint.textContent = hint;
  if (type === 'penalty' && !hint) setpieceHint.style.display = 'none';
  if (type === 'corner' || type === 'freekick') pointSetAimAtGoal(teamBlue, type === 'freekick' ? ball : taker);
  setLoft = 0;
  if (!inPens) showMsg(label, 1200);
  // 경기 중 프리킥·코너킥·페널티킥: 심판 휘슬 → 키커가 공을 세팅하는 장면
  if (!fkMode && !inPens && !opts.noIntro && (type === 'freekick' || type === 'corner' || type === 'penalty')) startSpIntro(type, label);
}

// ===== 사운드: 전부 Web Audio로 합성 (외부 파일 없음) =====
const SETTINGS_KEY = 'apexFootball.settings.v2';
const settings = Object.assign({ master: 0, bgm: 0, sfx: 0, crowd: 0, aspect: '16:9' }, /* 기본은 소리 꺼짐 */ (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; } })());
rebuildKeymap();
/** 게임 화면 비율: UI를 고정 해상도(높이 900 기준)로 만들고 창에 맞춰 통째로 확대/축소 — 어느 컴퓨터든 같은 배치, 휠 없이
 *  남는 곳은 검은 여백 · '꽉 채우기'는 높이 900에 창 비율대로 폭을 맞춤 */
const ASPECTS = { '16:9': [1600, 900], '16:10': [1600, 1000], '21:9': [2100, 900], '4:3': [1600, 1200] };
let stageScale = 1;
function applyAspect() {
  if (!wrap) return;
  const W = innerWidth, H = innerHeight;
  const [bw, bh] = ASPECTS[settings.aspect] || [Math.round(900 * W / H), 900];
  const sc = Math.min(W / bw, H / bh);
  stageScale = sc;
  Object.assign(wrap.style, { width: `${bw}px`, height: `${bh}px`, transform: `scale(${sc})`, left: `${Math.floor((W - bw * sc) / 2)}px`, top: `${Math.floor((H - bh * sc) / 2)}px` });
  wrap.style.setProperty?.('--vh', `${bh / 100}px`);
  camera.aspect = bw / bh;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min((window.devicePixelRatio || 1) * sc, 1.5));
  renderer.setSize(bw, bh);
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* 저장 불가 */ } }
const AU = { ctx: null, master: null, bgm: null, sfx: null, crowd: null, noise: null, amb: null, ambGain: null, dist: null, bgmOn: false, bgmT: 0, bgmStep: 0, drumNext: 0 };
function initAudio() {
  if (AU.ctx) { if (AU.ctx.state === 'suspended') AU.ctx.resume(); return; }
  try {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    const ctx = AU.ctx = new C();
    AU.master = ctx.createGain(); AU.master.connect(ctx.destination);
    // 전체가 너무 크지 않게 살짝 눌러 줌
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    comp.connect(AU.master);
    for (const k of ['bgm', 'sfx', 'crowd']) { AU[k] = ctx.createGain(); AU[k].connect(comp); }
    // 노이즈 버퍼 (관중·그물·킥)
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) { // 핑크 노이즈
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
    }
    AU.noise = buf;
    // 경기장 잔향 (넓은 공간 울림): 생성한 임펄스 응답
    const irLen = Math.floor(ctx.sampleRate * 3.2);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const dd = ir.getChannelData(ch);
      for (let i = 0; i < irLen; i++) {
        const tt = i / ctx.sampleRate;
        dd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 2.2) * (tt < 0.02 ? tt / 0.02 : 1) * 0.55;
      }
    }
    AU.verb = ctx.createConvolver(); AU.verb.buffer = ir;
    const verbOut = ctx.createGain(); verbOut.gain.value = 0.55;
    AU.verb.connect(verbOut); verbOut.connect(AU.crowd);
    // 관중 웅성거림: 여러 사람 목소리(성대 진동 + 모음 공명)를 겹친 소리 — 지직거리는 노이즈 대신
    AU.ambGain = ctx.createGain(); AU.ambGain.gain.value = 0;
    const amb = vowelBank(ctx, 520, 1450, 2500);
    amb.out.connect(AU.ambGain);
    AU.ambGain.connect(AU.crowd);
    const ambVerb = ctx.createGain(); ambVerb.gain.value = 0.6; AU.ambGain.connect(ambVerb); ambVerb.connect(AU.verb);
    for (let i = 0; i < 18; i++) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.value = 110 + Math.random() * 190;
      const jit = ctx.createOscillator(), jg = ctx.createGain(); jit.frequency.value = 0.3 + Math.random() * 1.2; jg.gain.value = 6 + Math.random() * 14;
      jit.connect(jg); jg.connect(o.frequency);
      const vg = ctx.createGain(); vg.gain.value = 0.02;
      const am = ctx.createOscillator(), ag = ctx.createGain(); am.frequency.value = 0.15 + Math.random() * 0.9; ag.gain.value = 0.02;
      am.connect(ag); ag.connect(vg.gain);
      o.connect(vg); vg.connect(amb.in);
      o.start(); jit.start(); am.start();
    }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const breath = ctx.createGain(); breath.gain.value = 0.25;
    src.connect(breath); breath.connect(amb.in); src.start();
    // 기타용 디스토션
    const ws = ctx.createWaveShaper(); const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 14) * 0.9; }
    ws.curve = curve; AU.distCurve = curve;
    applyVolumes();
  } catch (e) { AU.ctx = null; }
}
function applyVolumes() {
  if (!AU.ctx) return;
  const t = AU.ctx.currentTime;
  AU.master.gain.setTargetAtTime(settings.master, t, 0.05);
  AU.bgm.gain.setTargetAtTime(settings.bgm * 0.5, t, 0.05);
  AU.sfx.gain.setTargetAtTime(settings.sfx, t, 0.05);
  AU.crowd.gain.setTargetAtTime(settings.crowd, t, 0.05);
}
window.addEventListener('pointerdown', initAudio);
window.addEventListener('keydown', initAudio);

/** 모음 공명(포먼트) 3개를 가진 필터 묶음 — 사람 목소리 느낌 */
function vowelBank(ctx, f1, f2, f3) {
  const inp = ctx.createGain(), out = ctx.createGain();
  const fs = [];
  for (const [f, q, g] of [[f1, 5, 1], [f2, 7, 0.55], [f3, 9, 0.22]]) {
    const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = f; b.Q.value = q;
    const gg = ctx.createGain(); gg.gain.value = g * 2.2;
    inp.connect(b); b.connect(gg); gg.connect(out); fs.push(b);
  }
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
  const o2 = ctx.createGain(); out.connect(lp); lp.connect(o2);
  return { in: inp, out: o2, f: fs };
}
/** 군중 목소리: n명이 동시에 모음을 내지름 (와~ / 오~). 모음이 from → to 로 바뀜 */
function crowdShout({ n = 34, dur = 3, from = [320, 760, 2300], to = [780, 1250, 2600], pitchLo = 140, pitchHi = 380, rise = 1.25, fall = 0.85, gain = 0.5, spread = 0.35, verb = 0.8, t = 0 }) {
  const ctx = AU.ctx, t0 = ctx.currentTime + t;
  const bank = vowelBank(ctx, from[0], from[1], from[2]);
  bank.f.forEach((b, i) => { b.frequency.setValueAtTime(from[i], t0); b.frequency.exponentialRampToValueAtTime(to[i], t0 + 0.35); });
  const out = ctx.createGain(); out.gain.value = gain;
  bank.out.connect(out); out.connect(AU.crowd);
  const vs = ctx.createGain(); vs.gain.value = verb; out.connect(vs); vs.connect(AU.verb);
  for (let i = 0; i < n; i++) {
    const st = t0 + Math.random() * spread;
    const f = pitchLo + Math.random() * (pitchHi - pitchLo);
    const o = ctx.createOscillator(); o.type = Math.random() < 0.5 ? 'sawtooth' : 'triangle';
    o.frequency.setValueAtTime(f, st);
    o.frequency.exponentialRampToValueAtTime(f * rise, st + 0.3 + Math.random() * 0.2);
    o.frequency.exponentialRampToValueAtTime(f * rise * fall, st + dur);
    const vib = ctx.createOscillator(), vg = ctx.createGain(); vib.frequency.value = 4 + Math.random() * 3; vg.gain.value = f * 0.025;
    vib.connect(vg); vg.connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, st);
    g.gain.exponentialRampToValueAtTime(0.06, st + 0.12 + Math.random() * 0.1);
    g.gain.setValueAtTime(0.06, st + dur * (0.45 + Math.random() * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, st + dur);
    o.connect(g); g.connect(bank.in);
    o.start(st); vib.start(st); o.stop(st + dur + 0.05); vib.stop(st + dur + 0.05);
  }
  // 숨소리(목소리 거친 결) 약간
  const s = ctx.createBufferSource(); s.buffer = AU.noise;
  const ng = ctx.createGain(); ng.gain.setValueAtTime(0.0001, t0); ng.gain.exponentialRampToValueAtTime(0.35, t0 + 0.2); ng.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  s.connect(ng); ng.connect(bank.in); s.start(t0, Math.random()); s.stop(t0 + dur + 0.05);
}
function noiseHit(dest, { t = 0, dur = 0.3, type = 'bandpass', freq = 1000, q = 1, gain = 0.3, attack = 0.005, rate = 1 }) {
  const ctx = AU.ctx; const t0 = ctx.currentTime + t;
  const s = ctx.createBufferSource(); s.buffer = AU.noise; s.playbackRate.value = rate;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  s.connect(f); f.connect(g); g.connect(dest);
  s.start(t0, Math.random() * 1.5); s.stop(t0 + dur + 0.05);
  return f;
}
function tone(dest, { t = 0, f = 440, f2 = null, dur = 0.2, type = 'sine', gain = 0.2, attack = 0.005, release = null }) {
  const ctx = AU.ctx; const t0 = ctx.currentTime + t;
  const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t0);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + (release ?? dur));
  o.connect(g); g.connect(dest); o.start(t0); o.stop(t0 + (release ?? dur) + 0.05);
  return o;
}
const sfxOk = () => AU.ctx && AU.ctx.state === 'running';
/** 공 차는 소리 */
function sndKick(power = 0.5) {
  if (!sfxOk()) return;
  const p = clamp(power, 0.1, 1.4);
  tone(AU.sfx, { f: 150 + p * 40, f2: 55, dur: 0.12, gain: 0.25 + p * 0.25 });
  noiseHit(AU.sfx, { dur: 0.07, freq: 1800, q: 0.8, gain: 0.12 + p * 0.15 });
}
/** 그물 출렁이는 소리 */
function sndNet(power = 0.6) {
  if (!sfxOk()) return;
  noiseHit(AU.sfx, { dur: 0.55, freq: 3200, q: 0.5, gain: 0.12 + power * 0.12, attack: 0.02 });
  noiseHit(AU.sfx, { t: 0.04, dur: 0.4, type: 'highpass', freq: 5000, q: 0.3, gain: 0.06 });
}
/** 골대 맞는 소리 */
function sndPost() {
  if (!sfxOk()) return;
  for (const [f, g] of [[620, 0.18], [1310, 0.09], [2240, 0.05]]) tone(AU.sfx, { f, dur: 0.9, gain: g, type: 'sine' });
  noiseHit(AU.sfx, { dur: 0.06, freq: 2500, gain: 0.15 });
}
/** 휘슬: kind 'short' | 'long' | 'half'(짧게 두 번) | 'end'(세 번, 마지막 길게) */
function sndWhistle(kind = 'short') {
  if (!sfxOk()) return;
  const parts = kind === 'long' ? [[0, 0.9]] : kind === 'half' ? [[0, 0.35], [0.5, 0.9]] : kind === 'end' ? [[0, 0.35], [0.5, 0.35], [1.0, 1.2]] : [[0, 0.4]];
  for (const [t, dur] of parts) {
    const o = tone(AU.sfx, { t, f: 2650, dur, type: 'square', gain: 0.05, attack: 0.02 });
    const lfo = AU.ctx.createOscillator(), lg = AU.ctx.createGain();
    lfo.frequency.value = 30; lg.gain.value = 140; lfo.connect(lg); lg.connect(o.frequency);
    lfo.start(AU.ctx.currentTime + t); lfo.stop(AU.ctx.currentTime + t + dur + 0.05);
  }
}
/** 관중 함성 "와아아!" (골·좋은 장면) */
function sndCheer(power = 1) {
  if (!sfxOk()) return;
  crowdShout({ n: 40, dur: 4.2 * Math.min(1.2, power), gain: 0.55 * power, rise: 1.3, fall: 0.8 });
  crowdShout({ n: 20, dur: 3.2, gain: 0.3 * power, pitchLo: 260, pitchHi: 520, t: 0.15 }); // 높은 목소리 (환호)
}
function sndCheerOld(power = 1) {
  if (!sfxOk()) return;
  const ctx = AU.ctx, t0 = ctx.currentTime;
  for (const [f, q, g] of [[700, 0.7, 0.5], [1500, 0.9, 0.3], [300, 0.8, 0.35]]) {
    const s = ctx.createBufferSource(); s.buffer = AU.noise; s.loop = true;
    const fl = ctx.createBiquadFilter(); fl.type = 'bandpass'; fl.frequency.value = f; fl.Q.value = q;
    const gg = ctx.createGain(); gg.gain.setValueAtTime(0.0001, t0);
    gg.gain.exponentialRampToValueAtTime(g * power, t0 + 0.35);
    gg.gain.setValueAtTime(g * power, t0 + 1.6);
    gg.gain.exponentialRampToValueAtTime(0.0001, t0 + 4.5);
    s.connect(fl); fl.connect(gg); gg.connect(AU.crowd); s.start(t0, Math.random()); s.stop(t0 + 4.6);
  }
}
/** 관중 탄식·놀라는 소리 "오오~" */
function sndOoh(power = 1) {
  if (!sfxOk()) return;
  crowdShout({ n: 30, dur: 1.9, from: [420, 820, 2400], to: [460, 760, 2300], pitchLo: 150, pitchHi: 340, rise: 1.15, fall: 0.62, gain: 0.5 * power, spread: 0.2 });
}
function sndOohOld(power = 1) {
  if (!sfxOk()) return;
  const ctx = AU.ctx, t0 = ctx.currentTime;
  const s = ctx.createBufferSource(); s.buffer = AU.noise; s.loop = true;
  const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.Q.value = 4;
  f1.frequency.setValueAtTime(520, t0); f1.frequency.linearRampToValueAtTime(380, t0 + 1.4);
  const f2 = ctx.createBiquadFilter(); f2.type = 'lowpass'; f2.frequency.value = 1400;
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.9 * power, t0 + 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.7);
  s.connect(f1); f1.connect(f2); f2.connect(g); g.connect(AU.crowd); s.start(t0, Math.random()); s.stop(t0 + 1.8);
}
/** 서포터 큰북: 여러 명이 함께 치는 깊고 웅장한 소리 (+ 경기장 울림) */
function sndDrum(t = 0, g = 0.5) {
  if (!sfxOk()) return;
  const ctx = AU.ctx;
  const bus = ctx.createGain(); bus.gain.value = g;
  bus.connect(AU.crowd);
  const vs = ctx.createGain(); vs.gain.value = 0.9; bus.connect(vs); vs.connect(AU.verb);
  for (let k = 0; k < 3; k++) { // 북 3개가 살짝 어긋나게
    const t0 = ctx.currentTime + t + k * 0.012 + Math.random() * 0.01;
    const f = 62 + k * 9 + Math.random() * 4;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f * 1.9, t0); o.frequency.exponentialRampToValueAtTime(f, t0 + 0.06);
    o.frequency.exponentialRampToValueAtTime(f * 0.85, t0 + 0.8);
    const og = ctx.createGain(); og.gain.setValueAtTime(0.0001, t0); og.gain.exponentialRampToValueAtTime(0.55, t0 + 0.005); og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);
    o.connect(og); og.connect(bus); o.start(t0); o.stop(t0 + 0.95);
    // 북 가죽 배음
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.setValueAtTime(f * 2.7, t0); o2.frequency.exponentialRampToValueAtTime(f * 2.2, t0 + 0.2);
    const g2 = ctx.createGain(); g2.gain.setValueAtTime(0.12, t0); g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
    o2.connect(g2); g2.connect(bus); o2.start(t0); o2.stop(t0 + 0.3);
    // 채 닿는 소리
    const s = ctx.createBufferSource(); s.buffer = AU.noise;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const sg = ctx.createGain(); sg.gain.setValueAtTime(0.5, t0); sg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
    s.connect(lp); lp.connect(sg); sg.connect(bus); s.start(t0, Math.random()); s.stop(t0 + 0.1);
  }
}
/** 서포터 나팔 (응원 팡파르) */
function sndHorn(t = 0) {
  if (!sfxOk()) return;
  const seq = [[392, 0.16], [523, 0.16], [659, 0.16], [784, 0.34], [659, 0.14], [784, 0.6]];
  let tt = t;
  for (const [f, d] of seq) {
    const o = tone(AU.crowd, { t: tt, f, dur: d * 0.95, type: 'sawtooth', gain: 0.07, attack: 0.03 });
    const o2 = tone(AU.verb, { t: tt, f, dur: d * 0.95, type: 'sawtooth', gain: 0.05, attack: 0.03 }); o2.detune.value = 8;
    const vib = AU.ctx.createOscillator(), vg = AU.ctx.createGain();
    vib.frequency.value = 6; vg.gain.value = 5; vib.connect(vg); vg.connect(o.frequency);
    vib.start(AU.ctx.currentTime + tt); vib.stop(AU.ctx.currentTime + tt + d);
    tt += d;
  }
}
/** 경기 중 응원 (북 박자 · 가끔 나팔) — 매 프레임 호출 */
function updateCrowdAudio(now) {
  if (!AU.ctx) return;
  const inMatch = !inMenus() && phase !== 'intro';
  const target = inMatch ? 0.5 + crowdExcite * 0.9 : 0;
  AU.ambGain.gain.setTargetAtTime(target, AU.ctx.currentTime, 0.4);
  if (!sfxOk() || !inMatch || paused) return;
  if (now > AU.drumNext) {
    // 둥·둥·둥둥둥 — 홈 서포터 응원 박자
    const hype = crowdExcite > 0.3;
    const beats = hype ? [0, 0.3, 0.6, 0.9, 1.2, 1.5, 1.8, 2.1] : [0, 0.5, 1.0, 1.25, 1.5];
    for (const b of beats) sndDrum(b, hype ? 0.75 : 0.6);
    // 북 박자에 맞춰 서포터들이 "오!" 하고 외침
    if (hype || Math.random() < 0.5) crowdShout({ n: 22, dur: 0.5, from: [450, 800, 2400], to: [700, 1150, 2500], pitchLo: 150, pitchHi: 260, rise: 1.1, fall: 0.9, gain: 0.25, spread: 0.06, t: beats[beats.length - 1] + 0.05 });
    if (Math.random() < (hype ? 0.6 : 0.15)) sndHorn(hype ? 0.1 : 1.8);
    AU.drumNext = now + (hype ? 2000 : 5500 + Math.random() * 7000);
  }
}

// ----- 로비 배경음악: 신나는 록 밴드 (오리지널) — 디스토션 일렉기타 2대(좌/우) · 리드 기타 · 베이스 · 드럼 -----
const BGM_BPM = 182;
const E2 = 40;
// 구성 (마디 단위): 인트로 리프 2 → 벌스 4 → 코러스 4 → 벌스 4 → 코러스 4 → 기타 솔로 4 → 코러스 4
const BGM_FORM = ['intro', 'intro', 'verse', 'verse', 'verse', 'verse', 'chorus', 'chorus', 'chorus', 'chorus',
  'verse', 'verse', 'verse', 'verse', 'chorus', 'chorus', 'chorus', 'chorus', 'solo', 'solo', 'solo', 'solo', 'chorus', 'chorus', 'chorus', 'chorus'];
// 벌스 리프 (8분음표, 근음 · m=뮤트) — 직접 만든 리프
const RIFF = [
  [E2, 'm'], [E2, 'm'], [E2 + 3, 'o'], [E2, 'm'], [E2 + 5, 'o'], [E2, 'm'], [E2 + 7, 'o'], [E2 + 5, 'o'],
  [E2, 'm'], [E2, 'm'], [E2 + 3, 'o'], [E2, 'm'], [E2 + 10, 'o'], [E2 + 8, 'o'], [E2 + 7, 'o'], [E2 + 5, 'o'],
];
const CHORUS = [E2, E2 + 8, E2 + 3, E2 + 10]; // E5 – C5 – G5 – D5
const CH_LEAD = [ // 코러스 리드 (8분음표 · 0 쉼)
  79, 0, 79, 81, 83, 0, 81, 79,   76, 0, 76, 79, 81, 0, 79, 76,
  74, 0, 76, 79, 81, 0, 83, 86,   83, 0, 81, 79, 81, 0, 0, 0,
];
const SOLO = [88, 86, 83, 81, 83, 86, 88, 91, 88, 86, 83, 86, 83, 81, 79, 81, 83, 81, 79, 76, 79, 81, 83, 86, 88, 91, 93, 91, 88, 86, 88, 0];
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
function bgmBus() {
  if (AU.rock) return AU.rock;
  const ctx = AU.ctx;
  const mk = pan => {
    const ws = ctx.createWaveShaper(); ws.curve = AU.distCurve; ws.oversample = '2x';
    const pre = ctx.createGain(); pre.gain.value = 2.2;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1600; mid.Q.value = 0.9; mid.gain.value = 5;
    const cab = ctx.createBiquadFilter(); cab.type = 'lowpass'; cab.frequency.value = 4800; cab.Q.value = 0.8;
    const out = ctx.createGain(); out.gain.value = 0.16;
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    pre.connect(ws); ws.connect(hp); hp.connect(mid); mid.connect(cab); cab.connect(out);
    if (p) { p.pan.value = pan; out.connect(p); p.connect(AU.bgm); } else out.connect(AU.bgm);
    return pre;
  };
  AU.rock = { gL: mk(-0.7), gR: mk(0.7), lead: mk(0) };
  return AU.rock;
}
function gtrChord(t, root, dur, mute, side) {
  const ctx = AU.ctx, bus = bgmBus();
  const inp = side < 0 ? bus.gL : bus.gR;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(mute ? 0.5 : 0.75, t + 0.004);
  g.gain.exponentialRampToValueAtTime(mute ? 0.02 : 0.25, t + (mute ? 0.09 : dur * 0.9));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = mute ? 900 : 6000;
  g.connect(lp); lp.connect(inp);
  for (const iv of [0, 7, 12]) {
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.value = mtof(root + iv); o.detune.value = side * 7 + (Math.random() - 0.5) * 6;
    o.connect(g); o.start(t + (side > 0 ? 0.008 : 0)); o.stop(t + dur + 0.02);
  }
}
function gtrLead(t, note, dur, bend = false) {
  const ctx = AU.ctx, bus = bgmBus();
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.42, t + 0.01);
  g.gain.setValueAtTime(0.42, t + dur * 0.8);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(bus.lead);
  const o = ctx.createOscillator(); o.type = 'sawtooth';
  o.frequency.setValueAtTime(mtof(bend ? note - 2 : note), t);
  if (bend) o.frequency.exponentialRampToValueAtTime(mtof(note), t + Math.min(0.12, dur * 0.5));
  const vib = ctx.createOscillator(), vg = ctx.createGain(); vib.frequency.value = 6.2; vg.gain.value = dur > 0.25 ? 9 : 2;
  vib.connect(vg); vg.connect(o.frequency);
  o.connect(g); o.start(t); vib.start(t); o.stop(t + dur + 0.02); vib.stop(t + dur + 0.02);
}
function bgmBass(t, root, dur) {
  const ctx = AU.ctx;
  const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(root - 12);
  const ws = ctx.createWaveShaper(); ws.curve = AU.distCurve;
  const pre = ctx.createGain(); pre.gain.value = 0.6;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
  const g = ctx.createGain(); g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(pre); pre.connect(ws); ws.connect(lp); lp.connect(g); g.connect(AU.bgm); o.start(t); o.stop(t + dur + 0.02);
}
function bgmDrum(t, kind, vel = 1) {
  const ctx = AU.ctx;
  if (kind === 'k') { // 킥: 저음 + 비터 클릭
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    g.gain.setValueAtTime(0.75 * vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g); g.connect(AU.bgm); o.start(t); o.stop(t + 0.25);
    noiseAt(t, 0.015, 'highpass', 3000, 0.25 * vel);
  } else if (kind === 's') { // 스네어: 몸통 + 쇠줄
    const o = ctx.createOscillator(), og = ctx.createGain(); o.type = 'triangle';
    o.frequency.setValueAtTime(240, t); o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
    og.gain.setValueAtTime(0.35 * vel, t); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(og); og.connect(AU.bgm); o.start(t); o.stop(t + 0.14);
    noiseAt(t, 0.2, 'bandpass', 2600, 0.6 * vel, 0.6);
  } else if (kind === 'h') noiseAt(t, 0.035, 'highpass', 8000, 0.13 * vel);
  else if (kind === 'o') noiseAt(t, 0.18, 'highpass', 7000, 0.12 * vel);
  else if (kind === 'c') { noiseAt(t, 1.6, 'highpass', 5000, 0.32 * vel, 0.3); noiseAt(t, 0.9, 'bandpass', 9000, 0.15 * vel); } // 크래시
  else if (kind === 'r') noiseAt(t, 0.3, 'bandpass', 6000, 0.09 * vel, 2); // 라이드
  else if (kind === 't1' || kind === 't2') { // 탐 필인
    const o = ctx.createOscillator(), g = ctx.createGain();
    const f = kind === 't1' ? 180 : 120;
    o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.2);
    g.gain.setValueAtTime(0.5 * vel, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g); g.connect(AU.bgm); o.start(t); o.stop(t + 0.3);
  }
}
function noiseAt(t, dur, type, freq, gain, q = 0.8) {
  const ctx = AU.ctx;
  const s = ctx.createBufferSource(); s.buffer = AU.noise;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(AU.bgm); s.start(t, Math.random()); s.stop(t + dur + 0.02);
}
/** 로비에서만 재생: 앞부분을 미리 예약 (8분음표 단위) */
function updateBgm() {
  if (!AU.ctx || AU.ctx.state !== 'running') return;
  const want = inMenus();
  const ctx = AU.ctx;
  if (want && !AU.bgmOn) { AU.bgmOn = true; AU.bgmT = ctx.currentTime + 0.1; AU.bgmStep = 0; AU.bgm.gain.cancelScheduledValues(ctx.currentTime); AU.bgm.gain.setTargetAtTime(settings.bgm * 0.5, ctx.currentTime, 0.2); }
  if (!want && AU.bgmOn) { AU.bgmOn = false; AU.bgm.gain.setTargetAtTime(0, ctx.currentTime, 0.25); return; }
  if (!AU.bgmOn) return;
  const e8 = 60 / BGM_BPM / 2;
  while (AU.bgmT < ctx.currentTime + 0.3) {
    const st = AU.bgmStep, t = AU.bgmT;
    const barN = Math.floor(st / 8), b8 = st % 8;
    const part = BGM_FORM[barN % BGM_FORM.length];
    const prevPart = BGM_FORM[(barN - 1 + BGM_FORM.length) % BGM_FORM.length];
    const nextPart = BGM_FORM[(barN + 1) % BGM_FORM.length];
    const lastOfPart = nextPart !== part;
    if (part === 'intro' || part === 'verse') {
      const [root, kind] = RIFF[(barN % 2) * 8 + b8];
      const mute = kind === 'm';
      gtrChord(t, root, mute ? e8 * 0.9 : e8 * 1.6, mute, -1);
      if (part === 'verse') gtrChord(t, root, mute ? e8 * 0.9 : e8 * 1.6, mute, 1);
      if (part === 'verse') bgmBass(t, root, e8 * 0.85);
    } else {
      const root = part === 'solo' ? [E2, E2 + 3, E2 + 5, E2 + 7][barN % 4] : CHORUS[barN % 4];
      // 코러스: 열린 파워코드를 8분음표로 힘차게
      gtrChord(t, root, e8 * 1.05, false, -1);
      gtrChord(t, root, e8 * 1.05, false, 1);
      bgmBass(t, root, e8 * 0.9);
      if (part === 'chorus') { const n = CH_LEAD[(barN % 4) * 8 + b8]; if (n) gtrLead(t, n, e8 * (CH_LEAD[(barN % 4) * 8 + b8 + 1] === 0 ? 1.9 : 0.95), b8 === 0); }
      else { // 솔로: 16분음표 속주
        const i = ((barN % 4) * 16 + b8 * 2) % SOLO.length;
        if (SOLO[i]) gtrLead(t, SOLO[i], e8 * 0.48, b8 % 4 === 0);
        if (SOLO[i + 1]) gtrLead(t + e8 / 2, SOLO[i + 1], e8 * 0.48);
      }
    }
    // 드럼
    if (part !== 'intro' || barN % BGM_FORM.length === 1) {
      const loud = part === 'chorus' || part === 'solo';
      if (b8 === 0 && prevPart !== part) bgmDrum(t, 'c');
      if (lastOfPart && b8 >= 4) { // 필인
        bgmDrum(t, b8 < 6 ? 't1' : 't2'); bgmDrum(t + e8 / 2, b8 < 6 ? 't1' : 't2', 0.8);
        if (b8 === 7) bgmDrum(t, 's');
      } else if (part === 'intro') { if (b8 >= 4) { bgmDrum(t, 's', 0.6); bgmDrum(t + e8 / 2, 's', 0.7); } }
      else {
        if (b8 === 0 || b8 === 3 || b8 === 4 || (loud && b8 === 7)) bgmDrum(t, 'k');
        if (b8 === 2 || b8 === 6) bgmDrum(t, 's');
        bgmDrum(t, loud ? 'r' : 'h', b8 % 2 ? 0.7 : 1);
        if (loud && b8 === 4 && barN % 2 === 1) bgmDrum(t, 'c', 0.6);
      }
    }
    AU.bgmT += e8; AU.bgmStep++;
  }
}

const pick = a => a[Math.floor(Math.random() * a.length)];
// 해설은 삭제됨 — 호출부는 그대로 두고 아무것도 하지 않음
const comm = new Proxy({}, { get: () => () => {} });
function commStop() {}

// ===== 세트피스 연출: 휘슬 → 공 세팅 =====
let spIntro = null;
function playWhistle(long = false) { sndWhistle(long ? 'long' : 'short'); }
function startSpIntro(type, label) {
  const taker = setpiece.taker;
  if (!taker) return;
  const spot = { x: ball.x, z: ball.z };
  const stand = { x: taker.x, z: taker.z, fx: taker.faceX, fz: taker.faceZ };
  // 키커는 조금 떨어진 곳에서 공을 들고 걸어옴
  const [ox, oz] = norm2(taker.x - spot.x || -1, taker.z - spot.z || 0.01);
  const from = { x: spot.x + ox * 7 + oz * 2, z: clamp(spot.z + oz * 7 - ox * 2, -FIELD_H / 2 - 1, FIELD_H / 2 + 1) };
  taker.x = from.x; taker.z = from.z;
  // 심판은 공 근처에서 휘슬을 불며 지점을 가리킴
  const [rx, rz] = norm2(-spot.x * 0.3 + 1, -spot.z || 1);
  referee.x = clamp(spot.x + rx * 4.5, -FIELD_W / 2 + 1, FIELD_W / 2 - 1);
  referee.z = clamp(spot.z + rz * 4.5, -FIELD_H / 2 + 1, FIELD_H / 2 - 1);
  referee.vx = referee.vz = 0;
  referee.mesh.rotation.y = Math.atan2(spot.x - referee.x, spot.z - referee.z);
  referee.whistle = 1;
  spIntro = { t: 0, type, label, taker, spot, stand, from, hint: setpieceHint.textContent };
  phase = 'sp_intro';
  setpieceHint.style.display = 'none';
  ball.owner = null;
  playWhistle(type === 'penalty');
  const gx = setpiece.teamBlue ? FIELD_W / 2 : -FIELD_W / 2;
  if (type === 'penalty') comm.penalty();
  else if (type === 'corner') comm.corner(setpiece.teamBlue);
  else comm.freekick(setpiece.teamBlue, Math.hypot(spot.x - gx, spot.z) < 32);
  const sp = $('sp-banner');
  if (sp) { sp.textContent = label; sp.classList.remove('show'); void sp.offsetWidth; sp.classList.add('show'); }
}
function updateSpIntro() {
  const S = spIntro;
  if (!S) return;
  S.t++;
  const p = S.taker;
  const T1 = 55, T2 = 125, T3 = 140, T4 = 175;
  if (S.t <= T1) { // 휘슬 · 심판이 지점을 가리킴
    p.vx = p.vz = 0;
    holdBallInHands(p);
  } else if (S.t <= T2) { // 공을 들고 지점까지 걸어옴
    const tx = S.spot.x + (p.x - S.spot.x) * 0, tz = S.spot.z;
    const [dx, dz] = norm2(S.spot.x - p.x, S.spot.z - p.z);
    const d = Math.hypot(S.spot.x - p.x, S.spot.z - p.z);
    const st = Math.min(Math.max(0, d - 0.55), WALK * 0.9);
    p.vx = dx * st; p.vz = dz * st; p.x += p.vx; p.z += p.vz;
    [p.faceX, p.faceZ] = turnToward(p.faceX || dx, p.faceZ || dz, dx, dz, 0.2);
    holdBallInHands(p);
    referee.whistle = S.t < T1 + 20 ? 1 : 0;
  } else if (S.t <= T3) { // 공을 내려놓음
    p.vx = p.vz = 0;
    const k = (S.t - T2) / (T3 - T2);
    ball.x = lerp(ball.x, S.spot.x, 0.3); ball.z = lerp(ball.z, S.spot.z, 0.3);
    ball.y = lerp(1.0, BALL_R, k);
    p.crouch = Math.sin(k * Math.PI);
  } else { // 자리로 물러남
    p.crouch = 0;
    ball.x = S.spot.x; ball.z = S.spot.z; ball.y = BALL_R;
    const k = Math.min(1, (S.t - T3) / (T4 - T3));
    const nx = lerp(p.x, S.stand.x, 0.12), nz = lerp(p.z, S.stand.z, 0.12);
    p.vx = nx - p.x; p.vz = nz - p.z; p.x = nx; p.z = nz;
    if (k >= 1) endSpIntro();
  }
  ball.vx = ball.vz = ball.vy = 0;
}
function holdBallInHands(p) {
  ball.x = p.x + (p.faceX || 0) * 0.42;
  ball.z = p.z + (p.faceZ || 0) * 0.42;
  ball.y = 1.05;
}
function endSpIntro() {
  const S = spIntro;
  if (!S) return;
  spIntro = null;
  const p = S.taker;
  p.x = S.stand.x; p.z = S.stand.z; p.faceX = S.stand.fx; p.faceZ = S.stand.fz; p.vx = p.vz = 0; p.crouch = 0;
  ball.x = S.spot.x; ball.z = S.spot.z; ball.y = BALL_R; ball.vx = ball.vz = ball.vy = 0;
  ball.owner = p;
  referee.whistle = 0;
  phase = 'setpiece';
  setpieceHint.style.display = S.hint ? 'block' : 'none';
  $('sp-banner')?.classList.remove('show');
  if (!p.isBlue) p.aiTimer = 40 + Math.floor(Math.random() * 25);
  if (S.type === 'freekick' && p.isBlue) { // 조준 초기화
    pointSetAimAtGoal(true, ball);
  }
}

function onGoal(blueScored) {
  thirdPersonCam = false;
  const scorerTeamBlue = lastToucher ? lastToucher.isBlue : blueScored;
  // 스로인이 그대로 들어가면 득점 불가
  if (ball.fromThrow && !inPens) {
    showMsg('스로인은 직접 득점이 안 됩니다', 1500);
    ball.fromThrow = false;
    const intoBlueGoal = !blueScored;
    // 상대 골문 → 골킥, 자기 골문 → 상대 코너킥
    if (scorerTeamBlue !== intoBlueGoal) beginSetpiece('goalkick', intoBlueGoal, 0, 0);
    else beginSetpiece('corner', !intoBlueGoal, (intoBlueGoal ? -1 : 1) * (FIELD_W / 2 - 0.6), ball.z < 0 ? -FIELD_H / 2 + 0.6 : FIELD_H / 2 - 0.6);
    return;
  }
  // 간접 프리킥이 아무도 안 거치고 들어가면 무효 → 골킥
  if (ball.indirect && !inPens) {
    showMsg('간접 프리킥 — 득점 무효', 1500);
    beginSetpiece('goalkick', !blueScored, 0, 0);
    return;
  }

  const ownGoal = lastToucher && lastToucher.isBlue !== blueScored;
  lastGoalBlue = blueScored;
  if (fkMode) fkResult(blueScored);
  const ti = blueScored ? 0 : 1;

  if (!(inPens && penState)) {
    score[ti]++;
    stats.goals[ti]++;
    if (!ownGoal && ball.shotTeamBlue === blueScored) stats.shotsOnTarget[ti]++;
  }
  updateHud();
  phase = 'goal_pause';
  clockPaused = true;
  ball.owner = null;
  ball.holdByGk = null;
  setCrowdStanding(true);
  sndCheer(blueScored ? 1.2 : 0.6); sndWhistle('short');
  if (inPens) comm.pkGoal(); else comm.goal(blueScored, ownGoal ? null : lastToucher?.num, !!ownGoal);
  if (blueScored && !inPens) sndHorn(0.6);
  const scorer = lastToucher && !ownGoal ? ` ${lastToucher.num}번` : '';
  if (!inPens && !fkMode) {
    const sc = !ownGoal ? lastToucher : null;
    const as = sc && prevPossessor && prevPossessor.isBlue === sc.isBlue && prevPossessor !== sc ? prevPossessor : null;
    matchGoals.push({ blue: blueScored, own: !!ownGoal, num: sc?.num, label: sc?.label, anum: as?.num, alabel: as?.label });
  }
  showMsg(ownGoal ? '자책골!' : `⚽ ${teamName(blueScored)} GOAL!${scorer}`, 2500);

  // 골 직후는 생중계 카메라로 세리머니, 그다음 리플레이 2번
  replayMode = inPens ? null : 'live';
  replayGoalSide = blueScored ? 1 : -1;
  if (inPens) replayBadge.classList.add('show');
  goalRecLeft = 75;
  goalPauseTimer = inPens ? 65 : 78;
  if (inPens && penState && penWouldEnd(blueScored === penState.kickerBlue)) goalPauseTimer = 1; // 끝내기 골: 바로 세리머니

  if (inPens && penState) penState.pendingResult = blueScored === penState.kickerBlue;
}

function ballOutOfBounds() {
  return Math.abs(ball.x) > FIELD_W / 2 + 0.1 || Math.abs(ball.z) > FIELD_H / 2 + 0.1;
}

function checkOutOfPlay() {
  if (phase !== 'play' || ball.holdByGk) return;
  // 공을 몰고 라인 밖으로 나가도 아웃
  if (ball.owner) {
    if (!ballOutOfBounds()) return;
    touchBall(ball.owner);
    ball.owner = null;
  }

  const inGoalZ = Math.abs(ball.z) < GOAL_W / 2;
  if (ball.lastShot && !ball.oohDone && Math.abs(ball.x) > FIELD_W / 2 + 0.1 && !(inGoalZ && ball.y < GOAL_H)) { ball.oohDone = true; sndOoh(Math.abs(ball.z) < GOAL_W ? 1 : 0.6); if (inPens) comm.pkMiss(); else comm.miss(); }
  // 공 '전체'가 골라인을 넘어야 득점
  if (inGoalZ && ball.y < GOAL_H) {
    if (ball.x > FIELD_W / 2 + BALL_R) { onGoal(true); return; }
    if (ball.x < -FIELD_W / 2 - BALL_R) { onGoal(false); return; }
  }
  if (ball.inGoal) return; // 그물 안에서 굴러다니는 중

  const lastBlue = !!lastToucher?.isBlue;
  for (const side of [1, -1]) {
    if (side * ball.x <= FIELD_W / 2 + BALL_R) continue;
    if (inPens) return penMiss();
    const defendingBlue = side < 0; // 이 골라인을 지키는 팀
    const cz = ball.z < 0 ? -FIELD_H / 2 + 0.6 : FIELD_H / 2 - 0.6;
    if (lastBlue !== defendingBlue) beginSetpiece('goalkick', defendingBlue, 0, ball.z);
    else beginSetpiece('corner', !defendingBlue, side * (FIELD_W / 2 - 0.6), cz);
    return;
  }

  if (Math.abs(ball.z) > FIELD_H / 2 + BALL_R) {
    if (inPens) return penMiss();
    const x = clamp(ball.x, -FIELD_W / 2 + 1, FIELD_W / 2 - 1);
    beginSetpiece('throw', !lastBlue, x, Math.sign(ball.z || 1) * (FIELD_H / 2 + 0.2));
  }
}

/** 키퍼 몸(서 있을 때 · 다이빙 중 모두)에 공이 닿으면 막음 */
function gkSweepSave(px, py, pz) {
  if (!ball.lastShot || ball.owner || ball.holdByGk) return false;
  const gk = fieldPlayers(ball.shotTeamBlue ? teamB : teamA).find(p => p.role === 'GK');
  if (!gk) return false;
  const userCtl = gk === userGkInPens();
  const diving = gk.dive > 0;
  // 세로 높이별 손·발이 닿는 반경
  let rLow, rHigh, reachH;
  if (diving) {
    if (userCtl ? !gk.userSave : !gk.saveRoll) return false;
    rLow = userCtl ? 1.55 : 1.35; rHigh = userCtl ? 1.3 : 1.15; reachH = gk.diveHigh ? 2.8 : 2.2;
  } else {
    if (userCtl && gk.autoSaved) return false;
    rLow = 1.3; rHigh = 1.05; reachH = 2.35;
  }
  // 선분(px,pz)→(ball.x,ball.z)에서 키퍼에 가장 가까운 점
  const ax = ball.x - px, az = ball.z - pz;
  const len2 = ax * ax + az * az || 1e-6;
  const t = clamp(((gk.x - px) * ax + (gk.z - pz) * az) / len2, 0, 1);
  const cx = px + ax * t, cz = pz + az * t, cy = lerp(py, ball.y, t);
  const d = Math.hypot(gk.x - cx, gk.z - cz);
  const lift = gk.jumpY || 0;
  if (cy > reachH + lift) return false;
  if (d > (cy < 0.7 ? rLow : rHigh)) return false;
  if (userCtl) { if (diving) gk.userSave = false; else gk.autoSaved = true; }
  else gk.saveRoll = false;
  ball.x = cx; ball.z = cz; ball.y = Math.max(BALL_R, cy);
  executeSave(gk);
  return true;
}

function updateBallFree() {
  if (ball.owner || ball.holdByGk) return;
  if (phase !== 'play' && phase !== 'goal_pause' && phase !== 'fk_wait' && phase !== 'pen_celebrate') return;

  const px = ball.x, py = ball.y, pz = ball.z;
  const hitFrame = stepBallPhysics(ball);
  // 승부차기: 이번 프레임 동안 공이 지나간 '선분' 전체로 키퍼 몸에 닿았는지 검사
  // (공이 빨라서 한 프레임 사이에 키퍼를 통과해 버리는 문제 방지)
  if (inPens && phase === 'play' && gkSweepSave(px, py, pz)) return;
  if (ball.inGoal && !ball.netSnd && Math.abs(ball.x) > FIELD_W / 2 + GOAL_D - 0.5) { ball.netSnd = true; sndNet(Math.min(1, Math.hypot(ball.vx, ball.vz) * 2)); }
  if (hitFrame) {
    sndPost();
    if (phase === 'play') { sndOoh(1); comm.post(); }
    ball.blockedShot = true;
    ball.lastShot = false;
  }

  // 필드 선수에 의한 슛 블록
  if (ball.lastShot && phase === 'play') {
    for (const p of allPlayers()) {
      if (p.sentOff || p.role === 'GK') continue;
      if (p.isBlue === ball.shotTeamBlue) continue;
      if (ball.y >= 1.8 || p.blockTry === ball.kph) continue;
      // 공이 이번 프레임에 지나간 길 위 '앞쪽'에 있는 수비수만 막을 수 있음
      // (달리는 슈터 옆 · 뒤에 붙어 있는 수비수가 차자마자 막아 버리던 문제 수정)
      const ahead = (p.x - px) * ball.vx + (p.z - pz) * ball.vz > 0;
      const dd = segPointDist(p.x, p.z, px, pz, ball.x, ball.z);
      if (!ahead || dd > PLAYER_R + 0.35) continue;
      p.blockTry = ball.kph; // 한 슛에 선수당 한 번만 판정
      if (Math.random() < clamp(0.9 - dd * 0.45, 0.4, 0.9)) {
        ball.vx *= -0.25 + (Math.random() - 0.5) * 0.2;
        ball.vz += (Math.random() - 0.5) * 0.35;
        ball.wx = ball.wy = ball.wz = 0;
        ball.blockedShot = true;
        ball.lastShot = false;
        touchBall(p);
        break;
      }
    }
  }

  if (phase === 'play') checkOutOfPlay();
}

// ===== 경기 진행 =====
function recoverStamina(amount) {
  for (const p of allPlayers()) p.stamina = Math.min(100, p.stamina + amount);
}

function startSecondHalf() {
  half = 2;
  matchMinute = 45;
  recoverStamina(35);
  overlay.classList.remove('show');
  beginKickoff(false);
  showMsg('후반전 시작!');
  comm.second();
  updateHud();
}

function startExtraTime() {
  half = 3;
  matchMinute = 90;
  recoverStamina(25);
  overlay.classList.remove('show');
  beginKickoff(true);
  showMsg('연장전 전반!');
  updateHud();
}

function startEtSecond() {
  half = 4;
  matchMinute = 105;
  recoverStamina(15);
  overlay.classList.remove('show');
  beginKickoff(false);
  showMsg('연장전 후반!');
  updateHud();
}

function offerExtraTime() {
  phase = 'et_offer';
  clockPaused = true;
  matchMinute = 90;
  overlayTitle.textContent = '정규시간 종료';
  overlaySub.textContent = '무승부 — 연장전(15+15) 진행';
  spaceHint.textContent = 'SPACE — 연장전 시작';
  spaceHint.style.display = 'block';
  statsBox.style.display = 'none';
  overlay.classList.add('show');
  updateHud();
}

function buildStatsHtml(winner) {
  const pkLine = penState && penState.blueTaken + penState.redTaken > 0
    ? `<div class="pk-under"><span>(${penState.blueGoals})</span><span>(${penState.redGoals})</span></div>` : '';
  if (pkOnly && penState) {
    // 승부차기 모드: 스코어 · (승부차기 점수) · 키커별 결과만
    const col = (log, blue) => log.map((k, i) =>
      `<div class="kick-row"><span>${i + 1}번 키커</span><span>${k.num}번 ${k.label}</span><b class="${k.ok ? 'ok' : 'no'}">${k.ok ? 'O' : 'X'}</b></div>`).join('') || '<div class="kick-row"><span>-</span></div>';
    return `
      <div class="end-teams"><span>${escapeHtml(teamName(true))}</span><span>${escapeHtml(teamName(false))}</span></div>
      <h3>${score[0]} - ${score[1]}</h3>
      ${pkLine}
      <div class="kick-cols"><div>${col(penState.blueLog, true)}</div><div>${col(penState.redLog, false)}</div></div>`;
  }
  const possTotal = stats.possession[0] + stats.possession[1] || 1;
  const possB = Math.round(stats.possession[0] / possTotal * 100);
  const possR = 100 - possB;
  return `
    <h3>${score[0]} - ${score[1]}</h3>
    ${pkLine}
    <div class="row"><span>승팀</span><span>${winner}</span></div>
    <div class="row"><span>팀</span><span>${teamName(true)} / ${teamName(false)}</span></div>
    <div class="row"><span>패스</span><span>${stats.passes[0]} / ${stats.passes[1]}</span></div>
    <div class="row"><span>점유율</span><span>${possB}% / ${possR}%</span></div>
    <div class="row"><span>슈팅</span><span>${stats.shots[0]} / ${stats.shots[1]}</span></div>
    <div class="row"><span>유효슈팅</span><span>${stats.shotsOnTarget[0]} / ${stats.shotsOnTarget[1]}</span></div>
    <div class="row"><span>득점</span><span>${stats.goals[0]} / ${stats.goals[1]}</span></div>
    <div class="row"><span>파울</span><span>${stats.fouls[0]} / ${stats.fouls[1]}</span></div>
    <div class="row"><span>옐로카드</span><span>${stats.yellows[0]} / ${stats.yellows[1]}</span></div>
    <div class="row"><span>레드카드</span><span>${stats.reds[0]} / ${stats.reds[1]}</span></div>
  `;
}

/** A코인 보상: 결과 · 경기 내용 · 리그(대회) 수준에 따라 */
let matchReward = null;
function calcReward(winner) {
  if (pkOnly || fkMode) return null;
  const won = winner === teamName(true), lost = !won && winner !== '무승부';
  const lgIdx = Math.max(0, LEAGUES.findIndex(l => l.id === userSetup.leagueId));
  const mult = isApc() ? 1.6 : LEAGUE_MULT[lgIdx] || 1;
  const items = [];
  items.push([won ? '승리' : lost ? '패배' : '무승부', won ? 1500 : lost ? 300 : 700]);
  const g = Math.min(6, score[0]);
  if (g) items.push([`득점 ${g}골`, g * 120]);
  const diff = score[0] - score[1];
  if (diff > 0) items.push([`득실차 +${diff}`, Math.min(5, diff) * 100]);
  if (score[1] === 0) items.push(['무실점', 200]);
  const sot = Math.min(15, stats.shotsOnTarget[0]);
  if (sot) items.push([`유효슈팅 ${sot}`, sot * 15]);
  const pt = stats.possession[0] + stats.possession[1] || 1;
  const poss = Math.round(stats.possession[0] / pt * 100);
  if (poss > 50) items.push([`점유율 ${poss}%`, (poss - 50) * 6]);
  let total = items.reduce((a, [, v]) => a + v, 0) * mult;
  const extra = [];
  total = Math.round(total / 10) * 10;
  return { total, items, extra, mult };
}
function giveReward(winner) {
  matchReward = calcReward(winner);
  if (!matchReward) return;
  userSetup.coins = (userSetup.coins || 0) + matchReward.total;
  const won = winner === teamName(true), lost = !won && winner !== '무승부';
  matchReward.exp = (won ? 120 : lost ? 40 : 70) + Math.min(60, score[0] * 10);
  matchReward.lvUp = addClubExp(matchReward.exp);
  saveSetup();
}
function rewardHtml() {
  const r = matchReward;
  if (!r) return '';
  const fmt = n => Math.round(n).toLocaleString();
  return `<div class="reward"><div class="rw-h"><span class="coin">A</span> 획득 A코인 <b>+${fmt(r.total)}</b></div>
    <div class="rw-items">${r.items.map(([k, v]) => `<span>${k} ${fmt(v)}</span>`).join('')}${r.mult !== 1 ? `<span>× ${isApc() ? '대회' : '리그'} 보정 ${r.mult}</span>` : ''}${r.extra.map(([k, v]) => `<span class="bonus">${k} +${fmt(v)}</span>`).join('')}</div>
    <div class="rw-sum">보유 ${fmt(userSetup.coins || 0)} A코인 · 구단 EXP +${r.exp || 0}${r.lvUp ? ` · <b class="lvup">레벨 업! Lv.${ensureClub().lv}</b>` : ''}</div>${r.lvUp ? `<div class="rw-lv">🎁 레벨 업 보상: ${rewardText(lastLevelReward)} — '내 아이템'에서 확인</div>` : ''}</div>`;
}

function endMatch(forceWinner = null) {
  if (!pkOnly && !fkMode) sndWhistle('end');
  phase = 'ended';
  clockPaused = true;
  inPens = false;
  setpiece = null;
  setpieceHint.style.display = 'none';
  if (half <= 2) matchMinute = 90;
  else matchMinute = 120;
  const winner = forceWinner || (score[0] > score[1] ? teamName(true) : score[1] > score[0] ? teamName(false) : '무승부');
  overlayTitle.textContent = '경기 종료';
  overlaySub.textContent = winner === '무승부' ? '무승부' : `승: ${winner}${penState ? ' (승부차기)' : ''}`;
  spaceHint.textContent = 'SPACE — 메뉴로';
  spaceHint.style.display = 'block';
  statsBox.style.display = 'block';
  giveReward(winner);
  let seasonHtml = '';
  if (apcOpp?.kind === 'league') seasonHtml = seasonRecordUserResult();
  else if (apcOpp) apcRecordUserResult(winner === teamName(true));
  spaceHint.textContent = apcOpp?.kind === 'league' ? 'SPACE — 리그 순위표로' : apcOpp ? 'SPACE — 대회로' : 'SPACE — 메뉴로';
  statsBox.innerHTML = buildStatsHtml(winner) + rewardHtml() + seasonHtml;
  if (!pkOnly) setTimeout(() => comm.end(winner), 1300);
  overlay.classList.add('show');
  updateHud();
}

// ===== 승부차기 =====
/** 페널티 실력 (페널티 킥 65% + 골 결정력 35%, 체력 반영) */
function penRating(p) { return statMul(p, 'penalty') * 0.65 + statMul(p, 'finishing') * 0.35; }
function penOrder(team) {
  // 페널티 실력 순, 키퍼는 마지막
  const rank = { ST: 0, WG: 1, MF: 2, FB: 3, CB: 4, GK: 5 }; // 실력이 같으면 공격수부터
  return fieldPlayers(team).sort((a, b) => (a.role === 'GK') - (b.role === 'GK') || penRating(b) - penRating(a) || (rank[a.role] ?? 3) - (rank[b.role] ?? 3));
}
/** 내 팀 기본 순서: 저장된 순서 → 나머지는 실력 순 */
function myPenOrder() {
  const avail = fieldPlayers(teamA);
  const saved = (userSetup.pkOrder || []).map(n => avail.find(p => p.num === n)).filter(Boolean);
  const rest = penOrder(teamA).filter(p => !saved.includes(p));
  return [...saved, ...rest];
}

// ----- 승부차기 키커 순서 설정 화면 -----
let penOrderUi = null;
function openPenOrder() {
  phase = 'pen_order';
  penOrderUi = { order: myPenOrder(), cur: 0, sel: -1 };
  setMatchHudVisible(false);
  setpieceHint.style.display = 'none';
  $('pen-order')?.classList.add('show');
  renderPenOrder();
  if (globalThis.__autoPenOrder) confirmPenOrder(); // (자동 테스트)
}
function penOrderClick(i) {
  const u = penOrderUi;
  if (!u) return;
  u.cur = i;
  if (u.sel < 0) u.sel = i;
  else {
    if (u.sel !== i) [u.order[u.sel], u.order[i]] = [u.order[i], u.order[u.sel]];
    u.sel = -1;
  }
  renderPenOrder();
}
function renderPenOrder() {
  const el = $('pen-order');
  const u = penOrderUi;
  if (!el || !u) return;
  const css = colorById(userSetup.colorId || 'blue').css;
  const v = (p, k) => Math.round((p.customStats?.[k] ?? STAT_BASE) - staminaPenalty(p));
  const bars = (p) => {
    const n = Math.max(1, Math.ceil((p.stamina ?? 100) / 20));
    let h = '';
    for (let i = 0; i < 5; i++) h += `<i class="${i < n ? 'on' : ''} ${n <= 2 ? 'low' : ''}"></i>`;
    return `<span class="po-bars">${h}</span>`;
  };
  const top = u.order[u.cur] || u.order[0];
  const rows = u.order.map((p, i) => `
    <div class="po-row ${i === u.cur ? 'cur' : ''} ${i === u.sel ? 'sel' : ''} ${i < 5 ? 'first5' : ''}" data-i="${i}">
      <span class="po-n">${i + 1}</span>
      <span class="po-name">${faceImg('sm')}<b class="po-pos">${escapeHtml(p.label)}</b>${p.num}번 ${p.role === 'GK' ? '골키퍼' : escapeHtml(p.position || p.label)}</span>
      <span>${v(p, 'penalty')}</span><span>${v(p, 'finishing')}</span><span>${v(p, 'shotPower')}</span><span>${bars(p)}</span>
    </div>`).join('');
  el.innerHTML = `
    <div class="po-box">
      <div class="po-head">
        <svg class="po-crest" viewBox="0 0 64 72">${crestSvg(css, (teamName(true)[0] || 'A').toUpperCase())}</svg>
        <span class="po-club">${escapeHtml(teamName(true))}</span>
      </div>
      <div class="po-sub">승부차기 키커 선택</div>
      <div class="po-top">
        <div class="po-face">${faceImg()}</div>
        <div class="po-topname"><b class="po-pos">${escapeHtml(top.label)}</b> ${top.num}번 선수</div>
        <div class="po-stat"><small>페널티 킥</small><b>${v(top, 'penalty')}</b></div>
        <div class="po-stat"><small>골 결정력</small><b>${v(top, 'finishing')}</b></div>
        <div class="po-stat"><small>슛 파워</small><b>${v(top, 'shotPower')}</b></div>
        <div class="po-ring"><small>수행능력</small>${bars(top)}</div>
      </div>
      <div class="po-th"><span>순서</span><span>선수명</span><span>페널티 킥</span><span>골 결정력</span><span>슛 파워</span><span>수행능력</span></div>
      <div class="po-list">${rows}</div>
      <div class="po-foot">
        <span class="po-help">${u.sel >= 0 ? `<b>${u.sel + 1}번</b>과 바꿀 선수를 고르세요` : '선수를 두 번 골라 순서를 바꿔요'} · <kbd>↑</kbd><kbd>↓</kbd> 이동 · <kbd>Space</kbd> 선택 · <kbd>Enter</kbd> 준비 완료</span>
        <button type="button" class="po-ready" id="btn-pen-ready">준비 완료</button>
      </div>
    </div>`;
  el.querySelectorAll('.po-row').forEach(r => r.addEventListener('click', () => penOrderClick(Number(r.dataset.i))));
  $('btn-pen-ready')?.addEventListener('click', confirmPenOrder);
}
function penOrderKey(code) {
  const u = penOrderUi;
  if (!u) return;
  if (code === 'ArrowUp') { u.cur = (u.cur + u.order.length - 1) % u.order.length; renderPenOrder(); }
  else if (code === 'ArrowDown') { u.cur = (u.cur + 1) % u.order.length; renderPenOrder(); }
  else if (code === 'Space' || code === 'KeyD') penOrderClick(u.cur);
  else if (code === 'Enter') confirmPenOrder();
}
function confirmPenOrder() {
  if (phase !== 'pen_order' || !penOrderUi) return;
  userSetup.pkOrder = penOrderUi.order.map(p => p.num);
  saveSetup();
  penState.blueOrder = penOrderUi.order.slice();
  penOrderUi = null;
  $('pen-order')?.classList.remove('show');
  setMatchHudVisible(true);
  showMsg('승부차기!', 2000);
  setupPenKick();
}

function startPenaltyShootout() {
  inPens = true;
  clockPaused = true;
  overlay.classList.remove('show');
  penState = {
    blueTaken: 0, redTaken: 0, blueGoals: 0, redGoals: 0,
    sudden: false, waiting: false, kickerBlue: true, shotTimer: 0,
    blueOrder: penOrder(teamA), redOrder: penOrder(teamB),
    blueHist: [], redHist: [], blueLog: [], redLog: [], curTaker: null,
  };
  openPenOrder(); // 키커 순서를 정한 뒤 시작
}

/** 이번 킥 결과(성공/실패)에 따라 승부차기가 끝날 수 있는지 */
function penWouldEnd(scored) {
  let b = penState.blueTaken, r = penState.redTaken, bg = penState.blueGoals, rg = penState.redGoals;
  if (penState.kickerBlue) { b++; if (scored) bg++; } else { r++; if (scored) rg++; }
  if (!penState.sudden) {
    if (bg > rg + (5 - r) || rg > bg + (5 - b)) return true;
    if (b >= 5 && r >= 5) return bg !== rg;
    return false;
  }
  return b === r && bg !== rg;
}

// ----- 결정적인 킥: 키커가 공을 들고 와서 직접 세팅하는 장면 -----
let penPostRec = 0;
function startPenCut() {
  const p = setpiece.taker;
  const gs = setpiece.teamBlue ? 1 : -1;
  const sx = setpiece.x, sz = setpiece.z;
  setpiece.cut = {
    t: 0, T: 86,
    from: { x: sx - gs * 7, z: sz - gs * 2.5 },
    spot: { x: sx, z: sz },
    place: { x: sx - gs * 0.55, z: sz },
    back: { x: p.x, z: p.z }, // 원래 도움닫기 자리
  };
  p.x = setpiece.cut.from.x; p.z = setpiece.cut.from.z;
  showMsg('결정적인 순간!', 1800);
  setpieceHint.textContent = `◆ 결정적인 킥 — ${teamName(setpiece.teamBlue)} ${p.num}번이 공을 세팅합니다 · Space 건너뛰기`;
}
function endPenCut() {
  const c = setpiece?.cut;
  if (!c) return;
  const p = setpiece.taker;
  p.x = c.back.x; p.z = c.back.z; p.vx = p.vz = 0; p.crouch = 0;
  [p.faceX, p.faceZ] = norm2(c.spot.x - p.x, c.spot.z - p.z);
  ball.x = c.spot.x; ball.z = c.spot.z; ball.y = BALL_R;
  setpiece.cut = null;
  const n = (setpiece.teamBlue ? penState.blueTaken : penState.redTaken);
  setpieceHint.textContent = setpiece.teamBlue ? '방향키 + D 슛' : '방향키 + D 다이빙';
  if (!setpiece.teamBlue) p.aiTimer = 45;
}
function updatePenCut() {
  const c = setpiece?.cut;
  if (!c || phase !== 'setpiece') return;
  const p = setpiece.taker;
  c.t++;
  const walk = (a, b, k) => {
    const nx = lerp(a.x, b.x, k), nz = lerp(a.z, b.z, k);
    p.vx = nx - p.x; p.vz = nz - p.z;
    p.x = nx; p.z = nz;
  };
  if (c.t <= 36) {                                   // 공을 들고 걸어옴
    walk(c.from, c.place, c.t / 36);
    [p.faceX, p.faceZ] = norm2(c.place.x - c.from.x, c.place.z - c.from.z);
    ball.x = p.x + p.faceX * 0.32; ball.z = p.z + p.faceZ * 0.32; ball.y = 1.05;
  } else if (c.t <= 58) {                            // 쭈그려 앉아 공을 내려놓음
    p.vx = p.vz = 0;
    const k = (c.t - 36) / 22;
    p.crouch = Math.sin(Math.PI * k);
    [p.faceX, p.faceZ] = norm2(c.spot.x - p.x, c.spot.z - p.z);
    const down = clamp(k * 1.8, 0, 1);
    ball.x = lerp(p.x + p.faceX * 0.32, c.spot.x, down);
    ball.z = lerp(p.z + p.faceZ * 0.32, c.spot.z, down);
    ball.y = lerp(1.05, BALL_R, down);
  } else if (c.t <= c.T) {                           // 뒷걸음으로 도움닫기 자리로
    p.crouch = 0;
    walk(c.place, c.back, (c.t - 58) / (c.T - 58));
    [p.faceX, p.faceZ] = norm2(c.spot.x - p.x, c.spot.z - p.z);
    ball.x = c.spot.x; ball.z = c.spot.z; ball.y = BALL_R;
  } else endPenCut();
  ball.vx = ball.vy = ball.vz = 0;
}

function setupPenKick() {
  clearCelebrations();
  replayBadge.classList.remove('show');
  replayMode = null;
  for (const p of allPlayers()) { p.dive = 0; p.diveZ = null; p.saveRoll = false; }
  const blueTurn = penState.kickerBlue;
  const order = blueTurn ? penState.blueOrder : penState.redOrder;
  const n = blueTurn ? penState.blueTaken : penState.redTaken;
  const taker = order[n % order.length];
  const penX = blueTurn ? FIELD_W / 2 - PEN_SPOT : -FIELD_W / 2 + PEN_SPOT;
  penState.waiting = false;
  penState.pendingResult = undefined;
  penState.decisive = penWouldEnd(true) || penWouldEnd(false);
  penState.curTaker = taker;
  penCam = { x: penX, z: 0, gs: blueTurn ? 1 : -1 };
  beginSetpiece('penalty', blueTurn, penX, 0, { taker });
  setpieceHint.textContent = blueTurn ? '방향키 + D 슛' : '방향키 + D 다이빙';
  setpieceHint.style.display = 'block';
  penPostRec = 0;
  if (penState.decisive) { recCount = 0; recHead = 0; } // 이번 킥만 녹화 (이전 킥 장면이 섞이지 않게)
  const myGk = teamA.find(p => p.role === 'GK' && !p.sentOff);
  if (myGk) { myGk.diveUsed = false; myGk.userSave = false; myGk.autoSaved = false; myGk.dive = 0; myGk.jumpY = 0; myGk.z = 0; }
  if (!blueTurn && myGk) {
    activeIdx = teamA.indexOf(myGk);
    setpieceHint.textContent = '방향키 + D 다이빙';
  }
  if (penState.decisive) startPenCut();
  updateHud();
}

function penMiss() {
  if (!penState || penState.pendingResult !== undefined) return;
  penState.pendingResult = false;
  phase = 'goal_pause';
  goalPauseTimer = penWouldEnd(false) ? 1 : 55;
  showMsg('실축!', 1000);
}

/** 승부차기 슛이 멈추거나 막혔는데 판정이 없으면 실축 처리 (예전엔 여기서 게임이 멈췄음) */
function watchPenShot() {
  if (!inPens || !penState || !penState.waiting || phase !== 'play') return;
  penState.shotTimer++;
  const slow = Math.hypot(ball.vx, ball.vz) < 0.05 && ball.y <= BALL_R + 0.02;
  if (penState.shotTimer > 150 || (penState.shotTimer > 20 && slow) || ball.blockedShot) penMiss();
}

function resolvePenKick(scored) {
  if (!penState) return;
  if (penState.kickerBlue) {
    penState.blueTaken++;
    if (scored) penState.blueGoals++;
    penState.blueHist.push(!!scored);
    penState.blueLog.push({ num: penState.curTaker?.num, label: penState.curTaker?.label, ok: !!scored });
  } else {
    penState.redTaken++;
    if (scored) penState.redGoals++;
    penState.redHist.push(!!scored);
    penState.redLog.push({ num: penState.curTaker?.num, label: penState.curTaker?.label, ok: !!scored });
  }
  penState.lastKick = { blue: penState.kickerBlue, scored: !!scored, taker: penState.curTaker };
  penState.kickerBlue = !penState.kickerBlue;
  penState.waiting = false;
  penState.pendingResult = undefined;

  const b = penState.blueTaken, r = penState.redTaken;
  const bg = penState.blueGoals, rg = penState.redGoals;
  const winner = () => startPenCelebration(bg > rg);

  if (!penState.sudden) {
    if (bg > rg + (5 - r) || rg > bg + (5 - b)) return winner();
    if (b >= 5 && r >= 5) {
      if (bg !== rg) return winner();
      penState.sudden = true;
    }
  } else if (b === r && bg !== rg) {
    return winner();
  }
  setupPenKick();
}

// 이긴 팀 선수들이 센터서클에서 키퍼에게 달려가 안아주고 헹가래
let celeb = null;
function startPenCelebration(blueWon) {
  const team = blueWon ? teamA : teamB;
  const last = penState?.lastKick;
  const heroKicker = !!(last && last.scored && last.blue === blueWon && last.taker);
  const gk = heroKicker ? last.taker : (team.find(p => p.role === 'GK' && !p.sentOff) || team[0]);
  const mates = team.filter(p => p !== gk && !p.sentOff);
  let meet;
  if (heroKicker) {
    // 결승골 넣은 키커: 코너 쪽으로 달려가며 환호
    const gs = blueWon ? 1 : -1;
    meet = { x: gs * (FIELD_W / 2 - 9), z: (gk.z >= 0 ? 1 : -1) * 16 };
  } else {
    const gs = gk.isBlue ? -1 : 1; // 키퍼가 지키는 골문 쪽
    meet = { x: gs * (FIELD_W / 2 - 14), z: 0 };
  }
  penWinnerName = teamName(blueWon);
  celeb = { t: 0, blueWon, gk, mates, meet, from: { x: gk.x, z: gk.z }, heroKicker };
  // 동료들은 센터서클에서 출발해 약 2.5초 만에 도착하도록 속도를 맞춤
  for (const p of mates) p.celebSpd = Math.max(SPRINT * 0.62, Math.hypot(meet.x - p.x, meet.z - p.z) / 205);
  inPens = false;
  phase = 'pen_celebrate';
  setpiece = null;
  penAim.visible = false;
  setpieceHint.style.display = 'none';
  setpieceHint.textContent = heroKicker
    ? `🏆 ${teamName(blueWon)} ${gk.num}번 결승골! · Space 건너뛰기`
    : `🏆 ${teamName(blueWon)} 승부차기 승리! 키퍼 선방 · Space 건너뛰기`;
  showMsg(`${teamName(blueWon)} 승리!`, 2600);
  setCrowdStanding(true);
  crowdExcite = 1;
  setMatchHudVisible(false);
  $('cine')?.classList.add('show');
  ball.owner = null; ball.holdByGk = null;
  for (const p of allPlayers()) { p.dive = 0; p.jumpY = 0; p.cheer = 0; p.lying = 0; }
}
function updatePenCelebration() {
  const c = celeb;
  if (!c) return;
  c.t++;
  const gk = c.gk;
  // 키퍼: 골문에서 앞으로 달려 나옴
  const runK = clamp(c.t / 160, 0, 1);
  if (c.t <= 160) {
    const nx = lerp(c.from.x, c.meet.x, runK), nz = lerp(c.from.z, c.meet.z, runK);
    gk.vx = nx - gk.x; gk.vz = nz - gk.z; gk.x = nx; gk.z = nz;
    if (Math.hypot(gk.vx, gk.vz) > 0.01) [gk.faceX, gk.faceZ] = norm2(gk.vx, gk.vz);
  } else { gk.vx = gk.vz = 0; }
  gk.cheer = 1;
  // 동료들: 키퍼에게 달려가 둘러쌈
  c.mates.forEach((p, i) => {
    const a = (i / c.mates.length) * Math.PI * 2;
    const r = c.t < 255 ? 0.95 : 1.15;
    const tx = gk.x + Math.cos(a) * r, tz = gk.z + Math.sin(a) * r;
    const d = Math.hypot(tx - p.x, tz - p.z);
    const spd = Math.min(d, p.celebSpd || SPRINT * 1.5);
    const [dx, dz] = norm2(tx - p.x, tz - p.z);
    p.vx = dx * spd; p.vz = dz * spd;
    p.x += p.vx; p.z += p.vz;
    if (d > 0.3) { p.faceX = dx; p.faceZ = dz; } else [p.faceX, p.faceZ] = norm2(gk.x - p.x, gk.z - p.z);
    p.cheer = d < 3 ? 1 : 0.5;
  });
  // 헹가래: 3번 공중으로
  if (c.t > 258 && c.t <= 258 + 2 * 60) {
    const k = ((c.t - 258) % 60) / 60;
    gk.jumpY = Math.sin(Math.PI * k) * (c.heroKicker ? 0.7 : 2.4);
    gk.lying = c.heroKicker ? 0 : 1;
    for (const p of c.mates) if (dist2(p, gk) < 2) p.cheer = 1 + Math.sin(Math.PI * k);
  } else if (c.t > 258 + 2 * 60) { gk.jumpY = Math.max(0, gk.jumpY - 0.07); gk.lying = Math.max(0, gk.lying - 0.05); }
  // 진 팀: 제자리에 멈춰 고개 숙임
  for (const p of (c.blueWon ? teamB : teamA)) { p.vx = p.vz = 0; p.cheer = 0; }
  updateBallFree();
  if (c.t >= 385) finishPenCelebration();
}
function finishPenCelebration() {
  if (!celeb) return;
  for (const p of allPlayers()) { p.cheer = 0; p.lying = 0; p.jumpY = 0; }
  celeb = null;
  clearCelebrations();
  $('cine')?.classList.remove('show');
  setMatchHudVisible(true);
  setpieceHint.style.display = 'none';
  startPenReplay(); // 세리머니 다음에 결정적 장면 리플레이
}

function triggerHalftime() {
  phase = 'halftime';
  sndWhistle('half');
  setTimeout(() => comm.half(), 900);
  clockPaused = true;
  if (half === 1) matchMinute = 45;
  else if (half === 3) matchMinute = 105;
  overlayTitle.textContent = half === 3 ? '연장 전반 종료' : '전반 종료';
  overlaySub.textContent = half === 3 ? '연장 후반을 준비하세요' : '후반전을 준비하세요';
  spaceHint.textContent = 'SPACE 를 누르세요';
  spaceHint.style.display = 'block';
  statsBox.style.display = 'block';
  statsBox.innerHTML = buildStatsHtml('—');
  overlay.classList.add('show');
  updateHud();
}

function updateTimer() {
  if (clockPaused || phase !== 'play') return;
  matchMinute += FIXED_DT * (40 / 60); // 실제 1초 = 경기 40초 (90분 ≈ 2분 15초)
  if (half === 1 && matchMinute >= 45) {
    matchMinute = 45;
    triggerHalftime();
  } else if (half === 2 && matchMinute >= 90) {
    matchMinute = 90;
    if (score[0] === score[1] && isApc()) startPenaltyShootout(); // 토너먼트: 무승부면 바로 승부차기
    else endMatch();               // 리그: 연장 없이 종료 (무승부 가능)
  } else if (half === 3 && matchMinute >= 105) {
    matchMinute = 105;
    triggerHalftime();
  } else if (half === 4 && matchMinute >= 120) {
    matchMinute = 120;
    if (score[0] === score[1]) startPenaltyShootout();
    else endMatch();
  }
}

// ===== 카메라 =====
/** 진영: 후반(연장 후반 포함)엔 중계 카메라가 경기장 반대편으로 → 화면에서 두 팀 공격 방향이 바뀜 (방향키도 화면 기준으로) */
function camSideNow() { return (half === 2 || half === 4) && !inPens && !fkMode ? -1 : 1; }
/** 카메라가 긴 쪽 관중석 안쪽/뒤로 가면 그쪽 관중석을 투명하게 → 반대로 멀어지면 다시 보이게 */
function updateStandFade(frameDt) {
  const cz = camera.position.z, lim = FIELD_H / 2 + 11;
  for (const [g, zs] of [['far', -1], ['near', 1]]) {
    const G = standGroups[g];
    const want = zs * cz > lim ? 0 : 1;
    const k = 1 - Math.pow(1 - 0.12, frameDt * 60);
    let op = G.userData.op + (want - G.userData.op) * k;
    if (Math.abs(op - want) < 0.01) op = want;
    if (op === G.userData.op && G.userData.done) continue;
    G.userData.op = op;
    G.userData.done = op === want;
    G.visible = op > 0.01;
    G.traverse(o => {
      if (!o.material) return;
      const m = o.material, tr = op < 0.999;
      if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
      m.opacity = op;
      m.depthWrite = !tr;
    });
  }
}
const _look = new THREE.Vector3();
const _camTarget = new THREE.Vector3();
const camLook = new THREE.Vector3(0, 0.5, 0);
/** 카메라가 관중석 계단/벽 속으로 들어가지 않게 높이를 올림 */
function keepCamInBowl(v) {
  const overZ = Math.abs(v.z) - (FIELD_H / 2 + 6.5);
  const overX = Math.abs(v.x) - (FIELD_W / 2 + 7.5);
  const over = Math.max(overZ, overX);
  if (over > 0) v.y = Math.max(v.y, over > 11 ? 14 : 2 + over * 0.8);
  return v;
}
let renderFrameNo = 0;
function updateCamera(frameDt) {
  renderFrameNo++;
  const k = a => 1 - Math.pow(1 - a, frameDt * 60); // 프레임레이트 무관 보간
  camZoom = lerp(camZoom, pshot ? 1 : 0, k(pshot ? 0.06 : 0.1));
  const fov = 50 - camZoom * 5; // 아주 살짝 줌인
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  if (phase === 'sp_intro' && spIntro) {
    const S = spIntro;
    if (S.t <= 55) {
      // 심판 클로즈업: 휘슬
      const fy = referee.mesh.rotation.y, fx = Math.sin(fy), fz = Math.cos(fy);
      _camTarget.set(referee.x + fx * 3.4 + fz * 1.2, 1.75, referee.z + fz * 3.4 - fx * 1.2);
      _look.set(referee.x, 1.6, referee.z);
    } else {
      // 공 세팅: 키커를 옆에서
      const p = S.taker;
      const [dx, dz] = norm2(S.spot.x - p.x || 1, S.spot.z - p.z || 0.01);
      _camTarget.set(S.spot.x - dz * 5.2 - dx * 2, 2.1, S.spot.z + dx * 5.2 - dz * 2);
      _look.set(lerp(p.x, S.spot.x, 0.5), 0.9, lerp(p.z, S.spot.z, 0.5));
    }
    if (S.t === 1 || S.t === 56) { camera.position.copy(keepCamInBowl(_camTarget)); camLook.copy(_look); }
    camera.position.lerp(keepCamInBowl(_camTarget), k(0.08));
    camLook.lerp(_look, k(0.12));
    camera.lookAt(camLook);
    return;
  }
  if (phase === 'prematch' && pre) {
    const st = pre.stage;
    if (st === 'lineup') { const a = performance.now() / 9000; _camTarget.set(Math.sin(a) * 62, 30, Math.cos(a) * 48); _look.set(0, 2, 0); }
    else if (st === 'walk') {
      // 지미집: 터널 위 높은 곳에서 내려다보다가, 선수들을 따라 천천히 내려오며 정면으로 돌아 들어감
      let lz = -FIELD_H / 2 - 6; for (const p of teamA) lz = Math.max(lz, p.z);
      const u = Math.min(1, pre.t / 560), e = u * u * (3 - 2 * u);
      _camTarget.set(lerp(-13, 7, e), lerp(15, 3.3, e), lerp(-24, LINE_Z + 11, e));
      _look.set(lerp(0, 1, e), 1.3, Math.min(LINE_Z, lz - 2));
    }
    else if (st === 'shake') {
      // 레일 카메라: 악수하는 줄을 따라 옆으로 천천히 이동
      const u = Math.min(1, pre.t / 420);
      const x = lerp(12, -17, u);
      _camTarget.set(x, 2.5 + Math.sin(u * Math.PI) * 0.6, LINE_Z + 7.2);
      _look.set(x - 2.5, 1.35, LINE_Z);
    }
    else {
      // 드론: 선수들이 흩어지는 동안 천천히 위로 솟으며 경기장을 한 바퀴
      const a = 0.4 + pre.t / 520;
      _camTarget.set(Math.sin(a) * 26, Math.min(26, 8 + pre.t * 0.05), 14 + Math.cos(a) * 22);
      _look.set(0, 0, 0);
    }
    if (pre.t === 1 && st === 'lineup') { camera.position.copy(_camTarget); camLook.copy(_look); }
    camera.position.lerp(keepCamInBowl(_camTarget), k(st === 'lineup' ? 0.02 : 0.03));
    camLook.lerp(_look, k(0.05));
    camera.lookAt(camLook);
    return;
  }
  if (phase === 'replay' && replay) {
    let side = replayGoalSide;
    const gx = side * (FIELD_W / 2);
    const ang = replay.passes[replay.pass].angle;
    const [dx, dz] = norm2(gx - ball.x, -ball.z);
    if (ang === 'tv') { const cs = camSideNow(); _camTarget.set(ball.x - 2 * cs, 10, ball.z + 17 * cs); _look.set(ball.x, 0.5, ball.z); }
    else if (ang === 'reverse') { _camTarget.set(ball.x + side * 3, 9, Math.max(ball.z - 15, -FIELD_H / 2 - 4)); _look.set(ball.x, 0.5, ball.z); }
    else if (ang === 'high') { _camTarget.set(ball.x - side * 6, 26, ball.z + 6); _look.set(ball.x, 0, ball.z); }
    else if (ang === 'shooter') { _camTarget.set(ball.x - dx * 8 - dz * 2, 3.4, ball.z - dz * 8 + dx * 2); _look.set(ball.x + dx * 6, 1, ball.z + dz * 6); }
    else if (ang === 'goal') { _camTarget.set(gx + side * 6, 5.2, ball.z >= 0 ? -3.5 : 3.5); _look.set(ball.x, ball.y * 0.6, ball.z); }
    else if (ang === 'gkview') {
      // 골문 안 키퍼 머리 뒤에서 키커를 바라봄 (키퍼에 가리지 않게 살짝 위·옆)
      // 공이 향한 쪽 골문 안쪽 모서리, 키퍼 허리 높이(1m)에서 키커를 바라봄
      const cz = (replay.cornerZ || 1) * (GOAL_W / 2 - 0.25);
      _camTarget.set(gx + side * (GOAL_D - 0.25), 1.35, cz); // 키퍼 가슴 높이
      const lk = side * (FIELD_W / 2 - PEN_SPOT);
      _look.set(lerp(lk, ball.x, 0.35), 0.85, ball.z * 0.35);
    }
    else if (ang === 'side45') {
      // 골대 옆 대각선 앞쪽, 조금 높은 곳: 키커·공·키퍼·골문이 한 화면에 겹치지 않고 보임
      const sz = (ball.z >= 0 ? 1 : -1);
      _camTarget.set(gx - side * 7.5, 3.4, sz * 10);
      _look.set(lerp(ball.x, gx, 0.35), 1.0, ball.z * 0.5);
    }
    else { _camTarget.set(gx + side * (GOAL_D - 0.4), 1.7, 0); _look.set(ball.x, ball.y, ball.z); }
    keepCamInBowl(_camTarget);
    if (snapReplayCam) { camera.position.copy(_camTarget); camLook.copy(_look); snapReplayCam = false; }
    camera.position.lerp(_camTarget, k(0.18));
    camLook.lerp(_look, k(0.25));
    camera.lookAt(camLook);
    return;
  }
  if (phase === 'goal_pause' && replayMode === 'live') {
    // 골 직후: 득점한 선수 쪽으로 다가가는 중계 카메라
    const sc = lastToucher && !lastToucher.sentOff ? lastToucher : ball;
    _camTarget.set(sc.x - replayGoalSide * 6, 4.5, sc.z + 9 * camSideNow());
    _look.set(sc.x, 1.2, sc.z);
    camera.position.lerp(keepCamInBowl(_camTarget), k(0.06));
    camLook.lerp(_look, k(0.1));
    camera.lookAt(camLook);
    return;
  }
  if (phase === 'pen_celebrate' && celeb) {
    const g = celeb.gk;
    let cx = 0, cz = 0;
    for (const m of celeb.mates) { cx += m.x; cz += m.z; }
    cx /= Math.max(1, celeb.mates.length); cz /= Math.max(1, celeb.mates.length);
    const [ax, az] = norm2(g.x - cx, g.z - cz);   // 동료들 → 주인공 방향
    const far = Math.hypot(g.x - cx, g.z - cz);
    const mx = lerp(g.x, cx, 0.5), mz = lerp(g.z, cz, 0.5);
    if (celeb.t < 175) {
      // ① 경기장 옆 높은 곳에서 넓게: 주인공과 달려오는 동료들이 한 화면에
      const sideZ = g.z >= 0 ? 1 : -1;
      _camTarget.set(mx - ax * 5, 20.5, mz + sideZ * 22.5);
      _look.set(mx, 0, mz);
    } else if (celeb.t < 250) {
      // ② 주인공 정면 클로즈업 (가슴 높이) — 뒤로 동료들이 달려 들어옴
      _camTarget.set(g.x - ax * 3.2 + az * 0.8, 1.6, g.z - az * 3.2 - ax * 0.8);
      _look.set(g.x, 1.35 + (g.jumpY || 0), g.z);
    } else {
      // ③ 껴안는 무리 가까이, 천천히 돌며
      // 지금 카메라가 있는 방향에서 그대로 이어 돌기 시작 (무리를 가로질러 들어가지 않게)
      if (celeb.orbitA0 === undefined) celeb.orbitA0 = Math.atan2(camera.position.z - g.z, camera.position.x - g.x) - 250 / 130;
      const a = celeb.orbitA0 + celeb.t / 130;
      // 거리·높이 고정: 헹가래 때 카메라가 들어갔다 나오지 않음
      _camTarget.set(g.x + Math.cos(a) * 4.3, 2.0, g.z + Math.sin(a) * 4.3);
      _look.set(g.x, 1.35 + (g.jumpY || 0) * 0.25, g.z);
    }
    if (celeb.t === 1) { camera.position.copy(keepCamInBowl(_camTarget)); camLook.copy(_look); }
    // 컷 전환은 끊지 않고 천천히 미끄러지듯 이동 (전환 직후 약 1.2초 동안 느리게)
    const sinceCut = celeb.t < 175 ? celeb.t : celeb.t < 250 ? celeb.t - 175 : celeb.t - 250;
    const glide = celeb.t > 1 && sinceCut < 70;
    camera.position.lerp(keepCamInBowl(_camTarget), k(glide ? 0.035 : 0.07));
    if (celeb.t >= 175) {
      // 클로즈업 이후엔 주인공에게 일정 거리 이상 다가가지 않음
      const dx = camera.position.x - g.x, dz = camera.position.z - g.z, d = Math.hypot(dx, dz);
      const minD = celeb.t >= 250 ? 3.9 : 3.0;
      if (d < minD && d > 0.01) { camera.position.x = g.x + dx / d * minD; camera.position.z = g.z + dz / d * minD; }
    }
    camLook.lerp(_look, k(glide ? 0.06 : 0.1));
    camera.lookAt(camLook);
    return;
  }
  // 승부차기: 차고 난 뒤 · 골이 들어가도 같은 화면 유지
  if (inPens && penCam && (phase === 'play' || phase === 'goal_pause')) {
    const gs = penCam.gs;
    _camTarget.set(penCam.x - gs * 11, 3.5, 0); // 골문 정중앙 뒤에서 똑바로
    _look.set(gs * FIELD_W / 2 - gs * 4, 0.9, 0);
    camera.position.lerp(keepCamInBowl(_camTarget), k(0.12));
    camLook.lerp(_look, k(0.15));
    camera.lookAt(camLook);
    return;
  }
  if (phase === 'goal_pause' && replayMode) {
    const side = replayGoalSide;
    const gx = side * (FIELD_W / 2);
    if (replayMode === 'fp') {
      _camTarget.set(ball.x - side * 5, ball.y + 1.2, ball.z + 1);
      _look.set(gx + side * 2, 1.2, 0);
    } else if (replayMode === 'side') {
      _camTarget.set(gx - side * 8, 4, ball.z + 14);
      _look.set(ball.x, ball.y, ball.z);
    } else if (replayMode === 'gk') {
      _camTarget.set(gx + side * (GOAL_D - 0.4), 1.6, 0.5);
      _look.set(ball.x - side * 6, 1, ball.z);
    } else {
      const kicker = lastToucher;
      _camTarget.set((kicker ? kicker.x : ball.x - side * 12) - side * 2.5, 1.6, (kicker ? kicker.z : 0) + 2);
      _look.set(gx, 1.2, 0);
    }
    camera.position.lerp(keepCamInBowl(_camTarget), k(0.1));
    camLook.lerp(_look, k(0.15));
    camera.lookAt(camLook);
    return;
  }
  if (phase === 'setpiece' && setpiece?.cut && setpiece.taker) {
    const gs = setpiece.teamBlue ? 1 : -1;
    const tk = setpiece.taker;
    _camTarget.set(setpiece.x + gs * 2.5, 1.9, setpiece.z - gs * 5.2);
    _look.set(tk.x, 0.9, tk.z);
    camera.position.lerp(keepCamInBowl(_camTarget), k(0.08));
    camLook.lerp(_look, k(0.12));
    camera.lookAt(camLook);
    return;
  }
  if (fkCam && (phase === 'play' || phase === 'goal_pause' || phase === 'fk_wait')) {
    fkCam.t++;
    // 리그: 공이 누구·무엇에 맞거나(벽·키퍼·골대) 방향이 꺾이면, 또는 잡히면 바로 중계 카메라로
    if (!fkMode && phase === 'play') {
      const h = Math.hypot(ball.vx, ball.vz);
      if (!fkCam.dir && h > 0.05) fkCam.dir = [ball.vx / h, ball.vz / h, h];
      const turned = fkCam.dir && h > 0.03 && (ball.vx * fkCam.dir[0] + ball.vz * fkCam.dir[1]) / h < 0.8;
      const slowed = fkCam.dir && h < fkCam.dir[2] * 0.45 && ball.y > BALL_R + 0.05; // 공중에서 갑자기 느려짐 = 어딘가 맞음
      if (fkCam.dir) fkCam.dir[2] = Math.max(h, fkCam.dir[2] * 0.97);
      const touched = lastToucher && fkCam.kicker && lastToucher !== fkCam.kicker;
      if (fkCam.t > 210 || ball.owner || ball.holdByGk || ball.blockedShot || touched || turned || slowed) fkCam = null;
    }
    if (!fkCam) { /* 아래 기본 카메라로 */ }
    else if (fkCam) {
      camera.position.lerp(keepCamInBowl(fkCam.pos), k(0.2));
      camLook.lerp(fkCam.look, k(0.2));
      camera.lookAt(camLook);
      return;
    }
  }
  if (phase === 'setpiece' && setpiece && (setpiece.type === 'corner' || setpiece.type === 'freekick' || setpiece.type === 'penalty') && setpiece.taker) {
    const goalSign = setpiece.teamBlue ? 1 : -1;
    const goalX = goalSign * (FIELD_W / 2);
    const [bx, bz] = norm2(ball.x - goalX, ball.z);
    const pen = setpiece.type === 'penalty';
    if (pen) {
      const bx = inPens && penCam ? penCam.x : ball.x, bz = inPens && penCam ? penCam.z : ball.z;
      _camTarget.set(bx - goalSign * 11, 3.5, 0); // 골문 정중앙 뒤에서 똑바로
      _look.set(goalX - goalSign * 4, 0.9, 0);
      camera.position.lerp(keepCamInBowl(_camTarget), k(0.12));
      camLook.lerp(_look, k(0.15));
      camera.lookAt(camLook);
      return;
    }
    const back = pen ? 7 : setpiece.type === 'corner' ? 11.5 : 13.5;
    const camH = pen ? 2.6 : setpiece.type === 'corner' ? 3.6 : 3.9;
    _camTarget.set(ball.x + bx * back, camH, ball.z + bz * back);
    _look.set(lerp(ball.x, goalX, pen ? 0.9 : 0.62), 1.3, lerp(ball.z, 0, pen ? 1 : 0.45));
    camera.position.lerp(keepCamInBowl(_camTarget), k(0.1));
    camLook.lerp(_look, k(0.12));
    camera.lookAt(camLook);
    return;
  }
  if (inMenus()) {
    const a = performance.now() / 14000;
    _camTarget.set(-16 + Math.sin(a) * 4, 10.5, 15 + Math.cos(a) * 3);
    _look.set(-4.5, 0.4, 0.5);
    camera.position.lerp(_camTarget, k(0.03));
    camLook.lerp(_look, k(0.05));
    camera.lookAt(camLook);
    return;
  }
  // 방송 카메라: 공을 따라가되 공격 방향으로 살짝 앞을 비춤
  //  · 따라갈 지점을 부드럽게(스프링) 움직이고 카메라는 그 지점에서 항상 같은 각도로 → 패스할 때 화면이 휙휙 돌지 않음
  const carrier = ball.owner || ball.holdByGk;
  const dt = Math.min(0.05, frameDt);
  const fresh = camF.f !== renderFrameNo - 1; // 다른 카메라에서 막 넘어옴
  camF.f = renderFrameNo;
  const wantLead = carrier ? (carrier.isBlue ? 4 : -4) : clamp(ball.vx * 6, -4, 4);
  const tx = clamp(ball.x, -FIELD_W / 2 + 6, FIELD_W / 2 - 6);
  const tz = clamp(ball.z * 0.85, -FIELD_H / 2 + 1, FIELD_H / 2 - 1); // 옆(위아래) 이동은 조금 덜 따라감
  if (fresh && !camF.init) { camF.x = tx; camF.z = tz; camF.lead = wantLead; camF.vx = camF.vz = camF.vl = 0; camF.init = true; }
  camF.lead = sdamp(camF.lead, wantLead, camF, 'vl', 1.2, dt);
  camF.x = sdamp(camF.x, tx, camF, 'vx', 0.5, dt);
  camF.z = sdamp(camF.z, tz, camF, 'vz', 0.75, dt);
  const fx = clamp(camF.x + camF.lead, -FIELD_W / 2 + 6, FIELD_W / 2 - 6), fz = camF.z;
  const cs = camSideNow();
  _camTarget.set(fx - 2 * cs, 22, fz + 26 * cs);
  _look.set(fx, 0.5, fz);
  // 위치와 바라보는 점을 같은 비율로 움직여 각도가 흔들리지 않게 (다른 화면에서 넘어올 땐 천천히)
  const r = fresh ? 0.05 : Math.max(0.05, camF.blend = Math.min(0.35, (camF.blend || 0.05) + 0.004));
  if (fresh) camF.blend = 0.05;
  camera.position.lerp(keepCamInBowl(_camTarget), k(r));
  camLook.lerp(_look, k(r));
  camera.lookAt(camLook);
}
/** 스프링처럼 부드럽게 목표를 따라감 (속도까지 이어져서 갑자기 꺾이지 않음) */
function sdamp(cur, target, o, key, T, dt) {
  const w = 2 / T, x = w * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const ch = cur - target, tmp = ((o[key] || 0) + w * ch) * dt;
  o[key] = ((o[key] || 0) - w * tmp) * e;
  return target + (ch + tmp) * e;
}
const camF = { x: 0, z: 0, lead: 0, vx: 0, vz: 0, vl: 0, f: -9, init: false, blend: 0.05 };

// ===== 렌더 동기화 =====
function previewSetpieceTrajectory(from) {
  const action = charge.action || (setpiece?.type === 'freekick' ? 'shoot' : 'lob');
  const power = charge.action ? charge.power : 0.6;
  const kp = setpieceKickParams(from, action, power, true);
  const [dx, dz] = norm2(kp.tx - ball.x, kp.tz - ball.z);
  const st = makeLaunch(ball.x, ball.z, BALL_R + kp.lift, dx, dz, kp.spd, kp.vy, kp.spin);
  const arr = trajGeo.attributes.position.array;
  let n = 0;
  let landX = st.x, landZ = st.z;
  let wasAir = false;
  for (; n < TRAJ_N; n++) {
    arr[n * 3] = st.x;
    arr[n * 3 + 1] = Math.max(0.08, st.y);
    arr[n * 3 + 2] = st.z;
    stepBallPhysics(st);
    const air = st.y > BALL_R + 0.02;
    if (wasAir && !air) { landX = st.x; landZ = st.z; n++; break; }
    if (air) wasAir = true;
    landX = st.x; landZ = st.z;
    if (!wasAir && n > 50) break;              // 땅볼은 50프레임만
    if (Math.abs(st.x) > FIELD_W / 2 + 3 || Math.abs(st.z) > FIELD_H / 2 + 3) { n++; break; }
  }
  trajGeo.setDrawRange(0, n);
  trajGeo.attributes.position.needsUpdate = true;
  trajGeo.computeBoundingSphere();
  kickGuide.computeLineDistances();
  kickAimRing.position.set(landX, 0.06, landZ);
  setKickCone(ball.x, ball.z, dx, dz, 5, 0.18);
}

let showAllTags = false;
// 화면 보간: 시뮬레이션은 1/60초 단위로 띄엄띄엄 진행(게임 속도 80%·프리킥 68% 등)되므로
// 그리는 프레임에서는 직전 스텝과 현재 스텝 사이를 부드럽게 이어 덜덜거림을 없앰
let rAlpha = 1;
function snapPrev() {
  for (const p of allPlayers()) { p.px = p.x; p.pz = p.z; }
  ball.px = ball.x; ball.py = ball.y; ball.pz = ball.z;
}
function ix(o, k, pk) { // 크게 순간이동한 경우엔 보간하지 않음
  const a = o[pk];
  if (a === undefined || Math.abs(o[k] - a) > 3) return o[k];
  return a + (o[k] - a) * rAlpha;
}
function syncMeshes() {
  updateNets();
  const gauge = charge.power;
  const active = getActive();
  for (const p of allPlayers()) {
    if (p.sentOff) { p.mesh.visible = false; continue; }
    p.mesh.position.set(ix(p, 'x', 'px'), 0, ix(p, 'z', 'pz'));
    if (Math.hypot(p.faceX, p.faceZ) > 0.1) p.mesh.rotation.y = Math.atan2(p.faceX, p.faceZ);
    p.mesh.userData.ring.visible = p === active && phase !== 'prematch' && phase !== 'sp_intro';
    // 이름표: 기본은 내가 조작하는 선수만 (N키로 전체 표시 토글), 리플레이·세리머니 때는 모두 숨김
    const spr = p.mesh.userData.sprite;
    const cine = phase === 'replay' || phase === 'pen_celebrate' || phase === 'ended' || phase === 'prematch' || phase === 'sp_intro';
    const fkAiming = (phase === 'setpiece' && setpiece?.type === 'freekick') || !!fkRun;
    spr.visible = !cine && !(fkAiming && p === setpiece?.taker) && (p === active || showAllTags);
    if (spr.visible) {
      const sc = p === active ? 1 : 0.72;
      spr.scale.set(1.45 * sc, 0.9 * sc, 1);
      spr.material.opacity = p === active ? 1 : 0.6;
    }
    updatePlayerGauge(p, p === active ? gauge : 0, p === active && !!charge.action);
    animatePlayer(p);
  }
  referee.mesh.position.set(referee.x, 0, referee.z);
  if (Math.hypot(referee.vx, referee.vz) > 0.01) referee.mesh.rotation.y = Math.atan2(referee.vx, referee.vz);
  animatePlayer(referee);

  // 공: 위치 + 굴러가는 회전
  const bxr = ix(ball, 'x', 'px'), byr = ix(ball, 'y', 'py'), bzr = ix(ball, 'z', 'pz');
  const prev = ballMesh.userData.prev || { x: bxr, z: bzr };
  const mx = bxr - prev.x, mz = bzr - prev.z;
  const moved = Math.hypot(mx, mz);
  if (moved > 1e-4 && moved < 3) {
    _axis.set(mz, 0, -mx).normalize();
    _q.setFromAxisAngle(_axis, moved / BALL_R);
    ballMesh.quaternion.premultiply(_q);
  }
  ballMesh.userData.prev = { x: bxr, z: bzr };
  ballMesh.position.set(bxr, byr, bzr);
  ballShadow.position.set(bxr, 0.03, bzr);
  const h = Math.max(0, byr - BALL_R);
  ballShadow.scale.setScalar(1 + h * 0.18);
  ballShadow.material.opacity = clamp(0.38 - h * 0.035, 0.1, 0.38);

  const [inX, inZ] = getInputDir();
  const penUser = phase === 'setpiece' && setpiece?.type === 'penalty' && setpiece.teamBlue && setpiece.taker === active && !setpiece.cut;
  penAim.visible = !!penUser;
  if (penUser) {
    const gs = 1;
    const gx = gs * FIELD_W / 2;
    penAim.position.set(gx - 0.05, Math.min(Math.max(0.3, penHeight(penRun ? penRun.power : charge.action ? charge.power : 0)), GOAL_H + 1.2), penRun ? penRun.aimZ : penAimZ); // 아래에서 시작해 게이지만큼 올라감, 차는 동안엔 정한 높이에 고정
    penAim.rotation.set(0, -Math.PI / 2, 0);
  }
  const aimedSet = phase === 'setpiece' && (setpiece?.type === 'corner' || setpiece?.type === 'freekick') && setpiece.taker === active && setpiece.teamBlue;
  const showArrow = active && !active.sentOff && (inX || inZ || aimedSet || penUser) && phase !== 'kickoff';
  dirArrow.visible = !!showArrow;
  if (showArrow) {
    let ax = aimedSet ? setAimX : inX;
    let az = aimedSet ? setAimZ : inZ;
    let px = active.x, pz = active.z;
    if (penUser) {
      // 페널티: 공 밑에서 조준점(골문) 쪽을 가리킴 — ←→ 누르는 방향과 같이 움직임
      [ax, az] = norm2(FIELD_W / 2 - ball.x, penAimZ - ball.z);
      px = ball.x; pz = ball.z;
    }
    dirArrow.position.set(px, 0, pz);
    dirArrow.rotation.y = Math.atan2(ax, az);
  }

  kickGuide.visible = !!aimedSet;
  kickAimRing.visible = !!aimedSet;
  kickCone.visible = !!aimedSet;
  if (aimedSet) previewSetpieceTrajectory(setpiece.taker);
  syncSetpieceUi();
}

const debugLines = [];
const mmCanvas = $('minimap');
const mmCtx = mmCanvas && mmCanvas.getContext ? mmCanvas.getContext('2d') : null;
function drawMinimap() {
  if (!mmCtx || inMenus()) return;
  const W = mmCanvas.width, H = mmCanvas.height;
  const pad = 6;
  const sx = (W - pad * 2) / FIELD_W, sz = (H - pad * 2) / FIELD_H;
  const cs = camSideNow(); // 후반엔 화면과 같게 뒤집어서
  const X = x => pad + (cs * x + FIELD_W / 2) * sx;
  const Z = z => pad + (cs * z + FIELD_H / 2) * sz;
  const X0 = x => pad + (x + FIELD_W / 2) * sx, Z0 = z => pad + (z + FIELD_H / 2) * sz; // 좌우·위아래 대칭인 선
  const g = mmCtx;
  g.clearRect(0, 0, W, H);
  // 잔디 (반 투명 어두운 초록 + 줄무늬)
  g.fillStyle = 'rgba(18,64,30,0.38)';
  g.fillRect(X0(-FIELD_W / 2), Z0(-FIELD_H / 2), FIELD_W * sx, FIELD_H * sz);
  for (let i = 0; i < 10; i += 2) {
    g.fillStyle = 'rgba(255,255,255,0.03)';
    g.fillRect(X0(-FIELD_W / 2 + i * FIELD_W / 10), Z0(-FIELD_H / 2), FIELD_W / 10 * sx, FIELD_H * sz);
  }
  // 라인 (연한 크림색)
  g.strokeStyle = 'rgba(240,236,190,0.6)';
  g.lineWidth = 3;
  g.strokeRect(X0(-FIELD_W / 2), Z0(-FIELD_H / 2), FIELD_W * sx, FIELD_H * sz);
  g.beginPath(); g.moveTo(X0(0), Z0(-FIELD_H / 2)); g.lineTo(X0(0), Z0(FIELD_H / 2)); g.stroke();
  g.beginPath(); g.ellipse(X(0), Z(0), CIRCLE_R * sx, CIRCLE_R * sz, 0, 0, Math.PI * 2); g.stroke();
  const arcA = Math.acos((PEN_W - PEN_SPOT) / CIRCLE_R);
  for (const sd of [-1, 1]) {
    const gx = sd * FIELD_W / 2;
    g.strokeRect(Math.min(X(gx), X(gx - sd * PEN_W)), Z0(-PEN_H / 2), PEN_W * sx, PEN_H * sz);
    g.strokeRect(Math.min(X(gx), X(gx - sd * SIX_W)), Z0(-SIX_H / 2), SIX_W * sx, SIX_H * sz);
    const spot = gx - sd * PEN_SPOT;
    g.fillStyle = 'rgba(240,236,190,0.9)';
    g.beginPath(); g.arc(X(spot), Z(0), 2.5, 0, Math.PI * 2); g.fill();
    g.beginPath();
    if (sd * cs < 0) g.ellipse(X(spot), Z(0), CIRCLE_R * sx, CIRCLE_R * sz, 0, -arcA, arcA);
    else g.ellipse(X(spot), Z(0), CIRCLE_R * sx, CIRCLE_R * sz, 0, Math.PI - arcA, Math.PI + arcA);
    g.stroke();
  }
  g.fillStyle = 'rgba(240,236,190,0.9)';
  g.beginPath(); g.arc(X(0), Z(0), 2.5, 0, Math.PI * 2); g.fill();
  // 선수: 흰 테두리 원 (우리 팀은 팀 색, 상대는 어두운 색), 조작 중인 선수는 노란 +
  const home = colorById(userSetup.colorId || 'blue').css;
  const active = getActive();
  for (const p of allPlayers()) {
    if (p.sentOff || p === active) continue;
    g.beginPath();
    g.arc(X(p.x), Z(p.z), 7, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
    g.beginPath();
    g.arc(X(p.x), Z(p.z), 3.6, 0, Math.PI * 2);
    g.fillStyle = p.isBlue ? home : '#1f2937';
    g.fill();
  }
  // 공
  g.beginPath();
  g.arc(X(ball.x), Z(ball.z), 3.4, 0, Math.PI * 2);
  g.fillStyle = '#fff59d';
  g.fill();
  if (active && !active.sentOff) {
    const ax = X(active.x), az = Z(active.z);
    g.strokeStyle = '#1f2937';
    g.lineWidth = 7;
    g.beginPath(); g.moveTo(ax - 8, az); g.lineTo(ax + 8, az); g.moveTo(ax, az - 8); g.lineTo(ax, az + 8); g.stroke();
    g.strokeStyle = '#ffd23f';
    g.lineWidth = 4;
    g.beginPath(); g.moveTo(ax - 8, az); g.lineTo(ax + 8, az); g.moveTo(ax, az - 8); g.lineTo(ax, az + 8); g.stroke();
  }
}

function syncAiDebug() {
  const box = $('ai-debug');
  if (!aiDebug) {
    for (const l of debugLines) l.visible = false;
    if (box) box.style.display = 'none';
    return;
  }
  while (debugLines.length < 22) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]),
      new THREE.LineBasicMaterial({ color: 0xfde047 })
    );
    line.visible = false;
    scene.add(line);
    debugLines.push(line);
  }
  const players = allPlayers();
  players.forEach((p, i) => {
    const line = debugLines[i];
    const show = !p.sentOff && p.role !== 'GK' && p.targetPosition;
    line.visible = !!show;
    if (!show) return;
    line.geometry.setFromPoints([
      new THREE.Vector3(p.x, 0.25, p.z),
      new THREE.Vector3(p.targetPosition.x, 0.25, p.targetPosition.z),
    ]);
    const pressing = teamAi.bluePress === p || teamAi.redPress === p;
    line.material.color.setHex(pressing ? 0xfb7185 : p.currentAction === 'MAKE_RUN' ? 0x22d3ee : 0xfde047);
  });
  if (!box) return;
  box.style.display = 'block';
  const poss = teamAi.poss === 'blue' ? 'BLUE 공격' : teamAi.poss === 'red' ? 'RED 공격' : '루즈볼';
  const rows = players.filter(p => !p.sentOff && p.role !== 'GK').map(p => {
    const press = (teamAi.bluePress === p || teamAi.redPress === p) ? ' PRESS' : '';
    const sc = Math.round(p.actionScores?.[p.currentAction] || 0);
    return `${p.isBlue ? 'B' : 'R'}${p.num} ${p.position} ${p.currentAction}${press} (${sc})`;
  });
  box.textContent = `${activeFormation} vs ${userSetup.cpuFormation} · ${poss}\n` + rows.join('\n');
}

// ===== 메인 업데이트 (항상 1/60초 단위) =====
function update() {
  simTime += FIXED_DT * 1000;
  simFrame++;
  if (devFlags.on && devTick) devTick();
  if (ball.lockT > 0) ball.lockT--;
  updateTimer();
  if (crowdExcite > 0) crowdExcite = Math.max(0, crowdExcite - 0.004);
  if (foulCd > 0) foulCd--;
  if (headingCd > 0) headingCd--;
  updateLandMarker();
  if (phase === 'replay') { updateReplay(); return; }
  if (phase === 'prematch') { updatePreMatch(); return; }
  if (phase === 'sp_intro') { updateSpIntro(); return; }
  if (phase === 'pen_celebrate') {
    const recTail = celeb && celeb.t < 75;
    updatePenCelebration();
    if (recTail) recordPenTail();
    updateReferee();
    return;
  }
  if (phase === 'fk_wait') {
    updateBallFree();
    if (--fkState.wait <= 0) nextFreeKick();
    return;
  }
  computeBallPath();
  if (phase === 'play' || phase === 'setpiece') updateTeamAi();

  if (phase === 'goal_pause') {
    goalPauseTimer--;
    updateBallFree();
    if (goalRecLeft > 0 && !inPens) { recordFrame(); goalRecLeft--; }
    if (goalPauseTimer <= 0) {
      if (inPens && penState) {
        clearCelebrations();
        replayBadge.classList.remove('show');
        replayMode = null;
        if (penState.pendingResult !== undefined) resolvePenKick(!!penState.pendingResult);
        else setupPenKick();
      } else {
        startReplay();
      }
    }
    if (phase !== 'goal_pause') return;
  }

  if (kickCooldown > 0) kickCooldown--;
  if (ball.throwTtl > 0 && --ball.throwTtl <= 0) ball.throwTo = null;
  if (switchLock > 0) switchLock--;

  updatePowerShot();
  updateQueuedKick();
  if (charge.action && (phase === 'play' || phase === 'setpiece')) {
    charge.power = Math.min(1, charge.power + realK() / TUNE.gauge.charge);
    const held = actionHeld(charge.action);
    if (!held) {
      releaseAction(charge.action, charge.power);
      charge.action = null;
      charge.power = 0;
    }
  }

  if (phase === 'play' || phase === 'setpiece' || phase === 'goal_pause' || phase === 'kickoff') {
    const active = getActive();
    for (const p of teamA) updatePlayer(p, p === active, FIXED_DT);
    for (const p of teamB) updatePlayer(p, false, FIXED_DT);
    if (phase !== 'goal_pause') separatePlayers();
    if (phase === 'play' || phase === 'setpiece' || phase === 'kickoff') updateDribble();
    if (phase === 'play') {
      updateBallFree();
      checkOutOfPlay();
      if (!fkMode) checkFouls();
      watchPenShot();
      watchFreeKick();
      if (ball.owner?.isBlue || ball.holdByGk?.isBlue) stats.possession[0]++;
      else if (ball.owner || ball.holdByGk) stats.possession[1]++;
    }
    if (phase === 'play' || phase === 'setpiece') {
      releaseOpponentGk();
      releaseUserGk();
    }
    enforceClearance();
    enforceSetpieceShape();
    updatePenCut();
    updatePenRun();
    updateFkRun();
    keepersFaceForward();
  }
  updateReferee();
  if (!inPens && (phase === 'play' || (phase === 'setpiece' && (fkRun || penRun)))) recordFrame();
  if (inPens && penState?.decisive && !setpiece?.cut && (phase === 'play' || (phase === 'setpiece' && penRun) || (phase === 'goal_pause' && penPostRec++ < 50))) recordFrame();
  if (saveReplayPending > 0 && --saveReplayPending === 0) {
    if (phase === 'play') startSaveReplay();
  }
}

let lastFrame = performance.now();
let accum = 0;
function loop(now) {
  let frameDt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (!(frameDt > 0)) frameDt = 0;
  frameDt = Math.min(frameDt, 0.25);
  const fkSlow = phase !== 'replay' && (fkMode || (phase === 'setpiece' && setpiece?.type === 'freekick') || !!fkCam);
  simScale = inPens ? TIME_SCALE * 0.5 : fkSlow ? TIME_SCALE * 0.85 : TIME_SCALE; // 승부차기 절반 · 프리킥 15% 느리게 (리플레이 제외)
  if (devFlags.on) simScale *= devFlags.speed;
  if (paused) frameDt = 0;
  accum += frameDt * simScale; // 게임 전체 템포(패스·달리기·공·시계·애니메이션)
  let steps = 0;
  while (accum >= FIXED_DT && steps < 6) {
    snapPrev();
    update();
    accum -= FIXED_DT;
    steps++;
  }
  if (steps >= 6) accum = 0; // 탭 전환 후 몰아서 돌리지 않음
  rAlpha = clamp(accum / FIXED_DT, 0, 1);
  // 불투명 메뉴가 화면을 덮고 있으면 3D 관련 갱신 · 렌더를 모두 생략 (메뉴 렉 방지)
  const covered = menuRoot?.classList.contains('dim') && menuRoot.classList.contains('show');
  if (covered) { updateBgm(); requestAnimationFrame(loop); return; }
  updateCrowd(simTime);
  updateStadium(now);
  updateCrowdAudio(now);
  updateBgm();
  updateHud();
  updatePowerShotUi();
  // 카메라도 보간된 위치를 따라가게 (잠시 바꿨다가 되돌림)
  const sv = [ball.x, ball.y, ball.z];
  ball.x = ix(ball, 'x', 'px'); ball.y = ix(ball, 'y', 'py'); ball.z = ix(ball, 'z', 'pz');
  updateCamera(frameDt);
  updateStandFade(frameDt);
  [ball.x, ball.y, ball.z] = sv;
  syncMeshes();
  syncAiDebug();
  drawMinimap();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

// ===== 메뉴 UI =====
const menuRoot = $('menu-root');
const menuTitle = $('menu-title');
const menuTeam = $('menu-team');
const menuSquad = $('menu-squad');
const colorGrid = $('color-grid');
const formationChips = $('formation-chips');
const playerListEl = $('player-list');
const MENU_PHASES = new Set(['intro', 'login', 'club_setup', 'menu', 'league_select', 'squad_setup', 'apc', 'training', 'shop', 'items', 'pm', 'club_info']);
function inMenus() { return MENU_PHASES.has(phase); }

/** 로비 배경: 우리 팀 공격수 한 명만 센터서클에서 공 앞에 서 있음 */
function setupLobbyScene() {
  const star = teamA.find(p => p.role === 'ST') || teamA[9];
  for (const p of allPlayers()) p.mesh.visible = p === star;
  referee.mesh.visible = false;
  if (star) {
    star.x = -3.5; star.z = 0.8; star.vx = star.vz = 0;
    star.faceX = 0.35; star.faceZ = 0.94;
    star.sentOff = false;
  }
  resetBall(-3.2, 1.55);
  activeIdx = teamA.indexOf(star);
}

function crestSvg(css, letter) {
  return `<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="1" stop-color="#000" stop-opacity="0.25"/></linearGradient></defs>
    <path d="M32 2 L60 10 L58 40 C56 56 44 65 32 70 C20 65 8 56 6 40 L4 10 Z" fill="#0a1024" stroke="#fff" stroke-width="2.5"/>
    <path d="M32 8 L54 14 L52 39 C50 52 41 59 32 63 C23 59 14 52 12 39 L10 14 Z" fill="${css}"/>
    <path d="M32 8 L54 14 L52 39 C50 52 41 59 32 63 C23 59 14 52 12 39 L10 14 Z" fill="url(#cg)"/>
    <circle cx="32" cy="34" r="12" fill="none" stroke="#fff" stroke-width="2"/>
    <text x="32" y="39.5" text-anchor="middle" font-family="'Black Han Sans', sans-serif" font-size="15" fill="#fff">${letter}</text>
    <text x="32" y="57" text-anchor="middle" font-family="sans-serif" font-weight="900" font-size="7" fill="#fff" letter-spacing="1">FC</text>`;
}
function escapeHtml(t) {
  return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updateLobby() {
  const home = colorById(userSetup.colorId || 'blue');
  if (!userSetup.oppColorId) userSetup.oppColorId = pickOppColor(home.id);
  const away = colorById(userSetup.oppColorId);
  const lg = currentLeague();
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  const crest = $('club-crest');
  if (crest) crest.innerHTML = crestSvg(home.css, escapeHtml(teamName(true).slice(0, 1)));
  set('club-name', teamName(true));
  set('club-user', currentUser || '-');
  set('club-lv', `Lv.${ensureClub().lv}`);
  set('bottom-user', currentUser || '-');
  set('nm-form', userSetup.formation);
  animNum($('coin-amt'), userSetup.coins || 0);
  set('nm-home', teamName(true));
  set('nm-away', `${away.name} CPU`);
  set('nm-info', `최근 리그: ${lg.name} · 상대 능력치 ${lg.base}`);
  const hs = $('nm-home-shirt'), as = $('nm-away-shirt');
  if (hs) hs.style.background = home.css;
  if (as) as.style.background = away.css;
}

let pkOnly = false; // 로비의 '승부차기' 모드

function toast(msg, ms = 1800) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

// ===== APC 에펙컵: 8팀 토너먼트 =====
const APC_SUFFIX = ['유나이티드', '시티', '로버스', '애슬레틱', '원더러스', '레인저스', '알비온', '스포르팅'];
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const APC_ENH_MIN = 5, APC_ENH_MAX = 10, APC_TR = 10; // APC 상대 강화 · 훈련
function apcIQ(base) { return clamp(0.15 + (base - 65) / 29 * 0.85, 0.15, 1); }
function newApc() {
  const mine = userSetup.colorId || 'blue';
  const others = TEAM_COLORS.filter(c => c.id !== mine);
  const suf = shuffle(APC_SUFFIX.slice());
  // 상대 7팀: 구단 선수 · 강화 5~10강 랜덤 · 훈련 10레벨
  const teams = [{ colorId: mine, name: teamName(true), base: teamOvr(), user: true }]
    .concat(others.map((c, i) => { const enh = APC_ENH_MIN + Math.floor(Math.random() * (APC_ENH_MAX - APC_ENH_MIN + 1)); return { colorId: c.id, name: `${c.name} ${suf[i]}`, enh, tr: APC_TR, base: clubXI(c.id, '4-3-3', { enh, tr: APC_TR }).ovr, user: false }; }));
  const slots = shuffle(teams.map((_, i) => i)); // 대진표 자리 → 팀 번호
  userSetup.apc = { teams, slots, round: 0, res: [[], [], []], out: false, champ: null, drawn: false };
  saveSetup();
}
/** 라운드별 대진: 이전 라운드 승자들로 */
function apcEntrants(r) {
  const A = userSetup.apc;
  if (r === 0) return A.slots.slice();
  return A.res[r - 1].map(m => m?.w);
}
function apcSim(a, b) {
  const A = userSetup.apc;
  const ra = A.teams[a].base, rb = A.teams[b].base;
  const pois = l => { let k = 0, p = Math.exp(-l), s = p, u = Math.random(); while (u > s && k < 8) { k++; p *= l / k; s += p; } return k; };
  const ga = pois(1.2 * Math.exp((ra - rb) / 18)), gb = pois(1.2 * Math.exp((rb - ra) / 18));
  let w = ga > gb ? a : gb > ga ? b : null, pk = null;
  if (w == null) {
    w = Math.random() < 0.5 + (ra - rb) / 60 ? a : b;
    const lo = 2 + Math.floor(Math.random() * 3);
    pk = w === a ? [lo + 1, lo] : [lo, lo + 1];
  }
  return { a, b, ga, gb, pk, w };
}
/** 이번 라운드에서 내 경기를 뺀 나머지를 시뮬레이션 */
function apcSimRest(r) {
  const A = userSetup.apc;
  const ent = apcEntrants(r);
  for (let m = 0; m < ent.length / 2; m++) {
    if (A.res[r][m]) continue;
    const a = ent[m * 2], b = ent[m * 2 + 1];
    if (A.teams[a].user || A.teams[b].user) continue;
    A.res[r][m] = apcSim(a, b);
  }
}
function apcUserMatch(r) {
  const A = userSetup.apc;
  const ent = apcEntrants(r);
  for (let m = 0; m < ent.length / 2; m++) {
    const a = ent[m * 2], b = ent[m * 2 + 1];
    if (A.teams[a]?.user || A.teams[b]?.user) return { m, a, b, opp: A.teams[a].user ? b : a };
  }
  return null;
}
function apcRecordUserResult(won) {
  const A = userSetup.apc;
  if (!A || A.out || A.champ != null) return;
  const um = apcUserMatch(A.round);
  if (!um) return;
  const userIsA = A.teams[um.a].user;
  const ga = userIsA ? score[0] : score[1], gb = userIsA ? score[1] : score[0];
  const pkU = penState && penState.blueTaken + penState.redTaken > 0 ? [penState.blueGoals, penState.redGoals] : null;
  const pk = pkU ? (userIsA ? pkU : [pkU[1], pkU[0]]) : null;
  const userIdx = userIsA ? um.a : um.b;
  A.res[A.round][um.m] = { a: um.a, b: um.b, ga, gb, pk, w: won ? userIdx : um.opp };
  apcSimRest(A.round);
  if (!won) { A.out = true; A.outRound = A.round; }
  if (A.round === 2) A.champ = A.res[2][0].w;
  else A.round++;
  saveSetup();
}
/** 탈락 후: 남은 경기 모두 시뮬레이션 */
function apcFinishAll() {
  const A = userSetup.apc;
  while (A.champ == null) {
    apcSimRest(A.round);
    if (A.round === 2) A.champ = A.res[2][0].w;
    else A.round++;
  }
  saveSetup();
  renderApc();
}

// ===== 리그 시즌: 8구단 · 홈/원정 2번씩 = 14경기 =====
const SEASON_PRIZE = [20000, 14000, 10000, 7000, 5000, 3500, 2500, 1500];
const SIM_ROSTER = [
  { num: 9, label: 'ST', g: 5, a: 1.5 }, { num: 10, label: 'CAM', g: 3, a: 3 }, { num: 11, label: 'LW', g: 3, a: 2.5 },
  { num: 7, label: 'RW', g: 3, a: 2.5 }, { num: 8, label: 'CM', g: 1.6, a: 2.2 }, { num: 6, label: 'CDM', g: 0.8, a: 1.4 },
  { num: 4, label: 'CB', g: 0.6, a: 0.4 }, { num: 5, label: 'CB', g: 0.6, a: 0.4 }, { num: 2, label: 'RB', g: 0.4, a: 1.1 }, { num: 3, label: 'LB', g: 0.4, a: 1.1 },
];
const seasonMonth = r => Math.min(3, Math.floor(r / 4)); // 4라운드 = 한 달
function pickW(list, key, not) { const l = list.filter(x => x !== not); let t = l.reduce((a, x) => a + x[key], 0) * Math.random(); for (const x of l) { t -= x[key]; if (t <= 0) return x; } return l[0]; }
function addStat(S, team, num, label, kind, r) {
  S.pl = S.pl || {};
  const k = `${team}-${num}`;
  const e = S.pl[k] = S.pl[k] || { team, num, label, g: 0, a: 0, mg: [0, 0, 0, 0], ma: [0, 0, 0, 0] };
  const m = seasonMonth(r);
  if (kind === 'g') { e.g++; e.mg[m]++; } else { e.a++; e.ma[m]++; }
}
function simScorers(S, team, goals, r) {
  for (let i = 0; i < goals; i++) {
    const sc = pickW(SIM_ROSTER, 'g');
    addStat(S, team, sc.num, sc.label, 'g', r);
    if (Math.random() < 0.72) { const as = pickW(SIM_ROSTER, 'a', sc); addStat(S, team, as.num, as.label, 'a', r); }
  }
}
function leagueMult() { return LEAGUE_MULT[Math.max(0, LEAGUES.findIndex(l => l.id === userSetup.leagueId))] || 1; }
function newSeason() {
  const lg = currentLeague();
  const mine = userSetup.colorId || 'blue';
  const others = shuffle(TEAM_COLORS.filter(c => c.id !== mine));
  const offs = shuffle([-4, -3, -1, 0, 1, 2, 4]);
  const suf = shuffle(['FC', '유나이티드', '시티', '로버스', '애슬레틱', '원더러스', '레인저스', '알비온']);
  const teams = [{ colorId: mine, name: teamName(true), base: teamOvr(), user: true }]
    .concat(others.map((c, i) => ({ colorId: c.id, name: clubName(c.id), base: clubXI(c.id, '4-3-3', lg).ovr, user: false })));
  // 라운드 로빈(원형 방식): 7라운드 + 홈/원정 바꿔 7라운드
  const ids = shuffle([0, 1, 2, 3, 4, 5, 6, 7]);
  const half = [];
  let arr = ids.slice();
  for (let r = 0; r < 7; r++) {
    const pairs = [];
    for (let i = 0; i < 4; i++) {
      const a = arr[i], b = arr[7 - i];
      pairs.push(r % 2 ? [b, a] : [a, b]);
    }
    half.push(pairs);
    arr = [arr[0], arr[7], ...arr.slice(1, 7)];
  }
  const sched = half.concat(half.map(rd => rd.map(([h, a]) => [a, h])));
  userSetup.season = { leagueId: lg.id, teams, sched, round: 0, res: [], done: false, prize: null };
  saveSetup();
}
function seasonTable() {
  const S = userSetup.season;
  const T = S.teams.map((t, i) => ({ i, t, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 }));
  for (const rd of S.res) for (const m of rd || []) {
    if (!m) continue;
    const H = T[m.h], A = T[m.a];
    H.p++; A.p++; H.gf += m.hg; H.ga += m.ag; A.gf += m.ag; A.ga += m.hg;
    if (m.hg > m.ag) { H.w++; A.l++; H.pts += 3; }
    else if (m.hg < m.ag) { A.w++; H.l++; A.pts += 3; }
    else { H.d++; A.d++; H.pts++; A.pts++; }
  }
  return T.sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || x.t.name.localeCompare(y.t.name));
}
function seasonUserMatch() {
  const S = userSetup.season;
  const rd = S.sched[S.round];
  if (!rd) return null;
  for (let m = 0; m < rd.length; m++) {
    const [h, a] = rd[m];
    if (S.teams[h].user || S.teams[a].user) return { m, h, a, home: S.teams[h].user, opp: S.teams[h].user ? a : h };
  }
  return null;
}
function simScore(ra, rb, homeAdv = 0.1) {
  const pois = l => { let k = 0, p = Math.exp(-l), s2 = p, u = Math.random(); while (u > s2 && k < 8) { k++; p *= l / k; s2 += p; } return k; };
  return [pois(1.3 * Math.exp((ra - rb) / 18 + homeAdv)), pois(1.3 * Math.exp((rb - ra) / 18 - homeAdv))];
}
function seasonRecordUserResult() {
  const S = userSetup.season;
  if (!S || S.done) return '';
  const um = seasonUserMatch();
  if (!um) return '';
  const r = S.round;
  S.res[r] = S.res[r] || [];
  S.res[r][um.m] = um.home ? { h: um.h, a: um.a, hg: score[0], ag: score[1] } : { h: um.h, a: um.a, hg: score[1], ag: score[0] };
  // 내 경기 득점·도움 기록
  const me = S.teams.findIndex(t => t.user);
  for (const g of matchGoals) {
    if (g.own || g.num == null) continue;
    const team = g.blue ? me : um.opp;
    addStat(S, team, g.num, g.label, 'g', r);
    if (g.anum != null) addStat(S, team, g.anum, g.alabel, 'a', r);
  }
  return seasonFinishRound();
}
/** 이번 라운드의 다른 경기들을 시뮬레이션하고 라운드를 넘김 (마지막 라운드면 시즌 종료 → 결산 대기) */
function seasonFinishRound() {
  const S = userSetup.season, r = S.round;
  S.res[r] = S.res[r] || [];
  S.sched[r].forEach(([h, a], m) => {
    if (S.res[r][m]) return;
    const [hg, ag] = simScore(S.teams[h].base, S.teams[a].base);
    S.res[r][m] = { h, a, hg, ag };
    simScorers(S, h, hg, r); simScorers(S, a, ag, r);
  });
  S.round++;
  let html = '';
  if (S.round >= S.sched.length) {
    S.done = true; S.settled = false; S.prize = null;
    const rank = seasonTable().findIndex(x => x.t.user) + 1;
    html = `<div class="reward season-end"><div class="rw-h">🏁 시즌 종료 — 최종 <b style="margin:0 4px;color:#fde68a">${rank}위</b></div><div class="rw-sum">리그 화면에서 <b>결산하기</b>를 눌러 순위 보상을 받으세요</div></div>`;
  }
  saveSetup();
  return html;
}
// ----- 빠른 진행: 직접 뛰지 않고 시뮬레이션 (보상 40% 감소) -----
const QUICK_SIM_RATE = 0.6; // 빠른 진행 보상 비율 (40% 감소)
function seasonQuick() {
  const S = userSetup.season;
  const um = seasonUserMatch();
  if (!S || S.done || !um) return;
  const r = S.round, me = S.teams.findIndex(t => t.user), o = S.teams[um.opp];
  const myBase = teamOvr();
  const [hg, ag] = um.home ? simScore(myBase, o.base) : simScore(o.base, myBase);
  S.res[r] = S.res[r] || [];
  S.res[r][um.m] = { h: um.h, a: um.a, hg, ag };
  const mg = um.home ? hg : ag, og = um.home ? ag : hg;
  simScorers(S, me, mg, r); simScorers(S, um.opp, og, r);
  // 보상: 결과 · 득점 · 득실 · 무실점 × 리그 보정 × 60%
  const won = mg > og, lost = mg < og, mult = leagueMult();
  const items = [[won ? '승리' : lost ? '패배' : '무승부', won ? 1500 : lost ? 300 : 700]];
  if (mg) items.push([`득점 ${Math.min(6, mg)}골`, Math.min(6, mg) * 120]);
  if (mg > og) items.push([`득실차 +${mg - og}`, Math.min(5, mg - og) * 100]);
  if (!og) items.push(['무실점', 200]);
  const base = items.reduce((a, [, v]) => a + v, 0);
  const coins = Math.round(base * mult * QUICK_SIM_RATE / 10) * 10;
  const exp = Math.round(((won ? 120 : lost ? 40 : 70) + Math.min(60, mg * 10)) * QUICK_SIM_RATE);
  userSetup.coins = (userSetup.coins || 0) + coins;
  const lvUp = addClubExp(exp);
  const endHtml = seasonFinishRound();
  renderSeason();
  const el = $('settle-pop');
  el.innerHTML = `<div class="stl-box quick"><div class="stl-h">⏩ 빠른 진행 · ${r + 1}라운드</div>
    <div class="qs-score"><span>${kitDot(S.teams[me].colorId)}${escapeHtml(S.teams[me].name)}</span><b>${mg} : ${og}</b><span>${escapeHtml(o.name)}${kitDot(o.colorId)}</span></div>
    <div class="qs-res ${won ? 'w' : lost ? 'l' : 'd'}">${won ? '승리' : lost ? '패배' : '무승부'}</div>
    <div class="stl-items">${items.map(([k, v]) => `<span>${k} ${v.toLocaleString()}</span>`).join('')}<span>× 리그 ${mult}</span><span class="cut">× 빠른 진행 ${QUICK_SIM_RATE * 100}%</span></div>
    <div class="stl-total"><span class="coin">A</span> +${coins.toLocaleString()} <small>· 구단 EXP +${exp}${lvUp ? ` · 레벨 업! Lv.${ensureClub().lv}` : ''}</small></div>
    ${endHtml ? '<div class="stl-note">🏁 시즌 마지막 경기였어요 — <b>결산하기</b>로 순위 보상을 받으세요</div>' : ''}
    <button type="button" class="btn" id="stl-ok">확인</button></div>`;
  el.classList.add('show');
  $('stl-ok')?.addEventListener('click', () => el.classList.remove('show'));
}
const kitDot = id => `<i class="kit" style="background:${colorById(id).css}"></i>`;
/** 경기 방식 고르기: 직접 플레이 / 빠른 진행 */
function seasonChooseMode() {
  const S = userSetup.season, um = seasonUserMatch();
  if (!um) return;
  const o = S.teams[um.opp];
  const el = $('settle-pop');
  el.innerHTML = `<div class="stl-box mode"><div class="stl-h">${S.round + 1}라운드 · ${um.home ? '홈' : '원정'} vs ${kitDot(o.colorId)}${escapeHtml(o.name)} <small>OVR ${o.base}</small></div>
    <div class="md-opts">
      <button type="button" class="md-opt" id="md-play"><b>🎮 직접 플레이</b><small>경기를 직접 뛰어요 · 보상 100%</small></button>
      <button type="button" class="md-opt" id="md-quick"><b>⏩ 빠른 진행</b><small>팀 능력치로 결과를 바로 계산 · 보상 ${QUICK_SIM_RATE * 100}% (40% 감소)</small></button>
    </div><button type="button" class="btn ghost" id="md-x">취소</button></div>`;
  el.classList.add('show');
  $('md-x')?.addEventListener('click', () => el.classList.remove('show'));
  $('md-play')?.addEventListener('click', () => { el.classList.remove('show'); seasonPlay(); });
  $('md-quick')?.addEventListener('click', () => { el.classList.remove('show'); seasonQuick(); });
}
// ----- 결산: 리그 순위 / 대회 성적만큼 보상 · 우승하면 세리머니 -----
const SEASON_ITEMS = [{ enhBox: 3, bsPack: 2 }, { enhBox: 2, bsPack: 1 }, { enhBox: 1, bsPack: 1 }]; // 1~3위 아이템 보상
const APC_STAGE = ['8강 탈락', '4강 탈락', '준우승', '우승'];
const APC_PRIZE = [3000, 7000, 14000, 30000];
const APC_ITEMS = [null, { enhBox: 1 }, { enhBox: 2, bsPack: 1 }, { enhBox: 4, bsPack: 3 }];
const ITEM_NAME = { enhBox: '강화 박스', bsPack: 'BS 선수팩', trainBox: '훈련박스', breakBox: '훈련돌파박스' };
function giveItems(it) { const v = ensureInv(); for (const [k, n] of Object.entries(it || {})) v[k] = (v[k] || 0) + n; }
const itemsText = it => Object.entries(it || {}).map(([k, n]) => `${ITEM_NAME[k] || k} ${n}개`).join(' · ');
function seasonSettle() {
  const S = userSetup.season;
  if (!S || !S.done || S.settled) return;
  const tbl = seasonTable(), rank = tbl.findIndex(x => x.t.user) + 1;
  const coins = Math.round(SEASON_PRIZE[rank - 1] * leagueMult() / 10) * 10;
  const items = SEASON_ITEMS[rank - 1] || null;
  userSetup.coins = (userSetup.coins || 0) + coins;
  giveItems(items);
  S.settled = true; S.prize = { rank, coins, items };
  saveSetup();
  renderSeason();
  const lg = currentLeague();
  const pl = Object.values(S.pl || {}), top = k => pl.filter(e => e[k] > 0).sort((a, b) => b[k] - a[k])[0];
  const g = top('g'), a = top('a');
  const honor = [g && `⚽ 득점왕 ${S.teams[g.team].name} ${g.num}번 (${g.g}골)`, a && `🅰️ 도움왕 ${S.teams[a.team].name} ${a.num}번 (${a.a}도움)`].filter(Boolean);
  const panel = { title: `${lg.name} 시즌 결산`, big: `${rank}위`, sub: rank === 1 ? '🏆 리그 우승!' : `${tbl[0].t.name} 우승`, coins, items, honor,
    table: tbl.slice(0, 8).map((x, k) => `<div class="stl-tr ${x.t.user ? 'me' : ''}"><span>${k + 1}</span>${kitDot(x.t.colorId)}<span class="tn">${escapeHtml(x.t.name)}</span><b>${x.pts}점</b></div>`).join('') };
  if (rank === 1) playTrophyCeremony({ comp: lg.name, kind: 'league', lg, panel });
  else showSettle(panel);
}
function apcSettle() {
  const A = userSetup.apc;
  if (!A || A.settled) return;
  if (A.champ == null) apcFinishAll();
  const champ = A.teams[A.champ]?.user;
  const stage = champ ? 3 : (A.outRound ?? 0);
  const coins = APC_PRIZE[stage], items = APC_ITEMS[stage];
  userSetup.coins = (userSetup.coins || 0) + coins;
  giveItems(items);
  A.settled = true; A.prize = { stage, coins, items };
  saveSetup();
  renderApc();
  const panel = { title: 'APC 에펙컵 결산', big: APC_STAGE[stage], sub: champ ? '🏆 APC 에펙컵 우승!' : `우승: ${A.teams[A.champ].name}`, coins, items, honor: [], table: '' };
  if (champ) playTrophyCeremony({ comp: 'APEX PREMIER CUP', kind: 'cup', panel });
  else showSettle(panel);
}
function settleHtml(P) {
  return `<div class="stl-h">${escapeHtml(P.title)}</div><div class="stl-big">${escapeHtml(P.big)}</div><div class="stl-sub">${escapeHtml(P.sub)}</div>
    ${P.table ? `<div class="stl-table">${P.table}</div>` : ''}
    <div class="stl-rw"><div class="stl-total"><span class="coin">A</span> +${P.coins.toLocaleString()}</div>${P.items ? `<div class="stl-it">🎁 ${itemsText(P.items)} <small>→ '아이템'</small></div>` : ''}</div>
    ${P.honor.length ? `<div class="stl-honor">${P.honor.map(h => `<span>${escapeHtml(h)}</span>`).join('')}</div>` : ''}`;
}
function showSettle(P) {
  const el = $('settle-pop');
  el.innerHTML = `<div class="stl-box">${settleHtml(P)}<button type="button" class="btn" id="stl-ok">확인</button></div>`;
  el.classList.add('show');
  $('stl-ok')?.addEventListener('click', () => el.classList.remove('show'));
}
function renderSeason() {
  const S = userSetup.season;
  const el = $('season-body');
  if (!el || !S) return;
  const tbl = seasonTable();
  const kit = id => `<i class="kit" style="background:${colorById(id).css}"></i>`;
  const rows = tbl.map((x, k) => `<tr class="${x.t.user ? 'me' : ''} ${k < 1 ? 'top' : ''}"><td>${k + 1}</td><td class="tn">${kit(x.t.colorId)}${escapeHtml(x.t.name)}<small>${x.t.base}</small></td><td>${x.p}</td><td>${x.w}</td><td>${x.d}</td><td>${x.l}</td><td>${x.gf}</td><td>${x.ga}</td><td>${x.gf - x.ga > 0 ? '+' : ''}${x.gf - x.ga}</td><td class="pts">${x.pts}</td></tr>`).join('');
  // 내 일정 14경기
  const me = S.teams.findIndex(t => t.user);
  const fx = S.sched.map((rd, r) => {
    const m = rd.findIndex(([h, a]) => h === me || a === me);
    const [h, a] = rd[m];
    const home = h === me, opp = S.teams[home ? a : h];
    const res = S.res[r]?.[m];
    let tag = '', sc = '';
    if (res) {
      const mg = home ? res.hg : res.ag, og = home ? res.ag : res.hg;
      tag = mg > og ? '<b class="w">승</b>' : mg < og ? '<b class="l">패</b>' : '<b class="d">무</b>';
      sc = `${mg} : ${og}`;
    }
    return `<div class="fx ${r === S.round && !S.done ? 'next' : ''} ${res ? 'done' : ''}"><span class="rd">R${r + 1}</span><span class="ha">${home ? '홈' : '원정'}</span>${kit(opp.colorId)}<span class="on">${escapeHtml(opp.name)}</span><span class="sc">${sc}</span>${tag}</div>`;
  }).join('');
  const um = !S.done ? seasonUserMatch() : null;
  const opp = um ? S.teams[um.opp] : null;
  const prizeList = SEASON_PRIZE.map((v, i) => `${i + 1}위 ${Math.round(v * leagueMult() / 10) * 10 >= 10000 ? (Math.round(v * leagueMult() / 100) / 10) + '만' : Math.round(v * leagueMult() / 10) * 10}`).join(' · ');
  const lgc = currentLeague();
  el.innerHTML = `
    <div class="lg-head lg-${lgc.tier}">${leagueEmblem(lgc)}<div><div class="lg-hn ${lgc.tier === 'apl' ? 'apl-name' : ''}">${escapeHtml(lgc.name)}</div><div class="lg-hs">상대 평균 OVR <b>${lgc.base}</b> · 내 팀 OVR <b>${teamOvr()}</b> · ${S.done ? '시즌 종료' : `${S.round}/14 라운드 진행`}</div></div></div>
    <div class="season">
      <div class="st-card">
        <div class="st-h">${escapeHtml(currentLeague().name)} 순위표 <small>${S.done ? '시즌 종료' : `${S.round}/14 경기`}</small></div>
        <table class="st"><thead><tr><th>#</th><th class="tn">팀</th><th>경기</th><th>승</th><th>무</th><th>패</th><th>득</th><th>실</th><th>득실</th><th>승점</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="st-prize">시즌 순위 보상 (A코인): ${prizeList}</div>
      </div>
      <div class="fx-card">
        <div class="st-h">${S.done ? (S.settled ? `🏁 결산 완료 — ${S.prize?.rank}위 · +${(S.prize?.coins || 0).toLocaleString()} A코인` : '🏁 시즌 종료 — 결산하기를 눌러 보상을 받으세요') : `다음 경기 · ${S.round + 1}라운드`}</div>
        ${opp ? `<div class="next-m">${kit(S.teams[me].colorId)}<b>${escapeHtml(S.teams[me].name)}</b><span>vs</span>${kit(opp.colorId)}<b>${escapeHtml(opp.name)}</b><small>${um.home ? '홈' : '원정'} · 상대 능력치 ${opp.base}</small></div>` : ''}
        <div class="fx-list">${fx}</div>
      </div>
    </div>
    ${seasonLeadersHtml(S)}`;
  const go = $('btn-play-match');
  if (S.done && S.prize && S.settled == null) S.settled = true; // 예전 시즌(자동 지급)은 결산 완료로
  if (go) { go.textContent = S.done ? (S.settled ? '새 시즌 시작' : '🏆 결산하기') : `${S.round + 1}라운드 진행`; go.classList.toggle('settle', !!(S.done && !S.settled)); }
}
function seasonLeadersHtml(S) {
  const pl = Object.values(S.pl || {});
  const nm = e => `<i class="kit" style="background:${colorById(S.teams[e.team].colorId).css}"></i><span class="ln">${escapeHtml(S.teams[e.team].name)} <b>${e.num}번</b> <small>${escapeHtml(e.label || '')}</small></span>`;
  const top = (key) => pl.filter(e => e[key] > 0).sort((a, b) => b[key] - a[key] || b[key === 'g' ? 'a' : 'g'] - a[key === 'g' ? 'a' : 'g']).slice(0, 5);
  const list = (arr, key, unit) => arr.length ? arr.map((e, i) => `<div class="ld ${S.teams[e.team].user ? 'me' : ''}"><span class="rk">${i + 1}</span>${nm(e)}<b class="v">${e[key]}${unit}</b></div>`).join('') : '<div class="ld empty">아직 기록이 없어요</div>';
  // 이번 달 MVP: 그 달 득점 3점 + 도움 2점
  const played = Math.max(0, S.round - 1);
  const mon = seasonMonth(played);
  const monRange = m => `${m * 4 + 1}~${Math.min(14, m * 4 + 4)}R`;
  const mvpOf = m => pl.map(e => ({ e, s: e.mg[m] * 3 + e.ma[m] * 2 })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || b.e.mg[m] - a.e.mg[m])[0];
  const cur = S.round > 0 ? mvpOf(mon) : null;
  const past = [];
  for (let m = 0; m < mon; m++) { const x = mvpOf(m); if (x) past.push(`<div class="ld"><span class="rk">${m + 1}월</span>${nm(x.e)}<b class="v">${x.e.mg[m]}골 ${x.e.ma[m]}도움</b></div>`); }
  return `<div class="leaders">
    <div class="ld-card"><div class="st-h">⚽ 득점왕</div>${list(top('g'), 'g', '골')}</div>
    <div class="ld-card"><div class="st-h">🅰️ 도움왕</div>${list(top('a'), 'a', '도움')}</div>
    <div class="ld-card mvp"><div class="st-h">🏅 이번 달 리그 MVP <small>${S.round > 0 ? `${mon + 1}월 · ${monRange(mon)}` : ''}</small></div>
      ${cur ? `<div class="mvp-big">${nm(cur.e)}<b>${cur.e.mg[mon]}골 · ${cur.e.ma[mon]}도움</b></div>` : '<div class="ld empty">아직 기록이 없어요</div>'}
      ${past.length ? `<div class="mvp-past"><small>지난 달 MVP</small>${past.join('')}</div>` : ''}</div>
  </div>`;
}
function seasonGo() {
  const S = userSetup.season;
  if (!S) return;
  if (S.done) { if (!S.settled) seasonSettle(); else { newSeason(); renderSeason(); } return; }
  seasonChooseMode();
}
function seasonPlay() {
  const S = userSetup.season;
  if (!S || S.done) return;
  const um = seasonUserMatch();
  if (!um) return;
  const o = S.teams[um.opp];
  const lg = currentLeague();
  apcOpp = { kind: 'league', name: o.name, colorId: o.colorId, base: o.base, iq: clamp(lg.iq + (o.base - lg.base) * 0.03, 0.1, 1) };
  userSetup.oppColorId = o.colorId;
  const forms = Object.keys(FORMATIONS);
  userSetup.cpuFormation = forms[Math.floor(Math.random() * forms.length)];
  if (menuRoot) menuRoot.classList.remove('show');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  resetMatch();
  startPreMatch();
}

// ===================== 우승 세리머니 =====================
// 선수들이 한 명씩 걸어 들어와 두 줄로 서고 → 마지막으로 주장이 트로피를 들고 입장 → 다 같이 번쩍 들어 올리며 환호 · 뒤에서 불꽃 · 꽃가루
const CER_T = { first: 900, gap: 360, walk: 1500, captainWalk: 1900, crouch: 650, panel: 2600 }; // 연출 시간(ms)
let cer = null;
const CER_SKIN = ['#f1c9a5', '#e0ac85', '#c68b62', '#a26a43', '#7a4b2c', '#f5d6bd'];
const CER_HAIR = ['#1f1308', '#3b2412', '#6b4423', '#0b0b0b', '#c2a25a', '#2a1a0e'];
function cerPlayerSvg(o) {
  const sk = o.skin, sh = o.shirt, so = o.shorts, hd = o.hair;
  const arm = (x1, y1, x2, y2, x3, y3) => `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${sh}" stroke-width="8" stroke-linecap="round"/><path d="M${x2} ${y2} L${x3} ${y3}" stroke="${sk}" stroke-width="6.5" stroke-linecap="round"/><circle cx="${x3}" cy="${y3}" r="4" fill="${sk}"/>`;
  return `<svg viewBox="0 0 60 150" class="cp-svg">
    <ellipse cx="30" cy="147" rx="17" ry="3.5" fill="rgba(0,0,0,0.35)"/>
    <g class="leg l"><rect x="20" y="96" width="9" height="20" rx="3" fill="${sk}"/><rect x="20" y="113" width="9" height="24" rx="2" fill="${o.sock}"/><rect x="18.5" y="136" width="11.5" height="7" rx="3" fill="#111"/></g>
    <g class="leg r"><rect x="31" y="96" width="9" height="20" rx="3" fill="${sk}"/><rect x="31" y="113" width="9" height="24" rx="2" fill="${o.sock}"/><rect x="30" y="136" width="11.5" height="7" rx="3" fill="#111"/></g>
    <path d="M17 84h26l2.5 18H32l-2-5-2 5H14.5z" fill="${so}"/>
    <path d="M17 45 Q30 39 43 45 L45.5 87 H14.5 Z" fill="${sh}"/><path d="M24 41 L30 48 L36 41" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="2"/>
    <text x="30" y="72" text-anchor="middle" font-size="13" font-weight="900" fill="rgba(255,255,255,0.85)" font-family="sans-serif">${o.num}</text>
    <g class="medal"><path d="M26 42 L30 56 L34 42" fill="none" stroke="#2563eb" stroke-width="2.4"/><circle cx="30" cy="58" r="4.2" fill="#facc15" stroke="#a16207" stroke-width="1"/></g>
    <rect x="26.5" y="33" width="7" height="9" fill="${sk}"/>
    <circle cx="30" cy="27" r="10.5" fill="${sk}"/><path d="M19.5 26 Q20 14 30 14.5 Q40 14 40.5 26 Q37 19 30 19.5 Q23 19 19.5 26z" fill="${hd}"/>
    <g class="arms-dn">${arm(17, 48, 13, 66, 14, 82)}${arm(43, 48, 47, 66, 46, 82)}</g>
    <g class="arms-hold">${arm(17, 48, 16, 64, 27, 62)}${arm(43, 48, 44, 64, 33, 62)}</g>
    <g class="arms-up">${arm(17, 47, 9, 30, 6, 10)}${arm(43, 47, 51, 30, 54, 10)}</g>
  </svg>`;
}
const CUP_SVG = `<svg viewBox="0 0 80 110" class="cer-cup"><defs><linearGradient id="cupg" x1="0" x2="1"><stop offset="0" stop-color="#9ca3af"/><stop offset="0.35" stop-color="#ffffff"/><stop offset="0.6" stop-color="#d1d5db"/><stop offset="1" stop-color="#6b7280"/></linearGradient></defs>
  <path d="M22 10 Q6 12 6 34 Q6 52 26 54" fill="none" stroke="url(#cupg)" stroke-width="5"/><path d="M58 10 Q74 12 74 34 Q74 52 54 54" fill="none" stroke="url(#cupg)" stroke-width="5"/>
  <path d="M18 6 H62 Q62 52 44 64 V80 H36 V64 Q18 52 18 6z" fill="url(#cupg)"/><ellipse cx="40" cy="6" rx="22" ry="4" fill="#e5e7eb" stroke="#9ca3af"/>
  <path d="M28 80 H52 L56 92 H24z" fill="url(#cupg)"/><rect x="20" y="92" width="40" height="14" rx="2" fill="#374151"/><rect x="24" y="96" width="32" height="5" rx="1" fill="#facc15" opacity="0.8"/></svg>`;
function sndFirework(t = 0) {
  if (!sfxOk()) return;
  noiseHit(AU.sfx, { t, dur: 0.18, freq: 900, q: 0.6, gain: 0.25 });
  noiseHit(AU.sfx, { t: t + 0.08, dur: 0.9, type: 'highpass', freq: 4000, q: 0.3, gain: 0.06 });
}
function playTrophyCeremony({ comp, kind, lg, panel }) {
  const el = $('trophy-cer');
  if (!el) { showSettle(panel); return; }
  const c = colorById(userSetup.colorId || 'blue');
  const L = ensureRoster() && userSetup.lineup;
  const ids = [...L.xi, ...L.subs.slice(0, 3)];
  let cap = L.xi[0], best = -1;
  for (const r of L.xi) { const o = statsOf(r).ovr; if (o > best) { best = o; cap = r; } }
  const others = ids.filter(r => r !== cap);
  const gkC = c.id === 'orange' ? '#22c55e' : '#f97316';
  const dark = `color-mix(in srgb, ${c.css} 55%, #000)`;
  const mk = (r, k) => ({ r, num: slotNum(r, k), skin: CER_SKIN[(r * 7 + 3) % CER_SKIN.length], hair: CER_HAIR[(r * 5 + 1) % CER_HAIR.length], shirt: posOf(r) === 'GK' ? gkC : c.css, shorts: posOf(r) === 'GK' ? '#111827' : '#f8fafc', sock: posOf(r) === 'GK' ? gkC : c.css });
  // 자리: 뒷줄 7명 · 앞줄 6명(가운데는 주장 자리 비움)
  const back = [14, 26, 38, 50, 62, 74, 86], front = [10, 22, 34, 66, 78, 90];
  const spots = others.map((r, k) => k < back.length ? { x: back[k], row: 'b' } : { x: front[k - back.length] ?? (8 + (k % 6) * 16), row: 'f' });
  const crest = `<svg viewBox="0 0 64 72">${crestSvg(c.css, escapeHtml(teamName(true).slice(0, 1)))}</svg>`;
  const fw = Array.from({ length: 12 }, (_, k) => `<div class="fw" style="left:${6 + (k * 41) % 88}%;top:${6 + (k * 23) % 40}%;--d:${(k * 0.37) % 2.4}s;--c:${['#fde047', '#f472b6', '#60a5fa', '#fff', '#34d399', '#fb923c'][k % 6]}">${Array.from({ length: 16 }, (_, j) => `<i style="--a:${j * 22.5}deg"></i>`).join('')}</div>`).join('');
  const conf = Array.from({ length: 80 }, (_, k) => `<i style="left:${(k * 37) % 100}%;--d:${((k * 0.173) % 3).toFixed(2)}s;--t:${(2.6 + (k % 7) * 0.35).toFixed(2)}s;--r:${(k * 47) % 360}deg;background:${['#fde047', '#e5e7eb', c.css, '#fff', '#facc15'][k % 5]}"></i>`).join('');
  el.innerHTML = `<div class="cer-bg"></div><div class="cer-glitter"></div><div class="cer-fw">${fw}</div>
    <div class="cer-arch" style="--ac:${dark}"><svg viewBox="0 0 1000 360" preserveAspectRatio="none" class="arch-svg"><path d="M40 360 V200 Q500 -60 960 200 V360 H880 V215 Q500 20 120 215 V360 Z" fill="var(--ac)" stroke="rgba(255,255,255,0.35)" stroke-width="3"/></svg>
      <div class="arch-t"><b>WINNERS</b><small>${escapeHtml(comp)} ${new Date().getFullYear()}</small></div>
      <div class="arch-crest l">${crest}</div><div class="arch-crest r">${crest}</div></div>
    <div class="cer-stage"><div class="cer-podium"></div><div class="cer-pl" id="cer-pl"></div></div>
    <div class="cer-conf">${conf}</div><div class="cer-flash"></div>
    <div class="cer-team"><b>${escapeHtml(teamName(true))}</b><small>${escapeHtml(panel.sub)}</small></div>
    <div class="cer-panel"><div class="stl-box">${settleHtml(panel)}<button type="button" class="btn" id="cer-ok">확인</button></div></div>
    <div class="cer-skip">클릭하면 건너뛰기</div>`;
  const box = $('cer-pl');
  const add = (o, spot, isCap) => {
    const d = document.createElement('div');
    d.className = `cp ${spot.row} walk${isCap ? ' cap' : ''}`;
    d.style.left = '112%';
    d.style.setProperty('--x', spot.x + '%');
    d.innerHTML = cerPlayerSvg(o) + (isCap ? CUP_SVG : '') + `<span class="cp-nm">${escapeHtml(pname(o.r))}</span>`;
    box.appendChild(d);
    return d;
  };
  el.className = 'show';
  cer = { t: [], kind };
  const at = (ms, f) => cer.t.push(setTimeout(f, ms));
  const arrive = (d, dur) => { requestAnimationFrame(() => { d.style.transition = `left ${dur}ms linear`; d.style.left = d.style.getPropertyValue('--x'); }); at(dur, () => d.classList.remove('walk')); };
  others.forEach((r, k) => at(CER_T.first + k * CER_T.gap, () => arrive(add(mk(r, k), spots[k], false), CER_T.walk)));
  const capAt = CER_T.first + others.length * CER_T.gap + 500;
  at(capAt, () => { const d = add(mk(cap, 0), { x: 50, row: 'f' }, true); d.classList.add('hold'); arrive(d, CER_T.captainWalk); sndCheer(0.6); });
  const liftAt = capAt + CER_T.captainWalk + CER_T.crouch;
  at(liftAt - CER_T.crouch, () => el.classList.add('crouch'));
  const lift = () => {
    el.classList.remove('crouch'); el.classList.add('lift');
    sndCheer(1.3); for (let k = 0; k < 6; k++) sndFirework(k * 0.42);
  };
  at(liftAt, lift);
  at(liftAt + CER_T.panel, () => el.classList.add('done'));
  el.onclick = e => {
    if (e.target.closest('#cer-ok')) { cer?.t.forEach(clearTimeout); cer = null; el.className = ''; el.innerHTML = ''; return; }
    if (!el.classList.contains('lift') && cer) {
      // 건너뛰기: 모두 제자리 → 바로 들어 올리기
      cer.t.forEach(clearTimeout); cer.t = [];
      box.innerHTML = '';
      others.forEach((r, k) => { const d = add(mk(r, k), spots[k], false); d.classList.remove('walk'); d.style.left = spots[k].x + '%'; });
      const d = add(mk(cap, 0), { x: 50, row: 'f' }, true); d.classList.remove('walk'); d.style.left = '50%';
      lift();
      cer.t.push(setTimeout(() => el.classList.add('done'), 1200));
    }
  };
}
function slotNum(r, k) { return cardTpl(r)?.num ?? k + 1; }

// ===================== 컵대회 오프닝 (리그와 다른 분위기) =====================
function sndAnthem() {
  if (!sfxOk()) return;
  // 장엄한 화음 진행 (D - G - A - D)
  const ch = [[146.8, 220, 293.7, 370], [196, 246.9, 293.7, 392], [220, 277.2, 329.6, 440], [146.8, 220, 293.7, 370, 587.3]];
  ch.forEach((notes, i) => notes.forEach(f => {
    tone(AU.sfx, { t: i * 1.05, f, dur: 1.5, type: 'triangle', gain: 0.045, attack: 0.25 });
    tone(AU.sfx, { t: i * 1.05, f: f * 2, dur: 1.3, type: 'sine', gain: 0.018, attack: 0.3 });
  }));
}
const APC_ROUND_EN = ['QUARTER-FINAL', 'SEMI-FINAL', 'FINAL'];
function renderCupIntro() {
  const el = $('cup-intro');
  if (!el) return;
  const A = userSetup.apc, rd = A?.round ?? 0;
  const me = colorById(userSetup.colorId || 'blue'), op = colorById(userSetup.oppColorId || 'red');
  const cr = (c, nm) => `<svg viewBox="0 0 64 72">${crestSvg(c.css, escapeHtml(nm.slice(0, 1)))}</svg>`;
  const stars = Array.from({ length: 8 }, (_, k) => { const a = k / 8 * Math.PI * 2 - Math.PI / 2; return `<path transform="translate(${50 + Math.cos(a) * 33} ${50 + Math.sin(a) * 33}) scale(0.9)" d="M0 -9 L2.6 -2.8 L9 -2.8 L3.8 1.2 L5.6 7.6 L0 3.8 L-5.6 7.6 L-3.8 1.2 L-9 -2.8 L-2.6 -2.8z" fill="#f8fafc"/>`; }).join('');
  const sky = Array.from({ length: 60 }, (_, k) => `<i style="left:${(k * 53) % 100}%;top:${(k * 29) % 100}%;--d:${(k * 0.21) % 3}s;--s:${1 + (k % 3)}px"></i>`).join('');
  el.innerHTML = `<div class="ci-sky">${sky}</div><div class="ci-ring"></div>
    <div class="ci-logo"><svg viewBox="0 0 100 100"><defs><radialGradient id="cib" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#020617"/></radialGradient></defs><circle cx="50" cy="50" r="46" fill="url(#cib)" stroke="#cbd5e1" stroke-width="2.5"/>${stars}<text x="50" y="57" text-anchor="middle" font-size="19" font-weight="900" fill="#e2e8f0" font-family="'Black Han Sans', sans-serif" letter-spacing="1">APC</text></svg></div>
    <div class="ci-title">APEX PREMIER CUP</div><div class="ci-round">${APC_ROUND_EN[rd]} · ${['8강', '4강', '결승'][rd]}</div>
    <div class="ci-vs"><div class="ci-t l">${cr(me, teamName(true))}<b>${escapeHtml(teamName(true))}</b></div><span>VS</span><div class="ci-t r">${cr(op, teamName(false))}<b>${escapeHtml(teamName(false))}</b></div></div>`;
}
// ===== 경기 전 행사: 라운업 소개 → 선수 입장(1열) · 악수 → 각자 위치로 =====
let pre = null;
const LINE_Z = -13;
function startPreMatch() {
  if (globalThis.__skipPreMatch) return; // (자동 테스트)
  for (const p of allPlayers()) { p.koX = p.x; p.koZ = p.z; p.koFX = p.faceX; p.koFZ = p.faceZ; }
  const cup = apcOpp?.kind === 'apc';
  pre = { stage: cup ? 'cupintro' : 'lineup', t: 0 };
  phase = 'prematch';
  clockPaused = true;
  setMatchHudVisible(false);
  setpieceHint.style.display = 'none';
  renderLineup();
  if (cup) { renderCupIntro(); $('cup-intro')?.classList.add('show'); sndAnthem(); }
  else $('lineup')?.classList.add('show');
  preHint();
  // 선수들은 터널 안에서 대기
  const order = t => [t.find(p => p.role === 'GK'), ...t.filter(p => p.role !== 'GK')];
  [order(teamA), order(teamB)].forEach((list, side) => {
    list.forEach((p, i) => {
      p.x = (side ? 1 : -1) * 0.9; p.z = -FIELD_H / 2 - 2 - i * 1.4;
      p.vx = p.vz = 0; p.faceX = 0; p.faceZ = 1;
      p.preIdx = i; p.preSide = side;
      p.slotX = (side ? 1 : -1) * (2.4 + i * 1.25);
      p.preStage = 0; p.shake = 0;
    });
  });
  referee.x = 0; referee.z = -FIELD_H / 2 - 0.5; referee.vx = referee.vz = 0;
  ball.owner = null; ball.x = 0; ball.z = 0; ball.y = BALL_R; ball.vx = ball.vz = ball.vy = 0;
}
const PRE_LABEL = { cupintro: '대회 오프닝', lineup: '라인업 소개', walk: '선수 입장', shake: '악수', move: '위치로 이동' };
function preHint() {
  const el = $('prematch-hint');
  if (!el || !pre) return;
  el.innerHTML = `<b>${PRE_LABEL[pre.stage]}</b> · <kbd>SPACE</kbd> ${PRE_LABEL[pre.stage]} 건너뛰기 · <kbd>ENTER</kbd> 전체 건너뛰기`;
  el.classList.add('show');
}
function preNext() {
  if (!pre) return;
  const order = ['cupintro', 'lineup', 'walk', 'shake', 'move'];
  const i = order.indexOf(pre.stage);
  if (pre.stage === 'cupintro') { $('cup-intro')?.classList.remove('show'); $('lineup')?.classList.add('show'); pre.stage = 'lineup'; pre.t = 0; preHint(); return; }
  if (pre.stage === 'lineup') $('lineup')?.classList.remove('show');
  if (pre.stage === 'walk' || pre.stage === 'lineup') { // 입장을 건너뛰면 바로 줄을 선 상태로
    for (const p of allPlayers()) { p.x = p.slotX; p.z = LINE_Z; p.faceX = 0; p.faceZ = 1; p.vx = p.vz = 0; }
    referee.x = 0; referee.z = LINE_Z; referee.vx = referee.vz = 0;
  }
  if (pre.stage === 'lineup') { // 입장 장면은 터널부터
    allPlayers().forEach(p => { p.x = (p.preSide ? 1 : -1) * 0.9; p.z = -FIELD_H / 2 - 2 - p.preIdx * 1.4; p.preStage = 0; });
    referee.x = 0; referee.z = -FIELD_H / 2 - 0.5;
  }
  if (pre.stage === 'shake') {
    for (const p of teamB) { p.x = p.slotX; p.z = LINE_Z; p.shake = 0; }
  }
  if (i >= order.length - 1) { endPreMatch(); return; }
  pre.stage = order[i + 1];
  pre.t = 0;
  for (const p of allPlayers()) p.preStage = 0;
  preHint();
}
function endPreMatch() {
  pre = null;
  sndWhistle('long'); sndCheer(0.8);
  setTimeout(() => comm.kickoff(), 700);
  $('lineup')?.classList.remove('show');
  $('cup-intro')?.classList.remove('show');
  $('prematch-hint')?.classList.remove('show');
  for (const p of allPlayers()) { p.shake = 0; p.vx = p.vz = 0; }
  setMatchHudVisible(true);
  beginKickoff(true);
  updateHud();
}
function preMoveTo(p, tx, tz, spd) {
  const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
  if (d < 0.05) { p.vx = p.vz = 0; return true; }
  const st = Math.min(d, spd);
  p.vx = dx / d * st; p.vz = dz / d * st;
  p.x += p.vx; p.z += p.vz;
  [p.faceX, p.faceZ] = turnToward(p.faceX || 0, p.faceZ || 1, dx / d, dz / d, 0.25);
  return d - st < 0.05;
}
function updatePreMatch() {
  if (!pre) return;
  pre.t++;
  const all = allPlayers();
  if (pre.stage === 'cupintro') {
    if (pre.t > 290) preNext();
  } else if (pre.stage === 'lineup') {
    if (pre.t > 380) preNext();
  } else if (pre.stage === 'walk') {
    let done = true;
    for (const p of all) {
      if (pre.t < p.preIdx * 6) { done = false; continue; }
      const colX = (p.preSide ? 1 : -1) * 0.9;
      if (p.preStage === 0) { if (preMoveTo(p, colX, LINE_Z - 1.2, WALK * 1.25)) p.preStage = 1; done = false; }
      else if (p.preStage === 1) { if (preMoveTo(p, p.slotX, LINE_Z, WALK * 1.25)) p.preStage = 2; done = false; }
      else { p.vx = p.vz = 0; [p.faceX, p.faceZ] = turnToward(p.faceX, p.faceZ, 0, 1, 0.15); }
    }
    if (referee.z < LINE_Z - 0.05) { referee.vz = Math.min(WALK * 1.25, LINE_Z - referee.z); referee.z += referee.vz; } else referee.vz = 0;
    if (done) { pre.hold = (pre.hold || 0) + 1; if (pre.hold > 50) { pre.hold = 0; preNext(); } }
  } else if (pre.stage === 'shake') {
    // 원정팀이 홈팀 줄 앞을 지나가며 한 명씩 악수
    let done = true;
    const endX = -2.4 - 10 * 1.25 - 1.6;
    for (const p of teamB) {
      if (pre.t < p.preIdx * 7) { done = false; continue; }
      if (p.preStage === 0) { if (preMoveTo(p, p.x, LINE_Z + 0.95, WALK * 1.0)) p.preStage = 1; done = false; }
      else if (p.preStage === 1) { if (preMoveTo(p, endX, LINE_Z + 0.95, WALK * 1.15)) p.preStage = 2; done = false; }
      else { p.vx = p.vz = 0; }
      for (const h of teamA) if (Math.abs(h.x - p.x) < 0.7 && p.preStage === 1) { h.shake = 8; p.shake = 8; [h.faceX, h.faceZ] = turnToward(h.faceX, h.faceZ, 0.6, 0.8, 0.3); }
    }
    for (const h of teamA) { if (h.shake > 0) h.shake--; else [h.faceX, h.faceZ] = turnToward(h.faceX, h.faceZ, 0, 1, 0.1); h.vx = h.vz = 0; }
    for (const p of teamB) if (p.shake > 0) p.shake--;
    if (done) { pre.hold = (pre.hold || 0) + 1; if (pre.hold > 40) { pre.hold = 0; preNext(); } }
  } else if (pre.stage === 'move') {
    let done = true;
    for (const p of all) if (!preMoveTo(p, p.koX, p.koZ, WALK * 2)) done = false;
    if (Math.hypot(referee.x, referee.z - 6) > 0.1) { const d = Math.hypot(referee.x, referee.z - 6); referee.vx = -referee.x / d * Math.min(d, WALK * 1.4); referee.vz = (6 - referee.z) / d * Math.min(d, WALK * 1.4); referee.x += referee.vx; referee.z += referee.vz; done = false; }
    if (done || pre.t > 900) endPreMatch();
  }
}
function renderLineup() {
  const el = $('lineup');
  if (!el) return;
  const side = (team, blue) => {
    const c = colorById(blue ? userSetup.colorId || 'blue' : userSetup.oppColorId || 'red');
    const ovr = p => Math.round(STAT_DEFS.filter(d => d.roles === 'all' || d.roles === (p.role === 'GK' ? 'gk' : 'outfield')).reduce((a, d) => a + (p.customStats?.[d.key] ?? 0), 0) / STAT_DEFS.filter(d => d.roles === 'all' || d.roles === (p.role === 'GK' ? 'gk' : 'outfield')).length);
    const order = [...team].sort((a, b) => (a.role === 'GK' ? -1 : 0) - (b.role === 'GK' ? -1 : 0));
    return `<div class="lu-team" style="--tc:${c.css}">
      <div class="lu-h"><svg viewBox="0 0 64 72">${crestSvg(c.css, escapeHtml(teamName(blue).slice(0, 1)))}</svg><div><b>${escapeHtml(teamName(blue))}</b><small>${escapeHtml(blue ? activeFormation : userSetup.cpuFormation || activeFormation)} · 능력치 ${blue ? teamOvr() : oppBase()}</small></div></div>
      ${order.map((p, i) => `<div class="lu-row" style="animation-delay:${0.15 + i * 0.09}s">${faceImg('sm')}<span class="no">${p.num}</span><span class="po">${escapeHtml(p.label)}</span><span class="nm">${p.num}번 ${p.role === 'GK' ? '골키퍼' : escapeHtml(p.label)}</span><span class="ov">${ovr(p)}</span></div>`).join('')}
    </div>`;
  };
  const cupL = apcOpp?.kind === 'apc', lgL = apcOpp?.kind === 'league' ? currentLeague() : null;
  el.classList.toggle('cup', cupL);
  el.innerHTML = `<div class="lu-title">${lgL ? `<span class="lu-emb">${leagueEmblem(lgL)}</span>` : ''}${cupL ? '<span class="lu-star">★ ★ ★</span>' : ''}STARTING LINE-UP<small>${escapeHtml(compName())}${cupL ? ` · ${APC_ROUND_EN[userSetup.apc?.round ?? 0]}` : ''}</small></div><div class="lu-wrap">${side(teamA, true)}<div class="lu-vs">VS</div>${side(teamB, false)}</div>`;
}

let apcDraw = null; // 추첨 연출 진행
function openApc(fresh = false) {
  if (!userSetup.colorId) { openClubSetup(true); return; }
  apcOpp = null;
  fkMode = false; inPens = false;
  phase = 'apc';
  clockPaused = true;
  overlay.classList.remove('show');
  showMenuPanel('apc');
  if (fresh || !userSetup.apc) newApc();
  const A = userSetup.apc;
  A.teams.find(t => t.user).name = teamName(true);
  if (!A.drawn) startApcDraw();
  else renderApc();
}
function startApcDraw() {
  apcDraw = { n: 0 };
  renderApc();
  const tick = () => {
    if (!apcDraw || phase !== 'apc') return;
    apcDraw.n++;
    renderApc();
    if (apcDraw.n >= 8) {
      setTimeout(() => {
        if (!userSetup.apc) return;
        userSetup.apc.drawn = true; apcDraw = null; saveSetup(); renderApc();
      }, 700);
      return;
    }
    apcDraw.t = setTimeout(tick, 650);
  };
  apcDraw.t = setTimeout(tick, 900);
}
function skipApcDraw() {
  if (!apcDraw) return;
  clearTimeout(apcDraw.t);
  apcDraw = null;
  userSetup.apc.drawn = true;
  saveSetup();
  renderApc();
}
function renderApc() {
  const el = $('apc-body');
  const A = userSetup.apc;
  if (!el || !A) return;
  const shown = apcDraw ? apcDraw.n : 8;
  const team = (idx, slotOrder, res, side) => {
    if (idx == null || (slotOrder != null && slotOrder >= shown)) return `<div class="apc-team empty">${apcDraw && slotOrder === shown ? '<span class="drawing">추첨 중…</span>' : '?'}</div>`;
    const t = A.teams[idx], c = colorById(t.colorId);
    const lost = res && res.w !== idx;
    const g = res ? (side === 'a' ? res.ga : res.gb) : '';
    const pk = res?.pk ? `<small>(${side === 'a' ? res.pk[0] : res.pk[1]})</small>` : '';
    const justDrawn = apcDraw && slotOrder === shown - 1;
    return `<div class="apc-team ${t.user ? 'me' : ''} ${lost ? 'lost' : ''} ${res && !lost ? 'won' : ''} ${justDrawn ? 'pop' : ''}">
      <i class="kit" style="background:${c.css}"></i><span class="nm">${escapeHtml(t.name)}</span><span class="ov">${t.base}${t.enh ? `<small class="apc-enh">${t.enh}강</small>` : ""}</span><b class="sc">${g}${pk}</b></div>`;
  };
  const col = (r, title) => {
    const ent = r === 0 ? A.slots : (A.res[r - 1] || []).map(m => m?.w);
    const n = [4, 2, 1][r];
    let h = `<div class="apc-col r${r}"><div class="apc-rt">${title}</div>`;
    for (let m = 0; m < n; m++) {
      const res = A.res[r]?.[m];
      h += `<div class="apc-match">${team(ent[m * 2], r === 0 ? m * 2 : null, res, 'a')}${team(ent[m * 2 + 1], r === 0 ? m * 2 + 1 : null, res, 'b')}</div>`;
    }
    return h + '</div>';
  };
  const champ = A.champ != null ? A.teams[A.champ] : null;
  const champHtml = `<div class="apc-col champ"><div class="apc-rt">우승</div><div class="apc-cup ${champ ? 'has' : ''}">🏆${champ ? `<b style="color:${colorById(champ.colorId).css}">${escapeHtml(champ.name)}</b>` : '<span>?</span>'}</div></div>`;
  el.innerHTML = `<div class="apc-bracket">${col(0, '8강')}${col(1, '4강')}${col(2, '결승')}${champHtml}</div>`;
  // 안내 · 버튼
  const msg = $('apc-msg'), go = $('btn-apc-go');
  const um = A.champ == null && !A.out ? apcUserMatch(A.round) : null;
  const rn = ['8강', '4강', '결승'][A.round];
  if (apcDraw) { msg.textContent = `대진 추첨 중… ${Math.min(8, apcDraw.n)}/8`; go.textContent = '추첨 건너뛰기'; go.dataset.act = 'skip'; }
  else if ((A.champ != null || A.out) && !A.settled && !(A.prize && A.settled == null)) {
    const st = A.champ != null && champ.user ? 3 : (A.outRound ?? 0);
    msg.innerHTML = A.champ != null && champ.user ? '🏆 <b>APC 에펙컵 우승!</b> 결산하기를 눌러 우승 세리머니와 보상을 받으세요' : `<b>${APC_STAGE[st]}</b> — 결산하기를 누르면 남은 경기를 마치고 보상을 받아요`;
    go.textContent = '🏆 결산하기'; go.dataset.act = 'settle';
  } else if (A.champ != null) {
    msg.innerHTML = `${A.prize ? `결산 완료 · <b>${APC_STAGE[A.prize.stage]}</b> +${A.prize.coins.toLocaleString()} A코인 · ` : ''}우승: <b>${escapeHtml(champ.name)}</b>`;
    go.textContent = '새 대회 시작'; go.dataset.act = 'new';
  } else if (A.out) { msg.innerHTML = '<b>탈락</b>'; go.textContent = '새 대회 시작'; go.dataset.act = 'new'; }
  else if (um) {
    const o = A.teams[um.opp];
    msg.innerHTML = `${rn} 상대: <b style="color:${colorById(o.colorId).css}">${escapeHtml(o.name)}</b> · 능력치 ${o.base}`;
    go.textContent = `${rn} 진행`; go.dataset.act = 'play';
  }
  const coin = $('apc-coin');
  if (coin) coin.textContent = (userSetup.coins || 0).toLocaleString();
}
function apcGo() {
  const act = $('btn-apc-go')?.dataset.act;
  if (act === 'skip') skipApcDraw();
  else if (act === 'new') openApc(true);
  else if (act === 'rest') apcFinishAll();
  else if (act === 'settle') apcSettle();
  else if (act === 'play') startApcMatch();
}
function startApcMatch() {
  const A = userSetup.apc;
  const um = apcUserMatch(A.round);
  if (!um) return;
  const o = A.teams[um.opp];
  apcOpp = { kind: 'apc', name: o.name, colorId: o.colorId, base: o.base, iq: apcIQ(o.base), enh: o.enh, tr: o.tr };
  userSetup.oppColorId = o.colorId;
  const forms = Object.keys(FORMATIONS);
  userSetup.cpuFormation = forms[Math.floor(Math.random() * forms.length)];
  if (menuRoot) menuRoot.classList.remove('show');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  resetMatch();
  startPreMatch();
}
$('btn-apc-go')?.addEventListener('click', apcGo);
$('btn-apc-back')?.addEventListener('click', () => { skipApcDraw(); showTitleMenu(); });
function pkMode() {
  startMatchFromMenu();
  pkOnly = true;
  startPenaltyShootout();
}

/** 메뉴 화면 전환 (각 화면은 하나씩만) */
function showMenuPanel(which) {
  // 안전장치: 확인 창을 거치지 않고 라인업 화면을 떠나면 저장 안 한 변경은 되돌림
  if (which !== 'squad' && squadEdit) { if (squadDirty()) squadRevert(); squadEdit = null; }
  const panels = { intro: $('menu-intro'), login: $('menu-login'), team: menuTeam, title: menuTitle, league: $('menu-league'), squad: menuSquad, apc: $('menu-apc'), train: $('menu-train'), shop: $('menu-shop'), items: $('menu-items'), pm: $('menu-pm'), club: $('menu-club'), market: $('menu-market'), store: $('menu-store'), tactics: $('menu-tactics') };
  for (const [k, el] of Object.entries(panels)) if (el) el.style.display = k === which ? '' : 'none';
  panelEnter(panels[which]);
  if (menuRoot) {
    menuRoot.classList.add('show');
    menuRoot.classList.toggle('dim', which === 'team' || which === 'league' || which === 'squad' || which === 'apc' || which === 'train' || which === 'shop' || which === 'items' || which === 'pm' || which === 'club' || which === 'market' || which === 'store' || which === 'tactics');
    const tab = { title: 'title', pm: 'pm', train: 'pm', squad: 'squad', shop: 'shop', items: 'items', store: 'store', team: 'team', club: 'team', market: 'market', tactics: 'tactics' }[which];
    menuRoot.classList.toggle('tabs', !!tab && !(which === 'team' && clubFirst));
    document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  }
  setMatchHudVisible(false);
  setpieceHint.style.display = 'none';
  if (setpieceUi) setpieceUi.classList.remove('show');
  overlay.classList.remove('show');
  document.querySelectorAll('.navbar button').forEach(b => b.classList.toggle('on', b.dataset.go === 'title'));
}

// ===== 이적시장 (선수 정보 · 능력치 보기) =====
// ----- 이적시장 = 선수 도감: 모든 선수(8구단 160명 + 이적시장 30명) 검색 · 정보 보기 -----
let mktUi = { f: 'all', club: 'all', q: '', sort: 'ovr', own: false };
const MKT_GROUPS = { all: ['전체', null], fw: ['공격', ['ST', 'LW', 'RW']], mf: ['미드필더', ['CAM', 'CM', 'CDM']], df: ['수비', ['CB', 'LB', 'RB']], gk: ['골키퍼', ['GK']] };
const ownedCount = tid => (ensureRoster(), userSetup.roster.filter(c => c.tid === tid).length);
function openMarket() {
  ensureInv();
  phase = 'market';
  showMenuPanel('market');
  renderMarket();
}
function dexCard(T, cls = '') {
  return `<div class="fc ${cls}"><span class="fc-glow"></span><span class="fc-ovr">${T.ovr}</span><span class="fc-pos">${T.pos}</span>
    <img class="fc-face" src="${FACE_CARD}" alt=""><span class="fc-no e1">1</span>
    <span class="fc-bot"><span class="fc-bs">BS</span><span class="fc-nm">${escapeHtml(T.name)}</span></span></div>`;
}
function marketList() {
  const g = MKT_GROUPS[mktUi.f][1], q = mktUi.q.trim().toLowerCase();
  return playerDb().filter(T => (!g || g.includes(T.pos)) && (mktUi.club === 'all' || (mktUi.club === 'fa' ? !T.club : T.club === mktUi.club))
      && (!q || T.name.toLowerCase().includes(q) || T.nation.includes(q) || T.pos.toLowerCase() === q) && (!mktUi.own || ownedCount(T.tid)))
    .sort((a, b) => mktUi.sort === 'age' ? a.age - b.age : mktUi.sort === 'name' ? a.name.localeCompare(b.name, 'ko') : b.ovr - a.ovr || a.tid - b.tid);
}
function renderMarket(keepFocus = false) {
  const el = $('market-body');
  if (!el) return;
  const list = marketList();
  const total = playerDb().length, ownKinds = new Set(ensureRoster().map(c => c.tid)).size;
  const clubs = [['all', '전체 구단'], ...TEAM_COLORS.map(c => [c.id, clubName(c.id)]), ['fa', '자유계약(이적시장)']];
  el.innerHTML = `<div class="dx-top">
      <div class="dx-search"><input id="dx-q" type="search" placeholder="선수 이름 · 국적 · 포지션 검색" value="${escapeHtml(mktUi.q)}"></div>
      <select id="dx-club">${clubs.map(([k, n]) => `<option value="${k}" ${mktUi.club === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label class="dx-own"><input type="checkbox" id="dx-own" ${mktUi.own ? 'checked' : ''}> 보유한 선수만</label>
      <span class="dx-prog">도감 수집 <b>${ownKinds}</b> / ${total}</span>
    </div>
    <div class="mk-bar">${Object.entries(MKT_GROUPS).map(([k, [n]]) => `<button type="button" class="chip ${mktUi.f === k ? 'active' : ''}" data-f="${k}">${n}</button>`).join('')}
      <span class="mk-sp"></span><span class="mk-sl">${list.length}명 · 정렬</span>${[['ovr', '오버롤'], ['age', '나이'], ['name', '이름']].map(([k, n]) => `<button type="button" class="chip ${mktUi.sort === k ? 'active' : ''}" data-s="${k}">${n}</button>`).join('')}</div>
    <div class="dx-grid">${list.map(T => { const n = ownedCount(T.tid); return `<button type="button" class="dx-item ${n ? 'own' : 'none'}" data-id="${T.tid}">${dexCard(T)}<span class="dx-meta"><b>${escapeHtml(T.name)}</b><small>${T.nation} · ${clubName(T.club)}</small></span>${n ? `<span class="dx-own-b">보유 ${n}</span>` : ''}</button>`; }).join('') || '<div class="dx-empty">검색 결과가 없어요</div>'}</div>`;
  const qi = $('dx-q');
  qi?.addEventListener('input', () => { mktUi.q = qi.value; renderMarket(true); });
  if (keepFocus && qi) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
  $('dx-club')?.addEventListener('change', e => { mktUi.club = e.target.value; renderMarket(); });
  $('dx-own')?.addEventListener('change', e => { mktUi.own = e.target.checked; renderMarket(); });
  el.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { mktUi.f = b.dataset.f; renderMarket(); }));
  el.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => { mktUi.sort = b.dataset.s; renderMarket(); }));
  el.querySelectorAll('.dx-item').forEach(b => b.addEventListener('click', () => openMarketInfo(Number(b.dataset.id))));
}
function openMarketInfo(id) {
  const el = $('pinfo');
  const m = tplOf(id);
  if (!el || !m) return;
  const keySet = new Set(posKeys(m.pos));
  const cols = FO_COLS.map(col => col.filter(k => pdTab === 'all' || keySet.has(k))).filter(c => c.length);
  const statCols = cols.map(col => `<div class="pdc">${col.map(k => `<div class="pdc-r ${keySet.has(k) ? 'key' : ''}"><span>${FO_LABEL[k]}</span><b style="color:${statColor(m.fo[k])}">${m.fo[k]}</b></div>`).join('')}</div>`).join('');
  const info = [['소속', clubName(m.club)], ['국적', m.nation], ['나이', `${m.age}세`], ['키', `${m.height}cm`], ['몸무게', `${m.weight}kg`], ['주발', m.foot === 'left' ? '왼발' : '오른발'], ['카드', `${CARD_TYPE} ${CARD_SEASON}`], ['보유', `${ownedCount(m.tid)}장`]];
  el.innerHTML = `<div class="pd-box">
    <button type="button" class="pd-x" id="pd-x">✕</button>
    <div class="pd-l">${dexCard(m, 'big')}<div class="mk-info">${info.map(([a, b]) => `<div><small>${a}</small><b>${b}</b></div>`).join('')}</div></div>
    <div class="pd-r">
      <div class="pd-head">${badgeHtml()}<span class="nm">${escapeHtml(m.name)}</span><span style="color:#94a3b8;font-weight:700">선수 도감 · No.${String(m.tid + 1).padStart(3, '0')}</span><span class="ps">${m.pos}</span></div>
      <div class="pd-grp">${foGroups(m.fo, m.pos === 'GK').map(([n, v]) => `<div><small>${n}</small><b>${v}</b></div>`).join('')}</div>
      <div class="pd-tabs"><button type="button" data-t="all" class="${pdTab === 'all' ? 'on' : ''}">총 능력치</button><button type="button" data-t="pos" class="${pdTab === 'pos' ? 'on' : ''}">${m.pos} · 오버롤 ${m.ovr}</button></div>
      <div class="pd-stats"><div class="pdc-wrap">${statCols}</div></div>
      <div class="pd-btns"><button type="button" class="btn ghost" id="pd-close">닫기</button></div>
    </div></div>`;
  el.classList.add('show');
  const close = () => el.classList.remove('show');
  $('pd-x')?.addEventListener('click', close);
  $('pd-close')?.addEventListener('click', close);
  el.querySelectorAll('.pd-tabs button').forEach(b => b.addEventListener('click', () => { pdTab = b.dataset.t; openMarketInfo(id); }));
}

// ----- 보관함: 라인업(선발 · 교체 · 후보) 밖의 선수 카드 + 아이템 -----
let storeUi = { sel: null, sort: 'ovr', f: 'all', ovr: 'all', q: '', rel: false, pick: new Set() };
const RES_MAX = 10; // 후보 최대 인원
const ST_OVR = { all: ['전체', 0, 999], lo: ['~59', 0, 59], m6: ['60~69', 60, 69], m7: ['70~79', 70, 79], hi: ['80+', 80, 999] };
function openStore() {
  ensureInv();
  phase = 'store';
  showMenuPanel('store');
  renderStore();
}
function renderStore(keepFocus = false) {
  const el = $('store-body');
  if (!el) return;
  const g = MKT_GROUPS[storeUi.f]?.[1], [, lo, hi] = ST_OVR[storeUi.ovr] || ST_OVR.all, q = storeUi.q.trim().toLowerCase();
  const total = storageList().length;
  const list = storageList().map(r => ({ r, s: rStats(r) }))
    .filter(({ r, s }) => (!g || g.includes(posOf(r))) && s.ovr >= lo && s.ovr <= hi && (!q || pname(r).toLowerCase().includes(q)))
    .sort((a, b) => storeUi.sort === 'pos' ? a.s.nat.localeCompare(b.s.nat) || b.s.ovr - a.s.ovr : storeUi.sort === 'name' ? pname(a.r).localeCompare(pname(b.r), 'ko') : b.s.ovr - a.s.ovr);
  for (const r of [...storeUi.pick]) if (inSquad(r) || r >= userSetup.roster.length) storeUi.pick.delete(r);
  if (storeUi.sel != null && !list.some(x => x.r === storeUi.sel)) storeUi.sel = null;
  const sel = storeUi.sel, rel = storeUi.rel, L = userSetup.lineup;
  const side = rel
    ? `<div class="st-rel"><div class="st-rel-h">선수 방출</div><p>방출할 카드를 눌러 여러 장 고르세요. 방출한 카드는 사라지고 되돌릴 수 없어요.</p>
        <div class="st-rel-n">선택 <b>${storeUi.pick.size}</b>장</div>
        <div class="st-btns"><button type="button" class="btn ghost" id="st-all">보이는 카드 전체 선택 (${list.length})</button><button type="button" class="btn ghost" id="st-none">선택 해제</button>
        <button type="button" class="btn danger-b" id="st-release" ${storeUi.pick.size ? '' : 'disabled'}>선택한 ${storeUi.pick.size}장 방출</button><button type="button" class="btn ghost" id="st-rel-x">방출 모드 끝내기</button></div></div>`
    : sel == null ? '<div class="st-empty">카드를 눌러 보세요.<br>상점의 <b>BS 랜덤 선수팩</b>에서 뽑은 선수가 여기에 모여요.<br><br>같은 선수 · 시즌 · 종류 카드는 <b>한계 돌파</b> 재료로 쓸 수 있어요.</div>'
    : (() => { const s = rStats(sel); return `<div class="st-sel">${fcCard(sel, s, 'big')}<div class="st-nm">${escapeHtml(pname(sel))}</div><div class="st-sub">${s.nat} · OVR ${s.ovr} · ${enhLv(s.t)}강 · 돌파 ${lbCount(s.t)}/${LB_MAX}</div>
        <div class="st-btns"><button type="button" class="btn" id="st-info">상세 정보</button><button type="button" class="btn" id="st-pm">선수 관리</button><button type="button" class="btn" id="st-in">라인업에 넣기</button><button type="button" class="btn ghost" id="st-res" ${L.res.length >= RES_MAX ? 'disabled' : ''}>후보로 추가 (${L.res.length}/${RES_MAX})</button></div></div>`; })();
  const chips = (obj, key, attr) => Object.entries(obj).map(([k, v]) => `<button type="button" class="chip ${storeUi[key] === k ? 'active' : ''}" data-${attr}="${k}">${Array.isArray(v) ? v[0] : v}</button>`).join('');
  el.innerHTML = `<div class="st-wrap"><div class="st-left">
      <div class="mk-bar"><span class="st-count">보관 중 <b>${total}</b>장${list.length !== total ? ` · 표시 ${list.length}` : ''}</span><input class="mk-q" id="st-q" placeholder="이름 검색" value="${escapeHtml(storeUi.q)}"><span class="mk-sp"></span><button type="button" class="btn ${rel ? '' : 'ghost'} st-relbtn" id="st-rel">${rel ? '방출 모드 ON' : '선수 방출'}</button></div>
      <div class="mk-bar st-fbar"><span class="mk-sl">포지션</span>${chips(MKT_GROUPS, 'f', 'f')}<span class="mk-sl">오버롤</span>${chips(ST_OVR, 'ovr', 'o')}<span class="mk-sp"></span><span class="mk-sl">정렬</span>${[['ovr', '오버롤'], ['pos', '포지션'], ['name', '이름']].map(([k, n]) => `<button type="button" class="chip ${storeUi.sort === k ? 'active' : ''}" data-s="${k}">${n}</button>`).join('')}</div>
      <div class="st-grid ${rel ? 'rel' : ''}">${list.map(({ r, s }) => `<button type="button" class="st-item ${rel ? (storeUi.pick.has(r) ? 'pk' : '') : sel === r ? 'on' : ''}" data-r="${r}">${fcCard(r, s)}${rel ? `<i class="st-chk">${storeUi.pick.has(r) ? '✓' : ''}</i>` : ''}</button>`).join('') || '<div class="dx-empty">조건에 맞는 카드가 없어요</div>'}</div>
    </div><div class="st-side">${side}</div></div>`;
  el.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => { storeUi.sort = b.dataset.s; renderStore(); }));
  el.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { storeUi.f = b.dataset.f; renderStore(); }));
  el.querySelectorAll('[data-o]').forEach(b => b.addEventListener('click', () => { storeUi.ovr = b.dataset.o; renderStore(); }));
  const qi = $('st-q');
  qi?.addEventListener('input', () => { storeUi.q = qi.value; renderStore(true); });
  qi?.addEventListener('keydown', e => e.stopPropagation());
  if (keepFocus && qi) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
  el.querySelectorAll('.st-item').forEach(b => b.addEventListener('click', () => {
    const r = Number(b.dataset.r);
    if (storeUi.rel) { if (storeUi.pick.has(r)) storeUi.pick.delete(r); else storeUi.pick.add(r); }
    else storeUi.sel = r;
    renderStore();
  }));
  $('st-rel')?.addEventListener('click', () => { storeUi.rel = !storeUi.rel; storeUi.pick.clear(); renderStore(); });
  $('st-rel-x')?.addEventListener('click', () => { storeUi.rel = false; storeUi.pick.clear(); renderStore(); });
  $('st-all')?.addEventListener('click', () => { list.forEach(x => storeUi.pick.add(x.r)); renderStore(); });
  $('st-none')?.addEventListener('click', () => { storeUi.pick.clear(); renderStore(); });
  $('st-release')?.addEventListener('click', storeReleaseConfirm);
  $('st-info')?.addEventListener('click', () => openPlayerInfo(sel));
  $('st-pm')?.addEventListener('click', () => openPlayerMenu(sel));
  $('st-in')?.addEventListener('click', () => storeToLineup(sel));
  $('st-res')?.addEventListener('click', () => {
    if (userSetup.lineup.res.length >= RES_MAX) { toast(`후보는 최대 ${RES_MAX}명이에요`); return; }
    userSetup.lineup.res.push(sel); storeUi.sel = null; saveSetup(); toast(`${pname(sel)} → 후보 (${userSetup.lineup.res.length}/${RES_MAX})`); renderStore();
  });
}
/** 방출 확인 → 카드 삭제 (강화 · 훈련된 카드가 섞여 있으면 경고) */
function storeReleaseConfirm() {
  const rs = [...storeUi.pick].filter(r => !inSquad(r));
  if (!rs.length) return;
  const grown = rs.filter(r => { const t = userSetup.train[r]; return enhLv(t) > 1 || t.lv > 0 || lbCount(t) > 0 || Object.keys(t.sp || {}).length; }).length;
  const el = $('sq-confirm');
  el.innerHTML = `<div class="sqc-box"><div class="sqc-h">선수 ${rs.length}명 방출</div>
    <p>선택한 카드 <b>${rs.length}장</b>이 사라집니다. 되돌릴 수 없어요.${grown ? `<br><b style="color:#f87171">훈련 · 강화 · 한계 돌파한 카드 ${grown}장이 포함돼 있어요!</b>` : ''}</p>
    <div class="sqc-btns"><button type="button" class="btn ghost" id="rel-no">취소</button><button type="button" class="btn" id="rel-yes">방출</button></div></div>`;
  el.classList.add('show');
  $('rel-no')?.addEventListener('click', () => el.classList.remove('show'));
  $('rel-yes')?.addEventListener('click', () => {
    el.classList.remove('show');
    removeCards(rs);
    storeUi.pick.clear(); storeUi.sel = null;
    saveSetup();
    toast(`🗑 ${rs.length}명 방출 완료`);
    renderStore();
  });
}
/** 보관함 카드를 라인업의 한 자리와 맞바꿈 (바뀐 선수는 보관함으로) */
function storeToLineup(r) {
  const el = $('sq-confirm');
  if (!el) return;
  const L = (ensureRoster(), userSetup.lineup);
  const slots = getFormationSlots(userSetup.formation);
  const row = (kind, k, rr, label) => `<button type="button" class="sqp-row${gkSwapOk(`${kind}:${k}`, rr, 'store:0', r) ? '' : ' no'}" data-k="${kind}:${k}"><span class="pos">${label}</span><span>${escapeHtml(pname(rr))}</span><span class="nat">${posOf(rr)}</span><b>${statsOf(rr).ovr}</b></button>`;
  el.innerHTML = `<div class="sqc-box wide"><div class="sqc-h">${escapeHtml(pname(r))}와(과) 바꿀 선수</div>
    <div class="sqp-list">${L.xi.map((rr, k) => row('xi', k, rr, slots[k].label)).join('')}${L.subs.map((rr, k) => row('subs', k, rr, 'SUB')).join('')}${L.res.map((rr, k) => row('res', k, rr, 'RES')).join('')}</div>
    <div class="sqc-btns"><button type="button" class="btn ghost" id="sqp-x">취소</button></div></div>`;
  el.classList.add('show');
  $('sqp-x')?.addEventListener('click', () => el.classList.remove('show'));
  el.querySelectorAll('.sqp-row').forEach(b => b.addEventListener('click', () => {
    const [kind, k] = b.dataset.k.split(':');
    const out = L[kind][+k];
    if (!gkSwapOk(b.dataset.k, out, 'store:0', r)) { toast('🧤 골키퍼 자리는 골키퍼끼리만 바꿀 수 있어요'); return; }
    L[kind][+k] = r;
    saveSetup();
    el.classList.remove('show');
    storeUi.sel = out;
    toast(`🔁 ${pname(r)} → 라인업 · ${pname(out)} → 보관함`);
    renderStore();
  }));
}

// ----- 전술: 포메이션 · 수비/공격 스타일 · 선수별 역할 -----
function openTactics() {
  ensureInv();
  ensureTactics();
  phase = 'tactics';
  showMenuPanel('tactics');
  renderTactics();
}
// 축구판 위 카드 위치(라인업 · 전술 공용) — 줄마다 고르게
function pitchLayout(slots) {
  const rowsX = [];
  for (const f of [...slots].sort((a, b) => a.ox - b.ox)) if (!rowsX.length || f.ox - rowsX[rowsX.length - 1] > 3.5) rowsX.push(f.ox);
  const rowOf = ox => rowsX.reduce((bi, v, k) => (Math.abs(v - ox) < Math.abs(rowsX[bi] - ox) ? k : bi), 0);
  return slots.map(f => ({ x: 50 + f.oz * 42, y: 85 - rowOf(f.ox) * (70 / Math.max(1, rowsX.length - 1)) }));
}
const PITCH_LINES = '<div class="sq-lines"><i class="box"></i><i class="six"></i><i class="arc"></i><i class="half"></i></div>';
const tacUi = { sel: 10 };
function renderTactics() {
  const el = $('tactics-body');
  if (!el) return;
  const T = ensureTactics();
  const slots = getFormationSlots(userSetup.formation);
  if (tacUi.sel >= slots.length) tacUi.sel = 0;
  const opt = (list, cur, key) => list.map(x => `<button type="button" class="tc-opt ${cur === x.id ? 'on' : ''}" data-${key}="${x.id}"><b>${x.name}</b><small>${x.desc}</small></button>`).join('');
  const pos = pitchLayout(slots);
  const cards = slots.map((f, i) => {
    const s = slotStats(i), role = TAC_ROLE_BY_ID[tacRoleOf(i)] || {};
    return `<button type="button" class="sq-card tc-card${tacUi.sel === i ? ' active' : ''}" data-i="${i}" style="left:${pos[i].x}%;top:${pos[i].y}%">${fcCard(i, s)}<span class="tc-rb">${role.name || '-'}</span></button>`;
  }).join('');
  const si = tacUi.sel, sf = slots[si], list = TAC_ROLES[roleGroup(sf.position)] || [], cur = tacRoleOf(si);
  const roleList = slots.map((f, i) => `<button type="button" class="tc-mini ${i === si ? 'on' : ''}" data-i="${i}"><span class="pos">${f.label}</span><span class="nm">${escapeHtml(pname(xiR(i)))}</span><b>${(TAC_ROLE_BY_ID[tacRoleOf(i)] || {}).name || '-'}</b></button>`).join('');
  el.innerHTML = `<div class="tc-wrap3">
    <div class="tc-col">
      <div class="tc-h">포메이션</div>
      <div class="tc-forms">${Object.keys(FORMATIONS).map(f => `<button type="button" class="chip ${userSetup.formation === f ? 'active' : ''}" data-fm="${f}">${f}</button>`).join('')}</div>
      <div class="tc-h">수비 스타일</div><div class="tc-opts">${opt(DEF_STYLES, T.def, 'def')}</div>
      <div class="tc-h">공격 스타일</div><div class="tc-opts">${opt(ATK_STYLES, T.atk, 'atk')}</div>
    </div>
    <div class="tc-pitchwrap"><div class="sq-pitch tc-pitch">${PITCH_LINES}${cards}</div></div>
    <div class="tc-col">
      <div class="tc-h">${sf.label} · ${escapeHtml(pname(xiR(si)))} <small>역할 선택</small></div>
      <div class="tc-opts one">${list.map(x => `<button type="button" class="tc-opt ${x.id === cur ? 'on' : ''}" data-role="${x.id}"><b>${x.name}</b><small>${x.desc}</small></button>`).join('')}</div>
      <div class="tc-h">선발 11명 역할 <small>눌러서 선수 선택</small></div>
      <div class="tc-minis">${roleList}</div>
    </div>
  </div>`;
  el.querySelectorAll('[data-fm]').forEach(b => b.addEventListener('click', () => { userSetup.formation = b.dataset.fm; activeFormation = userSetup.formation; saveSetup(); renderTactics(); toast(`포메이션 ${userSetup.formation}`); }));
  el.querySelectorAll('[data-def]').forEach(b => b.addEventListener('click', () => { T.def = b.dataset.def; saveSetup(); renderTactics(); }));
  el.querySelectorAll('[data-atk]').forEach(b => b.addEventListener('click', () => { T.atk = b.dataset.atk; saveSetup(); renderTactics(); }));
  el.querySelectorAll('.tc-card, .tc-mini').forEach(b => b.addEventListener('click', () => { tacUi.sel = Number(b.dataset.i); renderTactics(); }));
  el.querySelectorAll('[data-role]').forEach(b => b.addEventListener('click', () => { T.roles[si] = b.dataset.role; saveSetup(); renderTactics(); }));
}

function goMenu(where) {
  if (where !== 'squad' && where !== 'guide' && where !== 'settings' && phase === 'squad_setup' && squadDirty()) { leaveSquad(() => goMenu(where)); return; }
  if (where !== 'squad' && where !== 'guide' && where !== 'settings' && phase === 'squad_setup') squadEdit = null;
  if (where === 'market') { openMarket(); return; }
  if (where === 'store') { openStore(); return; }
  if (where === 'tactics') { openTactics(); return; }
  if (where === 'guide') { $('guide')?.classList.add('show'); return; }
  if (where === 'team') { openClubInfo(); return; }
  if (where === 'squad') { openSquadSetup(); return; }
  if (where === 'training') { openTraining(); return; }
  if (where === 'pm') { openPlayerMgmt(); return; }
  if (where === 'shop') { openShop(); return; }
  if (where === 'items') { openItems(); return; }
  if (where === 'settings') { openSettings(); return; }
  showTitleMenu();
}

// ===== 인트로 → 로그인 → (처음이면) 구단 창단 → 로비 =====
function showIntro() {
  phase = 'intro';
  clockPaused = true;
  showMenuPanel('intro');
  setupLobbyScene();
}

function showLogin() {
  phase = 'login';
  showMenuPanel('login');
  const idIn = $('login-id');
  if (idIn) {
    idIn.value = lastUserId() || '';
    setTimeout(() => (idIn.value ? $('login-pw') : idIn)?.focus?.(), 50);
  }
  if ($('login-pw')) $('login-pw').value = '';
  setLoginMsg('');
}

function setLoginMsg(t, ok = false) {
  const m = $('login-msg');
  if (!m) return;
  m.textContent = t;
  m.classList.toggle('ok', ok);
}

function submitLogin(register) {
  const id = ($('login-id')?.value || '').trim();
  const pw = $('login-pw')?.value || '';
  const r = register ? registerAccount(id, pw) : loginAccount(id, pw);
  if (!r.ok) { setLoginMsg(r.msg); return; }
  rebuildTeamsFromSetup();
  if (!userSetup.colorId) openClubSetup(true);
  else showTitleMenu();
}

function logout() {
  currentUser = null;
  resetUserSetup();
  rebuildTeamsFromSetup();
  showLogin();
}

let clubFirst = false;
function openClubSetup(first) {
  clubFirst = !!first;
  phase = 'club_setup';
  showMenuPanel('team');
  const nameIn = $('club-name-input');
  if (nameIn) nameIn.value = userSetup.clubName || '';
  const t = $('club-setup-title');
  if (t) t.textContent = first ? '구단 창단' : '구단 관리';
  const save = $('btn-club-save');
  if (save) save.textContent = first ? '구단 창단' : '저장';
  const back = $('btn-team-back');
  if (back) back.style.visibility = first ? 'hidden' : 'visible';
  if (back) back.textContent = '구단 관리로';
  renderColorGrid();
}

function updateClubPreview() {
  const c = colorById(userSetup.colorId || 'blue');
  const name = (($('club-name-input')?.value || '').trim()) || `${c.name} FC`;
  const svg = $('club-crest-preview');
  if (svg) svg.innerHTML = crestSvg(userSetup.colorId ? c.css : '#334155', escapeHtml(name.slice(0, 1)));
  const n = $('club-name-preview');
  if (n) n.textContent = name;
  const save = $('btn-club-save');
  if (save) save.disabled = !userSetup.colorId;
  renderClubRosterPreview();
}
/** 구단 창단: 고른 팀 컬러 구단의 기본 선수 20명 · 선발 평균 오버롤 미리 보기 */
function renderClubRosterPreview() {
  const el = $('club-roster-preview');
  if (!el) return;
  if (!clubFirst) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = '';
  if (!userSetup.colorId) { el.innerHTML = '<div class="crp-empty">팀 컬러를 고르면 그 구단의 기본 선수 20명이 보여요</div>'; return; }
  const club = clubPlayers(userSetup.colorId);
  const xi = club.filter(t => t.grp === 'xi');
  const avg = Math.round(xi.reduce((a, t) => a + t.ovr, 0) / Math.max(1, xi.length));
  const grp = (title, g) => `<div class="crp-g">${title}</div>${club.filter(t => t.grp === g).map(t => `<div class="crp-r"><span class="pos">${t.pos}</span><span class="nm">${escapeHtml(t.name)}</span><small>${escapeHtml(t.nation)}</small><b>${t.ovr}</b></div>`).join('')}`;
  el.innerHTML = `<div class="crp-h"><span>기본 선수 ${club.length}명</span><span>선발 평균 <b>${avg}</b></span></div><div class="crp-list">${grp('선발', 'xi')}${grp('교체', 'subs')}${grp('후보', 'res')}</div>`;
}

function saveClub() {
  if (!userSetup.colorId) return;
  const name = (($('club-name-input')?.value || '').trim()).slice(0, 14);
  userSetup.clubName = name || `${colorById(userSetup.colorId).name} FC`;
  userSetup.oppColorId = pickOppColor(userSetup.colorId);
  if (clubFirst) { userSetup.rosterV = 0; ensureRoster(); } // 창단: 고른 팀 컬러 구단 선수 20명으로 시작
  saveSetup();
  rebuildTeamsFromSetup();
  if (clubFirst) showTitleMenu(); else openClubInfo();
}

$('btn-resume')?.addEventListener('click', () => setPaused(false));
$('btn-pause-guide')?.addEventListener('click', () => $('guide')?.classList.add('show'));
$('btn-abort')?.addEventListener('click', () => { $('pause-main').style.display = 'none'; $('pause-confirm').style.display = 'block'; });
$('btn-abort-no')?.addEventListener('click', () => { $('pause-main').style.display = 'block'; $('pause-confirm').style.display = 'none'; });
$('btn-abort-yes')?.addEventListener('click', abortMatch);
window.addEventListener('blur', () => { if (canPause() && !paused) setPaused(true); }); // 창을 벗어나면 자동 일시정지

function openSettings() {
  const el = $('settings');
  if (!el) return;
  for (const k of ['master', 'bgm', 'sfx', 'crowd']) {
    const inp = $('set-' + k);
    if (!inp) continue;
    inp.value = Math.round(settings[k] * 100);
    $('setv-' + k).textContent = inp.value;
  }
  const as = $('set-aspect'); if (as) as.value = ASPECTS[settings.aspect] || settings.aspect === 'fill' ? settings.aspect : '16:9';
  keyCapture = null; renderKeySettings(); showHeld();
  el.classList.add('show');
}
for (const k of ['master', 'bgm', 'sfx', 'crowd']) {
  $('set-' + k)?.addEventListener('input', e => {
    settings[k] = Number(e.target.value) / 100;
    $('setv-' + k).textContent = e.target.value;
    initAudio(); applyVolumes(); saveSettings();
  });
}
$('set-aspect')?.addEventListener('change', e => { settings.aspect = e.target.value; saveSettings(); applyAspect(); });
$('btn-set-close')?.addEventListener('click', () => $('settings')?.classList.remove('show'));
$('btn-set-test')?.addEventListener('click', () => { initAudio(); setTimeout(() => { sndKick(0.8); sndCheer(0.9); sndDrum(0.4, 0.7); sndDrum(0.9, 0.7); sndWhistle('short'); }, 50); });
$('btn-pause-settings')?.addEventListener('click', openSettings);

function showTitleMenu() {
  commStop();
  if (!currentUser) { showLogin(); return; }
  apcOpp = null;
  fkMode = false;
  inPens = false;
  phase = 'menu';
  clockPaused = true;
  thirdPersonCam = false;
  showMenuPanel('title');
  updateLobby();
  setupLobbyScene();
}

let lgView = 'pick'; // 'pick' = 리그 고르기 · 'season' = 고른 리그의 순위표 · 기록 · 라운드 진행
function openLeagueSelect(view) {
  lgView = view === 'season' || (typeof view !== 'string' && phase === 'ended') ? 'season' : 'pick';
  apcOpp = null;
  fkMode = false; inPens = false;
  phase = 'league_select';
  clockPaused = true;
  overlay.classList.remove('show');
  showMenuPanel('league');
  const S = userSetup.season;
  if (!S || S.leagueId !== userSetup.leagueId) newSeason();
  userSetup.season.teams.find(t => t.user).name = teamName(true);
  renderLeagueChips();
  renderSeason();
}

function openSquadSetup() {
  phase = 'squad_setup';
  if (!userSetup.boosts || userSetup.boosts.length !== 11) {
    userSetup.boosts = Array.from({ length: 11 }, () => emptyBoosts());
  }
  ensureRoster();
  // 라인업 편집 시작: 지금 라인업을 '저장된 상태'로 기억 → 저장하기 전까지는 바꾼 것이 확정되지 않음
  if (!squadEdit) squadEdit = { formation: userSetup.formation, lineup: JSON.parse(JSON.stringify(userSetup.lineup)) };
  if (!(squadUi.selR >= 0 && squadUi.selR < userSetup.roster.length)) squadUi.selR = userSetup.lineup.xi[0];
  squadUi.swapFrom = null;
  showMenuPanel('squad');
  renderFormationChips();
  renderPlayerList();
  renderStatEditor();
}

function renderColorGrid() {
  if (!colorGrid) return;
  colorGrid.innerHTML = '';
  for (const c of TEAM_COLORS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'color-card' + (userSetup.colorId === c.id ? ' selected' : '');
    card.innerHTML = `<div class="color-swatch" style="background:${c.css}"></div><span>${c.name}</span>`;
    card.addEventListener('click', () => {
      userSetup.colorId = c.id;
      renderColorGrid();
    });
    colorGrid.appendChild(card);
  }
  updateClubPreview();
}

function renderLeagueChips() {
  const box = $('league-chips');
  if (!box) return;
  const S = userSetup.season, busy = S && !S.done && S.round > 0;
  const pick = lgView === 'pick';
  box.style.display = pick ? '' : 'none';
  const sb = $('season-body'); if (sb) sb.style.display = pick ? 'none' : '';
  const play = $('btn-play-match'); if (play) play.style.display = pick ? 'none' : '';
  const rs = document.querySelector('#menu-league .league-reset'); if (rs) rs.style.visibility = pick ? 'hidden' : 'visible';
  const back = $('btn-league-back'); if (back) back.textContent = pick ? '로비로' : '리그 선택';
  const mp = document.querySelector('#menu-league .menu-p');
  if (mp) mp.innerHTML = pick ? `리그를 고르세요. 8개 구단이 홈·원정 두 번씩 맞붙는 14경기 시즌 · 높은 리그일수록 상대가 강하고 보상이 커요.${busy ? ` <b class="lg-busy">진행 중: ${escapeHtml(currentLeague().name)} ${S.round}/14</b>` : ''}` : '';
  if (!pick) return;
  box.innerHTML = LEAGUES.map(lg => {
    const cur = userSetup.leagueId === lg.id, locked = busy && !cur;
    return `<button type="button" class="league-card lg-${lg.tier} ${cur ? 'selected' : ''} ${locked ? 'locked' : ''}" data-lg="${lg.id}">
      ${leagueEmblem(lg)}<strong>${lg.tier === 'apl' ? '<span class="apl-name">APL</span><small class="apl-sub">Apex Premier League</small>' : lg.name}</strong>
      <span>상대 평균 OVR <b>${lg.base}</b></span><span class="lg-spec">${lg.enh}강 · 훈련 ${lg.tr} · 보상 ×${LEAGUE_MULT[LEAGUES.indexOf(lg)]}</span>${cur && busy ? '<i class="lg-now">진행 중</i>' : cur ? '<i class="lg-now">현재 리그</i>' : ''}</button>`;
  }).join('');
  box.querySelectorAll('[data-lg]').forEach(b => b.addEventListener('click', () => {
    const lg = leagueById(b.dataset.lg);
    if (busy && userSetup.leagueId !== lg.id) { toast('🔒 시즌이 끝날 때까지 다른 리그를 고를 수 없어요 (리그 화면 아래 「리그 초기화」)', 2600); return; }
    if (userSetup.leagueId !== lg.id || !userSetup.season || userSetup.season.leagueId !== lg.id) { userSetup.leagueId = lg.id; newSeason(); }
    lgView = 'season';
    renderLeagueChips();
    renderSeason();
    panelEnter($('menu-league'));
  }));
}

function renderFormationChips() {
  if (!formationChips) return;
  formationChips.innerHTML = '';
  for (const name of Object.keys(FORMATIONS)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (userSetup.formation === name ? ' active' : '');
    chip.textContent = name;
    chip.addEventListener('click', () => {
      userSetup.formation = name;
      activeFormation = name;
      squadChanged();
      renderFormationChips();
      renderPlayerList();
      renderStatEditor();
    });
    formationChips.appendChild(chip);
  }
}

/** 라인업: 반 코트에 선발 카드 · 오른쪽에 선발 / 교체 / 후보 목록. 카드 · 목록 줄을 마우스로 끌어다 놓으면 서로 자리 바꿈 */
let squadUi = { swapFrom: null, selR: 0 };
const PLACE_NAME = { xi: '선발', subs: '교체', res: '후보' };
const placeKey = r => { const pl = placeOf(r); return `${pl.kind}:${pl.idx}`; };
// ----- 라인업 저장 -----
let squadEdit = null; // { formation, lineup } = 마지막으로 저장된 라인업 (편집 중일 때만)
const squadDirty = () => !!squadEdit && (squadEdit.formation !== userSetup.formation || JSON.stringify(squadEdit.lineup) !== JSON.stringify(userSetup.lineup));
function squadChanged() { renderSquadSaveBar(); }
function renderSquadSaveBar() {
  const b = $('btn-squad-save'), m = $('sq-dirty');
  const d = squadDirty();
  if (b) b.disabled = !d;
  if (m) m.textContent = d ? '● 저장하지 않은 변경 사항이 있어요' : '';
}
function squadCommit() {
  if (!squadEdit) return;
  squadEdit = { formation: userSetup.formation, lineup: JSON.parse(JSON.stringify(userSetup.lineup)) };
  saveSetup();
  renderSquadSaveBar();
  toast('✅ 라인업을 저장했어요');
}
function squadRevert() {
  if (!squadEdit) return;
  userSetup.formation = squadEdit.formation;
  activeFormation = squadEdit.formation;
  userSetup.lineup = JSON.parse(JSON.stringify(squadEdit.lineup));
}
/** 라인업 화면에서 다른 곳으로 갈 때: 저장 안 한 변경이 있으면 물어봄 (머무르기 / 저장하고 나가기 / 저장 안 하고 나가기) */
function leaveSquad(next) {
  if (phase !== 'squad_setup' || !squadEdit) { next(); return; }
  if (!squadDirty()) { squadEdit = null; next(); return; }
  const el = $('sq-confirm');
  if (!el) { squadRevert(); squadEdit = null; next(); return; }
  el.innerHTML = `<div class="sqc-box"><div class="sqc-h">라인업이 저장되지 않았어요</div>
    <p>바꾼 라인업을 저장하지 않고 나가면 <b>원래 라인업</b>으로 돌아가요.<br>이 화면에 머무를까요?</p>
    <div class="sqc-btns"><button type="button" class="btn ghost" id="sqc-leave">저장 안 하고 나가기</button><button type="button" class="btn ghost" id="sqc-save">저장하고 나가기</button><button type="button" class="btn" id="sqc-stay">머무르기</button></div></div>`;
  el.classList.add('show');
  const close = () => el.classList.remove('show');
  $('sqc-stay')?.addEventListener('click', close);
  $('sqc-save')?.addEventListener('click', () => { close(); squadCommit(); squadEdit = null; next(); });
  $('sqc-leave')?.addEventListener('click', () => { close(); squadRevert(); squadEdit = null; toast('원래 라인업으로 돌아갔어요'); next(); });
}
/** 골키퍼 자리(선발 GK 칸)와 골키퍼 선수는 골키퍼끼리만 맞바꿈 */
function gkSlotKey(k) {
  const [a, ai] = k.split(':');
  return a === 'xi' && getFormationSlots(userSetup.formation)[+ai]?.position === 'GK';
}
function gkSwapOk(ka, ra, kb, rb) {
  const ga = posOf(ra) === 'GK', gb = posOf(rb) === 'GK';
  if (gkSlotKey(ka) || gkSlotKey(kb)) return ga && gb;
  // 필드 선발 칸에 골키퍼를 넣는 것도 막음
  if ((ka.startsWith('xi:') && gb) || (kb.startsWith('xi:') && ga)) return ga && gb;
  return true;
}
function swapPlaces(ka, kb) {
  if (!ka || !kb || ka === kb) return;
  const L = (ensureRoster(), userSetup.lineup);
  const [a, ai] = ka.split(':'), [b, bi] = kb.split(':');
  const ra = L[a][+ai], rb = L[b][+bi];
  if (ra == null || rb == null) return;
  if (!gkSwapOk(ka, ra, kb, rb)) { toast('🧤 골키퍼 자리는 골키퍼끼리만 바꿀 수 있어요'); return; }
  L[a][+ai] = rb; L[b][+bi] = ra;
  squadChanged();
  toast(`🔁 ${pname(ra)} ↔ ${pname(rb)}`);
}
/** 끌어다 놓기 (카드 · 목록 줄 공통) */
function bindDrag(root) {
  root.querySelectorAll('[data-place]').forEach(el => {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', el.dataset.place); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); document.body.classList.add('sq-dragging'); });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); document.body.classList.remove('sq-dragging'); document.querySelectorAll('.drop-on').forEach(x => x.classList.remove('drop-on')); });
    el.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drop-on'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop-on'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drop-on');
      const from = e.dataTransfer.getData('text/plain');
      if (!from || from === el.dataset.place) return;
      swapPlaces(from, el.dataset.place);
      squadUi.swapFrom = null;
      renderPlayerList(); renderStatEditor();
    });
  });
}
function renderPlayerList() {
  if (!playerListEl) return;
  ensureInv();
  const slots = getFormationSlots(userSetup.formation);
  // 세로 위치: 줄(비슷한 깊이끼리 묶음)마다 고르게 — 카드가 위아래로 겹치지 않게
  const pos = pitchLayout(slots);
  let cards = '';
  slots.forEach((f, i) => {
    const s = slotStats(i);
    const x = pos[i].x, y = pos[i].y;
    const off = s.nat !== f.position && !(POS_KEYS[s.nat] === POS_KEYS[f.position]);
    cards += `
      <button type="button" class="sq-card${squadUi.swapFrom != null && squadUi.swapFrom !== s.r && !gkSwapOk(placeKey(squadUi.swapFrom), squadUi.swapFrom, `xi:${i}`, s.r) ? ' no' : ''}${squadUi.selR === s.r ? ' active' : ''}${squadUi.swapFrom === s.r ? ' swap-from' : ''}${off ? ' offpos' : ''}" data-r="${s.r}" data-place="xi:${i}" style="left:${x}%;top:${y}%" title="${off ? `원래 포지션 ${s.nat}` : ''}">
        ${fcCard(i, s)}
      </button>`;
  });
  playerListEl.innerHTML = `<div class="sq-pitch"><div class="sq-lines"><i class="box"></i><i class="six"></i><i class="arc"></i><i class="half"></i></div>${cards}</div>`;
  playerListEl.querySelectorAll('.sq-card').forEach(btn => {
    btn.addEventListener('click', () => squadPick(Number(btn.dataset.r)));
    btn.addEventListener('dblclick', () => { if (squadUi.swapFrom == null) openPlayerInfo(Number(btn.dataset.r)); });
  });
  bindDrag(playerListEl);
  $('menu-squad')?.classList.toggle('swapping', squadUi.swapFrom != null);
}
function squadPick(r) {
  if (squadUi.swapFrom != null) {
    const a = squadUi.swapFrom;
    squadUi.swapFrom = null;
    if (a !== r) swapPlaces(placeKey(a), placeKey(r));
  }
  squadUi.selR = r;
  renderPlayerList();
  renderStatEditor();
}

/** 오른쪽: 고른 선수 요약 + 상세 정보 · 선수 관리 · 교체 + 선발 / 교체 / 후보 목록 */
function renderStatEditor() {
  const el = $('sq-side');
  if (!el) return;
  ensureInv();
  const L = userSetup.lineup;
  const i = squadUi.selR;
  const s = statsOf(i);
  const row = (r, place, label) => {
    const x = statsOf(r);
    return `<button type="button" class="sq-row ${squadUi.swapFrom != null && squadUi.swapFrom !== r && !gkSwapOk(placeKey(squadUi.swapFrom), squadUi.swapFrom, place, r) ? 'no' : ''} ${r === i ? 'on' : ''} ${squadUi.swapFrom === r ? 'swap-from' : ''}" data-r="${r}" data-place="${place}"><span class="pos">${label}</span><span class="nm">${faceImg('sm')}${badgeHtml()}${pname(r)}</span><span class="nat">${x.nat}</span><b>${x.ovr}</b></button>`;
  };
  const slots = getFormationSlots(userSetup.formation);
  const grp = (title, kind, arr, labelFn) => `<div class="sq-grp"><span>${title}</span><small>${arr.length}명</small></div>${arr.map((r, k) => row(r, `${kind}:${k}`, labelFn(r, k))).join('')}`;
  el.innerHTML = `
    <div class="sq-head">
      <div><div class="sq-hn">${badgeHtml()} ${pname(i)}</div><div class="sq-ho"><span>${labelOf(i)}</span> <b>${s.ovr}</b> <small class="sq-pl">${PLACE_NAME[placeOf(i).kind]} · 원래 ${s.nat}</small></div><div class="sq-hm">${escapeHtml(teamName(true))} · ${s.slot.foot === 'left' ? '왼발' : '오른발'}</div></div>
      <div class="sq-hface">${faceImg()}</div>
    </div>
    <div class="sq-groups">${foGroups(s.fo, s.isGk).map(([n, v]) => `<div><small>${n}</small><b style="color:${statColor(v)}">${v}</b></div>`).join('')}</div>
    <div class="sq-acts">
      <button type="button" class="btn" id="sq-info">상세 정보</button>
      <button type="button" class="btn" id="sq-pm">선수 관리</button>
      <button type="button" class="btn swap ${squadUi.swapFrom != null ? 'on' : ''}" id="sq-swap">${squadUi.swapFrom != null ? '교체 취소' : '교체'}</button>
      ${placeOf(i).kind === 'res' ? '<button type="button" class="btn ghost" id="sq-tostore">보관함으로</button>' : ''}
    </div>
    <div class="sq-swap-msg">${squadUi.swapFrom != null ? `${pname(squadUi.swapFrom)}와(과) 자리를 바꿀 선수를 고르세요` : '카드 · 목록을 끌어다 다른 선수에 놓으면 자리 교체'}</div>
    <div class="sq-th"><span>포지션</span><span>선수명</span><span>원래</span><span>능력치</span></div>
    <div class="sq-rows">
      ${grp('선발 라인업', 'xi', L.xi, (r, k) => slots[k].label)}
      ${grp('교체', 'subs', L.subs, () => 'SUB')}
      ${grp(`후보 (최대 ${RES_MAX})`, 'res', L.res, () => 'RES')}
    </div>`;
  el.querySelectorAll('.sq-row').forEach(b => {
    b.addEventListener('click', () => squadPick(Number(b.dataset.r)));
    b.addEventListener('dblclick', () => { if (squadUi.swapFrom == null) openPlayerInfo(Number(b.dataset.r)); });
  });
  bindDrag(el);
  $('sq-info')?.addEventListener('click', () => openPlayerInfo(i));
  $('sq-pm')?.addEventListener('click', () => openPlayerMenu(i));
  $('sq-swap')?.addEventListener('click', () => { squadUi.swapFrom = squadUi.swapFrom != null ? null : i; renderPlayerList(); renderStatEditor(); });
  $('sq-tostore')?.addEventListener('click', () => { const k = L.res.indexOf(i); if (k < 0) return; L.res.splice(k, 1); squadUi.swapFrom = null; squadUi.selR = L.xi[0]; squadChanged(); toast(`${pname(i)} → 보관함`); renderPlayerList(); renderStatEditor(); });
  renderSquadSaveBar();
}

// ===== 선수 카드 · 훈련 · 훈련 돌파 · 상점 · 내 아이템 =====
const CARD_BADGE = 'BS'; // 기본 지급 선수 = BS(베이스) 카드
const badgeHtml = (t = CARD_BADGE) => `<span class="cbadge">${t}</span>`;
const TRAIN_BASE_MAX = 5, BREAK_MAX = 5;
const BREAK_COST = [[500, 10], [750, 12], [900, 15], [1200, 18], [1500, 22]]; // [코인, 돌파권]
const BREAK_RATE = [50, 30, 25, 20, 15]; // 돌파 성공 확률(%) — 실패할 때마다 그 선수의 다음 확률 +1%
const breakRate = t => Math.min(100, BREAK_RATE[t.brk] + (t.brkFail || 0));
// ----- 강화 -----
// ===================== 강화 · 한계 돌파 설정값 (숫자는 여기서 바꾸면 됨) =====================
const ENH_BASE_MAX = 5;                 // 기본 강화 상한선
const ENH_MAX = 10;                     // 강화 최대 단계 (한계 돌파 5회)
// 강화 단계별 전체 능력치 보너스 (누적): 2강 +1 · 3강 +2 · 4강 +2 · 5강 +3 · 6강 +3 · 7강 +3 · 8강 +4 · 9강 +4 · 10강 +5
const ENH_BONUS = [0, 0, 1, 3, 5, 8, 11, 14, 18, 22, 27];
const enhLv = t => clamp(Math.floor(t?.enh || 1), 1, ENH_MAX);
const ENH_CARD_MAX = 10;                // 강화 카드 1~10강
/** 강화 카드 1장 성공 확률(%): 목표 단계 T — (T-1)강 카드 20% · T강 이상 카드 40% · 3강 강화에는 1강 카드도 10% · 그 외 낮은 카드 사용 불가 */
// 강화 카드 장당 확률: 목표 단계 이상 40% · 한 단계 아래 20% · 그 아래는 단계마다 줄어듦 (모든 카드 사용 가능)
const ENH_LOW_RATE = [20, 10, 5, 3, 2, 1, 1, 1, 1]; // 목표보다 1, 2, 3 … 단계 낮은 카드
const enhCardRate = (cardLv, target) => (cardLv >= target ? 40 : ENH_LOW_RATE[Math.min(ENH_LOW_RATE.length - 1, target - cardLv - 1)]);
const ENH_TABLE = [[1, 0.49], [2, 0.25], [3, 0.15], [4, 0.065], [5, 0.03], [6, 0.008], [7, 0.004], [8, 0.002], [9, 0.0007], [10, 0.0003]];
const LB_MAX = 5;                       // 한계 돌파 최대 횟수 (상한선 +5 → 10강)
const LB_EXP_NEED = 1000;               // 돌파 1회에 필요한 EXP
const LB_DUP_EXP = 1000;                // 같은 선수 · 시즌 · 종류 카드 1장 = EXP
const LB_CARD_EXPS = [300, 500, 600, 1000, 1500, 3000, 4500]; // 한계 돌파 카드 종류 (상점 판매 없음)
const lbCount = t => clamp(Math.floor(t?.lb || 0), 0, LB_MAX);
const enhCap = t => Math.min(ENH_MAX, ENH_BASE_MAX + lbCount(t)); // 지금 강화할 수 있는 최대 단계
const SHOP = [
  { id: 'trainBox', name: '훈련박스', price: 1000, ico: '📦', desc: '열면 훈련 EXP 카드 1장 — +100(50%) · +250(35%) · +500(10%) · +1000(5%)' },
  { id: 'breakBox', name: '훈련돌파박스', price: 1500, ico: '🎁', desc: '열면 훈련 돌파권 — 1장(50%) · 2장(30%) · 5장(15%) · 10장(5%)' },
  { id: 'redist', name: '훈련 재분배권', price: 3000, ico: '🔄', desc: '훈련으로 오른 능력치를 고른 7개 능력치에 다시 랜덤 분배' },
  { id: 'spTk', name: '특훈 재분배권', price: 5000, ico: '✦', desc: '특훈 재분배 1회에 1개 사용 — 기존 결과와 새 결과 중 선택' },
  { id: 'enhBox', name: '강화 박스', price: 4000, ico: '⬆', desc: '열면 강화 카드 1장 — 1강 49% · 2강 25% · 3강 15% · 4강 6.5% · 5강 3% · 6~10강 1%' },
  { id: 'bsPack', name: 'BS 랜덤 선수팩', price: 10000, ico: '🃏', desc: '모든 선수(8구단 + 이적시장 190명) 중 1명 · 모두 같은 확률 · 보관함으로' },
];
const EXP_CARDS = [1000, 500, 250, 100];
const statLabel = k => FO_LABEL[k] || STAT_DEFS.find(d => d.key === k)?.label || k;
const trainNeed = lv => ({ exp: 500 + 250 * (lv - 1), coin: 100 + 50 * (lv - 1) }); // lv = 올라갈 레벨
function emptyTrain() { return { lv: 0, brk: 0, exp: 0, bonus: {}, brkFail: 0, sp: {}, enh: 1, lb: 0, lbExp: 0 }; }
function emptyInv() { return { trainBox: 0, breakBox: 0, redist: 0, breakTk: 0, spTk: 0, enhBox: 0, bsPack: 0, exp: { 100: 0, 250: 0, 500: 0, 1000: 0 }, enhCard: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0 }, lbCard: { 300: 0, 500: 0, 600: 0, 1000: 0, 1500: 0, 3000: 0, 4500: 0 } }; }
function ensureInv() {
  if (!userSetup.inv) userSetup.inv = emptyInv();
  const v = userSetup.inv;
  v.exp = Object.assign({ 100: 0, 250: 0, 500: 0, 1000: 0 }, v.exp || {});
  v.enhCard = Object.assign({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0 }, v.enhCard || {});
  v.lbCard = Object.assign({ 300: 0, 500: 0, 600: 0, 1000: 0, 1500: 0, 3000: 0, 4500: 0 }, v.lbCard || {});
  for (const k of ['trainBox', 'breakBox', 'redist', 'breakTk', 'spTk', 'enhBox', 'bsPack']) v[k] = Math.max(0, Math.floor(v[k] || 0));
  ensureRoster();
  return v;
}
const trainMax = t => TRAIN_BASE_MAX + (t?.brk || 0);

// ===================== 선수 도감 (모든 선수 = BS 카드 템플릿) =====================
// · 8구단(팀 컬러) × 20명: 선발 11 · 교체 7 · 후보 2 — 선발 평균 오버롤 약 65
// · 이적시장(도감) 전용 선수 30명 (오버롤 높음)
// · 카드 종류 'BS', 시즌 '26
const CARD_SEASON = "'26", CARD_TYPE = 'BS';
// 선수 데이터는 players.json 에서 불러옴 (오버롤 ovr은 능력치 fo로 자동 계산)
const PLAYER_JSON = await fetch(new URL('./players.json', import.meta.url), { cache: 'no-cache' })
  .then(r => { if (!r.ok) throw new Error(`players.json ${r.status}`); return r.json(); })
  .catch(e => { document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;inset:0;z-index:9999;background:#050816;color:#fca5a5;display:grid;place-items:center;font:700 18px system-ui">players.json을 불러오지 못했어요 (${e.message}) — 웹 서버(GitHub Pages · Live Server 등)로 열어 주세요</div>`); throw e; });
const CLUB_SUFFIX = { blue: 'FC', red: '유나이티드', white: '시티', black: '로버스', green: '애슬레틱', orange: '원더러스', yellow: '레인저스', cyan: '알비온' };
const clubName = colorId => { const c = TEAM_COLORS.find(t => t.id === colorId); return c ? `${c.name} ${CLUB_SUFFIX[c.id] || 'FC'}` : '자유계약'; };
let PLAYER_DB = null;
function playerDb() {
  if (PLAYER_DB) return PLAYER_DB;
  const db = (PLAYER_JSON.players || []).map((p, i) => ({ ...p, tid: i, fo: { ...p.fo } }));
  for (const t of db) { const ks = posKeys(t.pos); t.ovr = Math.round(ks.reduce((a, k) => a + (t.fo[k] || 0), 0) / ks.length); }
  return (PLAYER_DB = db);
}
const tplOf = tid => playerDb()[tid] || playerDb()[0];
// 선수 사진: players.json의 "photo" 칸(photos 폴더 안 파일 이름)을 실제 주소로 바꿔 줌. 빈 칸이면 null
const PHOTO_DIR = './photos/';
const playerPhotoUrl = tid => { const f = tplOf(tid).photo; return f ? new URL(PHOTO_DIR + f, import.meta.url).href : null; };
const clubPlayers = colorId => playerDb().filter(t => t.club === colorId);

// ----- 내 선수 카드: roster[r] = { uid, tid, season, type } · 훈련/강화/한계돌파는 train[r] -----
// 라인업: 선발 11 · 교체 7 · 후보 2 (lineup.xi/subs/res = r 목록) · 그 밖의 카드는 보관함
const ROSTER_V = 2;
let cardUidSeq = 0;
function newCard(tid) { return { uid: Date.now().toString(36) + (++cardUidSeq).toString(36) + Math.floor(Math.random() * 1e6).toString(36), tid, season: CARD_SEASON, type: CARD_TYPE }; }
function ensureRoster() {
  let R = userSetup.roster;
  if (userSetup.rosterV !== ROSTER_V || !Array.isArray(R) || R.length < 11 || R.some(c => !Number.isInteger(c?.tid))) {
    // 기본 선수 대신 내 구단(팀 컬러) 선수 20명으로 시작 — 예전 기본 선수 · 훈련 기록은 정리
    const club = clubPlayers(userSetup.colorId || 'blue');
    R = club.map(t => newCard(t.tid));
    userSetup.roster = R;
    userSetup.train = R.map(() => emptyTrain());
    userSetup.lineup = { xi: club.map((t, k) => (t.grp === 'xi' ? k : -1)).filter(k => k >= 0), subs: club.map((t, k) => (t.grp === 'subs' ? k : -1)).filter(k => k >= 0), res: club.map((t, k) => (t.grp === 'res' ? k : -1)).filter(k => k >= 0) };
    userSetup.rosterV = ROSTER_V;
    userSetup.pids = null;
  }
  if (!Array.isArray(userSetup.train) || userSetup.train.length !== R.length) {
    const old = Array.isArray(userSetup.train) ? userSetup.train : [];
    userSetup.train = R.map((_, r) => old[r] || emptyTrain());
  }
  const L = userSetup.lineup;
  const all = L ? [...(L.xi || []), ...(L.subs || []), ...(L.res || [])] : [];
  const ok = L && Array.isArray(L.xi) && L.xi.length === 11 && Array.isArray(L.subs) && Array.isArray(L.res)
    && new Set(all).size === all.length && all.every(r => Number.isInteger(r) && r >= 0 && r < R.length);
  if (!ok) userSetup.lineup = { xi: Array.from({ length: 11 }, (_, i) => i), subs: Array.from({ length: Math.min(7, R.length - 11) }, (_, k) => 11 + k), res: Array.from({ length: clamp(R.length - 18, 0, 2) }, (_, k) => 18 + k) };
  return R;
}
const inSquad = r => { const L = (ensureRoster(), userSetup.lineup); return L.xi.includes(r) || L.subs.includes(r) || L.res.includes(r); };
const storageList = () => { ensureRoster(); return userSetup.roster.map((_, r) => r).filter(r => !inSquad(r)); };
/** 카드 추가 (보관함으로) → r */
function addCard(tid) { ensureRoster(); userSetup.roster.push(newCard(tid)); userSetup.train.push(emptyTrain()); return userSetup.roster.length - 1; }
/** 카드 삭제 (한계 돌파 재료 등) — 라인업 번호도 맞춰서 당김 */
function removeCards(rs) {
  ensureRoster();
  const del = new Set(rs.filter(r => !inSquad(r)));
  if (!del.size) return;
  const map = []; let n = 0;
  userSetup.roster.forEach((_, r) => { map[r] = del.has(r) ? -1 : n++; });
  userSetup.roster = userSetup.roster.filter((_, r) => !del.has(r));
  userSetup.train = userSetup.train.filter((_, r) => !del.has(r));
  const L = userSetup.lineup;
  for (const k of ['xi', 'subs', 'res']) L[k] = L[k].map(r => map[r]);
  if (Number.isInteger(trainUi?.sel)) trainUi.sel = Math.max(0, map[trainUi.sel] ?? 0);
  if (Number.isInteger(trainUi?.stick)) trainUi.stick = map[trainUi.stick] ?? null;
  if (Number.isInteger(squadUi?.selR)) squadUi.selR = Math.max(0, map[squadUi.selR] ?? 0);
}
const cardTpl = r => tplOf(ensureRoster()[r]?.tid ?? 0);
const xiR = i => (ensureRoster(), userSetup.lineup.xi[i]);
/** 경기용: 선발 11자리의 등번호 */
function ensurePids() { ensureRoster(); return userSetup.lineup.xi.map(r => cardTpl(r).num); }
const pnum = r => cardTpl(r).num;
const pname = r => cardTpl(r).name;
function placeOf(r) {
  const L = (ensureRoster(), userSetup.lineup);
  let k = L.xi.indexOf(r); if (k >= 0) return { kind: 'xi', idx: k };
  k = L.subs.indexOf(r); if (k >= 0) return { kind: 'subs', idx: k };
  k = L.res.indexOf(r); if (k >= 0) return { kind: 'res', idx: k };
  return { kind: 'store', idx: storageList().indexOf(r) };
}
const labelOf = r => { const pl = placeOf(r); return pl.kind === 'xi' ? getFormationSlots(userSetup.formation)[pl.idx].label : posOf(r); };
const rosterOrder = () => { ensureRoster(); const L = userSetup.lineup; return [...L.xi, ...L.subs, ...L.res, ...storageList()]; };
/** 선수 r의 능력치: 선발이면 그 자리 포지션 기준 오버롤, 아니면 원래 포지션 기준 */
const statsOf = r => { const pl = placeOf(r); return pl.kind === 'xi' ? slotStats(pl.idx) : rStats(r); };
const trainSum = t => Object.values(t?.bonus || {}).reduce((a, b) => a + b, 0);
// ===== FC식 능력치 34종 (화면 표시 · 훈련 · 특훈 기준) =====
const FO_STATS = [
  ['sprint', '속력'], ['accel', '가속력'], ['finishing', '골 결정력'], ['shotPower', '슛 파워'], ['longShots', '중거리 슛'], ['positioning', '위치 선정'], ['volleys', '발리슛'],
  ['penalty', '페널티 킥'], ['shortPass', '짧은 패스'], ['vision', '시야'], ['crossing', '크로스'], ['longPass', '긴 패스'], ['freekick', '프리킥'], ['curve', '커브'],
  ['dribbling', '드리블'], ['ballControl', '볼 컨트롤'], ['agility', '민첩성'], ['balance', '밸런스'], ['reactions', '반응 속도'], ['marking', '대인 수비'], ['standTackle', '태클'],
  ['interceptions', '가로채기'], ['heading', '헤더'], ['slideTackle', '슬라이딩 태클'], ['strength', '몸싸움'], ['stamina', '스태미너'], ['aggression', '적극성'], ['jump', '점프'], ['composure', '침착성'],
  ['gkDiving', 'GK 다이빙'], ['gkHandling', 'GK 핸들링'], ['gkKick', 'GK 킥'], ['gkReflex', 'GK 반응속도'], ['gkPos', 'GK 위치 선정'],
];
const FO_KEYS = FO_STATS.map(s => s[0]);
const FO_LABEL = Object.fromEntries(FO_STATS);
const FO_COLS = [FO_KEYS.slice(0, 7), FO_KEYS.slice(7, 14), FO_KEYS.slice(14, 21), FO_KEYS.slice(21, 29), FO_KEYS.slice(29)];
const GK_FO = new Set(['gkDiving', 'gkHandling', 'gkKick', 'gkReflex', 'gkPos']);
/** 포지션별 오버롤 결정 주요 능력치 */
const POS_KEYS = {
  ST: ['sprint', 'accel', 'finishing', 'shotPower', 'longShots', 'positioning', 'volleys', 'shortPass', 'dribbling', 'ballControl', 'reactions', 'heading', 'strength'],
  CAM: ['sprint', 'accel', 'finishing', 'longShots', 'positioning', 'shortPass', 'vision', 'longPass', 'dribbling', 'ballControl', 'agility', 'reactions'],
  CM: ['finishing', 'longShots', 'positioning', 'shortPass', 'vision', 'longPass', 'dribbling', 'ballControl', 'reactions', 'standTackle', 'interceptions', 'stamina'],
  RW: ['sprint', 'accel', 'finishing', 'longShots', 'positioning', 'shortPass', 'vision', 'crossing', 'dribbling', 'ballControl', 'agility', 'reactions'],
  CDM: ['shortPass', 'vision', 'longPass', 'ballControl', 'reactions', 'marking', 'standTackle', 'interceptions', 'slideTackle', 'strength', 'stamina', 'aggression'],
  RB: ['sprint', 'accel', 'shortPass', 'crossing', 'ballControl', 'reactions', 'marking', 'standTackle', 'interceptions', 'heading', 'slideTackle', 'stamina'],
  CB: ['sprint', 'shortPass', 'ballControl', 'reactions', 'marking', 'standTackle', 'interceptions', 'heading', 'slideTackle', 'strength', 'aggression', 'jump'],
  GK: ['gkDiving', 'gkHandling', 'gkKick', 'gkReflex', 'gkPos', 'reactions'],
};
POS_KEYS.LW = POS_KEYS.RW; POS_KEYS.LB = POS_KEYS.RB; POS_KEYS.LM = POS_KEYS.RW; POS_KEYS.RM = POS_KEYS.RW;
const posKeys = pos => POS_KEYS[pos] || POS_KEYS.CM;
const posOf = r => cardTpl(r).pos; // 선수의 원래 포지션 (훈련 · 특훈 기준)
/** 옛 저장 데이터(게임용 키) → 새 능력치 키 */
const OLD2FO = { speed: 'sprint', pass: 'shortPass', defense: 'standTackle', staminaRegen: 'stamina', reaction: 'gkReflex', gkPositioning: 'gkPos', diving: 'gkDiving', handling: 'gkHandling', gkKicking: 'gkKick' };
function migrateFo(obj) {
  const o = {};
  for (const [k, n] of Object.entries(obj || {})) { const nk = FO_LABEL[k] ? k : OLD2FO[k]; if (nk && n > 0) o[nk] = (o[nk] || 0) + Math.floor(n); }
  return o;
}
/** 기본 능력치: 자기 포지션 주요 능력치 90 · 나머지 80 (필드 선수의 GK 능력치 20, 키퍼의 필드 능력치 70) */
function foBase(pos) {
  const keys = new Set(posKeys(pos)), gk = pos === 'GK', o = {};
  for (const k of FO_KEYS) o[k] = keys.has(k) ? STAT_BASE : gk ? (GK_FO.has(k) ? STAT_BASE : 70) : (GK_FO.has(k) ? 20 : 80);
  return o;
}
/** 34개 능력치 → 실제 경기 계산용 능력치 */
function gameStats(f, isGk) {
  const r = (...v) => Math.round(v.reduce((a, b) => a + b, 0) / v.length);
  return {
    speed: f.sprint, accel: f.accel, staminaRegen: f.stamina,
    pass: r(f.shortPass, f.shortPass, f.longPass), shortPass: f.shortPass, longPass: f.longPass, crossing: f.crossing, vision: f.vision, shotPower: f.shotPower,
    finishing: r(f.finishing, f.finishing, f.longShots), penalty: f.penalty, freekick: f.freekick, curve: f.curve,
    dribbling: r(f.dribbling, f.dribbling, f.ballControl, f.agility), defense: r(f.marking, f.standTackle, f.interceptions, f.slideTackle),
    positioning: f.positioning, heading: r(f.heading, f.heading, f.jump), volleys: f.volleys,
    reaction: isGk ? r(f.gkReflex, f.reactions) : f.reactions, gkPositioning: f.gkPos, diving: f.gkDiving, handling: f.gkHandling, gkKicking: f.gkKick,
  };
}
function foGroups(f, isGk) {
  const r = (...k) => Math.round(k.reduce((a, x) => a + f[x], 0) / k.length);
  return isGk
    ? [['다이빙', f.gkDiving], ['핸들링', f.gkHandling], ['킥', f.gkKick], ['반응속도', f.gkReflex], ['스피드', r('sprint', 'accel')], ['위치선정', f.gkPos]]
    : [['스피드', r('sprint', 'accel')], ['슛', r('finishing', 'shotPower', 'longShots', 'positioning', 'volleys', 'penalty')], ['패스', r('shortPass', 'vision', 'crossing', 'longPass', 'freekick', 'curve')],
      ['드리블', r('dribbling', 'ballControl', 'agility', 'balance', 'reactions')], ['수비', r('marking', 'standTackle', 'interceptions', 'heading', 'slideTackle')], ['피지컬', r('strength', 'stamina', 'aggression', 'jump', 'composure')]];
}
/** 선수 i(라인업 자리)의 능력치: 기본 + 훈련 + 특훈 · 오버롤 = 자기 포지션 주요 능력치 평균 */
/** 선수 r의 능력치. slot을 주면 그 자리(포지션)의 주요 능력치로 오버롤 — 능력치 자체는 선수 원래 포지션 기준 */
function rStats(r, slot = null) {
  ensureRoster();
  const me = cardTpl(r);
  const nat = me.pos;
  const pos = slot?.position || nat;
  const t = userSetup.train?.[r] || emptyTrain();
  const base = me.fo, fo = {};
  const enh = ENH_BONUS[enhLv(t)]; // 강화: 전체 능력치 +
  for (const k of FO_KEYS) fo[k] = base[k] + (t.bonus?.[k] || 0) + (t.sp?.[k] || 0) + enh;
  const keys = posKeys(pos);
  const ovr = Math.round(keys.reduce((a, k) => a + fo[k], 0) / keys.length);
  const isGk = pos === 'GK';
  const sl = Object.assign({}, slot || { label: nat, position: nat, role: nat === 'GK' ? 'GK' : '' }, { foot: me.foot });
  return { r, tpl: me, slot: sl, isGk, pos, nat, t, base, fo, keys, ovr, enh, o: gameStats(fo, isGk) };
}
function slotStats(i) { return rStats(xiR(i), getFormationSlots(userSetup.formation)[i]); }
const teamOvr = () => Math.round(Array.from({ length: 11 }, (_, i) => slotStats(i).ovr).reduce((a, b) => a + b, 0) / 11);
const spPool = i => (posOf(i) === 'GK' ? posKeys('GK') : FO_KEYS.filter(k => !GK_FO.has(k)));
const statColor = v => (v >= 105 ? '#f97316' : v >= 98 ? '#eab308' : v >= 92 ? '#84cc16' : '#94a3b8');
const lvBadge = t => `<span class="tlv" title="훈련 레벨">${t?.lv || 0}</span>`;
/** FC식 선수 카드 (오버롤이 얼굴 위에) */
const FACE_CARD = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="sk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1f5f9"/><stop offset="1" stop-color="#cbd5e1"/></linearGradient></defs><path d="M6 64c2-14 12-20 26-20s24 6 26 20z" fill="#94a3b8"/><path d="M26 40h12v7c0 3-12 3-12 0z" fill="#b6c2d1"/><ellipse cx="32" cy="27" rx="12" ry="14" fill="url(#sk)"/><path d="M19 24c0-10 6-15 13-15s13 5 13 15c-3-5-8-7-13-7s-10 2-13 7z" fill="#475569"/></svg>`);
function fcCard(i, s = slotStats(i), cls = '') {
  i = s.r;
  return `<div class="fc ${cls}"><span class="fc-glow"></span><span class="fc-ovr">${s.ovr}</span><span class="fc-pos">${s.slot.label}</span>
    <img class="fc-face" src="${FACE_CARD}" alt=""><span class="fc-no e${enhLv(s.t)}">${enhLv(s.t)}</span>
    <span class="fc-bot"><span class="fc-bs">BS</span><span class="fc-nm">${pname(i)}</span></span></div>`;
}

// ----- 상점 -----
function openShop() {
  ensureInv();
  phase = 'shop';
  showMenuPanel('shop');
  renderShop();
}
function buyItem(id) {
  const it = SHOP.find(s => s.id === id);
  const v = ensureInv();
  if ((userSetup.coins || 0) < it.price) { toast('A코인이 부족해요'); return; }
  userSetup.coins -= it.price;
  v[id]++;
  saveSetup();
  renderShop();
  toast(`${it.name} 구매 완료!`);
}

// ----- 내 아이템 -----
function openItems() {
  ensureInv();
  phase = 'items';
  showMenuPanel('items');
  renderItems();
}
function rollTable(table) { let r = Math.random(), acc = 0; for (const [v, p] of table) { acc += p; if (r < acc) return v; } return table[table.length - 1][0]; }
function renderItems() {
  const el = $('items-body');
  if (!el) return;
  const v = ensureInv();
  // 가진 아이템만 표시
  const box = (id, name) => v[id] > 0 ? `<div class="it-card it-box"><div class="it-art">${ITEM_ART[id]}</div><div class="sc-name">${name}</div><div class="sc-own">${v[id].toLocaleString()}개</div>
    <div class="it-btns"><button type="button" class="btn" data-open="${id}" data-n="1">열기</button><button type="button" class="btn ghost" data-open="${id}" data-n="999" ${v[id] > 1 ? '' : 'disabled'}>모두 열기</button></div></div>` : '';
  const card = (art, name, n) => n > 0 ? `<div class="it-card it-c"><div class="it-art">${art}</div>${name ? `<div class="sc-name">${name}</div>` : ''}<div class="sc-own">× ${n.toLocaleString()}</div></div>` : '';
  const sec = (title, cls, html) => html.trim() ? `<div class="it-sec">${title}</div><div class="it-grid ${cls}">${html}</div>` : '';
  const html = sec('상자', '', `${box('trainBox', '훈련박스')}${box('breakBox', '훈련돌파박스')}${box('enhBox', '강화 박스')}${box('bsPack', 'BS 랜덤 선수팩')}`)
    + sec('훈련 재료', 'g7', EXP_CARDS.map(e => card(expCardArt(e), '', v.exp[e] || 0)).join('') + card(ITEM_ART.breakTk, '', v.breakTk) + card(ITEM_ART.redistTk, '', v.redist) + card(ITEM_ART.spTkCard, '', v.spTk))
    + sec('강화 카드', 'g7', Array.from({ length: ENH_CARD_MAX }, (_, k) => k + 1).map(l => card(enhCardArt(l), '', v.enhCard[l] || 0)).join(''))
    + sec('한계 돌파 카드', 'g7', LB_CARD_EXPS.map(e => card(lbCardArt(e), '', v.lbCard[e] || 0)).join(''));
  el.innerHTML = html || '<div class="it-empty">가진 아이템이 없어요 — 상점에서 상자를 사거나 경기 · 구단 레벨 보상으로 받을 수 있어요</div>';
  el.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openBox(b.dataset.open, Number(b.dataset.n))));
}
function showResult(title, lines) {
  const el = $('result-pop');
  if (!el) return;
  el.innerHTML = `<div class="rp-box glass"><div class="rp-h">${escapeHtml(title)}</div>${lines.map(l => `<div class="rp-l">${escapeHtml(l)}</div>`).join('')}<button type="button" class="btn" id="rp-ok">확인</button></div>`;
  el.classList.add('show');
  $('rp-ok')?.addEventListener('click', () => el.classList.remove('show'));
}

// ----- 선수 훈련 · 훈련 돌파 -----
let trainUi = { tab: 'train', sel: 0, sort: 'group', pick: { 100: 0, 250: 0, 500: 0, 1000: 0 } };
// 선수 관리 목록 정렬: 기본(선발 · 교체 · 후보 · 보관함[오버롤순]) · 오버롤순 · 포지션별
const TR_SORTS = [['group', '기본'], ['ovr', '오버롤'], ['pos', '포지션']];
const POS_SORT = ['GK', 'CB', 'LB', 'LWB', 'RB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'CF', 'ST'];
function trSorted(rs) {
  const ovrOf = r => statsOf(r).ovr;
  if (trainUi.sort === 'ovr') return rs.map(r => [r, ovrOf(r)]).sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(x => x[0]);
  if (trainUi.sort === 'pos') return rs.map(r => [r, POS_SORT.indexOf(posOf(r)), ovrOf(r)]).sort((a, b) => a[1] - b[1] || b[2] - a[2]).map(x => x[0]);
  // 기본: 라인업 순서 그대로, 보관함만 오버롤순
  const sq = rs.filter(r => inSquad(r)), st = rs.filter(r => !inSquad(r)).map(r => [r, rStats(r).ovr]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  return [...sq, ...st];
}
function openTraining(tab, sel) {
  ensureInv();
  if (tab) trainUi.tab = tab;
  if (sel != null) trainUi.sel = sel;
  trainUi.stick = sel != null ? sel : null; trainUi.retab = sel == null;
  spUi = { k: null, res: null };
  enhUi.slots = [];
  lbUi = { dup: [], lbc: {} };
  phase = 'training';
  trainUi.pick = { 100: 0, 250: 0, 500: 0, 1000: 0 };
  showMenuPanel('train');
  renderTraining();
}
function pickedExp() { return EXP_CARDS.reduce((a, e) => a + e * (trainUi.pick[e] || 0), 0); }
/** 고른 EXP로 몇 레벨까지 오르는지 · 드는 코인 */
function trainPreview(t, addExp) {
  let lv = t.lv, exp = t.exp + addExp, coin = 0;
  const max = trainMax(t);
  while (lv < max) {
    const need = trainNeed(lv + 1);
    if (exp < need.exp) break;
    exp -= need.exp; coin += need.coin; lv++;
  }
  return { lv, exp, coin, max };
}
function renderTraining() {
  const el = $('train-body');
  if (!el) return;
  const v = ensureInv();
  const slots = getFormationSlots(userSetup.formation);
  animNum($('train-coin'), userSetup.coins || 0);
  document.querySelectorAll('#menu-train .tr-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === trainUi.tab));
  if (!(trainUi.sel >= 0 && trainUi.sel < ensureRoster().length)) trainUi.sel = 0;
  const grpName = { xi: '선발', subs: '교체', res: '후보', store: '보관함' };
  // 이 탭에서 쓸 수 있는 선수만 (방금 작업한 선수는 탭을 바꾸기 전까지 남겨 둠)
  // 지금 고른 선수는 작업 뒤 조건이 끝나도 남겨 둠 (탭을 바꿀 때만 다시 고름)
  if (!trainUi.retab && trainUi.sel >= 0) trainUi.stick = trainUi.sel;
  trainUi.retab = false;
  const shown = trSorted(rosterOrder().filter(r => trEligible(trainUi.tab, r) || r === trainUi.stick));
  if (!shown.includes(trainUi.sel)) { trainUi.sel = shown.length ? shown[0] : -1; trainUi.stick = trainUi.sel; }
  // 왼쪽 목록은 데이터 · 탭 · 선택 · 정렬이 바뀔 때만 다시 그림 (카드 고르기 등은 오른쪽만 갱신 → 렉 감소 · 스크롤 유지)
  const listKey = `${dataVer}|${trainUi.tab}|${trainUi.sel}|${trainUi.sort}|${shown.length}`;
  let listFull = null;
  if (el._listKey !== listKey || !el.querySelector('.tr-list')) {
    let lastG = null;
    const list = shown.map(r => {
      const s = statsOf(r), g = placeOf(r).kind;
      const head = trainUi.sort === 'group' && g !== lastG ? `<div class="tr-grp">${grpName[g]}</div>` : '';
      lastG = g;
      return `${head}<button type="button" class="tr-pl ${trainUi.sel === r ? 'on' : ''}" data-i="${r}"><span class="pos">${labelOf(r)}</span><span class="nm">${faceImg('sm')}${badgeHtml()}${pname(r)}</span>${lvBadge(s.t)}<b>${s.ovr}</b></button>`;
    }).join('');
    const hidden = rosterOrder().length - shown.length;
    const sorts = TR_SORTS.map(([k, n]) => `<button type="button" class="tr-sort ${trainUi.sort === k ? 'on' : ''}" data-sort="${k}">${n}</button>`).join('');
    listFull = `<div class="tr-lhead"><span class="tr-lico">${PM_ART[trainUi.tab] || ''}</span><b>${TR_TAB_NAME[trainUi.tab] || ''} 가능 선수</b><small>${shown.length}명${hidden ? ` · 제외 ${hidden}명` : ''}</small></div><div class="tr-sorts">${sorts}</div>${list || '<div class="tr-lempty">해당 선수 없음</div>'}`;
    el._listKey = listKey;
  }
  const put = (mainCls, mainHtml) => {
    if (!el.querySelector('.tr-wrap')) el.innerHTML = '<div class="tr-wrap"><div class="tr-list"></div><div class="tr-main"></div></div>';
    if (listFull != null) { const L = el.querySelector('.tr-list'), st = L.scrollTop; L.innerHTML = listFull; L.scrollTop = st; }
    const M = el.querySelector('.tr-main');
    M.className = `tr-main ${mainCls}`;
    M.innerHTML = `<div class="tr-wm">${PM_ART[trainUi.tab] || ''}</div>${mainHtml}`;
    if (!el._deleg) {
      el._deleg = true;
      el.addEventListener('click', e => {
        const so = e.target.closest('.tr-sort');
        if (so) { trainUi.sort = so.dataset.sort; renderTraining(); return; }
        const b = e.target.closest('.tr-pl');
        if (!b || trainUi.anim) return;
        spUi = { k: null, res: null }; enhUi.slots = []; lbUi = { dup: [], lbc: {} };
        trainUi.sel = Number(b.dataset.i); trainUi.stick = trainUi.sel; trainUi.pick = { 100: 0, 250: 0, 500: 0, 1000: 0 };
        renderTraining();
      });
    }
  };
  if (trainUi.sel < 0) {
    put('', `<div class="tr-none"><div class="tr-none-art">${PM_ART[trainUi.tab] || ''}</div><b>${TR_TAB_NAME[trainUi.tab]}</b><p>${TR_EMPTY[trainUi.tab] || ''}</p></div>`);
    return;
  }
  const s = rStats(trainUi.sel);
  const t = s.t;
  const home = colorById(userSetup.colorId || 'blue');
  const card = fcCard(trainUi.sel, s);
  let main = '';
  if (trainUi.tab === 'train') {
    const add = pickedExp();
    const pv = trainPreview(t, add);
    const need = t.lv < trainMax(t) ? trainNeed(t.lv + 1) : null;
    const stats = s.keys.map(k => `<div class="ts"><span>${statLabel(k)}</span><b>${s.fo[k]}</b>${t.bonus[k] ? `<em>+${t.bonus[k]}</em>` : ''}</div>`).join('');
    const pct = need ? Math.min(100, (Math.min(need.exp, t.exp + add) / need.exp) * 100) : 100;
    main = `
      <div class="tr-top">
        ${card}
        <div class="tr-info">
          <div class="tr-lv"><span>LV <b>${t.lv}</b></span><span class="arr">»</span><span>LV <b class="${pv.lv > t.lv ? 'up' : ''}">${pv.lv}</b>/${pv.max}</span></div>
          <div class="ts-grid">${stats}</div>
          <div class="tr-bar"><i style="width:${pct}%"></i><span>${need ? `${Math.min(need.exp, t.exp + add).toLocaleString()} / ${need.exp.toLocaleString()} EXP` : (t.lv >= TRAIN_BASE_MAX + BREAK_MAX ? '최대 훈련 레벨' : '최대 레벨 — 훈련 돌파가 필요해요')}</span></div>
          <div class="tr-cost"><span class="coin">A</span> ${pv.coin.toLocaleString()} <small>(보유 ${(userSetup.coins || 0).toLocaleString()})</small></div>
          <div class="tr-note">훈련 레벨이 1 오를 때마다 ${s.pos} 주요 능력치 ${s.keys.length}개 중 랜덤으로 +1씩 2번 (10레벨 = +20) · 훈련 합계 <b>+${trainSum(t)}</b></div>
        </div>
      </div>
      <div class="tr-pick-h">훈련으로 사용할 EXP 카드를 선택하세요. (클릭 = 1장 추가 · 우클릭 = 1장 빼기)<b>선택한 EXP +${add.toLocaleString()}</b></div>
      <div class="tr-cards">${EXP_CARDS.every(e => !v.exp[e]) ? '<div class="tr-empty">보유한 EXP 카드가 없어요 — 상점에서 훈련박스를 사서 \'내 아이템\'에서 열어 주세요</div>' : ''}${EXP_CARDS.filter(e => v.exp[e] > 0).map(e => `<button type="button" class="expcard e${e} ${trainUi.pick[e] ? 'on' : ''}" data-e="${e}"><div>EXP</div><b>+${e}</b><small>x${v.exp[e] - (trainUi.pick[e] || 0)}</small>${trainUi.pick[e] ? `<i>${trainUi.pick[e]}</i>` : ''}</button>`).join('')}</div>
      <div class="tr-actions">
        <button type="button" class="btn ghost" id="tr-clear">모두 비우기</button>
        <button type="button" class="btn ghost" id="tr-auto">일괄 선택</button>
        <button type="button" class="btn ghost" id="tr-redist">훈련 재분배 (보유 ${v.redist})</button>
        <button type="button" class="btn tr-go" id="tr-go">훈련</button>
      </div>`;
  } else if (trainUi.tab === 'redist') {
    main = redistPage(s, card, v);
  } else if (trainUi.tab === 'sp' || trainUi.tab === 'sprd') {
    main = spPage(s, card, trainUi.tab);
  } else if (trainUi.tab === 'enh') {
    main = enhPage(s, card, v);
  } else if (trainUi.tab === 'lb') {
    main = lbPage(s, card, v);
  } else {
    const nb = t.brk < BREAK_MAX ? BREAK_COST[t.brk] : null;
    const autoMax = nb ? clamp(Math.min(Math.floor(v.breakTk / nb[1]), Math.floor((userSetup.coins || 0) / nb[0])), 1, 999) : 1;
    main = `
      <div class="brk"><div class="brk-l">
        ${nb ? `<div class="brk-rate">돌파 성공 확률 <b id="brk-rate-n">${breakRate(t)}%</b><small id="brk-rate-s">성공 확률 ${t.brkFail || 0}% 증가</small></div>` : ''}
        <div class="brk-circle"><svg class="brk-ring" viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="46"/><circle class="fg" id="brk-fg" cx="50" cy="50" r="46"/></svg>${card}<div class="brk-flash" id="brk-flash"></div></div>
        <div class="brk-lv"><span>훈련 돌파 레벨</span><span class="arr">›</span><b id="brk-lvn">${String(t.brk).padStart(2, '0')}</b><small>/${String(BREAK_MAX).padStart(2, '0')}</small></div>
        <div class="brk-sub">훈련 레벨 ${String(t.lv).padStart(2, '0')}/${String(trainMax(t)).padStart(2, '0')}</div>
        </div><div class="brk-r">
        <div class="brk-note"><div class="bn-h">훈련 돌파 유의 사항</div><div>• 훈련 돌파 레벨이 1 증가할수록 최대 훈련 레벨이 1 늘어납니다. (최대 10레벨)</div><div>• 실패 횟수마다 다음 시도의 성공 확률이 1% 증가합니다. (돌파권 · A코인은 실패해도 소모)</div></div>
        ${nb ? `<div class="brk-cost"><span>🎫 <b id="brk-tk">${v.breakTk}</b> / ${nb[1]}</span><span><span class="coin">A</span> ${nb[0].toLocaleString()}</span></div>
        <button type="button" class="btn brk-go" id="brk-go" ${v.breakTk >= nb[1] && (userSetup.coins || 0) >= nb[0] ? '' : 'disabled'}>훈련 돌파 (${t.brk + 1}돌파)</button>
        <div class="brk-auto">
          <div class="ba-row"><span>연속 훈련 돌파 횟수</span><b id="brk-auto-nv">${autoMax}</b></div>
          <input type="range" id="brk-auto-n" min="1" max="${autoMax}" value="${autoMax}">
          <div class="ba-row"><span>목표 돌파 레벨</span><b id="brk-auto-gv">${BREAK_MAX}</b></div>
          <input type="range" id="brk-auto-goal" min="${t.brk + 1}" max="${BREAK_MAX}" value="${BREAK_MAX}">
          <div class="ba-btns"><button type="button" class="btn" id="brk-auto">연속 돌파</button><button type="button" class="btn ghost" id="brk-stop" style="display:none">중지</button></div>
        </div>`
        : '<div class="brk-cost done">최대 돌파 완료</div>'}
        <div class="brk-log" id="brk-log"></div>
      </div></div>`;
  }
  put(`tm-${trainUi.tab}`, main);
  $('sp-to-rd')?.addEventListener('click', () => { trainUi.tab = 'sprd'; trainUi.retab = false; spUi = { k: null, res: null }; renderTraining(); });
  el.querySelectorAll('.expcard').forEach(b => {
    b.addEventListener('click', () => {
      const e = Number(b.dataset.e);
      const have = Number(v.exp[e] || 0), cur = Number(trainUi.pick[e] || 0);
      if (cur < have) { trainUi.pick[e] = cur + 1; renderTraining(); }
      else toast(have ? '이 EXP 카드를 모두 선택했어요' : 'EXP 카드가 없어요 — 상점에서 훈련박스를 사서 \'내 아이템\'에서 열어 주세요', 2400);
    });
    b.addEventListener('contextmenu', ev => { ev.preventDefault(); const e = Number(b.dataset.e); if (trainUi.pick[e] > 0) { trainUi.pick[e]--; renderTraining(); } });
  });
  $('tr-clear')?.addEventListener('click', () => { trainUi.pick = { 100: 0, 250: 0, 500: 0, 1000: 0 }; renderTraining(); });
  $('tr-auto')?.addEventListener('click', autoPickExp);
  $('tr-go')?.addEventListener('click', doTrain);
  $('tr-redist')?.addEventListener('click', openRedist);
  el.querySelectorAll('.spt-st').forEach(b => b.addEventListener('click', () => { spUi.k = b.dataset.k; renderTraining(); }));
  $('sp-go')?.addEventListener('click', doSpecial);
  el.querySelectorAll('.enh-pick').forEach(b => b.addEventListener('click', () => enhAdd(Number(b.dataset.l))));
  el.querySelectorAll('.enh-slot.full').forEach(b => b.addEventListener('click', () => { enhUi.slots.splice(Number(b.dataset.s), 1); renderTraining(); }));
  $('enh-clear')?.addEventListener('click', () => { enhUi.slots = []; renderTraining(); });
  $('enh-auto')?.addEventListener('click', enhAuto);
  $('enh-go')?.addEventListener('click', doEnhance);
  $('enh-auto-go')?.addEventListener('click', doEnhanceAuto);
  $('enh-stop')?.addEventListener('click', () => { trainUi.stop = true; });
  $('enh-auto-goal')?.addEventListener('input', e => { enhUi.goal = Number(e.target.value); $('enh-auto-gv').textContent = `${e.target.value}강`; });
  $('enh-to-lb')?.addEventListener('click', () => { trainUi.tab = 'lb'; trainUi.retab = false; renderTraining(); });
  el.querySelectorAll('.lbm').forEach(b => b.addEventListener('click', () => lbToggle(b.dataset.k)));
  el.querySelectorAll('.lb-slot[data-k]').forEach(b => b.addEventListener('click', () => lbRemove(b.dataset.k)));
  $('lb-clear')?.addEventListener('click', () => { lbUi = { dup: [], lbc: {} }; renderTraining(); });
  $('lb-go')?.addEventListener('click', lbConfirm);
  el.querySelectorAll('.spt-col').forEach(c => c.addEventListener('click', () => {
    const t = userSetup.train[trainUi.sel];
    if (c.dataset.pick === 'new') t.sp = spUi.res;
    spUi = { k: null, res: null };
    saveSetup();
    renderTraining();
    toast(c.dataset.pick === 'new' ? '새 특훈 결과를 적용했어요' : '기존 특훈을 유지했어요');
  }));
  $('brk-go')?.addEventListener('click', doBreak);
  $('brk-auto')?.addEventListener('click', doBreakAuto);
  $('brk-stop')?.addEventListener('click', () => { trainUi.stop = true; });
  $('brk-auto-n')?.addEventListener('input', e => { $('brk-auto-nv').textContent = e.target.value; });
  $('brk-auto-goal')?.addEventListener('input', e => { $('brk-auto-gv').textContent = e.target.value; });
}
/** 일괄 선택: 최대 레벨까지 필요한 만큼 큰 카드부터 */
function autoPickExp() {
  const v = ensureInv();
  const t = userSetup.train[trainUi.sel];
  trainUi.pick = { 100: 0, 250: 0, 500: 0, 1000: 0 };
  let need = 0;
  for (let l = t.lv + 1; l <= trainMax(t); l++) need += trainNeed(l).exp;
  need -= t.exp;
  for (const e of EXP_CARDS) while (need > 0 && trainUi.pick[e] < v.exp[e] && (need >= e || e === 100)) { trainUi.pick[e]++; need -= e; }
  if (need > 0) for (const e of [...EXP_CARDS].reverse()) while (need > 0 && trainUi.pick[e] < v.exp[e]) { trainUi.pick[e]++; need -= e; }
  renderTraining();
}
function doTrain() {
  const v = ensureInv();
  const i = trainUi.sel;
  const t = userSetup.train[i];
  const add = pickedExp();
  if (!add) { toast('EXP 카드를 먼저 선택하세요'); return; }
  if (t.lv >= trainMax(t)) { toast('최대 훈련 레벨이에요 — 훈련 돌파가 필요해요'); return; }
  const pv = trainPreview(t, add);
  if ((userSetup.coins || 0) < pv.coin) { toast('A코인이 부족해요'); return; }
  for (const e of EXP_CARDS) v.exp[e] -= trainUi.pick[e] || 0;
  const isGk = getFormationSlots(userSetup.formation)[i]?.role === 'GK';
  const ups = {};
  const from = t.lv;
  t.exp += add;
  while (t.lv < trainMax(t)) {
    const need = trainNeed(t.lv + 1);
    if (t.exp < need.exp || userSetup.coins < need.coin) break;
    t.exp -= need.exp; userSetup.coins -= need.coin; t.lv++;
    for (let n = 0; n < 2; n++) {
      const k = pick(posKeys(posOf(i)));
      t.bonus[k] = (t.bonus[k] || 0) + 1;
      ups[k] = (ups[k] || 0) + 1;
    }
  }
  trainUi.pick = { 100: 0, 250: 0, 500: 0, 1000: 0 };
  saveSetup();
  renderTraining();
  const lines = Object.entries(ups).map(([k, n]) => `${statLabel(k)} +${n}`);
  showResult(t.lv > from ? `훈련 완료! LV ${from} → ${t.lv}` : `EXP +${add.toLocaleString()} 적립`, lines.length ? lines : [`다음 레벨까지 ${(trainNeed(t.lv + 1).exp - t.exp).toLocaleString()} EXP`]);
}
/** 돌파 1회 시도 (원형 게이지 연출) → 성공 여부 */
function attemptBreak(fast = false) {
  return new Promise(resolve => {
    const v = ensureInv();
    const t = userSetup.train[trainUi.sel];
    if (t.brk >= BREAK_MAX) { resolve(null); return; }
    const [coin, tk] = BREAK_COST[t.brk];
    if (v.breakTk < tk || (userSetup.coins || 0) < coin) { resolve(null); return; }
    v.breakTk -= tk; userSetup.coins -= coin;
    const ok = Math.random() * 100 < breakRate(t);
    saveSetup();
    updateBreakNumbers();
    const fg = $('brk-fg'), flash = $('brk-flash');
    const C = 2 * Math.PI * 46;
    const target = ok ? 1 : 0.84 + Math.random() * 0.12;
    const dur = fast ? (ok ? 650 : 600) : (ok ? 1900 : 1750);
    const t0 = performance.now();
    if (fg) { fg.classList.remove('ok', 'no'); fg.style.strokeDasharray = String(C); fg.style.strokeDashoffset = String(C); }
    if (flash) flash.className = 'brk-flash';
    const done = () => {
      if (ok) { t.brk++; t.brkFail = 0; } else t.brkFail = (t.brkFail || 0) + 1;
      saveSetup();
      resolve(ok);
    };
    const step = now => {
      if (!fg) { done(); return; }
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 2.6);
      fg.style.strokeDashoffset = String(C * (1 - target * e));
      if (k < 1) { requestAnimationFrame(step); return; }
      fg.classList.add(ok ? 'ok' : 'no');
      if (flash) { flash.textContent = ok ? '돌파 성공!' : '실패'; flash.className = 'brk-flash show ' + (ok ? 'ok' : 'no'); }
      setTimeout(done, fast ? 380 : 900);
    };
    requestAnimationFrame(step);
  });
}
function updateBreakNumbers() {
  const v = ensureInv();
  const t = userSetup.train[trainUi.sel];
  const set = (id, txt) => { const e = $(id); if (e) e.textContent = txt; };
  set('brk-tk', `${v.breakTk}`);
  animNum($('train-coin'), userSetup.coins || 0);
  set('brk-rate-n', `${breakRate(t)}%`);
  set('brk-rate-s', `성공 확률 ${t.brkFail || 0}% 증가`);
  set('brk-lvn', String(t.brk).padStart(2, '0'));
}
async function doBreak() {
  if (trainUi.anim) return;
  const t = userSetup.train[trainUi.sel];
  if (t.brk >= BREAK_MAX) return;
  trainUi.anim = true;
  setBreakButtons(true);
  const ok = await attemptBreak(false);
  trainUi.anim = false;
  if (ok == null) toast('돌파권이나 A코인이 부족해요');
  renderTraining();
  const r = $('brk-log');
  if (r && ok != null) r.innerHTML = ok ? `<b class="ok">훈련 돌파 성공! ${t.brk}돌파</b> · 최대 훈련 레벨 ${trainMax(t)}` : `<b class="no">훈련 돌파 실패</b> · 다음 성공 확률 ${breakRate(t)}%`;
}
/** 연속 돌파: 목표 레벨에 닿거나, 정한 횟수만큼 하거나, 재료가 떨어질 때까지 */
async function doBreakAuto() {
  if (trainUi.anim) return;
  const t = userSetup.train[trainUi.sel];
  const maxN = Number($('brk-auto-n')?.value || 1), goal = Number($('brk-auto-goal')?.value || t.brk + 1);
  trainUi.anim = true; trainUi.stop = false;
  setBreakButtons(true);
  const startBrk = t.brk;
  let n = 0, fails = 0;
  const log = $('brk-log');
  while (n < maxN && t.brk < goal && !trainUi.stop) {
    const ok = await attemptBreak(true);
    if (ok == null) break;
    n++;
    if (!ok) fails++;
    if (log) log.innerHTML = `연속 돌파 진행 중… <b>${n}</b> / ${maxN}회 · 성공 ${t.brk - startBrk} · 실패 ${fails}`;
    const lv = $('brk-lvn'); if (lv && ok) { lv.classList.remove('pop'); void lv.offsetWidth; lv.classList.add('pop'); }
  }
  trainUi.anim = false;
  renderTraining();
  const l2 = $('brk-log');
  if (l2) l2.innerHTML = `연속 돌파 결과: <b>${n}회</b> 시도 · <b class="ok">${t.brk - startBrk}돌파 성공</b> (${startBrk} → ${t.brk}) · 실패 ${fails}${n === 0 ? ' — 돌파권이나 A코인이 부족해요' : ''}`;
}
function setBreakButtons(busy) {
  for (const id of ['brk-go', 'brk-auto']) { const b = $(id); if (b) b.disabled = busy; }
  const st = $('brk-stop'); if (st) st.style.display = busy ? '' : 'none';
}
// 재분배: 7개 능력치 선택 → 훈련 합계를 그 7개에 랜덤 분배 → 유지/재분배 중 선택
let redistUi = null;
function openRedist() {
  const v = ensureInv();
  const t = userSetup.train[trainUi.sel];
  if (!trainSum(t)) { toast('훈련으로 오른 능력치가 아직 없어요'); return; }
  if (v.redist <= 0) { toast('훈련 재분배권이 없어요 (상점에서 구매)'); return; }
  const isGk = posOf(trainUi.sel) === 'GK';
  const ks = posKeys(posOf(trainUi.sel));
  const need = Math.min(7, ks.length);
  // 고를 수 있는 능력치가 필요한 개수뿐이면(골키퍼 6개) 처음부터 전부 선택
  redistUi = { stats: ks, need, chosen: new Set(ks.length <= need ? ks : []), result: null };
  renderRedist();
}
function renderRedist() {
  const el = $('redist');
  if (!el || !redistUi) return;
  const t = userSetup.train[trainUi.sel];
  const R = redistUi;
  if (!R.result) {
    el.innerHTML = `<div class="rd-box"><div class="rd-title">/ 훈련 재분배 /</div>
      <p>재분배할 능력치 <b>${R.need}개</b>를 고르세요. 훈련 합계 <b>+${trainSum(t)}</b>가 고른 능력치에 랜덤으로 다시 나뉘어요.</p>
      <div class="rd-pick">${R.stats.map(k => `<button type="button" class="rd-st ${R.chosen.has(k) ? 'on' : ''}" data-k="${k}">${statLabel(k)} <small>+${t.bonus[k] || 0}</small></button>`).join('')}</div>
      <div class="rd-btns"><button type="button" class="btn ghost" id="rd-cancel">취소</button><button type="button" class="btn" id="rd-roll" ${R.chosen.size === R.need ? '' : 'disabled'}>재분배 (${R.chosen.size}/${R.need} · 재분배권 1개 사용)</button></div></div>`;
    el.querySelectorAll('.rd-st').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.k;
      if (R.chosen.has(k)) R.chosen.delete(k); else if (R.chosen.size < R.need) R.chosen.add(k);
      // 창 전체를 다시 그리지 않고 버튼만 갱신 (창이 튀지 않게)
      b.classList.toggle('on', R.chosen.has(k));
      const roll = $('rd-roll');
      if (roll) { roll.disabled = R.chosen.size !== R.need; roll.textContent = `재분배 (${R.chosen.size}/${R.need} · 재분배권 1개 사용)`; }
    }));
    $('rd-cancel')?.addEventListener('click', () => { el.classList.remove('show'); redistUi = null; });
    $('rd-roll')?.addEventListener('click', rollRedist);
  } else {
    const keys = R.stats.filter(k => (t.bonus[k] || 0) || R.result[k]);
    const col = (title, src, cmp) => `<div class="rd-col ${cmp ? 'new' : ''}" data-pick="${cmp ? 'new' : 'keep'}"><div class="rd-h">${title}</div>
      ${keys.map(k => { const a = src[k] || 0, b = t.bonus[k] || 0; const c = !cmp ? '' : a > b ? 'up' : a < b ? 'down' : ''; return `<div class="rd-row"><span>${statLabel(k)}</span><b class="${c}">${a}</b></div>`; }).join('')}</div>`;
    el.innerHTML = `<div class="rd-box"><div class="rd-title">/ 훈련 재분배 /</div><p>기존 훈련 능력치와 재분배된 훈련 능력치 중 선택하세요.</p>
      <div class="rd-cmp">${col('훈련 능력치 유지', t.bonus, false)}${col('훈련 능력치 재분배', R.result, true)}</div></div>`;
    el.querySelectorAll('.rd-col').forEach(c => c.addEventListener('click', () => {
      if (c.dataset.pick === 'new') t.bonus = R.result;
      saveSetup();
      el.classList.remove('show');
      redistUi = null;
      renderTraining();
      toast(c.dataset.pick === 'new' ? '재분배된 능력치를 적용했어요' : '기존 능력치를 유지했어요');
    }));
  }
  if (!el.classList.contains('show')) el.classList.add('show');
}
function rollRedist() {
  const v = ensureInv();
  const t = userSetup.train[trainUi.sel];
  const R = redistUi;
  if (!R || R.chosen.size !== R.need || v.redist <= 0) return;
  v.redist--;
  const total = trainSum(t);
  const ch = [...R.chosen];
  const res = {};
  for (let n = 0; n < total; n++) { const k = pick(ch); res[k] = (res[k] || 0) + 1; }
  R.result = res;
  saveSetup();
  renderRedist();
}

// ----- 선수 정보 (상세) -----
// ----- 선수 관리 (허브) -----
// 선수 관리 아이콘 (SVG) — 훈련=회색 꼬깔 · 훈련 돌파=축구공 · …
const PM_ART = {
  train: `<svg viewBox="0 0 100 100"><ellipse cx="50" cy="88" rx="40" ry="6" fill="rgba(0,0,0,0.25)"/><rect x="12" y="76" width="76" height="11" rx="3" fill="#6b7280"/><path d="M43 10h14l21 67H22z" fill="#9ca3af"/><path d="M39 24h22l4.4 14H34.6z" fill="#e5e7eb"/><path d="M31.5 48h37l4.4 14h-45.8z" fill="#e5e7eb"/><path d="M43 10h5l-15 67h-11z" fill="#fff" opacity=".22"/></svg>`,
  break: `<svg viewBox="0 0 100 100"><defs><clipPath id="pmball"><circle cx="50" cy="50" r="39"/></clipPath><radialGradient id="pmbg" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#cbd5e1"/></radialGradient></defs><circle cx="50" cy="50" r="40" fill="url(#pmbg)" stroke="#0f172a" stroke-width="3"/><g clip-path="url(#pmball)" fill="#0f172a" stroke="#0f172a" stroke-width="2.6" stroke-linejoin="round"><polygon points="50,35 64,45 59,61 41,61 36,45"/><line x1="50" y1="35" x2="50" y2="20"/><line x1="64" y1="45" x2="78" y2="40"/><line x1="59" y1="61" x2="68" y2="74"/><line x1="41" y1="61" x2="32" y2="74"/><line x1="36" y1="45" x2="22" y2="40"/><polygon points="40,4 60,4 58,20 50,20 42,20"/><polygon points="88,30 96,52 84,48 78,40"/><polygon points="76,86 62,96 62,80 68,74"/><polygon points="24,86 38,96 38,80 32,74"/><polygon points="12,30 4,52 16,48 22,40"/></g></svg>`,
  redist: `<svg viewBox="0 0 100 100"><rect x="46" y="18" width="8" height="64" rx="3" fill="#475569"/><rect x="30" y="80" width="40" height="8" rx="4" fill="#334155"/><rect x="14" y="22" width="72" height="6" rx="3" fill="#64748b"/><circle cx="50" cy="20" r="7" fill="#f59e0b"/><path d="M20 28l-12 26h24z M80 28l-12 26h24z" fill="none" stroke="#94a3b8" stroke-width="2"/><path d="M6 54h28a14 9 0 0 1-28 0z M66 54h28a14 9 0 0 1-28 0z" fill="#f59e0b"/></svg>`,
  sp: `<svg viewBox="0 0 100 100"><path d="M34 6h12l8 28H40z" fill="#2563eb"/><path d="M66 6H54l-8 28h14z" fill="#dc2626"/><circle cx="50" cy="60" r="30" fill="#f59e0b" stroke="#b45309" stroke-width="4"/><circle cx="50" cy="60" r="22" fill="#fbbf24"/><path d="M50 44l5 10.5 11.5 1.5-8.4 8 2.1 11.4L50 69.8 39.8 75.4l2.1-11.4-8.4-8 11.5-1.5z" fill="#fff7ed"/></svg>`,
  sprd: `<svg viewBox="0 0 100 100"><path d="M50 12a38 38 0 0 1 36 26" fill="none" stroke="#a855f7" stroke-width="7" stroke-linecap="round"/><path d="M90 30l-3 14-12-7z" fill="#a855f7"/><path d="M50 88a38 38 0 0 1-36-26" fill="none" stroke="#ec4899" stroke-width="7" stroke-linecap="round"/><path d="M10 70l3-14 12 7z" fill="#ec4899"/><path d="M50 28l7 14.5 16 2.3-11.6 11.3 2.8 15.9L50 64.5 35.8 72l2.8-15.9L27 44.8l16-2.3z" fill="#fbbf24" stroke="#b45309" stroke-width="2.5" stroke-linejoin="round"/></svg>`,
  enh: `<svg viewBox="0 0 100 100"><path d="M50 6l36 20v48L50 94 14 74V26z" fill="#0ea5e9" stroke="#0369a1" stroke-width="3"/><path d="M50 6l36 20L50 46 14 26z" fill="#7dd3fc" opacity=".7"/><path d="M30 60l20-18 20 18" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><path d="M30 76l20-18 20 18" fill="none" stroke="#fde047" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  lb: `<svg viewBox="0 0 100 100"><g stroke="#facc15" stroke-width="4" stroke-linecap="round"><line x1="12" y1="14" x2="22" y2="24"/><line x1="88" y1="14" x2="78" y2="24"/><line x1="50" y1="2" x2="50" y2="14"/></g><path d="M34 46V32a16 16 0 0 1 31-6" fill="none" stroke="#94a3b8" stroke-width="9" stroke-linecap="round"/><rect x="20" y="44" width="60" height="48" rx="9" fill="#7c3aed" stroke="#4c1d95" stroke-width="3"/><circle cx="50" cy="64" r="7" fill="#fde047"/><rect x="47" y="66" width="6" height="14" rx="2" fill="#fde047"/></svg>`,
  skill: `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#475569"/><text x="50" y="68" font-size="52" font-weight="900" text-anchor="middle" fill="#e2e8f0">?</text></svg>`,
};
const PM_TILES = [
  { id: 'train', name: '훈련', desc: 'EXP 카드로 훈련 레벨 올리기', c: '#64748b' },
  { id: 'break', name: '훈련 돌파', desc: '최대 훈련 레벨 늘리기', c: '#0f172a' },
  { id: 'redist', name: '훈련 재분배', desc: '훈련 능력치 다시 나누기', c: '#d97706' },
  { id: 'sp', name: '특훈', desc: '훈련 레벨 10 달성 시 해금 · 첫 특훈', c: '#2563eb' },
  { id: 'sprd', name: '특훈 재분배', desc: '특훈 결과를 다시 뽑아 고르기', c: '#a855f7' },
  { id: 'enh', name: '강화', desc: '강화 카드로 전체 능력치 올리기 (기본 5강 · 최대 10강)', c: '#0284c7' },
  { id: 'lb', name: '한계 돌파', desc: '같은 선수 카드 · 한계 돌파 카드로 강화 상한 올리기', c: '#7c3aed' },
  { id: 'skill', name: '스킬 변경', wip: true, c: '#475569' },
];
const TR_TAB_NAME = { train: '훈련', break: '훈련 돌파', redist: '훈련 재분배', sp: '특훈', sprd: '특훈 재분배', enh: '강화', lb: '한계 돌파' };
/** 탭마다 목록에 보일 선수 — 그 기능을 지금 쓸 수 있는 선수만 */
function trEligible(tab, r) {
  const t = userSetup.train[r];
  if (!t) return false;
  const full = TRAIN_BASE_MAX + BREAK_MAX;
  switch (tab) {
    case 'train': return t.lv < trainMax(t);
    case 'break': return t.brk < BREAK_MAX;
    case 'redist': return trainSum(t) > 0;
    case 'sp': return t.lv >= full && !Object.keys(t.sp || {}).length;
    case 'sprd': return Object.keys(t.sp || {}).length > 0;
    case 'enh': return enhLv(t) < enhCap(t);
    case 'lb': return lbCount(t) < LB_MAX;
  }
  return true;
}
const TR_EMPTY = {
  train: '훈련할 수 있는 선수가 없어요 — 모두 최대 훈련 레벨이에요. 훈련 돌파로 최대 레벨을 늘려 보세요.',
  break: '훈련 돌파할 수 있는 선수가 없어요 — 모두 최대 돌파예요.',
  redist: '재분배할 훈련 능력치가 있는 선수가 없어요 — 먼저 훈련을 해 주세요.',
  sp: `특훈할 수 있는 선수가 없어요 — 훈련 레벨 ${10}을 달성한(아직 특훈 안 한) 선수만 보여요.`,
  sprd: '특훈 재분배할 수 있는 선수가 없어요 — 특훈을 한 선수만 보여요.',
  enh: '강화할 수 있는 선수가 없어요 — 강화 상한에 닿은 선수는 한계 돌파가 필요해요.',
  lb: '한계 돌파할 수 있는 선수가 없어요 — 모두 최대 돌파예요.',
};
function openPlayerMgmt() {
  ensureInv();
  phase = 'pm';
  showMenuPanel('pm');
  const el = $('pm-body');
  if (!el) return;
  el.innerHTML = PM_TILES.map(t => { const n = t.wip ? 0 : rosterOrder().filter(r => trEligible(t.id, r)).length; return `<button type="button" class="pm-tile ${t.wip ? 'wip' : ''}" data-t="${t.id}" style="--c:${t.c}"><span class="pm-bgart">${PM_ART[t.id]}</span>${t.name}<small>${t.wip ? '' : t.desc}</small>${t.wip ? '' : `<span class="pm-cnt">가능 ${n}명</span>`}<span class="pm-ico">${PM_ART[t.id]}</span>${t.wip ? '<span class="wip-tag">제작중</span><span class="pm-wip-s">제작중</span>' : ''}</button>`; }).join('');
  el.querySelectorAll('.pm-tile').forEach(b => b.addEventListener('click', () => {
    const t = PM_TILES.find(x => x.id === b.dataset.t);
    if (t.wip) { toast('🚧 제작 중인 기능이에요'); return; }
    openTraining(t.id);
  }));
}

// ----- 선수 관리 메뉴 (라인업 · 상세 정보에서) -----
function openPlayerMenu(i) {
  const el = $('pmenu');
  if (!el) return;
  const v = ensureInv();
  const t = userSetup.train[i];
  const full = TRAIN_BASE_MAX + BREAK_MAX;
  const spOn = t.lv >= full;
  const items = [
    { tab: 'train', ico: '🏋️', name: '훈련', sub: t.lv >= full ? '훈련 최대 레벨 도달' : t.lv >= trainMax(t) ? '최대 레벨 — 훈련 돌파 필요' : `LV ${t.lv} / ${trainMax(t)}` },
    { tab: 'redist', ico: '⚖️', name: '훈련 재분배', sub: `재분배권 ${v.redist}개` },
    { tab: 'break', ico: '⬢', name: '훈련 돌파', sub: t.brk >= BREAK_MAX ? '훈련 돌파 최대 레벨 도달' : `돌파 ${t.brk} / ${BREAK_MAX}` },
    { tab: 'sp', ico: '✦', name: '특훈', sub: !spOn ? `훈련 ${full}레벨 달성 시 해금` : Object.keys(t.sp || {}).length ? '특훈 완료' : '특훈 가능', dim: !spOn || Object.keys(t.sp || {}).length > 0 },
    { tab: 'sprd', ico: '✦', name: '특훈 재분배', sub: Object.keys(t.sp || {}).length ? `재분배권 ${v.spTk}개` : '특훈 후 가능', dim: !Object.keys(t.sp || {}).length },
    { tab: 'enh', ico: '⬆', name: '강화', sub: enhLv(t) >= ENH_MAX ? '최대 강화 (10강)' : enhLv(t) >= enhCap(t) ? `${enhLv(t) + 1}강 잠김 · 한계 돌파 필요` : `${enhLv(t)}강 → ${enhLv(t) + 1}강` },
    { tab: 'lb', ico: '✦', name: '한계 돌파', sub: lbCount(t) >= LB_MAX ? '최대 돌파 완료' : `${lbCount(t)} / ${LB_MAX}회 · 상한 +${enhCap(t)}강` },
    { ico: '?', name: '스킬 변경', sub: '제작 중', wip: true },
  ];
  el.innerHTML = `<div class="pmn-box"><div class="pmn-h"><span>${labelOf(i)} ${pname(i)} · 선수 관리</span><button type="button" id="pmn-x">✕</button></div>
    ${items.map((it, k) => `<button type="button" class="pmn-it ${it.wip ? 'wip' : ''} ${it.dim ? 'dim' : ''}" data-k="${k}"><span class="i">${it.ico}</span><span><b>${it.name}</b>${it.sub ? `<small>${it.sub}</small>` : ''}</span></button>`).join('')}</div>`;
  el.classList.add('show');
  const close = () => el.classList.remove('show');
  $('pmn-x')?.addEventListener('click', close);
  el.addEventListener('click', e => { if (e.target === el) close(); }, { once: true });
  el.querySelectorAll('.pmn-it').forEach(b => b.addEventListener('click', () => {
    const it = items[Number(b.dataset.k)];
    if (it.wip) { toast('🚧 제작 중인 기능이에요'); return; }
    close();
    $('pinfo')?.classList.remove('show');
    squadUi.selR = i;
    leaveSquad(() => openTraining(it.tab, i));
  }));
}

// ----- 특훈 -----
let spUi = { k: null, res: null };
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
function spText(sp) {
  const e = Object.entries(sp || {}).filter(([, n]) => n);
  return e.length ? e.map(([k, n]) => `${statLabel(k)} <b>+${n}</b>`).join(' · ') : '없음';
}
function doSpecial() {
  const i = trainUi.sel;
  const t = userSetup.train[i];
  if (t.lv < TRAIN_BASE_MAX + BREAK_MAX) { toast(`훈련 ${TRAIN_BASE_MAX + BREAK_MAX}레벨을 달성해야 특훈을 할 수 있어요`); return; }
  if (!spUi.k) { toast('올리고 싶은 능력치를 먼저 고르세요'); return; }
  const v = ensureInv();
  const again = Object.keys(t.sp || {}).length > 0;
  if (again && v.spTk < 1) { toast('특훈 재분배권이 없어요 (상점에서 구매)'); return; }
  if (again) v.spTk--;
  const res = { [spUi.k]: randInt(1, 3) };
  // 고르지 않은 능력치 중 서로 다른 2개를 +1~2
  const rest = spPool(i).filter(k => k !== spUi.k);
  for (let n = 0; n < 2 && rest.length; n++) res[rest.splice(Math.floor(Math.random() * rest.length), 1)[0]] = randInt(1, 2);
  if (!Object.keys(t.sp || {}).length) {
    t.sp = res;
    saveSetup();
    renderTraining();
    { const f = rStats(i).fo; showResult('특훈 완료!', Object.entries(res).map(([k, n]) => `${statLabel(k)} ${f[k] - n} (+${n})`)); }
    return;
  }
  spUi.res = res;
  saveSetup();
  renderTraining();
}
// ----- 강화 화면 -----
let enhUi = { slots: [] };
function enhRate(slots, target) { return Math.min(100, slots.reduce((a, l) => a + enhCardRate(l, target), 0)); }
function enhAdd(l) {
  const v = ensureInv();
  const t = userSetup.train[trainUi.sel];
  const target = enhLv(t) + 1;
  if (target > enhCap(t)) return;
  if (!enhCardRate(l, target)) { toast(`${target}강 강화에는 이 카드를 쓸 수 없어요`); return; }
  if (enhUi.slots.length >= 5) { toast('강화 카드는 5장까지 넣을 수 있어요'); return; }
  const used = enhUi.slots.filter(x => x === l).length;
  if (used >= (v.enhCard[l] || 0)) { toast(`${l}강 강화 카드가 더 없어요`); return; }
  if (enhRate(enhUi.slots, target) >= 100) { toast('이미 성공 확률 100%예요'); return; }
  enhUi.slots.push(l);
  renderTraining();
}
/** 자동 채우기: 확률이 높은 카드(낮은 단계부터 아끼지 않게: 목표 단계 카드 → 바로 아래 단계)로 100%까지 */
function enhAuto() {
  const v = ensureInv();
  const t = userSetup.train[trainUi.sel];
  const target = enhLv(t) + 1;
  if (target > enhCap(t)) return;
  enhFill(t, v);
  if (!enhUi.slots.length) toast('쓸 수 있는 강화 카드가 없어요 — 상점에서 강화 박스를 사서 \'내 아이템\'에서 열어 주세요', 2600);
  renderTraining();
}
/** 슬롯 자동 채우기 (낮은 단계 카드부터 100%까지) */
function enhFill(t, v) {
  const target = enhLv(t) + 1;
  enhUi.slots = [];
  if (target > enhCap(t)) return;
  // 한 단계 아래 → 목표 이상(낮은 단계부터) → 더 낮은 카드로 남은 칸 채우기
  const order = [target - 1, ...Array.from({ length: ENH_CARD_MAX - target + 1 }, (_, i) => target + i), ...Array.from({ length: Math.max(0, target - 2) }, (_, i) => target - 2 - i)].filter(l => l >= 1 && l <= ENH_CARD_MAX);
  for (const l of order) {
    while (enhUi.slots.length < 5 && enhRate(enhUi.slots, target) < 100 && enhUi.slots.filter(x => x === l).length < (v.enhCard[l] || 0)) enhUi.slots.push(l);
  }
}
// ----- 연속 강화: 목표 단계까지 자동 채우기 → 강화를 반복 (카드 부족 · 상한 · 중지 시 멈춤) -----
const ENH_AUTO_DELAY = 650; // 한 번 시도마다 간격(ms)
async function doEnhanceAuto() {
  if (trainUi.anim) return;
  const v = ensureInv();
  const i = trainUi.sel, t = userSetup.train[i];
  const goal = Math.min(enhCap(t), Number($('enh-auto-goal')?.value) || enhCap(t));
  const start = enhLv(t), ovr0 = statsOf(i).ovr;
  if (start >= goal) return;
  trainUi.anim = true; trainUi.stop = false;
  enhUi.log = [];
  let tries = 0, used = 0, why = '';
  renderTraining();
  while (true) {
    if (trainUi.stop) { why = '중지'; break; }
    if (enhLv(t) >= goal) { why = '목표 달성'; break; }
    enhFill(t, v);
    if (!enhUi.slots.length) { why = '강화 카드 부족'; break; }
    const cur = enhLv(t), target = cur + 1, rate = enhRate(enhUi.slots, target);
    for (const l of enhUi.slots) v.enhCard[l] = Math.max(0, (v.enhCard[l] || 0) - 1);
    used += enhUi.slots.length; tries++;
    const ok = Math.random() * 100 < rate;
    if (ok) t.enh = target;
    enhUi.log.unshift(`<span class="${ok ? 'ok' : 'no'}">${tries}회 · ${target}강 ${rate}% → ${ok ? '성공' : '실패'}</span>`);
    enhUi.slots = [];
    saveSetup();
    renderTraining();
    const fx = document.querySelector('.tr-main .fc');
    if (fx) { fx.classList.remove('enh-flash', 'enh-fail'); void fx.offsetWidth; fx.classList.add(ok ? 'enh-flash' : 'enh-fail'); }
    await new Promise(r => setTimeout(r, ENH_AUTO_DELAY));
  }
  trainUi.anim = false; trainUi.stop = false;
  saveSetup();
  renderTraining();
  showResult(`연속 강화 종료 — ${why}`, [`${start}강 → ${enhLv(t)}강 (시도 ${tries}회 · 카드 ${used}장 사용)`, `오버롤 ${ovr0} → ${statsOf(i).ovr}`]);
}
function doEnhance() {
  const v = ensureInv();
  const i = trainUi.sel;
  const t = userSetup.train[i];
  const cur = enhLv(t), target = cur + 1;
  if (target > enhCap(t) || !enhUi.slots.length) return;
  const rate = enhRate(enhUi.slots, target);
  for (const l of enhUi.slots) v.enhCard[l] = Math.max(0, (v.enhCard[l] || 0) - 1); // 성공 · 실패 모두 카드 소모
  enhUi.slots = [];
  const ok = Math.random() * 100 < rate;
  const before = statsOf(i).ovr;
  if (ok) t.enh = target;
  saveSetup();
  renderTraining();
  if (ok) showResult(`${target}강 강화 성공!`, [`전체 능력치 +${ENH_BONUS[target] - ENH_BONUS[cur]} (누적 +${ENH_BONUS[target]})`, `오버롤 ${before} → ${statsOf(i).ovr}`]);
  else showResult('강화 실패', [`성공 확률 ${rate}% — 강화 카드는 소모됐어요`, `${cur}강 그대로`]);
}
function enhPage(s, card, v) {
  const t = s.t, cur = enhLv(t), target = cur + 1, cap = enhCap(t);
  const stepTxt = l => (l < 2 ? '기본' : `+${ENH_BONUS[l]}`);
  const lvRow = `<div class="enh-lv l10">${Array.from({ length: ENH_MAX }, (_, k) => k + 1).map(l => `<div class="el e${l} ${l <= cur ? 'done' : ''} ${l === target && l <= cap ? 'next' : ''} ${l > cap ? 'lock' : ''}"><b>${l > cap ? '🔒' : ''}${l}강</b><small>${stepTxt(l)}</small></div>`).join('')}</div>`;
  if (cur >= ENH_MAX) {
    return `<div class="spt"><div class="spt-l">${card}</div><div class="spt-r"><div class="spt-h">강화</div>${lvRow}<div class="spt-lock">최대 강화(${ENH_MAX}강) 달성 — 전체 능력치 +${ENH_BONUS[ENH_MAX]}</div></div></div>`;
  }
  if (target > cap) {
    return `<div class="spt"><div class="spt-l">${card}<div class="spt-now">현재 ${cur}강 · 상한 ${cap}강</div></div><div class="spt-r"><div class="spt-h">강화</div>${lvRow}
      <div class="spt-lock">🔒 ${target}단계 강화 잠김 — 한계 돌파 필요<br><small>한계 돌파 1회마다 강화 상한선이 +1강 올라가요 (최대 ${ENH_MAX}강)</small></div>
      <button type="button" class="btn brk-go" disabled>${target}강 강화</button>
      <button type="button" class="btn ghost" id="enh-to-lb">한계 돌파 하러 가기</button></div></div>`;
  }
  const rate = enhRate(enhUi.slots, target);
  const slots = Array.from({ length: 5 }, (_, k) => {
    const l = enhUi.slots[k];
    return l ? `<button type="button" class="enh-slot full c${l}" data-s="${k}" title="눌러서 빼기"><b>${l}강</b><small>강화 카드</small><i>${enhCardRate(l, target)}%</i></button>` : '<div class="enh-slot"><small>빈 칸</small></div>';
  }).join('');
  const picks = Array.from({ length: ENH_CARD_MAX }, (_, k) => k + 1).map(l => {
    const left = (v.enhCard[l] || 0) - enhUi.slots.filter(x => x === l).length;
    const r = enhCardRate(l, target);
    return `<button type="button" class="enh-pick c${l} ${r ? '' : 'no'}" data-l="${l}" ${left > 0 && r ? '' : 'disabled'}><b>${l}강</b><small>${r ? `장당 ${r}%` : '사용 불가'}</small><i>× ${left}</i></button>`;
  }).join('');
  return `<div class="spt"><div class="spt-l">${card}<div class="spt-now">현재 ${cur}강 · 전체 능력치 ${cur > 1 ? '+' + ENH_BONUS[cur] : '+0'} · 상한 ${cap}강</div></div><div class="spt-r">
    <div class="spt-h">강화 <small class="enh-to">${cur}강 → ${target}강 (전체 능력치 +${ENH_BONUS[target] - ENH_BONUS[cur]})</small></div>
    ${lvRow}
    <div class="spt-p">강화 카드를 최대 <b>5장</b>. ${target}강 강화: <b>${target}강 이상 장당 40%</b> · <b>${target - 1}강 20%</b>${target > 2 ? ` · 더 낮은 카드도 사용 가능 (${ENH_LOW_RATE.slice(1, target - 1).join('/')}%)` : ''}. 실패하면 카드만 사라져요.</div>
    <div class="enh-slots">${slots}</div>
    <div class="enh-picks p10">${picks}</div>
    <div class="spt-cost"><span>성공 확률 <b class="enh-rate">${rate}%</b></span><span><button type="button" class="btn ghost enh-mini" id="enh-auto">자동 채우기</button><button type="button" class="btn ghost enh-mini" id="enh-clear">비우기</button></span></div>
    <button type="button" class="btn brk-go" id="enh-go" ${enhUi.slots.length && !trainUi.anim ? '' : 'disabled'}>${target}강 강화</button>
    <div class="enh-auto">
      <span class="ea-t">연속 강화</span>
      <span class="ea-g">목표 <b id="enh-auto-gv">${cap}강</b></span>
      <input type="range" id="enh-auto-goal" min="${target}" max="${cap}" value="${Math.max(target, Math.min(cap, enhUi.goal || cap))}" ${trainUi.anim ? 'disabled' : ''}>
      ${trainUi.anim ? '<button type="button" class="btn ghost enh-mini" id="enh-stop">중지</button>' : '<button type="button" class="btn enh-mini" id="enh-auto-go">연속 강화</button>'}
    </div>
    <div class="enh-log">${(enhUi.log || []).slice(0, 4).join('')}</div>
  </div></div>`;
}
// ===================== 한계 돌파 =====================
/** 한계 돌파 카드 지급 (보상 · 개발자 모드 공용) */
function giveLimitBreakCard(exp, n = 1) {
  if (!LB_CARD_EXPS.includes(exp) || !(n > 0)) return false;
  const v = ensureInv();
  v.lbCard[exp] = (v.lbCard[exp] || 0) + Math.floor(n);
  saveSetup();
  return true;
}
const lbCardCls = e => 'x' + (LB_CARD_EXPS.indexOf(e) + 1); // 색: 낮을수록 회색/파랑 → 높을수록 빨강/금색
/** 재료 판정: 대상 카드 r에 카드 m을 넣을 수 있나 (자기 자신 · 스쿼드 등록 카드 불가, 선수 · 시즌 · 종류가 모두 같아야 함) */
function isLbMaterial(r, m) {
  if (r === m || inSquad(m)) return false;
  const R = ensureRoster(), a = R[r], b = R[m];
  return !!a && !!b && a.tid === b.tid && a.season === b.season && a.type === b.type;
}
/** EXP 계산: 지금 돌파 횟수 · 게이지 + 추가 EXP → 결과 (넘친 EXP는 다음 단계로 이월, 최대 횟수를 넘는 EXP는 소멸) */
function lbCalc(count, exp, add) {
  let c = count, e = exp + add, gained = 0;
  while (e >= LB_EXP_NEED && c < LB_MAX) { e -= LB_EXP_NEED; c++; gained++; }
  let wasted = 0;
  if (c >= LB_MAX) { wasted = e; e = 0; }
  return { count: c, exp: e, gained, wasted };
}
let lbUi = { dup: [], lbc: {} };
const lbAddExp = () => lbUi.dup.length * LB_DUP_EXP + Object.entries(lbUi.lbc).reduce((a, [e, n]) => a + Number(e) * n, 0);
function lbMaterials(r) {
  const v = ensureInv();
  const dups = userSetup.roster.map((_, m) => m).filter(m => isLbMaterial(r, m) && !lbUi.dup.includes(m)).map(m => ({ k: 'd' + m, exp: LB_DUP_EXP, m }));
  const cards = LB_CARD_EXPS.map(e => ({ k: 'c' + e, exp: e, left: (v.lbCard[e] || 0) - (lbUi.lbc[e] || 0) })).filter(x => x.left > 0);
  return [...dups, ...cards].sort((a, b) => b.exp - a.exp); // 기본 정렬: 경험치 높은 순
}
function lbToggle(k) {
  const r = trainUi.sel, t = userSetup.train[r];
  if (lbCount(t) >= LB_MAX) return;
  if (k[0] === 'd') { const m = Number(k.slice(1)); if (isLbMaterial(r, m) && !lbUi.dup.includes(m)) lbUi.dup.push(m); }
  else { const e = Number(k.slice(1)), v = ensureInv(); if ((lbUi.lbc[e] || 0) < (v.lbCard[e] || 0)) lbUi.lbc[e] = (lbUi.lbc[e] || 0) + 1; }
  renderTraining();
}
function lbRemove(k) {
  if (k[0] === 'd') lbUi.dup = lbUi.dup.filter(m => m !== Number(k.slice(1)));
  else { const e = Number(k.slice(1)); if (lbUi.lbc[e] > 1) lbUi.lbc[e]--; else delete lbUi.lbc[e]; }
  renderTraining();
}
function lbConfirm() {
  const add = lbAddExp();
  if (!add) return;
  const el = $('sq-confirm');
  const t = userSetup.train[trainUi.sel], res = lbCalc(lbCount(t), t.lbExp || 0, add);
  el.innerHTML = `<div class="sqc-box"><div class="sqc-h">재료 카드가 사라집니다</div>
    <p>선택한 재료(${lbUi.dup.length ? `선수 카드 ${lbUi.dup.length}장` : ''}${lbUi.dup.length && Object.keys(lbUi.lbc).length ? ' · ' : ''}${Object.entries(lbUi.lbc).map(([e, n]) => `EXP ${e} ×${n}`).join(' · ')})를 사용해 <b>EXP +${add}</b>를 얻어요.<br>한계 돌파 <b>${res.gained}회</b> 예정${res.wasted ? ` · <b style="color:#f87171">초과된 EXP ${res.wasted}는 소멸됩니다</b>` : ''}</p>
    <div class="sqc-btns"><button type="button" class="btn ghost" id="lbc-no">취소</button><button type="button" class="btn" id="lbc-yes">한계 돌파</button></div></div>`;
  el.classList.add('show');
  $('lbc-no')?.addEventListener('click', () => el.classList.remove('show'));
  $('lbc-yes')?.addEventListener('click', () => { el.classList.remove('show'); doLimitBreak(); });
}
function doLimitBreak() {
  const v = ensureInv();
  const uid = userSetup.roster[trainUi.sel].uid;
  const add = lbAddExp();
  const t = userSetup.train[trainUi.sel];
  const before = enhCap(t);
  const res = lbCalc(lbCount(t), t.lbExp || 0, add);
  for (const [e, n] of Object.entries(lbUi.lbc)) v.lbCard[e] = Math.max(0, (v.lbCard[e] || 0) - n); // 한계 돌파 카드 차감
  removeCards(lbUi.dup);                                                                    // 재료 선수 카드 삭제
  trainUi.sel = Math.max(0, userSetup.roster.findIndex(c => c.uid === uid)); trainUi.stick = trainUi.sel;
  const tt = userSetup.train[trainUi.sel];
  tt.lb = res.count; tt.lbExp = res.exp;
  lbUi = { dup: [], lbc: {} };
  saveSetup();
  renderTraining();
  lbFx(trainUi.sel, before, enhCap(tt), res);
}
/** 성공 연출: 카드가 빛나고 자물쇠가 풀림 · 여러 번 돌파면 상한 숫자가 차례로 올라감 */
function lbFx(r, from, to, res) {
  const el = $('lb-fx');
  if (!el) return;
  const card = fcCard(r, rStats(r), 'big');
  el.innerHTML = `<div class="lbfx-box"><div class="lbfx-card">${card}</div><div class="lbfx-r"><div class="lbfx-lock">${to > from ? '🔒' : '✦'}</div><div class="lbfx-num">+${from}강</div>
    <div class="lbfx-t">${to > from ? `한계 돌파 성공!` : '돌파 EXP 충전'}</div><div class="lbfx-s">${to > from ? `강화 상한선 +${from}강 → +${to}강` : `게이지 ${res.exp} / ${LB_EXP_NEED}`}</div>
    <button type="button" class="btn" id="lbfx-ok">확인</button></div></div>`;
  el.classList.add('show');
  const lock = el.querySelector('.lbfx-lock'), num = el.querySelector('.lbfx-num');
  let c = from;
  const tick = () => {
    if (c >= to) return;
    c++;
    lock.classList.remove('open'); void lock.offsetWidth; lock.textContent = '🔒'; lock.classList.add('open');
    setTimeout(() => { lock.textContent = '🔓'; }, 260);
    num.textContent = `+${c}강`; num.classList.remove('pop'); void num.offsetWidth; num.classList.add('pop');
    if (c < to) setTimeout(tick, 700);
  };
  setTimeout(tick, 450);
  $('lbfx-ok')?.addEventListener('click', () => el.classList.remove('show'));
}
function lbPage(s, card, v) {
  const r = trainUi.sel, t = s.t;
  const cnt = lbCount(t), cap = enhCap(t), exp = t.lbExp || 0;
  if (cnt >= LB_MAX) {
    return `<div class="spt"><div class="spt-l">${card}</div><div class="spt-r"><div class="spt-h">한계 돌파</div>
      <div class="lb-top"><div class="lb-arrow"><b>+${cap}</b></div></div>
      <div class="spt-lock">✦ 최대 돌파 완료 (${LB_MAX}회) — 강화 상한 +${ENH_MAX}강</div>
      <div class="lb-btns"><button type="button" class="btn brk-go" disabled>최대 돌파 완료</button></div></div></div>`;
  }
  const add = lbAddExp(), res = lbCalc(cnt, exp, add);
  const pctCur = Math.min(100, exp / LB_EXP_NEED * 100);
  const pctNew = res.gained ? 100 : Math.min(100, (exp + add) / LB_EXP_NEED * 100);
  const slotItems = [...lbUi.dup.map(m => `<button type="button" class="lb-slot dup" data-k="d${m}" title="눌러서 빼기"><span class="mini">${pname(m)}</span><i>+${LB_DUP_EXP}</i></button>`),
    ...Object.entries(lbUi.lbc).map(([e, n]) => `<button type="button" class="lb-slot ${lbCardCls(Number(e))}" data-k="c${e}" title="눌러서 하나 빼기"><b>EXP ${e}</b><i>×${n}</i></button>`)].join('');
  const mats = lbMaterials(r);
  const list = mats.map(x => x.m != null
    ? `<button type="button" class="lbm dup" data-k="${x.k}"><span class="lbm-c">${escapeHtml(pname(x.m))}<small>${cardTpl(x.m).pos} · ${CARD_TYPE} ${CARD_SEASON}</small></span><i>EXP ${x.exp}</i></button>`
    : `<button type="button" class="lbm ${lbCardCls(x.exp)}" data-k="${x.k}"><span class="lbm-c"><b>${x.exp}</b><small>한계 돌파 카드 ×${x.left}</small></span><i>EXP ${x.exp}</i></button>`).join('')
    || '<div class="lb-empty">재료로 쓸 수 있는 카드가 없어요 (같은 선수 카드는 보관함에 있어야 하고, 라인업에 등록된 카드는 쓸 수 없어요)</div>';
  return `<div class="spt"><div class="spt-l">${card}<div class="spt-now">현재 ${enhLv(t)}강 · 상한 ${cap}강 · 돌파 ${cnt}/${LB_MAX}회</div></div><div class="spt-r lb-r">
    <div class="spt-h">한계 돌파</div>
    <div class="lb-top"><div class="lb-arrow big"><b>+${cap}</b><span>→</span>${res.gained ? `<b class="open">🔓 +${Math.min(ENH_MAX, ENH_BASE_MAX + res.count)}</b>` : `<b class="locked">🔒 +${cap + 1}</b>`}</div><div class="lb-lockt ${res.gained ? 'ok' : ''}">${res.gained ? `돌파 ${res.gained}회 · 강화 상한 +${cap}강 → +${Math.min(ENH_MAX, ENH_BASE_MAX + res.count)}강` : `${cap + 1}단계 강화단계 잠김`}</div></div>
    <div class="lb-gauge"><div class="lb-fill new" style="width:${pctNew}%"></div><div class="lb-fill" style="width:${pctCur}%"></div><span>${exp}${add ? ` <em>+${add}</em>` : ''} / ${LB_EXP_NEED}</span></div>
    <div class="lb-prev">${add ? `얻게 될 EXP <b>+${add}</b> · 돌파 <b>${res.gained}회</b> 예정${res.gained ? ` (상한 +${Math.min(ENH_MAX, ENH_BASE_MAX + res.count)}강)` : ''}${res.wasted ? ` · <b class="warn">초과된 EXP는 소멸됩니다 (${res.wasted})</b>` : ''}` : '재료를 고르면 얻게 될 EXP가 여기 보여요'}</div>
    <div class="lb-slots">${slotItems || '<span class="lb-guide">다음 카드를 재료로 사용 가능합니다<br>- 한계 돌파 카드<br>- 동일 선수, 동일 시즌, 동일 종류 카드</span>'}</div>
    <div class="lb-list">${list}</div>
    <div class="lb-btns"><button type="button" class="btn ghost" id="lb-clear">모두 비우기</button><button type="button" class="btn brk-go" id="lb-go" ${add ? '' : 'disabled'}>한계 돌파</button></div>
  </div></div>`;
}
function spPage(s, card, mode = 'sp') {
  const t = s.t;
  const raw = k => s.fo[k] - (t.sp?.[k] || 0); // 특훈 빼고 (기본 + 훈련)
  const val = (k, n) => n ? `${raw(k)} <em class="sp-up">(+${n})</em>` : `${raw(k)}`;
  const full = TRAIN_BASE_MAX + BREAK_MAX;
  const stats = spPool(trainUi.sel);
  let right;
  const hasSp = Object.keys(t.sp || {}).length > 0;
  if (mode === 'sp' && hasSp && !spUi.res) {
    right = `<div class="spt-p">이 선수는 특훈을 마쳤어요. 결과를 다시 뽑으려면 <b>특훈 재분배</b>를 이용하세요.</div><div class="spt-done">${Object.entries(t.sp).map(([k, n]) => `<div><span>${statLabel(k)}</span><b>+${n}</b></div>`).join('')}</div><button type="button" class="btn brk-go" id="sp-to-rd">특훈 재분배로</button>`;
  } else if (mode === 'sprd' && !hasSp) {
    right = `<div class="spt-lock">특훈을 한 선수만 특훈 재분배를 할 수 있어요</div>`;
  } else if (t.lv < full) {
    right = `<div class="spt-lock">🔒 특훈은 훈련 레벨 ${full}을 달성하면 열려요<br><small>현재 훈련 LV ${t.lv} / ${trainMax(t)} · 훈련 돌파로 최대 레벨을 ${full}까지 올리세요</small></div>`;
  } else if (spUi.res) {
    const col = (title, sp, pk) => `<div class="spt-col" data-pick="${pk}"><div class="h">${title}</div>${Object.entries(sp).map(([k, n]) => `<div class="r"><span>${statLabel(k)}</span><b>${val(k, n)}</b></div>`).join('') || '<div class="r">없음</div>'}</div>`;
    right = `<div class="spt-p">기존 특훈과 새 특훈 결과 중 하나를 고르세요.</div><div class="spt-res">${col('기존 특훈 유지', t.sp, 'keep')}${col('새 특훈 적용', spUi.res, 'new')}</div>`;
  } else {
    right = `<div class="spt-p">올리고 싶은 능력치 <b>1개</b>를 고르세요. 고른 능력치는 <b>+1~3</b>, 고르지 않은 능력치 중 <b>2개</b>가 각각 <b>+1~2</b> 랜덤으로 올라요.<br>다시 특훈하면 기존 결과와 새 결과 중 고를 수 있어요.</div>
      <div class="spt-grid">${stats.map(k => `<button type="button" class="spt-st ${spUi.k === k ? 'on' : ''}" data-k="${k}"><span>${statLabel(k)}</span><small>${raw(k)}${t.sp?.[k] ? `<em>+${t.sp[k]}</em>` : ''}</small></button>`).join('')}</div>
      <div class="spt-cost">${Object.keys(t.sp || {}).length ? `<span>✦ 특훈 재분배권 1개 사용</span><span>보유 ${ensureInv().spTk}개</span>` : '<span>첫 특훈은 무료예요</span>'}</div>
      <button type="button" class="btn brk-go" id="sp-go" ${spUi.k ? '' : 'disabled'}>${Object.keys(t.sp || {}).length ? '특훈 재분배' : '특훈'}</button>`;
  }
  return `<div class="spt"><div class="spt-l">${card}<div class="spt-now">현재 특훈: ${Object.keys(t.sp || {}).length ? Object.entries(t.sp).map(([k, n]) => `${statLabel(k)} ${val(k, n)}`).join(' · ') : '없음'}</div></div><div class="spt-r"><div class="spt-h">${mode === 'sprd' ? '특훈 재분배' : '특훈'}</div>${right}</div></div>`;
}
function redistPage(s, card, v) {
  const t = s.t;
  return `<div class="rdt"><div class="rdt-l">${card}</div><div class="rdt-r"><div class="rdt-h">훈련 재분배</div>
    <div class="rdt-p">훈련으로 오른 능력치 <b>+${trainSum(t)}</b>를 ${s.pos} 주요 능력치 중 고른 ${Math.min(7, s.keys.length)}개 능력치에 다시 랜덤으로 나눠요. 결과를 보고 기존/재분배 중 고를 수 있어요.</div>
    <div class="rdt-grid">${s.keys.map(k => `<div class="rdt-st"><span>${statLabel(k)}</span><b>+${t.bonus[k] || 0}</b></div>`).join('')}</div>
    <div class="spt-cost"><span>🔄 훈련 재분배권 <b>${v.redist}</b>개 보유</span></div>
    <button type="button" class="btn brk-go" id="tr-redist">훈련 재분배</button></div></div>`;
}

// ----- 상세 정보 (FC식 총 능력치 · 포지션 주요 능력치) -----
const STAT_DESC = {
  sprint: '전력 질주 시 선수의 최고 속력을 결정합니다.', accel: '최고 속력에 도달하는 시간을 결정합니다.',
  agility: '드리블 · 몸싸움 시 균형 유지와 빠른 동작에 영향을 줍니다.', balance: '태클 돌파 · 몸싸움 · 밀고 당기기에서 균형 유지에 영향을 줍니다.',
  jump: '헤딩 경합과 공중볼 경합에서 이길 확률에 영향을 줍니다.', stamina: '경기 중 얼마나 지치는지를 결정합니다.',
  strength: '몸싸움 · 볼 보호 · 공중볼 경합 등 물리적 경합에 영향을 줍니다.', aggression: '태클과 압박을 얼마나 적극적으로 하는지 영향을 줍니다.',
  composure: '압박받는 상황에서 패스 · 슛을 얼마나 침착하게 하는지 영향을 줍니다.', interceptions: '근처의 패스를 차단하고 루즈볼을 간수하는 데 영향을 줍니다.',
  positioning: '공격 시 적절한 위치를 잡고 침투하는 판단에 영향을 줍니다.', reactions: '공의 궤적을 읽고 빠르게 반응하는 데 영향을 줍니다.',
  vision: '주변을 잘 인식해 짧은 패스 · 긴 패스 · 스루 패스를 정확하게 합니다.', ballControl: '공 컨트롤 시 공이 덜 튀어 나갑니다.',
  dribbling: '볼 터치와 드리블 턴이 빨라지고 태클을 당해도 공을 잘 간수합니다.', crossing: '크로스의 속도와 정확도에 영향을 줍니다.',
  longPass: '로빙 패스의 정확도에 영향을 줍니다.', shortPass: '짧은 패스의 속도와 정확도에 영향을 줍니다.',
  curve: '슛 · 패스 시 공이 얼마나 휘는지에 영향을 줍니다. (프리킥 · 감아차기)', shotPower: '슈팅의 최고 속력을 결정합니다.',
  longShots: '먼 거리에서 슈팅할 때 정확도를 결정합니다.', finishing: '슈팅 정확도에 영향을 주며 골대와의 거리에 따라 반영 비중이 달라집니다.',
  freekick: '프리킥 정확도에 영향을 줍니다.', penalty: '페널티킥 정확도에 영향을 줍니다.',
  heading: '헤딩 슈팅의 정확도와 헤딩 반응에 영향을 줍니다.', volleys: '바운드되는 공을 슈팅할 때 정확도에 영향을 줍니다.',
  marking: '드리블하는 상대에 대한 반응과 압박 거리에 영향을 줍니다.', slideTackle: '슬라이딩 태클의 정확도에 영향을 줍니다.',
  standTackle: '스탠딩 태클의 정확도에 영향을 줍니다.', gkDiving: '빠르고 정확한 다이빙에 영향을 줍니다.',
  gkHandling: '공을 쳐내기보다 손으로 잡아내는 데 영향을 줍니다.', gkKick: '골킥 · 펀트가 얼마나 멀리 가는지 결정합니다.',
  gkPos: '여러 슈팅을 막을 수 있는 위치를 정확하게 잡는 데 영향을 줍니다.', gkReflex: '슛에 반응하는 속도에 영향을 줍니다.',
};
let pdTab = 'all';
function openPlayerInfo(i, showBd = false) {
  const el = $('pinfo');
  if (!el) return;
  ensureInv();
  const s = statsOf(i); // i = 선수단 번호
  const t = s.t;
  const full = TRAIN_BASE_MAX + BREAK_MAX;
  const add = k => (t.bonus?.[k] || 0) + (t.sp?.[k] || 0) + s.enh;
  const keySet = new Set(s.keys);
  const cols = FO_COLS.map(col => col.filter(k => pdTab === 'all' || keySet.has(k))).filter(c => c.length);
  const statCols = cols.map(col => `<div class="pdc">${col.map(k => `<div class="pdc-r"><span>${FO_LABEL[k]}</span><b class="${add(k) ? 'up' : ''}">${s.fo[k]}</b></div>`).join('')}</div>`).join('');
  const spSum = Object.values(t.sp || {}).reduce((a, b) => a + b, 0);
  const row = (lab, val, cell) => `<div class="pd-row"><div class="k"><span>${lab}</span>${cell}</div><div class="v">${val}</div></div>`;
  const bdRow = k => `<div class="bd-r" data-k="${k}"><span>${FO_LABEL[k]}</span><i>${s.base[k]}</i><i class="${t.bonus?.[k] ? 'plus' : 'z'}">${t.bonus?.[k] || 0}</i><i class="${t.sp?.[k] ? 'plus' : 'z'}">${t.sp?.[k] || 0}</i><i class="${s.enh ? 'plus' : 'z'}">${s.enh}</i><b>${s.fo[k]}</b></div>`;
  const bdHead = '<div class="bd-r bd-h"><span>능력치</span><i>기본</i><i>훈련</i><i>특훈</i><i>강화</i><b>종합</b></div>';
  const third = Math.ceil(FO_KEYS.length / 3);
  const bd = `<div class="pd-bd"><div class="pd-bd-h"><span>능력치 상세 <small>기본 + 훈련 + 특훈 + 강화 = 종합</small></span><button type="button" id="pd-bd-x">✕</button></div>
    <div class="bd-grid">${[0, 1, 2].map(c => `<div>${bdHead}${FO_KEYS.slice(c * third, (c + 1) * third).map(bdRow).join('')}</div>`).join('')}</div>
    <div class="bd-desc" id="bd-desc"><b>${FO_LABEL[s.keys[0]]}</b> ${STAT_DESC[s.keys[0]]}</div></div>`;
  el.innerHTML = `<div class="pd-box">
    <button type="button" class="pd-x" id="pd-x">✕</button>
    <div class="pd-l">
      ${fcCard(i, s, 'big')}
      <div class="pd-nav"><button type="button" id="pd-prev">«</button><span>${rosterOrder().indexOf(i) + 1} / ${rosterOrder().length}</span><button type="button" id="pd-next">»</button></div>
    </div>
    <div class="pd-r">
      <div class="pd-head">${badgeHtml()}<span class="nm">${pname(i)}</span><span style="color:#94a3b8;font-weight:700">${escapeHtml(teamName(true))} · ${s.slot.foot === 'left' ? '왼발' : '오른발'}</span><span class="ps">${s.slot.label}</span></div>
      ${row('훈련', t.lv, `<span class="pd-bar"><i style="width:${t.lv / full * 100}%"></i><em>${t.lv >= trainMax(t) ? 'MAX' : `${t.lv} / ${trainMax(t)}`}</em></span>`)}
      <div class="pd-two">
        ${row('훈련 돌파', t.brk, `<span class="pd-pips">${Array.from({ length: BREAK_MAX }, (_, k) => `<i class="${k < t.brk ? 'on' : ''}"></i>`).join('')}</span>`)}
        ${row('특훈', spSum ? `+${spSum}` : '-', `<span class="pd-sp">${t.lv < full ? `훈련 ${full}레벨 달성 시 해금` : spText(t.sp)}</span>`)}
      </div>
      <div class="pd-grp">${foGroups(s.fo, s.isGk).map(([n, v]) => `<div><small>${n}</small><b>${v}</b></div>`).join('')}</div>
      <div class="pd-tabs"><button type="button" data-t="all" class="${pdTab === 'all' ? 'on' : ''}">총 능력치</button><button type="button" data-t="pos" class="${pdTab === 'pos' ? 'on' : ''}">${s.pos} · 오버롤 ${s.ovr}</button></div>
      <div class="pd-stats" id="pd-stats" title="눌러서 능력치 상세 보기"><div class="hint">눌러서 능력치 상세 보기 ›</div><div class="pdc-wrap">${statCols}</div></div>
      <div class="pd-btns"><button type="button" class="btn" id="pd-pm">선수 관리</button><button type="button" class="btn ghost" id="pd-close">닫기</button></div>
    </div>
    ${showBd ? bd : ''}
  </div>`;
  el.classList.add('show');
  const close = () => el.classList.remove('show');
  $('pd-x')?.addEventListener('click', close);
  $('pd-close')?.addEventListener('click', close);
  { const ord = rosterOrder(), k = ord.indexOf(i), n = ord.length;
    $('pd-prev')?.addEventListener('click', () => openPlayerInfo(ord[(k + n - 1) % n]));
    $('pd-next')?.addEventListener('click', () => openPlayerInfo(ord[(k + 1) % n])); }
  $('pd-stats')?.addEventListener('click', () => openPlayerInfo(i, true));
  $('pd-bd-x')?.addEventListener('click', () => openPlayerInfo(i, false));
  $('pd-pm')?.addEventListener('click', () => openPlayerMenu(i));
  el.querySelectorAll('.pd-tabs button').forEach(b => b.addEventListener('click', () => { pdTab = b.dataset.t; openPlayerInfo(i); }));
  el.querySelectorAll('.bd-r[data-k]').forEach(r => r.addEventListener('mouseenter', () => { const d = $('bd-desc'); if (d) d.innerHTML = `<b>${FO_LABEL[r.dataset.k]}</b> ${STAT_DESC[r.dataset.k] || ''}`; }));
  el.querySelector('.pd-box').style.animation = showBd ? 'none' : '';
}

// ----- 구단 레벨 -----
const clubNeed = lv => 300 + 150 * (lv - 1);
function ensureClub() {
  if (!userSetup.club || typeof userSetup.club !== 'object') userSetup.club = {};
  const c = userSetup.club;
  c.lv = Math.max(1, Math.floor(c.lv || 1));
  c.exp = Math.max(0, Math.floor(c.exp || 0));
  if (!c.founded) c.founded = readAccounts()[currentUser]?.created || Date.now();
  return c;
}
/** 경기 EXP: 승 120 · 무 70 · 패 40 + 득점당 10 (최대 60) */
/** 레벨 업 보상: 매 레벨 훈련박스 10 · 훈련돌파박스 5 / 5의 배수 +훈련 재분배권 1 / 10의 배수 +특훈 재분배권 1 */
function levelReward(lv) {
  const r = { trainBox: 10, breakBox: 5 };
  if (lv % 5 === 0) r.redist = 1;
  if (lv % 10 === 0) r.spTk = 1;
  return r;
}
const REWARD_NAME = { trainBox: '훈련박스', breakBox: '훈련돌파박스', redist: '훈련 재분배권', spTk: '특훈 재분배권' };
const rewardText = r => Object.entries(r).map(([k, n]) => `${REWARD_NAME[k]} ${n}개`).join(' · ');
function addClubExp(n) {
  const c = ensureClub();
  const from = c.lv;
  const v = ensureInv();
  const got = {};
  c.exp += n;
  while (c.exp >= clubNeed(c.lv)) {
    c.exp -= clubNeed(c.lv); c.lv++;
    for (const [k, q] of Object.entries(levelReward(c.lv))) { v[k] = (v[k] || 0) + q; got[k] = (got[k] || 0) + q; }
  }
  lastLevelReward = got;
  return c.lv - from;
}
let lastLevelReward = {};
// ----- 구단 관리 (정보) -----
function openClubInfo() {
  phase = 'club_info';
  showMenuPanel('club');
  const el = $('club-body');
  if (!el) return;
  const c = ensureClub();
  const home = colorById(userSetup.colorId || 'blue');
  const d = new Date(c.founded);
  const lg = currentLeague();
  const pct = Math.min(100, c.exp / clubNeed(c.lv) * 100);
  el.innerHTML = `
    <div class="ci-top">
      <div class="ci-crest"><svg viewBox="0 0 64 72">${crestSvg(home.css, escapeHtml(teamName(true).slice(0, 1)))}</svg></div>
      <div class="ci-name"><b>${escapeHtml(teamName(true))}</b><span>감독 ${escapeHtml(currentUser || '-')}</span>
        <div class="ci-lv"><span class="lvb">Lv.${c.lv}</span><span class="ci-bar"><i style="width:${pct}%"></i></span><small>${c.exp.toLocaleString()} / ${clubNeed(c.lv).toLocaleString()} EXP</small></div></div>
    </div>
    <div class="ci-grid">
      <div class="ci-card"><small>구단 창단일</small><b>${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.</b></div>
      <div class="ci-card"><small>구단 레벨</small><b>Lv.${c.lv}</b></div>
      <div class="ci-card"><small>현재 전술</small><b>${userSetup.formation}</b></div>
      <div class="ci-card"><small>팀 평균 오버롤</small><b>${teamOvr()}</b></div>
      <div class="ci-card"><small>팀 컬러</small><b><span class="ci-sw" style="background:${home.css}"></span>${home.name}</b></div>
      <div class="ci-card"><small>참가 리그</small><b>${lg.name}</b></div>
    </div>
    <div class="ci-note">경기를 하면 구단 EXP를 얻어요 — 승리 120 · 무승부 70 · 패배 40 · 득점당 +10 (최대 60)</div>
    <div class="ci-rw"><b>다음 레벨 보상 (Lv.${c.lv + 1})</b> ${rewardText(levelReward(c.lv + 1))}<small>매 레벨 훈련박스 10 · 훈련돌파박스 5 / 5레벨마다 +훈련 재분배권 / 10레벨마다 +특훈 재분배권</small></div>
    <div class="ci-btns"><button type="button" class="btn" id="btn-club-color">🎨 팀 컬러 바꾸기</button></div>`;
  $('btn-club-color')?.addEventListener('click', () => openClubSetup(false));
}

// ----- 개발자 모드: 로비에서 M 7번 -----
let devTaps = 0, devT = 0;
function devTap() {
  const now = performance.now();
  if (now - devT > 2500) devTaps = 0;
  devT = now;
  if (++devTaps >= 7) {
    devTaps = 0;
    const v = ensureInv();
    // 개발자 지급 (예전 지급량 기준: 코인 ×100 · 나머지 ×10)
    const DEV = { coins: 10000000, breakTk: 10000, redist: 200, spTk: 100, enhBox: 200, lbEach: 30, lb1000: 100, exp1000: 1000, expSmall: 100, bsPack: 100, trainBox: 100, breakBox: 100, enhCard: 10 };
    userSetup.coins = (userSetup.coins || 0) + DEV.coins;
    v.breakTk += DEV.breakTk;
    v.redist += DEV.redist;
    v.spTk += DEV.spTk;
    v.enhBox += DEV.enhBox;
    v.bsPack += DEV.bsPack;
    v.trainBox += DEV.trainBox;
    v.breakBox += DEV.breakBox;
    for (let l = 1; l <= ENH_CARD_MAX; l++) v.enhCard[l] = (v.enhCard[l] || 0) + DEV.enhCard;
    for (const e of LB_CARD_EXPS) giveLimitBreakCard(e, e === 1000 ? DEV.lb1000 : DEV.lbEach); // 한계 돌파 카드는 지금은 개발자 모드에서만
    v.exp[1000] += DEV.exp1000;
    for (const e of [100, 250, 500]) v.exp[e] += DEV.expSmall;
    saveSetup();
    updateLobby?.();
    toast('🛠 개발자 모드: A코인 1,000만 · 돌파권 1만 · 재분배권 200 · 특훈 재분배권 100 · 강화 박스 200 · BS 선수팩 100 · 한계 돌파 카드(1000 ×100 · 나머지 ×30) · EXP 카드 · 훈련/돌파 박스 100 · 강화 카드 1~10강 ×10 지급', 4000);
  }
}

// ===== 미니 페이스 (회색 사람 일러스트 · 전체 공통) =====
const FACE_URL = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cbd5e1"/><stop offset="1" stop-color="#94a3b8"/></linearGradient><linearGradient id="sk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1f5f9"/><stop offset="1" stop-color="#cbd5e1"/></linearGradient></defs><rect width="64" height="64" rx="10" fill="url(#bg)"/><path d="M8 64c2-13 11-19 24-19s22 6 24 19z" fill="#64748b"/><path d="M26 41h12v7c0 3-12 3-12 0z" fill="#b6c2d1"/><ellipse cx="32" cy="28" rx="12" ry="14" fill="url(#sk)"/><path d="M19 25c0-10 6-15 13-15s13 5 13 15c-3-5-8-7-13-7s-10 2-13 7z" fill="#475569"/></svg>`);
const faceImg = (cls = '') => `<img class="face ${cls}" src="${FACE_URL}" alt="">`;

// ===== 상점 (상품 카드 + 구매 창) =====
// ===== 아이템 그림: 흰 상자 · 흰 카드에 기능 아이콘 (훈련=꼬깔 · 훈련 돌파=축구공 · 강화=보석 · 한계 돌파=자물쇠) =====
let artSeq = 0;
/** 같은 SVG를 여러 번 그려도 그라데이션 id가 겹치지 않게 */
function uniqSvg(str) { const n = ++artSeq; return str.replace(/id="([\w-]+)"/g, `id="$1_${n}"`).replace(/url\(#([\w-]+)\)/g, `url(#$1_${n})`); }
const emb = (k, x, y, w) => PM_ART[k].replace('<svg viewBox="0 0 100 100">', `<svg x="${x}" y="${y}" width="${w}" height="${w}" viewBox="0 0 100 100">`);
function boxArt(k, c) {
  return uniqSvg(`<svg viewBox="0 0 120 120" class="ia ia-box"><defs><linearGradient id="bf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#dfe5ee"/></linearGradient><linearGradient id="bs" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#d5dce6"/><stop offset="1" stop-color="#b8c2d0"/></linearGradient></defs>
    <ellipse cx="62" cy="108" rx="44" ry="6" fill="rgba(0,0,0,0.3)"/>
    <polygon points="88,44 104,33 104,93 88,105" fill="url(#bs)" stroke="#94a3b8" stroke-width="1.2"/>
    <rect x="16" y="44" width="72" height="61" rx="3" fill="url(#bf)" stroke="#94a3b8" stroke-width="1.2"/>
    <polygon points="16,44 32,33 104,33 88,44" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.2"/>
    <rect x="47" y="44" width="10" height="61" fill="${c}"/><polygon points="47,44 57,44 73,33 63,33" fill="${c}"/><polygon points="88,68 104,57 104,64 88,75" fill="${c}" opacity="0.85"/>
    <path d="M60 33 C48 18 38 26 52 33 Z M66 33 C78 18 88 26 74 33 Z" fill="${c}" stroke="rgba(0,0,0,0.25)" stroke-width="1"/><circle cx="63" cy="32" r="4" fill="${c}"/>
    <circle cx="52" cy="76" r="20" fill="#fff" stroke="${c}" stroke-width="3.5"/>${emb(k, 37, 61, 30)}</svg>`);
}
function cardArt(k, c, top, val, small = '') {
  return uniqSvg(`<svg viewBox="0 0 90 120" class="ia ia-card"><defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e6ebf2"/></linearGradient></defs>
    <rect x="4" y="4" width="82" height="112" rx="9" fill="url(#cg)" stroke="${c}" stroke-width="3"/>
    <path d="M4 13 a9 9 0 0 1 9 -9 h64 a9 9 0 0 1 9 9 v15 h-82z" fill="${c}"/>
    <text x="45" y="22" text-anchor="middle" font-size="11" font-weight="900" fill="#fff" font-family="sans-serif" letter-spacing="1">${top}</text>
    <circle cx="45" cy="58" r="22" fill="#fff" stroke="${c}" stroke-opacity="0.35" stroke-width="2"/>${emb(k, 25, 38, 40)}
    <text x="45" y="102" text-anchor="middle" font-size="${String(val).length > 4 ? 15 : 18}" font-weight="900" fill="${c}" font-family="sans-serif">${val}</text>
    ${small ? `<text x="45" y="112" text-anchor="middle" font-size="7.5" font-weight="800" fill="#64748b" font-family="sans-serif">${small}</text>` : ''}
    <path d="M10 34 L28 34 L14 112 L8 112z" fill="#fff" opacity="0.35"/></svg>`);
}
const EXP_COL = { 100: '#22c55e', 250: '#3b82f6', 500: '#a855f7', 1000: '#f59e0b' };
const ENH_COL = [null, '#64748b', '#b87333', '#9ca3af', '#eab308', '#5eb8c4', '#10b981', '#38bdf8', '#a855f7', '#f97316', '#ef4444'];
const LB_COL = { 300: '#64748b', 500: '#22c55e', 600: '#14b8a6', 1000: '#3b82f6', 1500: '#a855f7', 3000: '#eab308', 4500: '#ef4444' };
const expCardArt = e => cardArt('train', EXP_COL[e] || '#22c55e', '훈련 카드', `+${e}`, 'EXP');
const enhCardArt = l => cardArt('enh', ENH_COL[l] || '#64748b', '강화 카드', `${l}강`);
const lbCardArt = e => cardArt('lb', LB_COL[e] || '#7c3aed', '한계 돌파', String(e), 'EXP');
const BS_PACK_SVG = `<svg viewBox="0 0 120 120" class="ia"><defs><linearGradient id="bp1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#1e3a8a"/></linearGradient></defs><rect x="26" y="18" width="62" height="84" rx="8" fill="#0f172a" stroke="#64748b" stroke-width="2" transform="rotate(-10 57 60)"/><rect x="34" y="16" width="62" height="86" rx="8" fill="url(#bp1)" stroke="#e0f2fe" stroke-width="2.5"/><text x="65" y="56" text-anchor="middle" font-size="22" font-weight="900" fill="#fff" font-family="sans-serif">BS</text><text x="65" y="82" text-anchor="middle" font-size="26" font-weight="900" fill="#fde047" font-family="sans-serif">?</text></svg>`;
const ITEM_ART = {
  get bsPack() { return uniqSvg(BS_PACK_SVG); },
  get redist() { return ITEM_ART.redistTk; },
  get spTk() { return ITEM_ART.spTkCard; },
  get trainBox() { return boxArt('train', '#64748b'); },
  get breakBox() { return boxArt('break', '#1f2937'); },
  get enhBox() { return boxArt('enh', '#0284c7'); },
  get breakTk() { return cardArt('break', '#1f2937', '훈련 돌파권', '돌파권'); },
  get redistTk() { return cardArt('redist', '#d97706', '훈련 재분배', '재분배권'); },
  get spTkCard() { return cardArt('sprd', '#a855f7', '특훈 재분배', '재분배권'); },
};
let shopBuy = null;
function renderShop() {
  const el = $('shop-body');
  if (!el) return;
  const v = ensureInv();
  const own = { trainBox: v.trainBox, breakBox: v.breakBox, redist: v.redist, spTk: v.spTk, enhBox: v.enhBox, bsPack: v.bsPack };
  const feat = SHOP[1];
  el.innerHTML = `
    <div class="shop-hero">
      <div class="shop-banner">
        <div class="sb-chain"></div>
        <div class="sb-sub">APEX FOOTBALL</div>
        <div class="sb-title">TRAINING SHOP</div>
        <div class="sb-desc">훈련박스 · 훈련돌파박스 · 훈련 재분배권 · 특훈 재분배권 · 강화 박스</div>
        <div class="sb-art">${ITEM_ART.trainBox}${ITEM_ART.breakBox}${ITEM_ART.redist}</div>
      </div>
      <div class="shop-feat" data-id="${feat.id}">
        <div class="sf-h">추천 상품</div>
        <div class="sf-body"><div class="sf-art">${ITEM_ART[feat.id]}</div><div><b>${feat.name}</b><div class="sf-price"><span class="coin">A</span> ${feat.price.toLocaleString()}</div></div></div>
        <div class="sf-bar">보유 ${own[feat.id]}개</div>
      </div>
    </div>
    <div class="shop-row">${SHOP.map(it => `
      <button type="button" class="shop-item" data-id="${it.id}">
        <div class="si-art">${ITEM_ART[it.id]}</div>
        <div class="si-bar">보유 ${own[it.id]}개</div>
        <div class="si-name">${it.name}</div>
        <div class="si-price"><span class="coin">A</span> ${it.price.toLocaleString()}</div>
      </button>`).join('')}</div>`;
  el.querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => openBuy(b.dataset.id)));
  animNum($('shop-coin'), userSetup.coins || 0);
}
function openBuy(id) {
  shopBuy = { id, n: 1 };
  renderBuy();
}
function renderBuy() {
  const el = $('buy-pop');
  if (!el || !shopBuy) return;
  const it = SHOP.find(s => s.id === shopBuy.id);
  const coins = userSetup.coins || 0;
  const maxN = () => Math.max(1, Math.min(999, Math.floor((userSetup.coins || 0) / it.price)));
  shopBuy.n = clamp(shopBuy.n, 1, maxN());
  el.innerHTML = `<div class="bp-box">
    <div class="bp-title">상품 구매</div>
    <div class="bp-grid">
      <div class="bp-art">${ITEM_ART[it.id]}</div>
      <div class="bp-info">
        <div class="bp-name">${it.name}</div>
        <div class="bp-desc">${escapeHtml(it.desc)}</div>
        <div class="bp-line"></div>
        <div class="bp-row"><span>보유금액</span><b>${coins.toLocaleString()}</b></div>
        <div class="bp-row green"><span>가격</span><b>${it.price.toLocaleString()}</b></div>
        <div class="bp-row"><span>수량 <small class="bp-max">(최대 ${maxN()}개)</small></span><span class="bp-qty"><input type="text" inputmode="numeric" id="bp-n" maxlength="3" value="${shopBuy.n}" title="눌러서 숫자로 입력"><span><button type="button" id="bp-up">▲</button><button type="button" id="bp-dn">▼</button></span></span></div>
        <div class="bp-total"><span>총 결제금액</span><b><span id="bp-total"></span> <span class="coin">A</span></b></div>
        <div class="bp-btns"><button type="button" class="bp-buy" id="bp-buy">구매</button><button type="button" class="bp-cancel" id="bp-cancel">취소</button></div>
      </div>
    </div></div>`;
  el.classList.add('show');
  const inp = $('bp-n');
  // 창은 다시 그리지 않고 숫자만 바꿈 (창이 흔들리지 않게)
  const update = (fromTyping = false) => {
    const total = it.price * shopBuy.n;
    if (!fromTyping && inp) inp.value = shopBuy.n;
    $('bp-total').textContent = total.toLocaleString();
    $('bp-buy').disabled = (userSetup.coins || 0) < total;
  };
  update();
  const step = d => { shopBuy.n = clamp(shopBuy.n + d, 1, maxN()); update(); };
  $('bp-up')?.addEventListener('click', () => step(1));
  $('bp-dn')?.addEventListener('click', () => step(-1));
  inp?.addEventListener('focus', () => inp.select());
  inp?.addEventListener('click', () => inp.select());
  inp?.addEventListener('input', () => {
    const digits = inp.value.replace(/\D/g, '');
    if (digits !== inp.value) inp.value = digits;
    if (!digits) return; // 지우는 중에는 그대로 둠
    shopBuy.n = clamp(Number(digits), 1, maxN());
    if (String(shopBuy.n) !== digits) inp.value = shopBuy.n;
    update(true);
  });
  inp?.addEventListener('blur', () => { if (!inp.value) inp.value = shopBuy.n; });
  inp?.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'ArrowUp') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); step(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); $('bp-buy')?.click(); }
  });
  $('bp-cancel')?.addEventListener('click', () => { el.classList.remove('show'); shopBuy = null; });
  $('bp-buy')?.addEventListener('click', () => {
    if (!shopBuy) return;
    const v = ensureInv();
    const t2 = it.price * shopBuy.n;
    if ((userSetup.coins || 0) < t2) { toast('A코인이 부족해요'); return; }
    userSetup.coins -= t2;
    v[it.id] += shopBuy.n;
    saveSetup();
    toast(`${it.name} ${shopBuy.n}개 구매 완료!`);
    el.classList.remove('show');
    shopBuy = null;
    renderShop();
  });
}

// ===== 상자 개봉 연출 (상자가 빛나며 열림 → 카드 등장 → 획득 아이템) =====
let boxAnim = null;
function rarityOf(id, val) {
  if (id === 'enhBox') return ['r0', 'r0', 'r1', 'r2', 'r3', 'r3', 'r3', 'r3', 'r3', 'r3', 'r3'][val] || 'r0';
  if (id === 'bsPack') return val >= 85 ? 'r3' : val >= 75 ? 'r2' : val >= 64 ? 'r1' : 'r0';
  const order = id === 'trainBox' ? [100, 250, 500, 1000] : [1, 2, 5, 10];
  return ['r0', 'r1', 'r2', 'r3'][order.indexOf(val)] || 'r0';
}
function openBox(id, n = 1) {
  const v = ensureInv();
  n = Math.min(n, v[id]);
  if (n <= 0 || boxAnim || packFx) return;
  const got = {};
  let best = 0;
  for (let i = 0; i < n; i++) {
    v[id]--;
    let val;
    if (id === 'trainBox') { val = rollTable([[100, 0.5], [250, 0.35], [500, 0.1], [1000, 0.05]]); v.exp[val]++; }
    else if (id === 'enhBox') { val = rollTable(ENH_TABLE); v.enhCard[val]++; }
    else if (id === 'bsPack') { val = Math.floor(Math.random() * playerDb().length); addCard(val); } // 모든 선수 같은 확률 → 보관함
    else { val = rollTable([[1, 0.5], [2, 0.3], [5, 0.15], [10, 0.05]]); v.breakTk += val; }
    got[val] = (got[val] || 0) + 1;
    best = id === 'bsPack' ? Math.max(best, tplOf(val).ovr) : Math.max(best, val);
  }
  saveSetup();
  renderItems();
  if (id === 'bsPack') { openPackFx(Object.entries(got).flatMap(([val, c]) => Array(c).fill(Number(val)))); return; }
  const el = $('box-open');
  if (!el) return;
  const name = id === 'trainBox' ? '훈련박스' : id === 'enhBox' ? '강화 박스' : id === 'bsPack' ? 'BS 랜덤 선수팩' : '훈련돌파박스';
  const cards = Object.entries(got).sort((a, b) => b[0] - a[0]).map(([val, c]) => {
    if (id === 'bsPack') { const T = tplOf(Number(val)); return `<div class="bo-card ${rarityOf(id, T.ovr)} pk"><div class="bc-in"><small>${T.pos} · ${clubName(T.club)}</small><b>${T.ovr}</b><em>${escapeHtml(T.name)}</em></div><div class="bc-cnt">× ${c}</div></div>`; }
    const r = rarityOf(id, Number(val));
    const art = id === 'trainBox' ? expCardArt(Number(val)) : id === 'enhBox' ? enhCardArt(Number(val)) : ITEM_ART.breakTk;
    return `<div class="bo-card ${r} art"><div class="bc-art">${art}</div>${id === 'breakBox' ? `<small class="bc-sub">돌파권 ${val}장</small>` : ''}<div class="bc-cnt">× ${c}</div></div>`;
  }).join('');
  const list = Object.entries(got).sort((a, b) => b[0] - a[0]).map(([val, c]) => `<div class="bo-li"><span>${id === 'trainBox' ? `EXP +${val} 카드` : id === 'enhBox' ? `${val}강 강화 카드` : id === 'bsPack' ? `${escapeHtml(tplOf(Number(val)).name)} (${tplOf(Number(val)).pos} ${tplOf(Number(val)).ovr}) → 보관함` : `훈련 돌파권 ${val}장`}</span><b>${c}개</b></div>`).join('');
  el.innerHTML = `
    <div class="bo-title">${name} <small>${n}개 개봉</small></div>
    <div class="bo-stage">
      <div class="bo-glow ${rarityOf(id, best)}"></div>
      <div class="bo-box">${ITEM_ART[id]}<div class="bo-lid"></div></div>
      <div class="bo-beam"></div>
      <div class="bo-silhouette"></div>
      <div class="bo-cards ${Object.keys(got).length > 5 ? 'many' : ''}" id="bo-cards">${cards}</div>
      ${Object.keys(got).length > 5 ? `<div class="bo-more">← 마우스 휠로 좌우 이동 · 전체 ${Object.keys(got).length}종 →</div>` : ''}
    </div>
    <div class="bo-got"><div class="bo-gh">획득한 아이템 <b>${Object.values(got).reduce((a, b) => a + b, 0)}개</b></div><div class="bo-list">${list}</div></div>
    <div class="bo-btns">
      ${v[id] > 0 ? `<button type="button" class="btn ghost" id="bo-again">1개 더 개봉 (남은 ${v[id]}개)</button>` : ''}
      <button type="button" class="btn" id="bo-ok">확인</button>
    </div>
    <div class="bo-skip">클릭하면 건너뛰기</div>`;
  el.className = 'show s1';
  wheelX($('bo-cards')); wheelX(el.querySelector('.bo-list'));
  boxAnim = { t: [] };
  const go = (cls, ms) => boxAnim.t.push(setTimeout(() => { el.className = 'show ' + cls; }, ms));
  go('s2', 1150); go('s3', 1650); go('s4', 2350);
  boxAnim.t.push(setTimeout(() => { boxAnim = null; }, 2400));
  el.onclick = e => {
    if (e.target.id === 'bo-ok') { el.className = ''; return; }
    if (e.target.id === 'bo-again') { el.className = ''; boxAnim = null; openBox(id, 1); return; }
    if (boxAnim) { boxAnim.t.forEach(clearTimeout); boxAnim = null; el.className = 'show s4'; }
  };
}

// ===================== BS 선수팩 개봉 연출 =====================
// 경기장 입장 터널: 카드가 빛나며 선수가 되어 터널로 걸어 들어감 → 카메라가 터널을 따라 걸어 나감 → 출구 빛 속에 국적 · 포지션 · 소속 구단 → 흰 섬광 → 경기장 무대에서 공개
// 여러 장이면: 가장 오버롤 높은 선수를 메인으로, 나머지는 아래 줄(마우스 휠로 좌우 이동)
const PACK_FX = { back: 1250, rush: 1750, flag: 2500, pos: 3300, club: 4100, flash: 4900, stage: 5300 }; // 단계별 시작 시각(ms)
const packTier = ovr => (ovr >= 80 ? 't3' : ovr >= 72 ? 't2' : ovr >= 66 ? 't1' : 't0');
const FLAG_SVG = {
  '대한민국': '<rect width="60" height="40" fill="#fff"/><path d="M30 12a8 8 0 0 1 0 16a4 4 0 0 1 0-8a4 4 0 0 0 0-8z" fill="#c60c30"/><path d="M30 28a8 8 0 0 1 0-16a4 4 0 0 1 0 8a4 4 0 0 0 0 8z" fill="#003478"/><g fill="#000"><rect x="8" y="6" width="9" height="2" transform="rotate(34 12 7)"/><rect x="8" y="10" width="9" height="2" transform="rotate(34 12 11)"/><rect x="43" y="28" width="9" height="2" transform="rotate(34 47 29)"/><rect x="43" y="32" width="9" height="2" transform="rotate(34 47 33)"/><rect x="43" y="6" width="9" height="2" transform="rotate(-34 47 7)"/><rect x="8" y="30" width="9" height="2" transform="rotate(-34 12 31)"/></g>',
  '스페인': '<rect width="60" height="40" fill="#c60b1e"/><rect y="10" width="60" height="20" fill="#ffc400"/>',
  '브라질': '<rect width="60" height="40" fill="#009c3b"/><path d="M30 4 56 20 30 36 4 20z" fill="#ffdf00"/><circle cx="30" cy="20" r="8" fill="#002776"/>',
  '잉글랜드': '<rect width="60" height="40" fill="#fff"/><rect x="26" width="8" height="40" fill="#ce1124"/><rect y="16" width="60" height="8" fill="#ce1124"/>',
  '독일': '<rect width="60" height="40" fill="#000"/><rect y="13.3" width="60" height="13.4" fill="#dd0000"/><rect y="26.6" width="60" height="13.4" fill="#ffce00"/>',
  '프랑스': '<rect width="60" height="40" fill="#fff"/><rect width="20" height="40" fill="#0055a4"/><rect x="40" width="20" height="40" fill="#ef4135"/>',
  '이탈리아': '<rect width="60" height="40" fill="#fff"/><rect width="20" height="40" fill="#009246"/><rect x="40" width="20" height="40" fill="#ce2b37"/>',
  '일본': '<rect width="60" height="40" fill="#fff"/><circle cx="30" cy="20" r="11" fill="#bc002d"/>',
  '네덜란드': '<rect width="60" height="40" fill="#fff"/><rect width="60" height="13.3" fill="#ae1c28"/><rect y="26.6" width="60" height="13.4" fill="#21468b"/>',
  '아르헨티나': '<rect width="60" height="40" fill="#74acdf"/><rect y="13.3" width="60" height="13.4" fill="#fff"/><circle cx="30" cy="20" r="4" fill="#f6b40e"/>',
  '포르투갈': '<rect width="60" height="40" fill="#da291c"/><rect width="24" height="40" fill="#046a38"/><circle cx="24" cy="20" r="7" fill="#ffe900" stroke="#da291c" stroke-width="1.5"/>',
  '스웨덴': '<rect width="60" height="40" fill="#006aa7"/><rect x="17" width="7" height="40" fill="#fecc00"/><rect y="16.5" width="60" height="7" fill="#fecc00"/>',
  '미국': '<rect width="60" height="40" fill="#fff"/><g fill="#b22234">' + Array.from({ length: 7 }, (_, k) => `<rect y="${k * 6.16}" width="60" height="3.08"/>`).join('') + '</g><rect width="26" height="21.5" fill="#3c3b6e"/>',
  '가나': '<rect width="60" height="40" fill="#006b3f"/><rect width="60" height="26.6" fill="#fcd116"/><rect width="60" height="13.3" fill="#ce1126"/><path d="M30 14l1.8 5.4h5.6l-4.5 3.3 1.7 5.4-4.6-3.3-4.6 3.3 1.7-5.4-4.5-3.3h5.6z" fill="#000"/>',
  '크로아티아': '<rect width="60" height="40" fill="#fff"/><rect width="60" height="13.3" fill="#ff0000"/><rect y="26.6" width="60" height="13.4" fill="#171796"/><g transform="translate(24 10)"><rect width="12" height="14" fill="#fff" stroke="#171796"/>' + Array.from({ length: 12 }, (_, k) => `<rect x="${(k % 3) * 4 + ((Math.floor(k / 3) % 2) ? 0 : 0)}" y="${Math.floor(k / 3) * 3.5}" width="4" height="3.5" fill="${(k + Math.floor(k / 3)) % 2 ? '#fff' : '#ff0000'}"/>`).join('') + '</g>',
  '모로코': '<rect width="60" height="40" fill="#c1272d"/><path d="M30 11l2.6 8h8.4l-6.8 5 2.6 8-6.8-5-6.8 5 2.6-8-6.8-5h8.4z" fill="none" stroke="#006233" stroke-width="1.6"/>',
};
const flagSvg = n => `<svg viewBox="0 0 60 40" preserveAspectRatio="none">${FLAG_SVG[n] || '<rect width="60" height="40" fill="#94a3b8"/>'}</svg>`;
let packFx = null;
function wheelX(el) { el?.addEventListener('wheel', e => { if (el.scrollWidth <= el.clientWidth) return; e.preventDefault(); el.scrollLeft += (Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX); }, { passive: false }); }
function openPackFx(tids) {
  const el = $('pack-open');
  if (!el || !tids.length) return;
  const all = tids.map(tplOf).sort((a, b) => b.ovr - a.ovr || a.tid - b.tid);
  const best = all[0];
  const tier = packTier(best.ovr);
  const club = TEAM_COLORS.find(c => c.id === best.club);
  const crest = `<svg viewBox="0 0 64 72">${crestSvg(club ? club.css : '#64748b', escapeHtml((club ? clubName(club.id) : '자').slice(0, 1)))}</svg>`;
  el.innerHTML = `
    <div class="pk-tunnel"><div class="pk-cam"><div class="pk-3d">
      <i class="pkw floor"></i><i class="pkw ceil"></i><i class="pkw left"></i><i class="pkw right"></i>
      <i class="pkw exit"><b class="ex-stand"></b><b class="ex-pitch"></b></i>
    </div></div><div class="pk-vig"></div>
    <svg class="pk-walker" viewBox="0 0 60 120"><circle cx="30" cy="12" r="9"/><path d="M18 26h24l4 40h-8l-2 50h-9l-1-34-1 34h-9l-2-50h-8z"/></svg></div>
    <div class="pk-back"><b>BS</b><small>${CARD_SEASON}</small></div>
    <div class="pk-panel pk-flag">${flagSvg(best.nation)}<span>${escapeHtml(best.nation)}</span></div>
    <div class="pk-panel pk-pos"><b>${best.pos}</b></div>
    <div class="pk-panel pk-club">${crest}<span>${escapeHtml(clubName(best.club))}</span></div>
    <div class="pk-flash"></div>
    <div class="pk-stage">
      <div class="pk-lights"></div>
      <div class="pk-banner" id="pk-banner"></div>
      <div class="pk-strip-wrap">${all.length > 1 ? `<div class="pk-strip-h">획득 선수 <b>${all.length}명</b> <small>마우스 휠로 좌우 이동 · 눌러서 크게 보기</small></div><div class="pk-strip" id="pk-strip">${all.map((T, k) => `<button type="button" class="pk-mini ${packTier(T.ovr)} ${k === 0 ? 'on' : ''}" data-k="${k}">${dexCard(T)}<small>${T.pos}</small></button>`).join('')}</div>` : ''}</div>
      <div class="pk-btns">${ensureInv().bsPack > 0 ? `<button type="button" class="btn ghost" id="pk-again">1개 더 개봉 (남은 ${ensureInv().bsPack}개)</button>` : ''}<button type="button" class="btn" id="pk-ok">확인</button></div>
    </div>
    <div class="pk-skip">클릭하면 건너뛰기</div>`;
  const showMain = k => {
    const T = all[k], g = foGroups(T.fo, T.pos === 'GK');
    const c = TEAM_COLORS.find(x => x.id === T.club);
    $('pk-banner').innerHTML = `<div class="pkb-bg" style="--cc:${c ? c.css : '#475569'}"></div>
      <div class="pkb-l"><b class="pkb-ovr">${T.ovr}</b><small>${T.pos} · ${escapeHtml(T.nation)}</small><em>${escapeHtml(clubName(T.club))}</em></div>
      <div class="pkb-card ${packTier(T.ovr)}">${dexCard(T, 'big')}</div>
      <div class="pkb-r"><b class="pkb-ovr">${T.ovr}</b><div class="pkb-st">${g.map(([n, v]) => `<div><small>${n}</small><b>${v}</b></div>`).join('')}</div></div>
      <div class="pkb-name"><span>BS ${escapeHtml(T.name)}</span><small>${T.pos} · ${escapeHtml(T.nation)} · ${escapeHtml(clubName(T.club))} → 보관함</small></div>`;
    el.querySelectorAll('.pk-mini').forEach(b => b.classList.toggle('on', Number(b.dataset.k) === k));
  };
  showMain(0);
  el.className = `show ${tier} p1`;
  packFx = { t: [] };
  const at = (cls, ms) => packFx.t.push(setTimeout(() => { el.className = `show ${tier} ${cls}`; }, ms));
  at('p2', PACK_FX.back); at('p3', PACK_FX.rush); at('p4', PACK_FX.flag); at('p5', PACK_FX.pos); at('p6', PACK_FX.club); at('p7', PACK_FX.flash); at('p8', PACK_FX.stage);
  packFx.t.push(setTimeout(() => { packFx = null; }, PACK_FX.stage + 50));
  wheelX($('pk-strip'));
  el.onclick = e => {
    const id = e.target.closest('button')?.id;
    const mini = e.target.closest('.pk-mini');
    if (packFx) { packFx.t.forEach(clearTimeout); packFx = null; el.className = `show ${tier} p8`; return; }
    if (mini) { showMain(Number(mini.dataset.k)); return; }
    if (id === 'pk-ok') { el.className = ''; return; }
    if (id === 'pk-again') { el.className = ''; openBox('bsPack', 1); }
  };
}

// ===== 숫자가 촤르륵 올라가는 표시 =====
function animNum(el, to) {
  if (!el) return;
  const from = Number(el.dataset.v ?? to);
  el.dataset.v = to;
  if (from === to || typeof requestAnimationFrame === 'undefined') { el.textContent = to.toLocaleString(); return; }
  const t0 = performance.now(), dur = 650;
  const step = now => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(from + (to - from) * e).toLocaleString();
    if (k < 1 && el.dataset.v == to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ===== 패널이 열릴 때 부드럽게 등장 =====
function panelEnter(el) {
  if (!el) return;
  el.classList.remove('enter');
  void el.offsetWidth;
  el.classList.add('enter');
  clearTimeout(el._enterT);
  el._enterT = setTimeout(() => el.classList.remove('enter'), 900);
}

// ===== 축구공 텍스처: 깎은 정이십면체(오각형 12 · 육각형 20) + 이음새 =====
function makeSoccerBallTextures() {
  const W = 1024, H = 512;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const b = document.createElement('canvas'); b.width = W; b.height = H;
  const g = c.getContext && c.getContext('2d'), gb = b.getContext && b.getContext('2d');
  if (!g || typeof ImageData === 'undefined' || !g.createImageData) return null;
  const P = (1 + Math.sqrt(5)) / 2, iP = 1 / P;
  const norm = v => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  const pent = [], hex = [];
  for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
    pent.push(norm([0, s1, s2 * P]), norm([s1, s2 * P, 0]), norm([s2 * P, 0, s1]));
    hex.push(norm([0, s1 * P, s2 * iP]), norm([s1 * iP, 0, s2 * P]), norm([s2 * P, s1 * iP, 0]));
    for (const s3 of [-1, 1]) hex.push(norm([s1, s2, s3]));
  }
  const centers = pent.map(v => [v[0] / 2.32744, v[1] / 2.32744, v[2] / 2.32744, 1]).concat(hex.map(v => [v[0] / 2.26728, v[1] / 2.26728, v[2] / 2.26728, 0]));
  const img = g.createImageData(W, H), bimg = gb.createImageData(W, H);
  const d = img.data, bd = bimg.data;
  for (let y = 0; y < H; y++) {
    const th = (y + 0.5) / H * Math.PI, st = Math.sin(th), ct = Math.cos(th);
    for (let x = 0; x < W; x++) {
      const ph = (x + 0.5) / W * Math.PI * 2;
      const dx = -Math.cos(ph) * st, dy = ct, dz = Math.sin(ph) * st;
      let m1 = -2, m2 = -2, isP = 0;
      for (const cc of centers) {
        const dd = dx * cc[0] + dy * cc[1] + dz * cc[2];
        if (dd > m1) { m2 = m1; m1 = dd; isP = cc[3]; } else if (dd > m2) m2 = dd;
      }
      const edge = m1 - m2; // 0 = 이음새
      const seam = Math.min(1, edge / 0.0075);
      const shade = 0.88 + 0.12 * Math.min(1, edge / 0.05); // 패널이 살짝 볼록
      let r, gg, bl;
      if (isP) { r = 22; gg = 26; bl = 38; } else { r = 246; gg = 247; bl = 250; }
      const sCol = isP ? 40 : 150;
      r = (r * shade) * seam + sCol * (1 - seam); gg = (gg * shade) * seam + sCol * (1 - seam); bl = (bl * shade) * seam + (sCol + 8) * (1 - seam);
      const i = (y * W + x) * 4;
      d[i] = r; d[i + 1] = gg; d[i + 2] = bl; d[i + 3] = 255;
      const bv = 255 * (0.35 + 0.65 * seam);
      bd[i] = bd[i + 1] = bd[i + 2] = bv; bd[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0); gb.putImageData(bimg, 0, 0);
  const map = srgb(new THREE.CanvasTexture(c));
  map.anisotropy = 4;
  return { map, bump: new THREE.CanvasTexture(b) };
}

function startMatchFromMenu() {
  if (!userSetup.colorId) { openClubSetup(true); return; }
  userSetup.oppColorId = pickOppColor(userSetup.colorId);
  const forms = Object.keys(FORMATIONS);
  userSetup.cpuFormation = forms[Math.floor(Math.random() * forms.length)];
  if (menuRoot) menuRoot.classList.remove('show');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // SPACE가 버튼을 다시 누르지 않게
  resetMatch();
}

$('btn-game-start')?.addEventListener('click', () => openLeagueSelect('pick'));
$('btn-fk')?.addEventListener('click', openFkPick);
$('btn-pk')?.addEventListener('click', pkMode);
$('btn-apc')?.addEventListener('click', () => openApc());
for (const id of ['btn-shop-back', 'btn-items-back', 'btn-market-back', 'btn-store-back', 'btn-tactics-back']) $(id)?.addEventListener('click', showTitleMenu);
$('btn-train-back')?.addEventListener('click', () => { if (!trainUi.anim) openPlayerMgmt(); });
document.querySelectorAll('#tabbar button').forEach(b => b.addEventListener('click', () => { if (trainUi.anim) return; goMenu(b.dataset.tab); }));
$('btn-logout2')?.addEventListener('click', () => logout());
$('btn-live')?.addEventListener('click', () => toast('🚧 실시간 매치는 제작 중인 기능이에요'));
applyAspect();
$('btn-shop-items')?.addEventListener('click', openItems);
$('btn-items-shop')?.addEventListener('click', openShop);
document.querySelectorAll('#menu-train .tr-tab').forEach(b => b.addEventListener('click', () => { if (trainUi.anim) return; trainUi.tab = b.dataset.tab; trainUi.stick = null; trainUi.retab = true; spUi = { k: null, res: null }; renderTraining(); panelEnter($('menu-train')); }));
$('btn-guide-close')?.addEventListener('click', () => $('guide')?.classList.remove('show'));
document.querySelectorAll('#guide .g-tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#guide .g-tabs button').forEach(x => x.classList.toggle('on', x === b));
  const grow = b.dataset.gt === 'grow';
  const g = document.querySelector('#guide .g-grow'), c = document.querySelector('#guide .g-ctl');
  if (g) g.style.display = grow ? '' : 'none';
  if (c) c.style.display = grow ? 'none' : '';
}));
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => goMenu(b.dataset.go)));
$('btn-team-back')?.addEventListener('click', () => openClubInfo());
$('btn-club-save')?.addEventListener('click', saveClub);
$('club-name-input')?.addEventListener('input', updateClubPreview);
$('btn-squad-back')?.addEventListener('click', () => leaveSquad(showTitleMenu));
$('btn-squad-save')?.addEventListener('click', squadCommit);
$('btn-league-back')?.addEventListener('click', () => { if (lgView === 'season') { lgView = 'pick'; renderLeagueChips(); renderSeason(); } else showTitleMenu(); });
$('btn-play-match')?.addEventListener('click', seasonGo);
$('btn-league-reset')?.addEventListener('click', () => {
  const b = $('btn-league-reset');
  if (!b.dataset.armed) {
    b.dataset.armed = '1';
    b.textContent = '한 번 더 누르면 초기화돼요 (시즌 기록 삭제)';
    setTimeout(() => { delete b.dataset.armed; b.textContent = '리그 초기화'; }, 3000);
    return;
  }
  delete b.dataset.armed;
  b.textContent = '리그 초기화';
  newSeason();
  renderLeagueChips();
  renderSeason();
  toast('리그를 초기화했어요 — 새 리그를 고를 수 있어요');
});
$('btn-login')?.addEventListener('click', () => submitLogin(false));
$('btn-register')?.addEventListener('click', () => submitLogin(true));
$('btn-logout')?.addEventListener('click', logout);
$('login-pw')?.addEventListener('keydown', e => { if (e.key === 'Enter') submitLogin(false); });
$('login-id')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('login-pw')?.focus(); });
$('menu-intro')?.addEventListener('click', showLogin);

// 인트로부터 시작 (뒤에는 경기장과 선수 한 명)
rebuildTeamsFromSetup();
placeForKickoff(true);
showIntro();
requestAnimationFrame(loop);
