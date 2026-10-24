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

- Every 0.25 s, place an anar or chakri on a grid in the lane ahead of
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
