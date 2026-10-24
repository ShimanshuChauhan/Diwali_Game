# Aarti recordings: sourcing and licence record

Issue #58 · PRD Story 31, "Audio catalogue and controls", Acceptance #4 and #13.

The ceremony needs recordings of **Om Jai Jagdish Hare**, **Jai Lakshmi Mata**
and **Jai Ganesh Deva**, preferably warm group singing. Any recording we bundle
must carry a grant that permits modification and redistribution, including
commercial use (CC0, CC BY, CC BY-SA, or something just as clear). Reject
noncommercial-only, no-derivatives, unclear and purchase-required material.

## Status (searched 2026-10-24)

| Song | Status | Bundled file |
| --- | --- | --- |
| Om Jai Jagdish Hare | **Gap: no verified recording** | `src/audio/aarti/placeholders/PLACEHOLDER-om-jai-jagdish-hare.wav` |
| Jai Lakshmi Mata | **Gap: no verified recording** | `src/audio/aarti/placeholders/PLACEHOLDER-jai-lakshmi-mata.wav` |
| Jai Ganesh Deva | **Gap: no verified recording** | `src/audio/aarti/placeholders/PLACEHOLDER-jai-ganesh-deva.wav` |

All three songs stay in the catalogue. Each one plays a generated bell pattern
(24 s, 8 kHz mono, about 190 KB) until a real recording is approved. The
pattern is clearly not singing. `scripts/make-aarti-placeholders.mjs`
regenerates the files. `releaseBlockers()` in `src/audio/aarti/recordings.ts`
reports every placeholder, and release acceptance (#68) must find it empty.

The compositions are traditional. Om Jai Jagdish Hare is attributed to Shardha
Ram Phillauri (died 1881). Copyright in the songs themselves has therefore
lapsed. Each *recording* (the performance and the sound recording) is still
protected and needs its own grant.

## Sources searched

- Wikimedia Commons: full-text and MediaSearch audio queries for each title
  (English and Devanagari spellings), plus `Category:Aarti` and
  `Category:Audio files of Hindu music`.
- Internet Archive: title searches limited to audio items, and items
  that mention aarti and carry a Creative Commons `licenseurl`.
- Freesound: `aarti`, `ganesh aarti`, `jagdish` and `lakshmi`.
- General web search for CC-licensed recordings of each title.

## Candidates considered and rejected

| Candidate | Claimed licence | Why rejected |
| --- | --- | --- |
| [archive.org `HindiBhajans-shriHariOmSharanJi`](https://archive.org/details/HindiBhajans-shriHariOmSharanJi): `OmJaiJagdishHare.mp3` (8:17), `AartiLaxmiMaaKi.mp3` (5:01), `GanpatiVandana.mp3` (1:16) | CC0 | A personal account uploaded commercially released Hari Om Sharan albums (73 tracks) and marked them CC0. Nothing shows the uploader holds the rights, so the grant is unverifiable and probably invalid. |
| [Commons `Aarti Puja, Lakshmi Laxmi.ogg`](https://commons.wikimedia.org/wiki/File:Aarti_Puja,_Lakshmi_Laxmi.ogg) and [`Aarti Puja, Ganpati Vandana.ogg`](https://commons.wikimedia.org/wiki/File:Aarti_Puja,_Ganpati_Vandana.ogg) | CC0 | Copied to Commons from the archive.org item above, so they inherit the same unverified claim. Ganpati Vandana is also not Jai Ganesh Deva. |
| [Commons `Aarti.ogg`](https://commons.wikimedia.org/wiki/File:Aarti.ogg) | GFDL | A different aarti (a Swaminarayan aarti by Muktanand Swami). GFDL is also impractical for a bundled game asset. |
| [Jamendo / archive.org `jamendo-336234`](https://archive.org/details/jamendo-336234), Sujay Govindaraj, "Om Jai Jagadish Hare" | CC BY-NC-ND 3.0 | Noncommercial and no-derivatives. |
| archive.org `om_jai_jagdish_hare_aarti_bhakti_songs`, `y2mate…`, `jai-laxmi-mata-aarti-anuradha-paudwal`, `aarti-jai-ganesh-jai-ganesh-deva`, `JaiGaneshJaiGaneshJaiGaneshDevaLordGaneshAarti`, `ganesh_aarti` and similar | none stated | No licence, and mostly rips of commercial releases (for example Anuradha Paudwal / T-Series). |
| archive.org `getmp-3.pro`, "Shankar Singh Thakur" and other `CC BY-ND 4.0` compilations | CC BY-ND 4.0 | No-derivatives. These are also re-uploads from MP3 download sites, so the rights claim is unverifiable. |
| [Freesound 107604](https://freesound.org/people/sonologue/sounds/107604/), sonologue, "sfx-jaiganesh.mp3" (0:28) | Sampling+ 1.0 | Whole-copy redistribution is noncommercial only, and it is only a 28 s loudspeaker fragment. |

## Lead for human review

- [Freesound 338317](https://freesound.org/people/chhavi/sounds/338317/),
  chhavi, "aarti.mp3", 1:49.8, 192 kbps stereo, **CC0 1.0** (stated by the
  uploader, who made the recording). The description reads: "My aunt and her
  friends singing an aarti during Ganesh chathurthi in Mumbai, India, 2015."
  This is exactly the warm group singing we want and the licence is
  acceptable, but the listing doesn't name the aarti. At Ganesh Chaturthi in
  Mumbai it may well be the Marathi *Sukhakarta Dukhaharta* rather than *Jai
  Ganesh Deva*. Before adopting it for Jai Ganesh Deva, someone has to listen
  to confirm which song it is. It's also worth confirming with the uploader
  that the singers agreed to its release. Listening was not possible in this
  environment, so it is **not** adopted.

## Ways to close the gaps

1. Commission or record the three aartis, for example with family or friends.
   Release them as CC0 or CC BY with the performers' written agreement, and
   keep that agreement with this record.
2. Ask a performer or temple group to release an existing recording under
   CC BY. Keep the written grant as licence evidence.
3. Re-run the searches above periodically. New Commons and Freesound
   uploads appear, especially around Diwali.

## Adding an approved recording

1. Encode the file locally (Ogg Vorbis or Opus, roughly 64–96 kbps) and place
   it in `src/audio/aarti/`. No runtime CDN.
2. Change the song's entry in `AARTI_RECORDINGS` to `status: 'approved'`. Fill
   in `provenance` (performer, source URL, rights holder, licence, licence
   evidence URL, attribution) and the file's exact `durationSeconds`.
3. Delete that song's placeholder file and its line in
   `scripts/make-aarti-placeholders.mjs`. The catalogue test fails if any
   bundled audio file is not in the catalogue.
4. Extend the duration check in `tests/aartiRecordings.test.ts` to the new
   format. It currently parses WAV headers only.
5. Add the attribution to `NOTICES.md` and move the row in the table above to
   "approved", with the date it was verified.
