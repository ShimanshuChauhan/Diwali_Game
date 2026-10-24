import { describe, expect, it } from 'vitest';
import { FixedStep } from '../src/core/fixedStep';

describe('FixedStep', () => {
  const step = 1 / 60;

  it('accumulates partial frames until a full step is available', () => {
    const loop = new FixedStep({ step, maxSteps: 5 });
    expect(loop.advance(step / 2).steps).toBe(0);
    expect(loop.advance(step / 2).steps).toBe(1);
  });

  it('runs multiple steps for a long frame and reports the remainder as alpha', () => {
    const loop = new FixedStep({ step, maxSteps: 5 });
    const result = loop.advance(step * 2.5);
    expect(result.steps).toBe(2);
    expect(result.alpha).toBeCloseTo(0.5);
  });

  it('caps steps after a stall and drops the backlog', () => {
    const loop = new FixedStep({ step, maxSteps: 5 });
    expect(loop.advance(10).steps).toBe(5);
    expect(loop.advance(0).steps).toBe(0);
  });

  it('ignores negative elapsed time', () => {
    const loop = new FixedStep({ step, maxSteps: 5 });
    expect(loop.advance(-1)).toEqual({ steps: 0, alpha: 0 });
  });

  it('rejects invalid options', () => {
    expect(() => new FixedStep({ step: 0, maxSteps: 1 })).toThrow();
    expect(() => new FixedStep({ step, maxSteps: 0 })).toThrow();
  });
});
