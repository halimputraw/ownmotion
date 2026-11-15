import { useStore, type CalibrationStep } from "../core/store";

const STEPS: Record<CalibrationStep, { title: string; hint: string }> = {
  neutral: {
    title: "Look straight at the screen",
    hint: "Sit comfortably and hold still. This becomes your resting position.",
  },
  range: {
    title: "Move your head as far as is comfortable",
    hint: "Slowly look left, right, up and down. Only go as far as feels easy.",
  },
  mouth: {
    title: "Open your mouth wide, then close it",
    hint: "Do it once or twice. This sets how far you need to open to click.",
  },
  quiet: {
    title: "Stay quiet for a moment",
    hint: "Measuring the background noise in this room.",
  },
  speak: {
    title: "Say “click” three times",
    hint: "Speak the way you normally would. This sets how loud your voice is here.",
  },
};

const FACE_STEPS: CalibrationStep[] = ["neutral", "range", "mouth"];
const VOICE_STEPS: CalibrationStep[] = ["quiet", "speak"];

export function CalibrationOverlay() {
  const step = useStore((state) => state.calibrationStep);
  const progress = useStore((state) => state.calibrationProgress);
  const faceVisible = useStore((state) => state.faceVisible);
  const voiceAvailable = useStore(
    (state) => state.voiceState !== "off" && state.voiceState !== "error",
  );

  if (!step) {
    return null;
  }

  const ORDER =
    voiceAvailable || VOICE_STEPS.includes(step)
      ? [...FACE_STEPS, ...VOICE_STEPS]
      : FACE_STEPS;
  const index = ORDER.indexOf(step);
  const { title, hint } = STEPS[step];

  return (
    <div
      className="absolute inset-x-4 bottom-4 rounded-xl border border-cyan-200/40 bg-black/80 p-5 backdrop-blur-md md:inset-x-8 md:bottom-8"
      role="status"
      aria-live="polite"
    >
      <p className="text-sm font-semibold uppercase tracking-[0.16em] text-cyan-200">
        Calibration · step {index + 1} of {ORDER.length}
      </p>
      <p className="mt-1 font-display text-2xl font-bold text-white md:text-3xl">
        {title}
      </p>
      <p className="mt-1 text-lg text-cyan-50/90">
        {faceVisible ? hint : "Waiting to see your face…"}
      </p>
      <div className="mt-4 flex gap-2">
        {ORDER.map((name, i) => (
          <div
            key={name}
            className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/15"
          >
            <div
              className="h-full rounded-full bg-cyan-300"
              style={{
                width: `${
                  i < index ? 100 : i === index ? Math.min(progress, 1) * 100 : 0
                }%`,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
