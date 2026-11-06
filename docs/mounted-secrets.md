# Mounted secrets

Set the relevant variable to the path of a read-only secret file inside the
process or container that uses it.

| Process | File variable | Credential |
| --- | --- | --- |
| SubSmelt | `API_KEY_FILE` | API key for the local LLM connection |
| SubSmelt | `WHISPER_BACKEND_TOKEN_FILE` | Token SubSmelt sends to the Whisper backend |
| Whisper backend | `SUBSMELT_WHISPER_TOKEN_FILE` | Token the Whisper backend requires |
| Whisper backend | `SUBSMELT_HF_TOKEN_FILE` | Hugging Face token for speaker diarization |

Use a file with one UTF-8 credential up to 16 KiB. Surrounding whitespace,
including a final newline, is trimmed. The original variable without `_FILE`
takes precedence when nonempty. The mounted file takes precedence over saved
settings or, for diarization, the `HF_TOKEN` fallback. SubSmelt reads mounted
credentials at startup and treats them as environment-pinned settings. Restart
the app to apply a changed credential.

For a shared Whisper token in Compose, mount the same secret in each service
and set `WHISPER_BACKEND_TOKEN_FILE=/run/secrets/whisper-token` in SubSmelt and
`SUBSMELT_WHISPER_TOKEN_FILE=/run/secrets/whisper-token` in the backend. The
process running each service needs permission to read its mount. An invalid
selected app or backend auth file stops startup with the variable name in the
diagnostic. An invalid diarization file leaves speaker diarization unavailable.

New SubSmelt log entries redact configured credentials and recognized
authentication fields before they reach the console, log file, or Logs page.
