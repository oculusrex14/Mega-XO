import * as THREE from '/.artifacts/p21-three-tools/node_modules/three/build/three.module.js';
import { createAsset, assetNames } from './factories.mjs';

const canvas = document.querySelector('#preview');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#070c19');
const camera = new THREE.PerspectiveCamera(37, 1, 0.1, 80);
camera.position.set(0, 0, 5.4);

scene.add(new THREE.HemisphereLight('#c8e4ff', '#151126', 2.1));
const key = new THREE.DirectionalLight('#fff3da', 4.2);
key.position.set(-3.5, 5.5, 7);
scene.add(key);
const coolRim = new THREE.DirectionalLight('#6c9eff', 2.4);
coolRim.position.set(4, 2.2, -4);
scene.add(coolRim);
const magentaFill = new THREE.PointLight('#b549ff', 11, 10, 2);
magentaFill.position.set(0, 2.8, 1.5);
scene.add(magentaFill);

const orbit = new THREE.Group();
scene.add(orbit);
const assetSelect = document.querySelector('#asset-select');
const qualityLabel = document.querySelector('#quality-label');
const assetLabel = document.querySelector('#asset-label');
const assetDescription = document.querySelector('#asset-description');
let quality = 'high';
let modelRoot = null;
let framingDistance = 5.4;

const presentation = Object.freeze({
  x: ['Neon X', 'Solid cyan X glyph with independently modeled rounded beveled arms.'],
  o: ['Neon O', 'Continuous pink torus glyph with a rounded cross-section.'],
  coin: ['Coin', 'Gold coin blank with a raised five-point star and concentric rims.'],
  crown: ['Crown', 'Purple three-point crown with segmented band plates and faceted tips.'],
  'rank-wood': ['Wood rank', 'Walnut and pale maple shield-and-wing relief; no wood-grain texture.'],
  'rank-stone': ['Stone rank', 'Chiseled slate and cool stone shield-and-wing relief; no stone texture.'],
  'rank-iron': ['Iron rank', 'Dark gunmetal shield with restrained icy-blue facets.'],
  'rank-bronze': ['Bronze rank', 'Copper-bronze segmented shield with amber crystal.'],
  'rank-silver': ['Silver rank', 'Platinum-silver frame and icy-blue crystal.'],
  'rank-gold': ['Gold rank', 'Yellow-gold wing plates and amber crystal.'],
  'rank-diamond': ['Diamond rank', 'Cyan-silver frame with a violet crystal core.'],
  'rank-emerald': ['Emerald rank', 'Silver frame with emerald facets and crystal.'],
  'rank-champion': ['Champion rank', 'Ruby-red shield, gold frame and a raised single finial.'],
  'rank-master': ['Master rank', 'Amethyst crystal, lavender-platinum frame and triple finial.'],
  'rank-grandmaster': ['Grandmaster rank', 'Iridescent pale crystal, gold-platinum frame and three-point crown.'],
  trophy: ['Trophy', 'Lathed gold cup, handles, laurel leaves, raised star and dark stepped pedestal.'],
  'reward-chest': ['Decorative award chest', 'Provisional closed black-and-gold chest; no source art or reward contents.'],
  'board-x': ['Neon X board plate', 'Cyan 3×3 decorative plate with X marks in the diagonal cells.'],
  'board-o': ['Neon O board plate', 'Pink 3×3 decorative plate with O marks in the diagonal cells.'],
});

if (assetNames.length !== 19 || assetNames.some(name => !presentation[name])) {
  throw new Error('Preview labels must describe all nineteen source factories.');
}

function disposeModel() {
  if (!modelRoot) return;
  orbit.remove(modelRoot);
  modelRoot.traverse((part) => {
    if (!part.isMesh) return;
    part.geometry.dispose();
    const materials = Array.isArray(part.material) ? part.material : [part.material];
    materials.forEach(material => material.dispose());
  });
  modelRoot = null;
}

function populate() {
  disposeModel();
  const name = assetSelect.value;
  modelRoot = createAsset(THREE, name, quality);
  const bounds = new THREE.Box3().setFromObject(modelRoot);
  const center = bounds.getCenter(new THREE.Vector3());
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  modelRoot.position.sub(center);
  if (name === 'coin') modelRoot.rotation.y = -0.15;
  if (name === 'crown' || name === 'rank-master') modelRoot.rotation.y = 0.12;
  orbit.add(modelRoot);
  const detail = presentation[name];
  assetLabel.textContent = detail[0];
  assetDescription.textContent = detail[1];
  qualityLabel.textContent = quality === 'high' ? 'High detail' : 'Lightweight';
  document.querySelector('#quality-toggle').textContent = quality === 'high' ? 'Show lightweight' : 'Show high detail';
  framingDistance = Math.max(3.8, sphere.radius * 3.8);
  camera.position.z = framingDistance;
  camera.lookAt(0, 0, 0);
}

assetSelect.addEventListener('change', populate);
document.querySelector('#quality-toggle').addEventListener('click', () => {
  quality = quality === 'high' ? 'low' : 'high';
  populate();
});
populate();

let drag = null;
canvas.addEventListener('pointerdown', (event) => {
  drag = { x: event.clientX, y: event.clientY, rotationY: orbit.rotation.y, rotationX: orbit.rotation.x };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', (event) => {
  if (!drag) return;
  orbit.rotation.y = drag.rotationY + (event.clientX - drag.x) * 0.006;
  orbit.rotation.x = THREE.MathUtils.clamp(drag.rotationX + (event.clientY - drag.y) * 0.004, -0.52, 0.52);
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('pointercancel', () => { drag = null; });

function resize() {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.position.z = framingDistance * (width / height < 1.4 ? 1.12 : 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);
resize();

function render() {
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}
render();
