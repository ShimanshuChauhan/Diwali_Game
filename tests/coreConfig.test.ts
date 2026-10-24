import { describe, expect, it } from 'vitest';
import { crackerForSlot, isSelectSlot } from '../src/core/actions';
import { QUALITY_LEVELS, QUALITY_PROFILES, qualityProfile } from '../src/core/quality';
import { TUNING } from '../src/core/tuning';
import { CRACKER_TYPES, isHandheld } from '../src/core/types';

describe('select slots', () => {
  it('maps keys 1–5 to phuljhari, anar, chakri, rocket, ladi', () => {
    expect([1, 2, 3, 4, 5].map((slot) => crackerForSlot(slot as 1 | 2 | 3 | 4 | 5))).toEqual([
      'phuljhari',
      'anar',
      'chakri',
      'rocket',
      'ladi',
    ]);
  });

  it('accepts only slots 1–5', () => {
    expect([0, 1, 4, 5, 6, 2.5].map(isSelectSlot)).toEqual([false, true, true, true, false, false]);
  });

  it('treats only the phuljhari as handheld', () => {
    expect(CRACKER_TYPES.filter(isHandheld)).toEqual(['phuljhari']);
  });
});

describe('tuning', () => {
  it('gives every cracker type a positive fuse and active duration', () => {
    for (const type of CRACKER_TYPES) {
      expect(TUNING.crackers.fuse[type]).toBeGreaterThan(0);
      expect(TUNING.crackers.activeDuration[type]).toBeGreaterThan(0);
    }
  });

  it('keeps capacity caps consistent', () => {
    const { maxPlacedCrackers, maxLitCrackers } = TUNING.caps;
    expect(maxLitCrackers).toBeGreaterThanOrEqual(1);
    expect(maxPlacedCrackers).toBeGreaterThanOrEqual(maxLitCrackers);
  });

  it('runs faster than it walks', () => {
    expect(TUNING.player.runSpeed).toBeGreaterThan(TUNING.player.walkSpeed);
  });
});

describe('quality profiles', () => {
  it('defines a profile for every level, keyed by its own level', () => {
    for (const level of QUALITY_LEVELS) {
      expect(qualityProfile(level).level).toBe(level);
    }
  });

  it('never lowers a budget when stepping up a level', () => {
    const budgets = ['maxParticles', 'maxActiveEffects', 'maxDynamicLights', 'maxAudioVoices'] as const;
    const { low, medium, high } = QUALITY_PROFILES;
    for (const key of budgets) {
      expect(medium[key]).toBeGreaterThanOrEqual(low[key]);
      expect(high[key]).toBeGreaterThanOrEqual(medium[key]);
    }
  });

  it('keeps enough budget on Low for several simultaneous fireworks', () => {
    expect(QUALITY_PROFILES.low.maxActiveEffects).toBeGreaterThanOrEqual(CRACKER_TYPES.length);
    expect(QUALITY_PROFILES.low.ambientFireworks).toBe(true);
  });
});

describe('rule modules stay renderer-free', () => {
  // Contract and rule files in core; eveningScene.ts is rendering by design.
  const sources = import.meta.glob<string>(['../src/core/*.ts', '!../src/core/eveningScene.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  });
  const ruleFiles = Object.entries(sources);

  it('finds the core rule files', () => {
    expect(ruleFiles.length).toBeGreaterThan(0);
  });

  it.each(ruleFiles)('%s imports neither three nor rapier', (_file, source) => {
    expect(source).not.toMatch(/from\s+['"](three|@dimforge\/)/);
  });
});
