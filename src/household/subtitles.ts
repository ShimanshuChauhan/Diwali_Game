import type { HouseholdMemberSnapshot, LocationId } from '../core/homes';
import { DS } from '../ui/design/tokens';
import { MEMBER_LABELS } from '../ui/homePrompts';

/** One spoken line as the subtitles show it. */
export interface Subtitle {
  readonly speaker: string;
  readonly text: string;
}

/** Lines being spoken by household members in `location`, in roster order. */
export function subtitlesFor(members: readonly HouseholdMemberSnapshot[], location: LocationId): Subtitle[] {
  const lines: Subtitle[] = [];
  for (const member of members) {
    if (member.home !== location || !member.line) continue;
    lines.push({ speaker: MEMBER_LABELS[member.id], text: member.line.text });
  }
  return lines;
}

export interface SubtitlesView {
  /** Show these lines; cheap when they are unchanged. */
  sync(lines: readonly Subtitle[]): void;
  dispose(): void;
}

/**
 * Hinglish lines from the household, captioned above the HUD's message
 * strip: the speaker's name in gold, then what they say. Plain DOM, readable
 * at every quality level; it never takes pointer events.
 */
export function createSubtitles(parent: HTMLElement): SubtitlesView {
  const doc = parent.ownerDocument;
  const root = doc.createElement('div');
  root.className = 'household-subtitles';
  root.setAttribute('aria-live', 'polite');
  root.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:150px',
    'transform:translateX(-50%)',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'gap:6px',
    'max-width:min(92vw, 720px)',
    'pointer-events:none',
    'user-select:none',
    'font-size:17px',
    'text-align:center',
    // A touch brighter than body text: subtitles sit over the lit scene.
    'color:#fff8ec',
    `text-shadow:${DS.shadow.textHud}`,
  ].join(';');
  parent.appendChild(root);

  let shown = '';
  return {
    sync(lines) {
      const key = lines.map((line) => `${line.speaker}\u0000${line.text}`).join('\u0001');
      if (key === shown) return;
      shown = key;
      root.replaceChildren(
        ...lines.map((line) => {
          const row = doc.createElement('div');
          row.style.cssText = `padding:5px 14px;border-radius:8px;background:${DS.color.surfaceWarm}`;
          const speaker = doc.createElement('span');
          speaker.style.cssText = `color:${DS.color.textAccent};font-weight:${DS.weight.semibold}`;
          speaker.textContent = `${line.speaker}: `;
          row.append(speaker, line.text);
          return row;
        }),
      );
    },
    dispose() {
      root.remove();
    },
  };
}
