import { BALTI, BaltiBlast } from '../balti/baltiBlast';
import { createGameEventBus } from '../core/events';
import { TUNING } from '../core/tuning';
import type { BurstPattern, CrackerType } from '../core/types';
import { CRACKER_DEFINITIONS } from '../crackers/definitions';
import { rollLadiChain } from '../crackers/ladi';
import { BURST_PATTERNS } from '../effects/presets';
import { AudioEngine } from './audioEngine';

/**
 * Sound board for auditioning the synthesised sounds (open the app with
 * `?sounds`). It drives its own audio engine on its own bus, so it works
 * without starting the game: each button plays what the game would for that
 * cracker, a few metres in front of the listener.
 */

const IN_FRONT = { x: 0, y: 0, z: -4 } as const;
const SKY = { x: 4, y: 30, z: -20 } as const;

export function createSoundBoard(parent: HTMLElement): () => void {
  const bus = createGameEventBus();
  const audio = new AudioEngine({ bus });
  audio.setListener({
    mode: 'firstPerson',
    position: { x: 0, y: 1.6, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    yaw: 0,
    pitch: 0,
  });
  const { fuse, activeDuration } = TUNING.crackers;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let next = 0;
  const later = (seconds: number, run: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, seconds * 1000);
    timers.add(timer);
  };

  const burnCracker = (type: CrackerType): void => {
    const id = `board-${next++}`;
    const position = type === 'phuljhari' ? { x: 0.3, y: 1.2, z: -0.5 } : IN_FRONT;
    bus.emit('crackerActive', { id, type, position });
    later(activeDuration[type], () => bus.emit('crackerFinished', { id, type, reason: 'completed' }));
  };

  /** The player's own ladi: its pops on the game's timing, from the string's near end outwards. */
  const burnLadi = (): void => {
    const id = `board-${next++}`;
    const chain = rollLadiChain(CRACKER_DEFINITIONS.ladi, Math.random);
    bus.emit('crackerActive', { id, type: 'ladi', position: IN_FRONT, ladi: { chain, heading: 0 } });
    chain.pops.forEach((pop, index) => {
      const position = { x: IN_FRONT.x, y: IN_FRONT.y, z: IN_FRONT.z + 0.4 - (0.8 * index) / chain.pops.length };
      later(pop.time, () => bus.emit('ladiPop', { id, index, banger: pop.banger, position, loud: pop.loud }));
    });
    later(chain.duration, () => bus.emit('crackerFinished', { id, type: 'ladi', reason: 'completed' }));
  };

  const launchRocket = (pattern: BurstPattern): void => {
    const id = `board-${next++}`;
    const flight = { ascent: activeDuration.rocket, apexHeight: 30, drift: { x: 3, z: -4 } };
    bus.emit('crackerActive', { id, type: 'rocket', position: IN_FRONT, flight });
    later(flight.ascent, () => {
      const position = { x: IN_FRONT.x + flight.drift.x, y: flight.apexHeight, z: IN_FRONT.z + flight.drift.z };
      bus.emit('burst', { id, position, pattern, colours: [0xffd34f] });
      bus.emit('crackerFinished', { id, type: 'rocket', reason: 'completed' });
    });
  };

  /** A whole balti round set off six metres in front, on the game's own timing. */
  const baltiRound = (): void => {
    const spot = { x: 0, y: 0, z: -6 };
    const feet = { x: 0, y: 0, z: -5 };
    const forward = { x: 0, y: 0, z: -1 };
    const round = new BaltiBlast({ spot, bus, playerPosition: () => feet });
    round.playerStep(feet, forward);
    round.playerStep(feet, forward);
    later(BALTI.coverTime, () => {
      round.playerStep(feet, forward);
      const timer = setInterval(() => {
        round.update(1 / 60);
        if (round.phase !== 'cheering') return;
        clearInterval(timer);
        round.dispose();
      }, 1000 / 60);
    });
  };

  const actions: [string, () => void][] = [
    ['Fuse', () => bus.emit('fuseLit', { id: `board-${next++}`, type: 'anar', position: IN_FRONT })],
    ['Phuljhari', () => burnCracker('phuljhari')],
    ['Anar', () => burnCracker('anar')],
    ['Chakri', () => burnCracker('chakri')],
    ['Ladi, at your feet', burnLadi],
    ['Rocket → peony', () => launchRocket('peony')],
    ['Balti blast', baltiRound],
    ...BURST_PATTERNS.map((pattern): [string, () => void] => [
      `Burst: ${pattern}`,
      () => bus.emit('burst', { id: `board-${next++}`, position: SKY, pattern, colours: [0xffd34f] }),
    ]),
    ['Rocket, near', () => audio.playAmbient({ kind: 'rocket', azimuth: 0.9, distance: 60, intensity: 1, duration: 1.8 })],
    ['Rocket, far', () => audio.playAmbient({ kind: 'rocket', azimuth: 3.5, distance: 260, intensity: 1, duration: 2.2 })],
    ['Anar, down the street', () => audio.playAmbient({ kind: 'anar', azimuth: 1.6, distance: 50, intensity: 1, duration: 6 })],
    ['Chakri, down the street', () => audio.playAmbient({ kind: 'chakri', azimuth: 4.4, distance: 40, intensity: 1, duration: 5 })],
    ['Bomb, near', () => audio.playAmbient({ kind: 'bomb', azimuth: 0.6, distance: 50, intensity: 1, duration: 0 })],
    ['Bomb, far', () => audio.playAmbient({ kind: 'bomb', azimuth: 4, distance: 200, intensity: 1, duration: 0 })],
    ['Ladi', () => audio.playAmbient({ kind: 'ladi', azimuth: 2.2, distance: 90, intensity: 1, duration: 3.5 })],
    ['Far pops', () => audio.playAmbient({ kind: 'pop', azimuth: 5, distance: 300, intensity: 1, duration: 0 })],
    ['Shell over town', () => bus.emit('distantBurst', { position: { x: 90, y: 50, z: -110 } })],
    ['Stop all', () => audio.reset()],
  ];

  const panel = parent.ownerDocument.createElement('div');
  panel.style.cssText = [
    'position:fixed',
    'top:16px',
    'left:16px',
    'z-index:1000',
    'display:grid',
    'grid-template-columns:repeat(2,minmax(0,1fr))',
    'gap:6px',
    'padding:12px',
    'max-width:320px',
    'border-radius:8px',
    'background:rgba(11,10,26,0.9)',
    'font:13px system-ui,sans-serif',
  ].join(';');
  const title = parent.ownerDocument.createElement('div');
  title.textContent = `Sound board · fuse ${fuse.anar}s`;
  title.style.cssText = 'grid-column:1/-1;color:#ffcf70;font-weight:600';
  panel.appendChild(title);
  for (const [label, run] of actions) {
    const button = parent.ownerDocument.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = 'padding:6px 8px;border-radius:6px;border:1px solid #6b5a3a;background:#241c2e;color:#f6e7c8;cursor:pointer';
    button.addEventListener('click', (event) => {
      // Keep the click from reaching the game's start screen.
      event.stopPropagation();
      void audio.unlock().then(run);
    });
    panel.appendChild(button);
  }
  parent.appendChild(panel);

  return () => {
    for (const timer of timers) clearTimeout(timer);
    audio.dispose();
    panel.remove();
  };
}
