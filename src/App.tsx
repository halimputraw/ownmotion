import { useEffect, useRef } from "react";
import { CalibrationOverlay } from "./components/CalibrationOverlay";
import { GestureMeters } from "./components/GestureMeters";
import { SettingsPanel } from "./components/SettingsPanel";
import { VoicePanel } from "./components/VoicePanel";
import { engine } from "./core/engine";
import { useStore } from "./core/store";

const BUTTON =
  "rounded-lg border-2 px-5 py-3 text-lg font-bold transition focus:outline-none focus-visible:ring-4 focus-visible:ring-cyan-100 disabled:cursor-not-allowed disabled:opacity-40";
const PRIMARY = `${BUTTON} border-cyan-200 bg-cyan-300/95 text-slate-950 hover:bg-cyan-200`;
const SECONDARY = `${BUTTON} border-white/30 bg-white/5 text-white hover:bg-white/15`;

function useStatusText(): string {
  const phase = useStore((state) => state.phase);
  const paused = useStore((state) => state.paused);
  const faceVisible = useStore((state) => state.faceVisible);
  const dragging = useStore((state) => state.dragging);
  const scrollMode = useStore((state) => state.scrollMode);

  if (phase === "idle") {
    return "Ready to start";
  }
  if (phase === "starting") {
    return "Starting camera…";
  }
  if (phase === "error") {
    return "Camera error";
  }
  if (phase === "calibrating") {
    return "Calibrating";
  }
  if (paused) {
    return "Paused";
  }
  if (!faceVisible) {
    return "Face not found";
  }
  if (scrollMode) {
    return "Scroll mode";
  }
  return dragging ? "Dragging" : "Tracking active";
}

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const phase = useStore((state) => state.phase);
  const paused = useStore((state) => state.paused);
  const scrollMode = useStore((state) => state.scrollMode);
  const error = useStore((state) => state.error);
  const notice = useStore((state) => state.notice);
  const accessibilityGranted = useStore((state) => state.accessibilityGranted);
  const hasProfile = useStore((state) => state.calibration !== null);
  const clickTick = useStore((state) => state.clickTick);
  const statusText = useStatusText();

  useEffect(() => () => engine.stop(), []);

  const live = phase === "running" || phase === "calibrating";
  const busy = phase === "starting";

  const start = () => {
    if (videoRef.current && canvasRef.current) {
      void engine.start(videoRef.current, canvasRef.current);
    }
  };

  return (
    <main className="relative min-h-screen overflow-hidden bg-ink text-mist">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_25%,rgba(0,189,167,0.26),transparent_36%),radial-gradient(circle_at_78%_18%,rgba(255,141,82,0.2),transparent_34%),linear-gradient(160deg,#040709_0%,#0a1014_40%,#11171f_100%)]" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 pb-6 pt-5 md:px-8">
        <header className="mb-5 flex flex-col gap-4 rounded-xl border border-white/15 bg-black/20 p-4 backdrop-blur-md lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-tight text-white md:text-4xl">
              OwnMotion
            </h1>
            <p className="mt-1 text-lg text-cyan-100/95">
              Your head points. Your voice acts.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            {live ? (
              <>
                <button
                  type="button"
                  className={PRIMARY}
                  disabled={phase !== "running"}
                  onClick={() => engine.togglePause()}
                >
                  {paused ? "Resume" : "Pause"}
                </button>
                <button
                  type="button"
                  className={SECONDARY}
                  disabled={phase !== "running"}
                  aria-pressed={scrollMode}
                  onClick={() => engine.toggleScrollMode()}
                >
                  {scrollMode ? "Cursor mode" : "Scroll mode"}
                </button>
                <button
                  type="button"
                  className={SECONDARY}
                  disabled={phase !== "running"}
                  onClick={() => engine.recenter()}
                >
                  Recenter
                </button>
                <button
                  type="button"
                  className={SECONDARY}
                  onClick={() => engine.beginCalibration()}
                >
                  Recalibrate
                </button>
                <button
                  type="button"
                  className={SECONDARY}
                  onClick={() => engine.stop()}
                >
                  Stop
                </button>
              </>
            ) : (
              <button type="button" className={PRIMARY} disabled={busy} onClick={start}>
                {busy ? "Starting…" : hasProfile ? "Start" : "Start calibration"}
              </button>
            )}
          </div>
        </header>

        <div className="grid flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="relative flex min-h-[55vh] items-center justify-center overflow-hidden rounded-2xl border border-white/20 bg-black/30">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
            />
            <canvas
              ref={canvasRef}
              className="pointer-events-none absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
            />

            {!live && !busy && (
              <div className="relative max-w-lg px-6 text-center">
                <p className="font-display text-2xl font-bold text-white">
                  Control your computer without your hands
                </p>
                <p className="mt-2 text-lg text-cyan-50/85">
                  {hasProfile
                    ? "Your calibration is saved. Press Start to begin."
                    : "A 20-second calibration learns how you move and speak, then you are ready."}
                </p>
              </div>
            )}

            <div
              className="pointer-events-none absolute left-4 top-4 max-w-md rounded-lg border border-emerald-200/30 bg-black/70 px-4 py-3 backdrop-blur-sm"
              role="status"
              aria-live="polite"
            >
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-cyan-200">
                Status
              </p>
              <p className="text-2xl font-bold text-white">{statusText}</p>
              {error && <p className="mt-2 text-base text-rose-300">{error}</p>}
              {!accessibilityGranted && (
                <p className="mt-2 text-base text-amber-200">
                  Cursor control needs Accessibility permission. Enable it in
                  System Settings › Privacy &amp; Security › Accessibility, then
                  restart OwnMotion.
                </p>
              )}
              {notice && phase === "running" && (
                <p className="mt-2 text-base text-amber-200">{notice}</p>
              )}
              {phase === "running" && (
                <p className="mt-2 text-sm text-cyan-100/70">
                  Press ⌘⇧G in any app to pause or resume.
                </p>
              )}
            </div>

            <div
              key={clickTick}
              className={`absolute left-1/2 top-1/2 h-14 w-14 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-cyan-200/80 ${
                clickTick > 0 ? "animate-ripple" : "opacity-0"
              }`}
              aria-hidden="true"
            />

            <CalibrationOverlay />
          </div>

          <aside className="flex flex-col gap-4">
            <VoicePanel />
            <GestureMeters />
            <SettingsPanel />
          </aside>
        </div>
      </div>
    </main>
  );
}

export default App;
