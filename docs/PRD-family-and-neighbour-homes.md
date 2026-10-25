# Family and Neighbour Homes: Aarti, Sweets and Belonging

## Problem Statement

The completed first version lets players explore a festive lane, light diyas and enjoy fireworks, but it offers little personal connection to the people celebrating there. Players need a family to celebrate with and meaningful activities inside homes, so that the evening feels like their own Diwali rather than a place they only observe.

The expansion must preserve relaxed, open-ended play and remain usable on ordinary laptops. Interior detail must support the feeling of belonging without making movement, fireworks or interactions noticeably unreliable.

## Solution

Add two enterable homes: the player's family home and a familiar neighbour's home. Players interact at a door and enter or exit through a brief fade. Both homes are available from the start, with no required visit order.

At home, parents, a sibling and grandparents are already gathered at the puja corner. A family member calls the player over without a timer or pressure. Aarti starts only when the player joins. Holding a button circles the thali; releasing it rests the player's hands. The player can look around freely and explicitly leave aarti to put down the thali and regain movement. There is no scoring, failure state or movement-accuracy requirement.

The player selects a recording from Om Jai Jagdish Hare, Jai Lakshmi Mata and Jai Ganesh Deva. The selected recording supplies the singing while family members pray, clap and ring a bell. Aarti follows the full recording's duration. Changing recordings starts the new song from the beginning. Aarti happens once per session, although the player may leave and rejoin before it finishes.

When the player leaves aarti, playback stops but the ceremony's elapsed time continues while the game runs. Rejoining resumes playback at the elapsed position. If the selected song finishes while the player is away, the ceremony completes. Pausing the game or switching tabs freezes the song, ceremony timer and family activity together.

After aarti, family members move to seats, chat and serve the sweets tray. The player may eat directly from it or carry a plate to share with individual family members, indefinitely. Distinct Hinglish text and gestures express affection, teasing and blessings; spoken dialogue is deferred.

A gift box is available at home at any time. The neighbour's uncle and aunty welcome the player with greetings and mithai whether or not a gift is brought. Bringing the box triggers one special exchange per session and provides a return box. The player can bring that box home and place it on the sweets table for a family reaction. Before aarti finishes, the box waits there; afterward, the family acknowledges it. Visits remain unlimited.

## User Stories

1. As a player, I want to enter my family home through a door interaction and brief fade, so that I can join a personal indoor celebration.
2. As a player, I want to visit the neighbour at any time, so that I can choose the order of my evening.
3. As a player, I want to find my parents, sibling and grandparents gathered, so that I feel expected and included.
4. As a player, I want a warm invitation without a countdown, so that I can choose when to begin aarti.
5. As a player, I want aarti to start only when I join, so that I do not miss its beginning while exploring.
6. As a player, I want to hold a button to circle the thali and release it to rest, so that participation feels direct and comfortable.
7. As a player, I want to look around without leaving aarti, so that I can see my family participating.
8. As a player, I want an explicit leave action that puts down the thali and restores movement, so that I can step away freely.
9. As a player, I want to choose among the three requested aartis while participating, so that I can choose the music for the ceremony.
10. As a player, I want changing songs to start the new recording from the beginning, so that I can perform it in full.
11. As a player, I want the ceremony to follow the selected song's duration independently of thali movement, so that I can participate without scoring or pressure.
12. As a player, I want the family to continue aarti when I leave, so that the household feels independent of my presence.
13. As a player, I want to rejoin at the current song position before it finishes, so that leaving does not restart the ceremony.
14. As a player, I want the ceremony to complete when its song ends even while I am elsewhere, so that the evening progresses naturally.
15. As a player, I want pausing or switching tabs to freeze music, ceremony time and family activity together, so that stepping away from the game does not make me miss events.
16. As a player, I want my family to move to seats and serve sweets after aarti, so that the gathering changes naturally over the evening.
17. As a player, I want unlimited eating directly from the tray, so that I can enjoy the activity without managing supplies.
18. As a player, I want to carry a sharing plate to individual family members, so that I can spend time with each person.
19. As a player, I want distinct Hinglish text and gestures from each family member, so that sharing feels personal.
20. As a player, I want the sharing plate to remain in the family home with a clear return prompt before exiting, so that its purpose is understandable.
21. As a player, I want one held item at a time, so that carrying sweets, gifts and crackers is visually consistent.
22. As a player carrying sweets, I want cracker actions blocked with a return-or-deliver prompt, so that I understand how to free my hands.
23. As a player, I want a gift box available before aarti, so that neighbour visits do not depend on completing the ceremony.
24. As a player, I want familiar uncle and aunty to recognise me, ask about my family and offer mithai even without a gift, so that I feel welcome.
25. As a player, I want a special response and return box when I bring sweets, so that giving has a meaningful social response.
26. As a player, I want one special gift exchange per session and unlimited later visits, so that the exchange has continuity without closing the neighbour's home.
27. As a player, I want designated return spots for both gift boxes, so that I can temporarily stop carrying one without losing it.
28. As a player, I want to place the return box at home and receive a family reaction after aarti, so that the visit connects back to my family.
29. As a player, I want a fresh celebration on a new session, so that no account or saved progress is required.
30. As a player on the reference laptop, I want at least 30 FPS on Low with a goal of 60, so that interiors preserve comfortable play.
31. As the project owner, I want redistribution-compatible audio and recorded attribution, so that the game can be distributed with its assets.

## Implementation Decisions

### Modules

Extend the existing module contracts and typed GameEventBus. Keep gameplay rules renderer-free, use the existing fixed-step simulation, and retain SessionModule reset and pause ownership. Proposed module boundaries are implementation recommendations, not an already implemented design.

| Component | Responsibility and stable contract |
| --- | --- |
| Interior locations and transitions | Owns the active location, doorway destinations, entry/exit poses and transition state. Accepts a transition request, returns acceptance or a clear rejection, and publishes location changes. Retains household state across visits; handles collision and camera context changes behind the interface. |
| Aarti ceremony | Owns waiting, running and completed state; player participation; selected recording; elapsed time; and thali intent. Accepts join, leave, song-change and hold/release commands. Advances only with unpaused simulation time and completes once per session. Publishes presentation-ready snapshots and one-time completion events. |
| Recorded aarti audio | Owns the licensed recording catalogue, durations, loading, seeking and one active playback source. Consumes ceremony snapshots to play from the correct offset only during participation. Integrates with AudioModule unlock, mute, master gain and session pause; playback does not own ceremony progression. |
| Household behaviour and dialogue | Owns stable family and neighbour identities, reaction selection and household activity. Consumes ceremony, sharing and gift events; supplies poses, gestures and Hinglish text. Family transitions from gathering to seats after completion even when its interior is inactive. |
| Held items and sweets | Owns exclusive hand occupancy, tray availability, plate pickup/return, eating and offering eligibility. Exposes commands and rejection reasons. Arbitrates sweets and thali use with the existing held phuljhari and cracker controls. |
| Gift exchange | Owns outbound and return box locations, the one-time neighbour exchange and the one-time home acknowledgment. Exposes pickup, return, exchange and table-placement commands; publishes idempotent social events. |
| Interior presentation | Builds rooms, furniture, household figures, props and warm lighting from gameplay snapshots. Activates only the current location's expensive presentation. Reuses assets and respects QualityProfile budgets. |
| Interaction, input and interface | Extends InteractionModule beyond crackers and diyas to doors, puja, trays, people and return spots. Routes contextual actions, shows leave/hold/return prompts, and exposes song selection only while participating. Keeps camera look separate from thali control and UI input. |
| Session and performance integration | Registers new resettable state, pauses clocks and animation consistently, releases held input on focus loss, and includes interior resources in existing monitoring and sustained-play checks. |

### Technical Choices

#### Existing foundation

- Retain TypeScript, Vite, Three.js, Rapier and Vitest. Keep the experience client-only, self-contained and desktop-browser focused, with no account, backend, paid service or runtime CDN dependency.
- Preserve the existing outdoor sandbox, quality profiles, effect budgets, fresh-session reset and first-/third-person camera options. New room collisions and camera views must support the existing modes.
- Use the existing renderer-free rule architecture and typed event contracts. Presentation and audio subscribe to state changes rather than owning story progression.

#### Locations and transitions

- Provide exactly two enterable homes in this release. The family home needs a puja area and seating/sweets area; the neighbour home needs a greeting and sweets area. Extra rooms are unnecessary unless they directly support these activities.
- Door interaction starts a brief fade, moves the player to a valid destination pose and restores control. Block overlapping transition requests and suppress accidental actions during the fade.
- Render the active location rather than drawing the complete street and both interiors simultaneously. Inactive household progression remains as lightweight logical state.
- Retain outdoor world and accepted cracker lifecycles across home visits. Hiding outdoor rendering must not reset already accepted effects, stall their logical cleanup or resurrect expired crackers on return.
- A carried plate blocks exit from the family home and identifies the sweets table as its return spot. Gift boxes may cross door transitions.

#### Aarti state and timing

- Initial state: family gathered, ceremony waiting, no singing playback. An invitation is ambient encouragement and does not start a countdown.
- Joining starts the selected song at the beginning and reserves the player's hands for the thali. While participating, player translation is disabled, camera look remains available and holding the action circles the thali. Releasing it rests the pose without pausing the song.
- Explicitly leaving clears participation, puts down the thali and restores movement. Family activity and ceremony time continue while the session runs, including when the player is outside or visiting the neighbour.
- Song selection is available only during participation. Selecting a different song replaces the active recording, resets elapsed time to zero and sets completion to that recording's full duration. Changing songs can extend the gathering; there is no fixed 2–3 minute limit.
- Rejoining a running ceremony starts playback at its accumulated elapsed time. A completed ceremony cannot be rejoined or restarted until a fresh session.
- Completion occurs once when elapsed time reaches the selected recording's duration, regardless of participation or thali activity. Stop playback, release the thali if held, and transition the family to post-aarti behaviour.
- Use unpaused game time as the logical clock, not a wall-clock deadline. Pause/focus loss freezes it along with family activity and playback; resumption synchronises them. Retain the existing browser gesture requirement for resuming audio and pointer lock.
- Release the held thali action on pause or focus loss so it cannot remain stuck after return. Audio end callbacks must not complete an obsolete song after a selection change, leave, reset or transition.

#### Audio catalogue and controls

- Required titles: Om Jai Jagdish Hare, Jai Lakshmi Mata and Jai Ganesh Deva. Prefer warm group singing where suitably licensed recordings are available.
- Bundle recordings locally and provide a catalogue containing title, performer/source, licence, attribution, duration and asset identity. Metadata and playback must refer to the same recording.
- Only one aarti recording plays at once. Play it only while the player participates; otherwise retain the lightweight timeline. Do not render or play the family ceremony in another location merely to keep time.
- Supply song selection and an indication of the current song/progress. Retain existing mute and master volume controls; muting does not stop ceremony progression.
- Family members pray, clap and ring a bell without individual sung voice tracks. Avoid layering duplicate bell/clap audio over a recording that already contains it.
- Load enough metadata to know duration before committing to a song. A load or decode failure needs visible feedback and a consistent previous state; it must not silently finish the ceremony or leave controls unusable.
- Per-song pause, seeking, repeat, autoplay queues and song selection after completion were not agreed and are excluded from the initial mini player.

#### Sweets, hands and gift continuity

- Serve the family tray only after aarti. Eating directly from it and offering from a carried plate are unlimited and do not consume currency or a finite supply.
- Family members have distinct Hinglish text and gestures. Use a small set of variations with bounded presentation timing so repeated sharing does not create overlapping dialogue or animation queues.
- The sharing plate remains inside the family home and is returned to its sweets table. Gift boxes use their own designated spots in the home they came from and can be picked up again until delivered.
- One item occupies the hands at a time. Picking up sweets puts away the selected cracker. Selecting or attempting to use crackers while holding a plate or gift box keeps that item in hand and shows a clear return-or-deliver message. This gate must cover placement, ground-cracker ignition and held-sparkler ignition.
- Joining aarti while carrying another item requires returning it first. Thali occupancy and cracker occupancy follow the same exclusive-hand rule.
- The neighbour gift exchange is a single atomic transition: consume the outbound box, record the exchange and place the return box in the player's now-free hands. Repeat interactions never duplicate gifts or restart the special exchange.
- The return box may be placed on the family sweets table before or during aarti. Record a pending acknowledgment; trigger it once after aarti. If aarti has already finished, trigger it on placement. After acknowledgment, treat it as delivered rather than a reusable exchange item.
- Neighbour greetings and eating mithai remain available on later visits, including visits without a gift. The family tray's timing does not gate neighbour hospitality.
- Reset ceremony, participation, hands, gifts, pending reactions and household activity with the existing fresh-session reset.

#### Performance and presentation

- Acceptance target: at least 30 FPS on Low at the established 1280 × 720 CSS viewport on the reference laptop; aim for 60 FPS. Preserve the existing Low render scale when comparing results and report actual drawing-buffer dimensions.
- Reference machine: 2022 MacBook Air, Apple M2 with 8-core integrated GPU and 8 GB unified memory. Existing measurements recorded roughly 60 FPS on Low/Medium and about 50 FPS on High, with temporary sustained-play dips. These results are a baseline, not proof of interior performance or a guarantee for all integrated GPUs.
- Reuse geometry and materials, batch static decoration, use inexpensive glowing flames and limit real lights and transparent effects. Low must retain every interaction and legible family gestures.
- Preload nearby interior assets where practical. Reuse bounded room assets across visits, stop inactive presentation and audio, and reclaim obsolete playback sources/listeners.
- Track room-entry hitches separately from steady-state frame rate. Door fades do not excuse unbounded loading stalls or memory growth.

### ADR References

No standalone ADRs or CONTEXT document were found during repository review. Existing domain vocabulary comes from the prototype requirements, architecture documentation and module contracts. This PRD records proposed expansion decisions; it does not claim that new modules or interfaces already exist.

Relevant project context: [session and input](https://github.com/ShimanshuChauhan/Diwali_Game/issues/3), [interaction rules](https://github.com/ShimanshuChauhan/Diwali_Game/issues/8), [audio](https://github.com/ShimanshuChauhan/Diwali_Game/issues/13), [performance validation](https://github.com/ShimanshuChauhan/Diwali_Game/issues/19) and [licensing/acceptance](https://github.com/ShimanshuChauhan/Diwali_Game/issues/20).

## Testing Decisions

Use deterministic, renderer-free tests for stateful rules and browser checks for collision, input, audio and visual behaviour. Existing precedents include Session lifecycle/reset tests, fake AudioContext tests, interaction and placement tests, capacity tests, and sustained-session resource checks. The coverage below is proposed from those precedents; it was not separately reviewed test by test by the user.

- **Ceremony rules:** invitation does not start time; joining starts once; thali hold/release does not change duration; leaving preserves progression; rejoining uses the elapsed offset; changing songs resets to the new full duration; stale callbacks cannot finish a replacement; completion is idempotent and prevents replay until reset.
- **Pause and audio integration:** user pause and hidden-tab/focus loss freeze all relevant state; resumption restores matching offsets without duplicate voices; leaving silences playback while time advances; completion while absent is detected without audio playing; mute does not affect timing; failed loading and delayed metadata leave a usable state.
- **Items and sweets:** tray availability follows aarti; eating/sharing are unlimited; family reactions are distinct and bounded; only one item is held; every cracker action respects hand occupancy; plate exit is blocked; designated returns and repickup preserve box identity.
- **Gift progression:** no-gift visits work before and after aarti; the special exchange occurs once; outbound consumption and return creation are atomic; acknowledgment defers before completion and occurs once afterward, including after offscreen completion; reset clears all progression.
- **Transition integration:** doorway requests cannot overlap; entry/exit poses are walkable; both camera modes avoid clipping; fade controls do not leak movement or interactions; visits preserve world and ceremony state; outdoor cracker cleanup continues while its presentation is inactive.
- **Browser experience:** verify invitation, look-around, held thali, leave/rejoin, mini-player input, family seating, eating, plate sharing and the full gift round trip. Review Hinglish readability, recognisable gestures and clear rejection prompts. Ensure normal UI focus changes do not accidentally abandon aarti or resume the game.
- **Performance:** measure family home during aarti, family home during sweets interactions, neighbour hospitality, outdoor fireworks at existing effect caps, and repeated doorway transitions. Record average and percentile frame times, resource counts and transition hitches. Run a visible 15–30 minute browser session with repeated visits, song switches and pause/resume; investigate sustained sub-30 FPS periods and growth in memory, geometries, textures, audio sources or listeners. Headless soak tests supplement but do not replace browser/GPU measurements.
- **Delivery:** production type-check/build and existing tests remain passing once implementation occurs. Verify each bundled recording's actual licence, provenance and attribution; no unverified candidate audio ships.

### Acceptance Criteria

1. Both homes can be entered and exited through a brief door fade at any point in the evening, subject to the plate-return rule.
2. The family is gathered on entry, invites the player without pressure, and waits for participation before starting aarti.
3. The player can hold to circle the thali, release to rest, look around and explicitly leave without scores or failure.
4. All three requested aartis have approved bundled recordings; changing the selection starts the new song from the beginning and completion follows its full duration.
5. Leaving stops playback while ceremony time continues; rejoining seeks correctly; ending while absent completes the ceremony once.
6. Pause and tab switching freeze and resume song, ceremony and family state together without stuck held input or duplicate playback.
7. Family members move to seats after aarti and serve the tray. Eating and individual sharing are unlimited and produce distinct Hinglish text/gesture reactions.
8. The sharing plate stays home and must be returned before exit. Both gift boxes have working return spots; all sweets-held cracker actions give clear rejection feedback.
9. Uncle and aunty welcome visits without gifts. One special exchange supplies a return box, and later visits remain available.
10. Returning the box produces one family acknowledgment, deferred until after aarti when necessary.
11. New sessions reset all expansion state. Existing outdoor gameplay and camera options remain usable.
12. Low meets the agreed 30 FPS floor under representative sustained play on the reference laptop, aims for 60 FPS, and shows bounded resources across repeated visits; measurements include transition hitches and actual rendering resolution.
13. Recording redistribution permissions and attribution are documented and verified before release.

## Out of Scope

- Additional enterable homes, a large neighbourhood expansion or elaborate unused rooms.
- Seamless doorway traversal, street views rendered through interior windows, or a detailed door-opening simulation.
- Multiplayer, accounts, cloud services, saved progress or persistence between sessions.
- Scores, rhythm challenges, aarti failure, compulsory visit order, currency, finite sweets supplies or rewards/unlocks.
- Restarting a completed aarti within the same session; fixed-duration cutoffs that truncate the chosen song.
- Per-song pause, seeking, repeat queues or background aarti playback when the player is not participating.
- Recorded character dialogue, individual family singing tracks, conversation trees or complex social AI.
- Carrying the sharing plate outside, arbitrary item dropping, general inventory management or physical simulation for every sweet.
- Rangoli creation, diya painting/placement, wardrobes, companions, photo mode and miniature fort construction; earlier research ideas are not part of this release.
- Mobile/touch controls, gamepad support, injuries, destruction, indoor cracker activities or paid asset/service requirements.

## Further Notes

- **Decision precedence:** follow the later full-song timing decision, not the earlier 2–3 minute suggestion. Audio plays only during participation, not merely because the player is inside. Family progression continues during an in-game absence but stops during global pause or tab inactivity.
- **Scope change:** enterable interiors, sweets interactions and one session-local ceremony intentionally expand the prototype's earlier exclusions. Fresh sessions, single-player operation and open-ended outdoor celebration remain the foundation.
- **Music dependency:** redistribution-compatible recordings have not yet been verified for any of the three requested songs. Search candidates described as copyright-free are leads only. Traditional lyrics, free listening access or an uploader's title do not establish permission for the particular recording. Retain source, rights-holder/licence evidence and required attribution. Prefer CC0, CC BY or another demonstrably compatible free grant; reject noncommercial-only, unclear or purchase-required material. Do not silently substitute unapproved audio or remove a requested song.
- **Implementation assumptions:** represent the family as mother, father, one sibling and two grandparents; final names, appearances and sibling identity remain content choices. A repeated invitation should be restrained rather than a constant prompt. Simple post-aarti conversation may use gestures and Hinglish text without recorded speech.
- **Additional assumed rules:** return a carried item before joining aarti; require an active held sparkler to be extinguished or put away before a sweets pickup; use a placeholder state while approved audio is still being sourced during development, without treating placeholders as release-ready. Exact handling must preserve the existing accepted cracker lifecycle and capacity accounting.
- **Controls and layout:** exact bindings, fade duration, room dimensions, interaction ranges and reaction cooldowns are implementation tuning. Keep instructions contextual and distinguish song UI interaction from thali control. The original camera modes remain available; mode-specific hand presentation needs browser review.
- **Performance evidence:** the existing reference measurements concern the outdoor prototype and include unresolved temporary soak dips. No interior benchmark has been run. Broader hardware claims require additional measurement.
- **Delivery sequence:** establish one complete family-home slice with ceremony timing, pause/audio integration, sweets and performance checks; then add the neighbour visit and gift round trip through the same location/item contracts. This PRD is a requirements document, not a decomposition into implementation tickets.
- **Review status:** gameplay choices and the performance target were agreed in conversation. Module boundaries, test coverage and explicitly marked assumptions are recommendations for implementation review, not additional claimed user approvals.
- **Publication:** published as [GitHub issue #51](https://github.com/ShimanshuChauhan/Diwali_Game/issues/51) with the existing needs-triage label. This saved document is the local copy; publication does not constitute implementation or validation of the feature.
