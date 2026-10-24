# Architecture

How the prototype's modules fit together. The module list comes from
[`PRD.md`](../PRD.md) → Implementation Decisions → Modules; the contracts
live in [`src/core/`](../src/core).

## Shared contracts (`src/core/`)

| File            | What it defines                                                      |
| --------------- | -------------------------------------------------------------------- |
| `types.ts`      | Plain value types: `Vec3`, ids, `CrackerType`, `CameraMode`, rejection reasons |
| `actions.ts`    | `GameAction` union produced by input; slot → cracker mapping          |
| `eventBus.ts`   | Generic typed `EventBus` (`on`/`once`/`off`/`emit`/`clear`)            |
| `events.ts`     | `GameEvents` map — every game-wide event and its payload               |
| `contracts.ts`  | One interface per module (`CrackersModule`, `WorldModule`, …)         |
| `tuning.ts`     | `TUNING`: clearances, fuse lengths, caps, speeds (placeholders)        |
| `quality.ts`    | `QualityProfile` and the Low/Medium/High `QUALITY_PROFILES`            |
| `fixedStep.ts`  | Fixed-timestep accumulator for the game loop                          |

Everything above is plain TypeScript with no Three.js or Rapier imports
(enforced by `tests/coreConfig.test.ts`). `eveningScene.ts` is the only
rendering file in `core/` and is temporary scaffolding.

## Module ownership

Each module owns its folder under `src/`, its state, and the interface of
the same name in `contracts.ts`. Other modules reach it only through that
interface or through events.

| Module (folder)            | Interface                     | Owns                                               | Renderer? |
| -------------------------- | ----------------------------- | -------------------------------------------------- | --------- |
| Session & input (`session/`) | `SessionModule`, `InputModule` | Start/reset/pause; keyboard+mouse → `GameAction` | No (DOM only at the edge) |
| World (`world/`)           | `WorldModule`                 | Scenery, colliders, doorways, diya sites, neighbour areas | Yes, behind queries |
| Player (`player/`)         | `PlayerModule`                | Walk/run, stairs, grounding → `PlayerPose`        | No (Rapier) |
| Camera (`camera/`)         | `CameraModule`                | Yaw/pitch, first/third-person `CameraView`        | View only  |
| Interaction (`interaction/`) | `InteractionModule`         | Nearby interactables, placement validation        | No         |
| Crackers (`crackers/`)     | `CrackersModule`              | Selection, lifecycle `placed → fuseBurning → active → finished`, held phuljhari, caps | No |
| Capacity (`capacity/`)     | `CrackerAdmission` (`CapacityBudget`) | Budgets for props, lit crackers, effects, particles, lights, voices; admission, unlit-prop reclamation, overlay counters | No |
| Effects (`effects/`)       | `EffectsModule`               | Pooled particles, trails, flashes; effect budgets | Yes        |
| Diyas (`diyas/`)           | `DiyasModule`                 | Session-local lit state                           | No (visuals react to `diyaLit`) |
| Neighbours (`neighbours/`) | `NeighboursModule`            | Ambient behaviour, reactions, live positions      | Logic no; meshes yes |
| Audio (`audio/`)           | `AudioModule`                 | Gain, mute, voices, spatial playback              | Web Audio  |
| UI (`ui/`)                 | `UiModule`                    | HUD, prompts, rejection feedback, pause menu      | DOM        |
| Quality (`quality/`)       | `QualityModule`               | Active `QualityProfile`                           | No         |

**Rule modules** — session logic, interaction, crackers, diyas, neighbour
logic, quality — must not import `three`. Where they need geometry they ask
`WorldModule` (whose implementation may use Rapier) through plain-data
queries, so tests can pass a fake world.

## Data flow per frame

```
DOM events ─▶ InputModule.drainActions() ─▶ GameAction[]
                                             │
   move/run/look ───────────────▶ PlayerModule.move() ─▶ PlayerPose
                                 CameraModule.look()/update(pose) ─▶ CameraView
   select ──────────────────────▶ CrackersModule.select()
   place ─▶ InteractionModule.validatePlacement() ─┬─ ok ─▶ CrackersModule.place()
                                                   └─ no ─▶ placementRejected
   interact ─▶ InteractionModule.findInteractable(view)
                 ├─ cracker ─▶ CrackersModule.ignite(id)
                 └─ diya    ─▶ DiyasModule.light(id)
   toggleCamera ────────────────▶ CameraModule.toggleMode()
   pause ───────────────────────▶ SessionModule.pause('user')

Fixed step: CrackersModule / NeighboursModule / EffectsModule .update(dt)
```

Rule modules publish on the shared `GameEventBus`; presentation modules
subscribe:

| Event                | Published by | Typical subscribers            |
| -------------------- | ------------ | ------------------------------ |
| `crackerSelected`    | Crackers     | UI                             |
| `crackerPlaced`      | Crackers     | Effects (prop), Audio          |
| `placementRejected`  | Crackers / interaction | UI                   |
| `fuseLit`            | Crackers     | Effects, Audio                 |
| `ignitionRejected`   | Crackers     | UI                             |
| `crackerActive`      | Crackers     | Effects, Audio, Neighbours     |
| `burst`              | Crackers     | Effects, Audio, Neighbours     |
| `crackerFinished`    | Crackers     | Effects (cleanup), UI          |
| `diyaLit`            | Diyas        | World/visuals, Audio           |
| `neighbourReacted`   | Neighbours   | Audio                          |
| `qualityChanged`     | Quality      | Renderer, Effects, Audio       |
| `cameraModeChanged`  | Camera       | UI, player model visibility    |
| `paused` / `resumed` | Session      | Input, Audio, UI               |
| `sessionStarted` / `sessionReset` | Session | every `Resettable` module |

Listeners run synchronously; keep them cheap and never emit an event from
its own listener in a way that recurses.

## Tuning and quality

Gameplay numbers live in `TUNING`, budgets that vary with hardware live in
`QualityProfile`. Rule modules should accept them as constructor options
(defaulting to `TUNING`) so tests can pin values. All current values are
placeholders pending play-testing and measurement on the reference laptop.
