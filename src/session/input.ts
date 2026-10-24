import type { GameAction } from '../core/actions';
import type { InputModule } from '../core/contracts';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import { bindingFor, PLACE_BUTTON } from './bindings';

export interface InputOptions {
  /** When given, input disables on `paused` and re-enables on `sessionStarted`/`resumed`. */
  readonly bus?: GameEventBus;
  /** Whether input is accepted before any session event. Defaults to true. */
  readonly enabled?: boolean;
}

/**
 * Converts raw key/mouse input into `GameAction`s. DOM-free: the browser edge
 * (`domControls.ts`) forwards `KeyboardEvent.code`s, buttons and mouse deltas.
 *
 * Held keys are tracked so that releasing them — or losing focus with them
 * down — always ends in a neutral `move`/`run`, and movement never sticks.
 */
export class Input implements InputModule {
  private readonly held = new Set<string>();
  private queue: GameAction[] = [];
  private forward = 0;
  private right = 0;
  private running = false;
  private enabled: boolean;
  private readonly unsubscribes: Unsubscribe[] = [];

  constructor(options: InputOptions = {}) {
    this.enabled = options.enabled ?? true;
    const { bus } = options;
    if (bus) {
      this.unsubscribes.push(
        bus.on('paused', () => this.setEnabled(false)),
        bus.on('resumed', () => this.setEnabled(true)),
        bus.on('sessionStarted', () => this.setEnabled(true)),
        bus.on('sessionReset', () => this.releaseAll()),
      );
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Codes currently held down, e.g. for debugging stuck keys. */
  get heldKeys(): readonly string[] {
    return [...this.held];
  }

  /** Disabling releases everything; while disabled, input is ignored. */
  setEnabled(enabled: boolean): void {
    if (!enabled) this.releaseAll();
    this.enabled = enabled;
  }

  /** Returns true when `code` is bound, so the caller can suppress browser defaults. */
  keyDown(code: string): boolean {
    const binding = bindingFor(code);
    if (!binding) return false;
    if (!this.enabled || this.held.has(code)) return true;
    this.held.add(code);
    if (binding.kind === 'press') this.queue.push(binding.action);
    else this.updateHeld();
    return true;
  }

  keyUp(code: string): boolean {
    const binding = bindingFor(code);
    if (!binding) return false;
    if (this.held.delete(code)) this.updateHeld();
    return true;
  }

  mouseDown(button: number): void {
    if (this.enabled && button === PLACE_BUTTON) this.queue.push({ type: 'place' });
  }

  /** Mouse delta in pixels; consecutive deltas merge into one action. */
  look(dx: number, dy: number): void {
    if (!this.enabled || (dx === 0 && dy === 0)) return;
    const last = this.queue[this.queue.length - 1];
    if (last?.type === 'look') {
      this.queue[this.queue.length - 1] = { type: 'look', dx: last.dx + dx, dy: last.dy + dy };
    } else {
      this.queue.push({ type: 'look', dx, dy });
    }
  }

  drainActions(): readonly GameAction[] {
    if (!this.enabled || this.queue.length === 0) return [];
    const actions = this.queue;
    this.queue = [];
    return actions;
  }

  /**
   * Forget held keys and pending presses and looks. If the player was moving
   * or running, queue the neutral actions so consumers stop them. Pending
   * move/run actions are kept so a repeated release can't drop the neutral.
   */
  releaseAll(): void {
    this.held.clear();
    this.queue = this.queue.filter((action) => action.type === 'move' || action.type === 'run');
    this.updateHeld();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  private updateHeld(): void {
    let forward = 0;
    let right = 0;
    let running = false;
    for (const code of this.held) {
      const binding = bindingFor(code);
      if (binding?.kind === 'axis') {
        if (binding.axis === 'forward') forward += binding.sign;
        else right += binding.sign;
      } else if (binding?.kind === 'run') {
        running = true;
      }
    }
    if (forward !== this.forward || right !== this.right) {
      this.forward = forward;
      this.right = right;
      this.queue.push({ type: 'move', forward, right });
    }
    if (running !== this.running) {
      this.running = running;
      this.queue.push({ type: 'run', active: running });
    }
  }
}
