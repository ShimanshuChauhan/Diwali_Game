import { describe, expect, it } from 'vitest';
import {
  AARTI_RECORDINGS,
  AARTI_SONG_IDS,
  type AartiRecording,
  type AartiSongId,
  type ApprovedRecording,
  aartiRecordings,
  releaseBlockers,
} from '../src/audio/aarti/recordings';

const AARTI_DIR = new URL('../src/audio/aarti/', import.meta.url);

// Bundled audio as data URLs, keyed by path relative to the aarti folder.
const BUNDLED: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../src/audio/aarti/**/*.wav', { query: '?inline', import: 'default', eager: true }),
  ).map(([path, dataUrl]) => [path.replace('../src/audio/aarti/', ''), dataUrl]),
);

function bundledBytes(file: string): DataView {
  const dataUrl = BUNDLED[file];
  if (!dataUrl) throw new Error(`${file} is not bundled`);
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  return new DataView(Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer);
}

const fourCC = (view: DataView, offset: number) =>
  String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(offset + i)));

/** Duration of a PCM WAV file from its header, seconds. */
function wavSeconds(view: DataView): number {
  expect(fourCC(view, 0)).toBe('RIFF');
  expect(fourCC(view, 8)).toBe('WAVE');
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= view.byteLength) {
    const id = fourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') byteRate = view.getUint32(offset + 16, true);
    if (id === 'data') return size / byteRate;
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

const approved = (overrides: Partial<ApprovedRecording['provenance']> = {}): ApprovedRecording => ({
  id: 'jaiGaneshDeva',
  title: 'Jai Ganesh Deva',
  status: 'approved',
  file: 'jai-ganesh-deva.ogg',
  durationSeconds: 300,
  url: 'jai-ganesh-deva.ogg',
  provenance: {
    performer: 'A family choir',
    sourceUrl: 'https://example.org/recording',
    rightsHolder: 'A family choir',
    licence: 'CC-BY-4.0',
    licenceEvidenceUrl: 'https://example.org/recording#licence',
    attribution: '"Jai Ganesh Deva" by A family choir, CC BY 4.0',
    ...overrides,
  },
});

const withGanesh = (recording: AartiRecording): Record<AartiSongId, AartiRecording> => ({
  ...AARTI_RECORDINGS,
  jaiGaneshDeva: recording,
});

describe('aarti recording catalogue', () => {
  it('lists the three requested songs in selector order', () => {
    expect(aartiRecordings().map((r) => r.title)).toEqual([
      'Om Jai Jagdish Hare',
      'Jai Lakshmi Mata',
      'Jai Ganesh Deva',
    ]);
    for (const id of AARTI_SONG_IDS) expect(AARTI_RECORDINGS[id].id).toBe(id);
  });

  it('gives every song its own bundled file', () => {
    const files = aartiRecordings().map((r) => r.file);
    expect(new Set(files).size).toBe(files.length);
    // Nothing stray is bundled: every audio file in the folder is catalogued.
    expect(Object.keys(BUNDLED).sort()).toEqual([...files].sort());
  });

  it('records the real length of each bundled file', () => {
    for (const recording of aartiRecordings()) {
      expect(wavSeconds(bundledBytes(recording.file))).toBeCloseTo(recording.durationSeconds, 2);
    }
  });

  it('resolves each url to its catalogued file', () => {
    for (const recording of aartiRecordings()) {
      expect(recording.url).toBe(new URL(recording.file, AARTI_DIR).href);
    }
  });

  it('marks placeholders clearly and claims no provenance for them', () => {
    for (const recording of aartiRecordings()) {
      if (recording.status !== 'placeholder') continue;
      expect(recording.file).toMatch(/\/PLACEHOLDER-/);
      expect(recording).not.toHaveProperty('provenance');
    }
  });
});

describe('releaseBlockers', () => {
  it('blocks release while any song uses placeholder audio', () => {
    const blockers = releaseBlockers();
    expect(blockers).toHaveLength(3);
    expect(blockers[0]).toContain('Om Jai Jagdish Hare');
  });

  it('reports only the songs still missing a recording', () => {
    const blockers = releaseBlockers(withGanesh(approved()));
    expect(blockers).toHaveLength(2);
    expect(blockers.join()).not.toContain('Jai Ganesh Deva');
  });

  it('is clear once every song has a fully attributed recording', () => {
    const catalogue = Object.fromEntries(
      AARTI_SONG_IDS.map((id) => [id, { ...approved(), id, title: id, file: `${id}.ogg` }]),
    ) as Record<AartiSongId, AartiRecording>;
    expect(releaseBlockers(catalogue)).toEqual([]);
  });

  it('rejects an approved recording with incomplete provenance', () => {
    const blockers = releaseBlockers(withGanesh(approved({ attribution: ' ', licenceEvidenceUrl: 'see email' })));
    expect(blockers).toContain('Jai Ganesh Deva: missing attribution, licenceEvidenceUrl');
  });

  it('rejects an approved entry that still points at a placeholder file', () => {
    const blockers = releaseBlockers(withGanesh({ ...approved(), file: 'placeholders/PLACEHOLDER-jai-ganesh-deva.wav' }));
    expect(blockers).toContain('Jai Ganesh Deva: approved entry points at a placeholder file');
  });
});
