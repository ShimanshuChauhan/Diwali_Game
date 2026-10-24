# Diwali Celebration Sandbox Playable Prototype

## Problem Statement

Players want to experience the warmth, sound, and spectacle of Diwali in a neighbourhood they can freely explore. The central appeal is feeling present in a festive residential lane and personally lighting diyas and crackers, especially watching large, colourful fireworks overhead.

The first playable prototype must establish whether movement, camera control, cracker handling, and repeated fireworks are enjoyable on ordinary laptops before investing in a detailed neighbourhood or additional activities.

## Solution

Create a single-player, browser-based celebration sandbox with a finite, freely explorable street, courtyard, and one accessible rooftop. Use a stylised, atmospheric visual direction: colourful homes with balconies, warm diya light, neighbours celebrating, distant crackers, and striking sky patterns.

The experience is open-ended. Players choose their own activities, have unlimited cracker supplies, and begin with a fresh world on every visit. There are no missions, completion goals, finale, injuries, or destruction.

Deliver a compact playable prototype first. Use simple original scenery and characters to validate the interactions; polish and suitable open-source asset packs can follow. The prototype should contain enough light, sound, and ambient neighbour activity to assess the Diwali atmosphere.

## User Stories

1. As a player, I want to enter the game from a desktop or laptop browser, so that I can play without installing a game client.
2. As a player, I want to walk and run around a finite residential lane and courtyard, so that I can freely explore the celebration.
3. As a player, I want to use stairs to reach one rooftop, so that I can enjoy another view of the neighbourhood and sky.
4. As a player, I want first-person view by default and a switch to third-person view, so that I can choose an immersive or character-focused perspective.
5. As a player, I want one preset character in festive clothing, so that third-person roaming fits the setting.
6. As a player, I want to select phuljhari, anar, chakri, or rocket without earning or buying supplies, so that I can experiment freely.
7. As a player, I want a placement preview and clear feedback, so that I understand where ground crackers can be placed.
8. As a player, I want to place a cracker and then light its fuse separately, so that I can step back and watch it activate.
9. As a player, I want to hold and light a phuljhari directly, so that it behaves like a handheld sparkler.
10. As a player, I want several crackers to run simultaneously, so that I can combine effects.
11. As a player, I want different cracker types to have distinct motion, sound, and light, so that experimenting stays rewarding.
12. As a player, I want rockets to produce large, varied, colourful sky patterns, so that fireworks deliver the main wow moment.
13. As a player, I want bursts to briefly illuminate nearby houses and have spatial sound, so that the spectacle feels present in the world.
14. As a player, I want to light existing diyas outside homes, so that I can contribute to the neighbourhood's atmosphere.
15. As a player, I want ambient neighbours who watch fireworks and occasionally cheer, so that the street feels inhabited.
16. As a player, I want placement rules that keep crackers away from neighbours and doorways, so that the celebration stays relaxed.
17. As a player on integrated graphics, I want quality settings and bounded simultaneous effects, so that I can balance spectacle and smooth play.
18. As a player, I want to leave and return to a fresh celebration, so that no account or saved progress is required.
19. As the project owner, I want open-source dependencies and assets with no purchase requirements, so that building and running the prototype does not require paid products or services.

## Implementation Decisions

### Modules

Each module owns its state and exposes a small contract. Rendering details should remain separate from gameplay rules, allowing placement, lifecycle, and capacity decisions to be tested without a browser renderer.

| Module | Responsibility and contract |
| --- | --- |
| Session and input | Starts and resets a session; converts keyboard and mouse input into gameplay actions; releases controls when paused or focus is lost. |
| World | Supplies static scenery, collision geometry, traversable surfaces, doorway exclusions, diya locations, and neighbour exclusion areas. |
| Player movement | Consumes movement intent and elapsed time; returns the player's collision-resolved position and facing. Owns walking, running, stairs, and grounding. |
| Camera | Consumes player pose, mouse look, and selected mode; returns the active view with obstacle avoidance in third-person. Changing mode preserves player location. |
| Interaction and placement | Identifies nearby usable objects and validates candidate placement. Returns a preview or a clear rejection reason before creating a cracker. |
| Crackers | Owns type definitions and lifecycle: placed, fuse burning, active, and finished. Provides selection, placement, ignition, and completion events; handles phuljhari as a held item. |
| Fireworks effects | Converts cracker events into pooled particles, trails, flashes, and sound events. Enforces effect budgets and cleans up finished effects. |
| Diyas | Tracks session-local lit state for existing diyas; makes repeated lighting harmless and updates visual feedback. |
| Ambient neighbours | Runs simple celebration behaviours and bounded reactions to nearby fireworks. Publishes positions for placement exclusions. |
| Audio | Plays local effects and distant ambience; controls gain, mute, and concurrent voices; starts after a player gesture. |
| Interface and quality | Shows selection, contextual prompts, invalid placement feedback, pause controls, and quality settings; applies a central quality profile. |

### Technical Choices

- **Agreed foundation:** TypeScript, Vite, Three.js using its WebGL renderer, and Rapier for movement and collision queries.
- **Client-only architecture:** gameplay runs in the browser. The prototype requires no account, database, backend, paid API, or hosted service.
- **Controls:** keys 1–4 select crackers; click places a selected ground cracker; E lights a nearby placed cracker or existing diya. The phuljhari is held and lit directly. Proposed remaining bindings are WASD movement, Shift to run, mouse look, V to switch camera, and Escape to pause/release the pointer.
- **Cracker behaviours:** phuljhari emits handheld sparks; anar produces a ground fountain; chakri spins on the ground; rocket rises with a trail and produces an overhead burst. Rocket variation prioritises burst shape, colour, and timing.
- **Placement:** validate reach, supported surface, geometry clearance, doorway clearance, neighbour clearance, and capacity. Rockets require clear space above their launch position. Invalid previews explain why placement is unavailable. Exact clearance distances are tuning values.
- **Simultaneous use:** cracker supply is unlimited, while placed objects, active effects, particles, dynamic lights, and audio voices have finite budgets. Reject additional placement or ignition with clear feedback when capacity is exhausted; preserve already accepted cracker sequences. Reclaim expired effects and abandoned unlit props through a bounded policy.
- **Physics:** use collision handling for the player and world queries. Animate fireworks with controlled trajectories and particle simulation rather than assigning a rigid body to every spark.
- **Rendering:** reuse geometry and materials, pool particle storage, limit light sources, and make expensive effects quality-dependent. Diyas may use emissive surfaces and selective lighting rather than a shadow-casting light per flame.
- **Quality:** offer Low, Medium, and High profiles controlling rendering resolution, particles, shadows, and supporting effects. Low must retain all four cracker types and recognisable sky bursts.
- **Session state:** diya states, placed crackers, and player position reset on a new visit. Saving is deferred.
- **Assets and licensing:** use original project-created geometry, textures, and synthesised audio initially. Any later third-party code must have an open-source licence; art and audio must have a free licence permitting modification and redistribution, such as CC0 or CC BY with attribution. Retain notices and source records. Avoid paid packs, noncommercial-only assets, unclear licences, and runtime CDN dependencies.
- **Project licensing:** distribute original project code under an open-source licence; MIT is the proposed default. Third-party materials retain their own notices. Confirm actual installed dependency licences during implementation rather than assuming every transitive dependency shares the top-level licence.

### ADR References

No existing architecture decision records or project domain documentation are present. The technical decisions above capture the agreed foundation; implementation may record durable tradeoffs separately as they arise.

## Testing Decisions

The following coverage is proposed for implementation; the user has not separately confirmed a test plan. Test meaningful gameplay rules and integration risks rather than mirroring visual implementation details.

- **Automated rule coverage:** placement acceptance and rejection; cracker lifecycle and one-time ignition; capacity admission and reclamation; repeated diya lighting; session reset.
- **Movement integration checks:** walls block traversal; stairs work in both directions; rooftop access remains inside boundaries; camera switching does not move the player; third-person camera avoids clipping through walls.
- **Browser play checks:** all controls and prompts work in both camera modes; phuljhari remains held; all four cracker types complete; overlapping fireworks remain usable; pause and focus changes do not leave movement stuck.
- **Visual and audio review:** rocket patterns are legible from street and rooftop; fountains and chakris are distinct; diya lighting changes the environment; spatial sound, distant ambience, and neighbour reactions support the celebration.
- **Performance checks:** exercise the active-effect cap, repeated launches, and a sustained session. Track frame time and resource counts to detect unbounded growth. Begin with a provisional goal of at least 30 FPS on Low at 1280 × 720 on a named integrated-graphics reference laptop; target 60 FPS where feasible. Hardware and final limits require measurement, so these are not yet verified guarantees.
- **Compatibility and delivery:** validate production build and local serving. Start with current desktop Chromium browsers; assess Firefox and Safari before claiming support. Check dependency notices and verify that runtime operation needs no paid endpoint.

### Prototype Acceptance Criteria

1. A player can start a local browser session, explore the test lane and courtyard, and reach the rooftop by stairs without jumping.
2. Walking, running, collision, first-person default, and third-person switching function together; one preset festive character is visible in third-person.
3. All four crackers are selectable with unlimited supply. Ground crackers support preview, placement, separate ignition, and stepping away; phuljhari is held.
4. Multiple crackers overlap within an enforced cap, and capacity feedback is understandable.
5. Rockets produce varied colourful sky bursts; supporting flashes and sound are present. Anar, chakri, and phuljhari each have a distinct effect.
6. Existing diyas can be lit, and ambient neighbours provide basic watching or cheering reactions.
7. Placement exclusions protect doorways and neighbours; no injuries or destruction occur.
8. Quality settings work, resources remain bounded during repeated play, and measured performance is recorded with the actual test hardware.
9. Reloading starts a fresh session. There are no goals, ending, or finale.
10. Source, dependency setup, and run instructions are available; all included dependencies and assets have recorded compatible licences and require no purchase.

## Out of Scope

- Multiplayer, shared worlds, accounts, and chat.
- Mobile and touch controls; gamepad support is also deferred.
- Saved progress, persistent diya states, and cloud storage.
- Missions, doorway completion rewards, unlocks, currency, shops, and a finale.
- Injuries, damage, destruction, combat, and mischievous consequences.
- Jumping, vehicles, character customisation, and multiple playable characters.
- Enterable house interiors, additional rooftops, and a large city map.
- Player-placed diyas, rangoli systems, deliveries, and additional minigames.
- Firework show editors, sequencing tools, and additional cracker types.
- Detailed NPC conversations or complex crowd simulation.
- Paid assets, proprietary dependencies, paid services, and purchase-required build tools.
- Public deployment as a requirement for this prototype; local play must be self-contained.

## Further Notes

- **Scope distinction:** the long-term direction is an expandable open-ended celebration sandbox. The immediate milestone is a small playable prototype of the agreed interactions, not a fully dressed neighbourhood.
- **Priority order:** enjoyable movement and handling; impressive repeated fireworks; atmospheric light and sound; simple neighbour presence; visual polish.
- **Confirmed constraints:** ordinary laptops with integrated graphics, desktop/laptop browser input, no fixed release date, both camera modes, unlimited supplies with a finite performance budget, and fresh sessions.
- **Implementation assumptions:** fixed Diwali evening lighting, original procedural prototype assets, no game economy, and no mandatory external service. Exact map dimensions, neighbour count, effect caps, fuse lengths, and audio mix are tuning decisions rather than agreed requirements.
- **Unresolved validation:** select a representative integrated-graphics laptop, measure performance, and verify the licences of actual dependency versions and any imported assets. No asset purchases are authorised.
- **Publication status:** prepared for the project issue tracker with the intended label `needs-triage`. The project directory has no repository or tracker configuration, so tracker publication is pending. The local PRD is the fallback deliverable.
- **Project state at authoring:** the project directory was empty; implementation had not started. There are no existing modules, test precedents, ADRs, or tracker conventions to preserve.
