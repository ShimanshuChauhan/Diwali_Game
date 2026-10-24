import type { AudioModule } from '../core/contracts';

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

/** A ready-made mute checkbox and volume slider for the pause menu. */
export function createAudioControls(doc: Document, audio: AudioSettings): HTMLElement {
  const root = doc.createElement('fieldset');
  root.className = 'audio-controls';
  const legend = doc.createElement('legend');
  legend.textContent = 'Sound';

  const mute = doc.createElement('input');
  mute.type = 'checkbox';
  const muteLabel = doc.createElement('label');
  muteLabel.append(mute, ' Mute');

  const volume = doc.createElement('input');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '100';
  volume.step = '1';
  const volumeLabel = doc.createElement('label');
  volumeLabel.append('Volume ', volume);

  root.append(legend, muteLabel, volumeLabel);
  bindAudioControls({ mute, volume }, audio);
  return root;
}
