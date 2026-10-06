import type { ModelEngine } from "./types.js";

export function modelEngine(id: string): ModelEngine {
  return id.toLowerCase().startsWith("nemotron") ? "nemotron" : "whisper";
}
