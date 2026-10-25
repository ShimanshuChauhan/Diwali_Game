import { describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../src/audio/audioEngine';
import { CAPACITY_RESOURCES, CapacityBudget, type CapacityStats } from '../src/capacity';
import { createGameEventBus, type GameEvents } from '../src/core/events';
import { QUALITY_LEVELS, qualityProfile } from '../src/core/quality';
import { TUNING, type Tuning } from '../src/core/tuning';
import { CRACKER_TYPES, type CrackerType, type QualityLevel, type Vec3 } from '../src/core/types';
import { Crackers } from '../src/crackers';
import { FireworksEffects } from '../src/effects/fireworksEffects';
import {
  createPerfOverlay,
  FrameTimer,
  initialQualityLevel,
  PERF_OVERLAY_KEY,
  perfLines,
  QUALITY_STORAGE_KEY,
  QualitySettings,
  renderSettings,
  type PerfSnapshot,
  type QualityStorage,
} from '../src/quality';
import { CONTROLS_HELP } from '../src/ui/text';
import { FakeAudioContext } from './fakeAudioContext';

const STEP = 1 / 60;
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function memoryStorage(initial: Record<string, string> = {}): QualityStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const brokenStorage: QualityStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('initial quality level', () => {
  it('prefers the URL, then the stored choice, then Medium', () => {
    const storage = memoryStorage({ [QUALITY_STORAGE_KEY]: 'high' });
    expect(initialQualityLevel({ search: '?quality=low', storage })).toBe('low');
    expect(initialQualityLevel({ search: '', storage })).toBe('high');
    expect(initialQualityLevel({})).toBe('medium');
  });

  it('ignores unknown values and unreadable storage', () => {
    const storage = memoryStorage({ [QUALITY_STORAGE_KEY]: 'ultra' });
    expect(initialQualityLevel({ search: '?quality=potato', storage })).toBe('medium');
    expect(initialQualityLevel({ storage: brokenStorage })).toBe('medium');
  });
});

describe('QualitySettings', () => {
  it('announces each switch once and remembers it', () => {
    const bus = createGameEventBus();
    const storage = memoryStorage();
    const quality = new QualitySettings({ bus, level: 'high', storage });
    const changes: GameEvents['qualityChanged'][] = [];
    bus.on('qualityChanged', (e) => changes.push(e));

    quality.setLevel('high');
    expect(changes).toHaveLength(0);

    quality.setLevel('low');
    expect(quality.level).toBe('low');
    expect(quality.profile).toBe(qualityProfile('low'));
    expect(changes).toEqual([{ profile: qualityProfile('low') }]);
    expect(storage.data[QUALITY_STORAGE_KEY]).toBe('low');
  });

  it('still switches when storage refuses the write', () => {
    const bus = createGameEventBus();
    const quality = new QualitySettings({ bus, storage: brokenStorage });
    const onChange = vi.fn();
    bus.on('qualityChanged', onChange);
    quality.setLevel('low');
    expect(onChange).toHaveBeenCalledOnce();
    expect(quality.level).toBe('low');
  });
});

describe('render settings', () => {
  it('caps pixel ratio per profile and scales Low down', () => {
    expect(renderSettings(qualityProfile('high'), 3).pixelRatio).toBe(2);
    expect(renderSettings(qualityProfile('medium'), 3).pixelRatio).toBe(1.5);
    expect(renderSettings(qualityProfile('medium'), 1).pixelRatio).toBe(1);
    expect(renderSettings(qualityProfile('low'), 2).pixelRatio).toBe(0.75);
  });

  it('falls back to 1 for a bogus device ratio and never drops below half resolution', () => {
    expect(renderSettings(qualityProfile('high'), Number.NaN).pixelRatio).toBe(1);
    expect(renderSettings({ ...qualityProfile('low'), renderScale: 0.1 }, 1).pixelRatio).toBe(0.5);
  });

  it('keeps bloom and shadows off on Low only', () => {
    expect(renderSettings(qualityProfile('low'), 1)).toMatchObject({ bloom: false, shadows: false });
    for (const level of ['medium', 'high'] as const) {
      expect(renderSettings(qualityProfile(level), 1)).toMatchObject({ bloom: true, shadows: true });
    }
  });

  it('never gets more expensive going down a level', () => {
    const settings = QUALITY_LEVELS.map((level) => renderSettings(qualityProfile(level), 2));
    for (let i = 1; i < settings.length; i++) {
      expect(settings[i]!.pixelRatio).toBeGreaterThanOrEqual(settings[i - 1]!.pixelRatio);
      expect(settings[i]!.shadowMapSize).toBeGreaterThanOrEqual(settings[i - 1]!.shadowMapSize);
    }
  });
});

describe('FrameTimer', () => {
  it('averages over a fixed window', () => {
    const timer = new FrameTimer(4);
    expect(timer.fps).toBe(0);
    for (let i = 0; i < 4; i++) timer.record(1 / 30);
    expect(timer.fps).toBeCloseTo(30);
    for (let i = 0; i < 4; i++) timer.record(1 / 60);
    expect(timer.count).toBe(4);
    expect(timer.averageMs).toBeCloseTo(1000 / 60);
    expect(timer.fps).toBeCloseTo(60);
  });

  it('tracks the worst frame and ignores pauses and junk', () => {
    const timer = new FrameTimer(8);
    timer.record(0.016);
    timer.record(0.05);
    timer.record(30); // tab was hidden
    timer.record(-1);
    timer.record(Number.NaN);
    expect(timer.count).toBe(2);
    expect(timer.worstMs).toBeCloseTo(50);
    timer.reset();
    expect(timer.count).toBe(0);
  });

  it('stays bounded over a long session', () => {
    const timer = new FrameTimer();
    for (let i = 0; i < 100_000; i++) timer.record(STEP);
    expect(timer.count).toBe(timer.capacity);
    expect(timer.fps).toBeCloseTo(60);
  });
});

function snapshot(capacity: CapacityStats): PerfSnapshot {
  return { level: 'low', fps: 59.6, frameMs: 16.78, worstFrameMs: 33.3, drawCalls: 42, triangles: 1234, capacity };
}

function emptyStats(): CapacityStats {
  const resources = Object.fromEntries(CAPACITY_RESOURCES.map((r) => [r, { used: 1, limit: 9 }]));
  return { resources, reclaimedProps: 3, rejectedPlacements: 0, rejectedIgnitions: 0 } as CapacityStats;
}

describe('perf overlay text', () => {
  it('lists FPS, frame time, draw calls and every budget', () => {
    const text = perfLines(snapshot(emptyStats())).join('\n');
    for (const label of ['Quality', 'FPS', 'Frame', 'Draw calls', 'Particles', 'Lights', 'Voices', 'Effects', 'Placed', 'Lit']) {
      expect(text).toContain(label);
    }
    expect(text).toContain(' 60');
    expect(text).toContain('16.8 ms');
    expect(text).toContain('Draw calls 42');
    expect(text).toContain('1 / 9');
  });

  it('is listed in the controls help', () => {
    expect(CONTROLS_HELP.some(([key]) => key === PERF_OVERLAY_KEY)).toBe(true);
  });
});

/** Just enough DOM for the overlay view. */
function fakeParent() {
  const panel = {
    className: '',
    textContent: '',
    style: { cssText: '', display: '' },
    setAttribute: () => {},
    remove: vi.fn(),
  };
  const parent = {
    ownerDocument: { createElement: () => panel },
    appendChild: vi.fn(),
  };
  return { panel, parent: parent as unknown as HTMLElement };
}

function key(code: string): Event {
  const event = new Event('keydown', { cancelable: true });
  return Object.assign(event, { code });
}

describe('perf overlay view', () => {
  it('toggles with F3 and refreshes only while shown', () => {
    const { panel, parent } = fakeParent();
    const win = new EventTarget();
    const sample = vi.fn(() => snapshot(emptyStats()));
    const overlay = createPerfOverlay({ parent, win, sample });
    expect(overlay.visible).toBe(false);
    overlay.frame(1);
    expect(sample).not.toHaveBeenCalled();

    const toggle = key(PERF_OVERLAY_KEY);
    win.dispatchEvent(toggle);
    expect(toggle.defaultPrevented).toBe(true);
    expect(overlay.visible).toBe(true);
    expect(panel.style.display).toBe('block');
    expect(panel.textContent).toContain('Draw calls');

    sample.mockClear();
    overlay.frame(0.1);
    expect(sample).not.toHaveBeenCalled();
    overlay.frame(0.2);
    expect(sample).toHaveBeenCalledOnce();

    win.dispatchEvent(key('KeyW'));
    expect(overlay.visible).toBe(true);
    win.dispatchEvent(key(PERF_OVERLAY_KEY));
    expect(panel.style.display).toBe('none');

    overlay.dispose();
    expect(panel.remove).toHaveBeenCalled();
    win.dispatchEvent(key(PERF_OVERLAY_KEY));
    expect(overlay.visible).toBe(false);
  });
});

/** Real crackers, capacity, effects and audio wired to one quality setting. */
async function celebration(level: QualityLevel = 'medium', tuning: Tuning = TUNING) {
  const bus = createGameEventBus();
  const quality = new QualitySettings({ bus, level });
  const ctx = new FakeAudioContext();
  const audio = new AudioEngine({
    bus,
    profile: quality.profile,
    createContext: () => ctx.asAudioContext(),
    random: seeded(7),
  });
  await audio.unlock();
  const effects = new FireworksEffects(bus, { quality: quality.profile, random: seeded(11) });
  const capacity = new CapacityBudget({
    crackers: () => crackers,
    bus,
    quality: quality.profile,
    effects: () => effects.stats,
    voices: () => audio.activeVoices,
    tuning,
  });
  const crackers = new Crackers({ bus, tuning, admission: capacity, random: seeded(5) });
  let x = 0;
  const launch = (type: CrackerType) => {
    const placed = crackers.place({ type, position: v((x = (x + 1.5) % 30), 0, 0) });
    if (placed.ok) crackers.ignite(placed.id);
  };
  const step = (seconds: number, check: (stats: CapacityStats) => void = () => {}) => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) {
      crackers.update(STEP);
      effects.update(STEP);
      capacity.update(STEP);
      audio.update(STEP);
      ctx.currentTime += STEP;
      check(capacity.stats);
    }
  };
  return { bus, quality, audio, effects, capacity, crackers, launch, step };
}

function expectWithinBudgets(stats: CapacityStats): void {
  for (const resource of CAPACITY_RESOURCES) {
    const { used, limit } = stats.resources[resource];
    expect(used, resource).toBeLessThanOrEqual(limit);
  }
}

describe('switching profiles at runtime', () => {
  it('re-budgets capacity, effects and audio from one setLevel, without a reload', async () => {
    const { quality, audio, effects, capacity } = await celebration('high');
    const particles = effects.engine.particles.positions;
    for (const level of ['low', 'medium', 'high', 'low'] as const) {
      quality.setLevel(level);
      const profile = qualityProfile(level);
      expect(capacity.limit('particles')).toBe(profile.maxParticles);
      expect(capacity.limit('activeEffects')).toBe(profile.maxActiveEffects);
      expect(effects.stats.particleLimit).toBe(profile.maxParticles);
      expect(effects.stats.lightLimit).toBe(profile.maxDynamicLights);
      expect(audio.voiceLimit).toBe(profile.maxAudioVoices);
    }
    // Same pooled storage throughout: switching never rebuilds the engine.
    expect(effects.engine.particles.positions).toBe(particles);
  });

  it('keeps crackers already burning when dropping to Low mid-show', async () => {
    const tuning = { ...TUNING, caps: { ...TUNING.caps, maxLitCrackers: 12 } };
    const { quality, crackers, capacity, launch, step } = await celebration('high', tuning);
    for (let i = 0; i < 8; i++) launch('anar');
    expect(crackers.litCount).toBe(8);
    quality.setLevel('low');
    // Over Low's effect budget, yet nothing already burning is cancelled…
    expect(crackers.litCount).toBe(8);
    expect(crackers.litCount).toBeGreaterThan(qualityProfile('low').maxActiveEffects);
    // …only new ignitions wait until the show drops back under it.
    launch('anar');
    expect(crackers.litCount).toBe(8);
    step(20);
    expect(crackers.litCount).toBe(0);
    expectWithinBudgets(capacity.stats);
  });
});

describe('overlay counters during repeated launches', () => {
  it.each(QUALITY_LEVELS)('stay within budget and drain back to zero on %s', async (level) => {
    const { launch, step, capacity } = await celebration(level);
    const peaks: number[] = [];
    for (let round = 0; round < 6; round++) {
      let peak = 0;
      for (let i = 0; i < 12; i++) {
        // Every ground type in turn: anar, chakri, rocket, ladi.
        launch(CRACKER_TYPES[1 + (i % 4)]!);
        step(0.25, (stats) => {
          expectWithinBudgets(stats);
          peak = Math.max(peak, stats.resources.particles.used);
        });
      }
      peaks.push(peak);
      step(20, expectWithinBudgets);
      const settled = capacity.stats.resources;
      expect(settled.litCrackers.used).toBe(0);
      expect(settled.activeEffects.used).toBe(0);
      expect(settled.particles.used).toBe(0);
      expect(settled.dynamicLights.used).toBe(0);
      // Voices are not drained: the distant-fireworks ambience keeps playing.
    }
    // Every round reaches a similar peak: nothing accumulates between rounds.
    expect(Math.max(...peaks)).toBeLessThanOrEqual(qualityProfile(level).maxParticles);
    expect(peaks[peaks.length - 1]).toBeLessThanOrEqual(Math.max(...peaks.slice(0, 2)) * 1.5);
  });

  it('stay bounded when the profile changes while rockets are in the air', async () => {
    const { quality, launch, step } = await celebration('high');
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 10; i++) {
        launch('rocket');
        step(0.2, expectWithinBudgets);
      }
      quality.setLevel(QUALITY_LEVELS[round % QUALITY_LEVELS.length]!);
      step(8, expectWithinBudgets);
    }
  });

  it('keeps all five cracker types working on Low', async () => {
    const { bus, launch, crackers, step } = await celebration('low');
    const active = new Set<CrackerType>();
    const bursts: GameEvents['burst'][] = [];
    bus.on('crackerActive', ({ type }) => active.add(type));
    bus.on('burst', (e) => bursts.push(e));
    crackers.select('phuljhari');
    expect(crackers.igniteHeld().ok).toBe(true);
    for (const type of ['anar', 'chakri', 'rocket', 'ladi'] as const) launch(type);
    step(6);
    expect([...active].sort()).toEqual([...CRACKER_TYPES].sort());
    expect(bursts.length).toBeGreaterThan(0);
  });
});
