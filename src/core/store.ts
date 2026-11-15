import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ControlMode = "direct" | "joystick";

export type Settings = {
  mode: ControlMode;
  /** Multiplier on cursor travel (direct) or speed (joystick). */
  sensitivity: number;
  /** 0 = snappy, 1 = very steady. */
  smoothing: number;
  /** Radius in pixels inside which small head movements are ignored. */
  deadZone: number;
  mouthClick: boolean;
  browRightClick: boolean;
  dwellClick: boolean;
  dwellMs: number;
  voice: boolean;
  /** Only accept speech while the camera sees the user's lips moving. */
  lipGate: boolean;
};

export type Calibration = {
  /** Head pose while looking straight at the screen. */
  neutral: { x: number; y: number };
  /** Comfortable head travel from neutral, in pose units. */
  halfRange: { x: number; y: number };
  jawOn: number;
  jawOff: number;
  browOn: number;
  browOff: number;
  /** False when the user's mouth opening was too small to detect reliably. */
  mouthUsable: boolean;
  /** Microphone loudness of the room and of the user's voice, if measured. */
  voice?: { noise: number; speech: number } | null;
};

export type CalibrationStep = "neutral" | "range" | "mouth" | "quiet" | "speak";

export type Phase = "idle" | "starting" | "calibrating" | "running" | "error";

export type VoiceState =
  | "off"
  | "loading"
  | "ready"
  | "listening"
  | "transcribing"
  | "error";

export type ActivityEntry = { id: number; text: string; ok: boolean };

type Runtime = {
  phase: Phase;
  error: string | null;
  notice: string | null;
  accessibilityGranted: boolean;
  faceVisible: boolean;
  paused: boolean;
  dragging: boolean;
  /** While on, tilting the head up or down scrolls instead of moving the cursor. */
  scrollMode: boolean;
  calibrationStep: CalibrationStep | null;
  calibrationProgress: number;
  jaw: number;
  brow: number;
  fps: number;
  voiceState: VoiceState;
  voiceProgress: number;
  voiceError: string | null;
  micLevel: number;
  micThreshold: number;
  noisy: boolean;
  activity: ActivityEntry[];
  clickTick: number;
};

type Store = Runtime & {
  settings: Settings;
  calibration: Calibration | null;
  updateSettings: (patch: Partial<Settings>) => void;
  setCalibration: (calibration: Calibration | null) => void;
  setRuntime: (patch: Partial<Runtime>) => void;
  logActivity: (text: string, ok: boolean) => void;
};

export const DEFAULT_SETTINGS: Settings = {
  mode: "direct",
  sensitivity: 1,
  smoothing: 0.6,
  deadZone: 6,
  mouthClick: true,
  browRightClick: false,
  dwellClick: false,
  dwellMs: 1200,
  voice: true,
  lipGate: true,
};

const INITIAL_RUNTIME: Runtime = {
  phase: "idle",
  error: null,
  notice: null,
  accessibilityGranted: true,
  faceVisible: false,
  paused: false,
  dragging: false,
  scrollMode: false,
  calibrationStep: null,
  calibrationProgress: 0,
  jaw: 0,
  brow: 0,
  fps: 0,
  voiceState: "off",
  voiceProgress: 0,
  voiceError: null,
  micLevel: 0,
  micThreshold: 0,
  noisy: false,
  activity: [],
  clickTick: 0,
};

let activityId = 0;

export const useStore = create<Store>()(
  persist(
    (set) => ({
      ...INITIAL_RUNTIME,
      settings: DEFAULT_SETTINGS,
      calibration: null,
      updateSettings: (patch) =>
        set((state) => ({ settings: { ...state.settings, ...patch } })),
      setCalibration: (calibration) => set({ calibration }),
      setRuntime: (patch) => set(patch),
      logActivity: (text, ok) =>
        set((state) => ({
          activity: [{ id: ++activityId, text, ok }, ...state.activity].slice(
            0,
            6,
          ),
        })),
    }),
    {
      name: "gestura-profile",
      version: 1,
      // Only the user's profile survives a restart; live status never does.
      partialize: (state) => ({
        settings: state.settings,
        calibration: state.calibration,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<Store>;
        return {
          ...current,
          settings: { ...DEFAULT_SETTINGS, ...saved.settings },
          calibration: saved.calibration ?? null,
        };
      },
    },
  ),
);
