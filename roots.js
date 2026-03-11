import * as THREE from 'three';
import { createBiofilm } from './biofilm.js';

const STEP_SIZE        = 0.08;
const BRANCH_CHANCE    = 0.015;
const BRANCH_MIN_AGE   = 10;
const BRANCH_SPREAD    = 0.5;
const INITIAL_SPREAD   = 1.5;
const MAX_TIPS         = 20;
const MAX_PATH_LEN     = 300;
const STEP_INTERVAL    = 10; // higher = slower growth
const GRAVITY          = 0.07;
const WANDER           = 0.4;
const MOMENTUM_STEPS   = 15;
const MOMENTUM_BOOST   = 3.5;
const MOMENTUM_GRAVITY = 0.04;
const ATTRACT_DIST     = 4.0;
const ATTRACT_STRENGTH = 0.15;
const FLASH_DECAY      = 0.0; // higher = faster fade
const FLASH_THICKNESS  = true; // toggle thick (2.0px) overlay on flashed edges
const GRADIENT_STRENGTH = 0.45; // 0 = flat body color, 1 = full body→tip range
const BODY_COLOR = '#24301C'; //'#750e62'; //'#4F531B'
const TIP_COLOR  = '#4F6A33'; //'#ef40e3'; //'#9FA93F'
const FLASH_COLOR = new THREE.Color(TIP_COLOR);

const _ab    = new THREE.Vector3();
const _ap    = new THREE.Vector3();
const _dummy = new THREE.Object3D();
const _col   = new THREE.Color();
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

    this._trail = new THREE.InstancedMesh(_trailGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_PATH_LEN);
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
    _col.lerpColors(this.bodyColor, this.tipColor, ((this._count - 1) / MAX_PATH_LEN) * GRADIENT_STRENGTH);
    this._trail.setColorAt(this._count - 1, _col);
    this._trail.instanceColor.needsUpdate = true;
    this._trail.count = this._count;
  }

  _refreshTipColors() {
    const n = this._count;
    for (let i = 0; i < n; i++) {
      _col.lerpColors(this.bodyColor, this.tipColor, (i / Math.max(1, n - 1)) * GRADIENT_STRENGTH);
      const ci = i * 3;
      this._colData[ci] = _col.r; this._colData[ci + 1] = _col.g; this._colData[ci + 2] = _col.b;
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

class RootSystem {
  constructor(seedPos, bodyColor, tipColor, scene) {
    this.bodyColor = bodyColor;
    this.tipColor  = tipColor;
    this.scene     = scene;
    this.tips      = [];

    this.marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.25, 12, 12),
      new THREE.MeshBasicMaterial({ color: tipColor })
    );
    this.marker.position.copy(seedPos);
    scene.add(this.marker);

    // increase initialCount (e.g. 12–16) for a denser fanning effect
    const initialCount = 10;
    for (let i = 0; i < initialCount; i++) {
      this._spawnTip(seedPos, null);
    }
  }

  _spawnTip(pos, parentDir) {
    if (this.tips.length >= MAX_TIPS) return;
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
      if (tip.age >= BRANCH_MIN_AGE && Math.random() < BRANCH_CHANCE) {
        this._spawnTip(tip.pos.clone(), tip.dir.clone());
      }
    }
  }

  isDone() {
    return this.tips.length > 0 && this.tips.every(t => !t.alive);
  }

  dispose() {
    for (const tip of this.tips) {
      this.scene.remove(tip.mesh);
      this.scene.remove(tip._trail);
      this.scene.remove(tip.sphere);
    }
    this.scene.remove(this.marker);
  }
}

function updateEdgeColors(edges, lineGeo, flashLineGeo) {
  const colStart = lineGeo.attributes.instanceColorStart;
  const colEnd   = lineGeo.attributes.instanceColorEnd;
  let dirty = false;

  // Interleaved buffers: [sx,sy,sz,ex,ey,ez] and [sr,sg,sb,er,eg,eb] per segment
  const fPosBuf  = FLASH_THICKNESS ? flashLineGeo.attributes.instanceStart.data      : null;
  const fColBuf  = FLASH_THICKNESS ? flashLineGeo.attributes.instanceColorStart.data : null;
  let flashCount = 0;

  for (const e of edges) {
    if (e.flash <= 0) continue;
    e.flash = Math.max(0, e.flash - FLASH_DECAY);
    const f = e.flash;

    const off = e.idx * 3;
    colStart.array[off]     = e.baseColStart * (1 - f) + FLASH_COLOR.r * f;
    colStart.array[off + 1] = e.baseColStart * (1 - f) + FLASH_COLOR.g * f;
    colStart.array[off + 2] = e.baseColStart * (1 - f) + FLASH_COLOR.b * f;
    colEnd.array[off]       = e.baseColEnd   * (1 - f) + FLASH_COLOR.r * f;
    colEnd.array[off + 1]   = e.baseColEnd   * (1 - f) + FLASH_COLOR.g * f;
    colEnd.array[off + 2]   = e.baseColEnd   * (1 - f) + FLASH_COLOR.b * f;
    dirty = true;

    // Compact flashing edges into the front of the overlay buffer
    if (FLASH_THICKNESS && f > 0) {
      const pOff = flashCount * 6;
      fPosBuf.array[pOff]     = e.start.x; fPosBuf.array[pOff + 1] = e.start.y; fPosBuf.array[pOff + 2] = e.start.z;
      fPosBuf.array[pOff + 3] = e.end.x;   fPosBuf.array[pOff + 4] = e.end.y;   fPosBuf.array[pOff + 5] = e.end.z;
      fColBuf.array[pOff]     = FLASH_COLOR.r * f; fColBuf.array[pOff + 1] = FLASH_COLOR.g * f; fColBuf.array[pOff + 2] = FLASH_COLOR.b * f;
      fColBuf.array[pOff + 3] = FLASH_COLOR.r * f; fColBuf.array[pOff + 4] = FLASH_COLOR.g * f; fColBuf.array[pOff + 5] = FLASH_COLOR.b * f;
      flashCount++;
    }
  }

  if (dirty) {
    colStart.needsUpdate = true;
    colEnd.needsUpdate   = true;
  }
  if (FLASH_THICKNESS) {
    fPosBuf.needsUpdate = true;
    fColBuf.needsUpdate = true;
    flashLineGeo.instanceCount = flashCount;
  }
}

function resetEdges(edges, lineGeo, flashLineGeo) {
  const colStart = lineGeo.attributes.instanceColorStart;
  const colEnd   = lineGeo.attributes.instanceColorEnd;
  for (const e of edges) {
    e.flash = 0;
    const off = e.idx * 3;
    colStart.array[off]     = colStart.array[off + 1] = colStart.array[off + 2] = e.baseColStart;
    colEnd.array[off]       = colEnd.array[off + 1]   = colEnd.array[off + 2]   = e.baseColEnd;
  }
  colStart.needsUpdate = true;
  colEnd.needsUpdate   = true;
  flashLineGeo.instanceCount = 0;
}

export function createRootSystems(scene, S, edges, lineGeo, flashLineGeo) {
  let frame = 0;
  let pending = false;
  let system  = new RootSystem(
    new THREE.Vector3(0, S, 0),
    new THREE.Color(BODY_COLOR),
    new THREE.Color(TIP_COLOR),
    scene
  );
  const biofilm = createBiofilm(scene, edges);

  function update() {
    frame++;
    if (frame % STEP_INTERVAL === 0) system.update(edges);
    updateEdgeColors(edges, lineGeo, flashLineGeo);
    biofilm.update();

    if (!pending && system.isDone()) {
      pending = true;
      biofilm.startFilling();
      setTimeout(() => {
        system.dispose();
        resetEdges(edges, lineGeo, flashLineGeo);
        biofilm.reset();
        frame   = 0;
        pending = false;
        system  = new RootSystem(
          new THREE.Vector3(0, S, 0),
          new THREE.Color(BODY_COLOR),
          new THREE.Color(TIP_COLOR),
          scene
        );
      }, 3000);
    }
  }

  return { update };
}
