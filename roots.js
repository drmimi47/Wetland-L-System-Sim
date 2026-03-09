import * as THREE from 'three';

const STEP_SIZE      = 0.08;
const BRANCH_CHANCE  = 0.020;
const BRANCH_MIN_AGE = 22;
const BRANCH_SPREAD  = 0.70;  // how far a fork deflects from its parent direction
const MAX_TIPS       = 20;
const MAX_PATH_LEN   = 400;
const TIP_GLOW_LEN   = 35;
const STEP_INTERVAL  = 4;

// Phase durations — kept short so voronoi attraction dominates quickly
const DESCEND_AGE = 18;
const SPREAD_AGE  = 12;

// Per-phase movement parameters          down   lateral  inertia
const PHASE = {
  descend: { bias: 0.60, drift: 0.55, inertia: 0.22 },  // chaotic downward tumble
  spread:  { bias: 0.12, drift: 0.55, inertia: 0.20 },  // brief lateral float
  normal:  { bias: 0.62, drift: 0.55, inertia: 0.26 },  // jittery edge-following
};

// Seed position — adjust these to move the generator (x, z in [-S/2, S/2], y = top surface)
const SEED_OFFSET_X = 0;
const SEED_OFFSET_Z = 0;

const ATTRACT_DIST     = 5.0;   // wider search so edges are found sooner
const ATTRACT_STRENGTH = 0.55;  // stronger pull = loosely travels along edges
const EDGE_SNAP_DIST   = 0.9;   // only jump to new edge when very close = longer runs per edge

const BODY_COLOR = '#750e62';
const TIP_COLOR  = '#ef40e3';

// Scratch vectors — avoids per-step allocation
const _ab    = new THREE.Vector3();
const _ap    = new THREE.Vector3();
const _cpt   = new THREE.Vector3();
const _dummy = new THREE.Object3D();

// Shared geometry for all trail spheres (one InstancedMesh per tip, all share this geo)
const _trailGeo = new THREE.SphereGeometry(0.07, 6, 5);

class RootTip {
  // parentDir: direction of the parent tip at the moment of branching.
  constructor(startPos, bodyColor, tipColor, parentDir = null) {
    this.bodyColor = bodyColor;
    this.tipColor  = tipColor;
    this.alive     = true;
    this.age       = 0;
    this.pos       = startPos.clone();
    this._targetEdge = null;

    if (parentDir) {
      // Branch: lateral spread but never upward
      const lateral = new THREE.Vector3(
        (Math.random() - 0.5), -Math.random() * 0.15, (Math.random() - 0.5)
      ).normalize();
      this.dir = parentDir.clone().lerp(lateral, BRANCH_SPREAD).normalize();
      this._phase    = 'spread';
      this._phaseAge = 0;
    } else {
      // Taproot: straight down with tiny lean
      this.dir = new THREE.Vector3(
        (Math.random() - 0.5) * 0.15, -1, (Math.random() - 0.5) * 0.15
      ).normalize();
      this._phase    = 'descend';
      this._phaseAge = 0;
    }

    this._posData = new Float32Array(MAX_PATH_LEN * 3);
    this._colData = new Float32Array(MAX_PATH_LEN * 3);
    this._count   = 0;

    this._geo = new THREE.BufferGeometry();
    this._geo.setAttribute('position', new THREE.BufferAttribute(this._posData, 3));
    this._geo.setAttribute('color',    new THREE.BufferAttribute(this._colData, 3));
    this._geo.setDrawRange(0, 0);

    this.mesh = new THREE.Line(this._geo, new THREE.LineBasicMaterial({ vertexColors: true }));

    // InstancedMesh — one frozen sphere placed at every recorded point
    this._trail = new THREE.InstancedMesh(
      _trailGeo,
      new THREE.MeshBasicMaterial({ color: bodyColor }),
      MAX_PATH_LEN
    );
    this._trail.count = 0;
    this._trail.frustumCulled = false;

    // Moving tip sphere — larger and tip-colored, follows the active position
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

    // Freeze a trail sphere at this point
    _dummy.position.set(p.x, p.y, p.z);
    _dummy.updateMatrix();
    this._trail.setMatrixAt(this._count - 1, _dummy.matrix);
    this._trail.instanceMatrix.needsUpdate = true;
    this._trail.count = this._count;
  }

  // Only re-colours the trailing TIP_GLOW_LEN+1 vertices — O(k) not O(n)
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

    // Advance phase
    this._phaseAge++;
    if (this._phase === 'descend' && this._phaseAge >= DESCEND_AGE) this._phase = 'normal';
    if (this._phase === 'spread'  && this._phaseAge >= SPREAD_AGE)  this._phase = 'normal';

    const p = PHASE[this._phase];
    const wander = new THREE.Vector3(
      (Math.random() - 0.5) * p.drift, -p.bias, (Math.random() - 0.5) * p.drift
    ).normalize();
    this.dir.lerp(wander, p.inertia);
    this.dir.y = Math.min(this.dir.y, 0);  // never grow upward
    this.dir.normalize();

    // Edge attraction only in normal phase
    if (this._phase === 'normal') {
      let switchTarget = !this._targetEdge;
      if (this._targetEdge) {
        const e = this._targetEdge;
        _ab.subVectors(e.end, e.start);
        _ap.subVectors(this.pos, e.start);
        const t = Math.max(0, Math.min(1, _ap.dot(_ab) / _ab.dot(_ab)));
        const cpx = e.start.x + _ab.x * t, cpy = e.start.y + _ab.y * t, cpz = e.start.z + _ab.z * t;
        const dx = this.pos.x - cpx, dy = this.pos.y - cpy, dz = this.pos.z - cpz;
        if (dx * dx + dy * dy + dz * dz < EDGE_SNAP_DIST * EDGE_SNAP_DIST) switchTarget = true;
      }

      if (switchTarget) {
        const snapSq    = EDGE_SNAP_DIST * EDGE_SNAP_DIST;
        const attractSq = ATTRACT_DIST * ATTRACT_DIST;
        const candidates = [];
        for (let k = 0; k < edges.length; k++) {
          if (edges[k] === this._targetEdge) continue;
          _ab.subVectors(edges[k].end, edges[k].start);
          _ap.subVectors(this.pos, edges[k].start);
          const t = Math.max(0, Math.min(1, _ap.dot(_ab) / _ab.dot(_ab)));
          const cpx = edges[k].start.x + _ab.x * t, cpy = edges[k].start.y + _ab.y * t, cpz = edges[k].start.z + _ab.z * t;
          const dx = this.pos.x - cpx, dy = this.pos.y - cpy, dz = this.pos.z - cpz;
          const dSq = dx * dx + dy * dy + dz * dz;
          if (dSq < attractSq && dSq >= snapSq * 0.25) candidates.push(edges[k]);
        }
        if (candidates.length > 0)
          this._targetEdge = candidates[Math.floor(Math.random() * candidates.length)];
      }

      if (this._targetEdge) {
        const e = this._targetEdge;
        _ab.subVectors(e.end, e.start);
        _ap.subVectors(this.pos, e.start);
        const t = Math.max(0, Math.min(1, _ap.dot(_ab) / _ab.dot(_ab)));
        const cpx = e.start.x + _ab.x * t, cpy = e.start.y + _ab.y * t, cpz = e.start.z + _ab.z * t;
        const dx = cpx - this.pos.x, dy = cpy - this.pos.y, dz = cpz - this.pos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const falloff = 1 - dist / ATTRACT_DIST;
        if (falloff > 0 && dist > 0) {
          _cpt.set(dx / dist, dy / dist, dz / dist);
          this.dir.lerp(_cpt, ATTRACT_STRENGTH * falloff);
          this.dir.y = Math.min(this.dir.y, 0);  // never grow upward
          this.dir.normalize();
        }
      }
    }

    const next = this.pos.clone().addScaledVector(this.dir, STEP_SIZE);
    if (next.y < 0) { this.alive = false; this.sphere.visible = false; return; }
    this.pos.copy(next);
    this.sphere.position.copy(next);
    this.age++;
    this._appendPoint(next);
  }

  get count() { return this._count; }
}

class RootSystem {
  constructor(seedPos, bodyColor, tipColor, scene) {
    this.bodyColor = bodyColor;
    this.tipColor  = tipColor;
    this.scene     = scene;
    this.tips      = [];

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 10, 10),
      new THREE.MeshBasicMaterial({ color: tipColor })
    );
    marker.position.copy(seedPos);
    scene.add(marker);

    this._spawnTip(seedPos, null);
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
      // Only branch once in normal phase — not during descent or mid-float
      if (tip._phase === 'normal' && tip.age >= BRANCH_MIN_AGE && Math.random() < BRANCH_CHANCE)
        this._spawnTip(tip.pos.clone(), tip.dir.clone());
    }
  }
}

export function createRootSystems(scene, S, edges) {
  let frame = 0;
  const system = new RootSystem(
    new THREE.Vector3(SEED_OFFSET_X, S, SEED_OFFSET_Z),
    new THREE.Color(BODY_COLOR),
    new THREE.Color(TIP_COLOR),
    scene
  );
  function update() {
    frame++;
    if (frame % STEP_INTERVAL !== 0) return;
    system.update(edges);
  }
  return { system, update };
}
