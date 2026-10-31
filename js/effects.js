// BREACHPOINT — visual effects: particle pools, tracers, decals, muzzle flash, debris, casings
import * as THREE from 'three';

const _c = new THREE.Color();

/* single instanced billboard pool used for sparks, blood, dust, smoke */
export class ParticlePool {
  constructor(scene, max, { additive = true, map = null, gravity = 9, drag = 2, bounce = false, colliders = null } = {}) {
    this.max = max; this.gravity = gravity; this.drag = drag; this.bounce = bounce; this.colliders = colliders;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: false, vertexColors: true,
    });
    // use instanced colour via vertex colors on shared geometry (instanceColor)
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);
    this.parts = new Array(max);
    for (let i = 0; i < max; i++) this.parts[i] = { life: 0, max: 1, pos: new THREE.Vector3(), vel: new THREE.Vector3(), size: 1, grav: 1, col: new THREE.Color(), rot: 0, rotV: 0, fade: 1, stretch: 1 };
    this.count = 0;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._e = new THREE.Euler();
  }
  spawn(x, y, z, vx, vy, vz, { life = 0.5, size = 0.1, color = 0xffffff, grav = 1, rotV = 0, stretch = 1 } = {}) {
    let p;
    if (this.count < this.max) p = this.parts[this.count++];
    else { p = this.parts[this._rr = ((this._rr || 0) + 1) % this.max]; }
    p.pos.set(x, y, z); p.vel.set(vx, vy, vz); p.life = life; p.max = life; p.size = size;
    p.col.set(color); p.grav = grav; p.rot = Math.random() * 6.28; p.rotV = rotV; p.fade = 1; p.stretch = stretch;
    return p;
  }
  update(dt, camera) {
    let n = 0;
    const q = this._q;
    // billboard toward camera
    q.copy(camera.quaternion);
    for (let i = 0; i < this.count; i++) {
      const p = this.parts[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vel.y -= this.gravity * p.grav * dt;
      p.vel.multiplyScalar(1 - Math.min(0.95, this.drag * dt));
      p.pos.addScaledVector(p.vel, dt);
      if (this.bounce && this.colliders) {
        const g = this.colliders.groundHeight(p.pos.x, p.pos.z, p.pos.y + 0.1, 0.1);
        if (isFinite(g) && p.pos.y < g) { p.pos.y = g; p.vel.y *= -0.35; p.vel.x *= 0.6; p.vel.z *= 0.6; }
      }
      const k = p.life / p.max;
      const sz = p.size * (p.fade < 1 ? (1 + (1 - Math.min(1, k * 1.6)) * p.fade * 2) : 1) * Math.min(1, k * 3);
      this._s.set(sz, sz * (p.stretch || 1), 1);
      this._e.set(0, 0, p.rot + p.rotV * (p.max - p.life));
      this._q.setFromEuler(this._e).premultiply(q);
      this._m.compose(p.pos, this._q, this._s);
      this.mesh.setMatrixAt(n, this._m);
      const a = p.col;
      this.mesh.instanceColor.setXYZ(n, a.r, a.g, a.b);
      n++;
    }
    // compact dead particles to the end (swap remove keeps it O(n))
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.parts[i].life > 0) { if (w !== i) { const t = this.parts[w]; this.parts[w] = this.parts[i]; this.parts[i] = t; } w++; }
    }
    const changed = w !== this.count || n !== this._lastN;
    this.count = w;
    this.mesh.count = n;
    // PERF: skip the full instance-buffer GPU re-upload when nothing visible changed
    // (empty pools sat at 4 uploads/frame × 4 pools for nothing).
    if (changed || n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
    this._lastN = n;
  }
}

/* soft round sprite texture generated at runtime */
export function makeSprite(size = 64, soft = 0.5) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(soft, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
export function makeSmokeTex(size = 128) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const g = cv.getContext('2d');
  for (let i = 0; i < 22; i++) {
    const r = size * (0.12 + Math.random() * 0.22);
    const x = size / 2 + (Math.random() - 0.5) * size * 0.42, y = size / 2 + (Math.random() - 0.5) * size * 0.42;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.16)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
export function makeSparkTex(size = 32) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const grd = g.createLinearGradient(0, 0, size, 0);
  grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(0.6, 'rgba(255,240,200,0.9)'); grd.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = grd;
  g.fillRect(0, size * 0.42, size, size * 0.16);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/* bullet tracer lines with additive fade */
export class Tracers {
  constructor(scene, max = 40) {
    this.max = max;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.lines = new THREE.LineSegments(geo, mat);
    this.lines.frustumCulled = false;
    scene.add(this.lines);
    this.items = []; // {a,b,life}
  }
  add(a, b, life = 0.07) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({ a: a.clone(), b: b.clone(), life, max: life });
  }
  update(dt) {
    let i = 0;
    for (const it of this.items) {
      it.life -= dt;
      if (it.life <= 0) continue;
      const k = i * 6;
      this.pos[k] = it.a.x; this.pos[k + 1] = it.a.y; this.pos[k + 2] = it.a.z;
      this.pos[k + 3] = it.b.x; this.pos[k + 4] = it.b.y; this.pos[k + 5] = it.b.z;
      i++;
    }
    this.items = this.items.filter(x => x.life > 0);
    this.lines.geometry.setDrawRange(0, i * 2);
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.material.opacity = 0.85;
  }
}

/* bullet-hole decals on surfaces */
export class Decals {
  constructor(scene, max = 90) {
    const geo = new THREE.CircleGeometry(0.055, 8);
    const mat = new THREE.MeshBasicMaterial({ map: makeBulletHole(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false; this.mesh.count = 0;
    scene.add(this.mesh);
    this.i = 0; this.max = max;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._n = new THREE.Vector3();
  }
  add(point, normal) {
    this._n.copy(normal).normalize();
    this._q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this._n);
    this._q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.random() * 6.28));
    const sc = 0.8 + Math.random() * 0.5;
    this._m.compose(point.clone().addScaledVector(this._n, 0.012), this._q, new THREE.Vector3(sc, sc, 1));
    this.mesh.setMatrixAt(this.i, this._m);
    this.i = (this.i + 1) % this.max; this.mesh.count = Math.min(this.max, this.mesh.count + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
function makeBulletHole() {
  const s = 32, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(5,4,3,1)'); grd.addColorStop(0.45, 'rgba(20,16,12,0.9)'); grd.addColorStop(0.7, 'rgba(40,32,24,0.35)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

const _fv = new THREE.Vector3(), _fn = new THREE.Vector3(), _fd = new THREE.Vector3();

/* muzzle flash: star sprite + point light fade */
export class MuzzleFlash {
  constructor(scene) {
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeFlash(), color: 0xffcf8a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    this.sprite.scale.setScalar(0.32); this.sprite.visible = false;
    scene.add(this.sprite);
    this.light = new THREE.PointLight(0xffb060, 0, 9, 2);
    scene.add(this.light);
    this.t = 0;
  }
  fire(pos, dir, scale = 1) {
    this.sprite.position.copy(pos).addScaledVector(dir, 0.08);
    this.sprite.scale.setScalar(0.22 + Math.random() * 0.12 + scale * 0.1);
    this.sprite.material.rotation = Math.random() * 6.28;
    this.sprite.visible = true;
    this.light.position.copy(pos);
    this.light.intensity = 4 * scale;
    this.t = 0.05;
  }
  update(dt) {
    if (this.t > 0) { this.t -= dt; if (this.t <= 0) { this.sprite.visible = false; this.light.intensity = 0; } }
    this.light.intensity *= 0.8;
  }
}
function makeFlash() {
  const s = 128, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const g = cv.getContext('2d'); g.translate(s / 2, s / 2);
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, s / 2);
  grd.addColorStop(0, 'rgba(255,255,240,1)'); grd.addColorStop(0.18, 'rgba(255,220,150,0.95)'); grd.addColorStop(0.5, 'rgba(255,150,60,0.35)'); grd.addColorStop(1, 'rgba(255,100,20,0)');
  g.fillStyle = grd; g.beginPath(); g.arc(0, 0, s / 2, 0, 7); g.fill();
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 6; i++) {
    g.save(); g.rotate((i / 6) * Math.PI * 2 + Math.random());
    const lg = g.createLinearGradient(0, 0, s / 2, 0);
    lg.addColorStop(0, 'rgba(255,240,200,0.9)'); lg.addColorStop(1, 'rgba(255,140,40,0)');
    g.fillStyle = lg; g.beginPath(); g.moveTo(0, -4); g.lineTo(s / 2, 0); g.lineTo(0, 4); g.fill(); g.restore();
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/* casings that pop out of the ejection port and bounce */
export class Casings {
  constructor(scene, colliders, max = 40) {
    this.colliders = colliders;
    const geo = new THREE.CylinderGeometry(0.008, 0.008, 0.03, 5);
    const mat = new THREE.MeshStandardMaterial({ color: 0xc9a253, metalness: 0.9, roughness: 0.35 });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false; this.mesh.count = max;
    scene.add(this.mesh);
    this.items = [];
    for (let i = 0; i < max; i++) this.items.push({ life: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Euler(), rv: new THREE.Vector3() });
    this.i = 0; this.max = max; this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._one = new THREE.Vector3(1, 1, 1);
    this._m.makeScale(0, 0, 0);
    for (let k = 0; k < max; k++) this.mesh.setMatrixAt(k, this._m);
  }
  spawn(pos, vel) {
    const it = this.items[this.i]; this.i = (this.i + 1) % this.max;
    it.life = 2.5; it.pos.copy(pos); it.vel.copy(vel);
    it.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    it.rv.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
  }
  update(dt) {
    for (let k = 0; k < this.max; k++) {
      const it = this.items[k];
      if (it.life > 0) {
        it.life -= dt;
        it.vel.y -= 18 * dt;
        it.pos.addScaledVector(it.vel, dt);
        const g = this.colliders.groundHeight(it.pos.x, it.pos.z, it.pos.y + 0.1, 0.2);
        if (isFinite(g) && it.pos.y < g + 0.015) { it.pos.y = g + 0.015; it.vel.y *= -0.35; it.vel.x *= 0.6; it.vel.z *= 0.6; it.rv.multiplyScalar(0.4); }
        it.rot.x += it.rv.x * dt; it.rot.y += it.rv.y * dt; it.rot.z += it.rv.z * dt;
        this._q.setFromEuler(it.rot);
        this._m.compose(it.pos, this._q, this._one);
        this.mesh.setMatrixAt(k, this._m);
      } else if (it.life > -1) {
        it.life = -2; this._m.makeScale(0, 0, 0); this.mesh.setMatrixAt(k, this._m);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/* blood mist / impact puffs helper bundle */
export class FX {
  constructor(scene, colliders, camera) {
    this.scene = scene; this.colliders = colliders; this.camera = camera;
    this.sparks = new ParticlePool(scene, 420, { additive: true, map: makeSprite(48, 0.3), gravity: 14, drag: 1.5 });
    this.dust = new ParticlePool(scene, 260, { additive: false, map: makeSprite(64, 0.4), gravity: -2.5, drag: 1.6 });
    this.blood = new ParticlePool(scene, 260, { additive: false, map: makeSmokeTex(64), gravity: 9, drag: 1.4, colliders });
    this.smoke = new ParticlePool(scene, 180, { additive: false, map: makeSmokeTex(128), gravity: -0.8, drag: 1.1 });
    this.tracers = new Tracers(scene, 60);
    this.decals = new Decals(scene, 110);
    this.casings = new Casings(scene, colliders, 32);
    this.muzzle = new MuzzleFlash(scene);
    this._v = new THREE.Vector3(); this._n = new THREE.Vector3();
  }
  impact(point, normal, kind = 'concrete') {
    const n = normal ? _fn.copy(normal) : _fn.set(0, 1, 0);
    for (let i = 0; i < 7; i++) {
      const v = _fv.set((Math.random() - 0.5) * 5, Math.random() * 4, (Math.random() - 0.5) * 5).addScaledVector(n, 2.5);
      this.sparks.spawn(point.x, point.y, point.z, v.x, v.y, v.z, { life: 0.18 + Math.random() * 0.25, size: 0.05, color: kind === 'metal' ? 0xffe6b0 : 0xffc27a, grav: 1.2, stretch: 1.6 });
    }
    for (let i = 0; i < 4; i++) {
      const v = _fv.set((Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2).addScaledVector(n, 1.4);
      this.dust.spawn(point.x, point.y, point.z, v.x, v.y, v.z, { life: 0.5 + Math.random() * 0.5, size: 0.09 + Math.random() * 0.08, color: kind === 'metal' ? 0x9aa0a6 : 0xb9a98f, grav: 0.25, rotV: (Math.random() - 0.5) * 3 });
    }
    this.decals.add(point, n);
  }
  bloodBurst(point, dir, amount = 8) {
    const d = dir ? _fd.copy(dir) : _fd.set(0, 0, 0);
    for (let i = 0; i < amount; i++) {
      const v = _fv.set((Math.random() - 0.5) * 3, Math.random() * 2.4, (Math.random() - 0.5) * 3).addScaledVector(d, 2.2);
      this.blood.spawn(point.x, point.y, point.z, v.x, v.y, v.z, { life: 0.45 + Math.random() * 0.4, size: 0.12 + Math.random() * 0.16, color: 0x7a0d0b, grav: 0.7, rotV: (Math.random() - 0.5) * 2 });
    }
    for (let i = 0; i < 4; i++) {
      const v = _fv.set((Math.random() - 0.5) * 1.2, Math.random() * 0.7, (Math.random() - 0.5) * 1.2).addScaledVector(d, 0.8);
      this.blood.spawn(point.x, point.y, point.z, v.x, v.y, v.z, { life: 0.7, size: 0.3, color: 0x5a0808, grav: 0.15 });
    }
  }
  explosion(pos, radius = 4, color = 0xffd080) {
    const light = this.muzzle.light;
    light.position.copy(pos); light.intensity = 25; light.color.setHex(color);
    const centerY = pos.y + 0.6;

    // fireball core: dense sphere of fire particles rising
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.7;
      const d = _fv.set(Math.cos(a) * r, 1.1 + Math.random() * 0.4, Math.sin(a) * r);
      const s = 1.5 + Math.random() * 2;
      this.sparks.spawn(pos.x + d.x * 0.3, centerY + d.y * 0.3, pos.z + d.z * 0.3,
        d.x * s * 0.5, d.y * s * 1.6, d.z * s * 0.5,
        { life: 0.9 + Math.random() * 0.7, size: 0.16, color: color, grav: -0.9, rotV: (Math.random() - 0.5) * 1.0 });
    }
    // outward blast wave sparks with long trails
    for (let i = 0; i < 30; i++) {
      const d = _fv.set(Math.random() - 0.5, Math.random() * 0.5, Math.random() - 0.5).normalize();
      const s = 6 + Math.random() * 14;
      this.sparks.spawn(pos.x, centerY, pos.z,
        d.x * s, d.y * s * 0.6 + 1.0, d.z * s,
        { life: 0.4 + Math.random() * 0.3, size: 0.11,
          color: [color, 0xff8a30, 0xfff2c0][i % 3], grav: 1.8, stretch: 2.2 });
    }
    // billowing smoke pillars
    for (let i = 0; i < 40; i++) {
      const d = _fv.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize();
      const s = 1.0 + Math.random() * 3.0;
      this.smoke.spawn(pos.x + d.x * 0.25, centerY + d.y * 0.35, pos.z + d.z * 0.25,
        d.x * s * 0.55, d.y * s * 0.7 + 0.9, d.z * s * 0.55,
        { life: 1.8 + Math.random() * 1.6, size: 1.0 + Math.random() * 1.0,
          color: i % 3 === 0 ? 0x2a2420 : 0x5c5550, grav: -0.07, rotV: (Math.random() - 0.5) * 0.7 });
    }
    // rising fire embers
    for (let i = 0; i < 20; i++) {
      const d = _fv.set(Math.random() - 0.5, 0.4, Math.random() - 0.5).normalize();
      const s = 1.0 + Math.random() * 1.5;
      this.sparks.spawn(pos.x + d.x * 0.2, centerY + 0.4, pos.z + d.z * 0.2,
        d.x * s * 0.3, 2.0 + Math.random() * 2.0, d.z * s * 0.3,
        { life: 1.2 + Math.random() * 1.0, size: 0.08, color: 0xffaa00, grav: -1.0, rotV: (Math.random() - 0.5) * 0.6 });
    }
    // heavy debris chunks
    this.debris(pos, 15);
    // screen shake + chromatic hint
    if (this.camera) {
      this.camera.position.x += (Math.random() - 0.5) * 0.14;
      this.camera.position.y += (Math.random() - 0.5) * 0.14;
      this.camera.position.z += (Math.random() - 0.5) * 0.14;
    }
  }
  smoke(pos, radius) {
    // thick smoke screen that lingers
    const cx = pos.x, cy = pos.y + 1, cz = pos.z;
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * radius;
      const d = _fv.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      this.smoke.spawn(cx + d.x, cy, cz + d.z, d.x * 0.4, 0.6 + Math.random() * 0.8, d.z * 0.4,
        { life: 4 + Math.random() * 3, size: 1.2 + Math.random() * 1.2, color: 0x6b6b70, grav: -0.03, rotV: (Math.random() - 0.5) * 0.4 });
    }
  }
  debris(pos, n = 8) {
    for (let i = 0; i < n; i++) {
      const d = _fv.set(Math.random() - 0.5, Math.random() * 0.8 + 0.3, Math.random() - 0.5).normalize();
      const s = 4 + Math.random() * 8;
      this.dust.spawn(pos.x, pos.y + 0.4, pos.z, d.x * s, d.y * s * 0.7 + 2.0, d.z * s,
        { life: 0.9 + Math.random() * 0.8, size: 0.09, color: 0x4a4038, grav: 2.2, rotV: (Math.random() - 0.5) * 20 });
    }
  }
  // fire effect: burning embers that linger
  fire(pos, radius = 1.5, life = 3) {
    const cx = pos.x, cy = pos.y, cz = pos.z;
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * radius;
      const d = _fv.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      this.sparks.spawn(cx + d.x, cy + 0.2, cz + d.z, d.x * 0.3, 1.2 + Math.random() * 1.5, d.z * 0.3,
        { life: life + Math.random() * 2, size: 0.06 + Math.random() * 0.04, color: 0xffaa00, grav: -0.8, rotV: (Math.random() - 0.5) * 0.5, stretch: 1.0 });
      this.smoke.spawn(cx + d.x * 0.5, cy + 0.3, cz + d.z * 0.5, d.x * 0.2, 0.4 + Math.random() * 0.3, d.z * 0.2,
        { life: 1.0 + Math.random() * 1.0, size: 0.4 + Math.random() * 0.3, color: 0x4a3a2a, grav: -0.02, rotV: (Math.random() - 0.5) * 0.3 });
    }
  }
  smokePuff(pos, n = 10, color = 0x8a8a88) {
    for (let i = 0; i < n; i++) {
      const d = _fv.set(Math.random() - 0.5, Math.random() * 0.5, Math.random() - 0.5);
      this.smoke.spawn(pos.x, pos.y + 0.1, pos.z, d.x * 1.4, d.y * 1.4 + 0.4, d.z * 1.4, { life: 1.4 + Math.random(), size: 0.5 + Math.random() * 0.5, color, grav: -0.05, rotV: (Math.random() - 0.5) });
    }
  }
  // flashbang: blinding white sphere with expanding ring
  flashbang(pos) {
    const light = this.muzzle.light;
    light.position.copy(pos); light.intensity = 24; light.color.setHex(0xffffff);
    // bright white spherical burst
    for (let i = 0; i < 18; i++) {
      const d = _fv.set(Math.random() - 0.5, Math.random() * 0.3, Math.random() - 0.5).normalize();
      const s = 3 + Math.random() * 5;
      this.sparks.spawn(pos.x, pos.y + 0.25, pos.z, d.x * s, d.y * s * 0.5 + 1.0, d.z * s, { life: 0.5 + Math.random() * 0.3, size: 0.13, color: 0xffffff, grav: 0.4, stretch: 1.4 });
    }
    // expanding white ring
    for (let i = 0; i < 20; i++) {
      const d = _fv.set(Math.random() - 0.5, 0.15, Math.random() - 0.5).normalize();
      const s = 1.5 + Math.random() * 3;
      this.smoke.spawn(pos.x + d.x * 0.2, pos.y + 0.2, pos.z + d.z * 0.2, d.x * s * 0.5, 0.4 + Math.random() * 0.3, d.z * s * 0.5,
        { life: 2.5 + Math.random() * 1.5, size: 0.8 + Math.random() * 0.6, color: 0xe8e8e8, grav: -0.03, rotV: (Math.random() - 0.5) * 0.5 });
    }
    if (this.camera) {
      this.camera.position.x += (Math.random() - 0.5) * 0.15;
      this.camera.position.y += (Math.random() - 0.5) * 0.15;
      this.camera.position.z += (Math.random() - 0.5) * 0.15;
    }
  }
  // fire effect: burning embers that linger
  fire(pos, radius = 1.5, life = 3) {
    const cx = pos.x, cy = pos.y, cz = pos.z;
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * radius;
      const d = _fv.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      this.sparks.spawn(cx + d.x, cy + 0.2, cz + d.z, d.x * 0.3, 1.2 + Math.random() * 1.5, d.z * 0.3,
        { life: life + Math.random() * 2, size: 0.06 + Math.random() * 0.04, color: 0xffaa00, grav: -0.8, rotV: (Math.random() - 0.5) * 0.5, stretch: 1.0 });
      this.smoke.spawn(cx + d.x * 0.5, cy + 0.3, cz + d.z * 0.5, d.x * 0.2, 0.4 + Math.random() * 0.3, d.z * 0.2,
        { life: 1.0 + Math.random() * 1.0, size: 0.4 + Math.random() * 0.3, color: 0x4a3a2a, grav: -0.02, rotV: (Math.random() - 0.5) * 0.3 });
    }
  }
  tracer(a, b) { this.tracers.add(a, b); }
  update(dt) {
    this.sparks.update(dt, this.camera); this.dust.update(dt, this.camera);
    this.blood.update(dt, this.camera); this.smoke.update(dt, this.camera);
    this.tracers.update(dt); this.casings.update(dt); this.muzzle.update(dt);
  }
  dispose() {
    const s = this.scene;
    for (const p of [this.sparks, this.dust, this.blood, this.smoke]) {
      s.remove(p.mesh); p.mesh.material.dispose(); p.mesh.geometry.dispose();
    }
    s.remove(this.tracers.lines); this.tracers.lines.geometry.dispose(); this.tracers.lines.material.dispose();
    s.remove(this.decals.mesh); this.decals.mesh.material.map?.dispose(); this.decals.mesh.material.dispose(); this.decals.mesh.geometry.dispose();
    s.remove(this.casings.mesh); this.casings.mesh.geometry.dispose(); this.casings.mesh.material.dispose();
    s.remove(this.muzzle.sprite); this.muzzle.sprite.material.map?.dispose(); this.muzzle.sprite.material.dispose();
    s.remove(this.muzzle.light);
  }
}
