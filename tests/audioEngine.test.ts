import { describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../src/audio/audioEngine';
import { BURST_DURATION } from '../src/audio/sounds';
import { createGameEventBus, type GameEventBus } from '../src/core/events';
import { qualityProfile, type QualityProfile } from '../src/core/quality';
import { TUNING } from '../src/core/tuning';
import { CRACKER_TYPES, type Vec3 } from '../src/core/types';
import { FakeAudioContext, type FakeSource } from './fakeAudioContext';

const origin: Vec3 = { x: 0, y: 0, z: 0 };

function setup(profile: QualityProfile = qualityProfile('low')) {
  const bus = createGameEventBus();
  const ctx = new FakeAudioContext();
  const createContext = vi.fn(() => ctx.asAudioContext());
  const audio = new AudioEngine({ bus, createContext, profile, random: () => 0.5 });
  return { bus, ctx, createContext, audio };
}

function launchRocket(bus: GameEventBus, id: string, position: Vec3 = origin): void {
  bus.emit('fuseLit', { id, type: 'rocket', position });
  bus.emit('crackerActive', { id, type: 'rocket', position });
}

/** Panners (one per spatial voice) still fed by a sounding source. */
function soundingVoices(ctx: FakeAudioContext): number {
  const live = new Set<unknown>();
  const walk = (node: unknown, seen: Set<unknown>): unknown => {
    if (!node || seen.has(node)) return null;
    seen.add(node);
    if (ctx.panners.includes(node as never)) return node;
    for (const next of (node as { outputs?: unknown[] }).outputs ?? []) {
      const found = walk(next, seen);
      if (found) return found;
    }
    return null;
  };
  for (const source of ctx.soundingSources() as FakeSource[]) {
    const panner = walk(source, new Set());
    if (panner) live.add(panner);
  }
  return live.size;
}

describe('AudioEngine before a player gesture', () => {
  it('creates no audio context and plays nothing', () => {
    const { bus, createContext, audio } = setup();
    launchRocket(bus, 'r1');
    bus.emit('burst', { id: 'r1', position: { x: 0, y: 40, z: 0 }, pattern: 'peony', colours: [0xff0000] });
    audio.update(10);
    audio.setMuted(true);
    audio.setMasterGain(0.3);

    expect(createContext).not.toHaveBeenCalled();
    expect(audio.unlocked).toBe(false);
    expect(audio.activeVoices).toBe(0);
  });

  it('settings made before unlock apply once the context starts', async () => {
    const { ctx, audio } = setup();
    audio.setMasterGain(0.3);
    audio.setMuted(true);
    await audio.unlock();
    const master = ctx.gains[0]!;
    expect(master.gain.value).toBe(0);
    audio.setMuted(false);
    expect(master.gain.value).toBeCloseTo(0.3);
  });
});

describe('AudioEngine unlock', () => {
  it('starts the context and the ambience bed on unlock', async () => {
    const { ctx, audio } = setup();
    await audio.unlock();
    expect(audio.unlocked).toBe(true);
    expect(ctx.state).toBe('running');
    expect(ctx.soundingSources().length).toBeGreaterThan(0);
  });

  it('is idempotent', async () => {
    const { ctx, createContext, audio } = setup();
    await audio.unlock();
    const sources = ctx.sources.length;
    await audio.unlock();
    expect(createContext).toHaveBeenCalledOnce();
    expect(ctx.sources.length).toBe(sources);
  });

  it('resolves quietly when Web Audio is unavailable', async () => {
    const bus = createGameEventBus();
    const audio = new AudioEngine({ bus, createContext: () => null });
    await expect(audio.unlock()).resolves.toBeUndefined();
    expect(audio.unlocked).toBe(false);
    expect(() => launchRocket(bus, 'r1')).not.toThrow();
  });

  it('survives a context constructor that throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bus = createGameEventBus();
    const audio = new AudioEngine({
      bus,
      createContext: () => {
        throw new Error('blocked');
      },
    });
    await expect(audio.unlock()).resolves.toBeUndefined();
    expect(audio.unlocked).toBe(false);
    warn.mockRestore();
  });

  it('survives an autoplay-blocked resume and retries on the next gesture', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ctx, audio } = setup();
    ctx.rejectResume = true;
    await expect(audio.unlock()).resolves.toBeUndefined();
    expect(audio.unlocked).toBe(false);

    ctx.rejectResume = false;
    await audio.unlock();
    expect(audio.unlocked).toBe(true);
    warn.mockRestore();
  });
});

describe('AudioEngine voices', () => {
  it('plays a sound for every cracker stage', async () => {
    const { bus, audio } = setup(qualityProfile('high'));
    await audio.unlock();
    for (const [i, type] of CRACKER_TYPES.entries()) {
      const id = `c${i}`;
      bus.emit('fuseLit', { id, type, position: { x: i, y: 0, z: 0 } });
      bus.emit('crackerActive', { id, type, position: { x: i, y: 0, z: 0 } });
    }
    bus.emit('burst', { id: 'c3', position: { x: 3, y: 40, z: 0 }, pattern: 'ring', colours: [0x00ff00] });
    // Each fuse hiss gives way to its active sound; plus one burst.
    expect(audio.activeVoices).toBe(CRACKER_TYPES.length + 1);
  });

  it('stays within the voice cap under rapid launches', async () => {
    const { bus, ctx, audio } = setup(qualityProfile('low'));
    await audio.unlock();
    const cap = qualityProfile('low').maxAudioVoices;
    for (let i = 0; i < 100; i++) {
      launchRocket(bus, `r${i}`, { x: i % 10, y: 0, z: -5 });
      bus.emit('burst', { id: `r${i}`, position: { x: 0, y: 40, z: -5 }, pattern: 'peony', colours: [0xffaa00] });
      bus.emit('fuseLit', { id: `a${i}`, type: 'anar', position: { x: 1, y: 0, z: -3 } });
      ctx.currentTime += 0.01;
      expect(audio.activeVoices).toBeLessThanOrEqual(cap);
    }
    // Stolen voices have actually been silenced, not just forgotten.
    ctx.currentTime += 0.1;
    expect(soundingVoices(ctx)).toBeLessThanOrEqual(cap);
  });

  it('bursts outrank and steal from ambient pops and fuses', async () => {
    const { bus, ctx, audio } = setup(qualityProfile('low'));
    await audio.unlock();
    const cap = audio.voiceLimit;
    for (let i = 0; i < cap; i++) bus.emit('fuseLit', { id: `f${i}`, type: 'anar', position: origin });
    expect(audio.activeVoices).toBe(cap);

    bus.emit('burst', { id: 'r', position: { x: 0, y: 40, z: 0 }, pattern: 'palm', colours: [0xffffff] });

    expect(audio.activeVoices).toBe(cap);
    ctx.currentTime += 0.5;
    // One fuse was cut to make room; the burst plays.
    expect(soundingVoices(ctx)).toBe(cap);
  });

  it('stops the fuse hiss when the cracker becomes active and its sound when it finishes', async () => {
    const { bus, ctx, audio } = setup();
    await audio.unlock();
    bus.emit('fuseLit', { id: 'a', type: 'anar', position: origin });
    expect(audio.activeVoices).toBe(1);

    bus.emit('crackerActive', { id: 'a', type: 'anar', position: origin });
    ctx.currentTime += 0.1;
    expect(audio.activeVoices).toBe(1);
    expect(soundingVoices(ctx)).toBe(1);

    bus.emit('crackerFinished', { id: 'a', type: 'anar', reason: 'completed' });
    expect(audio.activeVoices).toBe(0);
    ctx.currentTime += 0.1;
    expect(soundingVoices(ctx)).toBe(0);
  });

  it('frees a voice once its sound has played out', async () => {
    const { bus, ctx, audio } = setup();
    await audio.unlock();
    bus.emit('fuseLit', { id: 'c', type: 'chakri', position: origin });
    ctx.currentTime += TUNING.crackers.fuse.chakri + 0.2;
    expect(audio.activeVoices).toBe(0);
  });

  it('delays a far burst by the travel time of sound', async () => {
    const { bus, ctx, audio } = setup();
    await audio.unlock();
    audio.setListener({ mode: 'firstPerson', position: origin, forward: { x: 0, y: 0, z: -1 }, yaw: 0, pitch: 0 });
    const before = ctx.sources.length;
    bus.emit('burst', { id: 'r', position: { x: 0, y: 343, z: 0 }, pattern: 'willow', colours: [0xff00ff] });
    const starts = ctx.sources.slice(before).map((source) => source.startedAt!);
    expect(Math.min(...starts)).toBeCloseTo(1, 5);
    ctx.currentTime += 1 + BURST_DURATION + 0.1;
    expect(audio.activeVoices).toBe(0);
  });

  it('moves the rocket whistle up to the apex', async () => {
    const { bus, ctx, audio } = setup();
    await audio.unlock();
    launchRocket(bus, 'r', { x: 2, y: 0, z: 3 });
    const panner = ctx.panners.at(-1)!;
    const ramp = panner.positionY.events.find((e) => e.method === 'linearRampToValueAtTime');
    expect(ramp?.args[0]).toBe(TUNING.crackers.rocketApexHeight);
  });

  it('plays cheers spatially when the neighbour is known, unpanned otherwise', async () => {
    const bus = createGameEventBus();
    const ctx = new FakeAudioContext();
    const audio = new AudioEngine({
      bus,
      createContext: () => ctx.asAudioContext(),
      neighbourPosition: (id) => (id === 'n1' ? { x: 4, y: 0, z: 1 } : undefined),
    });
    await audio.unlock();
    bus.emit('neighbourReacted', { id: 'n1', reaction: 'cheer' });
    expect(ctx.panners).toHaveLength(1);
    bus.emit('neighbourReacted', { id: 'n2', reaction: 'cheer' });
    expect(ctx.panners).toHaveLength(1);
    bus.emit('neighbourReacted', { id: 'n1', reaction: 'watch' });
    expect(audio.activeVoices).toBe(2);
  });

  it('a lower quality cap stops excess voices', async () => {
    const { bus, ctx, audio } = setup(qualityProfile('high'));
    await audio.unlock();
    for (let i = 0; i < 30; i++) bus.emit('fuseLit', { id: `f${i}`, type: 'anar', position: origin });
    bus.emit('qualityChanged', { profile: qualityProfile('low') });
    expect(audio.voiceLimit).toBe(qualityProfile('low').maxAudioVoices);
    expect(audio.activeVoices).toBe(qualityProfile('low').maxAudioVoices);
    ctx.currentTime += 0.1;
    expect(soundingVoices(ctx)).toBe(qualityProfile('low').maxAudioVoices);
  });

  it('a session reset silences every effect voice', async () => {
    const { bus, ctx, audio } = setup();
    await audio.unlock();
    for (let i = 0; i < 5; i++) launchRocket(bus, `r${i}`);
    bus.emit('sessionReset', {});
    expect(audio.activeVoices).toBe(0);
    ctx.currentTime += 0.1;
    expect(soundingVoices(ctx)).toBe(0);
    // Ambience bed keeps going.
    expect(ctx.soundingSources().length).toBeGreaterThan(0);
  });
});

describe('AudioEngine ambience', () => {
  it('plays distant pops only once unlocked', async () => {
    const { ctx, audio } = setup(qualityProfile('high'));
    audio.update(30);
    expect(ctx.panners).toHaveLength(0);
    await audio.unlock();
    for (let i = 0; i < 600; i++) audio.update(1 / 60);
    expect(ctx.panners.length).toBeGreaterThan(0);
  });

  it('respects the quality toggle for ambient fireworks', async () => {
    const profile = { ...qualityProfile('low'), ambientFireworks: false };
    const { ctx, audio } = setup(profile);
    await audio.unlock();
    for (let i = 0; i < 600; i++) audio.update(1 / 60);
    expect(ctx.panners).toHaveLength(0);
  });
});

describe('AudioEngine mix', () => {
  it('mute silences the master and unmute restores the volume', async () => {
    const { ctx, audio } = setup();
    await audio.unlock();
    const master = ctx.gains[0]!;
    audio.setMasterGain(0.6);
    expect(master.gain.value).toBeCloseTo(0.6);
    audio.setMuted(true);
    expect(audio.muted).toBe(true);
    expect(master.gain.value).toBe(0);
    audio.setMuted(false);
    expect(master.gain.value).toBeCloseTo(0.6);
  });

  it('clamps volume to [0, 1] and ignores non-numbers', async () => {
    const { audio } = setup();
    audio.setMasterGain(3);
    expect(audio.masterGain).toBe(1);
    audio.setMasterGain(-1);
    expect(audio.masterGain).toBe(0);
    audio.setMasterGain(Number.NaN);
    expect(audio.masterGain).toBe(0);
  });

  it('pausing suspends audio and resuming restarts it', async () => {
    const { bus, ctx, audio } = setup();
    await audio.unlock();
    bus.emit('paused', { reason: 'user' });
    await Promise.resolve();
    expect(ctx.state).toBe('suspended');
    expect(audio.unlocked).toBe(false);
    bus.emit('resumed', {});
    await Promise.resolve();
    expect(ctx.state).toBe('running');
  });

  it('does not start audio from a gesture made while paused', async () => {
    const { bus, ctx, audio } = setup();
    bus.emit('paused', { reason: 'focusLost' });
    await audio.unlock();
    expect(ctx.state).toBe('suspended');
    bus.emit('resumed', {});
    await Promise.resolve();
    expect(ctx.state).toBe('running');
  });

  it('points the listener along the camera view', async () => {
    const { ctx, audio } = setup();
    audio.setListener({ mode: 'firstPerson', position: { x: 1, y: 1.6, z: 2 }, forward: { x: 1, y: 0, z: 0 }, yaw: 0, pitch: 0 });
    await audio.unlock();
    expect(ctx.listener.positionX.value).toBe(1);
    expect(ctx.listener.positionY.value).toBe(1.6);
    expect(ctx.listener.forwardX.value).toBe(1);
    expect(ctx.listener.upY.value).toBeCloseTo(1);
  });

  it('dispose stops listening and closes the context', async () => {
    const { bus, ctx, audio } = setup();
    await audio.unlock();
    audio.dispose();
    expect(ctx.state).toBe('closed');
    expect(bus.listenerCount('burst')).toBe(0);
  });
});
