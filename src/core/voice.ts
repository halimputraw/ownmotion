import type { WorkerRequest, WorkerResponse } from "./whisper.worker";

// Microphone capture, voice activity detection and transcription.
//
// Audio arrives in 32 ms blocks. A block counts as voiced when its loudness is
// well above the measured background noise. A few voiced blocks in a row open
// an utterance; a short silence closes it and sends it to the Whisper worker.

const SAMPLE_RATE = 16000;
const BLOCK_SECONDS = 512 / SAMPLE_RATE;
const START_BLOCKS = 3;
const END_BLOCKS = 15;
const PREROLL_BLOCKS = 10;
const MIN_VOICED_BLOCKS = 5;
const MAX_UTTERANCE_SECONDS = 8;
const MIN_THRESHOLD = 0.012;
const MIN_CALIBRATED_THRESHOLD = 0.004;
const NOISE_MULTIPLIER = 3;
/** Speech must reach this fraction of the user's calibrated speaking level. */
const SPEECH_FLOOR = 0.3;
/** The threshold never rises above this fraction, so speech can still get through. */
const SPEECH_CEILING = 0.7;
const UNCALIBRATED_NOISY_LEVEL = 0.03;

export type VoiceEvents = {
  onLoading: (progress: number) => void;
  onReady: () => void;
  onSpeechStart: () => void;
  /** Asked when an utterance ends; return false to discard it unheard. */
  shouldTranscribe: () => boolean;
  /** `willTranscribe` is false when the sound was too short to be a command. */
  onSpeechEnd: (willTranscribe: boolean) => void;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
};

const rms = (block: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < block.length; i += 1) {
    sum += block[i] * block[i];
  }
  return Math.sqrt(sum / block.length);
};

const concat = (blocks: Float32Array[]): Float32Array => {
  const total = blocks.reduce((length, block) => length + block.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const block of blocks) {
    merged.set(block, offset);
    offset += block.length;
  }
  return merged;
};

export class VoiceListener {
  private readonly events: VoiceEvents;
  private worker: Worker | null = null;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private modelReady = false;
  private noiseFloor = 0.004;
  private preroll: Float32Array[] = [];
  private utterance: Float32Array[] | null = null;
  private voicedRun = 0;
  private silentRun = 0;
  private voicedBlocks = 0;
  private nextId = 0;
  private speechLevel: number | null = null;
  private levelSum = 0;

  /** Loudness of the most recent audio block. */
  level = 0;

  constructor(events: VoiceEvents) {
    this.events = events;
  }

  /**
   * Sets how loud this user's voice is at this microphone (from calibration),
   * or null to rely on background-noise tracking alone.
   */
  setSpeechLevel(level: number | null): void {
    this.speechLevel = level;
  }

  /** Loudness a sound must exceed to count as speech right now. */
  get threshold(): number {
    const aboveNoise = this.noiseFloor * NOISE_MULTIPLIER;
    if (this.speechLevel === null) {
      return Math.max(MIN_THRESHOLD, aboveNoise);
    }
    // Rise with the room's noise, but never past the user's own voice.
    return Math.min(
      Math.max(MIN_CALIBRATED_THRESHOLD, aboveNoise, this.speechLevel * SPEECH_FLOOR),
      this.speechLevel * SPEECH_CEILING,
    );
  }

  /** True when background noise is close to drowning out the user's voice. */
  get noisy(): boolean {
    return this.speechLevel === null
      ? this.noiseFloor > UNCALIBRATED_NOISY_LEVEL
      : this.noiseFloor * NOISE_MULTIPLIER > this.speechLevel * SPEECH_CEILING;
  }

  async start(): Promise<void> {
    await window.electronAPI?.requestMediaAccess("microphone");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    this.worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) =>
      this.handleWorkerMessage(event.data);
    this.worker.onerror = (event) =>
      this.events.onError(event.message || "Speech worker crashed.");
    this.events.onLoading(0);
    this.send({ type: "load" });

    this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
    await this.context.audioWorklet.addModule(
      new URL("vad-worklet.js", document.baseURI).href,
    );
    const source = this.context.createMediaStreamSource(this.stream);
    // Cut rumble and mains hum (fans, air conditioning, traffic) below speech.
    const highpass = this.context.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 110;
    const node = new AudioWorkletNode(this.context, "chunk-forwarder");
    node.port.onmessage = (event: MessageEvent<Float32Array>) =>
      this.handleBlock(event.data);
    source.connect(highpass).connect(node);
  }

  stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.context?.close();
    this.context = null;
    this.worker?.terminate();
    this.worker = null;
    this.modelReady = false;
    this.utterance = null;
    this.preroll = [];
  }

  private send(request: WorkerRequest): void {
    this.worker?.postMessage(request);
  }

  private handleWorkerMessage(message: WorkerResponse): void {
    switch (message.type) {
      case "progress":
        if (!this.modelReady) {
          this.events.onLoading(message.progress);
        }
        break;
      case "ready":
        this.modelReady = true;
        this.events.onReady();
        break;
      case "result":
        this.events.onTranscript(message.text);
        break;
      case "error":
        this.events.onError(message.message);
        break;
    }
  }

  private handleBlock(block: Float32Array): void {
    const level = rms(block);
    this.level = level;
    const voiced = level > this.threshold;

    if (this.utterance === null) {
      // Track background noise: fall quickly, rise slowly.
      const rate = level < this.noiseFloor ? 0.2 : 0.02;
      this.noiseFloor += (level - this.noiseFloor) * rate;

      if (!this.modelReady) {
        return;
      }

      this.preroll.push(block);
      if (this.preroll.length > PREROLL_BLOCKS) {
        this.preroll.shift();
      }

      this.voicedRun = voiced ? this.voicedRun + 1 : 0;
      if (this.voicedRun >= START_BLOCKS) {
        this.utterance = this.preroll;
        this.preroll = [];
        this.voicedBlocks = this.voicedRun;
        this.levelSum = 0;
        this.silentRun = 0;
        this.voicedRun = 0;
        this.events.onSpeechStart();
      }
      return;
    }

    this.utterance.push(block);
    this.levelSum += level;
    if (voiced) {
      this.voicedBlocks += 1;
      this.silentRun = 0;
    } else {
      this.silentRun += 1;
    }

    const seconds = this.utterance.length * BLOCK_SECONDS;
    const ranTooLong = seconds >= MAX_UTTERANCE_SECONDS;
    if (this.silentRun >= END_BLOCKS || ranTooLong) {
      const blocks = this.utterance;
      this.utterance = null;
      if (ranTooLong) {
        // A sound that never pauses is the room getting louder, not a command:
        // learn it as the new background level so the next command stands out.
        this.noiseFloor = this.levelSum / blocks.length;
      }
      const longEnough =
        !ranTooLong &&
        this.voicedBlocks >= MIN_VOICED_BLOCKS &&
        this.events.shouldTranscribe();
      this.events.onSpeechEnd(longEnough);
      if (longEnough) {
        const audio = concat(blocks);
        this.nextId += 1;
        this.worker?.postMessage(
          { type: "transcribe", id: this.nextId, audio },
          [audio.buffer],
        );
      }
    }
  }
}
