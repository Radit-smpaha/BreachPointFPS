// BREACHPOINT — breach objective nodes: glowing relay crates with a hold-to-arm charge
import * as THREE from 'three';

function glowTexture() {
  const s = 128, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,200,80,0.9)'); grd.addColorStop(0.35, 'rgba(255,150,30,0.35)'); grd.addColorStop(1, 'rgba(255,120,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class ObjectiveNode {
  constructor(scene, def, accent = 0xffb020, c4Model = null) {
    this.def = def;
    this.group = new THREE.Group();
    this.group.position.copy(def.pos);
    scene.add(this.group);
    this.accent = new THREE.Color(accent);
    // C4 bomb model (deployed relay charge), falls back to a crate if missing
    if (c4Model && c4Model.scene) {
      const bomb = c4Model.scene.clone();
      bomb.scale.setScalar(0.55);
      bomb.position.y = 0.45;
      bomb.castShadow = true; bomb.receiveShadow = true;
      bomb.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
      this.crate = bomb;
      this.group.add(bomb);
    } else {
      this.crate = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.7, 0.9, 1, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0x2a2d2f, roughness: 0.65, metalness: 0.55 })
      );
      this.crate.position.y = 0.35; this.crate.castShadow = true; this.crate.receiveShadow = true;
      this.group.add(this.crate);
    }
    // accent strips
    this.stripMat = new THREE.MeshBasicMaterial({ color: accent, toneMapped: false });
    for (const [x, z, w, d] of [[0, 0.46, 0.92, 0.04], [0, -0.46, 0.92, 0.04], [0.46, 0, 0.04, 0.92], [-0.46, 0, 0.04, 0.92]]) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, d), this.stripMat);
      s.position.set(x, 0.62, z); this.group.add(s);
    }
    // antenna / dish
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.1, 6), new THREE.MeshStandardMaterial({ color: 0x15181a, metalness: 0.8, roughness: 0.4 }));
    mast.position.y = 1.25; this.group.add(mast);
    this.dish = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x3a3f43, metalness: 0.7, roughness: 0.35, side: THREE.DoubleSide }));
    this.dish.position.y = 1.8; this.dish.rotation.x = -1.1; this.group.add(this.dish);
    // beacon light above
    this.beaconMat = new THREE.MeshBasicMaterial({ color: 0xff4020, toneMapped: false });
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), this.beaconMat);
    this.beacon.position.y = 2.05; this.group.add(this.beacon);
    this.light = new THREE.PointLight(accent, 3, 9, 2);
    this.light.position.set(0, 1.2, 0); this.group.add(this.light);
    // ground ring + glow sprite
    this.ring = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.25, 40), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = 0.03; this.group.add(this.ring);
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: accent, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    this.halo.scale.setScalar(4); this.halo.position.y = 0.8; this.group.add(this.halo);
    this.armed = false; this.progress = 0;
    this.explodeT = 0;
    this.defuseT = 0;
    this.defusing = false;
  }
  update(dt, t, playerPos) {
    // PERF: node animations run at 15Hz instead of every physics step (90Hz) —
    // pulsing rings/beacons are visually identical at 15fps.
    this._animT = (this._animT || 0) + dt;
    if (this._animT < 1 / 15) return;
    const t2 = this._animT; this._animT = 0;
    this.ring.material.opacity = 0.35 + Math.sin(t2 * 2 + this.def.id) * 0.15;
    this.halo.material.opacity = 0.45 + Math.sin(t2 * 1.7 + this.def.id) * 0.15;
    // C4 countdown: armed = flashing red, defusing = filling green
    if (this.armed) {
      this.beaconMat.color.setHex((t2 % 0.25) < 0.12 ? 0xff3020 : 0x330800);
    } else {
      this.beaconMat.color.setHex((t2 % 1) < 0.5 ? 0xff3020 : 0x330800);
    }
    this.light.intensity = 2 + Math.sin(t2 * 1.7) * 0.7;
    if (this.progress > 0 && !this.armed) {
      this.stripMat.color.setHSL(0.1, 1, 0.5 + Math.sin(t2 * 14) * 0.2);
    }
    if (this.defusing) {
      this.stripMat.color.setHSL(0.35, 1, 0.5 + Math.sin(t2 * 20) * 0.2);
    }
  }
  arm() {
    this.armed = true; this.progress = 1;
    this.explodeT = 45; // 45 second defuse window
    this.stripMat.color.setHex(0xff3020);
    this.light.color.setHex(0xff3020);
    this.halo.material.color.setHex(0xff3020);
    this.ring.material.color.setHex(0xff3020);
  }
  startDefuse() { this.defusing = true; }
  stopDefuse() { this.defusing = false; }
  updateDefuse(dt) {
    if (!this.defusing || !this.armed) return false;
    this.defuseT += dt;
    if (this.defuseT >= 3.0) { // 3 seconds to defuse
      this.armed = false; this.explodeT = 0; this.defusing = false; this.defuseT = 0;
      this.stripMat.color.setHex(0x2bff88);
      this.light.color.setHex(0x2bff88);
      this.halo.material.color.setHex(0x2bff88);
      this.ring.material.color.setHex(0x2bff88);
      return true; // defused
    }
    return false;
  }
  updateExplosion(dt, fx) {
    if (this.explodeT <= 0) return false;
    this.explodeT -= dt;
    const k = 1 - this.explodeT / 45;
    const s = 1 + k * 0.4;
    this.crate.scale.setScalar(s + Math.sin(k * 40) * 0.03);
    if (this.explodeT <= 0) return true;
    return false;
  }
  dispose(scene) { scene.remove(this.group); this.group.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
}
