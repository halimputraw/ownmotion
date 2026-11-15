import { useStore, type VoiceState } from "../core/store";

const COMMANDS: Array<[string, string]> = [
  ["click", "Left click"],
  ["double click", "Double click"],
  ["right click", "Right click"],
  ["scroll up / down", "Scroll the page one step"],
  ["scroll / cursor", "Tilt your head to scroll, then back to the cursor"],
  ["type …", "Type what you say next"],
  ["enter · delete · tab · escape", "Press that key"],
  ["hold / drop", "Start and end a drag"],
  ["pause / resume", "Stop and restart control"],
  ["recenter", "Reset your resting position"],
];

const STATE_LABEL: Record<VoiceState, string> = {
  off: "Off",
  loading: "Loading speech model…",
  ready: "Ready. Say a command",
  listening: "Listening…",
  transcribing: "Working it out…",
  error: "Unavailable",
};

const STATE_DOT: Record<VoiceState, string> = {
  off: "bg-slate-500",
  loading: "bg-amber-300 animate-pulse",
  ready: "bg-emerald-400",
  listening: "bg-amber-300",
  transcribing: "bg-cyan-300 animate-pulse",
  error: "bg-rose-400",
};

export function VoicePanel() {
  const voiceState = useStore((state) => state.voiceState);
  const progress = useStore((state) => state.voiceProgress);
  const voiceError = useStore((state) => state.voiceError);
  const activity = useStore((state) => state.activity);
  const micLevel = useStore((state) => state.micLevel);
  const micThreshold = useStore((state) => state.micThreshold);
  const noisy = useStore((state) => state.noisy);
  const voiceCalibrated = useStore((state) => Boolean(state.calibration?.voice));
  const micOn = voiceState !== "off" && voiceState !== "error";
  // Loudness is shown on a square-root scale so quiet sounds are still visible.
  const scale = (level: number) => Math.min(1, Math.sqrt(level / 0.3)) * 100;

  return (
    <section className="rounded-xl border border-white/15 bg-black/30 p-4">
      <h2 className="font-display text-xl font-bold text-white">Voice</h2>
      <p
        className="mt-2 flex items-center gap-2 text-lg font-semibold text-white"
        role="status"
      >
        <span className={`h-3 w-3 flex-none rounded-full ${STATE_DOT[voiceState]}`} />
        {STATE_LABEL[voiceState]}
        {voiceState === "loading" && progress > 0 && (
          <span className="text-sm tabular-nums text-cyan-200">
            {Math.round(progress * 100)}%
          </span>
        )}
      </p>
      {voiceState === "loading" && (
        <p className="mt-1 text-sm text-cyan-100/70">
          Downloaded once, then it works offline. Your voice stays on this
          computer.
        </p>
      )}
      {voiceError && <p className="mt-1 text-sm text-rose-300">{voiceError}</p>}

      {micOn && (
        <div className="mt-3">
          <div className="flex justify-between text-sm">
            <span className="font-semibold text-white">Microphone</span>
            <span className="text-cyan-100/60">
              {voiceCalibrated ? "tuned to your voice" : "not calibrated yet"}
            </span>
          </div>
          <div className="relative mt-1 h-3 rounded-full bg-white/15">
            <div
              className={`h-full rounded-full ${
                micLevel > micThreshold ? "bg-emerald-400" : "bg-cyan-300"
              }`}
              style={{ width: `${scale(micLevel)}%` }}
            />
            <div
              className="absolute -top-1 h-5 w-0.5 bg-white"
              style={{ left: `${scale(micThreshold)}%` }}
              title="Sounds louder than this line count as speech"
            />
          </div>
          <p className="mt-1 text-sm text-cyan-100/70">
            The white line rises on its own when the room gets louder.
          </p>
          {noisy && (
            <p className="mt-2 rounded-md bg-amber-300/15 px-2 py-1 text-sm font-semibold text-amber-200">
              It is noisy here. Speak close to the microphone or use a headset.
            </p>
          )}
        </div>
      )}

      <ul className="mt-3 space-y-1" aria-label="Recent activity">
        {activity.length === 0 && (
          <li className="text-sm text-cyan-100/60">
            Clicks and commands will appear here.
          </li>
        )}
        {activity.map((entry) => (
          <li
            key={entry.id}
            className={`truncate text-sm ${
              entry.ok ? "text-emerald-200" : "text-amber-200/90"
            }`}
          >
            {entry.ok ? "✓" : "?"} {entry.text}
          </li>
        ))}
      </ul>

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-white/10 pt-3 text-sm">
        {COMMANDS.map(([phrase, meaning]) => (
          <div key={phrase} className="contents">
            <dt className="font-semibold text-cyan-200">“{phrase}”</dt>
            <dd className="text-cyan-50/80">{meaning}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
