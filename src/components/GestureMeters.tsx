import { useStore } from "../core/store";

function Meter(props: { label: string; value: number; threshold: number | null }) {
  const active = props.threshold !== null && props.value >= props.threshold;
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="font-semibold text-white">{props.label}</span>
        <span className={active ? "font-bold text-emerald-300" : "text-cyan-100/60"}>
          {active ? "triggered" : ""}
        </span>
      </div>
      <div className="relative mt-1 h-3 rounded-full bg-white/15">
        <div
          className={`h-full rounded-full ${active ? "bg-emerald-400" : "bg-cyan-300"}`}
          style={{ width: `${Math.min(props.value, 1) * 100}%` }}
        />
        {props.threshold !== null && (
          <div
            className="absolute -top-1 h-5 w-0.5 bg-white"
            style={{ left: `${Math.min(props.threshold, 1) * 100}%` }}
            title="Your trigger level"
          />
        )}
      </div>
    </div>
  );
}

export function GestureMeters() {
  const jaw = useStore((state) => state.jaw);
  const brow = useStore((state) => state.brow);
  const fps = useStore((state) => state.fps);
  const calibration = useStore((state) => state.calibration);

  return (
    <section className="rounded-xl border border-white/15 bg-black/30 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-xl font-bold text-white">Gestures</h2>
        <span className="text-sm tabular-nums text-cyan-100/60">{fps} fps</span>
      </div>
      <p className="mt-1 text-sm text-cyan-100/70">
        The white line is your personal trigger level from calibration.
      </p>
      <div className="mt-3 space-y-3">
        <Meter
          label="Mouth open"
          value={jaw}
          threshold={calibration?.mouthUsable ? calibration.jawOn : null}
        />
        <Meter
          label="Eyebrows raised"
          value={brow}
          threshold={calibration?.browOn ?? null}
        />
      </div>
    </section>
  );
}
