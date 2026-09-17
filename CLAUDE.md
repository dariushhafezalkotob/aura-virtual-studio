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
- Uncommitted as of 2026-09-17 (all below "Recent work" items dated 2026-09-17). Keep `data/projects.json` out of commits.
- Constraint editing, Kimodo demo workflow (not yet verified with a real regeneration):
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
