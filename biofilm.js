import * as THREE from 'three';

const MAX_BIOFILM  = 1000;  // total colony spheres at full saturation
const BASE_RATE    = 0.15;  // spheres revealed per frame during root growth
const FILL_FRAMES  = 170;   // frames to fill remaining during the 3s delay (~60fps)
const SPHERE_RADIUS  = 0.06; // radius of each biofilm sphere — main size control
const SPHERE_OPACITY = 0.75; // 0 = invisible, 1 = fully opaque

const _pos = new THREE.Vector3();
const _col = new THREE.Color();
const _mat = new THREE.Matrix4();

export function createBiofilm(scene, edges) {
  // Weight edge selection by length so longer edges get more coverage
  const lengths = edges.map(e => e.start.distanceTo(e.end));
  const totalLen = lengths.reduce((s, l) => s + l, 0);

  const sphereGeo = new THREE.SphereGeometry(SPHERE_RADIUS, 5, 4);
  const sphereMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: SPHERE_OPACITY });
  const mesh = new THREE.InstancedMesh(sphereGeo, sphereMat, MAX_BIOFILM);
  mesh.count = 0;
  mesh.visible = false; // off by default — toggle with spacebar
  mesh.frustumCulled = false;
  scene.add(mesh);

  window.addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); mesh.visible = !mesh.visible; }
  });

  // Pre-generate all candidate transforms and colors in a random order
  for (let i = 0; i < MAX_BIOFILM; i++) {
    // Pick an edge weighted by length
    let r = Math.random() * totalLen;
    let edge = edges[edges.length - 1];
    for (let k = 0; k < edges.length; k++) {
      r -= lengths[k];
      if (r <= 0) { edge = edges[k]; break; }
    }

    // Random position along the edge with small radial jitter
    _pos.lerpVectors(edge.start, edge.end, Math.random());
    _pos.x += (Math.random() - 0.5) * 0.14;
    _pos.y += (Math.random() - 0.5) * 0.14;
    _pos.z += (Math.random() - 0.5) * 0.14;

    _mat.makeTranslation(_pos.x, _pos.y, _pos.z);
    mesh.setMatrixAt(i, _mat);

    // Muted dark greens with per-sphere brightness variation
    const v = 0.5 + Math.random() * 0.5;
    _col.setRGB(0.07 * v, 0.30 * v, 0.05 * v);
    mesh.setColorAt(i, _col);
  }

  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate  = true;

  let shown = 0;
  let accum = 0;
  let rate  = BASE_RATE;

  return {
    update() {
      if (shown >= MAX_BIOFILM) return;
      accum += rate;
      const add = Math.floor(accum);
      if (add > 0) {
        accum -= add;
        shown = Math.min(shown + add, MAX_BIOFILM);
        mesh.count = shown;
      }
    },

    // Call once when roots finish — fills remaining spheres over the 3s delay
    startFilling() {
      const remaining = MAX_BIOFILM - shown;
      rate = remaining > 0 ? remaining / FILL_FRAMES : 0;
    },

    reset() {
      shown      = 0;
      accum      = 0;
      rate       = BASE_RATE;
      mesh.count = 0;
    }
  };
}
