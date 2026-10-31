// BREACHPOINT — hostile soldier assembly.
// The soldier_enemy.glb ships with a rig (Root/Hips/Torso/Head/UpperArm_*/
// Forearm_*/...) but no usable animation clips, so each enemy is posed
// procedurally from its bones: walk cycle, aim pitch, crouch, lean, recoil
// and a death fall. A procedural rifle + muzzle flash is parented to the
// right hand. If a bone is missing the geometry is grouped instead, so the
// model still animates.
import * as THREE from 'three';

// Skeleton-aware deep clone. Object3D.clone() SKINNED meshes keep pointing at the
// ORIGINAL template's bones, which never enter the scene graph — every vertex then
// collapses to the origin and the whole soldier renders invisible (only the
// procedural rifle shows). This rebuilds each SkinnedMesh's skeleton from the
// cloned bones and rebinds it, so skinning follows the clone's own rig.
function cloneSkinned(src) {
  const bonesByName = new Map();
  src.traverse(o => { if (o.isBone) bonesByName.set(o.name, o); });
  const clone = src.clone(true);
  const cloneBones = new Map();
  clone.traverse(o => { if (o.isBone) cloneBones.set(o.name, o); });
  clone.traverse(o => {
    if (o.isSkinnedMesh && o.skeleton) {
      const bones = o.skeleton.bones.map(b => cloneBones.get(b.name) || b);
      const skeleton = new THREE.Skeleton(bones, o.skeleton.boneInverses);
      o.bind(skeleton, o.bindMatrix);
    }
  });
  return clone;
}

export function buildSoldier(gltf) {
  if (!gltf || !gltf.scene) {
    const fallback = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.7, 0.6), new THREE.MeshStandardMaterial({ color: 0xff3030 }));
    box.position.y = 0.85; fallback.add(box);
    return { model: fallback, parts: {}, materials: [], mixer: null, anims: {} };
  }
  const src = gltf.scene;
  const model = cloneSkinned(src);
  const parts = {};
  const bones = {};
  const byName = {};
  model.traverse(o => {
    byName[o.name] = o;
    if (o.isMesh && o.material) {
      // never cull the soldier so the player can always see hostiles
      o.frustumCulled = false;
      o.visible = true;
      // Ensure material is opaque and visible
      if (o.material) {
        const m = o.material.clone();
        // Force opaque material - remove any transparency that might make enemy invisible
        m.transparent = false;
        m.opacity = 1.0;
        m.depthWrite = true;
        m.needsUpdate = true;
        o.material = m;
      }
      // PERF: skinned-mesh shadow casting is one of the biggest per-frame GPU costs
      // (each caster re-runs the full vertex skinning pass into the shadow map).
      // Soldiers keep receiveShadow (they still darken correctly); their own cast
      // is invisible in practice at combat range.
      o.castShadow = false;
      o.receiveShadow = true;
    }
  });
  // map expected bone names (tolerant matching)
  const find = (re) => { for (const n in byName) if (re.test(n)) return byName[n]; return null; };
  bones.hips = find(/^Hips$/i) || find(/hip|pelvis/i);
  bones.torso = find(/^Torso$/i) || find(/spine|chest/i);
  bones.head = find(/^Head$/i) || find(/neck/i);
  bones.armL = find(/UpperArm_L|upperarm_l|arm.*_l/i);
  bones.armR = find(/UpperArm_R|upperarm_r|arm.*_r/i);
  bones.foreL = find(/Forearm_L|forearm_l/i);
  bones.foreR = find(/Forearm_R|forearm_r/i);
  bones.legL = find(/^(Upper)?Leg_L|Thigh_L|leg_l/i);
  bones.legR = find(/^(Upper)?Leg_R|Thigh_R|leg_r/i);
  const rigged = !!(bones.torso || bones.armR);

  const materials = [];
  model.traverse(o => {
    if (o.isMesh && o.material) {
      const m = o.material.clone();
      if (m.emissive === undefined) m.emissive = new THREE.Color(0, 0, 0);
      o.material = m; materials.push(m);
      o.castShadow = false; o.receiveShadow = true;
    }
  });

  // scale to a believable 1.82 m soldier
  // The rig rests in a bind pose (arms out, legs apart) so a posed bounding box is
  // not the real height: measure the Root bone instead.
  let H = 0;
  if (bones.hips) {
    const hb = new THREE.Box3().setFromObject(model);
    H = hb.max.y - hb.min.y; // bind pose includes the whole figure
  }
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  if (!H) H = size.y || 1.9;
  const s = (1.62 / Math.max(H, 1.6)) * 1.22; // calibrated against the map scale so the soldier reads ~1.9 m
  model.scale.setScalar(s);
  model.position.y = -box.min.y * s;

  // ---- throw away the model's baked rifle (its own rifle is legacy geometry that
  // never follows the bones); each soldier carries the procedural one below
  const stale = [];
  model.traverse(o => { if (o.isMesh && (/rifle|weapon|gun|scope|barrel|magazine/i.test(o.name) || /rifle|weapon|gun/i.test(o.parent?.name || ''))) stale.push(o); });
  stale.forEach(o => o.parent && o.parent.remove(o));
  const rifle = buildRifle();
  const muzzle = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffd28a, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0.95 }));
  muzzle.scale.setScalar(0.16); muzzle.visible = false;
  rifle.add(muzzle); muzzle.position.set(0, 0.01, 0.52);
  if (bones.foreR || bones.armR) {
    const hand = (bones.foreR && bones.foreR.children.find(c => c.isBone)) || bones.foreR || bones.armR;
    // Right hand socket relative to the animated torso (the arms are posed by
    // enemy.animate(), so the rifle rides their midpoint rather than the bone).
    if (bones.torso) bones.torso.add(rifle); else model.add(rifle);
    rifle.position.set(-0.13, 0.44, 0.30);
    // Rifle and soldier forward along local +Z; root yaw turns them together.
    rifle.rotation.set(-0.05, 0, 0);
    rifle.userData.base = { x: -0.13, y: 0.44, z: 0.30, rx: -0.05, ry: 0, rz: 0 };
  } else {
    model.add(rifle);
    rifle.position.set(0.2, 1.02, 0.28);
    rifle.userData.base = { x: 0.2, y: 1.02, z: 0.28, rx: -0.05, ry: -0.07, rz: 0 };
  }

  parts.torso = bones.torso; parts.head = bones.head;
  parts.armL = bones.armL; parts.armR = bones.armR;
  parts.legL = bones.legL; parts.legR = bones.legR;
  parts.rifle = rifle; parts.muzzle = muzzle;
  parts.restPose = {};
  for (const k in parts) {
    const o = parts[k];
    if (o && o.isObject3D) parts.restPose[k] = { px: o.position.x, py: o.position.y, pz: o.position.z, rx: o.rotation.x, ry: o.rotation.y, rz: o.rotation.z };
  }

  // ---- authored clips, when the export has them
  let mixer = null;
  const anims = {};
  if (gltf.animations && gltf.animations.length) {
    mixer = new THREE.AnimationMixer(model);
    for (const clip of gltf.animations) {
      const n = clip.name.toLowerCase();
      if (n.includes('run') || n.includes('sprint')) anims.run = mixer.clipAction(clip);
      else if (n.includes('walk')) anims.walk = mixer.clipAction(clip);
      else if (n.includes('idle')) anims.idle = mixer.clipAction(clip);
      else if (n.includes('death') || n.includes('die')) anims.death = mixer.clipAction(clip);
    }
    if (anims.idle) { anims.idle.play(); anims.idle.setEffectiveWeight(1); }
    anims.prev = 'idle';
  }
  return { model, parts, materials, rigged, height: 1.82, size, mixer, anims };
}

function buildRifle() {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x22262a, roughness: 0.55, metalness: 0.6 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.44), dark);
  // Weapon forward is local +Z to match the soldier/AI forward convention.
  body.position.z = 0.05; g.add(body);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.34, 6), dark);
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.012, 0.32); g.add(barrel);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.16, 0.06), dark);
  mag.position.set(0, -0.11, -0.02); mag.rotation.x = 0.25; g.add(mag);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.2), dark);
  stock.position.set(0, -0.01, 0.24); g.add(stock);
  const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.16, 8), dark);
  scope.rotation.x = Math.PI / 2; scope.position.set(0, 0.075, -0.02); g.add(scope);
  const accent = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.015, 0.1), new THREE.MeshStandardMaterial({ color: 0x6a5a3a, roughness: 0.7 }));
  accent.position.set(0, 0.045, -0.12); g.add(accent);
  return g;
}

export function disposeSoldier(parts) {
  parts.rifle?.traverse?.(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  parts.muzzle?.material.dispose();
}
