# Why LLM translation beats traditional MT

Most subtitle translation tools call a dictionary-based engine (Google Translate,
DeepL) one sentence at a time. SubSmelt doesn't. It sends **whole chunks of
subtitles together** to a large language model, which changes the result in
several concrete ways.

## Context carried across lines

A line like *"He did it again"* is ambiguous alone. Sent alongside the
surrounding five exchanges, the model reads who "he" is, what "it" refers to, and
how formal the register should be — and picks the right phrasing. Traditional MT
has none of that.

SubSmelt uses 20-line chunks with a 5-line overlap window, so context carries
across chunk boundaries rather than resetting at each one.

## Character names and proper nouns stay consistent

For files over 500 cues, SubSmelt first runs a quick analysis pass to extract
recurring names, technical terms, and style notes into a glossary. Every chunk
that follows sees that glossary. A character named 佐藤 doesn't become Sato in one
subtitle and Satou in the next.

## Tone and register are preserved

LLMs understand that an anime character speaking in keigo should sound formal,
that a slang-heavy crime drama should stay gritty, and that children's content
should simplify vocabulary. A word-level MT system has no concept of register.

## Natural phrasing, not word-for-word rendering

Subtitle translation requires short, punchy lines that fit on screen. LLMs
rephrase naturally to hit that constraint. Traditional MT often produces awkward
literal output that has to be manually post-edited.

## Reasoning models go further

Models like Qwen3, DeepSeek-R1, and Gemini Thinking reason explicitly before
committing to a translation. For ambiguous lines — idioms, wordplay, cultural
references — you see higher-quality output because the model pauses to consider
alternatives.

## The tradeoff

Each chunk is a real API call, so this costs more than a dictionary lookup.
SubSmelt minimises that with:

- **Adaptive chunking** — 20 lines per call by default (`chunk_size`)
- **Parallel workers** — tuned automatically against the model's real context window
- **Context probing** — the LM Studio native API is queried for the actual window size
- **A skip threshold** — the analysis pass is skipped entirely for short files

Running against a local endpoint (LM Studio, Ollama, vLLM, GPUStack) removes the
per-call cost altogether.
