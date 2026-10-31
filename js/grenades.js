// BREACHPOINT — grenade physics: gravity, bouncing off walls/floors, fuse, blast damage
import * as THREE from 'three';

const GRAV = 20;

export class Grenades {
  constructor(scene, colliders, fx, audio) {
    this.scene = scene; this.colliders = colliders; this.fx = fx; this.audio = audio;
    this.list = [];
    this.geo = new THREE.IcosahedronGeometry(0.07, 1);
    this.geo.scale(0.8, 1.0, 0.8);
    this.mat = new THREE.MeshStandardMaterial({ color: 0x2f3a2c, roughness: 0.6, metalness: 0.45 });
    this.lightGeo = new THREE.SphereGeometry(0.02, 6, 6);
    this.lightMat = new THREE.MeshBasicMaterial({ color: 0xff3020, toneMapped: false });
    this.onExplode = null; // (pos, dmg, radius, enemy, type)
  }
  throw(vel, from, { enemy = false, fuse = 2.4, dmg = 110, radius = 7, throwable = 'grenade', model = null } = {}) {
    let mesh;
    if (model && model.scene) {
      mesh = model.scene.clone();
      mesh.scale.setScalar(0.6);
      mesh.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
    } else {
      mesh = new THREE.Mesh(this.geo, this.mat);
      mesh.castShadow = true;
    }
    mesh.position.copy(from);
    const led = new THREE.Mesh(this.lightGeo, this.lightMat);
    led.position.set(0.05, 0.05, 0);
    mesh.add(led);
    this.scene.add(mesh);
    const g = { mesh, led, vel: vel.clone(), fuse, dmg, radius, enemy, bounces: 0, rest: false, spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8), armed: 0.6, throwable, color: throwable === 'smoke_bomb' ? 0x8a8a8a : throwable === 'flashbang' ? 0xfff0a0 : 0xff3020 };
    mesh.userData.g = g;
    this.list.push(g);
    this.audio && this.audio.pin();
    return g;
  }
  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const g = this.list[i];
      g.fuse -= dt; g.armed -= dt;
      if (!g.rest) {
        g.vel.y -= GRAV * dt;
        const p = g.mesh.position;
        const nx = p.x + g.vel.x * dt, nz = p.z + g.vel.z * dt, ny = p.y + g.vel.y * dt;
        // wall collision: resolve horizontally, reflect velocity
        const before = new THREE.Vector3(nx, p.y, nz);
        const test = new THREE.Vector3(nx, p.y + 0.06, nz);
        const resolved = this.colliders.groundHeight(test.x, test.z, test.y, 0.4);
        const blockedTop = this.hitTall(test, p.y + 0.06);
        if (blockedTop) {
          // push back out and bounce
          const back = new THREE.Vector3(p.x - nx, 0, p.z - nz);
          if (Math.abs(back.x) > 1e-4) g.vel.x *= -0.45;
          if (Math.abs(back.z) > 1e-4) g.vel.z *= -0.45;
          p.x = p.x + back.x * 0.4; p.z = p.z + back.z * 0.4;
          g.bounces++;
          if (g.bounces < 4) this.audio && this.audio.grenadeBounce(p);
        } else { p.x = nx; p.z = nz; }
        // floor collision
        const floor = this.colliders.groundHeight(p.x, p.z, ny + 0.12, 0.3);
        if (isFinite(floor) && ny <= floor + 0.07) {
          p.y = floor + 0.07;
          if (Math.abs(g.vel.y) > 1.2) {
            g.vel.y *= -0.38; g.vel.x *= 0.62; g.vel.z *= 0.62; g.bounces++;
            if (g.bounces < 5) this.audio && this.audio.grenadeBounce(p);
          } else {
            g.vel.y = 0; g.vel.x *= 0.86; g.vel.z *= 0.86;
            if (Math.hypot(g.vel.x, g.vel.z) < 0.4) { g.rest = true; g.vel.set(0, 0, 0); }
          }
        } else p.y = ny;
        // ceiling / low box
        const ceil = this.hitCeil(p, p.y);
        if (ceil) { p.y = ceil - 0.08; g.vel.y *= -0.3; }
        if (p.y < -30) { g.fuse = 0; }
      }
      // spin + LED blink
      if (!g.rest) {
        g.mesh.rotation.x += g.spin.x * dt; g.mesh.rotation.y += g.spin.y * dt; g.mesh.rotation.z += g.spin.z * dt;
      }
      g.led.visible = (g.fuse % 0.4) < (g.fuse < 1 ? 0.24 : 0.1);
      if (g.fuse <= 0) {
        this.list.splice(i, 1);
        this.scene.remove(g.mesh);
        this.fx.explosion(g.mesh.position, g.radius, g.color);
        this.audio && this.audio.explosion(g.mesh.position);
        this.onExplode && this.onExplode(g.mesh.position.clone(), g.dmg, g.radius, g.enemy, g.throwable);
      }
    }
  }
  clear() { for (const g of this.list) this.scene.remove(g.mesh); this.list.length = 0; }
  hitTall(p, feetY) {
    const list = this.colliders.query(p.x - 0.1, p.z - 0.1, p.x + 0.1, p.z + 0.1);
    for (const b of list) if (b.maxY > feetY + 0.1 && b.minY < feetY + 0.25) return true;
    return false;
  }
  hitCeil(p, feetY) {
    const list = this.colliders.query(p.x - 0.1, p.z - 0.1, p.x + 0.1, p.z + 0.1);
    let best = null;
    for (const b of list) if (b.minY > feetY && b.minY < feetY + 0.4) best = best === null ? b.minY : Math.min(best, b.minY);
    return best;
  }
}
