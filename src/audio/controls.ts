import type { AudioModule } from '../core/contracts';
import { sectionHeading, slider, toggleSwitch } from '../ui/design/components';

/**
 * DOM glue for the audio module: unlocking on the first player gesture and
 * the pause menu's mute and volume controls. Typed structurally so tests can
 * drive them with plain `EventTarget`s.
 */

const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;
// Capture phase, so gestures that other handlers stop still count.
const LISTEN = { capture: true } as const;

/**
 * Call `audio.unlock()` from the first player gesture on `target` (normally
 * `window`). Listeners stay until audio is actually running, so a gesture
 * that cannot start it (e.g. while paused) is followed by another try.
 * Returns a function that removes the listeners.
 */
export function unlockOnFirstGesture(
  target: EventTarget,
  audio: Pick<AudioModule, 'unlock' | 'unlocked'>,
): () => void {
  const detach = (): void => {
    for (const type of GESTURES) target.removeEventListener(type, onGesture, LISTEN);
  };
  function onGesture(): void {
    if (audio.unlocked) {
      detach();
      return;
    }
    audio
      .unlock()
      .then(() => {
        if (audio.unlocked) detach();
      })
      .catch(() => undefined);
  }
  for (const type of GESTURES) target.addEventListener(type, onGesture, LISTEN);
  return detach;
}

export interface AudioSettings {
  readonly muted: boolean;
  readonly masterGain: number;
  setMuted(muted: boolean): void;
  setMasterGain(gain: number): void;
}

export interface AudioControlInputs {
  /** Checkbox: checked means muted. */
  readonly mute: EventTarget & { checked: boolean };
  /** Range input with values 0–100. */
  readonly volume: EventTarget & { value: string };
}

/** Keep the inputs and the audio settings in step. Returns an unbind function. */
export function bindAudioControls(inputs: AudioControlInputs, audio: AudioSettings): () => void {
  inputs.mute.checked = audio.muted;
  inputs.volume.value = String(Math.round(audio.masterGain * 100));
  const onMute = (): void => audio.setMuted(inputs.mute.checked);
  const onVolume = (): void => {
    const percent = Number(inputs.volume.value);
    if (!Number.isFinite(percent)) return;
    audio.setMasterGain(percent / 100);
    // Raising the volume while muted is a clear request to hear it.
    if (audio.muted && percent > 0) {
      audio.setMuted(false);
      inputs.mute.checked = false;
    }
  };
  inputs.mute.addEventListener('change', onMute);
  inputs.volume.addEventListener('input', onVolume);
  return () => {
    inputs.mute.removeEventListener('change', onMute);
    inputs.volume.removeEventListener('input', onVolume);
  };
}

/**
 * The pause menu's Sound section: a mute switch and a volume slider (0–100)
 * from the design system, under the `audio-controls` class.
 */
export function createAudioControls(doc: Document, audio: AudioSettings): HTMLElement {
  const root = doc.createElement('fieldset');
  root.className = 'audio-controls ds-section';

  const mute = toggleSwitch(doc, 'Mute');
  const volume = slider(doc, 'Volume', { min: 0, max: 100, step: 1, format: (percent) => `${percent}%` });

  root.append(sectionHeading(doc, 'Sound', 'legend'), mute.root, volume.root);
  bindAudioControls({ mute: mute.input, volume: volume.input }, audio);
  // The binding set the value from code, which fires no `input` event.
  volume.refresh();
  return root;
}
