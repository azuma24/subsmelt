# Nemotron 3.5 ASR engine for SubSmelt 0.6.0

## Outcome

The transcription backend offers one new model next to Whisper: NVIDIA Nemotron 3.5 ASR (`nvidia/nemotron-3.5-asr-streaming-0.6b`). Users see it in Settings and on the Transcribe page, download it from the model manager, and pick it per run or per folder like any Whisper size. It produces punctuated subtitles with word-level timing, much faster than Whisper large-v3, with little VRAM. Whisper stays the default. Diarization is unchanged (pyannote); the Nemotron diarizer is out of scope.

The user's backend runs on Windows with an NVIDIA CUDA GPU (PyInstaller service, no torch). Docker (Linux CUDA) and a Mac dev run must work too.

## Runtime: NeMo-Speech.cpp, not Python NeMo

- NVIDIA NeMo-Speech.cpp v0.1.0 (Apache-2.0) runs the model natively from a GGUF file with no Python or torch. Release assets: `nemo-speech-0.1.0-windows-x86_64-cuda.zip`, `...-linux-x86_64-cuda.tar.gz`, `...-linux-aarch64-cpu.tar.gz`, `...-macos-aarch64-metal.tar.gz`, each with a `.sha256`.
- Model file: `nemotron-3.5-asr-streaming-0.6b.q8_0.gguf` (742 MB) in the HF repo `nvidia/nemotron-3.5-asr-streaming-0.6b`. Passing a local GGUF path to `--model` never touches the network.
- A Mac build for local testing is already unpacked at /private/tmp/claude-501/-Users-richard-Projects-subsmelt/1007d2c4-3a41-493d-b8be-dfa1f0574419/scratchpad/proto-nemo/nemo-speech/bin/nemo-speech, and the GGUF is at .../proto-nemo/models/nvidia/nemotron-3.5-asr-streaming-0.6b/1c8deaecc64b91f034d73e08dd8b64625eb3395d/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf. Test audio: .../proto-nemo/ted.wav (234 s, English, reference captions in ted.en.srt).
- Observed CLI: `nemo-speech transcribe <wav> --model <gguf> --language <locale|auto> --json` prints one JSON object when done: `{file, text, confidence, duration, languages: ["en-US"], words: [{word, start, end, confidence}]}`. Status lines go to stderr prefixed with `[`. There is no progress output, including with `--stream`. Measured on an M-series Mac with Metal: 234 s of audio in 20 s including model load.
- Locales: `en-US`, `es-US`, `fr-FR`, `de-DE`, `ja-JP`, `ko-KR`, `zh-CN`, `ar-AR`, `hi-IN`, `vi-VN`, `pt-BR`, `it-IT`, `nl-NL`, `tr-TR`, `ru-RU`, `uk-UA` and more (32 usable without fine-tuning), or `auto`.

## Design (build this shape)

1. **Engine seam.** Downstream code only needs segments with `start`, `end`, `text` (and optional `speaker`) plus info `language` and `duration` (see app/transcribe.py:170-171, 197-198, segments.py, formatters.py). Introduce one registry that maps a model id to an engine. `whisper` wraps the existing faster-whisper runners unchanged. `nemotron` is the new runner. Do not duplicate the four run_faster_whisper* variants a fifth time: the Nemotron runner should plug into the same call sites through the registry.
2. **Model descriptors.** Replace the flat Whisper-only catalog with descriptors: `{id, engine, label, sizeMb, requiredRamMb, requiredVramMb, languages: "all" | string[], supports: {prompt, beamSize, vad, computeType, wordTimestamps, translateTask}}`. The Nemotron id is `nemotron-3.5-asr` (no slash; the Node server's model-name check rejects `/`). Keep the existing `/health` `capabilities.models: string[]` for older clients and add `capabilities.modelInfo: descriptor[]`.
3. **Download and detection.** Download only the GGUF with huggingface_hub (`allow_patterns` for that one file) into the same cache the model manager uses, reusing its progress plumbing and per-model lock. Installed = that GGUF exists. Delete removes it.
4. **Binary.** Resolve `nemo-speech` from `SUBSMELT_NEMO_SPEECH`, then a copy bundled next to the backend executable, then PATH. If none is found, the model shows as unavailable with a clear reason, never a crash. Report the binary version in capabilities.
5. **Long audio, progress and cancel.** Split the 16 kHz WAV at silences into chunks of about 10 minutes (use the silero VAD that faster-whisper already ships, `faster_whisper.vad`, or an ffmpeg `silencedetect` pass if that is simpler), run `nemo-speech` per chunk as a subprocess, offset word times by the chunk start, and report progress per finished chunk in seconds of audio (the Node server requires `processedSeconds` and `totalSeconds`). Cancel kills the running subprocess and stops before the next chunk. Always clean temp chunks.
6. **Words to segments.** Build subtitle segments from words: break at sentence-ending punctuation, at pauses over 0.6 s, and at a maximum cue duration and length that respect the existing subtitle-quality settings. CJK text has no spaces, so measure length in characters there.
7. **Language.** Map request languages (`auto`, `en`, `ja`, `zh`, `zh-TW`, ...) to Nemotron locales through one table; unsupported language → a clear 400 error code `language_not_supported` (generalise the existing `english_only_model` code). Report the detected language from `languages[0]` mapped back to the short code the rest of the system uses.
8. **Options.** Whisper-only options (beam size, patience, prompt, compute type, condition on previous text) are ignored for Nemotron and hidden in the UI through `supports`. VAD is not needed.
9. **Memory.** Loading Nemotron must not leave a Whisper model resident, and vice versa (the backend audit branch adds eviction; build on it).

## Packaging

- Windows: download the pinned `windows-x86_64-cuda.zip`, verify its SHA-256, and bundle the extracted folder with the service (packaging/windows/build-local.ps1, the PyInstaller spec or the Inno Setup script, and .github/workflows/windows-whisper-build.yml). Set `SUBSMELT_NEMO_SPEECH` in the service environment (install-service.ps1).
- Docker: add the pinned Linux archive to backend-whisper/Dockerfile (CUDA build for amd64; CPU build for arm64), checksum-verified.
- Document the new model in the README speech-to-text section and CHANGELOG [Unreleased].

## Server and client

- Server (src/server): pass the model id through unchanged; nothing assumes Whisper sizes. Fix Whisper-only assumptions that would break Nemotron: the low-RAM downgrade must not switch engines silently (transcription/http-health.ts:79-85), and history retry must reuse the stored model (routes/transcription-history-routes.ts:44-48), and the history path scrubber must not mangle model ids (transcription-history.ts:64-66).
- Client (src/client): model pickers (features/settings/sections/SttSection.tsx, features/whisper/*, ModelManagerPanel.tsx) read `modelInfo` when present, group models under "Whisper" and "NVIDIA Nemotron", show a one-line strength per model (Nemotron: "Fast, punctuated. English, Japanese, Korean, most European languages."; Whisper: "99 languages. Best for Chinese and rare languages."), hide options the selected model does not support, and fall back to the old string list for older backends. "Whisper Models" headings become "Speech-to-text models". All new strings in all 32 locales.

## Verification

- Unit tests with a fake `nemo-speech` script (Python, prints canned JSON, sleeps per chunk, honours kill) for: chunk offsets, words to segments (English and Japanese samples), language mapping, cancel mid-run, missing binary, descriptor listing, download detection.
- End to end on this Mac: run the backend with `SUBSMELT_NEMO_SPEECH` pointing at the Mac build and the model dir holding the GGUF, POST /transcribe/upload/stream with ted.wav and model `nemotron-3.5-asr`, get an SRT, compare it against ted.en.srt by eye and with a simple word error rate. Record timing.
- Server and client: `npm test`, `npm run typecheck`, screenshots of the model picker and model manager at 390 and 1280 px.
- Windows CUDA cannot be tested here: write the exact manual check for the user (install, download the model in Settings, transcribe a file, expected speed).
