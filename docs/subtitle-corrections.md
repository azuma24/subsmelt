# Subtitle corrections

Corrections fix words that keep coming out wrong: a brand that Whisper
mishears, or a product name the translator renders differently every time. Rules are deterministic find → replace substitutions on cue text. They
are not a general quality check and do not fix mistranslations, timing or grammar.

## Where rules run

| Stage | When | What it changes |
|---|---|---|
| **Before translation** | Right after Whisper writes a transcript, and again when a translation job starts | The source subtitle on disk (any source in the set's folders, not only transcripts), and the text sent to the LLM. A replacement that looks like a name (capitals, digits, or a script without case, such as `Sereniti`, `A7 Pro` or `賽瑞尼`) is also added to the per-chunk glossary as a term to keep as written (`Sereniti -> Sereniti`). A plain lowercase fix such as `teh → the` is not, so the translator still translates it. |
| **After translation** | Just before the translated file is saved | The translated cues only. A rule can be limited to some target languages (`chi`, `jpn`). It applies by the folder the **translation** is saved in, which an output pattern such as `Subs/{{name}}.chi.srt` can make different from the source's folder. |
| **Before and after** | Both | Both. |

Fixing a speech-recognition mistake **before** translation is usually better:
the translator then reads "Sereniti" instead of guessing at "Serenity", and
every target language benefits. Use **after translation** for slips in the
translation itself.

## Lists and folders

Rules live in named **lists**, for example *Sereniti terms*. A list is defined
once and switched on for folders. It then applies to those folders and every
subfolder. **Whole library** applies to everything, so keep brand fixes scoped:
"anchor" is an ordinary English word in a movie. Lists run in order, and the
rules in a list run top to bottom.

There are two places to work with lists:

- **Library → open any file → Corrections.** The panel shows which lists apply
  to that file's folder, including lists inherited from a parent folder
  (marked "from AnKor"). A checkbox switches a list on or off for this folder,
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
  one that already has a list (a *Sereniti* list on `AnKor/` for a file in
  `AnKor/Tutorials/`), and you can pick any folder above the file.

Before anything is written, the dialog lists every file in scope that contains
the word, with a count and up to two sample lines shown before and after the
fix. All files are ticked. Untick any that should stay as they are, for example
where "anchor" is the ordinary verb. Unticking applies to this fix only, unless
you also tick **Never apply this rule to the unticked files**. The rule then
keeps those files as exceptions, and they are skipped by future jobs,
transcripts and dry runs. The rule's options show "Not applied to N files", with
**Apply everywhere again** to clear the list.

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
  several lines at once (`Serenity → Sereniti`, `a -> b`, `a => b`, or two
  columns copied from a spreadsheet) and they are all added.
- After you add a capitalised word, the editor offers its lowercase twin
  ("Also fix `anchor` → `ankor`?"), because whole-word rules match case.
- **Try a line** runs the list on a sample line, using the same code as the server.
- Edits are kept as a draft until you press **Save rules**. A problem with a
  rule shows on its line, and Save stays off until every problem is fixed.
- A filled-in last line joins the list when you click elsewhere, so **Save
  rules** keeps it. A word with no replacement still needs Enter or **Add rule**.
- In Settings, leaving Corrections saves the draft. A draft with a problem is
  not saved, and a message says why.

## Matching

- **Whole word** (default): the exact text, not touching another letter, digit
  or underscore in any script. `Anchor` matches in `Anchor Network` and `使用 Anchor。`,
  but not in `AnchorCloud`, `my_Anchor`, `Anchor2` or `超級Anchor網路`. This is the
  same as Python's Unicode `\b`.
- **Anywhere**: the exact text inside other text, for scripts without spaces
  (`賽瑞尼` → `Sereniti` in a Chinese translation).
- **Regular expression**: JavaScript syntax with Unicode on; `$1` and `$<name>`
  work in the replacement.
- **Match case** is on by default, so `Anchor` and `anchor` are separate rules.
  Turn it off to canonicalise every spelling (`ankor` → `AnKor`); matches already
  spelled like the replacement are not counted.

### Check with the translator

Some terms are also ordinary words: "anchor" is the brand Whisper misheard in
"open the anchor app", and the verb in "we anchor the dashboards". Turn on
**Check with the translator** in a rule's options (it then shows a **Check**
tag) and each match is put to the LLM, with the lines before and after it,
before it is replaced:

- Only a clear "yes" is replaced. A "no", an unclear or missing answer, or a
  failed request keeps the text exactly as written, so the check can only do
  less than the plain rule would.
- Matches are sent in batches of 40, one request per batch, so a file costs a
  few small requests at most. The tokens show under **Settings → Usage** as
  *Correction check*.
- Checked rules run inside translation jobs, where an LLM is available. They
  fix the text the translator reads and the saved translation, but the source
  file on disk is not rewritten for them, and a new transcript is not checked
  when it is saved. **Fix everywhere** applies them to the files you tick, as
  you have already confirmed those.
- A checked rule's replacement is not pinned in the glossary.
- The job log lists what was replaced after a check and what was kept as
  written.

A term split across two lines, two cues or a tag (`Uni<i>fy</i>`) is not a
match, and markup (`<i>`, `{\i1}`, `\N`) is never changed.

## The Convert page

Files uploaded on the Convert page belong to no media folder, so only lists
that are on **Whole library** apply to them, for both the source and the
translation.

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
- Saving refuses two lists that undo each other where both apply (`Anchor → AnKor` on one folder, `AnKor → Anchor` on the whole library), and a regular expression that matches empty text (a lookahead on its own).
- A rewrite keeps the file's permissions, its owner where the server is allowed to set it, and goes through a symlink to the real file.
- Saving refuses a rule that would never settle, for example `AnKor` →
  `AnKor Network` (the replacement contains the term again), or `A → B` followed
  by `B → A`.
- Each job's log lists the replacements per rule: `Corrected 3 terms in
  Talk.en.srt: Serenity → Sereniti ×2, Anchor → Ankor ×1`.

## Example: an AnKor library

A list named *Sereniti* that is on for the folder `AnKor`:

| Find | Replace with | When | Match |
|---|---|---|---|
| `Anchor` | `Ankor` | Before translation | Whole word |
| `anchor` | `ankor` | Before translation | Whole word |
| `Serenity` | `Sereniti` | Before translation | Whole word |

You can type the three pairs one by one, or paste them in one go.

## Storage

Lists are stored in `config.json` under `correction_rule_sets`, as a JSON
array of `{ id, name, enabled, paths, rules: [{ id, find, replace, stage, match,
caseSensitive, languages, enabled }] }` (`stage`: `source`, `output` or
`both`; `match`: `word`, `phrase` or `regex`). The matching code is
`src/shared/corrections.ts`, and the file rewriting is `src/server/corrections.ts`.
The UI lives in `src/client/features/corrections/` (the list editor, the
Library panel block, and the draft and save logic).
