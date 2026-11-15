import type { ReactNode } from "react";
import { useStore, type ControlMode } from "../core/store";

function Slider(props: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between">
        <span className="text-base font-semibold text-white">{props.label}</span>
        <span className="text-sm tabular-nums text-cyan-200">{props.display}</span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
        className="mt-1 h-6 w-full accent-cyan-300"
      />
      <span className="block text-sm text-cyan-100/70">{props.hint}</span>
    </label>
  );
}

function Toggle(props: {
  label: string;
  hint: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex items-start gap-3 ${props.disabled ? "opacity-50" : ""}`}
    >
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
        className="mt-1 h-5 w-5 flex-none accent-cyan-300"
      />
      <span>
        <span className="block text-base font-semibold text-white">
          {props.label}
        </span>
        <span className="block text-sm text-cyan-100/70">{props.hint}</span>
      </span>
    </label>
  );
}

const MODES: Array<{ id: ControlMode; label: string; hint: string }> = [
  {
    id: "direct",
    label: "Direct",
    hint: "The cursor goes where your head points.",
  },
  {
    id: "joystick",
    label: "Joystick",
    hint: "Lean your head to steer. Good for a small range of movement.",
  },
];

export function SettingsPanel() {
  const settings = useStore((state) => state.settings);
  const update = useStore((state) => state.updateSettings);
  const mouthUsable = useStore((state) => state.calibration?.mouthUsable ?? true);
  const activeMode = MODES.find((mode) => mode.id === settings.mode) ?? MODES[0];

  return (
    <section className="rounded-xl border border-white/15 bg-black/30 p-4">
      <h2 className="font-display text-xl font-bold text-white">Settings</h2>

      <div className="mt-3">
        <div
          className="grid grid-cols-2 gap-1 rounded-lg bg-white/10 p-1"
          role="radiogroup"
          aria-label="Control mode"
        >
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={settings.mode === mode.id}
              onClick={() => update({ mode: mode.id })}
              className={`rounded-md px-3 py-2 text-base font-bold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-100 ${
                settings.mode === mode.id
                  ? "bg-cyan-300 text-slate-950"
                  : "text-cyan-50 hover:bg-white/10"
              }`}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-sm text-cyan-100/70">{activeMode.hint}</p>
      </div>

      <div className="mt-4 space-y-4">
        <Slider
          label="Sensitivity"
          hint="How far the cursor travels for the same head movement."
          value={settings.sensitivity}
          min={0.1}
          max={2.5}
          step={0.05}
          display={`${settings.sensitivity.toFixed(2)}×`}
          onChange={(sensitivity) => update({ sensitivity })}
        />
        <Slider
          label="Steadiness"
          hint="Higher is smoother but slightly slower to react."
          value={settings.smoothing}
          min={0}
          max={1}
          step={0.05}
          display={`${Math.round(settings.smoothing * 100)}%`}
          onChange={(smoothing) => update({ smoothing })}
        />
        <Slider
          label="Dead zone"
          hint="Small movements inside this radius are ignored."
          value={settings.deadZone}
          min={0}
          max={40}
          step={1}
          display={`${settings.deadZone}px`}
          onChange={(deadZone) => update({ deadZone })}
        />
      </div>

      <div className="mt-5 space-y-3 border-t border-white/10 pt-4">
        <Toggle
          label="Voice commands"
          hint="Say “click”, “scroll down”, “type hello”…"
          checked={settings.voice}
          onChange={(voice) => update({ voice })}
        />
        <Toggle
          label="Only listen when my lips move"
          hint="The camera checks it is you speaking, so other voices and noise are ignored."
          checked={settings.lipGate}
          disabled={!settings.voice}
          onChange={(lipGate) => update({ lipGate })}
        />
        <Toggle
          label="Open mouth to click"
          hint={
            mouthUsable
              ? "Ignored automatically while you are speaking."
              : "Not available: recalibrate to try again."
          }
          checked={settings.mouthClick && mouthUsable}
          disabled={!mouthUsable}
          onChange={(mouthClick) => update({ mouthClick })}
        />
        <Toggle
          label="Raise eyebrows to right-click"
          hint="Hold your eyebrows up for a moment."
          checked={settings.browRightClick}
          onChange={(browRightClick) => update({ browRightClick })}
        />
        <Toggle
          label="Dwell click"
          hint="Hold the cursor still to click. Needs no gesture or voice."
          checked={settings.dwellClick}
          onChange={(dwellClick) => update({ dwellClick })}
        />
        {settings.dwellClick && (
          <Slider
            label="Dwell time"
            hint="How long to hold still before the click."
            value={settings.dwellMs}
            min={600}
            max={3000}
            step={100}
            display={`${(settings.dwellMs / 1000).toFixed(1)}s`}
            onChange={(dwellMs) => update({ dwellMs })}
          />
        )}
      </div>
    </section>
  );
}
