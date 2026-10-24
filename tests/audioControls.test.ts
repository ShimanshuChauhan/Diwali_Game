import { describe, expect, it } from 'vitest';
import { bindAudioControls, unlockOnFirstGesture, type AudioSettings } from '../src/audio/controls';

function settings(): AudioSettings & { muted: boolean; masterGain: number } {
  return {
    muted: false,
    masterGain: 0.8,
    setMuted(muted) {
      this.muted = muted;
    },
    setMasterGain(gain) {
      this.masterGain = gain;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('unlockOnFirstGesture', () => {
  it('does nothing until a gesture, then unlocks once', async () => {
    const target = new EventTarget();
    const audio = {
      unlocked: false,
      calls: 0,
      async unlock() {
        this.calls++;
        this.unlocked = true;
      },
    };
    unlockOnFirstGesture(target, audio);
    expect(audio.calls).toBe(0);

    target.dispatchEvent(new Event('keydown'));
    await flush();
    target.dispatchEvent(new Event('pointerdown'));
    await flush();

    expect(audio.calls).toBe(1);
    expect(audio.unlocked).toBe(true);
  });

  it('keeps listening while audio has not started', async () => {
    const target = new EventTarget();
    const audio = {
      unlocked: false,
      calls: 0,
      async unlock() {
        this.calls++;
        if (this.calls === 2) this.unlocked = true;
      },
    };
    unlockOnFirstGesture(target, audio);
    target.dispatchEvent(new Event('pointerdown'));
    await flush();
    target.dispatchEvent(new Event('touchend'));
    await flush();
    target.dispatchEvent(new Event('keydown'));
    await flush();
    expect(audio.calls).toBe(2);
  });

  it('swallows unlock failures', async () => {
    const target = new EventTarget();
    const audio = { unlocked: false, unlock: () => Promise.reject(new Error('nope')) };
    unlockOnFirstGesture(target, audio);
    expect(() => target.dispatchEvent(new Event('keydown'))).not.toThrow();
    await flush();
  });
});

describe('bindAudioControls', () => {
  function inputs() {
    return {
      mute: Object.assign(new EventTarget(), { checked: false }),
      volume: Object.assign(new EventTarget(), { value: '0' }),
    };
  }

  it('shows the current settings', () => {
    const audio = settings();
    audio.muted = true;
    audio.masterGain = 0.25;
    const ui = inputs();
    bindAudioControls(ui, audio);
    expect(ui.mute.checked).toBe(true);
    expect(ui.volume.value).toBe('25');
  });

  it('mute checkbox toggles mute', () => {
    const audio = settings();
    const ui = inputs();
    bindAudioControls(ui, audio);
    ui.mute.checked = true;
    ui.mute.dispatchEvent(new Event('change'));
    expect(audio.muted).toBe(true);
    ui.mute.checked = false;
    ui.mute.dispatchEvent(new Event('change'));
    expect(audio.muted).toBe(false);
  });

  it('volume slider sets master gain and unmutes', () => {
    const audio = settings();
    audio.muted = true;
    const ui = inputs();
    bindAudioControls(ui, audio);
    ui.volume.value = '40';
    ui.volume.dispatchEvent(new Event('input'));
    expect(audio.masterGain).toBeCloseTo(0.4);
    expect(audio.muted).toBe(false);
    expect(ui.mute.checked).toBe(false);
  });

  it('unbinding stops updates', () => {
    const audio = settings();
    const ui = inputs();
    const unbind = bindAudioControls(ui, audio);
    unbind();
    ui.volume.value = '10';
    ui.volume.dispatchEvent(new Event('input'));
    expect(audio.masterGain).toBe(0.8);
  });
});
