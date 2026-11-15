import type { TapKey } from "../types/electron-api";

export type Command =
  | { kind: "click" }
  | { kind: "double-click" }
  | { kind: "right-click" }
  | { kind: "scroll"; direction: "up" | "down" }
  | { kind: "scroll-mode"; on: boolean }
  | { kind: "type"; text: string }
  | { kind: "dictate-next" }
  | { kind: "key"; key: TapKey }
  | { kind: "hold" }
  | { kind: "drop" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "recenter" };

// Short words are easy for a speech model to mishear, so each command accepts
// the spellings Whisper commonly produces for it.
const PHRASES: Array<[Command, string[]]> = [
  [{ kind: "double-click" }, ["double click", "double clique", "double-click"]],
  [
    { kind: "right-click" },
    ["right click", "write click", "right clique", "right-click"],
  ],
  [{ kind: "click" }, ["click", "clique", "clicks", "klick", "select", "tap"]],
  [
    { kind: "scroll", direction: "down" },
    ["scroll down", "scrolled down", "scroll town", "page down", "go down"],
  ],
  [
    { kind: "scroll", direction: "up" },
    ["scroll up", "scrolled up", "page up", "go up"],
  ],
  [
    { kind: "scroll-mode", on: true },
    ["scroll", "scroll mode", "scrolling", "start scrolling", "head scroll"],
  ],
  [
    { kind: "scroll-mode", on: false },
    ["cursor", "cursor mode", "stop scrolling", "done", "pointer"],
  ],
  [{ kind: "key", key: "enter" }, ["enter", "return", "submit", "press enter"]],
  [
    { kind: "key", key: "backspace" },
    ["delete", "backspace", "back space", "press delete"],
  ],
  [{ kind: "key", key: "escape" }, ["escape", "cancel", "press escape"]],
  [{ kind: "key", key: "tab" }, ["tab", "next field", "press tab"]],
  [{ kind: "key", key: "space" }, ["space", "spacebar", "press space"]],
  [{ kind: "hold" }, ["hold", "drag", "grab", "hold it"]],
  [{ kind: "drop" }, ["drop", "release", "let go", "drop it"]],
  [{ kind: "pause" }, ["pause", "stop", "freeze", "pause own motion"]],
  [
    { kind: "resume" },
    ["resume", "continue", "unpause", "start", "resume own motion"],
  ],
  [
    { kind: "recenter" },
    ["recenter", "re-center", "re center", "center", "reset", "recentre"],
  ],
];

const LOOKUP = new Map<string, Command>();
for (const [command, phrases] of PHRASES) {
  for (const phrase of phrases) {
    LOOKUP.set(phrase.replace(/-/g, " "), command);
  }
}

const TYPE_PREFIX = /^\s*(type|dictate|write)\b[\s,:.]*/i;

/** Lowercases and strips punctuation so "Click." and "click" match. */
export const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/-/g, " ")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Cleans a transcript for typing: no wrapping space, no trailing full stop. */
export const cleanDictation = (text: string): string =>
  text
    .trim()
    .replace(/[.。]+$/, "")
    .trim();

/** Whisper emits tags like "[BLANK_AUDIO]" or "(music)" for non-speech. */
export const isNonSpeech = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed.length === 0 || /^[[(].*[\])]$/.test(trimmed);
};

export const parseCommand = (transcript: string): Command | null => {
  if (isNonSpeech(transcript)) {
    return null;
  }

  const phrase = normalize(transcript);
  const exact = LOOKUP.get(phrase);
  if (exact) {
    return exact;
  }

  const typeMatch = TYPE_PREFIX.exec(transcript);
  if (typeMatch) {
    const text = cleanDictation(transcript.slice(typeMatch[0].length));
    return text.length > 0 ? { kind: "type", text } : { kind: "dictate-next" };
  }

  return null;
};

export const describeCommand = (command: Command): string => {
  switch (command.kind) {
    case "click":
      return "Click";
    case "double-click":
      return "Double click";
    case "right-click":
      return "Right click";
    case "scroll":
      return `Scroll ${command.direction}`;
    case "scroll-mode":
      return command.on ? "Scroll mode on" : "Cursor mode";
    case "type":
      return `Type "${command.text}"`;
    case "dictate-next":
      return "Type… (say the text)";
    case "key":
      return `Press ${command.key}`;
    case "hold":
      return "Hold (drag started)";
    case "drop":
      return "Drop (drag ended)";
    case "pause":
      return "Paused";
    case "resume":
      return "Resumed";
    case "recenter":
      return "Recentered";
  }
};
