import * as THREE from 'three';

const STEP_SIZE        = 0.08;
const BRANCH_CHANCE    = 0.015;
const BRANCH_MIN_AGE   = 10; //30
const BRANCH_SPREAD    = 0.5;
const INITIAL_SPREAD   = 1.5; //0.90
const MAX_TIPS         = 20;
const MAX_PATH_LEN     = 300;
const TIP_GLOW_LEN     = 35;
const STEP_INTERVAL    = 10; //4 this is how fast the simulated roots grow.
const GRAVITY          = 0.07;
const WANDER           = 0.4;
const MOMENTUM_STEPS   = 15;
const MOMENTUM_BOOST   = 3.5; 
const MOMENTUM_GRAVITY = 0.04;
const ATTRACT_DIST     = 4.0;
const ATTRACT_STRENGTH = 0.15; //0.1
const FLASH_DECAY      = 0.0; //0.06 the higher this value is the faster the flash fades. 
const BODY_COLOR = '#750e62';
const TIP_COLOR  = '#ef40e3';
const FLASH_COLOR = new THREE.Color(TIP_COLOR);

const _ab    = new THREE.Vector3();
const _ap    = new THREE.Vector3();
const _dummy = new THREE.Object3D();
const _trailGeo = new THREE.SphereGeometry(0.07, 6, 5);

function closestPointOnEdge(pos, edge) {
  _ab.subVectors(edge.end, edge.start);
  _ap.subVectors(pos, edge.start);
  const t = Math.max(0, Math.min(1, _ap.dot(_ab) / _ab.dot(_ab)));
  return new THREE.Vector3().copy(edge.start).addScaledVector(_ab, t);
}

class RootTip {
  constructor(startPos, bodyColor, tipColor, parentDir = null) {
    this.bodyColor = bodyColor;
    this.tipColor  = tipColor;
    this.alive     = true;
    this.age       = 0;
    this.pos       = startPos.clone();

    if (parentDir) {
      const spread = new THREE.Vector3((Math.random()-0.5), -0.3, (Math.random()-0.5)).normalize();
      this.dir = parentDir.clone().lerp(spread, BRANCH_SPREAD).normalize();
    } else {
      const theta = Math.random() * Math.PI * 2;
      const phi   = INITIAL_SPREAD * Math.random() * Math.PI / 2;
      this.dir = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        -Math.cos(phi),
        Math.sin(phi) * Math.sin(theta)
      ).normalize();
    }

    this._posData = new Float32Array(MAX_PATH_LEN * 3);
    this._colData = new Float32Array(MAX_PATH_LEN * 3);
    this._count   = 0;

    this._geo = new THREE.BufferGeometry();
    this._geo.setAttribute('position', new THREE.BufferAttribute(this._posData, 3));
    this._geo.setAttribute('color',    new THREE.BufferAttribute(this._colData, 3));
    this._geo.setDrawRange(0, 0);

    this.mesh = new THREE.Line(this._geo, new THREE.LineBasicMaterial({ vertexColors: true }));

    this._trail = new THREE.InstancedMesh(_trailGeo, new THREE.MeshBasicMaterial({ color: bodyColor }), MAX_PATH_LEN);
    this._trail.count = 0;
    this._trail.frustumCulled = false;

    this.sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 8, 8),
      new THREE.MeshBasicMaterial({ color: tipColor })
    );
    this.sphere.position.copy(startPos);

    this._appendPoint(startPos);
  }

  _appendPoint(p) {
    if (this._count >= MAX_PATH_LEN) { this.alive = false; this.sphere.visible = false; return; }
    const b = this._count * 3;
    this._posData[b] = p.x; this._posData[b + 1] = p.y; this._posData[b + 2] = p.z;
    this._count++;
    this._refreshTipColors();
    this._geo.attributes.position.needsUpdate = true;
    this._geo.attributes.color.needsUpdate    = true;
    this._geo.setDrawRange(0, this._count);
    _dummy.position.set(p.x, p.y, p.z);
    _dummy.updateMatrix();
    this._trail.setMatrixAt(this._count - 1, _dummy.matrix);
    this._trail.instanceMatrix.needsUpdate = true;
    this._trail.count = this._count;
  }

  _refreshTipColors() {
    const n = this._count;
    const start = Math.max(0, n - TIP_GLOW_LEN - 1);
    const tmp = new THREE.Color();
    for (let i = start; i < n; i++) {
      const t = Math.max(0, (i - (n - TIP_GLOW_LEN)) / TIP_GLOW_LEN);
      tmp.lerpColors(this.bodyColor, this.tipColor, t);
      const ci = i * 3;
      this._colData[ci] = tmp.r; this._colData[ci + 1] = tmp.g; this._colData[ci + 2] = tmp.b;
    }
  }

  step(edges) {
    if (!this.alive) return;

    const inMomentum = this.age < MOMENTUM_STEPS;
    const g = inMomentum ? MOMENTUM_GRAVITY : GRAVITY;
    const noiseScale = WANDER * (inMomentum ? MOMENTUM_BOOST : 1.0);

    this.dir.y -= g;

    const noise = new THREE.Vector3(
      (Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)
    ).normalize().multiplyScalar(noiseScale);
    this.dir.add(noise);

    let nearestEdge = null, nearest = null, nearestDist = ATTRACT_DIST;
    for (const e of edges) {
      const cp = closestPointOnEdge(this.pos, e);
      const d = this.pos.distanceTo(cp);
      if (d < nearestDist) { nearest = cp; nearestDist = d; nearestEdge = e; }
    }
    if (nearest) {
      nearestEdge.flash = 1.0;
      const pull = nearest.sub(this.pos).normalize();
      this.dir.lerp(pull, ATTRACT_STRENGTH * (1 - nearestDist / ATTRACT_DIST));
    }

    this.dir.normalize();

    const next = this.pos.clone().addScaledVector(this.dir, STEP_SIZE);
    if (next.y < 0) { this.alive = false; this.sphere.visible = false; return; }
    this.pos.copy(next);
    this.sphere.position.copy(next);
    this.age++;
    this._appendPoint(next);
  }
}
// RootSystem manages multiple RootTips and handles the initial explosion and branching logic
class RootSystem {
  constructor(seedPos, bodyColor, tipColor, scene) {
    this.bodyColor = bodyColor;
    this.tipColor  = tipColor;
    this.scene     = scene;
    this.tips      = [];

    // 1. Visual Marker for the origin
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.25, 12, 12),
      new THREE.MeshBasicMaterial({ color: tipColor })
    );
    marker.position.copy(seedPos);
    scene.add(marker);

    // 2. THE EXPLOSION: Spawn multiple tips immediately
    // Increase this number (e.g., 12 or 16) for a denser "fanning" effect
    const initialCount = 10; 
    for (let i = 0; i < initialCount; i++) {
      this._spawnTip(seedPos, null);
    }
  }

  _spawnTip(pos, parentDir) {
    // Safety check to prevent crashing the browser with too many lines
    if (this.tips.length >= MAX_TIPS) return;

    // Passing 'null' for parentDir triggers the "seed burst" math 
    // inside the RootTip constructor
    const tip = new RootTip(pos, this.bodyColor, this.tipColor, parentDir);
    
    this.scene.add(tip.mesh);
    this.scene.add(tip._trail);
    this.scene.add(tip.sphere);
    this.tips.push(tip);
  }

  update(edges) {
    for (const tip of this.tips) {
      if (!tip.alive) continue;
      tip.step(edges);

      // Subsequent branching happens here after the initial burst
      if (tip.age >= BRANCH_MIN_AGE && Math.random() < BRANCH_CHANCE) {
        this._spawnTip(tip.pos.clone(), tip.dir.clone());
      }
    }
  }
}

function updateEdgeColors(edges, lineGeo) {
  const col = lineGeo.attributes.color;
  let dirty = false;
  for (const e of edges) {
    if (e.flash <= 0) continue;
    e.flash = Math.max(0, e.flash - FLASH_DECAY);
    const f = e.flash;
    const off = e.idx * 6;
    col.array[off]     = e.baseColStart * (1 - f) + FLASH_COLOR.r * f;
    col.array[off + 1] = e.baseColStart * (1 - f) + FLASH_COLOR.g * f;
    col.array[off + 2] = e.baseColStart * (1 - f) + FLASH_COLOR.b * f;
    col.array[off + 3] = e.baseColEnd   * (1 - f) + FLASH_COLOR.r * f;
    col.array[off + 4] = e.baseColEnd   * (1 - f) + FLASH_COLOR.g * f;
    col.array[off + 5] = e.baseColEnd   * (1 - f) + FLASH_COLOR.b * f;
    dirty = true;
  }
  if (dirty) col.needsUpdate = true;
}

export function createRootSystems(scene, S, edges, lineGeo) {
  let frame = 0;
  const system = new RootSystem(
    new THREE.Vector3(0, S, 0),
    new THREE.Color(BODY_COLOR),
    new THREE.Color(TIP_COLOR),
    scene
  );
  function update() {
    frame++;
    if (frame % STEP_INTERVAL === 0) system.update(edges);
    updateEdgeColors(edges, lineGeo);
  }
  return { system, update };
}
