// Barrel module: the Whisper backend HTTP client was split into focused
// sub-modules (shared helpers, health/preflight, path/shared-FS transport,
// upload + URL transport, model manager). This file re-exports everything so
// existing importers (`transcription-client.js` → `./transcription/http.js`)
// keep working unchanged.
export * from "./http-shared.js";
export * from "./http-health.js";
export * from "./http-transcribe.js";
export * from "./http-upload.js";
export * from "./http-models.js";
