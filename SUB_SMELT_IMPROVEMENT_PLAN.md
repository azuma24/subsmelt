# SubSmelt Improvement Plan

This document outlines the technical improvements to move SubSmelt from "Correct Translation" to "Natural, Consistent Translation."

## 🎯 Objectives
1. **Eliminate "Lost in the Middle"**: Move from passive to active glossary injection.
2. **Ensure Series Consistency**: Implement cross-file memory (Series-Wide Memory).
3. **Human-like Naturalness**: Introduce a refinement pass for flow and tone.
4. **Code Health**: Refactor the `translator.ts` "god file" and remove `any` types.

---

## 🛠️ Technical Specifications

### 1. Active Glossary Injection
**Current**: Glossary is appended to the system prompt.
**Proposed**: 
- Implement a `scanForGlossaryTerms(text, glossary)` helper.
- For each chunk, identify which glossary terms are present.
- Append a "Direct Instructions" block to the prompt: `Current Chunk Glossary: [Term A -> Translation A, Term B -> Translation B]`.
- This forces the LLM to pay attention to specific terms in the immediate context.

### 2. Series-Wide Memory
**Current**: Analysis is per-file.
**Proposed**:
- Create a `.subsmelt_glossary.json` file at the root of the media folder (or a specific series folder).
- **Merge Logic**: When a new file is analyzed, merge its glossary with the series glossary (resolving conflicts or adding new terms).
- **Loading**: Use the series glossary as the base for all translations in that folder.

### 3. The Refinement Pass (Pass 2)
**Current**: One-shot translation.
**Proposed**:
- Add a `refineTranslation` function.
- After a chunk is translated, a second (optional) LLM call is made.
- **Prompt**: *"You are a professional editor. Review these translated subtitles for natural flow and tone. Correct any awkward phrasing while preserving the meaning and the glossary terms."*
- This can be toggled in settings.

### 4. Architectural Refactoring
**Proposed**: Split `src/server/translator.ts` into:
- `src/server/translator/engine.ts`: Core translation loop and chunking.
- `src/server/translator/ai-client.ts`: AI SDK wrappers and tool definitions.
- `src/server/translator/context.ts`: Analysis, glossary merging, and series memory.
- `src/server/translator/utils.ts`: Parsing, sanitization, and helper functions.
- **Type Safety**: Replace `any` with proper interfaces for `SubtitleCue`, `Job`, and `TranslationOptions`.

---

## 📈 Success Criteria
- [ ] Tests in `src/server` pass.
- [ ] Translations use glossary terms more consistently in long files.
- [ ] Glossary is persisted across multiple files in the same folder.
- [ ] No regression in existing functionality (STT, File Watcher, etc.).
