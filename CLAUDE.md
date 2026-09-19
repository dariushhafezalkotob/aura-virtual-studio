# Aura Virtual Studio

Browser-based virtual film studio: design 3D scenes, set up and animate actors, and record camera moves (including using a phone as a gyro camera remote).

## Stack
- React 18 + TypeScript + Vite 6, Tailwind CSS
- Three.js via @react-three/fiber and drei
- @gradio/client for AI model backends
- GitHub: dariushhafezalkotob/aura-virtual-studio

## Run
- `npm run dev` → https://localhost:3000 (HTTPS via basic-ssl, needed for phone sensors)
- `npm run build` → `tsc && vite build`
- Much server/API logic lives in `vite.config.ts` (dev-server middleware, ~54KB)
- Secrets in `.env.local` (not committed); see `.env.example`
- Project data is stored in `data/projects.json`

## Layout
- `src/components/screens/` — main views: Projects, SceneDesign, ActingSetup, CameraRecord, WorkflowSequence, MobileCameraRemote
- `src/components/acting/` — actor rig posing, constraints, multi-actor timeline
- `src/components/viewport/` — ThreeStage, CharacterActorModel
- `src/components/roombake/` — RoomBake studio and UV inspector
- `src/services/` — cameraRemoteService (phone gyro), ikSolver, kimodoService (AI motion generation), roombake engine/AI, somaSkeleton, storageService, trellisService (AI 3D generation)
- `src/types/index.ts` — shared types

## Recent work
- Acting layout (2026-09-19, uncommitted): the multi-text sequence lives in the bottom bar's left margin instead of a full-width row.
  - It used to be "Row 0" above the prompt, so opening it added ~190px to the bottom panel and took that height off the 3D viewport -- exactly when you want to watch the motion you are describing. As a column it takes width from the timeline, which scrolls horizontally anyway.
  - The column is ABSOLUTELY positioned (`left-md top-md bottom-md`) inside the now-`relative` bottom panel. As an ordinary flex child its own content set the panel's height, so a fifth or sixth segment grew the bar and ate the viewport again. Out of flow, the panel is sized by the timeline alone and the list just scrolls: 2 -> 6 segments kept the canvas at 1600x583, list 253px tall with 426px of content.
  - Nothing else may reintroduce the gap: the sibling stack clears the column by 4px (`ml-[264px] xl:ml-[304px] 2xl:ml-[344px]`), AND while the column is open the prompt row and the timeline (`MultiActorTimeline` prop `alignLeft`) swap `mx-auto` for `mr-auto`. Both are `max-w-6xl`, so the centring margin was itself a ~36px gap between the column and the timeline card -- measuring the container edge hides this; measure the timeline card's own `left`.
  - Each segment is a small card (prompt on top, duration/reorder/delete underneath) to fit 260-340px.
  - The prompt row is `flex-wrap` with a `min-w-[160px]` prompt: every control after it is `shrink-0`, so on a narrow window GENERATE MOTION was pushed off the screen edge and the prompt collapsed to a ~20px empty square.
- Ground track / root2d authoring (2026-09-19, no code change -- what exists today): keying the 2D root is a better lever for position than full-body poses, and the app already compiles two kinds. `destination` constraints (CONSTRAINTS panel) become SPARSE root2d keys, one per waypoint at its `endTime`, with headings from a `facing_direction` constraint or the path tangent; the SMOOTH PATH toggle sends the actor's trajectory spline as a DENSE per-frame root2d. Gaps: the floor ring in ThreeStage is display-only (position is two number fields), there is no "key the root at the playhead" button, arrival time is the constraint's END time, and the dense path is not hand-editable (it comes from the straight/arc/circle/in-place dropdown or the last take).
- Phone remote lag (2026-09-19, diagnosed, NOT fixed): Bluetooth is not an option -- Web Bluetooth only makes the browser a BLE central, a phone browser cannot advertise as a peripheral, and iOS Safari has none of it. The lag is in the send path: `CameraRemoteSocket.send` never checks `ws.bufferedAmount`, so at ~66Hz a brief WiFi stall queues ~20 stale samples that then arrive in a burst (WebSocket is TCP, so one lost packet also blocks everything behind it). Fixes in order: drop the sample when anything is still buffered, then a WebRTC DataChannel (`ordered: false, maxRetransmits: 0`) with the existing relay carrying only the handshake. There is a `ping` in the service but no pong and no RTT readout, so nobody is measuring any of this yet. For Android the best transport is `adb reverse tcp:3000 tcp:3000` over USB (phone opens the pairing URL with `localhost` in place of the IP; `localhost` is a secure context so the gyro APIs still work); `getLocalIpAddress` in vite.config.ts returns the first `en*` interface, so the QR always points at WiFi even when a tether is up.
- Pelvis position (2026-09-18, uncommitted, not yet tried against the live Kimodo Space): the pelvis is positionable, not just rotatable, and its position reaches Kimodo.
  - `ActorKeyframePose.hipsSpace: 'root'` marks a key whose `ikTargets.hips` is in ROOT space on all three axes -- the take's root at that time plus the offset the user moved the pelvis by, which is exactly Kimodo's `root_positions`. Keys without the flag are older ones: only their height was ever meaningful, so X/Z still fall back to the take's own root. `rootSpaceHipsToBodySpace` / `bodySpaceHipsToRootSpace` (somaSkeleton) convert; `absoluteHipsToBodySpace` is the same thing for Y alone and still serves the presets, whose X/Z are body-local.
  - The live-pose snapshot (CharacterActorModel) now writes all three axes in root space; before, only Y picked up the body-group offset, so a sideways pelvis edit read as ~0 and the compiler dropped it. An untouched pelvis compiles to exactly the take's root, so keys that don't move it behave as before (verified headlessly and in the app).
  - FK: with the Move tool (W) the pelvis gizmo translates the whole body; every other joint is still rotate-only. Commits to `ikTargets.hips`, the same place the IK hip ring writes.
  - A HELD full-body constraint now also emits a `root2d` entry over its span -- Kimodo's dedicated ground-track constraint -- merged into the waypoint path when there is one, skipped entirely when a dense path was authored. Limb-only holds leave the root free so they can't cancel locomotion.
  - Pasting a constraint keeps the pelvis HEIGHT but re-anchors its ground position to the take at the paste time, so a paste can't teleport the actor back to where the copied pose stood.
- Uncommitted as of 2026-09-18 (everything below "Uncommitted as of 2026-09-17" too). Keep `data/projects.json` out of commits.
- Continuing a take: `CONTINUE +Xs` (ActingSetupView `handleContinueFromLastFrame`) sends the take's END pose as a frame-0 fullbody constraint, generates the next section from the prompt box + DUR slider, and merges it with `KimodoService.appendMotion` (ground track carried over, absolute hip height kept, duplicate first frame dropped, BVH dropped, new prompt appended as its own motion segment). Verified once against the live Space: 300 + 120 frames merged to 419 in the app; the join was never inspected and the merged take never reached disk (see save conflict below).
- Constraint copy/paste: copy button on the constraint card and in the Keys list, paste at the playhead (onto the constraint there, or as a new one). Clipboard is a module-level variable in ActorRigPosingPanel, so it survives closing the panel and works across actors.
- Held constraints send EVERY frame (was every 3rd). Measured on a real regeneration: a fullbody hold went from 0.174°/frame drift with 0.140° flicker to exactly 0; foot-only holds still move ~0.16°/frame (Kimodo's own behaviour, not the sampling).
- Hip height is ABSOLUTE in constraints and in `motionData.root[i][1]`, but body-space in `ikTargets.hips`/the IK handle while a take plays. `absoluteHipsToBodySpace(actor, t, y)` (somaSkeleton) converts when applying a preset, snapping to a constraint, or pasting; the live-pose snapshot adds the body-group offset when recording hips. Getting this wrong drew seated takes floating at standing height and stored standing pelvis heights on constraints.
- Constraint auto-save waits up to 4s for the viewport to draw a frame with the edit (was 0.5s) before giving up.
- KNOWN RISK: two app instances (e.g. the user's tab on 3000 plus a test instance on 3100) overwrite each other's saves, and a single save rewrites the whole ~103 MB `data/projects.json` (seconds per save, lost if the page reloads mid-save). Constraints and a merged take were lost this way. Only run one instance, and moving motion takes into per-take asset files is the real fix.
- Uncommitted as of 2026-09-17 (all below "Recent work" items dated 2026-09-17). Keep `data/projects.json` out of commits.
- Constraint editing, Kimodo demo workflow (verified end-to-end on 2026-09-18: a seated hold regenerated correctly):
  - Playback uses the take's ABSOLUTE hip height (`motionData.root[i][1]` vs the rig's rest hip Y); X/Z stay relative to the actor's placement. Taking Y relative to frame 0 drew seated takes (~0.5m hips) at standing height with the feet in the air.
  - `POSE_PRESETS.seated` (Pose Library "Seated") poses a chair sit and drops the pelvis; presets may now carry `hips`, applied into `ikTargets.hips`.
  - Acting timeline spans each actor's multi-text total and constraint ends, not just `actor.duration`, so long takes can be scrubbed and constrained.
  - Interval constraints: `ActorKeyframePose.endTime` holds the pose over a range ("Hold until" in the constraint card, bar on the timeline). Playback holds exactly inside the span and blends from span end to the next key (`blendKeyframesAt`/`keyframeSpan` in somaSkeleton.ts). Compile expands an interval to frames at `KimodoService.INTERVAL_SAMPLE_FPS` (10) instead of every frame; constraints past the clip length are dropped rather than clamped to the last frame.
  - Rig panel: Enter Editing (pauses playback, FK/IK) -> "Constraint @ t" card: add Full Body / L/R Hand / L/R Foot using the on-screen pose; at a keyed frame it auto-snaps to the key and edits auto-save into it; Snap / Reset to generated / Delete -> Exit & Regenerate. Exit clears live edits (customBoneRotations/ikTargets/customPoseTime).
  - Skeleton overlay (bone LineSegments + 77-joint InstancedMesh, drawn on top) in CharacterActorModel while editing; clicking a joint selects it for FK.
  - Keys = constraints (`keyframePoses` with `constraintKinds`). Set Key stores the live on-screen pose (after FK+IK, before constraint post-pass) via `setLiveActorPose`/`getLiveActorPose` in somaSkeleton.ts, guarded by `poseSourceOf`/`samePoseSource`; hips offset stored in `kf.ikTargets.hips` and blended on key playback.
  - Live edits are time-scoped: `liveEditAppliesAt(actor, t)` (within POSE_EDIT_TIME_TOLERANCE of `customPoseTime` when a take/keys exist). IK goals, hips and FK edits only apply at their time; editing at another time starts fresh; in IK mode moving to a new time (paused) re-seeds handles.
  - FK->IK captures handle positions from the current pose; IK solve keeps the existing elbow/knee bend as pole. IK->FK bakes solved limbs into customBoneRotations (not on exit to off).
  - Generation: constraints compiled against the multi-text total (`clipDuration`), not the single-prompt slider; results build on latest project (projectRef) and clear live edits. Dialogue "Generate motion" also sends each actor's constraints.
- Viewport/selection: while posing, the Rig panel's actor stays selected (empty/set clicks no longer deselect); IK handles render on top (depthTest off, renderOrder 1000).
- Panels: Rig, Constraints and Dialogue panels are `fixed` to the window (top 128px, bottom 16px) with internal scrolling, so they never go behind the timeline.
- Saving: App coalesces project persistence (1.2s debounce, one save at a time, flush on hide/pagehide). Previously every keystroke saved all projects (~62 MB) three times and exhausted RAM.
- Dialogue: voices can be deleted per line (Per line mode) or all at once; `/api/dialogue/delete-audio` only removes `dialogue_*.wav` files. Old mixed tracks are deleted when rebuilt. Script parser accepts `DAVID` lines, `David:` inline, `(V.O.)` and bold names.
- Dialogue previs (2026-09-17, uncommitted, not yet tested with a real Gemini key or Kimodo run):
  - DIALOGUE panel on the Acting screen (`src/components/acting/DialoguePanel.tsx`): script with speaker names and inline `[emotion]` tags, cast (actor + Gemini voice), audio, line timings, acting.
  - Audio: "Per line" (one Gemini TTS call per line, clips trimmed and mixed into one track with a chosen pause), "Whole scene" (one two-speaker TTS call), or "Import" a WAV. Every mode ends as `project.dialogue.audioUrl` plus per-line start/end.
  - Server code lives in `server/dialogueApi.ts` and `server/dialogueAudio.ts` (hooked into `vite.config.ts`): `/api/dialogue/tts`, `tts-scene`, `assemble`, `align`. TTS tries `generateContent`, then the Interactions API. Alignment matches script lines to pauses in the audio using word counts, pause length, a per-speaker voice fingerprint (mel-spectrum) and per-speaker pace. On synthetic tests it's exact to ~0.03s, except occasionally a short line opener lands ~1.3s off, so line times are hand-editable in the panel.
  - `src/services/dialogueScript.ts`: script parsing, emotion-tag to Kimodo body prompts (speaking and listening reactions), `buildActorSegments` gives each cast actor a talk/listen multi-text sequence covering the whole scene.
  - `useDialogueAudioSync` (Web Audio) plays the track in sync on the Acting and Camera Record screens; the timeline has a Dialogue row and adaptive ruler ticks.
  - Open risk: Kimodo has not been tried on ~1 minute multi-segment motions.
- Phone remote sync (committed in d90df9b):
  - Host no longer recreates its socket on every project change (reads project via ref) and resends `init_scene` (debounced) when characters/scenes change; phone sends `request_scene` when a host (re)joins. Fixes actors not animating on the phone.
  - Host sends `host_state` on discrete changes plus every 250ms while playing (was every frame). Phone runs its own clock in `LocalClockStage` (MobileCameraRemote.tsx), extrapolating at most 0.75s past the last sync and stopping when the host leaves.
  - Open issue: user reported phone actors kept playing after pausing on the Mac; the fixes above target this but it is not yet confirmed.
- Camera stabilizer (committed in d90df9b): `src/services/cameraStabilizer.ts` applies a zero-lag Gaussian smoothing to recorded take keyframes. `CameraTake.stabilizer` (0-100, new takes default 35) is applied on playback/export via `stabilizedTake`; the recorded keyframes are never modified. Slider lives in the take review badge in CameraRecordView. Live phone view is not smoothed.
- Camera remote: fixed gyro camera flipping when the phone tilts toward the ceiling (raw angles passed through; host smooths the pose). Known limit: joystick movement does nothing while pointing straight up.
- Acting: multi-text prompt sequences with blend length, shown as draggable timeline regions.
- Kimodo: fixes for actor rotation between world and motion space; hips keyed from the generated take.
- API: generate request is forwarded in full.

## Conventions
- Commit messages: `type(scope): summary` (e.g. `fix(camera-remote): ...`, `feat(timeline): ...`)
- Explain results to the user in plain, non-technical language.
