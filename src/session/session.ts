import type { Resettable, SessionModule } from '../core/contracts';
import type { GameEventBus } from '../core/events';

/** `idle` is the start screen, before the first `start()`. */
export type SessionState = 'idle' | 'running' | 'paused';

export interface SessionOptions {
  readonly bus: GameEventBus;
  /** Modules whose session-local state a fresh session clears. */
  readonly resettables?: Iterable<Resettable>;
}

/**
 * Session lifecycle: start screen → running ⇄ paused.
 *
 * Every session is fresh. Nothing is persisted, so a reload always lands on
 * the start screen with diyas unlit, no placed crackers and the player at
 * spawn. Modules join a reset either by registering here or by listening for
 * `sessionReset` on the bus.
 */
export class Session implements SessionModule {
  private current: SessionState = 'idle';
  private readonly bus: GameEventBus;
  private readonly resettables = new Set<Resettable>();

  constructor(options: SessionOptions) {
    this.bus = options.bus;
    for (const resettable of options.resettables ?? []) this.resettables.add(resettable);
  }

  get state(): SessionState {
    return this.current;
  }

  get started(): boolean {
    return this.current !== 'idle';
  }

  /** True whenever gameplay should not advance, including on the start screen. */
  get paused(): boolean {
    return this.current !== 'running';
  }

  /** Include a module in every reset. Returns a function that removes it. */
  register(resettable: Resettable): () => void {
    this.resettables.add(resettable);
    return () => this.resettables.delete(resettable);
  }

  start(): void {
    this.reset();
    this.current = 'running';
    this.bus.emit('sessionStarted', {});
  }

  /** Restore every module to its initial state; the run/pause state is kept. */
  reset(): void {
    for (const resettable of this.resettables) resettable.reset();
    this.bus.emit('sessionReset', {});
  }

  pause(reason: 'user' | 'focusLost'): void {
    if (this.current !== 'running') return;
    this.current = 'paused';
    this.bus.emit('paused', { reason });
  }

  resume(): void {
    if (this.current !== 'paused') return;
    this.current = 'running';
    this.bus.emit('resumed', {});
  }
}
