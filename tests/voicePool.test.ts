import { describe, expect, it, vi } from 'vitest';
import { VoicePool } from '../src/audio/voicePool';

const voice = (priority: number, endTime = 10, stop = vi.fn()) => ({ priority, endTime, stop });

describe('VoicePool', () => {
  it('admits voices up to its capacity', () => {
    const pool = new VoicePool(3);
    for (let i = 0; i < 3; i++) expect(pool.allocate(voice(1), 0)).not.toBeNull();
    expect(pool.activeCount(0)).toBe(3);
  });

  it('steals the lowest-priority voice when full', () => {
    const pool = new VoicePool(2);
    const low = voice(0);
    const high = voice(5);
    pool.allocate(low, 0);
    pool.allocate(high, 0);

    expect(pool.allocate(voice(3), 0)).not.toBeNull();

    expect(low.stop).toHaveBeenCalledOnce();
    expect(high.stop).not.toHaveBeenCalled();
    expect(pool.activeCount(0)).toBe(2);
  });

  it('steals the oldest voice among equal priorities', () => {
    const pool = new VoicePool(2);
    const first = voice(2);
    const second = voice(2);
    pool.allocate(first, 0);
    pool.allocate(second, 0.1);

    pool.allocate(voice(2), 0.2);

    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();
  });

  it('rejects a request outranked by every playing voice', () => {
    const pool = new VoicePool(1);
    const burst = voice(5);
    pool.allocate(burst, 0);

    expect(pool.allocate(voice(0), 0)).toBeNull();
    expect(burst.stop).not.toHaveBeenCalled();
  });

  it('frees voices once they end on their own', () => {
    const pool = new VoicePool(1);
    const short = voice(5, 1);
    pool.allocate(short, 0);

    expect(pool.allocate(voice(0), 1)).not.toBeNull();
    expect(short.stop).not.toHaveBeenCalled();
  });

  it('never exceeds its cap under a flood of requests', () => {
    const pool = new VoicePool(8);
    for (let i = 0; i < 200; i++) {
      pool.allocate(voice(i % 6, i * 0.01 + 5), i * 0.01);
      expect(pool.activeCount(i * 0.01)).toBeLessThanOrEqual(8);
    }
  });

  it('release forgets a voice without stopping it', () => {
    const pool = new VoicePool(2);
    const v = voice(1);
    const id = pool.allocate(v, 0)!;
    expect(pool.release(id)).toBe(true);
    expect(pool.release(id)).toBe(false);
    expect(v.stop).not.toHaveBeenCalled();
    expect(pool.activeCount(0)).toBe(0);
  });

  it('shrinking capacity stops the weakest voices', () => {
    const pool = new VoicePool(3);
    const voices = [voice(0), voice(4), voice(2)];
    for (const v of voices) pool.allocate(v, 0);

    pool.setCapacity(1, 0);

    expect(voices[0]!.stop).toHaveBeenCalledOnce();
    expect(voices[2]!.stop).toHaveBeenCalledOnce();
    expect(voices[1]!.stop).not.toHaveBeenCalled();
    expect(pool.activeCount(0)).toBe(1);
  });

  it('clear stops everything', () => {
    const pool = new VoicePool(2);
    const voices = [voice(1), voice(2)];
    for (const v of voices) pool.allocate(v, 0);
    pool.clear();
    for (const v of voices) expect(v.stop).toHaveBeenCalledOnce();
    expect(pool.activeCount(0)).toBe(0);
  });

  it('a zero cap admits nothing', () => {
    expect(new VoicePool(0).allocate(voice(9), 0)).toBeNull();
  });
});
