/**
 * Catalogue of the aarti recordings the ceremony can play (PRD → Audio
 * catalogue and controls). Each entry pairs one bundled file with the
 * provenance of that same recording, so metadata and playback cannot drift.
 *
 * No recording has been approved yet (issue #58): every song currently
 * points at a generated bell-pattern placeholder that must not ship. The
 * search record and rejected candidates are in docs/aarti-recordings.md.
 */
export type AartiSongId = 'omJaiJagdishHare' | 'jaiLakshmiMata' | 'jaiGaneshDeva';

/** Accompaniment a recording may already contain. */
export type AartiAccompaniment = 'bell' | 'claps';

/**
 * Licences that permit modification and redistribution, including
 * commercially (PRD → Assets and licensing). Noncommercial, no-derivatives
 * and unclear grants are deliberately unrepresentable.
 */
export type AartiLicence = 'CC0-1.0' | 'CC-BY-3.0' | 'CC-BY-4.0' | 'CC-BY-SA-3.0' | 'CC-BY-SA-4.0';

/** Verified provenance; only an approved recording carries one. */
export interface RecordingProvenance {
  readonly performer: string;
  /** Page the file was obtained from. */
  readonly sourceUrl: string;
  readonly rightsHolder: string;
  readonly licence: AartiLicence;
  /** Where the grant is stated by, or on behalf of, the rights holder. */
  readonly licenceEvidenceUrl: string;
  /** Credit text to reproduce in NOTICES.md and the in-game credits. */
  readonly attribution: string;
}

interface RecordingBase {
  readonly id: AartiSongId;
  readonly title: string;
  /** Bundled file name inside this folder, also the asset identity. */
  readonly file: string;
  /** Length of the bundled file, seconds; the ceremony runs this long. */
  readonly durationSeconds: number;
  /** Resolved URL of the bundled file. */
  readonly url: string;
  /**
   * Bell or claps audible in the recording itself, so the family's own
   * bell and clap effects are not layered on top of it.
   */
  readonly includes: readonly AartiAccompaniment[];
}

export interface PlaceholderRecording extends RecordingBase {
  readonly status: 'placeholder';
}

export interface ApprovedRecording extends RecordingBase {
  readonly status: 'approved';
  readonly provenance: RecordingProvenance;
}

export type AartiRecording = PlaceholderRecording | ApprovedRecording;

/** Required songs, in the order the song selector lists them. */
export const AARTI_SONG_IDS: readonly AartiSongId[] = ['omJaiJagdishHare', 'jaiLakshmiMata', 'jaiGaneshDeva'];

/** Length of each generated placeholder, seconds. */
const PLACEHOLDER_SECONDS = 24;
/** The placeholders are a bell pattern. */
const PLACEHOLDER_INCLUDES: readonly AartiAccompaniment[] = ['bell'];

// `new URL(literal, import.meta.url)` lets Vite bundle each file locally.
export const AARTI_RECORDINGS: Readonly<Record<AartiSongId, AartiRecording>> = {
  omJaiJagdishHare: {
    id: 'omJaiJagdishHare',
    title: 'Om Jai Jagdish Hare',
    status: 'placeholder',
    file: 'placeholders/PLACEHOLDER-om-jai-jagdish-hare.wav',
    durationSeconds: PLACEHOLDER_SECONDS,
    includes: PLACEHOLDER_INCLUDES,
    url: new URL('./placeholders/PLACEHOLDER-om-jai-jagdish-hare.wav', import.meta.url).href,
  },
  jaiLakshmiMata: {
    id: 'jaiLakshmiMata',
    title: 'Jai Lakshmi Mata',
    status: 'placeholder',
    file: 'placeholders/PLACEHOLDER-jai-lakshmi-mata.wav',
    durationSeconds: PLACEHOLDER_SECONDS,
    includes: PLACEHOLDER_INCLUDES,
    url: new URL('./placeholders/PLACEHOLDER-jai-lakshmi-mata.wav', import.meta.url).href,
  },
  jaiGaneshDeva: {
    id: 'jaiGaneshDeva',
    title: 'Jai Ganesh Deva',
    status: 'placeholder',
    file: 'placeholders/PLACEHOLDER-jai-ganesh-deva.wav',
    durationSeconds: PLACEHOLDER_SECONDS,
    includes: PLACEHOLDER_INCLUDES,
    url: new URL('./placeholders/PLACEHOLDER-jai-ganesh-deva.wav', import.meta.url).href,
  },
};

/** Recordings in selector order. */
export function aartiRecordings(
  catalogue: Readonly<Record<AartiSongId, AartiRecording>> = AARTI_RECORDINGS,
): AartiRecording[] {
  return AARTI_SONG_IDS.map((id) => catalogue[id]);
}

/**
 * Reasons the catalogue cannot ship; empty once every song has an approved,
 * fully attributed recording. Release acceptance (#68) gates on this.
 */
export function releaseBlockers(
  catalogue: Readonly<Record<AartiSongId, AartiRecording>> = AARTI_RECORDINGS,
): string[] {
  const blockers: string[] = [];
  for (const recording of aartiRecordings(catalogue)) {
    if (recording.status === 'placeholder') {
      blockers.push(`${recording.title}: placeholder audio, no verified recording`);
      continue;
    }
    const p = recording.provenance;
    const missing: string[] = (['performer', 'rightsHolder', 'attribution'] as const).filter((k) => !p[k].trim());
    if (!isHttpsUrl(p.sourceUrl)) missing.push('sourceUrl');
    if (!isHttpsUrl(p.licenceEvidenceUrl)) missing.push('licenceEvidenceUrl');
    if (missing.length > 0) blockers.push(`${recording.title}: missing ${missing.join(', ')}`);
    if (recording.file.includes('PLACEHOLDER')) blockers.push(`${recording.title}: approved entry points at a placeholder file`);
  }
  return blockers;
}

function isHttpsUrl(value: string): boolean {
  return /^https:\/\/\S+$/.test(value);
}
