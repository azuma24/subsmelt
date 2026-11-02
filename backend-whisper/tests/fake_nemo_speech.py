#!/usr/bin/env python3
"""A stand-in for the nemo-speech binary.

Supports ``--version`` and ``transcribe <wav> --model <gguf> --language <loc>
--json --quiet [--device d]``. Emits one word every 0.5 s of the WAV's duration,
echoes the requested locale as ``languages`` (``auto`` becomes ``en-US``),
sleeps ``SUBSMELT_FAKE_NEMO_SLEEP`` seconds per call so a cancel can land
mid-run, writes its pid to ``SUBSMELT_FAKE_NEMO_PIDFILE`` when set, and exits 3
with nemo-speech's error JSON when the model path does not exist.
"""

import json
import os
import sys
import time
import wave

WORD_EVERY_S = 0.5
WORD_LENGTH_S = 0.4


def _options(args):
    opts = {}
    index = 0
    while index < len(args):
        if args[index].startswith("--") and index + 1 < len(args) and not args[index + 1].startswith("--"):
            opts[args[index]] = args[index + 1]
            index += 2
        else:
            opts[args[index]] = True
            index += 1
    return opts


def _error(message, kind, code):
    print(json.dumps({"error": {"message": message, "type": kind, "command": "transcribe", "exit_code": code}}))
    return code


def main(argv):
    if argv[:1] == ["--version"]:
        print("nemo-speech 0.1.0")
        return 0
    if argv[:1] != ["transcribe"] or len(argv) < 2:
        return _error("expected: transcribe INPUT", "invalid_argument", 2)
    wav_path = argv[1]
    opts = _options(argv[2:])
    pidfile = os.environ.get("SUBSMELT_FAKE_NEMO_PIDFILE")
    if pidfile:
        with open(pidfile, "w", encoding="utf-8") as fh:
            fh.write(str(os.getpid()))
    model = opts.get("--model")
    if not model or not os.path.exists(model):
        return _error(f"ASR model file does not exist: {model}", "missing_model", 3)
    time.sleep(float(os.environ.get("SUBSMELT_FAKE_NEMO_SLEEP", "0")))
    with wave.open(wav_path, "rb") as wav:
        duration = wav.getnframes() / wav.getframerate()
    language = opts.get("--language", "auto")
    locale = "en-US" if language == "auto" else language
    words = [
        {
            "word": f"word{i}",
            "start": round(i * WORD_EVERY_S, 2),
            "end": round(i * WORD_EVERY_S + WORD_LENGTH_S, 2),
            "confidence": 1,
        }
        for i in range(int(duration / WORD_EVERY_S))
    ]
    print(
        json.dumps(
            {
                "file": wav_path,
                "text": " ".join(word["word"] for word in words),
                "confidence": 1,
                "duration": duration,
                "languages": [locale],
                "words": words,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
