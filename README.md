# Diwali Celebration Sandbox

A single-player, browser-based Diwali celebration sandbox: explore a festive
residential lane, light diyas, and set off phuljhari, anar, chakri, rockets and ladis.
See [`PRD.md`](PRD.md) for the full product requirements and the
[issue tracker](https://github.com/ShimanshuChauhan/Diwali_Game/issues) for
the build plan.

## Stack

TypeScript · Vite · Three.js (WebGL) · Rapier (physics/collision) · Vitest.
Client-only — no backend, account, paid API or runtime CDN.

## Requirements

- Node.js 20.19+ (developed on Node 26)
- A current desktop Chromium browser

## Getting started

```bash
npm install
npm run dev        # dev server at http://localhost:5173
```

## Scripts

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Start the Vite dev server                     |
| `npm run build`     | Type-check and build a static site to `dist/` |
| `npm run preview`   | Serve the production build locally            |
| `npm test`          | Run headless rule tests once                  |
| `npm run test:watch`| Run tests in watch mode                       |
| `npm run typecheck` | Type-check only                               |

Performance results, the `?stress` test and the `?tour` family-home checkpoint: [`docs/performance.md`](docs/performance.md).

## Project layout

```
src/
  main.ts        bootstrap: Rapier init, renderer, fixed-step game loop
  core/          loop and shared engine plumbing
  session/       session lifecycle and input mapping
  world/         scenery, colliders, doorway/diya/neighbour data
  player/        movement controller
  camera/        first/third-person camera
  interaction/   nearby objects and placement validation
  crackers/      cracker types and lifecycle
  effects/       pooled particles, trails, flashes
  diyas/         diya lit state
  neighbours/    ambient neighbour behaviour
  audio/         sound effects and ambience
  ui/            HUD, prompts, pause menu
  quality/       Low/Medium/High profiles
  perf/          scripted stress test and resource-growth tracking
tests/           headless Vitest tests
```

Gameplay rule modules must not import the renderer, so they can be tested in
Node without a browser.

## Licence

Project code is released under the [MIT licence](LICENSE). Third-party
dependencies keep their own licences (Three.js: MIT, Rapier: Apache-2.0).
Bundled third-party assets and their credits are listed in [`NOTICES.md`](NOTICES.md).
