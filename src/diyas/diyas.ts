import type { DiyaSite, DiyasModule } from '../core/contracts';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import type { DiyaId } from '../core/types';

/**
 * Houses whose door diyas are already burning when a session begins, so the
 * lane has some glow before the player lights anything. Ids missing from
 * the world are ignored.
 */
export const DEFAULT_PRE_LIT: readonly DiyaId[] = [
  'house.lane.e1.diya.left',
  'house.lane.e1.diya.right',
  'house.court.ne.diya.left',
  'house.court.ne.diya.right',
];

export interface DiyasOptions {
  readonly sites: readonly DiyaSite[];
  /** Diyas lit at the start of every session; defaults to `DEFAULT_PRE_LIT`. */
  readonly preLit?: Iterable<DiyaId>;
  /** Publishes `diyaLit` and resets on `sessionReset`. */
  readonly bus?: GameEventBus;
}

/**
 * The diyas module: session-local lit state for the world's existing diyas.
 * Lighting is idempotent — only the first light of a diya changes anything
 * or emits `diyaLit`. Nothing is persisted; `reset()` restores the pre-lit
 * set. Renderer-free.
 */
export class Diyas implements DiyasModule {
  readonly sites: readonly DiyaSite[];
  private readonly byId = new Map<DiyaId, DiyaSite>();
  private readonly preLit: ReadonlySet<DiyaId>;
  private readonly lit = new Set<DiyaId>();
  private readonly bus: GameEventBus | undefined;
  private readonly unsubscribe: Unsubscribe[] = [];
  private changes = 0;

  constructor(options: DiyasOptions) {
    this.sites = options.sites;
    for (const site of options.sites) this.byId.set(site.id, site);
    const preLit = new Set<DiyaId>();
    for (const id of options.preLit ?? DEFAULT_PRE_LIT) if (this.byId.has(id)) preLit.add(id);
    this.preLit = preLit;
    this.bus = options.bus;
    if (options.bus) this.unsubscribe.push(options.bus.on('sessionReset', () => this.reset()));
    this.reset();
  }

  get litCount(): number {
    return this.lit.size;
  }

  /** Bumped whenever the lit set changes, so views can skip unchanged frames. */
  get version(): number {
    return this.changes;
  }

  /** Light a diya. True only the first time; unknown or lit diyas are a no-op. */
  light(id: DiyaId): boolean {
    const site = this.byId.get(id);
    if (!site || this.lit.has(id)) return false;
    this.lit.add(id);
    this.changes++;
    this.bus?.emit('diyaLit', { id, position: site.position });
    return true;
  }

  isLit(id: DiyaId): boolean {
    return this.lit.has(id);
  }

  /** Fresh session: only the pre-lit diyas burn. */
  reset(): void {
    this.lit.clear();
    for (const id of this.preLit) this.lit.add(id);
    this.changes++;
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }
}
