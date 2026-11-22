import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerResult,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import {
  cleanDictation,
  describeCommand,
  isNonSpeech,
  parseCommand,
  type Command,
} from "./commands";
import { OneEuroFilter } from "./oneEuro";
import { useStore, type Calibration, type CalibrationStep } from "./store";
import type { HudState } from "../types/electron-api";
import { VoiceListener } from "./voice";

// The engine owns everything that runs per camera frame: face tracking, the
// cursor, gestures, calibration and the hand-off between head and voice.
// It lives outside React so a 30-60 fps loop never causes re-renders; the UI
// reads a throttled summary from the store.

type Point = { x: number; y: number };

// MediaPipe face mesh landmark indexes.
const NOSE_TIP = 1;
const UPPER_LIP = 13;
const LOWER_LIP = 14;
const FACE_EDGE_A = 234;
const FACE_EDGE_B = 454;

const DEFAULT_HALF_RANGE: Point = { x: 0.15, y: 0.1 };
const MIN_HALF_RANGE = 0.03;
/** Reach the screen edge slightly before the end of the comfortable range. */
const RANGE_REACH = 0.85;

const CALIBRATION_MS: Record<CalibrationStep, number> = {
  neutral: 3000,
  range: 6000,
  mouth: 4000,
  quiet: 2500,
  speak: 5000,
};
const FACE_STEPS: CalibrationStep[] = ["neutral", "range", "mouth"];
const VOICE_STEPS: CalibrationStep[] = ["quiet", "speak"];
/** The user's voice must be at least this many times louder than the room. */
const MIN_VOICE_TO_NOISE = 2;
const MIN_VOICE_LEVEL = 0.008;
/** Lip opening change (in face widths) that counts as the user talking. */
const LIP_MOVE_MIN = 0.012;
const LIP_LOOKBACK_MS = 400;
const NEUTRAL_SETTLE_MS = 1000;
const MIN_JAW_TRAVEL = 0.12;

const MOUTH_HOLD_MS = 160;
const BROW_HOLD_MS = 250;
const GESTURE_COOLDOWN_MS = 400;
const JAW_FREEZE_MAX_MS = 1500;
const JAW_FREEZE_LOOKBACK_MS = 120;
const SPEECH_COOLDOWN_MS = 700;
const TRANSCRIBE_TIMEOUT_MS = 6000;

const DWELL_RADIUS = 30;
const JOYSTICK_DEAD = 0.18;
const JOYSTICK_MAX_SPEED = 1600;
const SCROLL_AMOUNT = 480;
/** Head tilt, as a fraction of the calibrated range, that is ignored in scroll mode. */
const TILT_SCROLL_DEAD = 0.25;
const TILT_SCROLL_MAX_SPEED = 1400;
const TILT_SCROLL_STEP = 12;
const FACE_LOST_MS = 500;
const HISTORY_MS = 600;
const HUD_REVERT_MS = 1800;
const UI_UPDATE_MS = 160;

const IDLE_HUD: HudState = {
  tone: "idle",
  text: "OwnMotion on · ⌘⇧G to pause",
};
const SCROLL_HUD: HudState = {
  tone: "listening",
  text: "Scroll mode · tilt up/down · say “cursor”",
};
const PAUSED_HUD: HudState = {
  tone: "paused",
  text: "Paused · say “resume” or ⌘⇧G",
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Head pose as the nose tip's offset from the middle of the face, in units of
 * face width. Because it is measured against the face itself it responds to
 * turning and nodding the head, not to leaning or moving the chair, and it is
 * the same at any distance from the camera.
 */
const headPose = (
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
): Point | null => {
  const nose = landmarks[NOSE_TIP];
  const a = landmarks[FACE_EDGE_A];
  const b = landmarks[FACE_EDGE_B];
  if (!nose || !a || !b) {
    return null;
  }

  const ax = a.x * width;
  const ay = a.y * height;
  const bx = b.x * width;
  const by = b.y * height;
  const faceWidth = Math.hypot(bx - ax, by - ay);
  if (faceWidth < 1) {
    return null;
  }

  const dx = nose.x * width - (ax + bx) / 2;
  const dy = nose.y * height - (ay + by) / 2;

  // Undo head tilt so tilting sideways does not move the cursor.
  const roll = Math.atan2(by - ay, bx - ax);
  const cos = Math.cos(-roll);
  const sin = Math.sin(-roll);

  return {
    x: (dx * cos - dy * sin) / faceWidth,
    y: (dx * sin + dy * cos) / faceWidth,
  };
};

/** Gap between the inner lips, in units of face width. */
const lipGap = (
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
): number | null => {
  const upper = landmarks[UPPER_LIP];
  const lower = landmarks[LOWER_LIP];
  const a = landmarks[FACE_EDGE_A];
  const b = landmarks[FACE_EDGE_B];
  if (!upper || !lower || !a || !b) {
    return null;
  }
  const faceWidth = Math.hypot((b.x - a.x) * width, (b.y - a.y) * height);
  if (faceWidth < 1) {
    return null;
  }
  return (
    Math.hypot((lower.x - upper.x) * width, (lower.y - upper.y) * height) /
    faceWidth
  );
};

const mean = (values: number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

type CalibrationRun = {
  steps: CalibrationStep[];
  step: CalibrationStep;
  elapsed: number;
  count: number;
  sumX: number;
  sumY: number;
  sumJaw: number;
  sumBrow: number;
  neutral: Point;
  jawRest: number;
  browRest: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  jawPeak: number;
  jawSmooth: number;
  quietLevels: number[];
  speakLevels: number[];
};

class OwnMotionEngine {
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private landmarker: FaceLandmarker | null = null;
  private stream: MediaStream | null = null;
  private voice: VoiceListener | null = null;
  private timer: number | null = null;
  private session = 0;
  private active = false;
  private unsubscribe: (() => void) | null = null;
  private removePauseListener: (() => void) | null = null;

  private screen = { width: 1440, height: 900 };
  private lastVideoTime = -1;
  private lastFrameAt = 0;
  private lastFaceAt = 0;
  private lastUiAt = 0;
  private frameCount = 0;
  private fpsWindowStart = 0;

  private readonly filterX = new OneEuroFilter();
  private readonly filterY = new OneEuroFilter();
  private cursor: Point = { x: 0, y: 0 };
  private sent: Point = { x: -1, y: -1 };
  private history: Array<Point & { t: number }> = [];
  private lastPose: Point | null = null;

  private calibrationRun: CalibrationRun | null = null;

  private jawFreezeSince: number | null = null;
  private jawFreezeExpired = false;
  private jawOnSince: number | null = null;
  private jawFired = false;
  private browOnSince: number | null = null;
  private browFired = false;
  private gestureCooldownUntil = 0;

  private speaking = false;
  private speechCooldownUntil = 0;
  private speechTimeout: number | null = null;
  private dictateNext = false;

  private dwellAnchor: Point = { x: 0, y: 0 };
  private dwellSince = 0;
  private dwellArmed = false;

  private scrollCarry = 0;

  private lipHistory: Array<{ t: number; gap: number }> = [];
  private lipMin = 0;
  private lipMax = 0;
  private lipSeen = false;
  private micPeak = 0;

  private hudTimer: number | null = null;

  // ---------------------------------------------------------------- lifecycle

  async start(video: HTMLVideoElement, canvas: HTMLCanvasElement): Promise<void> {
    this.stop();
    const session = ++this.session;
    const store = useStore.getState();
    store.setRuntime({ phase: "starting", error: null, notice: null });

    try {
      this.video = video;
      this.canvas = canvas;

      const api = window.electronAPI;
      if (api) {
        let granted = await api.getAccessibilityStatus();
        if (!granted) {
          await api.requestAccessibilityPermission();
          granted = await api.getAccessibilityStatus();
        }
        store.setRuntime({ accessibilityGranted: granted });
        this.screen = await api.getScreenSize();
        await api.requestMediaAccess("camera");
      } else {
        this.screen = { width: window.screen.width, height: window.screen.height };
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      if (session !== this.session) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      video.srcObject = stream;
      await video.play();

      const base = new URL(".", document.baseURI).href;
      const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
      const landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: `${base}models/face_landmarker.task`,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
      });
      if (session !== this.session) {
        landmarker.close();
        return;
      }
      this.landmarker = landmarker;

      this.active = true;
      this.cursor = { x: this.screen.width / 2, y: this.screen.height / 2 };
      this.fpsWindowStart = performance.now();
      this.lastFrameAt = 0;
      this.lastVideoTime = -1;

      this.removePauseListener =
        api?.onTogglePause(() => this.togglePause()) ?? null;

      // React to the voice switch being flipped while running.
      this.unsubscribe = useStore.subscribe((state, previous) => {
        if (state.settings.voice !== previous.settings.voice) {
          this.syncVoice();
        }
      });
      this.syncVoice();

      if (useStore.getState().calibration) {
        store.setRuntime({ phase: "running", paused: false });
        this.showHud(IDLE_HUD);
      } else {
        this.beginCalibration();
      }

      this.loop();
    } catch (error) {
      if (session !== this.session) {
        return;
      }
      this.stop();
      useStore.getState().setRuntime({
        phase: "error",
        error:
          error instanceof Error
            ? error.message
            : "Camera permission denied or unavailable.",
      });
    }
  }

  stop(): void {
    this.session += 1;
    this.active = false;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.releaseDrag();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.removePauseListener?.();
    this.removePauseListener = null;
    this.stopVoice();
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
    }
    this.calibrationRun = null;
    this.resetGestures();
    if (this.hudTimer !== null) {
      window.clearTimeout(this.hudTimer);
      this.hudTimer = null;
    }
    window.electronAPI?.updateHud({ visible: false, tone: "idle", text: "" });
    useStore.getState().setRuntime({
      phase: "idle",
      faceVisible: false,
      paused: false,
      scrollMode: false,
      calibrationStep: null,
      calibrationProgress: 0,
    });
  }

  // ------------------------------------------------------------------ control

  togglePause(): void {
    this.setPaused(!useStore.getState().paused);
  }

  setPaused(paused: boolean): void {
    const store = useStore.getState();
    if (store.phase !== "running" || store.paused === paused) {
      return;
    }
    if (paused) {
      this.releaseDrag();
    } else {
      this.resetGestures();
      this.filterX.reset();
      this.filterY.reset();
    }
    store.setRuntime({ paused });
    store.logActivity(paused ? "Paused" : "Resumed", true);
    this.showHud(paused ? PAUSED_HUD : store.scrollMode ? SCROLL_HUD : IDLE_HUD);
  }

  /**
   * In scroll mode the cursor stays where it is and tilting the head up or
   * down scrolls the page under it, faster the further the head tilts.
   */
  setScrollMode(on: boolean): void {
    const store = useStore.getState();
    if (store.phase !== "running" || store.scrollMode === on) {
      return;
    }
    this.scrollCarry = 0;
    this.filterX.reset();
    this.filterY.reset();
    store.setRuntime({ scrollMode: on });
    store.logActivity(on ? "Scroll mode on" : "Cursor mode", true);
    this.showHud(on ? SCROLL_HUD : store.paused ? PAUSED_HUD : IDLE_HUD);
  }

  toggleScrollMode(): void {
    this.setScrollMode(!useStore.getState().scrollMode);
  }

  /** Makes the current head position the new "looking straight ahead". */
  recenter(): void {
    const { calibration, setCalibration } = useStore.getState();
    if (!calibration || !this.lastPose) {
      return;
    }
    setCalibration({ ...calibration, neutral: { ...this.lastPose } });
    this.cursor = { x: this.screen.width / 2, y: this.screen.height / 2 };
    this.filterX.reset();
    this.filterY.reset();
  }

  beginCalibration(): void {
    if (!this.active) {
      return;
    }
    this.releaseDrag();
    this.resetGestures();
    const voiceState = useStore.getState().voiceState;
    const withVoice = this.voice !== null && voiceState !== "error";
    this.calibrationRun = {
      steps: withVoice ? [...FACE_STEPS, ...VOICE_STEPS] : FACE_STEPS,
      step: "neutral",
      elapsed: 0,
      count: 0,
      sumX: 0,
      sumY: 0,
      sumJaw: 0,
      sumBrow: 0,
      neutral: { x: 0, y: 0 },
      jawRest: 0,
      browRest: 0,
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
      jawPeak: 0,
      jawSmooth: 0,
      quietLevels: [],
      speakLevels: [],
    };
    useStore.getState().setRuntime({
      phase: "calibrating",
      paused: false,
      scrollMode: false,
      notice: null,
      calibrationStep: "neutral",
      calibrationProgress: 0,
    });
    this.showHud({ tone: "listening", text: "Calibrating…" });
  }

  // --------------------------------------------------------------- frame loop

  private loop = (): void => {
    if (!this.active) {
      return;
    }
    const video = this.video;
    const landmarker = this.landmarker;
    if (
      video &&
      landmarker &&
      video.readyState >= 2 &&
      video.currentTime !== this.lastVideoTime
    ) {
      this.lastVideoTime = video.currentTime;
      const now = performance.now();
      try {
        this.processFrame(landmarker.detectForVideo(video, now), now);
      } catch (error) {
        console.error("Frame processing failed:", error);
      }
    }
    // A timer, not requestAnimationFrame: tracking must continue while another
    // app covers this window.
    this.timer = window.setTimeout(this.loop, 8);
  };

  private processFrame(result: FaceLandmarkerResult, now: number): void {
    const video = this.video;
    if (!video) {
      return;
    }
    const dt = this.lastFrameAt === 0 ? 1 / 30 : (now - this.lastFrameAt) / 1000;
    this.lastFrameAt = now;
    this.frameCount += 1;

    const landmarks = result.faceLandmarks[0];
    const pose = landmarks
      ? headPose(landmarks, video.videoWidth, video.videoHeight)
      : null;

    let jaw = 0;
    let brow = 0;
    for (const shape of result.faceBlendshapes?.[0]?.categories ?? []) {
      if (shape.categoryName === "jawOpen") {
        jaw = shape.score;
      } else if (shape.categoryName === "browInnerUp") {
        brow = shape.score;
      }
    }

    this.drawOverlay(landmarks);

    const gap = landmarks
      ? lipGap(landmarks, video.videoWidth, video.videoHeight)
      : null;
    if (gap !== null) {
      this.lipHistory.push({ t: now, gap });
      while (this.lipHistory.length > 0 && now - this.lipHistory[0].t > LIP_LOOKBACK_MS) {
        this.lipHistory.shift();
      }
      if (this.speaking) {
        this.lipSeen = true;
        this.lipMin = Math.min(this.lipMin, gap);
        this.lipMax = Math.max(this.lipMax, gap);
      }
    }
    if (this.voice) {
      this.micPeak = Math.max(this.micPeak, this.voice.level);
    }

    if (pose) {
      this.lastFaceAt = now;
      this.lastPose = pose;
    }
    const faceVisible = pose !== null && now - this.lastFaceAt < FACE_LOST_MS;

    const state = useStore.getState();
    if (pose) {
      if (this.calibrationRun) {
        this.calibrationFrame(pose, jaw, brow, dt);
      } else if (state.phase === "running" && !state.paused && state.calibration) {
        this.updateCursor(pose, state.calibration, dt, now);
        this.updateGestures(jaw, brow, state.calibration, now);
      }
    }

    if (now - this.lastUiAt >= UI_UPDATE_MS) {
      const seconds = (now - this.fpsWindowStart) / 1000;
      const fps = seconds > 0 ? Math.round(this.frameCount / seconds) : 0;
      if (seconds > 1) {
        this.frameCount = 0;
        this.fpsWindowStart = now;
      }
      this.lastUiAt = now;
      const micPeak = this.micPeak;
      this.micPeak = 0;
      state.setRuntime({
        faceVisible,
        jaw,
        brow,
        micLevel: micPeak,
        micThreshold: this.voice?.threshold ?? 0,
        noisy: this.voice?.noisy ?? false,
        ...(seconds > 1 ? { fps } : {}),
        ...(this.calibrationRun
          ? {
              calibrationStep: this.calibrationRun.step,
              calibrationProgress:
                this.calibrationRun.elapsed /
                CALIBRATION_MS[this.calibrationRun.step],
            }
          : {}),
      });
    }
  }

  // ------------------------------------------------------------------- cursor

  private get frozen(): boolean {
    return this.jawFreezeSince !== null && !this.jawFreezeExpired;
  }

  private updateCursor(
    pose: Point,
    calibration: Calibration,
    dt: number,
    now: number,
  ): void {
    const { settings, scrollMode } = useStore.getState();
    const { width, height } = this.screen;

    // The camera image is not mirrored, so turning the head to the user's
    // right moves the nose towards image-left: flip x.
    const nx = -(pose.x - calibration.neutral.x) / calibration.halfRange.x;
    const ny = (pose.y - calibration.neutral.y) / calibration.halfRange.y;

    const minCutoff = 2.5 - 2.2 * clamp(settings.smoothing, 0, 1);
    this.filterX.minCutoff = minCutoff;
    this.filterY.minCutoff = minCutoff;

    if (scrollMode) {
      this.tiltScroll(this.filterY.filter(ny * 1000, dt) / 1000, dt, settings.sensitivity);
      return;
    }

    if (settings.mode === "joystick") {
      // Head offset sets cursor speed, so a small range of movement can still
      // reach the whole screen.
      const jx = this.filterX.filter(nx * 1000, dt) / 1000;
      const jy = this.filterY.filter(ny * 1000, dt) / 1000;
      const magnitude = Math.hypot(jx, jy);
      if (magnitude > JOYSTICK_DEAD && !this.frozen) {
        const push = Math.min(1, (magnitude - JOYSTICK_DEAD) / (1 - JOYSTICK_DEAD));
        const speed = JOYSTICK_MAX_SPEED * settings.sensitivity * push ** 1.5;
        this.cursor.x += (jx / magnitude) * speed * dt;
        this.cursor.y += (jy / magnitude) * speed * dt;
      }
    } else {
      const reach = settings.sensitivity / RANGE_REACH;
      const targetX = this.filterX.filter(width / 2 + nx * reach * (width / 2), dt);
      const targetY = this.filterY.filter(height / 2 + ny * reach * (height / 2), dt);

      // Dead zone: the cursor is pulled along only once the target is further
      // away than the dead-zone radius, so it stays put while the head is still.
      const dx = targetX - this.cursor.x;
      const dy = targetY - this.cursor.y;
      const distance = Math.hypot(dx, dy);
      if (distance > settings.deadZone && distance > 0) {
        const pull = 1 - settings.deadZone / distance;
        this.cursor.x += dx * pull;
        this.cursor.y += dy * pull;
      }
    }

    this.cursor.x = clamp(this.cursor.x, 0, width - 1);
    this.cursor.y = clamp(this.cursor.y, 0, height - 1);

    if (this.frozen) {
      return;
    }

    this.moveTo(this.cursor);
    this.history.push({ t: now, x: this.cursor.x, y: this.cursor.y });
    while (this.history.length > 0 && now - this.history[0].t > HISTORY_MS) {
      this.history.shift();
    }

    if (settings.dwellClick) {
      this.updateDwell(now, settings.dwellMs);
    }
  }

  private tiltScroll(tilt: number, dt: number, sensitivity: number): void {
    const magnitude = Math.abs(tilt);
    if (magnitude <= TILT_SCROLL_DEAD) {
      this.scrollCarry = 0;
      return;
    }
    const push = Math.min(1, (magnitude - TILT_SCROLL_DEAD) / (1 - TILT_SCROLL_DEAD));
    const speed = TILT_SCROLL_MAX_SPEED * sensitivity * push ** 1.5;
    // Head up (negative tilt) scrolls up, which is a positive scroll amount.
    this.scrollCarry += -Math.sign(tilt) * speed * dt;
    if (Math.abs(this.scrollCarry) >= TILT_SCROLL_STEP) {
      const amount = Math.trunc(this.scrollCarry);
      this.scrollCarry -= amount;
      window.electronAPI?.scroll(amount);
    }
  }

  private moveTo(point: Point): void {
    if (
      Math.abs(point.x - this.sent.x) < 0.5 &&
      Math.abs(point.y - this.sent.y) < 0.5
    ) {
      return;
    }
    this.sent = { x: point.x, y: point.y };
    window.electronAPI?.moveMouse(point.x, point.y);
  }

  /**
   * Puts the cursor back where it was a moment ago. Opening the mouth or
   * starting to speak nudges the head, so the click should land where the user
   * was pointing just before, not where the nudge took the cursor.
   */
  private rewindCursor(now: number, lookbackMs: number): void {
    const cutoff = now - lookbackMs;
    let anchor: Point | null = null;
    for (const entry of this.history) {
      if (entry.t > cutoff) {
        break;
      }
      anchor = entry;
    }
    anchor ??= this.history[0] ?? null;
    if (anchor) {
      this.moveTo(anchor);
    }
  }

  private updateDwell(now: number, dwellMs: number): void {
    const moved =
      Math.hypot(
        this.cursor.x - this.dwellAnchor.x,
        this.cursor.y - this.dwellAnchor.y,
      ) > DWELL_RADIUS;
    if (moved) {
      this.dwellAnchor = { ...this.cursor };
      this.dwellSince = now;
      this.dwellArmed = true;
    } else if (this.dwellArmed && now - this.dwellSince >= dwellMs) {
      this.dwellArmed = false;
      this.click("left", false, "Dwell click");
    }
  }

  // ----------------------------------------------------------------- gestures

  private updateGestures(
    jaw: number,
    brow: number,
    calibration: Calibration,
    now: number,
  ): void {
    const { settings } = useStore.getState();
    const voiceBusy = this.speaking || now < this.speechCooldownUntil;

    if (settings.mouthClick && calibration.mouthUsable) {
      // Hold the cursor still from the moment the mouth starts to open.
      if (jaw > calibration.jawOff) {
        if (this.speaking) {
          // Talking opens the mouth too; the cursor keeps moving during speech.
          this.jawFreezeSince = null;
          this.jawFreezeExpired = false;
        } else if (this.jawFreezeSince === null) {
          this.jawFreezeSince = now;
          this.jawFreezeExpired = false;
          this.rewindCursor(now, JAW_FREEZE_LOOKBACK_MS);
        } else if (now - this.jawFreezeSince > JAW_FREEZE_MAX_MS) {
          // A mouth that simply rests open must not lock the cursor forever.
          this.jawFreezeExpired = true;
        }
      } else {
        this.jawFreezeSince = null;
        this.jawFreezeExpired = false;
        this.jawFired = false;
      }

      if (jaw >= calibration.jawOn && !voiceBusy) {
        this.jawOnSince ??= now;
        if (
          !this.jawFired &&
          now - this.jawOnSince >= MOUTH_HOLD_MS &&
          now >= this.gestureCooldownUntil
        ) {
          this.jawFired = true;
          this.gestureCooldownUntil = now + GESTURE_COOLDOWN_MS;
          this.click("left", false, "Mouth click");
        }
      } else {
        // Talking opens the mouth too; speech always cancels a pending click.
        this.jawOnSince = null;
      }
    } else {
      this.jawFreezeSince = null;
      this.jawOnSince = null;
    }

    if (settings.browRightClick) {
      if (brow >= calibration.browOn && !voiceBusy) {
        this.browOnSince ??= now;
        if (
          !this.browFired &&
          now - this.browOnSince >= BROW_HOLD_MS &&
          now >= this.gestureCooldownUntil
        ) {
          this.browFired = true;
          this.gestureCooldownUntil = now + GESTURE_COOLDOWN_MS;
          this.click("right", false, "Eyebrow right-click");
        }
      } else if (brow < calibration.browOff) {
        this.browOnSince = null;
        this.browFired = false;
      }
    }
  }

  private resetGestures(): void {
    this.jawFreezeSince = null;
    this.jawFreezeExpired = false;
    this.jawOnSince = null;
    this.jawFired = false;
    this.browOnSince = null;
    this.browFired = false;
    this.speaking = false;
    this.dictateNext = false;
    this.dwellArmed = false;
    this.history = [];
    if (this.speechTimeout !== null) {
      window.clearTimeout(this.speechTimeout);
      this.speechTimeout = null;
    }
  }

  private click(button: "left" | "right", double: boolean, label: string): void {
    window.electronAPI?.click(button, double);
    const store = useStore.getState();
    store.setRuntime({ clickTick: store.clickTick + 1 });
    store.logActivity(label, true);
    this.flashHud({ tone: "ok", text: label });
  }

  private releaseDrag(): void {
    if (useStore.getState().dragging) {
      window.electronAPI?.setMouseDown(false);
      useStore.getState().setRuntime({ dragging: false });
    }
  }

  // -------------------------------------------------------------- calibration

  private calibrationFrame(pose: Point, jaw: number, brow: number, dt: number): void {
    const run = this.calibrationRun;
    if (!run) {
      return;
    }
    // Time only advances while a face is visible (this is only called then).
    run.elapsed += dt * 1000;

    if (run.step === "neutral") {
      if (run.elapsed >= NEUTRAL_SETTLE_MS) {
        run.count += 1;
        run.sumX += pose.x;
        run.sumY += pose.y;
        run.sumJaw += jaw;
        run.sumBrow += brow;
      }
    } else if (run.step === "range") {
      const dx = pose.x - run.neutral.x;
      const dy = pose.y - run.neutral.y;
      run.minX = Math.min(run.minX, dx);
      run.maxX = Math.max(run.maxX, dx);
      run.minY = Math.min(run.minY, dy);
      run.maxY = Math.max(run.maxY, dy);
    } else if (run.step === "mouth") {
      // Smooth a little so one noisy frame cannot set the peak.
      run.jawSmooth += (jaw - run.jawSmooth) * 0.4;
      run.jawPeak = Math.max(run.jawPeak, run.jawSmooth);
    } else if (this.voice) {
      (run.step === "quiet" ? run.quietLevels : run.speakLevels).push(
        this.voice.level,
      );
    }

    if (run.elapsed < CALIBRATION_MS[run.step]) {
      return;
    }

    if (run.step === "neutral") {
      if (run.count === 0) {
        run.elapsed = 0;
        return;
      }
      run.neutral = { x: run.sumX / run.count, y: run.sumY / run.count };
      run.jawRest = run.sumJaw / run.count;
      run.browRest = run.sumBrow / run.count;
      run.jawSmooth = run.jawRest;
    }

    const next = run.steps[run.steps.indexOf(run.step) + 1];
    if (next) {
      run.step = next;
      run.elapsed = 0;
      useStore.getState().setRuntime({
        calibrationStep: next,
        calibrationProgress: 0,
      });
      return;
    }

    this.finishCalibration(run);
  }

  private finishCalibration(run: CalibrationRun): void {
    const notices: string[] = [];

    const rangeX = (Math.abs(run.minX) + Math.abs(run.maxX)) / 2;
    const rangeY = (Math.abs(run.minY) + Math.abs(run.maxY)) / 2;
    const moved = rangeX >= MIN_HALF_RANGE && rangeY >= MIN_HALF_RANGE;
    if (!moved) {
      notices.push(
        "Very little head movement was detected, so a standard range is used. Try Joystick mode if reaching the screen edges is hard.",
      );
    }

    const jawTravel = run.jawPeak - run.jawRest;
    const mouthUsable = jawTravel >= MIN_JAW_TRAVEL;
    if (!mouthUsable) {
      notices.push(
        "Mouth opening was too small to detect reliably, so mouth-click is off. Use voice or dwell click instead.",
      );
    }

    // Voice: how loud the room is, and how loud this user is at this mic.
    let voiceProfile: Calibration["voice"] = null;
    if (run.speakLevels.length > 0) {
      const noise = mean(run.quietLevels);
      const speech = percentile(run.speakLevels, 0.9);
      if (speech >= MIN_VOICE_LEVEL && speech >= noise * MIN_VOICE_TO_NOISE) {
        voiceProfile = { noise, speech };
      } else {
        notices.push(
          "Your voice was not clearly louder than the room. Move closer to the microphone or use a headset, then recalibrate. Mouth and dwell click still work.",
        );
      }
    }
    this.voice?.setSpeechLevel(voiceProfile?.speech ?? null);

    const browOn = clamp(run.browRest + 0.3, 0.45, 0.9);
    const calibration: Calibration = {
      neutral: run.neutral,
      halfRange: moved ? { x: rangeX, y: rangeY } : DEFAULT_HALF_RANGE,
      jawOn: run.jawRest + jawTravel * 0.6,
      jawOff: run.jawRest + jawTravel * 0.35,
      browOn,
      browOff: browOn - 0.12,
      mouthUsable,
      voice: voiceProfile,
    };

    this.calibrationRun = null;
    this.cursor = { x: this.screen.width / 2, y: this.screen.height / 2 };
    this.filterX.reset();
    this.filterY.reset();
    this.resetGestures();

    const store = useStore.getState();
    store.setCalibration(calibration);
    store.setRuntime({
      phase: "running",
      calibrationStep: null,
      calibrationProgress: 0,
      notice: notices.length > 0 ? notices.join(" ") : null,
    });
    store.logActivity("Calibration saved", true);
    this.flashHud({ tone: "ok", text: "Calibrated" });
  }

  // -------------------------------------------------------------------- voice

  private syncVoice(): void {
    const wanted = this.active && useStore.getState().settings.voice;
    if (wanted && !this.voice) {
      this.startVoice();
    } else if (!wanted && this.voice) {
      this.stopVoice();
    }
  }

  private startVoice(): void {
    const store = useStore.getState();
    store.setRuntime({ voiceState: "loading", voiceProgress: 0, voiceError: null });

    const voice = new VoiceListener({
      onLoading: (progress) =>
        useStore.getState().setRuntime({ voiceProgress: progress }),
      onReady: () => useStore.getState().setRuntime({ voiceState: "ready" }),
      onSpeechStart: () => this.handleSpeechStart(),
      shouldTranscribe: () => this.lipsMoved(),
      onSpeechEnd: (willTranscribe) => this.handleSpeechEnd(willTranscribe),
      onTranscript: (text) => this.handleTranscript(text),
      onError: (message) => {
        this.endSpeech();
        useStore.getState().setRuntime({ voiceState: "error", voiceError: message });
      },
    });
    this.voice = voice;
    voice.setSpeechLevel(store.calibration?.voice?.speech ?? null);

    voice.start().catch((error: unknown) => {
      if (this.voice !== voice) {
        return;
      }
      this.stopVoice();
      useStore.getState().setRuntime({
        voiceState: "error",
        voiceError:
          error instanceof Error ? error.message : "Microphone unavailable.",
      });
    });
  }

  private stopVoice(): void {
    this.voice?.stop();
    this.voice = null;
    this.endSpeech();
    useStore.getState().setRuntime({ voiceState: "off", voiceError: null });
  }

  private handleSpeechStart(): void {
    const state = useStore.getState();
    this.speaking = true;
    this.jawOnSince = null;
    // Start the lip-movement record from just before the sound began.
    const gaps = this.lipHistory.map((entry) => entry.gap);
    this.lipSeen = gaps.length > 0;
    this.lipMin = gaps.length > 0 ? Math.min(...gaps) : Infinity;
    this.lipMax = gaps.length > 0 ? Math.max(...gaps) : -Infinity;
    state.setRuntime({ voiceState: "listening" });
    if (state.phase === "running") {
      this.showHud({ tone: "listening", text: "Listening…" });
    }
  }

  /**
   * The camera double-checks the microphone: a sound only counts as a command
   * if the user's lips moved while it was heard. This rejects other people
   * talking, music and background noise.
   */
  private lipsMoved(): boolean {
    const state = useStore.getState();
    // During calibration and with no face in view there is nothing to check.
    if (!state.settings.lipGate || !this.lipSeen || state.phase !== "running") {
      return true;
    }
    if (this.lipMax - this.lipMin >= LIP_MOVE_MIN) {
      return true;
    }
    state.logActivity("Ignored a sound (your lips were not moving)", false);
    return false;
  }

  private handleSpeechEnd(willTranscribe: boolean): void {
    if (!willTranscribe) {
      this.endSpeech();
      this.restoreHud();
      return;
    }
    useStore.getState().setRuntime({ voiceState: "transcribing" });
    // Never stay in the speaking state if a transcript fails to arrive.
    if (this.speechTimeout !== null) {
      window.clearTimeout(this.speechTimeout);
    }
    this.speechTimeout = window.setTimeout(() => {
      this.endSpeech();
      this.restoreHud();
    }, TRANSCRIBE_TIMEOUT_MS);
  }

  private endSpeech(): void {
    if (this.speechTimeout !== null) {
      window.clearTimeout(this.speechTimeout);
      this.speechTimeout = null;
    }
    this.speaking = false;
    this.speechCooldownUntil = performance.now() + SPEECH_COOLDOWN_MS;
    const state = useStore.getState();
    if (state.voiceState === "listening" || state.voiceState === "transcribing") {
      state.setRuntime({ voiceState: "ready" });
    }
  }

  private handleTranscript(text: string): void {
    const state = useStore.getState();
    try {
      if (state.phase !== "running" || isNonSpeech(text)) {
        this.restoreHud();
        return;
      }

      if (this.dictateNext && !state.paused) {
        this.dictateNext = false;
        this.runCommand({ kind: "type", text: cleanDictation(text) });
        return;
      }

      const command = parseCommand(text);
      if (!command) {
        const heard = text.trim();
        state.logActivity(`Heard “${heard}” (not a command)`, false);
        this.flashHud({ tone: "warn", text: `Heard “${heard}”` });
        return;
      }

      if (state.paused && command.kind !== "resume") {
        this.showHud(PAUSED_HUD);
        return;
      }

      this.runCommand(command);
    } finally {
      this.endSpeech();
    }
  }

  private runCommand(command: Command): void {
    const api = window.electronAPI;
    const store = useStore.getState();
    const label = describeCommand(command);

    switch (command.kind) {
      case "click":
        this.click("left", false, "Voice: click");
        return;
      case "double-click":
        this.click("left", true, "Voice: double click");
        return;
      case "right-click":
        this.click("right", false, "Voice: right click");
        return;
      case "scroll":
        api?.scroll(command.direction === "up" ? SCROLL_AMOUNT : -SCROLL_AMOUNT);
        break;
      case "scroll-mode":
        this.setScrollMode(command.on);
        return;
      case "type":
        if (command.text.length === 0) {
          return;
        }
        api?.typeText(command.text);
        break;
      case "dictate-next":
        this.dictateNext = true;
        store.logActivity(label, true);
        this.showHud({ tone: "listening", text: "Say the text to type…" });
        return;
      case "key":
        api?.keyTap(command.key);
        break;
      case "hold":
        api?.setMouseDown(true);
        store.setRuntime({ dragging: true });
        break;
      case "drop":
        this.releaseDrag();
        break;
      case "pause":
        this.setPaused(true);
        return;
      case "resume":
        this.setPaused(false);
        return;
      case "recenter":
        this.recenter();
        break;
    }

    store.logActivity(`Voice: ${label.toLowerCase()}`, true);
    this.flashHud({ tone: "ok", text: label });
  }

  // ---------------------------------------------------------------------- HUD

  private showHud(state: HudState): void {
    if (this.hudTimer !== null) {
      window.clearTimeout(this.hudTimer);
      this.hudTimer = null;
    }
    window.electronAPI?.updateHud(state);
  }

  private flashHud(state: HudState): void {
    this.showHud(state);
    this.hudTimer = window.setTimeout(() => this.restoreHud(), HUD_REVERT_MS);
  }

  private restoreHud(): void {
    if (!this.active || this.calibrationRun) {
      return;
    }
    if (this.dictateNext) {
      return;
    }
    const { paused, scrollMode } = useStore.getState();
    this.showHud(paused ? PAUSED_HUD : scrollMode ? SCROLL_HUD : IDLE_HUD);
  }

  // ------------------------------------------------------------------ overlay

  private drawOverlay(landmarks: NormalizedLandmark[] | undefined): void {
    const canvas = this.canvas;
    const video = this.video;
    // Skip drawing while the window is hidden; nobody can see it.
    if (!canvas || !video || document.visibilityState !== "visible") {
      return;
    }
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!landmarks) {
      return;
    }

    const { width, height } = canvas;
    const stroke = (
      connections: Array<{ start: number; end: number }>,
      color: string,
    ): void => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (const { start, end } of connections) {
        const from = landmarks[start];
        const to = landmarks[end];
        if (from && to) {
          ctx.moveTo(from.x * width, from.y * height);
          ctx.lineTo(to.x * width, to.y * height);
        }
      }
      ctx.stroke();
    };

    ctx.lineWidth = 1.5;
    stroke(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, "rgba(34, 211, 238, 0.7)");
    stroke(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, "rgba(167, 243, 208, 0.9)");
    stroke(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, "rgba(167, 243, 208, 0.9)");
    stroke(FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, "rgba(167, 243, 208, 0.7)");
    stroke(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW, "rgba(167, 243, 208, 0.7)");
    stroke(FaceLandmarker.FACE_LANDMARKS_LIPS, "rgba(251, 146, 60, 0.95)");

    const nose = landmarks[NOSE_TIP];
    if (nose) {
      ctx.fillStyle = "rgba(34, 211, 238, 1)";
      ctx.beginPath();
      ctx.arc(nose.x * width, nose.y * height, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export const engine = new OwnMotionEngine();
