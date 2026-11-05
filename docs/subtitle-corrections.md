# Subtitle corrections

**Settings → Corrections** fixes words that keep coming out wrong: a brand that
Whisper mishears, or a product name the translator renders differently every
time. Rules are deterministic find → replace substitutions on cue text. They
are not a general quality check and do not fix mistranslations, timing or grammar.

## Where rules run

| Stage | When | What it changes |
|---|---|---|
| **Before translation** | Right after Whisper writes a transcript, and again when a translation job starts | The source subtitle on disk (any source in the set's folders, not only transcripts), and the text sent to the LLM. Each replacement is also added to the per-chunk glossary as a term to keep as written (`Ubiquiti -> Ubiquiti`). |
| **After translation** | Just before the translated file is saved | The translated cues only. A rule can be limited to some target languages (`chi`, `jpn`). |
| **Before and after** | Both | Both. |

Fixing a speech-recognition mistake **before** translation is usually better:
the translator then reads "Ubiquiti" instead of guessing at "Ubiquity", and
every target language benefits. Use **after translation** for slips in the
translation itself.

## Rule sets and folders

Rules live in named sets, and a set applies to the folders it names and every
subfolder. **Whole library** applies to everything, so keep brand fixes scoped:
"unify" is an ordinary English word in a movie. Sets run in list order, and the
rules in a set run top to bottom.

## Matching

- **Whole word** (default): the exact text, not touching another letter, digit
  or underscore in any script. `Unify` matches in `Unify Network` and `使用 Unify。`,
  but not in `UnifyCloud`, `my_Unify`, `Unify2` or `超級Unify網路`. This is the
  same as Python's Unicode `\b`.
- **Anywhere**: the exact text inside other text, for scripts without spaces
  (`優比快` → `Ubiquiti` in a Chinese translation).
- **Regular expression**: JavaScript syntax with Unicode on; `$1` and `$<name>`
  work in the replacement.
- **Match case** is on by default, so `Unify` and `unify` are separate rules.
  Turn it off to canonicalise every spelling (`unifi` → `UniFi`); matches already
  spelled like the replacement are not counted.

A term split across two lines, two cues or a tag (`Uni<i>fy</i>`) is not a
match, and markup (`<i>`, `{\i1}`, `\N`) is never changed.

## Safety

- Only cue text changes. Cue numbers, timestamps, styles, blank lines, line
  endings, the byte-order mark and every other byte stay as they were. The
  rewritten source keeps its modification time, because the scanner uses it to
  tell a source from its translation.
- Every rewrite is checked before it is written: the same cues with the same
  timings, each cue exactly what the rules make of it, and a second pass that
  changes nothing. If a check fails, the file is left alone and the job log
  says why. A source that is not UTF-8 is never rewritten; the translation is
  still corrected in memory.
- Saving refuses a rule that would never settle, for example `UniFi` →
  `UniFi Network` (the replacement contains the term again), or `A → B` followed
  by `B → A`.
- Each job's log lists the replacements per rule: `Corrected 3 terms in
  Talk.en.srt: Ubiquity → Ubiquiti ×2, Unify → Unifi ×1`.

## Example: a UniFi library

A set named *Ubiquiti* on the folder `UniFi`:

| Find | Replace with | When | Match |
|---|---|---|---|
| `Unify` | `Unifi` | Before translation | Whole word |
| `unify` | `unifi` | Before translation | Whole word |
| `Ubiquity` | `Ubiquiti` | Before translation | Whole word |

Use **Try a line** under the set to check a rule before saving.

## Storage

Rules are stored in `config.json` under `correction_rule_sets`, as a JSON array
of `{ id, name, enabled, paths, rules: [{ id, find, replace, stage, match,
caseSensitive, languages, enabled }] }` (`stage`: `source`, `output` or
`both`; `match`: `word`, `phrase` or `regex`). The matching code is
`src/shared/corrections.ts`, and the file rewriting is `src/server/corrections.ts`.
