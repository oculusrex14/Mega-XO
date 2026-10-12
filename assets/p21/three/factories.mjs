/*
 * Editable, texture-free procedural P21 asset factories.
 *
 * Three.js is injected so this source does not declare or install a runtime
 * dependency. Factories return normalized Object3D hierarchies with a named
 * Pivot child. Geometry is genuine 3D, with generated normals and UVs.
 */

const QUALITY = {
  high: { bevelSegments: 4, curveSegments: 32, radialSegments: 64, torusSegments: 72, tubeSegments: 12, gemDetail: 1 },
  low: { bevelSegments: 1, curveSegments: 10, radialSegments: 20, torusSegments: 20, tubeSegments: 6, gemDetail: 0 },
};

function selectQuality(name) {
  if (!QUALITY[name]) throw new Error(`Unknown P21 Three.js quality: ${name}`);
  return QUALITY[name];
}

function makeRoot(T, name, quality) {
  const root = new T.Group();
  root.name = `P21 ${name} ${quality}`;
  root.userData = { assetId: `P21-3D-${name.toUpperCase()}`, quality, sourceKind: 'procedural-mesh', unitScale: 1 };
  const pivot = new T.Group();
  pivot.name = 'Pivot';
  pivot.userData = { role: 'center-of-mass-animation-pivot' };
  root.add(pivot);
  return { root, pivot };
}

function material(T, name, color, { metalness = 0, roughness = 0.5, emissive = '#000000', emissiveIntensity = 0 } = {}) {
  return new T.MeshStandardMaterial({ name, color, metalness, roughness, emissive, emissiveIntensity });
}

function ensureMeshAttributes(T, geometry) {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const normals = geometry.getAttribute('normal');
  if (normals) {
    for (let i = 0; i < normals.count; i++) {
      const x = normals.getX(i), y = normals.getY(i), z = normals.getZ(i);
      const length = Math.hypot(x, y, z);
      if (!Number.isFinite(length) || length < 1e-8) throw new Error('Cannot normalize a degenerate generated vertex normal.');
      normals.setXYZ(i, x / length, y / length, z / length);
    }
    normals.needsUpdate = true;
  }
  if (!geometry.getAttribute('uv')) {
    const positions = geometry.getAttribute('position');
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const spanX = Math.max(1e-8, box.max.x - box.min.x);
    const spanY = Math.max(1e-8, box.max.y - box.min.y);
    const spanZ = Math.max(1e-8, box.max.z - box.min.z);
    const uv = new Float32Array(positions.count * 2);
    for (let i = 0; i < positions.count; i++) {
      uv[i * 2] = (positions.getX(i) - box.min.x) / spanX;
      uv[i * 2 + 1] = (positions.getY(i) - box.min.y) / spanY;
      if (!Number.isFinite(uv[i * 2 + 1])) uv[i * 2 + 1] = (positions.getZ(i) - box.min.z) / spanZ;
    }
    geometry.setAttribute('uv', new T.BufferAttribute(uv, 2));
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function addMesh(T, parent, name, geometry, mat) {
  ensureMeshAttributes(T, geometry);
  const mesh = new T.Mesh(geometry, mat);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function roundedRect(T, width, height, radius) {
  const s = new T.Shape();
  const x = -width / 2, y = -height / 2, r = Math.min(radius, width / 2, height / 2);
  s.moveTo(x + r, y);
  s.lineTo(x + width - r, y); s.quadraticCurveTo(x + width, y, x + width, y + r);
  s.lineTo(x + width, y + height - r); s.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  s.lineTo(x + r, y + height); s.quadraticCurveTo(x, y + height, x, y + height - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function polygonShape(T, points) {
  const shape = new T.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  return shape;
}

function extrude(T, shape, quality, depth, bevelSize, bevelThickness) {
  return new T.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: quality.bevelSegments,
    steps: 1,
    bevelSize,
    bevelThickness,
    curveSegments: quality.curveSegments,
  });
}

function makeStar(T, outerRadius, innerRadius, points = 5) {
  const vertices = [];
  for (let i = 0; i < points * 2; i++) {
    const angle = Math.PI / 2 + (i * Math.PI / points);
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    vertices.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return polygonShape(T, vertices);
}

function makeX(T, qualityName = 'high') {
  const q = selectQuality(qualityName);
  const { root, pivot } = makeRoot(T, 'X', qualityName);
  const cyan = material(T, 'Neon cyan enamel · #39CFFF', '#39cfff', { metalness: 0.32, roughness: 0.26, emissive: '#146e9c', emissiveIntensity: 0.12 });
  const barShape = roundedRect(T, 1.52, 0.235, 0.108);
  const options = { curveSegments: q.curveSegments, bevelSegments: q.bevelSegments, depth: 0.145, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.025, steps: 1 };
  for (const [name, rotation] of [['Arm NW-SE', Math.PI / 4], ['Arm NE-SW', -Math.PI / 4]]) {
    const arm = new T.Group();
    arm.name = name;
    arm.rotation.z = rotation;
    const geometry = new T.ExtrudeGeometry(barShape, options);
    const mesh = addMesh(T, arm, `${name} beveled solid`, geometry, cyan);
    mesh.position.z = -options.depth / 2;
    pivot.add(arm);
  }
  return root;
}

function makeO(T, qualityName = 'high') {
  const q = selectQuality(qualityName);
  const { root, pivot } = makeRoot(T, 'O', qualityName);
  const pink = material(T, 'Neon pink enamel · #FF63B6', '#ff63b6', { metalness: 0.28, roughness: 0.25, emissive: '#7d1747', emissiveIntensity: 0.12 });
  addMesh(T, pivot, 'Continuous rounded O ring', new T.TorusGeometry(0.542, 0.073, q.radialSegments, q.torusSegments), pink);
  return root;
}

function coinProfile(T) {
  const s = new T.Shape();
  // Raised, five-point star with softened silhouette. Extrusion gives the star real depth.
  const outer = 0.52, inner = 0.25;
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + i * Math.PI / 5;
    const r = i % 2 === 0 ? outer : inner;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}

function makeCoin(T, qualityName = 'high') {
  const q = selectQuality(qualityName);
  const { root, pivot } = makeRoot(T, 'Coin', qualityName);
  const bronze = material(T, 'Coin edge · warm bronze gold', '#a45a08', { metalness: 0.9, roughness: 0.24 });
  const gold = material(T, 'Coin face · rich gold', '#e99b13', { metalness: 0.84, roughness: 0.28 });
  const rimGold = material(T, 'Raised rim · bright gold', '#ffd24a', { metalness: 0.92, roughness: 0.2 });
  const starGold = material(T, 'Raised star · pale gold', '#ffe578', { metalness: 0.78, roughness: 0.2, emissive: '#9b5c00', emissiveIntensity: 0.06 });

  const body = new T.CylinderGeometry(0.94, 0.94, 0.17, q.radialSegments, 1, false);
  body.rotateX(Math.PI / 2);
  addMesh(T, pivot, 'Solid coin blank', body, bronze);

  const face = new T.CylinderGeometry(0.82, 0.82, 0.026, q.radialSegments, 1, false);
  face.rotateX(Math.PI / 2);
  const medallion = addMesh(T, pivot, 'Inset circular gold face', face, gold);
  medallion.position.z = 0.085;

  for (const [name, radius, tube, z] of [
    ['Front raised outer rim', 0.865, 0.052, 0.07],
    ['Front inner engraving ring', 0.765, 0.016, 0.105],
    ['Back edge bead', 0.865, 0.037, -0.068],
  ]) {
    addMesh(T, pivot, name, new T.TorusGeometry(radius, tube, Math.max(6, q.radialSegments / 6), q.torusSegments), rimGold).position.z = z;
  }

  const star = addMesh(T, pivot, 'Raised five-point star', extrude(T, coinProfile(T), q, 0.09, 0.025, 0.025), starGold);
  star.position.z = 0.103;
  return root;
}

function crownOutline(T) {
  return polygonShape(T, [
    [-0.75, -0.34], [-0.63, 0.23], [-0.49, -0.02], [-0.30, -0.18],
    [-0.11, 0.11], [0, 0.50], [0.11, 0.11], [0.30, -0.18],
    [0.49, -0.02], [0.63, 0.23], [0.75, -0.34], [0.63, -0.47],
    [0.35, -0.51], [0, -0.46], [-0.35, -0.51], [-0.63, -0.47],
  ]);
}

function crownPanelShape(T, x0, x1, yTop0, yTop1, yBottom0, yBottom1) {
  return polygonShape(T, [[x0, yBottom0], [x0 + 0.018, yTop0], [x1 - 0.018, yTop1], [x1, yBottom1], [x1 - 0.012, yBottom1 - 0.025], [x0 + 0.012, yBottom0 - 0.025]]);
}

function makeCrown(T, qualityName = 'high') {
  const q = selectQuality(qualityName);
  const { root, pivot } = makeRoot(T, 'Crown', qualityName);
  const base = material(T, 'Crown body · deep royal purple', '#411274', { metalness: 0.66, roughness: 0.27, emissive: '#240c56', emissiveIntensity: 0.08 });
  const band = material(T, 'Crown band · violet enamel', '#7222c7', { metalness: 0.62, roughness: 0.26 });
  const panels = [
    material(T, 'Band panel · amethyst', '#9a43e9', { metalness: 0.56, roughness: 0.24 }),
    material(T, 'Band panel · royal violet', '#6020b5', { metalness: 0.64, roughness: 0.28 }),
    material(T, 'Band panel · orchid', '#b155ef', { metalness: 0.49, roughness: 0.24 }),
  ];
  const facets = material(T, 'Crown tine facets · lavender', '#bf74ff', { metalness: 0.46, roughness: 0.22 });
  const gems = material(T, 'Tip gems · pink lavender crystal', '#edc7ff', { metalness: 0.26, roughness: 0.18, emissive: '#7c29cf', emissiveIntensity: 0.11 });
  const rails = material(T, 'Band rails · lilac silver', '#dda4ff', { metalness: 0.72, roughness: 0.22, emissive: '#691ea5', emissiveIntensity: 0.05 });

  const shell = addMesh(T, pivot, 'Three-point crown shell', extrude(T, crownOutline(T), q, 0.12, 0.018, 0.025), base);
  shell.position.z = -0.06;

  // A central split-facet on each genuine raised tine distinguishes the three prongs.
  const facetShapes = [
    [[-0.63, 0.20], [-0.50, -0.02], [-0.43, 0.01]],
    [[-0.63, 0.20], [-0.43, 0.01], [-0.54, 0.12]],
    [[-0.105, 0.46], [-0.02, 0.26], [0, 0.12]],
    [[-0.105, 0.46], [0, 0.12], [-0.02, 0.34]],
    [[0.105, 0.46], [0.02, 0.26], [0, 0.12]],
    [[0.105, 0.46], [0, 0.12], [0.02, 0.34]],
    [[0.63, 0.20], [0.50, -0.02], [0.43, 0.01]],
    [[0.63, 0.20], [0.43, 0.01], [0.54, 0.12]],
  ];
  facetShapes.forEach((points, i) => {
    const facet = addMesh(T, pivot, `Tine facet ${i + 1}`, extrude(T, polygonShape(T, points), q, 0.018, 0.006, 0.008), i % 2 ? band : facets);
    facet.position.z = 0.066;
  });

  // Five inset plates leave visible seams and tonal changes across the curved band.
  const left = -0.66, width = 1.32 / 5;
  for (let i = 0; i < 5; i++) {
    const x0 = left + i * width, x1 = x0 + width;
    const c = (x0 + x1) / 2;
    const arch = 0.035 * (1 - Math.abs(c) / 0.66);
    const top0 = -0.145 + arch, top1 = -0.145 + arch;
    const bottom0 = -0.425 + arch * 0.3, bottom1 = -0.425 + arch * 0.3;
    const plate = addMesh(T, pivot, `Segmented band plate ${i + 1}`, extrude(T, crownPanelShape(T, x0, x1, top0, top1, bottom0, bottom1), q, 0.035, 0.008, 0.012), panels[i % panels.length]);
    plate.position.z = 0.058;
  }

  // Raised rails run along the top and bottom of the band, following its shallow arc.
  for (const [name, yBase] of [['Band upper rail', -0.14], ['Band lower rail', -0.435]]) {
    const points = [];
    const steps = q.curveSegments;
    for (let i = 0; i <= steps; i++) {
      const x = -0.65 + 1.3 * i / steps;
      const arch = 0.035 * (1 - Math.abs(x) / 0.65);
      points.push(new T.Vector3(x, yBase + arch, 0.105));
    }
    const path = new T.CatmullRomCurve3(points);
    addMesh(T, pivot, name, new T.TubeGeometry(path, steps, 0.012, q.tubeSegments, false), rails);
  }

  for (const [label, x, y, radius] of [
    ['Left tip gem', -0.62, 0.265, 0.108],
    ['Center tip gem', 0, 0.50, 0.12],
    ['Right tip gem', 0.62, 0.265, 0.108],
  ]) {
    const gem = addMesh(T, pivot, label, new T.OctahedronGeometry(radius, q.gemDetail), gems);
    gem.position.set(x, y, 0.12);
    gem.rotation.set(0.14, 0.18, Math.PI / 8);
  }

  return root;
}

const RANK_NAMES = Object.freeze([
  'wood', 'stone', 'iron', 'bronze', 'silver', 'gold', 'diamond',
  'emerald', 'champion', 'master', 'grandmaster',
]);

const RANK_PALETTES = Object.freeze({
  wood: {
    title: 'Wood', dark: '#32180f', frame: '#dca45b', face: '#854019', wing: '#71330f',
    wingFacet: '#e7b66d', core: '#a95d27', highlight: '#f0d092', metalness: 0.16, roughness: 0.46,
    gem: null, finials: 0, sideGems: 0, wingRows: 3, relief: 'carved timber',
  },
  stone: {
    title: 'Stone', dark: '#202733', frame: '#b7c3d3', face: '#46515f', wing: '#3b4654',
    wingFacet: '#c8d0dc', core: '#687584', highlight: '#dce3ea', metalness: 0.42, roughness: 0.48,
    gem: null, finials: 0, sideGems: 0, wingRows: 3, relief: 'chiseled slate',
  },
  iron: {
    title: 'Iron', dark: '#111b29', frame: '#b6d7f7', face: '#253345', wing: '#1f2a3a',
    wingFacet: '#82b8e8', core: '#35445a', highlight: '#d7edff', metalness: 0.84, roughness: 0.26,
    gem: null, finials: 0, sideGems: 0, wingRows: 3, relief: 'brushed gunmetal',
  },
  bronze: {
    title: 'Bronze', dark: '#471900', frame: '#ffc36d', face: '#a4480c', wing: '#9d3508',
    wingFacet: '#f5832d', core: '#d76a11', highlight: '#ffe1a3', metalness: 0.78, roughness: 0.27,
    gem: '#ff8b20', gemGlow: '#b74704', finials: 0, sideGems: 0, wingRows: 3, relief: 'copper bronze',
  },
  silver: {
    title: 'Silver', dark: '#25364b', frame: '#f0f8ff', face: '#90a8c0', wing: '#8caac7',
    wingFacet: '#d4eaff', core: '#c8d6e3', highlight: '#ffffff', metalness: 0.9, roughness: 0.18,
    gem: '#a9dfff', gemGlow: '#3c9bec', finials: 0, sideGems: 0, wingRows: 3, relief: 'platinum silver',
  },
  gold: {
    title: 'Gold', dark: '#4a2703', frame: '#ffe28a', face: '#bb7208', wing: '#c27c08',
    wingFacet: '#ffcf3f', core: '#e29b12', highlight: '#fff0b2', metalness: 0.9, roughness: 0.2,
    gem: '#ffca3e', gemGlow: '#b56505', finials: 0, sideGems: 0, wingRows: 3, relief: 'polished yellow gold',
  },
  diamond: {
    title: 'Diamond', dark: '#111557', frame: '#65eaff', face: '#1555bc', wing: '#1268d1',
    wingFacet: '#a5f6ff', core: '#27177e', highlight: '#d5fbff', metalness: 0.72, roughness: 0.19,
    gem: '#bd6eff', gemGlow: '#762dff', finials: 1, sideGems: 0, wingRows: 3, relief: 'cyan silver and violet crystal',
  },
  emerald: {
    title: 'Emerald', dark: '#063a35', frame: '#e3fff4', face: '#08766b', wing: '#008c77',
    wingFacet: '#32e2b3', core: '#064c42', highlight: '#baffdf', metalness: 0.68, roughness: 0.2,
    gem: '#1de7a0', gemGlow: '#00a875', finials: 0, sideGems: 0, wingRows: 3, relief: 'silver and emerald crystal',
  },
  champion: {
    title: 'Champion', dark: '#461019', frame: '#ffe07c', face: '#9e1730', wing: '#9c1027',
    wingFacet: '#fb3855', core: '#741329', highlight: '#fff0ba', metalness: 0.82, roughness: 0.2,
    gem: '#ff3158', gemGlow: '#d30036', finials: 1, sideGems: 2, wingRows: 3, relief: 'ruby and gold champion crest',
  },
  master: {
    title: 'Master', dark: '#25134d', frame: '#f1e5ff', face: '#5428a1', wing: '#5222ba',
    wingFacet: '#bd82ff', core: '#3f137d', highlight: '#f8edff', metalness: 0.76, roughness: 0.19,
    gem: '#b657ff', gemGlow: '#7b28ff', finials: 3, sideGems: 2, wingRows: 4, relief: 'amethyst and platinum master crest',
  },
  grandmaster: {
    title: 'Grandmaster', dark: '#4b310e', frame: '#ffde82', face: '#d8bd68', wing: '#f4e3ad',
    wingFacet: '#fff8df', core: '#d7c37a', highlight: '#ffffff', metalness: 0.88, roughness: 0.16,
    gem: '#e7f7ff', gemGlow: '#82d7ff', finials: 3, sideGems: 2, wingRows: 4, relief: 'gold platinum and iridescent diamond',
  },
});

const RANK_SHIELD = Object.freeze([
  [0, 0.80], [-0.27, 0.72], [-0.47, 0.51], [-0.49, 0.19],
  [-0.40, -0.24], [-0.25, -0.54], [0, -0.82], [0.25, -0.54],
  [0.40, -0.24], [0.49, 0.19], [0.47, 0.51], [0.27, 0.72],
]);

const RANK_WINGS = Object.freeze([
  [[0.37, 0.35], [0.74, 0.62], [0.98, 0.74], [0.91, 0.48], [0.57, 0.16]],
  [[0.41, 0.14], [0.91, 0.31], [0.98, 0.09], [0.48, -0.14]],
  [[0.38, -0.17], [0.82, -0.07], [0.70, -0.41], [0.22, -0.57]],
  [[0.30, 0.49], [0.60, 0.78], [0.84, 0.85], [0.72, 0.60], [0.43, 0.32]],
]);

function mapPolygon(points, scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0) {
  return points.map(([x, y]) => [offsetX + x * scaleX, offsetY + y * scaleY]);
}

function shrinkPolygon(points, scale = 0.76) {
  const center = points.reduce((sum, [x, y]) => [sum[0] + x / points.length, sum[1] + y / points.length], [0, 0]);
  return points.map(([x, y]) => [center[0] + (x - center[0]) * scale, center[1] + (y - center[1]) * scale]);
}

function addRankPlate(T, parent, name, points, q, mat, z, { depth = 0.08, bevelSize = 0.016, bevelThickness = 0.024 } = {}) {
  const mesh = addMesh(T, parent, name, extrude(T, polygonShape(T, points), q, depth, bevelSize, bevelThickness), mat);
  mesh.position.z = z;
  return mesh;
}

function makeRank(T, rank, qualityName = 'high') {
  const q = selectQuality(qualityName);
  const config = RANK_PALETTES[rank];
  if (!config) throw new Error(`Unsupported P21 rank badge: ${rank}`);
  const { root, pivot } = makeRoot(T, `Rank ${config.title}`, qualityName);
  const materials = {
    dark: material(T, `${config.title} structural shadow`, config.dark, { metalness: Math.min(config.metalness, 0.7), roughness: config.roughness + 0.08 }),
    frame: material(T, `${config.title} bright beveled frame`, config.frame, { metalness: config.metalness, roughness: config.roughness, emissive: rank === 'diamond' ? '#0a284a' : '#000000', emissiveIntensity: rank === 'diamond' ? 0.06 : 0 }),
    face: material(T, `${config.title} wing and armor base`, config.face, { metalness: Math.min(0.86, config.metalness), roughness: config.roughness + 0.04 }),
    wing: material(T, `${config.title} segmented wing plates`, config.wing, { metalness: Math.min(0.9, config.metalness), roughness: config.roughness + 0.03 }),
    wingFacet: material(T, `${config.title} raised wing facets`, config.wingFacet, { metalness: Math.min(0.9, config.metalness), roughness: Math.max(0.16, config.roughness - 0.02), emissive: rank === 'diamond' ? '#07365d' : '#000000', emissiveIntensity: rank === 'diamond' ? 0.07 : 0 }),
    core: material(T, `${config.title} inset shield`, config.core, { metalness: Math.min(0.82, config.metalness), roughness: config.roughness + 0.02 }),
    highlight: material(T, `${config.title} shield facet`, config.highlight, { metalness: config.metalness, roughness: Math.max(0.16, config.roughness - 0.03) }),
  };
  if (config.gem) {
    materials.gem = material(T, `${config.title} central faceted crystal`, config.gem, {
      metalness: 0.28, roughness: 0.17, emissive: config.gemGlow || '#000000', emissiveIntensity: config.gemGlow ? 0.12 : 0,
    });
  }

  // The twelve source designs share an angular shield-and-wing silhouette. Each
  // pair of layered feathers is independently editable rather than a flat cutout.
  const wingRows = Math.min(config.wingRows, RANK_WINGS.length);
  for (let row = 0; row < wingRows; row++) {
    for (const side of [-1, 1]) {
      const points = mapPolygon(RANK_WINGS[row], side, 1);
      addRankPlate(T, pivot, `${side < 0 ? 'Left' : 'Right'} feather ${row + 1} base`, points, q, materials.dark, -0.045, { depth: 0.105, bevelSize: 0.014, bevelThickness: 0.024 });
      addRankPlate(T, pivot, `${side < 0 ? 'Left' : 'Right'} feather ${row + 1} face`, shrinkPolygon(points, 0.79), q, row === 0 ? materials.wingFacet : materials.wing, 0.035, { depth: 0.045, bevelSize: 0.009, bevelThickness: 0.016 });
    }
  }

  // A dark backing, raised bright frame and smaller inset form the shield's
  // silhouette. Source PNGs are style references; this geometry is not a raster trace.
  addRankPlate(T, pivot, 'Shield rear armor', mapPolygon(RANK_SHIELD, 1.0, 1.0), q, materials.dark, -0.06, { depth: 0.16, bevelSize: 0.022, bevelThickness: 0.026 });
  addRankPlate(T, pivot, 'Raised shield frame', mapPolygon(RANK_SHIELD, 0.89, 0.89), q, materials.frame, 0.075, { depth: 0.075, bevelSize: 0.018, bevelThickness: 0.025 });
  addRankPlate(T, pivot, 'Inset shield face', mapPolygon(RANK_SHIELD, 0.75, 0.75), q, materials.face, 0.145, { depth: 0.038, bevelSize: 0.01, bevelThickness: 0.014 });
  addRankPlate(T, pivot, 'Center shield relief', mapPolygon(RANK_SHIELD, 0.59, 0.67), q, materials.core, 0.178, { depth: 0.028, bevelSize: 0.008, bevelThickness: 0.011 });

  const centerFacets = [
    [[0, 0.54], [-0.20, 0.36], [-0.17, -0.16], [0, -0.59]],
    [[0, 0.54], [0.20, 0.36], [0.17, -0.16], [0, -0.59]],
  ];
  centerFacets.forEach((points, index) => addRankPlate(T, pivot, `Shield cut facet ${index + 1}`, points, q, index === 0 ? materials.highlight : materials.frame, 0.207, { depth: 0.018, bevelSize: 0.005, bevelThickness: 0.008 }));

  if (materials.gem) {
    const bezel = addMesh(T, pivot, 'Raised crystal bezel', new T.TorusGeometry(0.31, 0.028, Math.max(6, q.radialSegments / 6), q.torusSegments), materials.frame);
    bezel.scale.set(0.72, 1.27, 0.45);
    bezel.position.set(0, -0.015, 0.225);
    const crystal = addMesh(T, pivot, 'Independently faceted central crystal', new T.OctahedronGeometry(0.30, q.gemDetail), materials.gem);
    crystal.scale.set(0.76, 1.43, 0.56);
    crystal.position.set(0, -0.03, 0.24);
    crystal.rotation.y = Math.PI / 8;
  } else {
    // Wood and stone remain visibly material-first: the raised inner shield is
    // cut into separate relief planes and does not introduce an unapproved gem.
    const insetFacet = addRankPlate(T, pivot, `${config.title} central relief facet`, [[0, 0.43], [-0.15, 0.20], [0, -0.48], [0.15, 0.20]], q, materials.highlight, 0.232, { depth: 0.014, bevelSize: 0.004, bevelThickness: 0.006 });
    insetFacet.userData.detail = config.relief;
  }

  // Thin material seams and studs provide distinct tier signatures without
  // introducing text, numbers or game-economy semantics into the emblem.
  if (config.sideGems >= 2) for (const side of [-1, 1]) {
    const stud = addMesh(T, pivot, `${side < 0 ? 'Left' : 'Right'} shoulder crystal`, new T.OctahedronGeometry(0.075, q.gemDetail), materials.gem);
    stud.scale.set(0.9, 1.1, 0.5);
    stud.position.set(side * 0.39, 0.43, 0.22);
  }

  if (config.finials) {
    const crest = config.finials === 1 ? [0] : [-0.21, 0, 0.21];
    crest.forEach((x, index) => {
      const center = x === 0;
      const points = center
        ? [[-0.11, 0.67], [-0.065, 0.82], [0, 0.99], [0.065, 0.82], [0.11, 0.67]]
        : [[x - 0.085, 0.68], [x - 0.045, 0.76], [x, 0.87], [x + 0.045, 0.76], [x + 0.085, 0.68]];
      addRankPlate(T, pivot, `${config.title} ${config.finials === 3 ? 'crown' : 'rising'} finial ${index + 1}`, points, q, materials.frame, 0.035, { depth: 0.07, bevelSize: 0.01, bevelThickness: 0.018 });
      if (center && materials.gem && (rank === 'champion' || rank === 'diamond')) {
        const crestGem = addMesh(T, pivot, `${config.title} finial crystal`, new T.OctahedronGeometry(0.075, q.gemDetail), materials.gem);
        crestGem.scale.set(0.75, 1.3, 0.6);
        crestGem.position.set(0, 0.80, 0.10);
      }
    });
  }
  return root;
}

function makeTrophy(T, qualityName = 'high') {
  const q = selectQuality(qualityName);
  const { root, pivot } = makeRoot(T, 'Championship Trophy', qualityName);
  const gold = material(T, 'Trophy cup · championship gold', '#f2a91a', { metalness: 0.9, roughness: 0.18 });
  const bright = material(T, 'Trophy raised gold trim', '#ffe384', { metalness: 0.92, roughness: 0.16 });
  const shadowGold = material(T, 'Trophy warm bronze facets', '#8b4b08', { metalness: 0.82, roughness: 0.28 });
  const black = material(T, 'Trophy pedestal · midnight enamel', '#111724', { metalness: 0.62, roughness: 0.29 });
  const assembly = new T.Group();
  assembly.name = 'Trophy Assembly';
  assembly.position.y = -0.16;
  pivot.add(assembly);

  const cupProfile = [
    [0.005, 0.23], [0.17, 0.23], [0.22, 0.31], [0.31, 0.47],
    [0.39, 0.81], [0.44, 0.95], [0.41, 0.99], [0.37, 0.88],
    [0.30, 0.58], [0.22, 0.43], [0.05, 0.39],
  ].map(([radius, height]) => new T.Vector2(radius, height));
  addMesh(T, assembly, 'Hollow lathed trophy bowl', new T.LatheGeometry(cupProfile, q.radialSegments), gold);
  const lip = new T.TorusGeometry(0.422, 0.025, Math.max(6, q.radialSegments / 6), q.torusSegments);
  lip.rotateX(Math.PI / 2);
  addMesh(T, assembly, 'Continuous cup lip', lip, bright).position.y = 0.95;

  for (const side of [-1, 1]) {
    const points = [
      new T.Vector3(side * 0.36, 0.80, 0), new T.Vector3(side * 0.57, 0.91, 0),
      new T.Vector3(side * 0.68, 0.72, 0), new T.Vector3(side * 0.65, 0.48, 0),
      new T.Vector3(side * 0.43, 0.40, 0),
    ];
    const handle = new T.CatmullRomCurve3(points, false, 'catmullrom', 0.25);
    addMesh(T, assembly, `${side < 0 ? 'Left' : 'Right'} curled trophy handle`, new T.TubeGeometry(handle, q.curveSegments, 0.045, q.tubeSegments, false), bright);
    for (let i = 0; i < 5; i++) {
      const y = 0.68 - i * 0.105;
      const x = side * (0.34 + i * 0.035);
      const leafPoints = [[0, 0.05], [0.105, 0], [0, -0.05], [-0.105, 0]].map(([dx, dy]) => [x + dx, y + dy]);
      addRankPlate(T, assembly, `${side < 0 ? 'Left' : 'Right'} laurel leaf ${i + 1}`, leafPoints, q, i % 2 ? bright : shadowGold, 0.29, { depth: 0.025, bevelSize: 0.004, bevelThickness: 0.006 });
    }
  }

  const star = addMesh(T, assembly, 'Raised five-point trophy star', extrude(T, makeStar(T, 0.18, 0.085), q, 0.045, 0.012, 0.016), bright);
  star.position.set(0, 0.65, 0.345);
  const medallion = addMesh(T, assembly, 'Dark star medallion inset', new T.CylinderGeometry(0.24, 0.24, 0.018, q.radialSegments), shadowGold);
  medallion.rotation.x = Math.PI / 2;
  medallion.position.set(0, 0.65, 0.32);

  const neck = addMesh(T, assembly, 'Tapered trophy neck', new T.CylinderGeometry(0.16, 0.21, 0.28, q.radialSegments), gold);
  neck.position.y = 0.12;
  const collar = addMesh(T, assembly, 'Trophy neck collar', new T.CylinderGeometry(0.245, 0.245, 0.07, q.radialSegments), bright);
  collar.position.y = -0.06;
  const stem = addMesh(T, assembly, 'Trophy stem', new T.CylinderGeometry(0.17, 0.22, 0.23, q.radialSegments), gold);
  stem.position.y = -0.18;
  const shoulder = addMesh(T, assembly, 'Pedestal shoulder', new T.CylinderGeometry(0.30, 0.36, 0.12, q.radialSegments), bright);
  shoulder.position.y = -0.36;
  const base = addMesh(T, assembly, 'Black polygonal pedestal', new T.CylinderGeometry(0.47, 0.54, 0.22, Math.max(8, q.radialSegments / 2)), black);
  base.position.y = -0.52;
  const foot = addMesh(T, assembly, 'Gold pedestal foot', new T.CylinderGeometry(0.55, 0.60, 0.10, Math.max(8, q.radialSegments / 2)), bright);
  foot.position.y = -0.68;
  const nameplate = addMesh(T, assembly, 'Blank gold award plate', new T.BoxGeometry(0.35, 0.12, 0.025), bright);
  nameplate.position.set(0, -0.52, 0.50);
  return root;
}

function archedChestProfile(T) {
  const shape = new T.Shape();
  shape.moveTo(-0.66, 0);
  shape.lineTo(0.66, 0);
  shape.lineTo(0.66, 0.14);
  shape.quadraticCurveTo(0.64, 0.50, 0, 0.53);
  shape.quadraticCurveTo(-0.64, 0.50, -0.66, 0.14);
  shape.closePath();
  return shape;
}

function makeRewardChest(T, qualityName = 'high') {
  const q = selectQuality(qualityName);
  const { root, pivot } = makeRoot(T, 'Decorative Award Chest', qualityName);
  const black = material(T, 'Chest body · midnight enamel', '#161b27', { metalness: 0.64, roughness: 0.29 });
  const darkGold = material(T, 'Chest underframe · antique gold', '#77500c', { metalness: 0.82, roughness: 0.25 });
  const gold = material(T, 'Chest bands · polished gold', '#e7a927', { metalness: 0.9, roughness: 0.2 });
  const bright = material(T, 'Chest lock and raised trim', '#ffe384', { metalness: 0.92, roughness: 0.16 });
  const inset = material(T, 'Chest panel inset · warm bronze', '#684013', { metalness: 0.78, roughness: 0.3 });
  const assembly = new T.Group();
  assembly.name = 'Closed Decorative Chest Assembly';
  pivot.add(assembly);

  const bottom = addMesh(T, assembly, 'Rectangular chest base', new T.BoxGeometry(1.35, 0.58, 0.78), black);
  bottom.position.y = -0.18;
  const frontPanel = addMesh(T, assembly, 'Inset front panel', new T.BoxGeometry(1.08, 0.38, 0.035), inset);
  frontPanel.position.set(0, -0.19, 0.415);
  const lid = addMesh(T, assembly, 'Genuine extruded arched lid', extrude(T, archedChestProfile(T), q, 0.78, 0.025, 0.035), black);
  lid.position.set(0, 0.11, -0.39);
  const lidPanel = addMesh(T, assembly, 'Raised lid panel', new T.BoxGeometry(0.91, 0.08, 0.025), darkGold);
  lidPanel.position.set(0, 0.50, 0.415);

  for (const side of [-1, 1]) {
    const band = addMesh(T, assembly, `${side < 0 ? 'Left' : 'Right'} vertical gold strap`, new T.BoxGeometry(0.085, 1.02, 0.045), gold);
    band.position.set(side * 0.42, 0.02, 0.425);
    const sideRivetTop = addMesh(T, assembly, `${side < 0 ? 'Left' : 'Right'} strap rivet upper`, new T.SphereGeometry(0.035, q.radialSegments / 2, q.radialSegments / 4), bright);
    sideRivetTop.position.set(side * 0.42, 0.38, 0.46);
    const sideRivetLow = addMesh(T, assembly, `${side < 0 ? 'Left' : 'Right'} strap rivet lower`, new T.SphereGeometry(0.035, q.radialSegments / 2, q.radialSegments / 4), bright);
    sideRivetLow.position.set(side * 0.42, -0.43, 0.46);
  }
  const seam = addMesh(T, assembly, 'Lid and box gold seam', new T.BoxGeometry(1.37, 0.055, 0.86), bright);
  seam.position.y = 0.10;
  const latch = addMesh(T, assembly, 'Blank shield-shaped chest latch', extrude(T, polygonShape(T, [[0, 0.17], [-0.105, 0.08], [-0.09, -0.08], [0, -0.17], [0.09, -0.08], [0.105, 0.08]]), q, 0.045, 0.009, 0.014), bright);
  latch.position.set(0, -0.02, 0.47);
  const keyhole = addMesh(T, assembly, 'Dark decorative latch keyhole', new T.CylinderGeometry(0.025, 0.025, 0.008, q.radialSegments / 2), black);
  keyhole.rotation.x = Math.PI / 2;
  keyhole.position.set(0, -0.04, 0.525);
  const plinth = addMesh(T, assembly, 'Low gold chest plinth', new T.BoxGeometry(1.47, 0.09, 0.88), darkGold);
  plinth.position.y = -0.52;
  return root;
}

function makeNeonBoard(T, mark, qualityName = 'high') {
  const q = selectQuality(qualityName);
  const plateQ = { ...q, curveSegments: Math.min(q.curveSegments, 16), bevelSegments: Math.min(q.bevelSegments, 3) };
  const isX = mark === 'X';
  const name = isX ? 'Neon Cyan X Board Plate' : 'Neon Pink O Board Plate';
  const { root, pivot } = makeRoot(T, name, qualityName);
  const edge = material(T, isX ? 'Cyan luminous outer plate edge' : 'Magenta luminous outer plate edge', isX ? '#22caff' : '#d92bee', {
    metalness: 0.5, roughness: 0.22, emissive: isX ? '#047eff' : '#9925cb', emissiveIntensity: 0.15,
  });
  const frame = material(T, isX ? 'Cobalt board frame' : 'Violet board frame', isX ? '#176da8' : '#8d2eab', { metalness: 0.58, roughness: 0.28 });
  const surface = material(T, 'Midnight blue inset board surface', '#031426', { metalness: 0.38, roughness: 0.37 });
  const grid = material(T, isX ? 'Cyan blue board grid' : 'Pink violet board grid', isX ? '#236caa' : '#77286c', { metalness: 0.44, roughness: 0.3, emissive: isX ? '#09223e' : '#2d0e33', emissiveIntensity: 0.08 });
  const glyph = material(T, isX ? 'Neon cyan X enamel' : 'Neon pink O enamel', isX ? '#27ceff' : '#fc75d9', {
    metalness: 0.34, roughness: 0.23, emissive: isX ? '#28bfff' : '#e81bcf', emissiveIntensity: 0.2,
  });

  const rear = addMesh(T, pivot, 'Rounded rectangular beveled backplate', extrude(T, roundedRect(T, 0.86, 1.30, 0.08), plateQ, 0.09, 0.025, 0.035), frame);
  rear.position.z = -0.055;
  const border = addMesh(T, pivot, 'Raised neon perimeter', extrude(T, roundedRect(T, 0.82, 1.25, 0.075), plateQ, 0.045, 0.018, 0.024), edge);
  border.position.z = 0.022;
  const face = addMesh(T, pivot, 'Inset dark game surface', extrude(T, roundedRect(T, 0.72, 1.14, 0.048), plateQ, 0.022, 0.008, 0.012), surface);
  face.position.z = 0.065;

  const gridX0 = -0.225, gridX1 = 0.225;
  for (const x of [gridX0, gridX1]) {
    const line = addMesh(T, pivot, `Vertical grid divider ${x < 0 ? 1 : 2}`, new T.BoxGeometry(0.012, 1.08, 0.018), grid);
    line.position.set(x, 0, 0.097);
  }
  for (const y of [-0.36, 0.36]) {
    const line = addMesh(T, pivot, `Horizontal grid divider ${y > 0 ? 1 : 2}`, new T.BoxGeometry(0.70, 0.012, 0.018), grid);
    line.position.set(0, y, 0.097);
  }

  // Match the current Card 3 code: the X and O marks occupy the leading,
  // center and trailing diagonal cells (indices 0, 4 and 8).
  const cellCenters = [[-0.30, 0.48], [0, 0], [0.30, -0.48]];
  cellCenters.forEach(([x, y], cellIndex) => {
    if (isX) {
      for (const [armIndex, angle] of [[1, Math.PI / 4], [2, -Math.PI / 4]]) {
        const arm = new T.Group();
        arm.name = `Diagonal X arm ${cellIndex + 1}.${armIndex}`;
        arm.position.set(x, y, 0.115);
        arm.rotation.z = angle;
        const bar = addMesh(T, arm, `Raised X mark ${cellIndex + 1} arm ${armIndex}`, new T.ExtrudeGeometry(roundedRect(T, 0.20, 0.028, 0.013), {
          curveSegments: plateQ.curveSegments, bevelSegments: plateQ.bevelSegments, depth: 0.027,
          bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, steps: 1,
        }), glyph);
        bar.position.z = -0.0135;
        pivot.add(arm);
      }
    } else {
      const ring = new T.TorusGeometry(0.079, 0.014, Math.max(6, q.radialSegments / 6), q.torusSegments);
      const mesh = addMesh(T, pivot, `Raised Neon O mark ${cellIndex + 1}`, ring, glyph);
      mesh.position.set(x, y, 0.129);
    }
  });
  return root;
}

export function createAsset(T, asset, quality = 'high') {
  if (!T?.Group || !T?.MeshStandardMaterial) throw new TypeError('Pass the pinned Three.js module as the first argument.');
  const normalized = String(asset).toLowerCase();
  if (normalized === 'x') return makeX(T, quality);
  if (normalized === 'o') return makeO(T, quality);
  if (normalized === 'coin') return makeCoin(T, quality);
  if (normalized === 'crown') return makeCrown(T, quality);
  if (normalized.startsWith('rank-')) return makeRank(T, normalized.slice(5), quality);
  if (normalized === 'trophy') return makeTrophy(T, quality);
  if (normalized === 'reward-chest') return makeRewardChest(T, quality);
  if (normalized === 'board-x') return makeNeonBoard(T, 'X', quality);
  if (normalized === 'board-o') return makeNeonBoard(T, 'O', quality);
  throw new Error(`Unsupported P21 asset: ${asset}`);
}

export const assetNames = Object.freeze([
  'x', 'o', 'coin', 'crown',
  ...RANK_NAMES.map(rank => `rank-${rank}`),
  'trophy', 'reward-chest', 'board-x', 'board-o',
]);
export const qualityNames = Object.freeze(['high', 'low']);
