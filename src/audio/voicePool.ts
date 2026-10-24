/**
 * Concurrent-voice budget with priority stealing.
 *
 * Renderer- and Web-Audio-free: the pool only tracks bookkeeping and calls
 * each voice's `stop` when it is stolen or cleared, so it runs headless.
 * Times are on the caller's clock (the audio context's `currentTime`).
 */
export interface VoiceSpec {
  /** Higher survives longer; a request may steal voices of equal or lower priority. */
  readonly priority: number;
  /** When the voice ends on its own; it is pruned after this. */
  readonly endTime: number;
  /** Silence the voice now. Called at most once, only when stolen or cleared. */
  readonly stop: () => void;
}

export type VoiceId = number;

interface Voice extends VoiceSpec {
  readonly id: VoiceId;
  readonly startTime: number;
}

export class VoicePool {
  private readonly voices = new Map<VoiceId, Voice>();
  private nextId = 1;

  constructor(private capacity: number) {
    if (capacity < 0) throw new Error('capacity must be non-negative');
  }

  get limit(): number {
    return this.capacity;
  }

  /** Voices still playing at `now`. */
  activeCount(now: number): number {
    this.prune(now);
    return this.voices.size;
  }

  /**
   * Admit a voice, stealing the weakest (lowest priority, then oldest) voice
   * if the pool is full. Returns null when every playing voice outranks the
   * request; the caller must then not start it.
   */
  allocate(spec: VoiceSpec, now: number): VoiceId | null {
    this.prune(now);
    if (this.capacity === 0) return null;
    if (this.voices.size >= this.capacity) {
      const victim = this.weakest();
      if (!victim || victim.priority > spec.priority) return null;
      this.voices.delete(victim.id);
      victim.stop();
    }
    const id = this.nextId++;
    this.voices.set(id, { ...spec, id, startTime: now });
    return id;
  }

  /** Forget a voice that the caller stopped itself. Returns false if unknown. */
  release(id: VoiceId): boolean {
    return this.voices.delete(id);
  }

  has(id: VoiceId): boolean {
    return this.voices.has(id);
  }

  /** Change the budget, stopping the weakest voices if over it. */
  setCapacity(capacity: number, now: number): void {
    if (capacity < 0) throw new Error('capacity must be non-negative');
    this.capacity = capacity;
    this.prune(now);
    while (this.voices.size > this.capacity) {
      const victim = this.weakest();
      if (!victim) break;
      this.voices.delete(victim.id);
      victim.stop();
    }
  }

  /** Stop and forget every voice. */
  clear(): void {
    const voices = [...this.voices.values()];
    this.voices.clear();
    for (const voice of voices) voice.stop();
  }

  private prune(now: number): void {
    for (const [id, voice] of this.voices) {
      if (voice.endTime <= now) this.voices.delete(id);
    }
  }

  private weakest(): Voice | undefined {
    let weakest: Voice | undefined;
    for (const voice of this.voices.values()) {
      if (
        !weakest ||
        voice.priority < weakest.priority ||
        (voice.priority === weakest.priority && voice.startTime < weakest.startTime)
      ) {
        weakest = voice;
      }
    }
    return weakest;
  }
}
