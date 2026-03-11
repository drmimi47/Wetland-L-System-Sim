import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildLattice } from './voronoi.js';
import { createRootSystems } from './roots.js';

const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0xffffff, 1);
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const S = 18;

// Isometric frustum — derived from projected cube extents onto the camera plane
const HALF_H = 6 * Math.sqrt(6);
const HALF_W = 9 * Math.sqrt(2);

function getFrustumSize(aspect) {
  return Math.max(2 * HALF_H, (2 * HALF_W) / aspect);
}

let aspect = window.innerWidth / window.innerHeight;
let frustumSize = getFrustumSize(aspect);

const camera = new THREE.OrthographicCamera(
  (-frustumSize * aspect) / 2,
  ( frustumSize * aspect) / 2,
   frustumSize / 2,
  -frustumSize / 2,
  0.1,
  1000
);
camera.position.set(15, 15 + S / 2, 15);
camera.lookAt(0, S / 2, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, S / 2, 0);
controls.autoRotate      = true;
controls.autoRotateSpeed = 0.6;   // degrees per frame; negative = reverse
controls.update();

// Stop auto-rotation permanently on any mouse interaction (resets on page refresh)
renderer.domElement.addEventListener('mousedown', () => { controls.autoRotate = false; }, { once: true });

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(10, 20, 10);
scene.add(dirLight);

const box = new THREE.Mesh(
  new THREE.BoxGeometry(S, S, S),
  new THREE.ShaderMaterial({
    transparent: true,
    depthWrite:  false,
    side:        THREE.DoubleSide,
    vertexShader: `
      varying vec3 vNormalView;
      void main() {
        vNormalView = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vNormalView;
      void main() {
        // Ortho camera: view dir in view-space is always (0,0,1)
        float cosA    = abs(vNormalView.z);
        float fresnel = 1.0 - cosA;
        float opacity = 0.02 + 0.28 * pow(fresnel, 2.75);
        gl_FragColor  = vec4(0.35, 0.45, 0.75, opacity);
      }
    `
  }) //.45,.45,.45 is grey
);
box.position.set(0, S / 2, 0);
scene.add(box);

const { lines, lineMaterial, flashLines, flashLineMaterial, dots, edges, lineGeo, flashLineGeo } = buildLattice(S);
scene.add(lines);
scene.add(dots);
scene.add(flashLines);

const { update: updateRoots } = createRootSystems(scene, S, edges, lineGeo, flashLineGeo);

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  aspect = w / h;
  frustumSize = getFrustumSize(aspect);
  camera.left   = (-frustumSize * aspect) / 2;
  camera.right  = ( frustumSize * aspect) / 2;
  camera.top    =  frustumSize / 2;
  camera.bottom = -frustumSize / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  lineMaterial.resolution.set(w, h);
  flashLineMaterial.resolution.set(w, h);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  updateRoots();
  renderer.render(scene, camera);
}

animate();
