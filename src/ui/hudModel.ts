import type { HeldItem, Interactable, UiModule } from '../core/contracts';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import {
  CRACKER_TYPES,
  isHandheld,
  type CameraMode,
  type CrackerType,
  type IgnitionRejection,
  type PlacementRejection,
} from '../core/types';
import { CRACKER_LABELS, rejectionText, type RejectionKind } from './text';

/** How long a rejection message stays on screen, in seconds. */
export const REJECTION_SECONDS = 2.5;

/** One line of the contextual prompt under the crosshair. */
export interface PromptLine {
  readonly text: string;
  /** True when the line explains why the action is unavailable. */
  readonly blocked: boolean;
}

/** What the player is looking at this frame, gathered by the game loop. */
export interface HudContext {
  /** Nearest usable cracker or diya, from `InteractionModule.findInteractable`. */
  readonly interactable: Interactable | null;
  /** Type of the interactable cracker, for its label. */
  readonly interactableType?: CrackerType;
  /** The handheld phuljhari, from `CrackersModule.held`. */
  readonly held?: HeldItem | null;
  /** This frame's placement verdict for the selected ground cracker, if aiming. */
  readonly placement?: { readonly ok: boolean; readonly reason: PlacementRejection | null } | null;
}

export interface Rejection {
  readonly text: string;
  /** Seconds left on screen. */
  readonly remaining: number;
}

function lower(type: CrackerType): string {
  return CRACKER_LABELS[type].toLowerCase();
}

/**
 * The contextual prompt for the current selection and view, e.g.
 * "E: Light anar" and "Click: Place rocket". It depends only on what the
 * player is near and holding — never on the camera mode — so the same
 * prompts appear in first- and third-person.
 */
export function promptLines(selected: CrackerType, context: HudContext): PromptLine[] {
  const lines: PromptLine[] = [];
  const { interactable } = context;
  if (interactable?.kind === 'diya') {
    lines.push({ text: 'E: Light diya', blocked: false });
  } else if (interactable?.kind === 'cracker') {
    const label = context.interactableType ? lower(context.interactableType) : 'cracker';
    lines.push({ text: `E: Light ${label}`, blocked: false });
  }

  if (isHandheld(selected)) {
    if (!interactable && !context.held?.lit) lines.push({ text: `E: Light ${lower(selected)}`, blocked: false });
  } else if (context.placement && !context.placement.ok && context.placement.reason) {
    lines.push({ text: rejectionText(context.placement.reason, 'placement'), blocked: true });
  } else {
    lines.push({ text: `Click: Place ${lower(selected)}`, blocked: false });
  }
  return lines;
}

function sameLines(a: readonly PromptLine[], b: readonly PromptLine[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.text !== b[i]!.text || a[i]!.blocked !== b[i]!.blocked) return false;
  }
  return true;
}

export interface HudModelOptions {
  /** When given, the HUD follows selection, rejection, camera and pause events. */
  readonly bus?: GameEventBus;
  /** Selection before any `crackerSelected`; defaults to slot 1. */
  readonly selected?: CrackerType;
  readonly rejectionSeconds?: number;
}

/**
 * Renderer-free state of the HUD: hotbar selection, contextual prompts,
 * the latest rejection message and crosshair visibility. The DOM view
 * (`hud.ts`) redraws whenever `revision` changes, so per-frame updates
 * that change nothing cost nothing.
 */
export class HudModel implements UiModule {
  private readonly initialSelection: CrackerType;
  private readonly rejectionSeconds: number;
  private readonly unsubscribes: Unsubscribe[] = [];

  private currentSelection: CrackerType;
  private currentMode: CameraMode = 'firstPerson';
  private isPaused = true;
  private lines: readonly PromptLine[] = [];
  private currentRejection: { text: string; remaining: number } | null = null;
  private rev = 0;

  constructor(options: HudModelOptions = {}) {
    this.initialSelection = options.selected ?? CRACKER_TYPES[0];
    this.currentSelection = this.initialSelection;
    this.rejectionSeconds = options.rejectionSeconds ?? REJECTION_SECONDS;
    const { bus } = options;
    if (bus) {
      this.unsubscribes.push(
        bus.on('crackerSelected', ({ type }) => this.setSelection(type)),
        bus.on('placementRejected', ({ reason }) => this.showRejection(reason, 'placement')),
        bus.on('ignitionRejected', ({ reason }) => this.showRejection(reason, 'ignition')),
        bus.on('cameraModeChanged', ({ mode }) => this.setCameraMode(mode)),
        bus.on('paused', () => this.setPaused(true)),
        bus.on('resumed', () => this.setPaused(false)),
        bus.on('sessionStarted', () => this.setPaused(false)),
        bus.on('sessionReset', () => this.reset()),
      );
    }
  }

  /** Bumps whenever anything visible changes. */
  get revision(): number {
    return this.rev;
  }

  get selected(): CrackerType {
    return this.currentSelection;
  }

  get cameraMode(): CameraMode {
    return this.currentMode;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  get prompts(): readonly PromptLine[] {
    return this.lines;
  }

  get rejection(): Rejection | null {
    return this.currentRejection;
  }

  /** The HUD hides behind the start screen and pause menu. */
  get visible(): boolean {
    return !this.isPaused;
  }

  /** The crosshair is for aiming in first-person only. */
  get crosshairVisible(): boolean {
    return !this.isPaused && this.currentMode === 'firstPerson';
  }

  setSelection(type: CrackerType): void {
    if (type === this.currentSelection) return;
    this.currentSelection = type;
    this.changed();
  }

  setCameraMode(mode: CameraMode): void {
    if (mode === this.currentMode) return;
    this.currentMode = mode;
    this.changed();
  }

  setPaused(paused: boolean): void {
    if (paused === this.isPaused) return;
    this.isPaused = paused;
    this.changed();
  }

  /** Replace the prompt with fixed text; null hides it. */
  showPrompt(text: string | null): void {
    this.setLines(text === null ? [] : [{ text, blocked: false }]);
  }

  /** Recompute the prompt from what the player is near and aiming at. */
  setContext(context: HudContext): void {
    this.setLines(promptLines(this.currentSelection, context));
  }

  showRejection(reason: PlacementRejection | IgnitionRejection, kind: RejectionKind = 'placement'): void {
    this.currentRejection = { text: rejectionText(reason, kind), remaining: this.rejectionSeconds };
    this.changed();
  }

  /** Age the rejection message by `dt` seconds of real time. */
  update(dt: number): void {
    const rejection = this.currentRejection;
    if (!rejection) return;
    rejection.remaining -= dt;
    // The countdown alone changes nothing visible, so no revision bump.
    if (rejection.remaining > 0) return;
    this.currentRejection = null;
    this.changed();
  }

  /** Fresh session: default selection, no prompt, no message. */
  reset(): void {
    this.currentSelection = this.initialSelection;
    this.lines = [];
    this.currentRejection = null;
    this.changed();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  private setLines(lines: readonly PromptLine[]): void {
    if (sameLines(lines, this.lines)) return;
    this.lines = lines;
    this.changed();
  }

  private changed(): void {
    this.rev++;
  }
}
