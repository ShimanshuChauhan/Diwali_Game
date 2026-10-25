# Performance

Measured results for issue #19 (PRD → Testing → Performance checks;
Acceptance #8). Goal: at least 30 FPS on Low at 1280 × 720 on an
integrated-graphics laptop, 60 FPS where feasible, and no unbounded growth
in particles, lights, voices or memory.

## Reference laptop

| | |
| --- | --- |
| Machine | Apple MacBook Air (Mac14,2), 2022 |
| Chip | Apple M2: 8-core CPU (4P + 4E), **8-core integrated GPU** |
| Memory | 8 GB unified |
| Display | Built-in 2560 × 1664 Retina, devicePixelRatio 2, 60 Hz |
| OS | macOS 26.5.1 (25F80) |
| Browser | Google Chrome 155.0.8059.86 |
| WebGL | `ANGLE (Apple, ANGLE Metal Renderer: Apple M2)` |
| Power | AC, battery charging |
| Build | `npm run build` + `vite preview` (production bundle) |

FPS is capped at 60 by the display's vsync, so "60" means "never missed a
refresh".

## How to reproduce

```bash
npm run build
npx vite preview          # http://localhost:4173
```

Open `http://localhost:4173/?stress&perf`, then click once anywhere outside
the game canvas so audio can start (browsers need a gesture). The run
needs no further input.

| Query | Default | Meaning |
| --- | --- | --- |
| `stress` | — | Turn the stress test on |
| `levels=low,medium,high` | all three | Profiles to measure, in order |
| `warmup=15` | 15 s | Play before each measurement (caps are full by then) |
| `measure=60` | 60 s | Measurement window per profile |
| `soak=15` | 15 min | Sustained session after the profiles |
| `soakLevel=low` | `low` | Profile held for the soak |
| `viewport=1280x720` | 1280×720 | Fixed canvas size in CSS px; `window` follows the window |
| `perf` | — | Also show the F3 overlay |

Progress and results come from `window.__stress()` in DevTools, and the
final report is also logged to the console as `[stress] done`. The
canvas is pinned to 1280 × 720 CSS pixels whatever the window size, so the
drawing buffer is 960 × 540 on Low (render scale 0.75, DPR capped at 1),
1920 × 1080 on Medium (DPR 1.5) and 2560 × 1440 on High (DPR 2).

**Keep the browser window in front and uncovered.** Chrome on macOS stops
producing frames for an occluded window. Gaps longer than 1 s count as
*stalls*: they're reported but kept out of the timings, and the phase
clocks only advance on rendered time, so a stall pauses the run instead
of skewing it.

### The scripted scenario (`src/perf/stressScenario.ts`)

It goes through the same placement rules and capacity gates as a player:

- Every 0.25 s, place an anar, chakri or ladi on a grid in the lane ahead of
  the spawn until the 12-prop cap refuses, then back off 5 s.
- Every 0.4 s, light the oldest unlit cracker until the 6-lit cap
  refuses, then back off 5 s.
- Every 2 s, place and light a rocket further up the lane.
- Keep a phuljhari lit in hand the whole time.

So the placed, lit and active-effect caps sit at their limits for nearly
the whole run, with a steady stream of rocket bursts and flashes, audio
voices and distant sky fireworks.

## Results (2026-10-24)

### Frame rate per profile at 1280 × 720

60 s each, after a 15 s warm-up with caps already full. Low is from the
first run; Medium and High are from the second, observed run (see
[Runs](#runs)).

| Profile | FPS | p50 | p95 | p99 | Worst | Frames > 33 ms | Stalls excluded |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Low** | **59.5** | 16.75 ms | 17.75 ms | 17.75 ms | 167 ms | 0.3 % | 2 (96 s) |
| Medium | 60.0 | 16.75 ms | 17.75 ms | 17.75 ms | 17.9 ms | 0 % | 0 |
| High | 50.4 | 16.75 ms | 33.5 ms | 34.25 ms | 251 ms | 7.5 % | 0 |

Draw calls 83 and about 20 k triangles on every profile. Low and Medium
hold 60 FPS. High drops some frames to vsync half-rate (33 ms): that's
the 2560 × 1440 buffer with bloom and 2048² shadows.

### Sustained session on Low

| | |
| --- | --- |
| Length | **5 min** of rendered play (300 s) plus 15 s settle, after the Medium and High measurements |
| FPS (whole soak) | 50.1 mean; p50 16.75 ms, p95 33.5 ms, p99 34.5 ms, worst 84 ms |
| FPS per minute | 59.6 · 60.0 · 52.0 · 37.7 · (last ~1 min back at 60 on the overlay) |
| Stalls excluded | 2 (17 s) |

Every minute stayed above 30 FPS. Minutes 3–4 dropped to 52 and 37.7 FPS,
then recovered to 60 FPS on the same profile with the same load. The
counters below show no matching growth, so the dip is **not** resource
growth. Its cause is unconfirmed: the likely candidates are the fanless
Air throttling under sustained GPU load, or other activity on the machine
at the time. See [What's still open](#whats-still-open).

### Resources over the soak (sampled every second)

"Early" is the mean over the second quarter of the soak (the first quarter
is warm-up); "late" is the mean over the last quarter.

| Resource | Min | Max | Budget | Early | Late | Growing? |
| --- | ---: | ---: | ---: | ---: | ---: | :---: |
| Placed props | 7 | 12 | 12 | 10.8 | 10.9 | no |
| Lit crackers | 1 | 6 | 6 | 4.9 | 4.9 | no |
| Active effects | 4 | 6 | 6 | 5.7 | 5.6 | no |
| Particles | 52 | 931 | 4000 | 494 | 483 | no |
| Dynamic lights | 0 | 2 | 2 | 0.2 | 0.2 | no |
| Audio voices | 0 | 12 | 12 | 7.7 | 6.9 | no |
| Distant sky sparks | 0 | 80 | — | 20.5 | 17.5 | no |
| Scene objects | 154 | 154 | — | 154 | 154 | no |
| GPU geometries | 18 | 18 | — | 18 | 18 | no |
| GPU textures | 1 | 1 | — | 1 | 1 | no |
| Shader programs | 40 | 40 | — | 40 | 40 | no |
| JS heap (MB) | 44.8 | 63.2 | — | 45.4 | 45.6 | no |

No peak went above its budget and nothing grew (`bounded: true`). The JS
heap saw-tooths with garbage collection between about 45 and 63 MB, and
its late mean equals its early one.

### Headless soak: 30 minutes (`tests/soak.test.ts`)

The browser soak is only 5 minutes, so the 15–30 minute requirement is
covered headlessly. `npm test` wires every renderer-free gameplay module as
`main.ts` does (crackers, capacity, effects engine, audio engine on a fake
`AudioContext`, neighbours, distant fireworks, interaction rules) and
drives the same scenario for **30 simulated minutes on Low** and 15 on
High. It also tracks the internal bookkeeping maps a leak would show up
in. Low results:

| Resource | Max | Budget | Early | Late |
| --- | ---: | ---: | ---: | ---: |
| Placed props | 12 | 12 | 10.9 | 11.0 |
| Lit crackers | 6 | 6 | 4.7 | 4.7 |
| Active effects | 6 | 6 | 5.6 | 5.6 |
| Particles | 1085 | 4000 | 485 | 492 |
| Dynamic lights | 2 | 2 | 0.28 | 0.29 |
| Audio voices | 12 | 12 | 7.2 | 7.2 |
| Effect handles (per cracker) | 6 | — | 4.7 | 4.7 |
| Voice handles | 12 | — | 8.0 | 8.0 |

The test fails if any metric grows (late mean more than 25 % + 2 above
early, *and* a higher late peak) or breaks its budget.

## Cap tuning

The caps were already well inside the target, so **no caps were changed**:

- Low holds 59.5–60 FPS at 1280 × 720 with every cap full: double the
  30 FPS goal, and at the 60 FPS target.
- The binding limit is the **6 lit crackers** (`TUNING.caps.maxLitCrackers`)
  and Low's **6 active effects**. With them full, particles peak around
  900–1100, a quarter of Low's 4000 budget. The particle budget is
  headroom, not the bottleneck.
- High is the only profile that misses 60 FPS on this laptop (50 FPS, 7.5 %
  of frames at 33 ms). That's acceptable for an opt-in profile; if it
  should hold 60, lower its `maxPixelRatio` from 2 to 1.5 first.

## Runs

1. **First run** (default plan): measured Low, which is the number above.
   Medium and High from this run aren't used: Chrome stalled the
   occluded window for 12–16 s during them. That's how stall handling
   came about.
2. **Second run** (`?stress&levels=medium,high&soak=5&perf`), kept in
   front throughout: measured Medium and High, then the 5-minute Low soak.

## What's still open

- **A 15–30 minute browser soak.** Run `?stress&levels=&soak=30` with the
  window in front for the whole time. The 30-minute headless soak covers
  resource growth, but not GPU-side or browser-side effects over that
  length.
- **The FPS dip in soak minutes 3–4.** Re-run the soak on an idle machine
  (and ideally on battery and on AC) to see if it repeats. If it does
  and resources stay flat, it's thermal; consider Low's render scale or
  the lit cap.
- **Other hardware.** This is one Apple-silicon laptop. An Intel or AMD
  integrated-GPU Windows laptop would be a useful second reference.

## Family-home checkpoint (issue #64)

Checks the complete family-home slice (door transitions, aarti, sweets)
before the neighbour home is measured with the full expansion (#67). Same
reference laptop and browser as above; production bundle via `vite
preview`; the laptop was **on battery** and other work was running on it
(see [Caveats](#caveats)).

### How to reproduce

```bash
npm run build
npx vite preview          # http://localhost:4173
```

Open `http://localhost:4173/?tour&perf` and click once outside the game
canvas so audio (the aarti recording) can start. The run takes about
7½ minutes and needs no further input; keep the window in front.
`window.__tour()` returns progress and the report, which is also logged
as `[tour] done`.

| Query | Default | Meaning |
| --- | --- | --- |
| `tour` | — | Turn the family-home tour on |
| `level=low` | `low` | Profile held for the whole tour |
| `settle=10` | 10 s | Play before each scenario's measurement |
| `measure=60` | 60 s | Measurement window per scenario |
| `trips=25` | 25 | Family-home round trips (two transitions each) |
| `dwell=3` | 3 s | Time on each side of the door per trip |
| `song=10` | 10 s | Seconds between aarti song changes |
| `viewport=1280x720` | 1280×720 | Fixed canvas size in CSS px, as for `?stress` |

### The scripted tour (`src/perf/homesTour.ts`)

It drives the same module commands that E and click reach, on Low:

1. **Outdoors**: the stress scenario above (placed, lit and effect caps
   full, a rocket every 2 s, a lit phuljhari in hand).
2. **Transitions**: 25 round trips through the family-home front door,
   3 s each side, with the outdoor fireworks still going. Resources are
   sampled outdoors after every trip.
3. **Aarti**: phuljhari put away, in through the door, join at the puja
   corner; circle the thali 2.5 s, rest 1 s, change song every 10 s.
   Then circle to the end of the song, which completes the ceremony and
   serves the tray.
4. **Sweets**: at the sweets table, every 0.75 s: eat, eat, take the
   plate, offer it to each of the five family members, put it back.
5. Out through the door.

Steady-state frames are measured per scenario after the settle period.
A **transition** runs from the first frame its fade is drawn until
0.25 s after it ends, so the first frames of the new room count; its
worst frame is its **hitch**, and those frames are kept out of the
steady-state numbers.

The aarti view is first person, facing the shrine with the thali in
view; the sweets view faces the seated family, with subtitles. The
recordings are still the 24 s placeholders (#58).

### Regression found and fixed: first-draw hitches

The first run showed a **67 ms** hitch on the first entry into the
family home, and **133 ms** when going in for aarti. A short diagnostic
run of the same build hit **534 ms** and **217 ms**. All later
transitions were 17–19 ms.

The shader programs were already compiled at boot: no new program
appeared on the first entry. The cost was the **first real draw**. A
draw uploads each object's buffers (geometries went 94 → 152 on the
first entry), and ANGLE's Metal backend builds a pipeline state per
program and vertex layout. `renderer.compile`, the old preload, does
neither. Going in for aarti also drew the thali and the anar placement
ghost for the first time.

Fix: at boot (and again after a quality change, for the new light set),
`drawEverythingOnce` (`src/perf/firstDraw.ts`) **draws each location
once**, the street included. For that one draw, every hidden prop
(thali, plate, bell, ghost, Low-only dressing) is shown and frustum
culling is off; lights keep their state, so the pipelines match what is
really drawn there. After the fix, programs (16), geometries (203) and
textures (1) never change after boot, and the first entry costs the same
as any other (17.7 ms).

An A/B of the outdoor stress at Low (30 s each, same session) showed no
steady-state cost: 60.00 FPS, p99 18.7 ms, no frames over 33 ms, both
with the old `renderer.compile` preload and with the new draw.

### Results (2026-10-25)

Drawing buffer **960 × 540** (1280 × 720 CSS px, Low render scale 0.75,
DPR capped at 1, measured from the canvas). Each scenario is 60 s after a
10 s settle; transitions in their own table.

#### Run 2: after the fix

| Scenario | FPS | Mean | p50 | p95 | p99 | Worst | Frames > 33 ms | Stalls excluded |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Outdoors at caps | 55.1 | 18.15 ms | 16.75 ms | 33.5 ms | 34.0 ms | 66.7 ms | 3.9 % | 1 (6.4 s) |
| Between transitions | 58.2 | 17.18 ms | 16.75 ms | 17.75 ms | 33.5 ms | 183 ms | 1.4 % | 0 |
| Aarti | **60.0** | 16.67 ms | 16.75 ms | 17.5 ms | 17.75 ms | 18.3 ms | 0 % | 0 |
| Sweets | **60.0** | 16.67 ms | 16.75 ms | 17.75 ms | 17.75 ms | 21.5 ms | 0 % | 0 |

| Transitions | Count | Hitch p50 | Hitch p95 | Worst hitch | First family-home entry | Frames > 33 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Run 2 | 52 | 17.75 ms | 34.5 ms | 65.9 ms | **17.7 ms** | 1.1 % |

The outdoor and between-transition dips in run 2 came in one stretch
(transitions 13–18 hitched at 34 ms, at vsync half-rate). The A/B above,
run straight afterwards, held 60.00 FPS outdoors on both builds, so it
is not the fix.

#### Run 3: after the fix, degraded machine

Run straight after run 2 and the A/B, with no code change. Before its
outdoor measurement the window was hidden for 408 s, which is excluded
as a stall.

| Scenario | FPS | Mean | p50 | p95 | p99 | Worst | Frames > 33 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Outdoors at caps | 44.6 | 22.43 ms | 17.25 ms | 34.5 ms | 35.25 ms | 68.5 ms | 17.3 % |
| Between transitions | 48.9 | 20.46 ms | 16.75 ms | 34.0 ms | 35.25 ms | 66.7 ms | 10.9 % |
| Aarti | 47.7 | 20.98 ms | 17.0 ms | 34.25 ms | 35.25 ms | 50.0 ms | 11.5 % |
| Sweets | 56.2 | 17.79 ms | 16.75 ms | 33.0 ms | 34.75 ms | 100 ms | 3.1 % |

52 transitions: hitch p50 35 ms, p95 35.5 ms, worst 116 ms. Resources
stayed identical to run 2 (536 objects, 203 geometries, 1 texture, 16
programs, 80 listeners, 102 DOM nodes, no aarti source).

This run reflects the machine, not the game. The aarti view (29 draw
calls, under 2 k triangles) held a flat 60 in runs 1 and 2, but here it
dropped frames at the same rate as the much heavier street. As a control
afterwards, in the same Chrome window, a blank page doing nothing but
moving one `div` managed **39.8, 47.0 and 56.4 FPS** in three 5 s
windows, with 96, 63 and 19 frames over 25 ms. Even in this state, every
scenario's average stayed above 30 FPS (lowest 44.6).

#### Run 1: before the fix

| Scenario | FPS | p50 | p95 | p99 | Worst | Frames > 33 ms | Stalls excluded |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Outdoors at caps | 60.0 | 16.75 ms | 17.5 ms | 17.75 ms | 34.3 ms | 0.03 % | 1 (3.1 s) |
| Between transitions | 60.0 | 16.75 ms | 17.5 ms | 17.75 ms | 75.4 ms | 0.01 % | 1 (13.8 s) |
| Aarti | 60.0 | 16.75 ms | 17.75 ms | 17.75 ms | 20.3 ms | 0 % | 0 |
| Sweets | 60.0 | 16.75 ms | 17.25 ms | 17.7 ms | 17.7 ms | 0 % | 0 |

52 transitions: hitch p50 17.75 ms, p95 19.25 ms; worst **133 ms**
(going in for aarti); first family-home entry **66.6 ms**.

Every scenario's average stayed above 30 FPS in every run. On an
undisturbed machine (run 1, and aarti and sweets in run 2) every
scenario held 60.

### Resources across 25 round trips (run 2)

Sampled outdoors after each round trip (25 samples, 50 transitions).
"Early" is the mean over the second quarter of the samples, "late" over
the last quarter.

| Resource | Min | Max | Budget | Early | Late | Growing? |
| --- | ---: | ---: | ---: | ---: | ---: | :---: |
| Placed props | 9 | 12 | 12 | 10.8 | 11.0 | no |
| Lit crackers | 3 | 6 | 6 | 4.7 | 4.9 | no |
| Active effects | 4 | 6 | 6 | 5.7 | 5.7 | no |
| Particles | 701 | 3942 | 4000 | 2396 | 2282 | no |
| Dynamic lights | 2 | 2 | 2 | 2 | 2 | no |
| Audio voices | 7 | 12 | 12 | 11.7 | 10.3 | no |
| Distant sky sparks | 0 | 80 | 82 | 27.3 | 14.0 | no |
| Scene objects | 536 | 536 | — | 536 | 536 | no |
| GPU geometries | 203 | 203 | — | 203 | 203 | no |
| GPU textures | 1 | 1 | — | 1 | 1 | no |
| Shader programs | 16 | 16 | — | 16 | 16 | no |
| Aarti audio sources | 0 | 0 | — | 0 | 0 | no |
| Event-bus listeners | 80 | 80 | — | 80 | 80 | no |
| DOM nodes | 102 | 102 | — | 102 | 102 | no |
| JS heap (MB) | 64.0 | 69.5 | — | 69.1 | 65.6 | no |

Nothing grows across the transitions (`bounded: true`). Scene objects,
geometries, textures, programs, listeners and DOM nodes are identical
after every trip. Run 1 was also flat (programs 28, geometries 152,
listeners 80, DOM nodes 102). Its distant-spark count was flagged as
growing, but that was noise: whole sky bursts come and go between
samples taken 7 s apart. The tour now judges distant sparks against
their pool budget instead (82 on Low).

The tour ran with no refused command. It made 52 transitions, joined
aarti once, changed song 7 times and completed the ceremony. At the
sweets table it ate 22 times, took and returned the plate 11 times, and
made 51 offers. One aarti recording played at a time, and none outlived
the ceremony (`aartiSources` 0 after every trip).

### Headless check (`tests/homesTour.test.ts`)

`npm test` runs the same tour headless. The family-home slice is wired as
`main.ts` wires it, scene graph included, with a fake `AudioContext`, and
the test makes 25 round trips plus the aarti and sweets. Across all 52
transitions it checks that:

- scene objects, geometries, materials, interior materials and event-bus
  listeners stay identical;
- no aarti source or decoded recording outlives the ceremony, and at most
  one ever sounds;
- capacity resources stay within budget and don't grow;
- after the whole tour the scene and bus are as they were at boot. The
  one exception is the family's bell: it's built at boot and only joins
  the graph in the ringer's hand at the first aarti.

### Caveats

- **Battery and a shared machine.** All runs were on battery (91 % → 78 %,
  Low Power Mode off), with other work running (load average around 3).
  Run 1 has 60 FPS everywhere; run 2 has one 30 FPS stretch that the A/B
  straight afterwards didn't reproduce; run 3 was degraded throughout,
  matching a blank-page control. A diagnostic run also showed 6.6 s at
  30 FPS in the sweets phase, then recovered by itself. Re-measure on AC
  on an idle machine before quoting a single number.
- **Stalls.** Chrome stops drawing an occluded window. Two runs had a
  3–14 s gap, which is excluded as a stall (see above).
- **Placeholders.** The aarti recordings are 24 s placeholders. Real
  recordings are longer, but play through one source the same way.
- **Not covered here.** The neighbour home's hospitality and a 15–30
  minute browser soak with repeated visits, song switches and
  pause/resume belong to #67.
