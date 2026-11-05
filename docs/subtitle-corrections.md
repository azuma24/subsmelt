# Subtitle corrections

Corrections fix words that keep coming out wrong: a brand that Whisper
mishears, or a product name the translator renders differently every time. Rules are deterministic find → replace substitutions on cue text. They
are not a general quality check and do not fix mistranslations, timing or grammar.

## Where rules run

| Stage | When | What it changes |
|---|---|---|
| **Before translation** | Right after Whisper writes a transcript, and again when a translation job starts | The source subtitle on disk (any source in the set's folders, not only transcripts), and the text sent to the LLM. A replacement that looks like a name (capitals, digits, or a script without case, such as `Ubiquiti`, `U7 Pro` or `優比快`) is also added to the per-chunk glossary as a term to keep as written (`Ubiquiti -> Ubiquiti`). A plain lowercase fix such as `teh → the` is not, so the translator still translates it. |
| **After translation** | Just before the translated file is saved | The translated cues only. A rule can be limited to some target languages (`chi`, `jpn`). It applies by the folder the **translation** is saved in, which an output pattern such as `Subs/{{name}}.chi.srt` can make different from the source's folder. |
| **Before and after** | Both | Both. |

Fixing a speech-recognition mistake **before** translation is usually better:
the translator then reads "Ubiquiti" instead of guessing at "Ubiquity", and
every target language benefits. Use **after translation** for slips in the
translation itself.

## Lists and folders

Rules live in named **lists**, for example *Ubiquiti terms*. A list is defined
once and switched on for folders. It then applies to those folders and every
subfolder. **Whole library** applies to everything, so keep brand fixes scoped:
"unify" is an ordinary English word in a movie. Lists run in order, and the
rules in a list run top to bottom.

There are two places to work with lists:

- **Library → open any file → Corrections.** The panel shows which lists apply
  to that file's folder, including lists inherited from a parent folder
  (marked "from UniFi"). A checkbox switches a list on or off for this folder,
  and the change is saved at once. **Edit** opens the list in a drawer, and
  **New list for this folder** starts a list that is already on for the folder.
- **Settings → Corrections** shows every list, the folders each one is on, and
  its rules. Use it for an overview or for bulk editing.

## Fixing a word you spot ("Fix everywhere")

In a job's preview, select a wrong word in the source or the translation and
click **Fix "…"** in the toolbar, or click **Fix a word…** to type one. The
dialog asks for the correct word and where to apply it:

- **Only this file**: a one-off fix with no rule saved.
- **All files in a folder** (the default): the rule is saved to a list on that
  folder, so files added later are fixed too. The folder starts at the nearest
  one that already has a list (a *Ubiquiti* list on `UniFi/` for a file in
  `UniFi/Tutorials/`), and you can pick any folder above the file.

Before anything is written, the dialog lists every file in scope that contains
the word, with a count and up to two sample lines shown before and after the
fix. All files are ticked. Untick any that should stay as they are, for example
where "unify" is the ordinary verb. Unticking applies to this fix only; the rule
still applies to that file's next translation.

A word selected in the **source** becomes a "before translation" rule. Fixing
a source does not change translations already made from it, so the dialog
offers to **re-translate** them and shows how many tokens they took last time.
A word selected in the **translation** becomes an "after translation" rule for
that language only, and fixes the translated files directly, with no LLM
needed. Words in Chinese, Japanese or Thai default to matching anywhere,
because those scripts don't put spaces between words.

The same dry run is under each list as **Preview on my files**. It shows what
the whole list would change in its folders and applies to the files you leave
ticked, once the list is saved.

## Editing a list

- A rule is one line: `wrong word → correct word`. Options that differ from the
  defaults (before translation, whole word, match case) show as small tags,
  such as `After`, `Anywhere`, `Regex`, `Any case` or `chi`. **Options** opens
  the rest.
- To add rules, type in the last line and press Enter. You can also paste
  several lines at once (`Ubiquity → Ubiquiti`, `a -> b`, `a => b`, or two
  columns copied from a spreadsheet) and they are all added.
- After you add a capitalised word, the editor offers its lowercase twin
  ("Also fix `unify` → `unifi`?"), because whole-word rules match case.
- **Try a line** runs the list on a sample line, using the same code as the server.
- Edits are kept as a draft until you press **Save rules**. A problem with a
  rule shows on its line, and Save stays off until every problem is fixed.

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
- Saving refuses two lists that undo each other where both apply (`Unify → UniFi` on one folder, `UniFi → Unify` on the whole library), and a regular expression that matches empty text (a lookahead on its own).
- A rewrite keeps the file's permissions, its owner where the server is allowed to set it, and goes through a symlink to the real file.
- Saving refuses a rule that would never settle, for example `UniFi` →
  `UniFi Network` (the replacement contains the term again), or `A → B` followed
  by `B → A`.
- Each job's log lists the replacements per rule: `Corrected 3 terms in
  Talk.en.srt: Ubiquity → Ubiquiti ×2, Unify → Unifi ×1`.

## Example: a UniFi library

A list named *Ubiquiti* that is on for the folder `UniFi`:

| Find | Replace with | When | Match |
|---|---|---|---|
| `Unify` | `Unifi` | Before translation | Whole word |
| `unify` | `unifi` | Before translation | Whole word |
| `Ubiquity` | `Ubiquiti` | Before translation | Whole word |

You can type the three pairs one by one, or paste them in one go.

## Storage

Lists are stored in `config.json` under `correction_rule_sets`, as a JSON
array of `{ id, name, enabled, paths, rules: [{ id, find, replace, stage, match,
caseSensitive, languages, enabled }] }` (`stage`: `source`, `output` or
`both`; `match`: `word`, `phrase` or `regex`). The matching code is
`src/shared/corrections.ts`, and the file rewriting is `src/server/corrections.ts`.
The UI lives in `src/client/features/corrections/` (the list editor, the
Library panel block, and the draft and save logic).
