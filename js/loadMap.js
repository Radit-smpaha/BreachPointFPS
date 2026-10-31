// loadMap.js — map loader for the three Blender exports.
//   const map = await loadMap('factory', scene, renderer, camera);
//   ...each frame: map.update(dt, camera);
//   map.root (batched scene), map.spawns [{position, yaw}], map.bounds
// Atmosphere presets are tuned for ACES tone mapping + FogExp2 so each map
// reads exactly as it was authored. Static meshes that share a material are
// baked into single draw calls; nearby lights are pooled into PointLights.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';

export const FILES = { factory: 'abandoned_factory.glb', snow: 'snowy_lodge.glb', desert: 'desert_town.glb' };

export const PRESETS = {
  factory: { // overcast late afternoon, hazy warm light through the broken roof
    exposure: 1.6, fog: [0xa7a198, 0.008],
    sky: { top: 0x56626e, horizon: 0xc9ab8d, sunGlow: 0xffc88a },
    sun: { color: 0xffc58a, intensity: 3.6, dir: [-0.55, 0.62, 0.45] },
    hemi: { sky: 0x8a9bab, ground: 0x4a4036, intensity: 1.1 },
    particles: { kind: 'dust', count: 500, color: 0xffe2b8, size: 0.07 },
  },
  snow: { // blue hour, heavy cold fog, falling snow
    exposure: 1.5, fog: [0x9eb3c7, 0.012],
    sky: { top: 0x1f2d47, horizon: 0xa9bed4, sunGlow: 0xffb9a0 },
    sun: { color: 0xcfe0ff, intensity: 2.2, dir: [0.5, 0.35, -0.6] },
    hemi: { sky: 0xb4c8e6, ground: 0xe6eef9, intensity: 1.3 },
    particles: { kind: 'snow', count: 1800, color: 0xffffff, size: 0.11 },
  },
  desert: { // golden hour, long shadows, dusty haze
    exposure: 1.7, fog: [0xe0b48a, 0.006],
    sky: { top: 0x4a6fa5, horizon: 0xf2a56b, sunGlow: 0xffd08a },
    sun: { color: 0xffb066, intensity: 4.2, dir: [-0.8, 0.28, 0.5] },
    hemi: { sky: 0xffd9b0, ground: 0x8a5a3a, intensity: 1.0 },
    particles: { kind: 'dust', count: 700, color: 0xffd9a8, size: 0.09, wind: [3, 0, 1] },
  },
};

function makeSky(p, sunDir) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(p.sky.top) }, hor: { value: new THREE.Color(p.sky.horizon) },
      glow: { value: new THREE.Color(p.sky.sunGlow) }, sun: { value: sunDir.clone() }
    },
    vertexShader: 'varying vec3 v; void main(){ v = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec3 v; uniform vec3 top,hor,glow,sun;
      void main(){ float h = clamp(v.y,0.,1.); vec3 c = mix(hor, top, pow(h,.55));
        float s = max(dot(normalize(v), normalize(sun)), 0.);
        c += glow * (pow(s,6.)*.45 + pow(s,180.)*1.2);
        gl_FragColor = vec4(c,1.); }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(400, 24, 12), mat);
  m.renderOrder = -1; m.frustumCulled = false;
  return m;
}

/* Batch the static map: every non-moving mesh that shares a material is baked
   into one BufferGeometry so hundreds of draw calls collapse into a handful.
   The same triangles and the same shadows are drawn, in far fewer calls. */
function mergeStaticMeshes(root) {
  root.updateMatrixWorld(true);
  const byMat = new Map();
  const toDetach = [];
  root.traverse(o => {
    if (!o.isMesh || o.isSkinnedMesh || !o.geometry || !o.material || o.material.transparent) return;
    const key = o.material.uuid + '|' + !!o.castShadow + '|' + !!o.receiveShadow;
    if (!byMat.has(key)) byMat.set(key, []);
    byMat.get(key).push(o);
  });
  for (const [, list] of byMat) {
    if (list.length < 2) continue;
    let vertexCount = 0, indexCount = 0;
    for (const m of list) {
      const g = m.geometry;
      vertexCount += g.attributes.position.count;
      indexCount += g.index ? g.index.count : g.attributes.position.count;
    }
    const posArr = new Float32Array(vertexCount * 3);
    const normArr = new Float32Array(vertexCount * 3);
    const uvArr = new Float32Array(vertexCount * 2);
    const colArr = list[0].geometry.attributes.color ? new Float32Array(vertexCount * 3) : null;
    const idxArr = new Uint32Array(indexCount);
    let vo = 0, io = 0;
    const v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
    for (const m of list) {
      const g = m.geometry;
      const p = g.attributes.position, nn = g.attributes.normal, uv = g.attributes.uv, col = g.attributes.color;
      m.updateMatrixWorld(true);
      nm.getNormalMatrix(m.matrixWorld);
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
        posArr[(vo + i) * 3] = v.x; posArr[(vo + i) * 3 + 1] = v.y; posArr[(vo + i) * 3 + 2] = v.z;
        if (nn) {
          n.fromBufferAttribute(nn, i).applyMatrix3(nm).normalize();
          normArr[(vo + i) * 3] = n.x; normArr[(vo + i) * 3 + 1] = n.y; normArr[(vo + i) * 3 + 2] = n.z;
        }
        if (uv) { uvArr[(vo + i) * 2] = uv.getX(i); uvArr[(vo + i) * 2 + 1] = uv.getY(i); }
        if (colArr && col) { colArr[(vo + i) * 3] = col.getX(i); colArr[(vo + i) * 3 + 1] = col.getY(i); colArr[(vo + i) * 3 + 2] = col.getZ(i); }
      }
      if (g.index) {
        for (let i = 0; i < g.index.count; i++) idxArr[io + i] = g.index.getX(i) + vo;
        io += g.index.count;
      } else {
        for (let i = 0; i < p.count; i++) idxArr[io + i] = i + vo;
        io += p.count;
      }
      vo += p.count;
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
    merged.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
    if (colArr) merged.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    merged.setIndex(new THREE.BufferAttribute(idxArr, 1));
    merged.computeBoundingSphere();
    const first = list[0];
    const batch = new THREE.Mesh(merged, first.material);
    batch.castShadow = first.castShadow;
    batch.receiveShadow = first.receiveShadow;
    batch.matrixAutoUpdate = false;
    batch.frustumCulled = true;
    batch.name = 'static_batch_' + first.material.name;
    root.add(batch);
    for (const m of list) toDetach.push(m);
  }
  for (const m of toDetach) { if (m.parent) m.parent.remove(m); m.geometry.dispose && m.geometry.dispose(); }
}

function makeParticles(cfg) {
  const n = cfg.count, pos = new Float32Array(n * 3), R = 40;
  for (let i = 0; i < n * 3; i++) pos[i] = (Math.random() - 0.5) * 2 * R;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({
    color: cfg.color, size: cfg.size, transparent: true,
    opacity: cfg.kind === 'snow' ? 0.9 : 0.45, depthWrite: false, sizeAttenuation: true
  }));
  pts.frustumCulled = false;
  const wind = cfg.wind || [0.3, 0, 0.2];
  pts.userData.update = (dt, cam, t) => {
    const a = g.attributes.position.array;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      if (cfg.kind === 'snow') { a[k] += Math.sin(t + i) * 0.4 * dt + 0.8 * dt; a[k + 1] -= (1.2 + (i % 5) * 0.25) * dt; a[k + 2] += Math.cos(t * 0.7 + i) * 0.3 * dt; }
      else { a[k] += (wind[0] + Math.sin(t * 0.5 + i) * 0.3) * dt; a[k + 1] += Math.sin(t * 0.4 + i * 0.7) * 0.12 * dt; a[k + 2] += (wind[2] + Math.cos(t * 0.5 + i) * 0.3) * dt; }
      for (const j of [0, 1, 2]) {
        const d = a[k + j] - cam.position.getComponent(j);
        if (d > R) a[k + j] -= 2 * R; else if (d < -R) a[k + j] += 2 * R;
      }
    }
    g.attributes.position.needsUpdate = true;
  };
  return pts;
}

/* Only the K nearest candidate lights are real PointLights -> forward rendering stays fast. */
class LightPool {
  constructor(scene, defs, k = 4) {
    this.defs = defs; this.lights = [];
    for (let i = 0; i < k; i++) { const l = new THREE.PointLight(0xffffff, 0, 20, 2); scene.add(l); this.lights.push(l); }
  }
  update(camPos, t) {
    const sorted = this.defs.filter(d => d.type === 'light').sort((a, b) => a.pos.distanceToSquared(camPos) - b.pos.distanceToSquared(camPos));
    this.lights.forEach((l, i) => {
      const d = sorted[i];
      if (!d) { l.intensity = 0; return; }
      l.position.copy(d.pos); l.color.set(d.color); l.distance = d.distance;
      let f = 1;
      if (d.flicker) f -= d.flicker * (0.5 + 0.5 * Math.sin(t * 23 + d.pos.x) * Math.sin(t * 7.3 + d.pos.z)) * (Math.random() > 0.93 ? 1 : 0.35);
      if (d.pulse) f = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 3));
      l.intensity = d.intensity * f;
    });
  }
  dispose(scene) { for (const l of this.lights) scene.remove(l); }
}

export async function loadMap(name, scene, renderer, camera, {
  shadows = true, basePath = './', lightPool = 4, lambert = true,
  shadowSize = 2048, particles = true, mergeStatic = true,
} = {}) {
  const P = PRESETS[name];
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = P.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (shadows) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; }
  scene.fog = new THREE.FogExp2(P.fog[0], P.fog[1]);
  // hand the tuned exposure back to the game so nothing later clobbers it
  loadMap.presentation = { exposure: P.exposure, fogColor: P.fog[0], fogDensity: P.fog[1] };

  const sunDir = new THREE.Vector3(...P.sun.dir).normalize();
  const sky = makeSky(P, sunDir); scene.add(sky);
  const hemi = new THREE.HemisphereLight(P.hemi.sky, P.hemi.ground, P.hemi.intensity * 1.25); scene.add(hemi);
  // fill light so shadowed interiors stay readable without washing the sky out
  const fill = new THREE.DirectionalLight(P.hemi.sky, 0.55); fill.position.set(-sunDir.x * 40, 50, -sunDir.z * 40); scene.add(fill);

  const sun = new THREE.DirectionalLight(P.sun.color, P.sun.intensity);
  sun.position.copy(sunDir).multiplyScalar(90);
  if (shadows) {
    sun.castShadow = true; sun.shadow.mapSize.set(shadowSize, shadowSize);
    const c = sun.shadow.camera; c.left = c.bottom = -60; c.right = c.top = 60; c.near = 1; c.far = 220;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
  }
  scene.add(sun, sun.target);

  // procedural environment: gives metals realistic reflections without HDR assets
  if (!loadMap._envFor) loadMap._envFor = {};
  if (!loadMap._envFor[name]) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(10, 16, 8), new THREE.MeshBasicMaterial({ color: P.sky.top, side: THREE.BackSide })));
    const ground = new THREE.Mesh(new THREE.CircleGeometry(10, 16), new THREE.MeshBasicMaterial({ color: P.hemi.ground }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -1; env.add(ground);
    const sunBall = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(P.sun.color).multiplyScalar(5) }));
    sunBall.position.copy(sunDir).multiplyScalar(7); env.add(sunBall);
    loadMap._envFor[name] = pmrem.fromScene(env, 0.04).texture;
    pmrem.dispose();
  }
  scene.environment = loadMap._envFor[name];
  scene.environmentIntensity = 0.5;

  const gltf = await new GLTFLoader().loadAsync(basePath + FILES[name]);
  const root = gltf.scene, spawns = [], lightDefs = [];
  root.updateMatrixWorld(true);
  const toRemove = [];
  root.traverse(o => {
    if (o.isMesh) {
      if (o.material && /Glow_Unlit/.test(o.material.name || '')) {
        o.material = new THREE.MeshBasicMaterial({ vertexColors: o.material.vertexColors });
      }
      o.castShadow = o.receiveShadow = shadows && o.material.name !== 'Glow_Unlit';
      if (lambert && o.material.name === 'LowPoly_VertexColor') o.material = new THREE.MeshLambertMaterial({ vertexColors: true });
      if (o.material.name === 'Glow_Unlit') o.material.toneMapped = false;
    } else if (o.userData?.type === 'spawn') {
      spawns.push({ position: o.getWorldPosition(new THREE.Vector3()), yaw: o.userData.yaw || 0 });
      toRemove.push(o);
    } else if (o.userData?.type === 'light') {
      lightDefs.push({ ...o.userData, pos: o.getWorldPosition(new THREE.Vector3()) });
      toRemove.push(o);
    }
  });
  toRemove.forEach(o => o.parent && o.parent.remove(o));
  scene.add(root);

  if (mergeStatic) {
    try { mergeStaticMeshes(root); } catch (e) { console.warn('static batching skipped:', e); }
  }
  // A merged/instanced subtree whose bounding sphere was never computed is culled by
  // three with a sphere of radius 0 at the origin -> the whole map disappears. Guarantee
  // every descendant has one before anything renders.
  root.traverse(o => {
    if (o.isMesh && o.geometry && !(o.geometry.boundingSphere && isFinite(o.geometry.boundingSphere.radius))) {
      try { o.geometry.computeBoundingSphere(); } catch (e) { o.frustumCulled = false; }
    }
  });

  const pool = new LightPool(scene, lightDefs, lightPool);
  const parts = particles ? makeParticles(P.particles) : null;
  if (parts) scene.add(parts);
  let t = 0;
  return {
    name, root, spawns, floorY: 0,
    bounds: root.userData.bounds || gltf.parser.json.scenes[0]?.extras?.bounds,
    sun, sunDir,
    update(dt, cam = camera, focus = null) {
      t += dt; sky.position.copy(cam.position);
      // shadow frustum follows the player so the 2k shadow map is spent near the action
      if (focus) {
        if (!loadMap._sunTmp) loadMap._sunTmp = new THREE.Vector3();
        const f = loadMap._sunTmp.copy(focus);
        sun.target.position.copy(f); sun.target.updateMatrixWorld();
        sun.position.copy(f).addScaledVector(sunDir, 90); sun.updateMatrixWorld();
      }
      pool.update(cam.position, t);
      if (parts && (parts.userData._f = ((parts.userData._f || 0) + 1)) % 2 === 0) parts.userData.update(dt * 2, cam, t);
    },
    dispose() {
      // every light the atmosphere added must leave too: a second Level (menu preview ->
      // mission) would otherwise run lights from an unloaded map on top of the new one
      scene.remove(root, sky, hemi, fill, sun, sun.target);
      if (parts) scene.remove(parts);
      pool.dispose(scene);
      if (scene.environment === loadMap._envFor[name]) scene.environment = null; // shared PMREM: kept
      scene.fog = null;
    },
  };
}
