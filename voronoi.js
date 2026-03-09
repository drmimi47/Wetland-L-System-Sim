import * as THREE from 'three';

const NX = 3;
const NY = 3;
const NZ = 3;

const MAX_CONN       = 6;
const CONNECT_DIST   = 30;
const PARALLEL_DOT   = 0.95;
const PARALLEL_DIST_SQ = 1.5 * 1.5;

// Scratch vectors — reused to avoid per-call allocation
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();

function stratifiedPoints(S) {
  const cx = S / NX;
  const cy = S / NY;
  const cz = S / NZ;
  const pts = [];
  const fit = 0.90; // shrinks the field slightly away from cube walls

  for (let ix = 0; ix < NX; ix++) {
    for (let iy = 0; iy < NY; iy++) {
      for (let iz = 0; iz < NZ; iz++) {
        const ox = -S / 2 + ix * cx;
        const oy =           iy * cy;
        const oz = -S / 2 + iz * cz;

        let jx = (ix === 0 || ix === NX - 1) ? Math.random() : (0.3 + Math.random() * 0.4);
        let jy = (iy === 0 || iy === NY - 1) ? Math.random() : (0.3 + Math.random() * 0.4);
        let jz = (iz === 0 || iz === NZ - 1) ? Math.random() : (0.3 + Math.random() * 0.4);

        if (ix === 0)      jx = Math.min(jx, 0.2);
        if (ix === NX - 1) jx = Math.max(jx, 0.9);
        if (iy === 0)      jy = Math.min(jy, 0.2);
        if (iy === NY - 1) jy = Math.max(jy, 0.9);
        if (iz === 0)      jz = Math.min(jz, 0.2);
        if (iz === NZ - 1) jz = Math.max(jz, 0.9);

        pts.push(new THREE.Vector3(
          (ox + cx * jx) * fit,
          ((oy + cy * jy) - S / 2) * fit + S / 2,
          (oz + cz * jz) * fit
        ));
      }
    }
  }
  return pts;
}

function makeUF(n) {
  const parent = new Int32Array(n).map((_, i) => i);
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  function connected(a, b) { return find(a) === find(b); }
  return { union, connected };
}

function tooCloseToExisting(pi, pj, accepted) {
  _mid.addVectors(pi, pj).multiplyScalar(0.5);
  _dir.subVectors(pj, pi).normalize();
  for (let i = 0; i < accepted.length; i++) {
    const e = accepted[i];
    if (Math.abs(_dir.dot(e.dir)) > PARALLEL_DOT &&
        _mid.distanceToSquared(e.mid) < PARALLEL_DIST_SQ) return true;
  }
  return false;
}

export function buildLattice(S) {
  const pts = stratifiedPoints(S);
  const n = pts.length;
  const allEdges = [];

  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const d = pts[i].distanceTo(pts[j]);
      if (d <= CONNECT_DIST) allEdges.push({ i, j, d });
    }
  allEdges.sort((a, b) => a.d - b.d);

  const connCount = new Int32Array(n);
  const uf = makeUF(n);
  const accepted = [];

  function accept(i, j) {
    accepted.push({
      start:     pts[i].clone(),
      end:       pts[j].clone(),
      rootCount: 0,
      maxRoots:  2,
      i, j,
      mid: new THREE.Vector3().addVectors(pts[i], pts[j]).multiplyScalar(0.5),
      dir: new THREE.Vector3().subVectors(pts[j], pts[i]).normalize()
    });
    connCount[i]++;
    connCount[j]++;
  }

  // Pass 1: MST — guarantees full connectivity
  for (let k = 0; k < allEdges.length; k++) {
    const { i, j } = allEdges[k];
    if (!uf.connected(i, j)) { accept(i, j); uf.union(i, j); }
  }

  // Pass 2: extra edges, rejecting near-parallel duplicates
  for (let k = 0; k < allEdges.length; k++) {
    const { i, j } = allEdges[k];
    if (connCount[i] >= MAX_CONN || connCount[j] >= MAX_CONN) continue;
    let exists = false;
    for (let a = 0; a < accepted.length; a++)
      if (accepted[a].i === i && accepted[a].j === j) { exists = true; break; }
    if (exists || tooCloseToExisting(pts[i], pts[j], accepted)) continue;
    accept(i, j);
  }

  const posArray = new Float32Array(accepted.length * 6);
  const colArray = new Float32Array(accepted.length * 6);
  const DEPTH_MIN   = -S;
  const DEPTH_RANGE =  3 * S;

  accepted.forEach((edge, idx) => {
    const pi = edge.start, pj = edge.end;
    const off = idx * 6;
    posArray.set([pi.x, pi.y, pi.z, pj.x, pj.y, pj.z], off);
    const ci = (1 - (pi.x + pi.y + pi.z - DEPTH_MIN) / DEPTH_RANGE) * 0.72;
    const cj = (1 - (pj.x + pj.y + pj.z - DEPTH_MIN) / DEPTH_RANGE) * 0.72;
    colArray.set([ci, ci, ci, cj, cj, cj], off);
  });

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
  lineGeo.setAttribute('color',    new THREE.BufferAttribute(colArray, 3));

  return {
    lines: new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true })),
    dots:  new THREE.Group(),
    pts,
    edges: accepted  // { start, end, rootCount, maxRoots, … }
  };
}
