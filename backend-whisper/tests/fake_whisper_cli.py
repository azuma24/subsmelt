#!/usr/bin/env python3
"""A stand-in for the whisper-cli binary.

Supports ``--version`` and ``-m <model> -f <wav> -l <lang> -ojf -pp -of <prefix>
[--prompt p] [-bs n]``. Prints three ``progress =`` lines to stderr, writes the
``-of`` prefix + ``.json`` the real binary would, sleeps
``SUBSMELT_FAKE_WHISPER_SLEEP`` seconds between progress lines so a cancel can
land mid-run, writes its pid to ``SUBSMELT_FAKE_WHISPER_PIDFILE`` when set, and
exits 1 when the model or wav path does not exist.
"""

import json
import os
import sys
import time
import wave

PROGRESS_LINES = (0, 50, 100)


def _error(message):
    print(message, file=sys.stderr)
    return 1


def main(argv):
    if argv[:1] == ["--version"]:
        print("whisper.cpp version: 1.9.5-dev")
        return 0
    opts = {}
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg in ("-m", "-f", "-l", "-of", "--prompt", "-bs") and index + 1 < len(argv):
            opts[arg] = argv[index + 1]
            index += 2
        else:
            opts[arg] = True
            index += 1
    model = opts.get("-m")
    wav_path = opts.get("-f")
    prefix = opts.get("-of")
    if not model or not os.path.exists(model):
        return _error(f"error: failed to open model file '{model}'")
    if not wav_path or not os.path.exists(wav_path):
        return _error(f"error: failed to read WAV input '{wav_path}'")
    if not prefix:
        return _error("error: -of is required")
    pidfile = os.environ.get("SUBSMELT_FAKE_WHISPER_PIDFILE")
    if pidfile:
        with open(pidfile, "w", encoding="utf-8") as fh:
            fh.write(str(os.getpid()))
    sleep = float(os.environ.get("SUBSMELT_FAKE_WHISPER_SLEEP", "0"))
    for pct in PROGRESS_LINES:
        print(f"whisper_print_progress_callback: progress =  {pct}%", file=sys.stderr)
        time.sleep(sleep)
    with wave.open(wav_path, "rb") as wav:
        duration_ms = int(wav.getnframes() / wav.getframerate() * 1000)
    language = opts.get("-l", "auto")
    result = {
        "systeminfo": "fake",
        "model": model,
        "params": {},
        "result": {"language": "en" if language == "auto" else language},
        "transcription": [
            {
                "timestamps": {"from": "00:00:00,000", "to": "00:00:01,000"},
                "offsets": {"from": 0, "to": min(1000, duration_ms)},
                "text": " Hello from whisper.cpp.",
            },
            {
                "timestamps": {"from": "00:00:01,000", "to": "00:00:02,000"},
                "offsets": {"from": 1000, "to": min(2000, duration_ms)},
                "text": " Second cue.",
            },
        ],
    }
    with open(f"{prefix}.json", "w", encoding="utf-8") as fh:
        json.dump(result, fh)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
