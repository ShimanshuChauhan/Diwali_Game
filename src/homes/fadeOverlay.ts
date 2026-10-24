export interface FadeOverlay {
  /** Opacity in [0, 1]; 0 hides the overlay. Cheap when unchanged. */
  set(opacity: number): void;
  dispose(): void;
}

/**
 * Full-screen black layer for door fades. It never takes pointer events, so
 * clicks still reach the canvas, and is hidden outright while clear. Add it
 * before the pause menu so the menu stays readable over a paused fade.
 */
export function createFadeOverlay(parent: HTMLElement): FadeOverlay {
  const root = parent.ownerDocument.createElement('div');
  root.className = 'door-fade';
  root.style.cssText = [
    'position:fixed',
    'inset:0',
    'background:#000',
    'pointer-events:none',
    'opacity:0',
    'display:none',
  ].join(';');
  parent.appendChild(root);
  let current = 0;

  return {
    set(opacity) {
      const next = Number.isFinite(opacity) ? Math.min(Math.max(opacity, 0), 1) : 0;
      if (next === current) return;
      current = next;
      root.style.opacity = String(next);
      root.style.display = next > 0 ? 'block' : 'none';
    },
    dispose() {
      root.remove();
    },
  };
}
