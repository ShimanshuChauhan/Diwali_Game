import { slotForSong } from '../aarti/participation';
import { AARTI_RECORDINGS } from '../audio/aarti/recordings';
import type { Unsubscribe } from '../core/eventBus';
import type { GameEventBus } from '../core/events';
import { AARTI_SONG_IDS, type AartiSnapshot, type AartiSongId } from '../core/homes';
import { DS } from './design/tokens';

const ACCENT = DS.color.accent;
const NOTICE = DS.color.textDanger;

/** One row of the song selector. */
export interface MiniPlayerSong {
  readonly id: AartiSongId;
  readonly title: string;
  /** The number key that picks it while playing. */
  readonly key: string;
  readonly current: boolean;
}

/**
 * What the mini player shows (PRD → Audio catalogue and controls): the three
 * songs to choose from, the current one and its progress, and nothing else.
 * There is deliberately no pause, seek, repeat or queue, and it disappears
 * once the player leaves or the ceremony completes.
 */
export interface MiniPlayerView {
  /** Only while the player takes part in a running aarti. */
  readonly visible: boolean;
  readonly title: string;
  /** How far through the current song, 0–1. */
  readonly progress: number;
  /** Elapsed and full length, e.g. "0:12 / 0:24". */
  readonly time: string;
  readonly songs: readonly MiniPlayerSong[];
  /** How to use the controls right now: keys while playing, the mouse while paused. */
  readonly hints: readonly string[];
  /** A recording that failed to load, so the silence is explained. */
  readonly notice: string | null;
}

/** Whole seconds as m:ss. */
export function formatTime(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

const DEFAULT_TITLES: Readonly<Record<AartiSongId, string>> = Object.fromEntries(
  AARTI_SONG_IDS.map((id) => [id, AARTI_RECORDINGS[id].title]),
) as Record<AartiSongId, string>;

// Click and E are prompted under the crosshair (the puja stays the target); songs are this panel's own.
const PLAYING_HINTS: readonly string[] = ['1–3: Choose a song'];
const PAUSED_HINTS: readonly string[] = ['Click a song to choose it'];

/** The mini player's contents for `aarti`; pure, so the rules test without a DOM. */
export function miniPlayerView(
  aarti: AartiSnapshot,
  options: {
    readonly titles?: Readonly<Record<AartiSongId, string>>;
    readonly paused?: boolean;
    readonly notice?: string | null;
  } = {},
): MiniPlayerView {
  const titles = options.titles ?? DEFAULT_TITLES;
  const duration = aarti.duration > 0 ? aarti.duration : 0;
  const elapsed = Math.min(Math.max(aarti.elapsed, 0), duration);
  return {
    visible: aarti.participating && aarti.state === 'running',
    title: titles[aarti.song],
    progress: duration > 0 ? elapsed / duration : 0,
    time: `${formatTime(elapsed)} / ${formatTime(duration)}`,
    songs: AARTI_SONG_IDS.map((id) => ({
      id,
      title: titles[id],
      key: String(slotForSong(id)),
      current: id === aarti.song,
    })),
    hints: options.paused ? PAUSED_HINTS : PLAYING_HINTS,
    notice: options.notice ?? null,
  };
}

export interface MiniPlayerModelOptions {
  readonly bus: GameEventBus;
  readonly titles?: Readonly<Record<AartiSongId, string>>;
}

/**
 * Renderer-free state of the mini player. The game loop feeds it the
 * ceremony snapshot each frame; the DOM view (`createMiniPlayer`) redraws
 * whenever `revision` changes. It remembers recording failures from
 * `aartiAudioFailed` until that song is tried again.
 */
export class MiniPlayerModel {
  private readonly titles: Readonly<Record<AartiSongId, string>> | undefined;
  private readonly failures = new Map<AartiSongId, string>();
  private readonly unsubscribes: Unsubscribe[];
  private paused = true;
  private aarti: AartiSnapshot | null = null;
  private current: MiniPlayerView | null = null;
  private drawnKey = '';
  private rev = 0;

  constructor(options: MiniPlayerModelOptions) {
    this.titles = options.titles;
    const { bus } = options;
    const retried = ({ song }: { readonly song: AartiSongId }): void => {
      if (this.failures.delete(song)) this.refresh();
    };
    this.unsubscribes = [
      bus.on('aartiAudioFailed', ({ song, message }) => {
        this.failures.set(song, message);
        this.refresh();
      }),
      // Joining or switching retries the recording; a repeat failure reports again.
      bus.on('aartiJoined', retried),
      bus.on('aartiSongChanged', retried),
      bus.on('paused', () => this.setPaused(true)),
      bus.on('resumed', () => this.setPaused(false)),
      bus.on('sessionStarted', () => this.setPaused(false)),
      bus.on('sessionReset', () => {
        this.failures.clear();
        this.refresh();
      }),
    ];
  }

  /** Bumps whenever anything visible changes. */
  get revision(): number {
    return this.rev;
  }

  titleOf(song: AartiSongId): string {
    return (this.titles ?? DEFAULT_TITLES)[song];
  }

  get view(): MiniPlayerView | null {
    return this.current;
  }

  /** Follow the ceremony; call once per rendered frame. */
  setAarti(aarti: AartiSnapshot): void {
    this.aarti = aarti;
    this.refresh();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  private setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.refresh();
  }

  private refresh(): void {
    if (!this.aarti) return;
    const view = miniPlayerView(this.aarti, {
      titles: this.titles,
      paused: this.paused,
      notice: this.failures.get(this.aarti.song) ?? null,
    });
    // Progress is drawn to a tenth of a percent; finer changes are invisible.
    const key = view.visible
      ? [view.title, view.time, view.progress.toFixed(3), view.hints.join(), view.notice ?? ''].join('|')
      : '';
    this.current = view;
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    this.rev++;
  }
}

export interface MiniPlayerElement {
  /** Redraw if the model changed since the last call; cheap otherwise. */
  sync(): void;
  dispose(): void;
}

function style(element: HTMLElement, rules: readonly string[]): void {
  element.style.cssText = rules.join(';');
}

/**
 * DOM view of the mini player, in the top-left corner. While playing, the
 * pointer is locked and songs are chosen with 1–3; while paused, the song
 * buttons take clicks. Those clicks stop at the button: they never reach
 * the canvas or the pause menu, so choosing a song cannot circle the thali,
 * leave aarti or resume the game, and the button gives up focus so a later
 * key cannot press it again.
 */
export function createMiniPlayer(
  parent: HTMLElement,
  model: MiniPlayerModel,
  onSelect: (song: AartiSongId) => void,
): MiniPlayerElement {
  const doc = parent.ownerDocument;
  const root = doc.createElement('div');
  root.className = 'aarti-mini-player';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Aarti songs');
  style(root, [
    'position:fixed',
    'left:16px',
    'top:16px',
    `z-index:${DS.z.floating}`,
    'width:260px',
    'padding:10px 12px',
    'border-radius:8px',
    'background:rgba(11,10,26,0.78)',
    `border:1px solid ${DS.color.borderStrong}`,
    `font-size:${DS.text.sm}`,
    'user-select:none',
    'pointer-events:none',
    'display:none',
  ]);

  const label = doc.createElement('div');
  style(label, [`font-size:${DS.text['2xs']}`, `letter-spacing:${DS.tracking.eyebrow}`, 'text-transform:uppercase', 'opacity:0.7']);
  label.textContent = 'Aarti · now playing';
  const title = doc.createElement('div');
  style(title, ['margin-top:2px', `font-size:${DS.text.md}`, `color:${ACCENT}`]);

  const bar = doc.createElement('div');
  style(bar, ['margin-top:8px', 'height:4px', 'border-radius:2px', 'background:rgba(255,255,255,0.15)', 'overflow:hidden']);
  const fill = doc.createElement('div');
  style(fill, ['height:100%', 'width:0', `background:${ACCENT}`]);
  bar.appendChild(fill);
  const time = doc.createElement('div');
  style(time, ['margin-top:3px', 'font-size:11px', 'opacity:0.7', 'text-align:right', 'font-variant-numeric:tabular-nums']);

  const notice = doc.createElement('div');
  notice.setAttribute('role', 'status');
  style(notice, ['margin-top:6px', `color:${NOTICE}`, `font-size:${DS.text.xs}`]);

  const list = doc.createElement('div');
  style(list, ['margin-top:8px', 'display:flex', 'flex-direction:column', 'gap:4px']);
  const buttons = new Map<AartiSongId, HTMLButtonElement>();
  for (const id of AARTI_SONG_IDS) {
    const button = doc.createElement('button');
    button.type = 'button';
    style(button, [
      'display:flex',
      'gap:8px',
      'align-items:baseline',
      'padding:4px 8px',
      'border-radius:5px',
      'border:1px solid transparent',
      'background:rgba(255,255,255,0.05)',
      'color:inherit',
      'font:inherit',
      'text-align:left',
      'cursor:pointer',
      'pointer-events:auto',
    ]);
    // Keep focus off the button and every press away from the game behind it.
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('mouseup', (event) => event.stopPropagation());
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      button.blur();
      onSelect(id);
    });
    buttons.set(id, button);
    list.appendChild(button);
  }

  const hints = doc.createElement('div');
  style(hints, ['margin-top:8px', 'font-size:11px', 'opacity:0.75', 'line-height:1.5']);

  root.append(label, title, bar, time, notice, list, hints);
  parent.appendChild(root);

  // Song labels are written once; selection, progress and hints change in place.
  for (const id of AARTI_SONG_IDS) {
    const key = doc.createElement('span');
    style(key, ['font-size:11px', 'opacity:0.7']);
    key.textContent = String(slotForSong(id));
    buttons.get(id)!.replaceChildren(key, model.titleOf(id));
  }

  let drawn = -1;
  let drawnHints: readonly string[] = [];
  const sync = (): void => {
    if (model.revision === drawn) return;
    drawn = model.revision;
    const view = model.view;
    root.style.display = view?.visible ? 'block' : 'none';
    if (!view?.visible) return;

    title.textContent = view.title;
    fill.style.width = `${(view.progress * 100).toFixed(1)}%`;
    time.textContent = view.time;
    notice.textContent = view.notice ?? '';
    notice.style.display = view.notice ? 'block' : 'none';
    for (const song of view.songs) {
      const button = buttons.get(song.id)!;
      button.style.borderColor = song.current ? ACCENT : 'transparent';
      button.style.color = song.current ? ACCENT : 'inherit';
      button.setAttribute('aria-pressed', String(song.current));
    }
    if (view.hints !== drawnHints) {
      drawnHints = view.hints;
      hints.replaceChildren(
        ...view.hints.map((text) => {
          const line = doc.createElement('div');
          line.textContent = text;
          return line;
        }),
      );
    }
  };
  sync();

  return {
    sync,
    dispose() {
      root.remove();
    },
  };
}
