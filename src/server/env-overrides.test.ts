import test from "node:test";
import assert from "node:assert/strict";
import { ENV_SETTING_OVERRIDES, envSettingOverrides } from "./config.js";

test("maps environment variables onto their settings keys", () => {
  const overrides = envSettingOverrides({
    LLM_ENDPOINT: "http://lm:1234/v1",
    MODEL: "qwen3",
    WHISPER_BACKEND_URL: "http://whisper-backend:8001",
    WHISPER_BACKEND_TOKEN: "s3cr3t",
  });

  assert.deepEqual(overrides, {
    llm_endpoint: "http://lm:1234/v1",
    model: "qwen3",
    transcription_backend_url: "http://whisper-backend:8001",
    transcription_backend_token: "s3cr3t",
  });
});

test("the backend token has an override at all", () => {
  // Without this, arming SUBSMELT_WHISPER_TOKEN on the backend and having no
  // way to give SubSmelt the same secret turns every request into a 401 — the
  // recommended protection silently disabling STT.
  assert.equal(ENV_SETTING_OVERRIDES.WHISPER_BACKEND_TOKEN, "transcription_backend_token");
});

test("unset and empty variables are left alone", () => {
  // Compose files routinely declare a variable with no value; that is "leave the
  // saved setting as it is", not "overwrite it with an empty string".
  assert.deepEqual(envSettingOverrides({}), {});
  assert.deepEqual(envSettingOverrides({ API_KEY: "" }), {});
  assert.deepEqual(envSettingOverrides({ API_KEY: undefined }), {});
  assert.deepEqual(envSettingOverrides({ API_KEY: "sk-live" }), { api_key: "sk-live" });
});

test("unrelated environment variables are ignored", () => {
  assert.deepEqual(envSettingOverrides({ PATH: "/usr/bin", HOME: "/root", TZ: "UTC" }), {});
});
