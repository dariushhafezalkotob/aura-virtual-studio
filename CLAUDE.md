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

## Recent work (as of 2026-09-14)
- Phone remote sync (uncommitted, awaiting user test):
  - Host no longer recreates its socket on every project change (reads project via ref) and resends `init_scene` (debounced) when characters/scenes change; phone sends `request_scene` when a host (re)joins. Fixes actors not animating on the phone.
  - Host sends `host_state` on discrete changes plus every 250ms while playing (was every frame). Phone runs its own clock in `LocalClockStage` (MobileCameraRemote.tsx), extrapolating at most 0.75s past the last sync and stopping when the host leaves.
  - Open issue: user reported phone actors kept playing after pausing on the Mac; the fixes above target this but it is not yet confirmed.
- Camera stabilizer (uncommitted): `src/services/cameraStabilizer.ts` applies a zero-lag Gaussian smoothing to recorded take keyframes. `CameraTake.stabilizer` (0-100, new takes default 35) is applied on playback/export via `stabilizedTake`; the recorded keyframes are never modified. Slider lives in the take review badge in CameraRecordView. Live phone view is not smoothed.
- Camera remote: fixed gyro camera flipping when the phone tilts toward the ceiling (raw angles passed through; host smooths the pose). Known limit: joystick movement does nothing while pointing straight up.
- Acting: multi-text prompt sequences with blend length, shown as draggable timeline regions.
- Kimodo: fixes for actor rotation between world and motion space; hips keyed from the generated take.
- API: generate request is forwarded in full.

## Conventions
- Commit messages: `type(scope): summary` (e.g. `fix(camera-remote): ...`, `feat(timeline): ...`)
- Explain results to the user in plain, non-technical language.
