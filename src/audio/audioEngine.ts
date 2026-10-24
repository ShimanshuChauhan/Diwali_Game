import type { AudioModule, CameraView, Steppable } from '../core/contracts';
import type { GameEventBus } from '../core/events';
import type { Unsubscribe } from '../core/eventBus';
import { DEFAULT_QUALITY, qualityProfile, type QualityProfile } from '../core/quality';
import { TUNING, type Tuning } from '../core/tuning';
import type { CrackerId, NeighbourId, Vec3 } from '../core/types';
import { AmbienceScheduler, AMBIENCE, type DistantPop } from './ambience';
import {
  ACTIVE_SOUND,
  BURST_DURATION,
  CHEER_DURATION,
  DISTANT_POP_DURATION,
  SOUNDS,
  STOP_FADE,
  type SoundKind,
} from './sounds';
import { createNoiseBank, silence, startMurmur, synthesise, type NoiseBank, type SynthVoice } from './synth';
import { VoicePool, type VoiceId } from './voicePool';

/** Metres per second; delays far bursts so the flash leads the boom. */
const SPEED_OF_SOUND = 343;
/** Seconds the master gain takes to follow mute/volume changes. */
const GAIN_SMOOTHING = 0.03;
const MURMUR_GAIN = 0.22;

export interface AudioEngineOptions {
  readonly bus: GameEventBus;
  /**
   * Builds the context on unlock; return null when Web Audio is missing.
   * Defaults to the browser's `AudioContext`. Tests inject a fake.
   */
  readonly createContext?: () => AudioContext | null;
  readonly profile?: QualityProfile;
  readonly tuning?: Tuning;
  /** Where a neighbour stands, so cheers are spatial; unknown ids play unpanned. */
  readonly neighbourPosition?: (id: NeighbourId) => Vec3 | undefined;
  readonly random?: () => number;
}

interface Graph {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly sfx: GainNode;
  readonly ambience: GainNode;
  readonly bank: NoiseBank;
  murmur: SynthVoice | null;
}

interface PlayOptions {
  /** Null plays unpanned (e.g. a cheer with no known position). */
  readonly position: Vec3 | null;
  readonly duration: number;
  readonly delay?: number;
  readonly gain?: number;
  readonly refDistance?: number;
  /** Panner moves here linearly over the voice, e.g. a rising rocket. */
  readonly moveTo?: Vec3;
  readonly distance?: number;
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
  private readonly ambienceScheduler: AmbienceScheduler;
  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly createContext: () => AudioContext | null;
  private readonly tuning: Tuning;
  private readonly neighbourPosition: (id: NeighbourId) => Vec3 | undefined;
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
    this.neighbourPosition = options.neighbourPosition ?? (() => undefined);
    this.random = options.random ?? Math.random;
    this.pool = new VoicePool(this.profile.maxAudioVoices);
    this.ambienceScheduler = new AmbienceScheduler(this.random, AMBIENCE);
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
    for (const pop of this.ambienceScheduler.update(dt)) this.playDistantPop(pop);
  }

  /** Stop every effect voice for a fresh celebration; the ambience bed continues. */
  reset(): void {
    this.pool.clear();
    this.voices.clear();
    this.crackerVoices.clear();
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
      bus.on('crackerActive', ({ id, type, position }) => {
        this.stopCracker(id);
        const duration = crackers.activeDuration[type];
        const moveTo = type === 'rocket' ? { ...position, y: position.y + crackers.rocketApexHeight } : undefined;
        this.playFor(id, ACTIVE_SOUND[type], { position, duration, moveTo });
      }),
      bus.on('crackerFinished', ({ id }) => this.stopCracker(id)),
      bus.on('burst', ({ position }) => {
        const distance = this.listener ? distanceBetween(this.listener.position, position) : 0;
        this.play('burst', { position, duration: BURST_DURATION, delay: distance / SPEED_OF_SOUND });
      }),
      bus.on('neighbourReacted', ({ id, reaction }) => {
        if (reaction !== 'cheer') return;
        this.play('cheer', { position: this.neighbourPosition(id) ?? null, duration: CHEER_DURATION });
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
    const ambience = ctx.createGain();
    ambience.connect(master);
    return { ctx, master, sfx, ambience, bank: createNoiseBank(ctx, this.random), murmur: null };
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
    if (!graph.murmur && graph.ctx.state === 'running') {
      const bed = graph.ctx.createGain();
      bed.connect(graph.ambience);
      graph.ambience.gain.value = MURMUR_GAIN;
      graph.murmur = startMurmur(graph.ctx, graph.bank, bed, graph.ctx.currentTime);
    }
  }

  private playFor(id: CrackerId, kind: SoundKind, options: PlayOptions): void {
    const voice = this.play(kind, options);
    if (voice === null) return;
    const list = this.crackerVoices.get(id);
    if (list) list.push(voice);
    else this.crackerVoices.set(id, [voice]);
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
    if (options.position) {
      const panner = this.createPanner(ctx, options.position, options.refDistance ?? spec.refDistance);
      if (options.moveTo) movePanner(panner, options.position, options.moveTo, t0, end);
      output.connect(panner);
      panner.connect(graph.sfx);
    } else {
      output.connect(graph.sfx);
    }
    synth = synthesise(ctx, graph.bank, kind, output, {
      t0,
      duration: options.duration,
      gain: spec.gain * (options.gain ?? 1),
      distance: options.distance,
    });
    // Disconnect once the last source finishes so finished voices are collected.
    const last = synth.sources[synth.sources.length - 1];
    if (last) last.onended = () => output.disconnect();
    this.voices.set(id, synth);
    return id;
  }

  private playDistantPop(pop: DistantPop): void {
    const origin = this.listener?.position ?? { x: 0, y: 0, z: 0 };
    const position = {
      x: origin.x + Math.sin(pop.azimuth) * pop.distance,
      y: origin.y + 15,
      z: origin.z + Math.cos(pop.azimuth) * pop.distance,
    };
    const falloff = Math.sqrt(AMBIENCE.minDistance / pop.distance);
    this.play('distantPop', {
      position,
      duration: DISTANT_POP_DURATION,
      gain: pop.intensity * falloff,
      // Loudness is set by `falloff`; the panner only supplies direction.
      refDistance: pop.distance,
      distance: pop.distance,
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
