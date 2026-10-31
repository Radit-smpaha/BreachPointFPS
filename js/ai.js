// BREACHPOINT — hostile AI
// Each soldier runs a behaviour state machine on top of A* navigation:
//  PATROL → INVESTIGATE (last known pos) → ENGAGE (fire from cover) →
//  SUPPRESS (pinned, blind fire) → FLANK (squad element) → RUSH → DEAD
// They share sighting information per squad, choose cover that breaks the
// player's line of sight, lean out to shoot, back off to reload, and throw
// grenades when the player hides or is out of reach.
import * as THREE from 'three';
import { _v1, _v2, _v3, _v4 } from './world.js';

const V = new THREE.Vector3();
const TMP = new THREE.Vector3();
const _scatter = new THREE.Vector3(), _part = new THREE.Vector3(), _aim = new THREE.Vector3();
const _end = new THREE.Vector3(), _ray = new THREE.Vector3(), _src = new THREE.Vector3();
const _chest = new THREE.Vector3(), _neg = new THREE.Vector3();

export const DIFFICULTY = {
  recruit: { hp: 80, dmg: 7, accuracy: 0.30, reaction: 0.95, burstMin: 2, burstMax: 4, sense: 34, aggression: 0.35, throwChance: 0.25 },
  operator: { hp: 100, dmg: 10, accuracy: 0.40, reaction: 0.7, burstMin: 2, burstMax: 5, sense: 40, aggression: 0.5, throwChance: 0.45 },
  veteran: { hp: 120, dmg: 15, accuracy: 0.62, reaction: 0.38, burstMin: 4, burstMax: 8, sense: 50, aggression: 0.85, throwChance: 0.8 },
};

const STATES = ['patrol', 'investigate', 'engage', 'suppress', 'flank', 'rush'];

export class Enemy {
  constructor(game, model, squad, opts = {}) {
    this.game = game;
    this.root = new THREE.Group();
    this.root.add(model);
    this.model = model;
    this.pos = this.root.position; // feet
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.squad = squad;
    this.cfg = game.diff;
    this.hp = this.cfg.hp; this.maxHp = this.cfg.hp;
    this.state = 'patrol'; this.stateT = 0;
    this.path = []; this.pathI = 0;
    this.target = new THREE.Vector3(); this.hasTarget = false;
    this.lastSeen = new THREE.Vector3(); this.lastSeenT = -99;
    this.seenNow = false; this.seesPlayer = false;
    this.seeTime = 0; this.reactionT = 0;
    this.fireT = 0; this.burstT = 0; this.burstLeft = 0;
    this.suppression = 0; this.suppressed = false;
    this.crouch = 0; this.crouchWant = 0;
    this.lean = 0; this.leanTarget = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1; this.strafeT = 0;
    this.reloadT = 0; this.mag = 30;
    this.cover = null; this.coverT = 0;
    this.role = 'assault';
    this.alertness = 0; this.alertT = 0;
    this.dead = false; this.deathT = 0; this.deathDir = 1;
    this.onGround = true; this.vy = 0;
    this.throwCd = 4 + Math.random() * 5;
    this.think = Math.random() * 0.2;
    this.anim = { phase: Math.random() * 6, speed: 0, kick: 0, recoil: 0, aimPitch: 0 };
    this.parts = {};
    this.hitR = { head: 0.13, body: 0.32 };
    this.voiceCd = 0;
    this.muzzleT = 0;
    this._eye = new THREE.Vector3();
    this.name = opts.name || 'hostile';
    this.broken = false;
  }

  get eye() { return _v2.set(this.pos.x, this.pos.y + 1.55 - this.crouch * 0.55, this.pos.z); }

  spawnNav(x, z) {
    const i = this.game.level.nav.nearestWalkable(x, z);
    if (i >= 0) { const w = this.game.level.nav.cellToWorld(i); this.pos.set(w.x, this.game.level.nav.floor[i], w.z); }
    this.root.position.copy(this.pos);
  }

  /* ---------------- perception ---------------- */
  canSee(targetPos, fov = 1.15) {
    const eye = this._eye.copy(this.eye); // copy: raycast reads it while _v2 is reused
    const dx = targetPos.x - eye.x, dz = targetPos.z - eye.z;
    const dist = Math.hypot(dx, dz);
    if (dist > this.cfg.sense) return false;
    if (dist > 3) {
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const dot = (fx * dx + fz * dz) / (dist || 1);
      if (dot < Math.cos(fov) && this.alertness < 0.6) return false;
    }
    return !this.game.level.losBlocked(eye, targetPos);
  }
  perceive(dt, player) {
    this.seenNow = false;
    let any = false;
    if (player.alive) {
      const tgt = _v1.set(player.pos.x, player.pos.y + 1.2, player.pos.z);
      const d = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
      let fov = 1.2;
      if (!player.onGround || player.sprinting) fov = 1.45; // sprint/jump = louder & easier to spot
      if (this.canSee(tgt, fov) || (d < 6 && !this.game.level.losBlocked(this._eye.copy(this.eye), tgt))) {
        this.seenNow = true; this.seesPlayer = true;
        this.seeTime += dt;
        this.lastSeen.copy(player.pos); this.lastSeenT = this.game.time;
        this.alertness = 1; this.alertT = 0;
        if (this.reactionT <= 0) this.reactionT = Math.min(this.cfg.reaction, 0.35 + Math.random() * 0.45);
        this.squad?.reportSighting(this, player.pos);
      } else {
        this.seesPlayer = false;
        if (this.seenNow) this.lastSeenT = this.game.time;
      }
    }
    // ---- hearing: gunfire, sprint steps, explosions
    if (this.game.playerNoise > 0) {
      const nd = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
      if (nd < this.game.playerNoise * 30) {
        this.alertness = Math.min(1, this.alertness + 0.5);
        this.alertT = 0;
        if (this.state === 'patrol') {
          this.lastSeen.copy(player.pos).add(_scatter.set((Math.random() - 0.5) * 4, 0, (Math.random() - 0.5) * 4));
          this.lastSeenT = this.game.time - 1;
          this.setPathTo(this.lastSeen, 'investigate');
        }
      }
    }
    if (!this.seenNow) { this.alertT += dt; if (this.alertT > 13) this.alertness = Math.max(0, this.alertness - dt * 0.08); }
    if (this.reactionT > 0 && (this.seenNow || this.squad?.sharesTarget)) this.reactionT -= dt;
    if (this.seeTime > 0 && !this.seenNow) this.seeTime = Math.max(0, this.seeTime - dt * 2);
    if (this.seenNow) any = true;
    return any;
  }

  /* ---------------- navigation ---------------- */
  setPathTo(dest, state = null, direct = false) {
    const nav = this.game.level.nav;
    this.target.copy(dest); this.hasTarget = true;
    let pts = nav.findPath(this.pos.x, this.pos.z, dest.x, dest.z);
    if (pts.length > 0) pts = nav.smoothPath(pts);
    if (pts.length) pts[pts.length - 1] = { x: dest.x, z: dest.z, exact: true };
    this.path = pts; this.pathI = 0;
    if (state) this.setState(state);
    return pts.length > 0;
  }
  followPath(dt, speed) {
    if (!this.path.length) return false;
    const nav = this.game.level.nav;
    let wp = this.path[this.pathI];
    if (!wp) return false;
    const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.55) {
      this.pathI++;
      if (this.pathI >= this.path.length) { this.path = []; return false; }
      wp = this.path[this.pathI];
    }
    const nx = dx / (d || 1), nz = dz / (d || 1);
    // steer toward the waypoint with local collision avoidance
    this.moveDir(nx, nz, speed, dt);
    return true;
  }
  moveDir(nx, nz, speed, dt) {
    const colliders = this.game.level.colliders;
    this.vel.x = nx * speed; this.vel.z = nz * speed;
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    colliders.resolveCircle(this.pos, 0.36, this.pos.y + 0.3, 1.6 - this.crouch * 0.6);
    // snap to floor every frame so hostiles never hover above thin slabs
    const g = colliders.groundHeight(this.pos.x, this.pos.z, this.pos.y + 0.4, 3.0);
    if (isFinite(g)) {
      this.pos.y = g; this.vy = 0; this.onGround = true;
    } else {
      // no floor below: fall
      this.vy -= 20 * dt; this.pos.y += this.vy * dt;
      if (this.pos.y < -25) { this.pos.y = 20; this.vy = 0; }
    }
    const targetYaw = Math.atan2(nx, nz);
    this.yaw = angleDamp(this.yaw, targetYaw, 9, dt);
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s; this.stateT = 0;
    if (s === 'engage' && this.squad && Math.random() < 0.5) this.squad.callout(this, 'contact');
  }

  /* ---------------- cover ---------------- */
  findCover(fromPos, threatPos, maxR = 20, preferDist = null) {
    const nav = this.game.level.nav;
    const [cx, cz] = nav.worldToCell(this.pos.x, this.pos.z);
    const r = Math.ceil(maxR / nav.cell);
    let best = null, bestScore = -1e9;
    const seen = new Set();
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const ix = cx + dx, iz = cz + dz;
      const i = nav.index(ix, iz);
      if (i < 0 || !nav.walk[i] || seen.has(i)) continue;
      seen.add(i);
      const w = nav.cellToWorld(i);
      const dt = Math.hypot(w.x - threatPos.x, w.z - threatPos.z);
      if (dt < this.squad?.minRange || dt > this.cfg.sense + 10) continue;
      // must NOT see the threat from the crouched cover position
      const low = _v3.set(w.x, nav.floor[i] + 0.75, w.z);
      const thr = _v4.set(threatPos.x, threatPos.y + 1.1, threatPos.z);
      if (!this.game.level.losBlocked(low, thr)) continue;
      // and must be able to see the threat while standing (peek-able)
      const high = _v1.set(w.x, nav.floor[i] + 1.55, w.z);
      const peek = this.game.level.losBlocked(high, thr);
      const pathD = Math.hypot(w.x - this.pos.x, w.z - this.pos.z);
      let score = -pathD * 1.4 - Math.abs(dt - (preferDist || 11)) * 1.2;
      if (nav.cover[i]) score += 5;
      if (!peek) score += 7; // cover that blocks LOS entirely while standing is ideal
      if (this.role === 'flank') score += Math.abs(dt - 14) * -0.8;
      if (score > bestScore) { bestScore = score; best = { x: w.x, z: w.z, idx: i, losWhenStanding: !peek }; }
    }
    return best;
  }

  /* ---------------- gunplay ---------------- */
  aimAt(worldPoint, speed, dt) {
    const eye = this.eye;
    const dx = worldPoint.x - eye.x, dy = worldPoint.y - eye.y, dz = worldPoint.z - eye.z;
    const targetYaw = Math.atan2(dx, dz);
    const targetPitch = Math.atan2(dy, Math.hypot(dx, dz));
    this.yaw = angleDamp(this.yaw, targetYaw, speed, dt);
    this.anim.aimPitch = THREE.MathUtils.damp(this.anim.aimPitch, targetPitch, speed, dt);
  }
  fireAt(player, dt) {
    const eye = this._eye.copy(this.eye);
    const part = _part.copy(player.pos).setY(player.pos.y + 1.05 + (player.crouch ? -0.35 : 0));
    // lead moving targets slightly — smart AI shouldn't shoot at where you were
    if (player.onGround) part.addScaledVector(player.vel, 0.07);
    const dist = eye.distanceTo(part);
    if (dist > 120) return;
    const d = this.cfg;
    let acc = d.accuracy;
    if (player.sprinting) acc *= 0.7;
    if (player.onGround && Math.hypot(player.vel.x, player.vel.z) < 0.6) acc *= 1.25;
    if (dist > 25) acc *= 0.7; else if (dist < 8) acc *= 0.85;
    if (this.movingNow) acc *= 0.55;
    if (this.lean > 0.5) acc *= 0.9;
    if (!this.seesPlayer) acc *= 0.35;
    if (!player.alive) return;
    // cannot shoot through cover that blocks the eye->target line
    if (this.game.level.losBlocked(eye, part)) return;
    const dir = _aim.copy(player.pos).setY(player.pos.y + 1.0).sub(eye).normalize();
    const spread = 1 - acc;
    let hit = Math.random() < acc;
    const end = _end;
    if (hit) {
      end.copy(part).add(_scatter.set((Math.random() - 0.5) * 0.45 * spread * 3, (Math.random() - 0.5) * 0.6 * spread * 3, (Math.random() - 0.5) * 0.45 * spread * 3));
    } else {
      end.copy(part).addScaledVector(dir, 4).add(_scatter.set((Math.random() - 0.5) * 4, (Math.random() - 0.3) * 3, (Math.random() - 0.5) * 4));
    }
    // wall check: if a wall is in the way, the bullet impacts there and the player hears it
    const rayDir = _ray.set(end.x - eye.x, end.y - eye.y, end.z - eye.z).normalize();
    const src = _src.copy(eye).addScaledVector(rayDir, Math.min(0.08, dist * 0.15));
    const travel = src.distanceTo(end);
    const block = this.game.rayHitWorld(src, rayDir, travel);
    if (block && block.t > 0.02 && block.t < travel - 0.02) {
      // compute hit point from the ray so decals never float in mid-air
      end.copy(src).addScaledVector(rayDir, block.t);
      hit = false;
      this.game.fx.impact(end, block.normal, 'concrete');
    } else if (block) {
      // something blocks but is behind the target — hit the target instead
      this.game.fx.impact(end, rayDir.clone().negate(), 'concrete');
    }
    this.game.fx.tracer(eye, end);
    this.game.fx.muzzle.fire(eye, dir, 0.8);
    this.muzzleT = 0.05;
    this.game.audio.shot('enemy', this.pos);
    this._muzzleLight();
    if (hit) {
      let dmg = d.dmg * (Math.random() * 0.3 + 0.85);
      if (this.game.endlessMode) dmg = Math.max(1, dmg - 3); // nerfed in endless mode
      this.game.damagePlayer(dmg, this.pos);
      this.game.fx.bloodBurst(end, dir, 4);
    } else {
      // near miss = bullet whip -> adds tension and tells the player where it came from
      if (Math.random() < 0.65) this.game.audio.whiz(end);
      this.game.fx.impact(end, dir.clone().negate(), 'concrete');
    }
    this.lastShotTime = this.game.time;
    this.squad?.reportFiring(this);
    this.firedAtPlayer = true;
    this.game.lastEnemyShot = this.game.time;
    this.game.lastEnemyShooter = this;
  }

  /** a real light flash on the soldier's muzzle so hostiles read in the dark */
  _muzzleLight() {
    const L = this.muzzleLight || (this.muzzleLight = new THREE.PointLight(0xffc070, 0, 9, 2));
    if (!L.parent && this.root) this.root.add(L);
    // the lamp is parented to root, so its offset is local = (forward*0.55, eyeHeight)
    L.position.set(-Math.sin(this.yaw) * 0.55, 1.5 - this.crouch * 0.3, -Math.cos(this.yaw) * 0.55);
    L.intensity = 6;
  }
  throwGrenade(player) {
    const target = _part.copy(player.pos);
    // lead the throw to where the player is heading
    target.addScaledVector(player.vel, 0.5);
    const eye = this._eye.copy(this.eye);
    const from = _src.copy(eye).addScaledVector(_aim.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), 0.4);
    const dist = from.distanceTo(target);
    const t = clampN(dist / 12, 0.6, 1.6);
    const vel = _end.copy(target).sub(from).divideScalar(t);
    vel.y += 0.5 * 20 * t * (target.y > from.y ? 1 : 0.6);
    this.game.grenades.throw(vel.clone(), from.clone(), { enemy: true, fuse: 1.6, dmg: 60, radius: 6 });
    this.throwCd = 9 + Math.random() * 8;
    this.squad?.callout(this, 'grenade');
  }

  /* ---------------- the brain ---------------- */
  thinkAI(dt, player) {
    const t = this.game.time;
    const dist = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    const knowsPlayer = this.seenNow || this.perceivedNow || this.seeTime > 0.2 || (this.squad?.sharesTarget && t - this.squad.lastSighting < 4) || this.state === 'engage' || this.state === 'suppress';
    const threat = this.squad?.sharesTarget ? this.squad.lastKnown.clone() : this.lastSeen.clone();
    if (this.suppression > 0.65 && this.state !== 'suppress' && this.state !== 'rush') this.setState('suppress');
    if (this.suppression > 0.35 && this.state === 'engage') this.crouchWant = 1;

    switch (this.state) {
      case 'patrol': {
        this.crouchWant = 0;
        // a player in plain sight is reason enough to fight — no time wasted
        if (this.seenNow) { this.setState('engage'); this.path = []; break; }
        if (!this.path.length) {
          this.idleT = (this.idleT || 0) - dt;
          if (this.idleT <= 0) { this.idleT = 2 + Math.random() * 3; this.pickPatrolPoint(); }
          this.yaw += Math.sin(t * 0.4 + this.anim.phase) * dt * 0.6;
        } else this.followPath(dt, 2.2);
        if (this.alertness > 0.3 && (t - this.lastSeenT) < 6) {
          this.setPathTo(this.lastSeen, 'investigate'); break;
        }
        if (this.seenNow) { this.setState('engage'); this.pickCoverAndPath(player, true); }
        break;
      }
      case 'investigate': {
        this.crouchWant = 0.3;
        this.alertness = Math.max(this.alertness, 0.6);
        const arrived = !this.followPath(dt, 3.8);
        if (whatArrived(this.path, this.target, this.pos, 1.2) || (arrived && this.pos.distanceTo(this.target) < 2)) {
          // sweep the area
          this.stateT += dt;
          this.yaw += dt * 1.4 * Math.sin(this.stateT * 1.3);
          if (this.stateT > 3) { this.setState('patrol'); this.pickPatrolPoint(); this.idleT = 2; }
        }
        if (this.seenNow) { this.setState('engage'); this.pickCoverAndPath(player, true); }
        break;
      }
      case 'engage': {
        this.stateT += dt;
        // no LOS for a while -> hunt / reposition
        if (t - this.lastSeenT > 2.2 || !this.seesPlayer) {
          this.lostT = (this.lostT || 0) + dt;
          if (this.lostT > 1.0) {
            this.lostT = 0;
            if (this.squad && this.squad.shouldFlank(this) && this.squad.lastSighting < 6) { this.setState('flank'); this.squad.flankTarget(this, player); }
            else if (this.role === 'flank') { this.setState('flank'); this.squad.flankTarget(this, player); }
            else { this.setPathTo(this.squad?.sharesTarget ? this.squad.lastKnown : this.lastSeen, 'investigate'); }
            break;
          }
        } else this.lostT = 0;

        if (this.cover && (this.coverT -= dt) < 0) {
          // re-evaluate cover every 2.5-4s or if the player moved
          if (this.coverT < -3.5 || (this.path.length === 0 && dist > 24)) this.pickCoverAndPath(player, false);
        }
        // stuck against a wall with no path and no sight -> pick a new spot
        // nothing in sight, no route, no cover slot: hunt the last contact point
        if (!this.seenNow && !this.path.length && this.stateT > 1.2) {
          this.stateT = 0;
          this.setPathTo(this.squad?.sharesTarget ? this.squad.lastKnown : this.lastSeen, 'investigate');
          break;
        }
        if (!this.seesPlayer && !this.path.length && !this.cover && this.stateT > 4) {
          this.stateT = 0;
          if (Math.random() < 0.5) this.pickCoverAndPath(player, false);
          else this.setPathTo(this.squad?.sharesTarget ? this.squad.lastKnown : this.lastSeen, 'investigate');
        }
        if (this.path.length) {
          // with a hostile in sight, shooting beats jogging: plant and fire
          if (this.seesPlayer) { this.path = []; this.movingNow = false; this.faceThreat(player, dt); this.combatFire(dt, player, dist); break; }
          const moving = this.followPath(dt, this.role === 'flank' ? 4.4 : 4.8);
          this.crouchWant = 0.25;
          if (!moving) this.path = [];
          this.movingNow = true;
        } else {
          this.movingNow = false;
          // fire from the current position
          this.faceThreat(player, dt);
          if (this.seesPlayer && this.reactionT <= 0) this.combatFire(dt, player, dist);
          else if (!this.seesPlayer && this.suppression < 0.3 && dist < 22 && this.mag > 0) {
            // suppress toward last known spot
            this.holdFire(dt, 0.6);
            this.crouchWant = 1;
          } else this.crouchWant = 1;
          // combat movement ratio: some enemies push after firing a while
          if (this.stateT > 3.5 + Math.random() * 3 && this.cfg.aggression > Math.random() && dist > 7 && !this.suppressed) {
            this.setState(this.role === 'flank' ? 'flank' : 'rush');
            if (this.state === 'flank') this.squad?.flankTarget(this, player); else this.setPathTo(player.pos);
          }
          // utility
          this.throwCd -= dt;
          if (this.throwCd <= 0 && (t - this.lastSeenT) < 6 && dist > 5 && dist < 24 && Math.random() < this.cfg.throwChance * dt * 4) {
            this.throwGrenade(player);
          }
        }
        break;
      }
      case 'suppress': {
        this.crouchWant = 1; this.movingNow = false;
        this.faceThreat(player, dt);
        if (this.suppression < 0.25 || t - this.lastSeenT > 5) { this.setState('engage'); break; }
        // blind fire over cover, in bursts, mostly inaccurate
        if (this.reactionT <= 0 && (t - (this.lastShotTime || 0)) > 0.9 && this.mag > 0 && Math.random() < 0.7) {
          this.fireAt(player, dt);
          this.mag--; this.muzzleT = 0.05;
        }
        if (this.squad) this.squad.callout(this, 'suppressed', 6);
        break;
      }
      case 'flank': {
        this.stateT += dt;
        this.crouchWant = 0.1;
        const moving = this.followPath(dt, 5.0);
        this.movingNow = true;
        if (!moving) {
          // reached flank position: engage from there
          this.role = 'assault';
          this.setState('engage'); this.pickCoverAndPath(player, false);
        }
        if (this.seenNow && this.reactionT <= 0 && dist < 12) {
          this.squad?.callout(this, 'flankfire', 6);
          this.setState('engage'); this.pickCoverAndPath(player, false);
        }
        if (this.stateT > 9) this.setState('engage');
        break;
      }
      case 'rush': {
        this.stateT += dt;
        this.crouchWant = 0;
        this.aimAt(TMP.set(player.pos.x, player.pos.y + 1.2, player.pos.z), 8, dt);
        this.movingNow = true;
        const d = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
        if (d > 3 && this.path.length) this.followPath(dt, 5.6);
        else this.moveDir((player.pos.x - this.pos.x) / (d || 1), (player.pos.z - this.pos.z) / (d || 1), 3.4, dt);
        if (this.seesPlayer && this.reactionT <= 0) this.combatFire(dt, player, d, true);
        if (this.stateT > 2.2 || this.pos.distanceTo(player.pos) < 2.5 || d < 3) { this.setState('engage'); this.pickCoverAndPath(player, false); }
        break;
      }
    }

    // ---- reload bookkeeping (smart: they reload behind cover, not in the open)
    if (this.mag <= 0) {
      this.reloadT += dt;
      this.crouchWant = 1;
      if (this.reloadT > 2.1) { this.mag = 30; this.reloadT = 0; }
      if (this.path.length === 0 && !this.cover) this.pickCoverAndPath(player, false);
    }
  }

  pickPatrolPoint() {
    const nav = this.game.level.nav;
    for (let i = 0; i < 8; i++) {
      const idx = this.squad?.patrolPoints ? this.squad.patrolPoints[(Math.random() * this.squad.patrolPoints.length) | 0] : -1;
      if (idx >= 0) { const w = nav.cellToWorld(idx); if (Math.hypot(w.x - this.pos.x, w.z - this.pos.z) > 3) { this.setPathTo(w); return; } }
      const a = Math.random() * 6.28, r = 6 + Math.random() * 12;
      const x = this.pos.x + Math.cos(a) * r, z = this.pos.z + Math.sin(a) * r;
      const j = nav.nearestWalkable(x, z);
      if (j >= 0) { const w = nav.cellToWorld(j); this.setPathTo(w); return; }
    }
  }

  pickCoverAndPath(player, immediate) {
    const threat = new THREE.Vector3(player.pos.x, player.pos.y, player.pos.z);
    const prefer = this.role === 'flank' ? 16 : (10 + Math.random() * 6);
    const c = this.findCover(this.pos, threat, this.role === 'flank' ? 22 : 18, prefer);
    if (c) {
      this.cover = c; this.coverT = 2.5 + Math.random() * 2;
      const dest = new THREE.Vector3(c.x, 0, c.z);
      if (dest.distanceTo(this.pos) > 1.2) this.setPathTo(dest, null);
      else this.path = [];
    } else {
      this.cover = null; this.coverT = 1.5;
      if (immediate && this.pos.distanceTo(threat) > 14) this.setPathTo(threat);
    }
  }

  faceThreat(player, dt) {
    const tgt = this.squad?.sharesTarget ? this.squad.lastKnown : this.lastSeen;
    this.aimAt(TMP.set(tgt.x, tgt.y + 1.25, tgt.z), 6.5, dt);
  }

  combatFire(dt, player, dist, rushing = false) {
    const t = this.game.time;
    // peek out of cover: stand + lean, fire a burst, tuck back
    if (this.reactionT > 0) return;
    if (this.burstT > 0) {
      this.burstT -= dt;
      if (t > this.fireT) {
        this.fireAt(player, dt);
        this.mag--; this.anim.recoil = 1; this.muzzleT = 0.05;
        const d = this.cfg;
        this.fireT = t + (rushing ? 0.085 : 0.1) + Math.random() * 0.05;
        if (this.grenadeCallT !== t) { this.grenadeCallT = t; }
      }
      this.crouchWant = 0.35;
      this.lean = THREE.MathUtils.damp(this.lean, this.leanTarget, 9, dt);
      return;
    }
    // rest between bursts
    const rest = (this.suppressed ? 0.9 : 0.55) + Math.random() * 0.6;
    this.tuckT = (this.tuckT || 0) + dt;
    this.lean = THREE.MathUtils.damp(this.lean, 0, 8, dt);
    if (this.cover && this.cover.losWhenStanding === false) this.crouchWant = 1;
    // fire whenever the player is exposed — engagement is the priority
    if (this.seesPlayer && this.tuckT > rest) {
      this.tuckT = 0;
      const d = this.cfg;
      this.burstLeft = d.burstMin + Math.floor(Math.random() * (d.burstMax - d.burstMin + 1));
      this.burstT = this.burstLeft * 0.11;
      this.mag = Math.max(this.mag, 1);
      this.fireT = t;
      this.leanTarget = Math.random() < 0.5 ? -1 : 1;
    }
  }

  /** shoot toward last known position, mostly to pin the player */
  holdFire(dt, accScale) {
    if (this.reactionT > 0) return;
    const t = this.game.time;
    if (t - (this.lastShotTime || 0) < 0.45) return;
    const fake = { pos: this.squad?.lastKnown || this.lastSeen, vel: { x: 0, y: 0, z: 0 }, crouch: 0, sprinting: false, onGround: true, alive: true };
    if (Math.random() < 0.35 * accScale) { this.fireAt(fake, dt); this.mag--; }
    this.lastShotTime = t;
  }

  /* ---------------- damage & death ---------------- */
  hit(dmg, point, dir, head) {
    if (this.dead) return false;
    this.hp -= 0;
    this.hp -= dmg;
    this.suppression = Math.min(1, this.suppression + 0.25);
    this.alertness = 1;
    if (!this.seenNow && !this.squad?.sharesTarget) {
      // got shot from somewhere: search toward the shooter
      this.squad?.reportSighting(this, this.game.player.pos);
      this.lastSeen.copy(this.game.player.pos);
      this.lastSeenT = this.game.time;
    }
    if (this.hp <= 0) { this.die(dir); return true; }
    // flinch: react by diving for cover if not already fighting
    if (Math.random() < 0.4 && this.path.length === 0) this.pickCoverAndPath(this.game.player, true);
    return false;
  }
  die(dir) {
    this.dead = true; this.deathT = 0;
    if (this.mixer && this.anims.death) { this.anims.death.reset().setLoop(THREE.LoopOnce, 1).play(); this.anims.death.clampWhenFinished = true; this.anims.death.setEffectiveWeight(1); }
    this.deathDir = Math.random() < 0.5 ? -1 : 1;
    this.ragdollAxis = new THREE.Vector3(dir ? dir.x : 0, 0, dir ? dir.z : 1).normalize();
    this.path = [];
    this.lean = 0;
    this.deadFall = new THREE.Vector3(this.pos.x, this.pos.y, this.pos.z);
    this.fallYaw = this.yaw;
    this.squad?.onKilled(this);
  }

  /* ---------------- per-frame ---------------- */
  update(dt, player) {
    // PERF: frozen corpse — skip every update incl. skinning/mixer work
    if (this._frozen) return;
    if (this.dead) { this.updateDeath(dt); return; }
    const ragdoll = false;
    this.stateT += dt;
    this.think -= dt;
    this.reactionT = Math.max(0, this.reactionT - (this.seenNow ? dt : dt * 0.3));
    this.suppression = Math.max(0, this.suppression - dt * 0.35);
    // spotting the player is immediate; the aim delay is the reaction timer
    if (this.seenNow && this.state !== 'engage' && this.state !== 'rush' && this.state !== 'flank') {
      this.setState('engage'); this.path = []; this.stateT = 0; this.cover = null;
    }
    this.suppressed = this.suppression > 0.5;
    this.movingNow = false;
    this.muzzleT -= dt;
    if (this.muzzleLight && this.muzzleLight.intensity > 0) {
      this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 90);
    }

    // ---- snap to floor every frame so hostiles never hover above thin slabs
    const g = this.game.level.colliders.groundHeight(this.pos.x, this.pos.z, this.pos.y + 0.4, 3.0);
    if (isFinite(g) && this.pos.y > g + 0.02) {
      this.pos.y = g; this.vy = 0; this.onGround = true;
    }
    // die if dropped below the map
    if (this.pos.y < -25) { this.pos.y = 20; this.vy = 0; this.onGround = true; }

    if (this.think <= 0) {
      const hz = 1 / 12;
      const sensed = this.perceive(hz, player);
      this.perceivedNow = sensed;
      // fast polling while alert or afraid, relaxed when wandering
      this.think = (sensed || this.alertness > 0.5 || this.suppression > 0.1) ? hz : 0.55;
    }
    // AI decision runs at 12hz, movement animation at full rate
    const brainDt = dt;
    this.thinkAI(brainDt, player);

    // ---- crouch smoothing & geometry
    this.crouch = THREE.MathUtils.damp(this.crouch, Math.max(this.crouchWant, this.suppression > 0.7 ? 1 : 0), 8, dt);
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.root.position.y += 0;
    // last-enemies alert: blink red + through-walls glow when <= 2 hostiles remain
    if (this.game.lowEnemyAlert && !this.dead) {
      const k = this.game.lowEnemyPulse ? 1 : 0.3;
      this.materials.forEach(m => { m.emissive.setRGB(k * 0.9, 0, 0); m.emissiveIntensity = 2.0; });
      if (!this._lastEnemyGlow) {
        this._lastEnemyGlow = new THREE.Mesh(new THREE.SphereGeometry(1.15, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.3, depthTest: false, depthWrite: false }));
        this.root.add(this._lastEnemyGlow);
      }
      this._lastEnemyGlow.visible = true;
      this._lastEnemyGlow.material.opacity = 0.18 + k * 0.12;
      this._lastEnemyGlow.position.set(0, 0.85, 0);
    } else {
      if (this._lastEnemyGlow) this._lastEnemyGlow.visible = false;
      if (!this.game.lowEnemyAlert) {
        this.materials.forEach(m => { m.emissive.setRGB(0, 0, 0); m.emissiveIntensity = 0; });
      }
    }
    this.animate(dt);
  }

  /** switch between the authored clips (walk/run/idle) with cross-fades */
  playClip(name, fade = 0.22) {
    const A = this.anims;
    if (!A || !A[name] || A.prev === name) return;
    const from = A[A.prev];
    const to = A[name];
    to.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (from && from !== to) from.fadeOut(fade);
    A.prev = name;
  }

  animate(dt) {
    const P = this.parts;
    const hs0 = Math.hypot(this.vel.x, this.vel.z);
    if (this.mixer) {
      // authored clips drive the body; the mixer handles blending/looping
      this.playClip(this.movingNow && hs0 > 0.5 ? (hs0 > 4 ? 'run' : 'walk') : 'idle');
      this.mixer.update(dt);
      if (P.rifle) P.rifle.rotation.set(-this.anim.aimPitch - 0.05 + this.anim.recoil * 0.1, this.lean * 0.12, this.lean * 0.22);
      if (P.muzzle) P.muzzle.visible = this.muzzleT > 0;
      if (this.hitFlash > 0) { this.hitFlash -= dt; const k = Math.max(0, this.hitFlash) * 3; this.materials.forEach(m => m.emissive.setRGB(k * 0.6, k * 0.12, 0.05)); }
      return;
    }
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const targetSpeed = this.movingNow ? (hs > 4.5 ? 1 : 0.55) : 0;
    this.anim.speed = THREE.MathUtils.damp(this.anim.speed, targetSpeed, 8, dt);
    const run = this.anim.speed > 0.75;
    this.anim.phase += dt * (run ? 11 : 6.5) * this.anim.speed;
    const ph = this.anim.phase;
    const s = this.anim.speed;
    this.anim.recoil = THREE.MathUtils.damp(this.anim.recoil, 0, 10, dt);
    const c = this.crouch;
    const aim = this.anim.aimPitch;
    const sw = Math.sin(ph) * 0.75 * s;
    const bob = Math.abs(Math.cos(ph)) * 0.05 * s;
    if (P.legL) P.legL.rotation.x = sw - c * 1.0;
    if (P.legR) P.legR.rotation.x = -sw - c * 1.0;
    if (P.legL) P.legL.position.y = 0.26;
    if (P.legR) P.legR.position.y = 0.26;
    if (P.armL) { P.armL.rotation.x = -sw * 0.7 - 0.35 - aim * 0.9; P.armL.rotation.z = -0.28; P.armL.rotation.y = -0.55 + aim * 0.35; }
    if (P.armR) { P.armR.rotation.x = sw * 0.7 - 0.5 - aim * 0.9 + this.anim.recoil * 0.18; P.armR.rotation.z = 0.28; P.armR.rotation.y = 0.55 - aim * 0.35; }
    if (P.torso) {
      P.torso.position.y = 0.52 - c * 0.18 + bob;
      P.torso.rotation.x = 0.06 + c * 0.22 + (this.lean * 0.12) - this.anim.recoil * 0.05;
      P.torso.rotation.z = this.lean * 0.22 + Math.sin(ph * 0.5) * 0.02 * s;
      P.torso.rotation.y = this.burstT > 0 ? Math.sin(this.game.time * 2) * 0.03 : 0;
    }
    if (P.head) {
      P.head.rotation.x = THREE.MathUtils.clamp(aim * 0.5, -0.5, 0.5);
      P.head.rotation.y = -this.lean * 0.15;
    }
    if (P.rifle && P.muzzle) {
      // rifle sits at the animated torso (already crouched/leaned by its parent)
      P.rifle.rotation.set(-aim + this.anim.recoil * 0.1, this.lean * 0.12, this.lean * 0.22);
      P.muzzle.visible = this.muzzleT > 0;
    }
    // hit flash
    if (this.hitFlash > 0) {
      this.hitFlash -= dt;
      const k = Math.max(0, this.hitFlash) * 3;
      this.materials.forEach(m => { m.emissive.setRGB(k * 0.6, k * 0.12, 0.05); });
    }
    // death not here
  }

  updateDeath(dt) {
    this.deathT += dt;
    if (this.mixer) { this.mixer.update(dt); if (this.deathT < 2.2) return; }
    const k = Math.min(1, this.deathT / 0.7);
    const ease = 1 - Math.pow(1 - k, 3);
    this.root.rotation.x = this.deathDir * ease * Math.PI * 0.5;
    this.root.position.y = this.deadFall.y + Math.sin(ease * Math.PI) * 0.12 - (1 - ease) * 0.05;
    if (this.parts.armL) this.parts.armL.rotation.x = THREE.MathUtils.lerp(this.parts.armL.rotation.x, -2.2, ease);
    if (this.parts.armR) this.parts.armR.rotation.x = THREE.MathUtils.lerp(this.parts.armR.rotation.x, -1.8, ease);
    if (this.parts.torso) this.parts.torso.rotation.z = THREE.MathUtils.lerp(this.parts.torso.rotation.z, 0.5 * this.deathDir, ease);
    if (this.deathT > 1.4 && this.deathT < 1.45) this.game.onCorpseReady && this.game.onCorpseReady(this);
  }
  setHitFlash() { this.hitFlash = 0.14; this.shakeT = 0.18; }
  dispose() {
    if (this.muzzleLight) { this.muzzleLight.parent?.remove(this.muzzleLight); this.muzzleLight.dispose?.(); this.muzzleLight = null; }
    this.root.parent?.remove(this.root);
  }
}

/* ---------------- squad coordination ---------------- */
export class Squad {
  constructor(game, id, center, radius, patrolPoints) {
    this.game = game; this.id = id; this.center = center; this.radius = radius;
    this.members = []; this.patrolPoints = patrolPoints || [];
    this.lastSighting = -99; this.lastKnown = new THREE.Vector3();
    this.sharesTarget = false;
    this.minRange = 7;
    this.callCd = 0;
    this.flankers = 0;
  }
  add(e) { this.members.push(e); e.squad = this; }
  get alive() { return this.members.filter(m => !m.dead); }
  reportSighting(e, pos) {
    this.lastSighting = this.game.time; this.lastKnown.copy(pos);
    this.sharesTarget = true;
    // sighting propagates: nearby friends turn toward the contact
    for (const m of this.members) {
      if (m === e || m.dead) continue;
      if (!m.seenNow && m.state === 'patrol' && m.pos.distanceTo(pos) < 34) {
        m.alertness = Math.max(m.alertness, 0.8);
        m.lastSeen.copy(pos); m.lastSeenT = this.game.time;
        if (Math.random() < 0.6) m.setPathTo(pos, 'investigate');
      } else if (!m.seenNow && m.state !== 'engage' && m.state !== 'flank') {
        m.alertness = Math.max(m.alertness, 0.6);
      }
    }
  }
  reportFiring(e) {
    this.lastSighting = Math.max(this.lastSighting, this.game.time - 1);
  }
  callout(e, type, cd = 5) {
    if (this.game.time < (this.callCd || 0)) return;
    this.callCd = this.game.time + cd;
    let text = null;
    switch (type) {
      case 'contact': text = 'CONTACT — CONTACT!'; break;
      case 'flank': text = 'MOVING TO FLANK'; break;
      case 'flankfire': text = 'FLANKING, PUSH NOW!'; break;
      case 'grenade': text = 'GRENADE OUT!'; break;
      case 'suppressed': text = 'PINNED DOWN — NEED SUPPORT'; break;
      case 'reload': text = 'RELOADING — COVER ME!'; break;
      case 'killed': text = 'MAN DOWN — AVENGE HIM'; break;
    }
    if (text) this.game.onCallout && this.game.onCallout(e, text);
  }
  onKilled(e) {
    this.callout(e, 'killed', 7);
    // survivors get aggressive when their squad is torn apart
    for (const m of this.members) if (m !== e && !m.dead) m.cfg = { ...m.cfg, aggression: Math.min(1, m.cfg.aggression + 0.25) };
    this.sharesTarget = true; this.lastKnown.copy(this.game.player.pos); this.lastSighting = this.game.time;
  }
  /** only one element flanks at a time, and only if the squad is healthy */
  shouldFlank(e) {
    const alive = this.alive.length;
    if (alive <= 1) return false;
    if (this.flankers >= 1) return false;
    return Math.random() < 0.5;
  }
  flankTarget(e, player) {
    this.flankers++;
    e.role = 'flank';
    this.callout(e, 'flank', 6);
    // pick a point on the far side of the player relative to the squad's line
    const nav = this.game.level.nav;
    const px = player.pos.x, pz = player.pos.z;
    const ax = e.pos.x - px, az = e.pos.z - pz;
    const ang = Math.atan2(az, ax);
    let best = null, bestScore = -1e9;
    for (let k = 0; k < 14; k++) {
      const a = ang + (k % 2 ? 1 : -1) * (0.9 + Math.random() * 1.6);
      const r = 11 + Math.random() * 6;
      const x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r;
      const i = nav.nearestWalkable(x, z);
      if (i < 0) continue;
      const w = nav.cellToWorld(i);
      const eye = new THREE.Vector3(w.x, nav.floor[i] + 1.5, w.z);
      if (this.game.level.losBlocked(eye, new THREE.Vector3(px, player.pos.y + 1.2, pz))) continue;
      const score = Math.hypot(w.x - e.pos.x, w.z - e.pos.z) * -0.6 + Math.random();
      if (score > bestScore) { bestScore = score; best = w; }
    }
    e.setPathTo(best || player.pos, 'flank');
  }
  update(dt) {
    if (this.game.time - this.lastSighting > 8) this.sharesTarget = false;
    this.flankers = this.alive.filter(m => m.role === 'flank' && m.state === 'flank').length;
    // squad-level spacing: keep from stacking on the same cover
    if (Math.random() < dt * 0.5) {
      const alive = this.alive;
      for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        if (a.cover && b.cover && Math.hypot(a.cover.x - b.cover.x, a.cover.z - b.cover.z) < 1.5 && Math.random() < 0.5) {
          b.pickCoverAndPath(this.game.player, false);
        }
      }
    }
  }
}

/* expectations: patrolPoints are nav indices covering the map */
export function createSquads(game, nav, count = 9, spawns) {
  const squads = [
    new Squad(game, 0, new THREE.Vector3(), 20, []),
    new Squad(game, 1, new THREE.Vector3(), 20, []),
    new Squad(game, 2, new THREE.Vector3(), 20, []),
  ];
  // walkable nav cells to use as patrol points and spawn candidates
  const cells = [];
  for (let i = 0; i < nav.walk.length; i++) if (nav.walk[i]) cells.push(i);
  const far = (x, z) => cells.filter(i => { const w = nav.cellToWorld(i); return Math.hypot(w.x - x, w.z - z) > 18; });

  const spawnCellList = spawns && spawns.length ? spawns : cells;
  for (let k = 0; k < count; k++) {
    const sq = squads[k % squads.length];
    let cell = -1;
    for (let tries = 0; tries < 80 && cell < 0; tries++) {
      const c = spawnCellList[(Math.random() * spawnCellList.length) | 0];
      if (typeof c === 'number') cell = c;
      else { const i = nav.nearestWalkable(c.position.x, c.position.z); if (i >= 0) cell = i; }
      // keep hostiles apart at start
      if (cell >= 0) { const w = nav.cellToWorld(cell); if (game.distanceToSpawns && game.distanceToSpawns(w) < 10) cell = -1; }
    }
    if (cell < 0) continue;
    sq.patrolPoints.push(...pickAround(nav, cell, 6));
    sq.spawnCells = sq.spawnCells || []; sq.spawnCells.push(cell);
  }
  for (const sq of squads) {
    const pts = sq.spawnCells || [];
    for (const c of pts) sq.patrolPoints.push(c);
  }
  return squads;
}
function pickAround(nav, cell, n) {
  const out = [];
  const [ix, iz] = [cell % nav.w, (cell - cell % nav.w) / nav.w];
  for (let k = 0; k < n * 3 && out.length < n; k++) {
    const x = ix + Math.round((Math.random() - 0.5) * 16), z = iz + Math.round((Math.random() - 0.5) * 16);
    const i = nav.index(x, z);
    if (i >= 0 && nav.walk[i]) out.push(i);
  }
  return out;
}

function angleDamp(a, b, lambda, dt) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-lambda * dt));
}
function clampN(v, a, b) { return v < a ? a : v > b ? b : v; }
function whatArrived(path, target, pos, r) { return path.length === 0 && Math.hypot(target.x - pos.x, target.z - pos.z) < r; }
