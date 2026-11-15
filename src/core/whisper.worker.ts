/// <reference lib="webworker" />
import {
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";

// Speech recognition runs here, off the main thread, so transcription never
// stalls face tracking. The model is downloaded once and cached by the
// browser; after that it works offline and audio never leaves the machine.

export type WorkerRequest =
  | { type: "load" }
  | { type: "transcribe"; id: number; audio: Float32Array };

export type WorkerResponse =
  | { type: "progress"; progress: number }
  | { type: "ready"; device: string }
  | { type: "result"; id: number; text: string }
  | { type: "error"; id?: number; message: string };

const MODEL = "onnx-community/whisper-base.en";

let recognizer: AutomaticSpeechRecognitionPipeline | null = null;
let queue: Promise<void> = Promise.resolve();

const post = (message: WorkerResponse): void => {
  self.postMessage(message);
};

const reportProgress = (event: unknown): void => {
  const info = event as { status?: string; progress?: number };
  if (info.status === "progress" && typeof info.progress === "number") {
    post({ type: "progress", progress: info.progress / 100 });
  }
};

const hasWebGpu = async (): Promise<boolean> => {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } })
    .gpu;
  if (!gpu) {
    return false;
  }
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
};

const load = async (): Promise<void> => {
  const attempts: Array<{ device: "webgpu" | "wasm"; dtype: object | string }> =
    [];
  if (await hasWebGpu()) {
    attempts.push({
      device: "webgpu",
      dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
    });
  }
  attempts.push({ device: "wasm", dtype: "q8" });

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      recognizer = (await pipeline("automatic-speech-recognition", MODEL, {
        device: attempt.device,
        dtype: attempt.dtype as never,
        progress_callback: reportProgress,
      })) as AutomaticSpeechRecognitionPipeline;
      // Warm up so the first real command is not slow.
      await recognizer(new Float32Array(16000));
      post({ type: "ready", device: attempt.device });
      return;
    } catch (error) {
      lastError = error;
      recognizer = null;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Speech model failed to load.");
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  if (request.type === "load") {
    load().catch((error: unknown) => {
      post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }

  if (!recognizer) {
    post({ type: "error", id: request.id, message: "Speech model not ready." });
    return;
  }

  // One utterance at a time, in the order they were spoken.
  const active = recognizer;
  queue = queue.then(async () => {
    try {
      const output = await active(request.audio);
      const result = Array.isArray(output) ? output[0] : output;
      post({ type: "result", id: request.id, text: result?.text ?? "" });
    } catch (error) {
      post({
        type: "error",
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
