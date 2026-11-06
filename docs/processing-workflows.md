# Processing workflows

Use **Settings → Sources → Subtitle source selection** to enable caption-first automation in selected folders. Each rule sets the source language and what to do if the video has no captions. See [Library subtitle intake and OCR](library-subtitle-intake.md).

Use **Settings → Speech to text → Processing profiles** to set model, language, output format, review limits, correction lists, translation targets, and Markdown export. A blank folder means the media root. The closest matching profile applies to subfolders. In Transcribe, select **Use folder profiles** to preview each distinct plan before submitting. Select **Translate using profile targets** to send the generated subtitles to the chosen target tasks. You can still choose model, language, and format for individual runs.

New jobs save their resolved processing settings at submission. An explicit run override takes precedence over a processing profile, and the profile takes precedence over inherited defaults. The backend URL, path mapping, transport, and credentials are read when the job runs. Pending reviews and CLI submission receipts survive restarts.

## Review and completion

Enable **Review source before translation** in a profile to hold SRT, WebVTT, or ASS output for approval. Open the pending item in **Transcription results and review**. Edit its text, check cue quality, and select the translation targets. Timing and line adjustments run in the order you add them. Preview an offset, frame-rate correction, or plain-text reflow before applying it to the editor. Approval publishes the edited transcript and queues the selected targets. An existing completed translation stays on disk and can be retranslated from its job.

Enable **Create a Markdown note** to download timestamped paragraphs for Library or URL transcripts. A URL job can also request this through the CLI. The **Transcript note ready** event in Notifications can send the work ID and title to your existing webhook once the note is saved. A raw speech recognition checkpoint lets the backend reuse compatible recognition when a later render or publish needs retrying. **Choose audio track** on a single selected video uses the stream index reported by FFprobe. **Upload audio only** uses lossless mono FLAC when the backend needs an upload. Phase timings and bytes uploaded appear under recent work.

To measure transport on your own media, run `npx tsx scripts/benchmark-transcription.ts --help`. Compare timing and subtitle hashes before changing the default. The comparison runs full upload and audio-only upload sequentially. Model warm-up can affect the measured time.

## JSON automation

Run the client from the repository with Node 22. Set `SUBSMELT_URL` or pass `--server`. If a reverse proxy requires authentication, set `SUBSMELT_AUTHORIZATION_FILE` to a file containing the full Authorization header value. `SUBSMELT_AUTHORIZATION` also works.

```bash
export SUBSMELT_URL=http://localhost:3000
node scripts/subsmelt.mjs plan --file /media/shows/episode.mkv
node scripts/subsmelt.mjs submit --file /media/shows/episode.mkv --key episode-42
node scripts/subsmelt.mjs status WORK_ID
node scripts/subsmelt.mjs wait WORK_ID --timeout 1800
node scripts/subsmelt.mjs download WORK_ID --note --output episode.md
```

File input paths belong to the SubSmelt server. To override the matching folder profile, use `--profile ID`. The plan response shows the matched profile's ID. Each command prints one JSON object. Submission returns stable job IDs and accepts an idempotency key during work retention. Use `status` without an ID to list recent work. Use `cancel WORK_ID` to stop queued or active work. Pass `--url` for a URL and `--force` when a run should perform fresh speech recognition.

For offline editing, use `download WORK_ID --output episode.srt` and save its JSON `revision`. After editing, run `approve WORK_ID --edit episode.srt --revision SHA256 --targets 1,2`. Use `--targets ''` to approve without starting translations. If the server's transcript changed during editing, reload it and reconcile your edits before submitting again.

Exit codes are 0 for success, 1 for server or client I/O errors, 2 for invalid arguments, 3 for failed or cancelled work, 4 for a wait timeout, and 5 for a wait that stopped at source review. Run `node scripts/subsmelt.mjs --help` for the command list.
