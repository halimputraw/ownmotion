# OwnMotion

OwnMotion is an Electron desktop app for hands-free computer control.
**Your head points. Your voice acts.** It needs only a laptop webcam and microphone.

## What It Does

- **Head-controlled cursor** using MediaPipe Face Landmarker, smoothed with a One Euro filter so it is steady at rest and responsive in motion.
- **Personal calibration (about 20 seconds)** learns your resting head position, your comfortable range of movement, how far you open your mouth, and your voice. The profile is saved between sessions.
- **Voice commands** transcribed on-device with Whisper: "click", "double click", "right click", "scroll up/down", "type ...", "enter", "delete", "tab", "escape", "hold", "drop", "pause", "resume", "recenter".
- **Head and voice work together.** The cursor keeps following your head while you speak, and mouth-click is ignored while you talk.
- **Voice that adapts to you and the room.** Calibration measures the room's background noise and how loud your voice is at this microphone. While running, the speech threshold rises automatically when the room gets louder, and a warning appears when noise is close to drowning you out.
- **The camera double-checks the microphone.** A sound only counts as a command if your lips moved while it was heard, so other people talking, music and background noise are ignored.
- **Other ways to click:** open your mouth, raise your eyebrows (right-click) or hold the cursor still (dwell click). Each can be switched on or off.
- **Scroll by tilting your head.** Say "scroll" (or press **Scroll mode**), then tilt your head up or down to scroll the page; the further you tilt, the faster it goes. Say "cursor" to go back to moving the cursor.
- **Two control modes.** *Direct*: the cursor goes where your head points. *Joystick*: lean your head to steer, for users with a small range of movement.
- **Always-visible status pill** at the bottom of the screen shows what OwnMotion heard, even when another app covers its window.
- **Global pause shortcut** `Cmd/Ctrl+Shift+G` works from any app.

## Tech Stack

- Electron (main process + preload bridge)
- React + Vite + TypeScript + Tailwind CSS (renderer UI), Zustand (settings store)
- `@mediapipe/tasks-vision` Face Landmarker (478 landmarks + blendshapes)
- `@huggingface/transformers` running `whisper-base.en` in a Web Worker (WebGPU, with a WebAssembly fallback)
- `@nut-tree-fork/nut-js` (native cursor, click, scroll and keyboard)

## Architecture

1. **Electron main process** (`electron/main.js`)
   - Creates the main window and the click-through status pill window.
   - Handles IPC for mouse move/click/drag/scroll, typing and key presses.
   - Registers the global pause shortcut and macOS permission checks.

2. **Preload bridge** (`electron/preload.cjs`)
   - Exposes a small, safe API on `window.electronAPI`.

3. **Renderer** (`src/`)
   - `core/engine.ts`: the per-frame loop. Tracking, cursor mapping, gestures, calibration, and the hand-off between head and voice.
   - `core/voice.ts`: microphone capture and voice activity detection.
   - `core/whisper.worker.ts`: speech-to-text in a worker.
   - `core/commands.ts`: turns a transcript into a command.
   - `core/oneEuro.ts`: the smoothing filter.
   - `core/store.ts`: settings, saved calibration and live status.
   - `components/`: calibration guide, voice panel, gesture meters, settings.

## Quick Start

```bash
npm install
```

```bash
npm run dev:electron
```

This starts Vite on `http://localhost:5173` and launches Electron.

If Electron reports that it "failed to install correctly", run `node node_modules/electron/install.js` and try again.

The first time voice is used, the speech model (about 100 MB) is downloaded and cached. After that OwnMotion works offline.

## How To Use

1. Click **Start calibration** and allow **Camera**, **Microphone** and **Accessibility** when asked.
2. Follow the steps: look straight ahead, move your head as far as is comfortable, open your mouth wide, stay quiet, then say "click" three times.
3. Move your head to move the cursor.
4. Say "click", or open your mouth, to click. Say "type hello" to type.
5. Say "pause" (or press `Cmd+Shift+G`) to stop control, and "resume" to continue.

## Scripts

- `npm run dev`: Start Vite renderer only.
- `npm run dev:electron`: Start Vite + Electron together.
- `npm run start`: Start Electron directly (needs the renderer running or built).
- `npm run build`: Type-check and build renderer.
- `npm run lint`: Run ESLint.

## macOS Permissions

OwnMotion needs, under System Settings > Privacy & Security:

1. **Camera** (face landmarks)
2. **Microphone** (voice commands)
3. **Accessibility** (system cursor and keyboard control)

When run in development these are granted to **Electron** (or to the terminal app that launched it). Restart the app after granting Accessibility.

## Troubleshooting

- **Face not found:** improve lighting, avoid strong backlight, keep one face in view.
- **Cursor does not move:** grant Accessibility permission and restart the app.
- **Cursor drifts off-centre:** say "recenter" or press **Recenter**.
- **Hard to reach screen edges:** raise Sensitivity, recalibrate, or switch to Joystick mode.
- **Voice not recognised:** check the microphone permission; speak the command on its own, with a short pause before and after.

## Safety and Privacy

- This app controls the global OS cursor.
- Use in a safe test environment.
- Webcam and microphone processing is local-only. No video or audio leaves the computer.
- Do not add frame logging or network upload without explicit consent.
