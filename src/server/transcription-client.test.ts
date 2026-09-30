import test from "node:test";
import assert from "node:assert/strict";
import {
  assertMediaPathAllowed,
  applyPreflightPolicy,
  buildTranscriptionRequest,
  normalizeTranscriptionBackendUrl,
  localTranscriptionOutputPath,
  transcribePostActionValues,
  resolveTransportMode,
  type TranscriptionOutputFormat,
} from "./transcription-client.js";

test("assertMediaPathAllowed accepts files under the media root", () => {
  assert.equal(assertMediaPathAllowed("/media/anime/Episode 01.mkv", "/media"), "/media/anime/Episode 01.mkv");
});

test("assertMediaPathAllowed rejects paths outside the media root", () => {
  assert.throws(() => assertMediaPathAllowed("/etc/passwd", "/media"), /outside media directory/);
  assert.throws(() => assertMediaPathAllowed("/media-not-really/video.mkv", "/media"), /outside media directory/);
});

test("normalizeTranscriptionBackendUrl trims trailing slashes", () => {
  assert.equal(normalizeTranscriptionBackendUrl("http://whisper-backend:8001///"), "http://whisper-backend:8001");
});

test("resolveTransportMode honours explicit shared/upload settings", () => {
  assert.equal(resolveTransportMode({ transcription_transport: "shared" }), "shared");
  assert.equal(resolveTransportMode({ transcription_transport: "upload" }), "upload");
  assert.equal(resolveTransportMode({ transcription_transport: "UPLOAD" }), "upload");
});

test("resolveTransportMode auto: upload only when a token is set with no path mapping (true remote)", () => {
  // No token, no mapping → local same-host → shared (preserves prior default).
  assert.equal(resolveTransportMode({ transcription_transport: "auto" }), "shared");
  // Token set, no mapping → remote with no shared FS → upload.
  assert.equal(resolveTransportMode({ transcription_transport: "auto", transcription_backend_token: "t" }), "upload");
  // Token + explicit mapping → operator wired a shared mount → shared.
  assert.equal(
    resolveTransportMode({
      transcription_transport: "auto",
      transcription_backend_token: "t",
      transcription_path_map_from: "/media",
      transcription_path_map_to: "/srv/media",
    }),
    "shared",
  );
});

test("resolveTransportMode defaults to auto behaviour when unset", () => {
  assert.equal(resolveTransportMode({}), "shared");
  assert.equal(resolveTransportMode({ transcription_backend_token: "t" }), "upload");
});

test("resolveTransportMode auto: backend host decides when no token is set", () => {
  // Remote host, no token, no mapping → no shared FS → upload (the prod-500 fix).
  assert.equal(
    resolveTransportMode({ transcription_transport: "auto", transcription_backend_url: "http://192.168.1.25:8001" }),
    "upload",
  );
  // Loopback host → same machine → shared.
  assert.equal(
    resolveTransportMode({ transcription_transport: "auto", transcription_backend_url: "http://127.0.0.1:8001" }),
    "shared",
  );
  assert.equal(
    resolveTransportMode({ transcription_transport: "auto", transcription_backend_url: "http://localhost:8001" }),
    "shared",
  );
  // Remote host but explicit path mapping → operator wired a shared mount → shared.
  assert.equal(
    resolveTransportMode({
      transcription_transport: "auto",
      transcription_backend_url: "http://192.168.1.25:8001",
      transcription_path_map_from: "/media",
      transcription_path_map_to: "/srv/media",
    }),
    "shared",
  );
});

test("buildTranscriptionRequest keeps whisper behavior app-owned", () => {
  const request = buildTranscriptionRequest({
    videoPath: "/media/anime/Episode 01.mkv",
    mediaDir: "/media",
    settings: {
      transcription_model: "base",
      transcription_device: "cpu",
      transcription_compute_type: "int8",
      transcription_language: "ja",
      transcription_use_vad: "1",
      transcription_output_format: "vtt",
    },
    postAction: "transcribe_and_translate",
  });

  assert.deepEqual(request, {
    input_path: "/media/anime/Episode 01.mkv",
    output_format: "vtt",
    model: "base",
    language: "ja",
    device: "cpu",
    compute_type: "int8",
    use_vad: true,
    post_action: "transcribe_and_translate",
  });
});

test("buildTranscriptionRequest keeps the original media path when no mapping is configured", () => {
  const request = buildTranscriptionRequest({
    videoPath: "/media/tv/Show/Episode 02.mkv",
    mediaDir: "/media",
    settings: {},
  });

  assert.equal(request.input_path, "/media/tv/Show/Episode 02.mkv");
});

test("buildTranscriptionRequest rewrites only the backend path when a mapping is configured", () => {
  const request = buildTranscriptionRequest({
    videoPath: "/media/anime/Season 1/Episode 03.mkv",
    mediaDir: "/media",
    settings: {
      transcription_path_map_from: "/media",
      transcription_path_map_to: "/srv/media-library",
    },
  });

  assert.equal(request.input_path, "/srv/media-library/anime/Season 1/Episode 03.mkv");
});

test("buildTranscriptionRequest still rejects source paths outside the media root even when mapping is configured", () => {
  assert.throws(() => buildTranscriptionRequest({
    videoPath: "/other-share/anime/Episode 04.mkv",
    mediaDir: "/media",
    settings: {
      transcription_path_map_from: "/media",
      transcription_path_map_to: "/srv/media-library",
    },
  }), /outside media directory/);
});

test("buildTranscriptionRequest rejects unsafe mapping configuration and traversal-ish mapped results", () => {
  assert.throws(() => buildTranscriptionRequest({
    videoPath: "/media/anime/Episode 05.mkv",
    mediaDir: "/media",
    settings: {
      transcription_path_map_from: "/media",
      transcription_path_map_to: "http://user:***@backend/share",
    },
  }), /must be an absolute filesystem path/);

  assert.throws(() => buildTranscriptionRequest({
    videoPath: "/media/anime/Episode 05.mkv",
    mediaDir: "/media",
    settings: {
      transcription_path_map_from: "/media/../media",
      transcription_path_map_to: "/srv/media-library",
    },
  }), /must not contain traversal segments/);
});

test("buildTranscriptionRequest includes subtitle polish options from settings", () => {
  const request = buildTranscriptionRequest({
    videoPath: "/media/anime/Episode 02.mkv",
    mediaDir: "/media",
    settings: {
      transcription_model: "small",
      transcription_language: "en",
      transcription_output_format: "srt",
      transcription_max_line_length: "32",
      transcription_max_subtitle_duration: "5.5",
      transcription_merge_short_segments: "1",
    },
  });

  assert.deepEqual(request.subtitle_quality, {
    max_line_length: 32,
    max_subtitle_duration: 5.5,
    merge_short_segments: true,
  });
});

test("buildTranscriptionRequest applies the longest matching per-folder defaults before global defaults", () => {
  const request = buildTranscriptionRequest({
    videoPath: "/media/anime/Season 2/Episode 07.mkv",
    mediaDir: "/media",
    settings: {
      transcription_model: "small",
      transcription_language: "auto",
      transcription_use_vad: "1",
      transcription_folder_defaults: JSON.stringify([
        { path: "/media/anime", model: "base", language: "ja", use_vad: false },
        { path: "/media/anime/Season 2", model: "medium", language: "ja", output_format: "vtt", max_line_length: 30 },
      ]),
    },
  });

  assert.equal(request.model, "medium");
  assert.equal(request.language, "ja");
  assert.equal(request.output_format, "vtt");
  assert.equal(request.use_vad, true, "folder defaults should only override keys they explicitly set");
  assert.deepEqual(request.subtitle_quality, { max_line_length: 30 });
});

test("buildTranscriptionRequest sends supported advanced STT options without enabling unsupported heavy features by default", () => {
  const request = buildTranscriptionRequest({
    videoPath: "/media/lectures/Talk 01.mkv",
    mediaDir: "/media",
    settings: {
      transcription_advanced_stt: JSON.stringify({
        beam_size: 7,
        patience: 1.2,
        condition_on_previous_text: false,
        word_timestamps: true,
        initial_prompt: "Technical conference audio.",
        speaker_diarization: false,
        bgm_separation: false,
      }),
    },
  });

  assert.deepEqual(request.advanced_options, {
    beam_size: 7,
    patience: 1.2,
    condition_on_previous_text: false,
    word_timestamps: true,
    initial_prompt: "Technical conference audio.",
    speaker_diarization: false,
    bgm_separation: false,
  });
});

test("buildTranscriptionRequest rejects invalid STT JSON settings instead of silently using global defaults", () => {
  assert.throws(() => buildTranscriptionRequest({
    videoPath: "/media/anime/Episode 08.mkv",
    mediaDir: "/media",
    settings: { transcription_folder_defaults: "[{not json]" },
  }), /Invalid transcription_folder_defaults JSON/);

  assert.throws(() => buildTranscriptionRequest({
    videoPath: "/media/anime/Episode 08.mkv",
    mediaDir: "/media",
    settings: { transcription_advanced_stt: "{not json}" },
  }), /Invalid transcription_advanced_stt JSON/);
});

test("localTranscriptionOutputPath mirrors backend language suffix output naming", () => {
  assert.equal(localTranscriptionOutputPath("/media/anime/Episode 07.mkv", "ja", "vtt"), "/media/anime/Episode 07.ja.vtt");
  assert.equal(localTranscriptionOutputPath("/media/anime/Episode 07.mkv", "auto", "srt"), "/media/anime/Episode 07.srt");
});

test("buildTranscriptionRequest rejects a language that would reshape the subtitle output path", () => {
  assert.throws(() => buildTranscriptionRequest({
    videoPath: "/media/anime/Episode 09.mkv",
    mediaDir: "/media",
    settings: {},
    overrides: { language: "../x" },
  }), { message: "Unsupported transcription language: ../x" });
});

test("buildTranscriptionRequest rejects an output format outside srt/vtt/txt/ass", () => {
  assert.throws(() => buildTranscriptionRequest({
    videoPath: "/media/anime/Episode 09.mkv",
    mediaDir: "/media",
    settings: {},
    outputFormat: "srt/../../evil" as TranscriptionOutputFormat,
  }), { message: "Unsupported transcription output format: srt/../../evil" });
});

test("a valid language and output format still name the subtitle next to the video", () => {
  const request = buildTranscriptionRequest({
    videoPath: "/media/anime/Episode 09.mkv",
    mediaDir: "/media",
    settings: {},
    outputFormat: "srt",
    overrides: { language: "en" },
  });

  assert.equal(localTranscriptionOutputPath("/media/anime/Episode 09.mkv", request.language, request.output_format), "/media/anime/Episode 09.en.srt");
});

test("a language with a region subtag names the subtitle with that tag", () => {
  const request = buildTranscriptionRequest({
    videoPath: "/media/drama/Episode 01.mkv",
    mediaDir: "/media",
    settings: {},
    outputFormat: "srt",
    overrides: { language: "zh-TW" },
  });

  assert.equal(localTranscriptionOutputPath("/media/drama/Episode 01.mkv", request.language, request.output_format), "/media/drama/Episode 01.zh-TW.srt");
});

test("transcribe post action values remain restricted", () => {
  assert.deepEqual(transcribePostActionValues, ["transcribe_only", "transcribe_and_translate"]);
});

test("applyPreflightPolicy downgrades low-RAM requests when configured", async () => {
  const calls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    const body = calls.length === 1
      ? { ok: false, safe: false, code: "insufficient_ram", availableRamMb: 4096, requiredRamMb: 8192, suggestedModel: "small" }
      : { ok: true, safe: true, code: "ok" };
    return Response.json(body);
  }) as typeof fetch;
  try {
    const request = await applyPreflightPolicy(
      "http://whisper-backend:8001",
      {
        input_path: "/media/Episode.mkv",
        output_format: "srt",
        model: "medium",
        language: "auto",
        device: "cpu",
        compute_type: "int8",
        use_vad: true,
        post_action: "transcribe_only",
      },
      { transcription_low_ram_behavior: "downgrade" },
    );
    assert.equal(request.model, "small");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applyPreflightPolicy never downgrades a Nemotron request to a Whisper model", async () => {
  const calls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: false, safe: false, code: "insufficient_ram", availableRamMb: 1024, requiredRamMb: 2048, suggestedModel: "small" });
  }) as typeof fetch;
  try {
    await assert.rejects(
      applyPreflightPolicy(
        "http://whisper-backend:8001",
        {
          input_path: "/media/Episode.mkv",
          output_format: "srt",
          model: "nemotron-3.5-asr",
          language: "ja",
          device: "cuda",
          compute_type: "int8",
          use_vad: true,
          post_action: "transcribe_only",
        },
        { transcription_low_ram_behavior: "downgrade" },
      ),
      { message: "Not enough RAM for nemotron-3.5-asr; available 1024 MB, required 2048 MB" },
    );
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applyPreflightPolicy sends explicit unsafe override only for run_anyway", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ ok: false, safe: false, code: "insufficient_ram", availableRamMb: 1024, requiredRamMb: 4096 })) as typeof fetch;
  try {
    const request = await applyPreflightPolicy(
      "http://whisper-backend:8001",
      {
        input_path: "/media/Episode.mkv",
        output_format: "srt",
        model: "small",
        language: "auto",
        device: "cpu",
        compute_type: "int8",
        use_vad: true,
        post_action: "transcribe_only",
      },
      { transcription_low_ram_behavior: "run_anyway" },
    );
    assert.equal(request.allow_unsafe, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
