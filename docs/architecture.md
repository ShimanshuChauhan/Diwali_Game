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
| `homes.ts`      | Homes expansion: location/song/member ids, rejection reasons, module interfaces |
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
                 ├─ door/puja/tray/person/returnSpot ─▶ applyHomeAction() (homes expansion)
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

## Homes expansion

The Family and Neighbour Homes expansion ([#51](https://github.com/ShimanshuChauhan/Diwali_Game/issues/51))
adds two enterable homes, a once-per-session aarti, sweets and a gift round
trip. Its contracts live in `src/core/homes.ts`, its events in `events.ts`
and its tuning under `TUNING.homes`; the modules below are built against
them in later issues.

| Module                     | Interface                     | Owns                                               | Renderer? |
| -------------------------- | ----------------------------- | -------------------------------------------------- | --------- |
| Locations & transitions    | `LocationsModule`             | Active location, doorways, arrival poses, the door fade | No    |
| Aarti ceremony             | `AartiCeremonyModule`         | `waiting → running → completed`, participation, song, elapsed time, thali circling, `playbackId` | No |
| Recorded aarti audio       | `AartiAudioModule`            | Recording catalogue (licence, attribution, duration), loading, one playback source | Web Audio |
| Household & dialogue       | `HouseholdModule`             | Family and uncle/aunty identities, activities, Hinglish lines and gestures, cooldowns | No |
| Held items & sweets        | `HeldItemsModule`             | Exclusive hand occupancy, tray, plate, eating, offering, cracker gating | No |
| Gift exchange              | `GiftExchangeModule`          | Box places, the one-time exchange, the one-time home acknowledgement | No |
| Interior presentation      | `InteriorPresentationModule`  | Rooms, furniture, figures, warm light, the fade overlay; active location only | Yes |

Ownership rules:

- **Time** is the ceremony's (`src/aarti/ceremony.ts`): it advances in
  `update(dt)` on the fixed step, which stops while paused, so song,
  ceremony and family freeze together. Audio follows `AartiSnapshot`
  (playing only while `participating`) and never drives the clock; it may
  only report the current recording's natural end (`playbackEnded`), and
  callbacks tagged with an old `playbackId` are ignored.
- **Hands** are `HeldItemsModule`'s (`src/homes/heldItems.ts`): the
  ceremony `reserveThali`s, gift exchange `take`s boxes, `returnTo`s them
  to their designated spots and `deliver`s them (swapping outbound for
  return in one step), and the cracker controls ask `crackerBlock()` before
  select, place, ignite and held ignition, emitting `crackerBlocked`.
  Taking an item puts an unlit phuljhari away (`Crackers.putAway`) and
  brings it back once the hands are free; a lit one refuses the item.
- **Location** is `LocationsModule`'s (`src/homes/locations.ts`, doors in
  `doorways.ts`): one fade at a time, `controlsLocked` while it runs (the
  loop drops actions failing `allowedDuringFade` and zeroes movement), the
  player moved through `onArrive` at the midpoint. A carried plate blocks
  leaving the family home; gift boxes pass. Crackers and capacity keep
  stepping wherever the player is, so outdoor lifecycles carry on.
- **Gift progression** is `GiftExchangeModule`'s. It listens for
  `aartiCompleted` to release a pending acknowledgement.
- Household state progresses whether or not its home is the active
  location; only presentation is location-gated.

```
E at door ─▶ LocationsModule.requestTransition ─┬─ ok ─▶ transitionStarted ─▶ (fade) ─▶ locationChanged
                                                └─ no ─▶ transitionRejected (carryingPlate, transitionInProgress, …)
E at puja ─▶ AartiCeremonyModule.join ─▶ HeldItemsModule.take(thali) ─▶ aartiJoined ─▶ AartiAudioModule.sync
hold/release ─▶ setCircling        song pick ─▶ selectSong ─▶ aartiSongChanged
fixed step ─▶ ceremony.update(dt) ─▶ aartiCompleted ─┬▶ Household (seats, serve tray)
                                                     ├▶ HeldItems (trayServed, thali released)
                                                     └▶ GiftExchange (pending → giftAcknowledged)
E at tray/person ─▶ HeldItemsModule.pickUpPlate/eat/offer ─▶ sweetsEaten / sweetsOffered ─▶ Household.react
E at neighbour ─▶ GiftExchangeModule.exchange ─▶ giftExchanged (return box now in hand)
```

| Event                                   | Published by    | Typical subscribers                 |
| --------------------------------------- | --------------- | ----------------------------------- |
| `transitionStarted` / `locationChanged` | Locations       | Interior presentation, player, camera, audio, UI |
| `transitionRejected`                    | Locations       | UI                                  |
| `aartiJoined` / `aartiLeft` / `aartiSongChanged` | Ceremony | Aarti audio, household, UI (mini player) |
| `aartiCompleted`                        | Ceremony        | Household, held items, gift exchange, aarti audio |
| `aartiRejected`                         | Ceremony        | UI                                  |
| `itemPickedUp` / `itemReturned` / `itemDelivered` | Held items | Presentation, UI          |
| `itemRejected`                          | Held items      | UI                                  |
| `crackerBlocked`                        | Cracker controls | UI (return-or-deliver prompt)      |
| `sweetsEaten` / `sweetsOffered`         | Held items      | Household                           |
| `giftExchanged` / `giftPlaced` / `giftAcknowledged` | Gift exchange | Household, presentation, UI |
| `giftRejected`                          | Gift exchange   | UI                                  |
| `householdReacted`                      | Household       | UI (Hinglish text), presentation (gesture) |

**Fresh sessions** clear all expansion state. `src/homes/reset.ts` lists
every stateful module (`HOMES_STATEFUL_MODULES`) and `main.ts` registers a
reset hook for each with the session. Unbuilt modules use a `PendingReset`
stub; a module replaces its stub by passing itself to `homesResetHooks()`.

## Tuning and quality

Gameplay numbers live in `TUNING`, budgets that vary with hardware live in
`QualityProfile`. Rule modules should accept them as constructor options
(defaulting to `TUNING`) so tests can pin values. All current values are
placeholders pending play-testing and measurement on the reference laptop.
