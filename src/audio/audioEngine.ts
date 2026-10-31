import type { AudioModule, CameraView, Steppable } from '../core/contracts';
import type { GameEventBus } from '../core/events';
import type { Unsubscribe } from '../core/eventBus';
import { DEFAULT_QUALITY, qualityProfile, type QualityProfile } from '../core/quality';
import { TUNING, type Tuning } from '../core/tuning';
import type { LadiChain } from '../core/ladi';
import type { BurstPattern, CrackerId, Vec3 } from '../core/types';
import { AmbienceScheduler, type AmbientEvent } from './ambience';
import {
  ACTIVE_SOUND,
  BURST_DURATION,
  DISTANT_BOMB_DURATION,
  DISTANT_POP_DURATION,
  DISTANT_SHELL_DURATION,
  LADI_BATCH,
  LADI_RING,
  LADI_TAIL,
  ladiPopLevel,
  SOUNDS,
  STOP_FADE,
  type SoundKind,
} from './sounds';
import {
  createLadiBus,
  createLaneEcho,
  createNoiseBank,
  silence,
  startTownCrackle,
  synthesise,
  type LadiPopSound,
  type NoiseBank,
  type SynthVoice,
} from './synth';
import { VoicePool, type VoiceId } from './voicePool';
import { BALTI_BOOM_DURATION, BALTI_CLANG_DURATION, BALTI_CLANG_FULL_SPEED } from './sounds';

/** Metres per second; delays far bursts so the flash leads the boom. */
const SPEED_OF_SOUND = 343;
/** Seconds the master gain takes to follow mute/volume changes. */
const GAIN_SMOOTHING = 0.03;
/** The faint crackle of the whole town celebrating. */
const TOWN_CRACKLE_GAIN = 0.14;
/** Distant bangs this close play at full intensity; further ones fall off. */
const DISTANT_REFERENCE = 45;
/** How much of the effects ring off the lane's walls. */
const ECHO_GAIN = 0.32;

export interface AudioEngineOptions {
  readonly bus: GameEventBus;
  /**
   * Builds the context on unlock; return null when Web Audio is missing.
   * Defaults to the browser's `AudioContext`. Tests inject a fake.
   */
  readonly createContext?: () => AudioContext | null;
  readonly profile?: QualityProfile;
  readonly tuning?: Tuning;
  readonly random?: () => number;
}

interface Graph {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly sfx: GainNode;
  /** Near ladis' pops: their lane slapback and limiter, into `sfx`. */
  readonly ladi: GainNode;
  readonly ambience: GainNode;
  /** Recorded music (aarti): under master gain and mute, dry of the lane echo. */
  readonly music: GainNode;
  readonly bank: NoiseBank;
  townCrackle: SynthVoice | null;
}

/** Where recorded music plays; see `AudioEngine.musicOutput`. */
export interface MusicOutput {
  readonly context: AudioContext;
  readonly destination: AudioNode;
}

interface PlayOptions {
  readonly position: Vec3;
  readonly duration: number;
  readonly delay?: number;
  readonly gain?: number;
  readonly refDistance?: number;
  /** Panner moves here linearly over the voice, e.g. a rising rocket. */
  readonly moveTo?: Vec3;
  readonly distance?: number;
  readonly pattern?: BurstPattern;
  readonly pops?: readonly LadiPopSound[];
}

/** A burning ladi's pops, and the first one no batch has played yet. */
interface LadiSound {
  readonly chain: LadiChain;
  next: number;
}

/**
 * The Audio module (PRD → Modules): plays synthesised local effects with
 * spatial panning and a distant ambience bed, under master gain, mute and a
 * concurrent-voice cap.
 *
 * Nothing touches Web Audio until `unlock()` runs from a player gesture, so
 * browsers' autoplay policies never warn. Events arriving before then are
 * dropped silently.
 */
export class AudioEngine implements AudioModule, Steppable {
  private graph: Graph | null = null;
  private readonly pool: VoicePool;
  private readonly voices = new Map<VoiceId, SynthVoice>();
  private readonly crackerVoices = new Map<CrackerId, VoiceId[]>();
  private readonly ladis = new Map<CrackerId, LadiSound>();
  private readonly ambienceScheduler: AmbienceScheduler;
  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly createContext: () => AudioContext | null;
  private readonly tuning: Tuning;
  private readonly random: () => number;
  private profile: QualityProfile;
  private listener: CameraView | null = null;
  private isMuted = false;
  private gain = 0.8;
  private sessionPaused = false;

  constructor(options: AudioEngineOptions) {
    this.createContext = options.createContext ?? defaultContext;
    this.profile = options.profile ?? qualityProfile(DEFAULT_QUALITY);
    this.tuning = options.tuning ?? TUNING;
    this.random = options.random ?? Math.random;
    this.pool = new VoicePool(this.profile.maxAudioVoices);
    this.ambienceScheduler = new AmbienceScheduler(this.random);
    this.subscribe(options.bus);
  }

  get unlocked(): boolean {
    return this.graph?.ctx.state === 'running';
  }

  get muted(): boolean {
    return this.isMuted;
  }

  get masterGain(): number {
    return this.gain;
  }

  get activeVoices(): number {
    return this.graph ? this.pool.activeCount(this.graph.ctx.currentTime) : 0;
  }

  get voiceLimit(): number {
    return this.pool.limit;
  }

  /**
   * The context and bus for recorded music, so it shares unlock, pause,
   * mute and master gain with the effects; null until `unlock()` has built
   * the graph. Music sources are the caller's and outside the voice cap.
   */
  get musicOutput(): MusicOutput | null {
    return this.graph ? { context: this.graph.ctx, destination: this.graph.music } : null;
  }

  async unlock(): Promise<void> {
    if (!this.graph) {
      let ctx: AudioContext | null = null;
      try {
        ctx = this.createContext();
      } catch (error) {
        console.warn('Audio unavailable:', error);
      }
      if (!ctx) return;
      this.graph = this.buildGraph(ctx);
      if (this.listener) this.setListener(this.listener);
    }
    // Stay quiet while paused; `resumed` restarts the context.
    if (this.sessionPaused) return;
    await this.resumeContext();
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    this.applyMaster();
  }

  setMasterGain(gain: number): void {
    if (!Number.isFinite(gain)) return;
    this.gain = Math.min(1, Math.max(0, gain));
    this.applyMaster();
  }

  setListener(view: CameraView): void {
    this.listener = view;
    if (!this.graph) return;
    const { listener } = this.graph.ctx;
    const { position: p, forward: f } = view;
    // Up is world +Y made perpendicular to the view direction.
    const dot = f.y;
    let up = { x: -f.x * dot, y: 1 - f.y * dot, z: -f.z * dot };
    const length = Math.hypot(up.x, up.y, up.z);
    up = length > 1e-6 ? { x: up.x / length, y: up.y / length, z: up.z / length } : { x: 0, y: 0, z: -1 };
    if (listener.positionX) {
      listener.positionX.value = p.x;
      listener.positionY.value = p.y;
      listener.positionZ.value = p.z;
      listener.forwardX.value = f.x;
      listener.forwardY.value = f.y;
      listener.forwardZ.value = f.z;
      listener.upX.value = up.x;
      listener.upY.value = up.y;
      listener.upZ.value = up.z;
    } else {
      // Older Safari lacks the AudioParam form.
      listener.setPosition(p.x, p.y, p.z);
      listener.setOrientation(f.x, f.y, f.z, up.x, up.y, up.z);
    }
  }

  applyQuality(profile: QualityProfile): void {
    this.profile = profile;
    this.pool.setCapacity(profile.maxAudioVoices, this.now());
    this.forgetStoppedVoices();
  }

  /** Advance distant ambience by `dt` seconds. */
  update(dt: number): void {
    if (!this.unlocked || !this.profile.ambientFireworks) return;
    for (const event of this.ambienceScheduler.update(dt)) this.playAmbient(event);
  }

  /** Stop every effect voice for a fresh celebration; the ambience bed continues. */
  reset(): void {
    this.pool.clear();
    this.voices.clear();
    this.crackerVoices.clear();
    this.ladis.clear();
    this.ambienceScheduler.reset();
  }

  /** Unsubscribe and close the context. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.reset();
    const graph = this.graph;
    this.graph = null;
    graph?.ctx.close().catch(() => undefined);
  }

  private subscribe(bus: GameEventBus): void {
    const { crackers } = this.tuning;
    this.unsubscribes.push(
      bus.on('fuseLit', ({ id, type, position }) => {
        this.playFor(id, 'fuseHiss', { position, duration: crackers.fuse[type] });
      }),
      bus.on('crackerActive', ({ id, type, position, flight, ladi }) => {
        this.stopCracker(id);
        if (ladi) this.ladis.set(id, { chain: ladi.chain, next: 0 });
        const sound = ACTIVE_SOUND[type];
        if (!sound) return;
        const duration = flight?.ascent ?? crackers.activeDuration[type];
        // The whistle rises to where the rocket will burst.
        const moveTo =
          type === 'rocket'
            ? {
                x: position.x + (flight?.drift.x ?? 0),
                y: position.y + (flight?.apexHeight ?? crackers.rocketApexHeight),
                z: position.z + (flight?.drift.z ?? 0),
              }
            : undefined;
        this.playFor(id, sound, { position, duration, moveTo });
      }),
      bus.on('ladiPop', ({ id, index, position }) => this.playLadiBatch(id, index, position)),
      bus.on('crackerFinished', ({ id }) => {
        this.stopCracker(id);
        // Its last batch rings on; there is nothing left to schedule.
        this.ladis.delete(id);
      }),
      bus.on('burst', ({ position, pattern }) => {
        const distance = this.listener ? distanceBetween(this.listener.position, position) : 0;
        this.play('burst', { position, duration: BURST_DURATION, delay: distance / SPEED_OF_SOUND, pattern });
      }),
      bus.on('distantLaunch', ({ position, apex, rise }) => {
        if (!this.profile.ambientFireworks) return;
        const distance = this.listener ? distanceBetween(this.listener.position, position) : DISTANT_REFERENCE;
        this.playDistant('distantWhistle', position, distance, 0.8, {
          duration: rise,
          delay: distance / SPEED_OF_SOUND,
          moveTo: apex,
        });
      }),
      bus.on('distantBurst', ({ position }) => {
        if (!this.profile.ambientFireworks) return;
        const distance = this.listener ? distanceBetween(this.listener.position, position) : DISTANT_REFERENCE;
        this.playDistant('distantShell', position, distance, 1, {
          duration: DISTANT_SHELL_DURATION,
          delay: distance / SPEED_OF_SOUND,
        });
      }),
      // The balti blast: its fuse hisses, the bomb booms under the steel, the balti clangs down.
      bus.on('baltiStep', ({ step, position, fuse }) => {
        if (step === 'lit') this.play('fuseHiss', { position, duration: fuse ?? crackers.fuse.anar });
      }),
      bus.on('baltiBlast', ({ position }) => {
        const distance = this.listener ? distanceBetween(this.listener.position, position) : 0;
        this.play('baltiBoom', { position, duration: BALTI_BOOM_DURATION, delay: distance / SPEED_OF_SOUND });
      }),
      bus.on('baltiBounce', ({ position, speed }) => {
        const gain = Math.min(1, Math.max(0.15, speed / BALTI_CLANG_FULL_SPEED));
        this.play('baltiClang', { position, duration: BALTI_CLANG_DURATION, gain });
      }),
      bus.on('paused', () => {
        this.sessionPaused = true;
        this.graph?.ctx.suspend().catch(() => undefined);
      }),
      bus.on('resumed', () => {
        this.sessionPaused = false;
        if (this.graph) void this.resumeContext();
      }),
      bus.on('sessionReset', () => this.reset()),
      bus.on('qualityChanged', ({ profile }) => this.applyQuality(profile)),
    );
  }

  private buildGraph(ctx: AudioContext): Graph {
    const master = ctx.createGain();
    master.gain.value = this.targetGain();
    // Softens the peak when many bursts stack.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 8;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    const sfx = ctx.createGain();
    sfx.connect(master);
    // Effects also ring off the lane's walls.
    const echo = ctx.createGain();
    echo.gain.value = ECHO_GAIN;
    sfx.connect(echo);
    echo.connect(createLaneEcho(ctx, this.random)).connect(master);
    const ladi = createLadiBus(ctx, sfx, this.random);
    const ambience = ctx.createGain();
    ambience.connect(master);
    const music = ctx.createGain();
    music.connect(master);
    return { ctx, master, sfx, ladi, ambience, music, bank: createNoiseBank(ctx, this.random), townCrackle: null };
  }

  private async resumeContext(): Promise<void> {
    const graph = this.graph;
    if (!graph) return;
    try {
      if (graph.ctx.state !== 'running') await graph.ctx.resume();
    } catch (error) {
      console.warn('Audio could not start:', error);
      return;
    }
    if (!graph.townCrackle && graph.ctx.state === 'running') {
      const bed = graph.ctx.createGain();
      bed.connect(graph.ambience);
      graph.ambience.gain.value = TOWN_CRACKLE_GAIN;
      graph.townCrackle = startTownCrackle(graph.ctx, graph.bank, bed, graph.ctx.currentTime);
    }
  }

  private playFor(id: CrackerId, kind: SoundKind, options: PlayOptions): void {
    const voice = this.play(kind, options);
    if (voice === null) return;
    const list = this.crackerVoices.get(id);
    if (list) list.push(voice);
    else this.crackerVoices.set(id, [voice]);
  }

  /**
   * At a pop no batch covers yet, play it and the pops right after it as one
   * voice. A batch is not tied to the cracker, so the ladi finishing never
   * cuts its last bangs short; pause and reset still silence it.
   */
  private playLadiBatch(id: CrackerId, index: number, position: Vec3): void {
    const ladi = this.ladis.get(id);
    if (!ladi || index < ladi.next) return;
    const pops = ladi.chain.pops;
    const first = pops[index];
    if (!first) return;
    const batch: LadiPopSound[] = [];
    let i = index;
    for (; i < pops.length && pops[i]!.time - first.time < LADI_BATCH; i++) {
      const pop = pops[i]!;
      batch.push({ at: pop.time - first.time, level: ladiPopLevel(pop.loud, this.random) });
    }
    // Later pops start the next batch even if this one found no voice.
    ladi.next = i;
    const last = batch[batch.length - 1]!.at;
    this.play('ladiPops', { position, duration: last + LADI_RING, pops: batch });
  }

  private stopCracker(id: CrackerId): void {
    const list = this.crackerVoices.get(id);
    if (!list) return;
    this.crackerVoices.delete(id);
    const now = this.now();
    for (const voiceId of list) {
      const voice = this.voices.get(voiceId);
      this.voices.delete(voiceId);
      if (this.pool.release(voiceId) && voice) silence(voice, now);
    }
  }

  private play(kind: SoundKind, options: PlayOptions): VoiceId | null {
    const graph = this.graph;
    if (!graph || !this.unlocked) return null;
    const { ctx } = graph;
    const spec = SOUNDS[kind];
    const now = ctx.currentTime;
    const t0 = now + Math.max(0, options.delay ?? 0);
    const end = t0 + options.duration;

    let synth: SynthVoice | null = null;
    const id = this.pool.allocate(
      {
        priority: spec.priority,
        endTime: end + STOP_FADE,
        stop: () => {
          if (synth) silence(synth, ctx.currentTime);
        },
      },
      now,
    );
    if (id === null) return null;
    this.forgetStoppedVoices();

    const output = ctx.createGain();
    const panner = this.createPanner(ctx, options.position, options.refDistance ?? spec.refDistance);
    if (options.moveTo) movePanner(panner, options.position, options.moveTo, t0, end);
    output.connect(panner);
    panner.connect(spec.bus === 'ladi' ? graph.ladi : graph.sfx);
    synth = synthesise(ctx, graph.bank, kind, output, {
      t0,
      duration: options.duration,
      gain: spec.gain * (options.gain ?? 1),
      distance: options.distance,
      pattern: options.pattern,
      pops: options.pops,
    });
    // Disconnect once the last source finishes so finished voices are collected.
    const last = synth.sources[synth.sources.length - 1];
    if (last) last.onended = () => output.disconnect();
    this.voices.set(id, synth);
    return id;
  }

  /** Play one crackers-elsewhere event now (the scheduler's, or the sound board's). */
  playAmbient(event: AmbientEvent): void {
    const origin = this.listener?.position ?? { x: 0, y: 0, z: 0 };
    const position = {
      x: origin.x + Math.sin(event.azimuth) * event.distance,
      y: origin.y,
      z: origin.z + Math.cos(event.azimuth) * event.distance,
    };
    const { distance, intensity, duration } = event;
    switch (event.kind) {
      case 'rocket': {
        // It whistles up, then bursts where it stops.
        const apex = { ...position, y: position.y + ROCKET_APEX.min + this.random() * (ROCKET_APEX.max - ROCKET_APEX.min) };
        this.playDistant('distantWhistle', position, distance, intensity, { duration, moveTo: apex });
        this.playDistant('distantShell', apex, distance, intensity, { duration: DISTANT_SHELL_DURATION, delay: duration });
        return;
      }
      case 'ladi':
        this.playDistant('distantLadi', position, distance, intensity, { duration: duration + LADI_TAIL });
        return;
      case 'anar':
        this.playDistant('distantFountain', position, distance, intensity, { duration });
        return;
      case 'chakri':
        this.playDistant('distantChakri', position, distance, intensity, { duration });
        return;
      case 'bomb':
        this.playDistant('distantBomb', position, distance, intensity, { duration: DISTANT_BOMB_DURATION });
        return;
      case 'pop':
        this.playDistant('distantPop', position, distance, intensity, { duration: DISTANT_POP_DURATION });
        return;
    }
  }

  /**
   * A sound `distance` metres away: quieter with distance (the panner only
   * gives direction), optionally delayed and moving (a rising rocket).
   */
  private playDistant(
    kind: SoundKind,
    position: Vec3,
    distance: number,
    intensity: number,
    options: { readonly duration: number; readonly delay?: number; readonly moveTo?: Vec3 },
  ): void {
    this.play(kind, {
      position,
      duration: options.duration,
      delay: options.delay,
      moveTo: options.moveTo,
      gain: intensity * Math.sqrt(DISTANT_REFERENCE / Math.max(DISTANT_REFERENCE, distance)),
      refDistance: distance,
      distance,
    });
  }

  private createPanner(ctx: AudioContext, position: Vec3, refDistance: number): PannerNode {
    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = 10000;
    panner.rolloffFactor = 1;
    if (panner.positionX) {
      panner.positionX.value = position.x;
      panner.positionY.value = position.y;
      panner.positionZ.value = position.z;
    } else {
      panner.setPosition(position.x, position.y, position.z);
    }
    return panner;
  }

  /** Drop handles for voices the pool no longer tracks (ended or stolen). */
  private forgetStoppedVoices(): void {
    for (const id of this.voices.keys()) {
      if (!this.pool.has(id)) this.voices.delete(id);
    }
  }

  private targetGain(): number {
    return this.isMuted ? 0 : this.gain;
  }

  private applyMaster(): void {
    if (!this.graph) return;
    const { master, ctx } = this.graph;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(this.targetGain(), ctx.currentTime, GAIN_SMOOTHING);
  }

  private now(): number {
    return this.graph?.ctx.currentTime ?? 0;
  }
}

/** How high rockets elsewhere in town climb before bursting, metres. */
const ROCKET_APEX = { min: 25, max: 55 } as const;

function defaultContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ? new Ctor({ latencyHint: 'interactive' }) : null;
}

function movePanner(panner: PannerNode, from: Vec3, to: Vec3, t0: number, end: number): void {
  if (!panner.positionX) return;
  const axes: [AudioParam, number, number][] = [
    [panner.positionX, from.x, to.x],
    [panner.positionY, from.y, to.y],
    [panner.positionZ, from.z, to.z],
  ];
  for (const [param, a, b] of axes) {
    param.setValueAtTime(a, t0);
    param.linearRampToValueAtTime(b, end);
  }
}

function distanceBetween(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
