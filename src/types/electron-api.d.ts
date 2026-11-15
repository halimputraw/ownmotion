export {};

export type HudState = {
  visible?: boolean;
  tone: "idle" | "listening" | "ok" | "warn" | "paused";
  text: string;
};

export type TapKey = "enter" | "backspace" | "escape" | "tab" | "space";

declare global {
  interface Window {
    electronAPI?: {
      moveMouse: (x: number, y: number) => void;
      click: (button?: "left" | "right", double?: boolean) => void;
      setMouseDown: (down: boolean) => void;
      scroll: (amount: number) => void;
      typeText: (text: string) => void;
      keyTap: (key: TapKey) => void;
      updateHud: (state: HudState) => void;
      onHudState: (listener: (state: HudState) => void) => void;
      onTogglePause: (listener: () => void) => () => void;
      getScreenSize: () => Promise<{ width: number; height: number }>;
      getAccessibilityStatus: () => Promise<boolean>;
      requestAccessibilityPermission: () => Promise<boolean>;
      requestMediaAccess: (kind: "camera" | "microphone") => Promise<boolean>;
    };
  }
}
