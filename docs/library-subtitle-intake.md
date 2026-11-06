# Library subtitle intake and image OCR

In **Settings → Sources → Subtitle source selection**, add a rule for the folder you want to manage, choose a source language, and set the fallback. The closest rule applies to each subfolder. A Scan Preview shows the source decision for each opted-in video. Manual scans and both library watcher methods follow the same selection. Use Pause monitoring to stop scheduled scans and file change detection together. Manual scans and queued work are still available.

A readable, timed sidecar whose filename identifies the source language takes priority. When the scan finds one unambiguous embedded text track in that language, it can import the track beside the video. Confirmed caption absence can trigger speech recognition if the rule permits it and a transcription backend is configured. Forced tracks, ambiguous languages, unsupported formats, image tracks and failed probes stay available for review.

Unattended speech recognition checks for newly arrived captions again before publication. In shared-filesystem mode, use Whisper backend 0.9.0 or later so the Library can verify the video and publish the sidecar itself. Upload mode can publish the returned transcript directly. Manual transcription can still run through an older shared-filesystem backend.

## Enable image subtitle OCR

Pin a Subtitle Edit `seconv` build with the documented JSON OCR CLI. SubSmelt's PGS and VobSub smoke tests used [Subtitle Edit v5.4.0](https://github.com/SubtitleEdit/subtitleedit/releases/tag/v5.4.0). Install the executable, Tesseract and the desired Tesseract language data in the same environment as the Subsmelt server. Configure the absolute path to the executable with `SUBSMELT_SECONV_PATH`. For example, a native server can use `/opt/subtitle-edit/seconv`. In a container, use a compatible Linux build and a path inside the container, with Tesseract and its language data available there. Subsmelt's bundled image leaves this optional runtime to the operator. [Subtitle Edit command line reference](https://github.com/SubtitleEdit/subtitleedit/blob/3d22a2f751b819bcd9550bd09987b0f0d2559cf5/docs/reference/command-line.md#ocr).

Subsmelt selects the Tesseract language from the track's tag and defaults unlabelled tracks to English. Set `SUBSMELT_SECONV_OCR_LANGUAGE` to a Tesseract language code such as `jpn` or `chi_tra` to override that choice.

In the Library, open a video and choose **Find embedded subtitles**. Select the PGS or VobSub track and choose **Read image subtitles**. The server stages only that track and saves validated cues as a new SRT beside the video. The existing file is kept if the destination is already occupied. You can cancel the import while OCR is running.
