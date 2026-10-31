import type { NeighbourSnapshot } from '../core/contracts';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import type { Vec3 } from '../core/types';
import { yawToward } from '../neighbours/neighbours';

/**
 * The balti blast: the street prank where a sutli bomb is set on the ground,
 * an upturned steel balti put over it and the fuse lit where it pokes out
 * under the rim. Everyone runs back, the bomb goes off with a muffled boom
 * and the balti is thrown high, tumbling, then clatters down and bounces.
 *
 * A few kids gather round the spot and play it on their own every so often;
 * the player joins by walking up and pressing E three times (bomb, balti,
 * fuse), then stepping back. Wander off half way and a kid finishes it.
 *
 * Renderer-free and deterministic for a given `random`; positions are
 * mutated in place, so per-step updates allocate nothing.
 */

/** Where the prank is in its round. */
export type BaltiPhase = 'ready' | 'bombPlaced' | 'covered' | 'fuseBurning' | 'flying' | 'cheering';

/** Who set the current round up. */
export type BaltiActor = 'player' | 'kid';

/** One of the three set-up steps E (or a kid) takes. */
export type BaltiStep = 'placed' | 'covered' | 'lit';

/**
 * What a kid is doing: `chat` stands in the huddle, `walk` heads somewhere,
 * `crouch` works at the bomb, `run` makes for a safe spot, `brace` waits
 * there with fingers in ears, and `cheer` jumps and laughs at the blast.
 */
export type KidActivity = 'chat' | 'walk' | 'crouch' | 'run' | 'brace' | 'cheer';

/** Everything the scene needs to pose one kid. */
export interface KidView extends NeighbourSnapshot {
  /** Facing in radians about +Y; 0 looks down -Z. */
  readonly yaw: number;
  /** Head tilt in radians; positive looks up. */
  readonly lookUp: number;
  readonly activity: KidActivity;
  /** Seconds spent in the current activity. */
  readonly activityTime: number;
  /** Index into the scene's looks. */
  readonly look: number;
}

/** Where the balti is: its middle, how far it has tipped and turned. */
export interface BaltiPose {
  readonly position: Vec3;
  /**
   * Tip about its own horizontal axis, radians: 0 stands mouth up, π is
   * upturned (mouth down) and π/2 lies on its side.
   */
  readonly tilt: number;
  /** Turn about +Y, radians. */
  readonly yaw: number;
}

/**
 * Where the street's kids play it: the open south-west corner of the
 * courtyard, just round from the lane, clear of the neighbours, the tulsi
 * platform and the parked scooter, with room to run back on every side.
 */
export const BALTI_SPOT: Vec3 = { x: -6.5, y: 0, z: -25 };

/** Placeholder tuning; times in seconds, distances in metres, speeds in m/s. */
export const BALTI = {
  /** Kids gathered round the spot. */
  kids: 4,
  /** E reaches the spot from this far. */
  reach: 2.2,
  /** The huddle round the spot before the fuse is lit. */
  gatherRadius: 1.6,
  /** Where everyone runs to once it is lit. */
  safeRadius: 4.2,
  /** A kid squats this far from the spot to work on it. */
  workRadius: 0.55,
  /** The player setting it up and walking further than this leaves it to the kids. */
  abandonRadius: 9,
  /** Fuse burn before the bang. */
  fuse: 3.2,
  /** Lowering the balti over the bomb. */
  coverTime: 0.45,
  /** A kid's time squatting over each step. */
  kidWork: 0.9,
  walkSpeed: 1.1,
  runSpeed: 3.4,
  /** Radians per second a kid turns towards where it wants to face. */
  turnSpeed: 7,
  /** Wait between the kids' own rounds, while the player is not at the spot. */
  kidRoundWait: [7, 12] as const,
  /** Cheering after the balti settles, before the huddle forms again. */
  cheerTime: 2.6,
  /** Highest head tilt following the balti up. */
  maxLookUp: 1.1,

  // ── The balti's flight ──
  /** Straight up off the bomb: about 5.5–8.5 m high. */
  launchSpeed: [10.5, 13] as const,
  /** Sideways kick off the blast. */
  drift: [0.2, 1.1] as const,
  /** Tumble end over end, rad/s, either way. */
  tumble: [5, 9] as const,
  /** Most twirl about the vertical, rad/s, either way. */
  twirl: 3,
  gravity: 9.81,
  /** Vertical speed kept by a bounce. */
  restitution: 0.38,
  /** Sideways speed kept by a bounce. */
  friction: 0.55,
  /** Tumble kept by a bounce. */
  tumbleKept: 0.5,
  /** A bounce slower than this ends in a settle. */
  settleSpeed: 1.2,
  maxBounces: 4,
  /** A flight never lasts longer than this. */
  maxFlight: 6,
  /** The balti never lands further than this from the spot. */
  maxDrift: 3,
  /** Height of its middle when standing on its base or rim, or lying on its side. */
  restHeight: 0.15,
  /** Where it waits before the first round, beside the spot. */
  restOffset: { x: 0.9, z: 0.5 },
  /** The fuse pokes out under the rim this far from the spot, along +X. */
  fuseReach: 0.26,
} as const;

export interface BaltiBlastOptions {
  /** The spot the bomb goes on, on the ground. */
  readonly spot: Vec3;
  /** Publishes the steps, blast and bounces; resets on `sessionReset`. */
  readonly bus?: GameEventBus;
  readonly random?: () => number;
  /** Player feet, or null when they are not out on the street. */
  readonly playerPosition?: () => Vec3 | null;
}

type MutableVec3 = { x: number; y: number; z: number };
type MutableKidView = { -readonly [K in keyof KidView]: KidView[K] };

interface Kid {
  readonly view: MutableKidView;
  readonly position: MutableVec3;
  /** Direction from the spot, radians, that the kid's huddle and safe spots lie along. */
  readonly angle: number;
  wantYaw: number;
  wantLookUp: number;
  target: { x: number; z: number };
  /** What the kid does on arriving at `target`. */
  then: KidActivity;
  speed: number;
}

const QUARTER = Math.PI / 2;
const TAU = Math.PI * 2;

/** Shortest signed angle from `a` to `b`, in (-π, π]. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

function approach(value: number, goal: number, step: number): number {
  if (Math.abs(goal - value) <= step) return goal;
  return value + Math.sign(goal - value) * step;
}

function between(random: () => number, range: readonly [number, number]): number {
  return range[0] + random() * (range[1] - range[0]);
}

/** The steady way up nearest `tilt`: on its base, its side or its rim. */
export function restingTilt(tilt: number): number {
  return Math.round(tilt / QUARTER) * QUARTER;
}

/**
 * The balti's flight, as plain state: one rigid body thrown up off the bomb,
 * tumbling and twirling under gravity, bouncing off the ground a few times
 * and settling the right way up, on its rim or on its side. Bounded: it
 * never climbs above its launch's apex, never strays beyond `maxDrift` of
 * the spot and always settles within `maxFlight`.
 */
export class BaltiFlight {
  readonly position: MutableVec3 = { x: 0, y: 0, z: 0 };
  readonly velocity: MutableVec3 = { x: 0, y: 0, z: 0 };
  tilt = 0;
  yaw = 0;
  tumble = 0;
  twirl = 0;
  bounces = 0;
  time = 0;
  /** On the ground for good, rocking onto its resting side. */
  settling = false;
  /** Still and steady: the flight is over. */
  done = true;
  private readonly origin: MutableVec3 = { x: 0, y: 0, z: 0 };

  /** Throw it from `from` (on the ground), its tilt and yaw so far kept. */
  launch(from: Vec3, random: () => number): void {
    const b = BALTI;
    this.origin.x = from.x;
    this.origin.y = from.y;
    this.origin.z = from.z;
    this.position.x = from.x;
    this.position.y = from.y + b.restHeight;
    this.position.z = from.z;
    const heading = random() * TAU;
    const drift = between(random, b.drift);
    this.velocity.x = Math.sin(heading) * drift;
    this.velocity.y = between(random, b.launchSpeed);
    this.velocity.z = Math.cos(heading) * drift;
    this.tumble = (random() < 0.5 ? -1 : 1) * between(random, b.tumble);
    this.twirl = (random() * 2 - 1) * b.twirl;
    this.bounces = 0;
    this.time = 0;
    this.settling = false;
    this.done = false;
  }

  /**
   * Advance by `dt`. Returns the speed it hit the ground at when it bounced
   * this step, else 0.
   */
  step(dt: number): number {
    if (this.done) return 0;
    const b = BALTI;
    const p = this.position;
    const v = this.velocity;
    const floor = this.origin.y + b.restHeight;
    this.time += dt;
    let impact = 0;

    if (!this.settling) {
      v.y -= b.gravity * dt;
      p.x += v.x * dt;
      p.y += v.y * dt;
      p.z += v.z * dt;
      this.tilt += this.tumble * dt;
      this.yaw += this.twirl * dt;
      if (p.y <= floor && v.y < 0) {
        p.y = floor;
        impact = -v.y;
        this.bounces++;
        v.y = impact * b.restitution;
        v.x *= b.friction;
        v.z *= b.friction;
        this.tumble *= b.tumbleKept;
        this.twirl *= b.tumbleKept;
        if (v.y < b.settleSpeed || this.bounces >= b.maxBounces) this.settle();
      } else if (this.time >= b.maxFlight) {
        p.y = floor;
        this.settle();
      }
    } else {
      // Sliding to a stop and rocking onto its base, side or rim.
      const slow = Math.exp(-6 * dt);
      v.x *= slow;
      v.z *= slow;
      p.x += v.x * dt;
      p.z += v.z * dt;
      p.y = floor;
      this.twirl *= Math.exp(-4 * dt);
      this.yaw += this.twirl * dt;
      const rest = restingTilt(this.tilt);
      this.tilt = approach(this.tilt, rest, 6 * dt);
      const still = Math.hypot(v.x, v.z) < 0.05 && Math.abs(this.twirl) < 0.05;
      if ((this.tilt === rest && still) || this.time >= b.maxFlight + 1) {
        this.tilt = ((rest % TAU) + TAU) % TAU;
        this.yaw %= TAU;
        v.x = v.y = v.z = 0;
        this.done = true;
      }
    }
    this.keepNear();
    return impact;
  }

  private settle(): void {
    this.velocity.y = 0;
    this.tumble = 0;
    this.settling = true;
  }

  /** Never further than `maxDrift` from where it was thrown. */
  private keepNear(): void {
    const p = this.position;
    const dx = p.x - this.origin.x;
    const dz = p.z - this.origin.z;
    const d = Math.hypot(dx, dz);
    if (d <= BALTI.maxDrift) return;
    const k = BALTI.maxDrift / d;
    p.x = this.origin.x + dx * k;
    p.z = this.origin.z + dz * k;
    this.velocity.x = 0;
    this.velocity.z = 0;
  }
}

/**
 * The balti blast activity: the round's phases, the kids and the balti.
 * Publishes `baltiStep`, `baltiBlast` and `baltiBounce` for the effects and
 * audio, and returns to its first state on `sessionReset`.
 */
export class BaltiBlast {
  readonly spot: Vec3;

  private readonly random: () => number;
  private readonly playerPosition: () => Vec3 | null;
  private readonly bus: GameEventBus | undefined;
  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly kids: Kid[] = [];
  private readonly viewList: KidView[];
  private readonly snapshots: NeighbourSnapshot[];
  private readonly flight = new BaltiFlight();
  /** Where the balti waits between rounds, and its tilt and yaw there. */
  private readonly rest: MutableVec3 = { x: 0, y: 0, z: 0 };
  private restTilt = 0;
  private restYaw = 0;
  private readonly pose: { position: MutableVec3; tilt: number; yaw: number } = {
    position: { x: 0, y: 0, z: 0 },
    tilt: 0,
    yaw: 0,
  };
  private readonly fuseTip: Vec3;

  private currentPhase: BaltiPhase = 'ready';
  private phaseTime = 0;
  private actor: BaltiActor | null = null;
  /** The kid setting the round up, if a kid is. */
  private leader: Kid | null = null;
  /** Seconds the leader has squatted over the current step. */
  private work = 0;
  /** Seconds until the kids start a round of their own. */
  private wait = 0;
  /** Whose turn it is to lead the kids' next round. */
  private nextLeader = 0;
  private rounds = 0;

  constructor(options: BaltiBlastOptions) {
    this.spot = { x: options.spot.x, y: options.spot.y, z: options.spot.z };
    this.random = options.random ?? Math.random;
    this.playerPosition = options.playerPosition ?? (() => null);
    this.bus = options.bus;
    this.fuseTip = { x: this.spot.x + BALTI.fuseReach, y: this.spot.y, z: this.spot.z };
    for (let i = 0; i < BALTI.kids; i++) {
      const angle = (i / BALTI.kids) * TAU + 0.4;
      const position = { x: 0, y: this.spot.y, z: 0 };
      this.kids.push({
        view: { id: `balti.kid.${i}`, position, yaw: 0, lookUp: 0, activity: 'chat', activityTime: 0, look: i },
        position,
        angle,
        wantYaw: 0,
        wantLookUp: 0,
        target: { x: 0, z: 0 },
        then: 'chat',
        speed: 0,
      });
    }
    this.viewList = this.kids.map((kid) => kid.view);
    // Kids and the spot itself keep ground crackers away; live objects, built once.
    this.snapshots = [...this.kids.map((kid) => ({ id: kid.view.id, position: kid.position })), { id: 'balti.spot', position: this.spot }];
    if (options.bus) this.unsubscribes.push(options.bus.on('sessionReset', () => this.reset()));
    this.reset();
  }

  get phase(): BaltiPhase {
    return this.currentPhase;
  }

  /** Seconds into the current phase. */
  get phaseElapsed(): number {
    return this.phaseTime;
  }

  /** Who set up the round under way; null between rounds. */
  get setBy(): BaltiActor | null {
    return this.actor;
  }

  /** Blasts so far this session. */
  get blasts(): number {
    return this.rounds;
  }

  /** The sutli bomb is on the ground (and not yet gone off). */
  get bombDown(): boolean {
    const phase = this.currentPhase;
    return phase === 'bombPlaced' || phase === 'covered' || phase === 'fuseBurning';
  }

  /** How much of the fuse has burnt, 0–1; 0 unless it is burning. */
  get fuseProgress(): number {
    return this.currentPhase === 'fuseBurning' ? Math.min(1, this.phaseTime / BALTI.fuse) : 0;
  }

  /** Where the fuse pokes out under the rim. */
  get fusePosition(): Vec3 {
    return this.fuseTip;
  }

  /** The balti's pose now. Live object; do not keep. */
  get balti(): BaltiPose {
    const pose = this.pose;
    const phase = this.currentPhase;
    if (phase === 'flying') {
      pose.position.x = this.flight.position.x;
      pose.position.y = this.flight.position.y;
      pose.position.z = this.flight.position.z;
      pose.tilt = this.flight.tilt;
      pose.yaw = this.flight.yaw;
    } else if (phase === 'covered' || phase === 'fuseBurning') {
      // Lifted from where it waited and swung over the bomb, upturned.
      const u = phase === 'covered' ? Math.min(1, this.phaseTime / BALTI.coverTime) : 1;
      const s = u * u * (3 - 2 * u);
      pose.position.x = this.rest.x + (this.spot.x - this.rest.x) * s;
      pose.position.z = this.rest.z + (this.spot.z - this.rest.z) * s;
      pose.position.y = this.spot.y + BALTI.restHeight + Math.sin(Math.PI * u) * 0.4;
      pose.tilt = this.restTilt + (Math.PI - this.restTilt) * s;
      pose.yaw = this.restYaw;
    } else {
      pose.position.x = this.rest.x;
      pose.position.y = this.rest.y;
      pose.position.z = this.rest.z;
      pose.tilt = this.restTilt;
      pose.yaw = this.restYaw;
    }
    return pose;
  }

  /** Pose data for every kid, for the scene. Live objects; do not keep. */
  views(): readonly KidView[] {
    return this.viewList;
  }

  /** Kids and the spot, for keeping ground crackers clear. Live objects; do not keep. */
  positions(): readonly NeighbourSnapshot[] {
    return this.snapshots;
  }

  /**
   * The step E takes for a player standing at `feet` and looking along
   * `forward`, or null: they must be within `BALTI.reach` of the spot and
   * facing it, between rounds or setting this one up themselves, and the
   * balti must have finished lowering before the fuse is offered.
   */
  offer(feet: Vec3, forward: Vec3): BaltiStep | null {
    if (this.leader) return null;
    const step = this.nextStep();
    if (!step) return null;
    if (this.currentPhase === 'covered' && this.phaseTime < BALTI.coverTime) return null;
    const dx = this.spot.x - feet.x;
    const dz = this.spot.z - feet.z;
    const distance = Math.hypot(dx, dz);
    if (distance > BALTI.reach || Math.abs(this.spot.y - feet.y) > 1) return null;
    const level = Math.hypot(forward.x, forward.z);
    // Right over the spot counts whichever way the view points.
    if (distance > 0.6 && level > 0 && (dx * forward.x + dz * forward.z) / (distance * level) < Math.cos((70 * Math.PI) / 180)) {
      return null;
    }
    return step;
  }

  /** Take the next set-up step as the player. Returns what was done, or null. */
  playerStep(feet: Vec3, forward: Vec3): BaltiStep | null {
    const step = this.offer(feet, forward);
    if (!step) return null;
    this.actor = 'player';
    this.take(step);
    return step;
  }

  update(dt: number): void {
    this.phaseTime += dt;
    const player = this.playerPosition();
    switch (this.currentPhase) {
      case 'ready':
        if (!this.leader) {
          // Nobody starts while the player stands at the spot: it is theirs to set up.
          if (!this.atSpot(player)) this.wait -= dt;
          if (this.wait <= 0) this.startKidRound();
        }
        break;
      case 'bombPlaced':
      case 'covered':
        // Left half done: the nearest kid finishes it off.
        if (this.actor === 'player' && !this.leader && !this.near(player, BALTI.abandonRadius)) this.takeOver();
        break;
      case 'fuseBurning':
        if (this.phaseTime >= BALTI.fuse) this.blast();
        break;
      case 'flying': {
        const impact = this.flight.step(dt);
        if (impact > 0) this.bus?.emit('baltiBounce', { position: { ...this.flight.position }, speed: impact });
        if (this.flight.done) this.land();
        break;
      }
      case 'cheering':
        if (this.phaseTime >= BALTI.cheerTime) this.regroup();
        break;
    }
    if (this.leader) this.lead(dt);
    for (const kid of this.kids) this.moveKid(kid, dt);
  }

  /** Fresh session: balti beside the spot, kids huddled, a round soon. */
  reset(): void {
    this.flight.done = true;
    this.rest.x = this.spot.x + BALTI.restOffset.x;
    this.rest.y = this.spot.y + BALTI.restHeight;
    this.rest.z = this.spot.z + BALTI.restOffset.z;
    this.restTilt = 0;
    this.restYaw = 0;
    this.enter('ready');
    this.actor = null;
    this.leader = null;
    this.work = 0;
    this.nextLeader = 0;
    this.rounds = 0;
    this.wait = between(this.random, BALTI.kidRoundWait);
    for (const kid of this.kids) {
      kid.position.x = this.spot.x + Math.sin(kid.angle) * BALTI.gatherRadius;
      kid.position.y = this.spot.y;
      kid.position.z = this.spot.z + Math.cos(kid.angle) * BALTI.gatherRadius;
      kid.view.yaw = kid.wantYaw = yawToward(kid.position, this.spot);
      kid.view.lookUp = kid.wantLookUp = 0;
      this.begin(kid, 'chat');
    }
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private nextStep(): BaltiStep | null {
    switch (this.currentPhase) {
      case 'ready':
        return 'placed';
      case 'bombPlaced':
        return 'covered';
      case 'covered':
        return 'lit';
      default:
        return null;
    }
  }

  /** Do `step` for whoever is setting the round up. */
  private take(step: BaltiStep): void {
    const by = this.actor ?? 'kid';
    if (step === 'placed') {
      this.enter('bombPlaced');
      this.bus?.emit('baltiStep', { step, by, position: this.spot });
    } else if (step === 'covered') {
      this.enter('covered');
      this.bus?.emit('baltiStep', { step, by, position: this.spot });
    } else {
      this.enter('fuseBurning');
      this.bus?.emit('baltiStep', { step, by, position: this.fuseTip, fuse: BALTI.fuse });
      // Everyone runs for it, the leader included.
      this.leader = null;
      for (const kid of this.kids) this.sendTo(kid, BALTI.safeRadius, BALTI.runSpeed, 'run', 'brace');
    }
  }

  private startKidRound(): void {
    const leader = this.kids[this.nextLeader % this.kids.length]!;
    this.nextLeader += 1 + Math.floor(this.random() * (this.kids.length - 1));
    this.actor = 'kid';
    this.leadWith(leader);
  }

  /** The player walked off mid set-up: the nearest kid carries on. */
  private takeOver(): void {
    let best = this.kids[0]!;
    let bestD = Infinity;
    for (const kid of this.kids) {
      const d = Math.hypot(kid.position.x - this.spot.x, kid.position.z - this.spot.z);
      if (d < bestD) {
        best = kid;
        bestD = d;
      }
    }
    this.actor = 'kid';
    this.leadWith(best);
  }

  private leadWith(kid: Kid): void {
    this.leader = kid;
    this.work = 0;
    this.sendTo(kid, BALTI.workRadius, BALTI.walkSpeed, 'walk', 'crouch');
  }

  /** The leader squats over each step in turn, then lights it and runs. */
  private lead(dt: number): void {
    const kid = this.leader!;
    if (kid.view.activity !== 'crouch') return;
    this.work += dt;
    const extra = this.currentPhase === 'covered' ? BALTI.coverTime : 0;
    if (this.work < BALTI.kidWork + extra) return;
    this.work = 0;
    const step = this.nextStep();
    if (step) this.take(step);
  }

  private blast(): void {
    const by = this.actor ?? 'kid';
    this.rounds++;
    this.flight.tilt = Math.PI;
    this.flight.yaw = this.restYaw;
    this.flight.launch(this.spot, this.random);
    this.enter('flying');
    this.bus?.emit('baltiBlast', { position: this.spot, by });
    for (const kid of this.kids) {
      kid.wantYaw = yawToward(kid.position, this.spot);
      this.begin(kid, 'cheer');
    }
  }

  private land(): void {
    const p = this.flight.position;
    this.rest.x = p.x;
    this.rest.y = p.y;
    this.rest.z = p.z;
    this.restTilt = this.flight.tilt;
    this.restYaw = this.flight.yaw;
    this.enter('cheering');
  }

  /** Back into the huddle; the next kids' round comes after a wait. */
  private regroup(): void {
    this.enter('ready');
    this.actor = null;
    this.wait = between(this.random, BALTI.kidRoundWait);
    for (const kid of this.kids) this.sendTo(kid, BALTI.gatherRadius, BALTI.walkSpeed, 'walk', 'chat');
  }

  private enter(phase: BaltiPhase): void {
    this.currentPhase = phase;
    this.phaseTime = 0;
  }

  /** Head for the spot `radius` out along the kid's own direction, then do `then`. */
  private sendTo(kid: Kid, radius: number, speed: number, going: KidActivity, then: KidActivity): void {
    kid.target.x = this.spot.x + Math.sin(kid.angle) * radius;
    kid.target.z = this.spot.z + Math.cos(kid.angle) * radius;
    kid.speed = speed;
    kid.then = then;
    this.begin(kid, going);
  }

  private begin(kid: Kid, activity: KidActivity): void {
    kid.view.activity = activity;
    kid.view.activityTime = 0;
  }

  private moveKid(kid: Kid, dt: number): void {
    const view = kid.view;
    view.activityTime += dt;
    if (view.activity === 'walk' || view.activity === 'run') {
      const dx = kid.target.x - kid.position.x;
      const dz = kid.target.z - kid.position.z;
      const distance = Math.hypot(dx, dz);
      const step = kid.speed * dt;
      if (distance <= step) {
        kid.position.x = kid.target.x;
        kid.position.z = kid.target.z;
        this.begin(kid, kid.then);
      } else {
        kid.position.x += (dx / distance) * step;
        kid.position.z += (dz / distance) * step;
        kid.wantYaw = yawToward(kid.position, kid.target);
      }
    }
    if (view.activity !== 'walk' && view.activity !== 'run') {
      // Standing anywhere, everyone watches the spot, or the balti once it flies.
      const watching = this.currentPhase === 'flying' ? this.flight.position : this.spot;
      const ground = Math.hypot(watching.x - kid.position.x, watching.z - kid.position.z);
      if (ground > 0.05) kid.wantYaw = yawToward(kid.position, watching);
      const height = watching.y - kid.position.y - 0.9;
      kid.wantLookUp =
        this.currentPhase === 'flying' ? Math.min(BALTI.maxLookUp, Math.max(0, Math.atan2(height, Math.max(0.3, ground)))) : 0;
    } else {
      kid.wantLookUp = 0;
    }
    view.yaw += approach(0, angleDelta(view.yaw, kid.wantYaw), BALTI.turnSpeed * dt);
    view.lookUp = approach(view.lookUp, kid.wantLookUp, BALTI.turnSpeed * 0.5 * dt);
  }

  private near(position: Vec3 | null, radius: number): boolean {
    if (!position) return false;
    return Math.hypot(position.x - this.spot.x, position.z - this.spot.z) <= radius;
  }

  private atSpot(position: Vec3 | null): boolean {
    return this.near(position, BALTI.reach);
  }
}
