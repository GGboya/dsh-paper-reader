# Feature details & configuration guide

The README lists only the core capabilities; prerequisites, costs, known limitations and configuration live here.（中文版本：[features.md](features.md)）

## Contents

- [Guided reading & stage checks](#guided-reading--stage-checks)
- [MinerU parsing: scanned PDFs & click-to-cite formulas](#mineru-parsing-scanned-pdfs--click-to-cite-formulas)
- [Embedding semantic search](#embedding-semantic-search)
- [Selection translation (formulas preserved)](#selection-translation-formulas-preserved)
- [Notes](#notes)
- [Bilingual split view (two modes)](#bilingual-split-view-two-modes)
- [PDF dark mode](#pdf-dark-mode)
- [Per-paper folders (incl. old-library migration)](#per-paper-folders-incl-old-library-migration)
- [Nested subtopics](#nested-subtopics)
- [Scoped asking](#scoped-asking)
- [Long-document performance & view switching](#long-document-performance--view-switching)
- [Library management details](#library-management-details)

## Guided reading & stage checks

After the plugin is enabled and the app restarts, the `paper-reader` preset is registered with the plugin — **no separate agent install or copied configuration is needed**. It is only added as an optional dsh preset: new conversations opened from the paper library still use dsh's default agent, and the plugin never switches it for you. When you want stage checks, select “论文伴读” (Paper Reading Tutor) manually in the conversation's preset picker. Existing conversations are not rewritten.

- **Quick Q&A**: selection questions and isolated factual questions are answered directly with clickable page citations; they do not complete steps in a learning plan.
- **Guided learning**: say “带我读”, “guide me through this paper”, “continue”, or “quiz me”. The AI reads the current study progress and creates a 3–6 step plan. Each step starts only with original-page links and a few questions; you read the original and answer in your own words.
- **Earn the transition**: the AI checks the core ideas, key reasoning/evidence, and major misconceptions at the depth expected for the current step. For vague, copied, or incorrect answers it assigns targeted re-reading, asks follow-ups, and gives progressive hints. Until the current step passes, it does not assign or explain the next stage in the guided conversation. A fresh answer is still required after remediation; to skip a step, ask for a short test-out check instead.
- **Not a substitute reader**: no whole-paper/section summary or pre-explanation before your first genuine attempt. After all steps, a 3–5 question integrative quiz provides item-by-item feedback and exact re-reading links for weak points.

The study profile lives beside each paper as `<paper>.study.json`, storing the plan and quiz history; all conversations for the same paper share it. Stage passing is judged by the AI from your answers, not by an independent deterministic grader. This gate only controls **progression in the guided conversation** — it does not lock PDF navigation or search, and Quick Q&A remains available.

## MinerU parsing: scanned PDFs & click-to-cite formulas

By default text is extracted locally with pdf.js — **plain text-native PDFs need no configuration at all**. Two scenarios need MinerU:

- **Scanned PDFs** (old papers, book chapters, scanned handouts): no text layer, pdf.js can't read them; MinerU (OCR) can
- **Click to cite a formula**: formulas in PDFs are graphical garbage — unselectable and unsearchable. Once MinerU recovers them as LaTeX, **clicking a formula in the PDF puts its LaTeX into the ask bubble** (send it and the formula is cited with your question); formula queries like `QK^T` hit search; the "∑ 公式" (Formulas) panel lists every formula by page

**You need to set this up yourself (pick one)**, configured under **Settings → Paper Reader → "MinerU parser"**:

| Option | Setup | For |
| --- | --- | --- |
| Cloud (easiest) | 1. Register at [mineru.net](https://mineru.net) 2. Create a token under "API Management" 3. In settings pick mode "Cloud", paste the token, "Test connection" → save. ~1 minute, free quota | Most people |
| Self-hosted (no signup) | `pip install -U "mineru[core]"` → `mineru-api --host 127.0.0.1 --port 8000` → pick mode "Local" in settings | Heavy/privacy-minded users; free, unlimited, papers never leave your machine |

Once configured: newly uploaded scanned PDFs go through MinerU automatically; an untranscribed paper has a dedicated **转录** (Transcribe) button in the toolbar using the active backend; for papers with an older cache, open the "∑" panel and click "Re-parse with MinerU" (**old caches are not re-parsed automatically** — re-parse a paper explicitly if you want its formulas searchable).

> Notes: the cloud `pipeline` channel is verified end-to-end with a real token (19-page paper, 18/18 formulas identical to local output); `vlm`-series models are unverified. The token is stored 0600 and only ever shown masked. See [reader-ux-requirements.md](reader-ux-requirements.md) for troubleshooting.

## Embedding semantic search

Point `search_paper` at an OpenAI-compatible `/embeddings` endpoint (Settings → Paper Reader → "Embedding search (optional)" card: URL / model / key — a real request is fired as a precheck before saving): semantically close passages that share **zero keywords** with your query still enter the candidate set — plain-language questions ("how is the learning rate scheduled") hit terminology passages, fused with keyword hits, never replacing them. Unconfigured (or half-configured) = off by default: not a single request is sent, and search behaves exactly as before.

> ⚠️ **Privacy notice**: once enabled, two kinds of text are sent to the endpoint you configure — ① the paper's chunk texts (body passages, for chunk vectors); ② the query text of every search (your input at each retrieval, for the query vector). The endpoint must be one you trust; if unconfigured, not a single request is sent.

Configure one of three ways (same priority as the translate endpoint): the settings panel (recommended) > profile YAML `config.embed` > the environment variable `DSH_EMBED_API_KEY` (key only). Vectors are cached in `<topic>/<paper>.embeddings.json` (vectors only — no plaintext key, no query text), invalidated automatically by endpoint/model/content hash — switching endpoint or model, or re-transcribing, triggers recomputation; chunks are submitted in `batchSize` batches (default 10, the strictest per-batch input cap among known endpoints — Alibaba Bailian text-embedding-v3/v4 allows 10 and qwen3.7-text-embedding allows 20; raise it via the "Batch size" field on the embedding card or profile YAML when your endpoint allows more) — any failed batch degrades the whole retrieval and writes nothing (when the failure looks like a batch-cap rejection, the degradation reason appends a hint to lower the batch size). The precheck before saving fires **one real batch at the effective batch size**, so a per-model input cap surfaces at save time instead of on the first search. If the endpoint is unreachable during a search, keyword results return as usual with the degradation reason noted — no silent failures.

> **Non-goals** (for later): local ONNX / transformers.js models, whole-library precomputation, vector databases — this round is API endpoints only.

## Selection translation (formulas preserved)

**How to use**: select a passage in the reader → the familiar "select-to-ask" bubble appears (behaviour unchanged) → click **"译" (Translate)** → a **translation bubble** opens containing **only the translation** (plus one honest note line). Re-select to retranslate; click outside or press Esc to dismiss.

That bubble has **no** "insert into chat" and **no** "copy" button, and the plugin **never** writes to your clipboard automatically. The asking path is untouched: just select again and you are back in the original ask bubble.

**What happens to formulas** (the core of this feature):

- Formulas in the PDF text layer are **unreadable**: `$F_{\theta}$` often degrades to a bare `F` (the subscript is dropped entirely), `\sum` becomes `X`, fractions get flattened into one line, and delimiter pairs can even turn into control characters. Feeding that to a model guarantees wrong formulas in the translation.
- So: **each formula inside the selection is replaced by the LaTeX MinerU recognized**, and the model is explicitly told to **keep `$…$` verbatim** (no translation, no rewriting, no omissions, no added symbols). When the reply comes back, every formula token is **checked** to still be present, and the bubble tells you honestly if any went missing.
- Both kinds are covered: **display formulas** (located exactly with the MinerU `equation` block bbox) and **inline formulas embedded in prose** (e.g. `π(a|s)`, `Q(s,a)`, `x_t`). Inline formulas have **no bbox of their own** in MinerU's output (they live inside a text block), so the plugin recovers them by fuzzy-aligning the selection text against the MinerU block text.

**Prerequisites and costs (please read first)**:

| # | Prerequisite | What happens without it |
| --- | --- | --- |
| 1 | **A configured translation endpoint** (Settings → Paper Reader, or ⚙ in the reader toolbar; the same config used for Chinese-PDF generation) | Clicking "译" **opens the endpoint form automatically**, and **retries this translation** after you save (no wasted click). If the endpoint is incomplete the server refuses and the UI opens that form |
| 2 | **Formula preservation requires the paper to have been parsed by MinerU** (a `<paper>.mineru.json` artifact) | **Falls back to plain translation**: prose is translated normally, but formulas are unreadable in the text layer, so the bubble honestly says "this paper was not parsed with MinerU: the translation may be inaccurate". **By design, not a defect** |
| 3 | An artifact exists but one passage could not be aligned | Only the alignable parts are restored; the bubble says "some formulas could not be restored" |
| 4 | A very short selection (fewer than 4 effective characters, e.g. the lone `F`) | No restoration (not enough signal); the bubble says "selection too short, formula not restored" |

**OpenCode Go endpoints**: the "OpenCode Go" provider preset (`https://opencode.ai/inference/go/openai/v1`) requires an OpenCode Console subscription and its API key; model names follow the console (the preset list is only an input suggestion). Go asks every inference request to carry a stable `x-opencode-session` ID, and for `opencode.ai` endpoints the plugin **sends it automatically** on all three LLM paths (selection translate, whole-paper Chinese version, and the pre-save connection test). Whole-paper and selection translation share one ID per paper, stable across restarts; the ID is derived from a random 0600 secret under `$DSH_HOME/.dsh-paper-reader/` and **contains neither the paper name nor the key**. Other endpoints are unaffected — not a single extra header.

**Known limitations (stated plainly, not glossed over)**:

- **No request has ever been sent to a real LLM endpoint**: all development verification used a fake upstream (to avoid spending money and to avoid using your key). "Does the model really keep formulas verbatim" is backed by two decidable assertions — a **byte-level prompt contract** and a **per-formula check on the reply** — but there is no end-to-end run against a real provider key.
- MinerU occasionally splits **one formula into two `$…$` fragments** (the first ending in `=`). In that shape only half a formula may be restored (e.g. `action $\hat{a}_t\sim\pi_\theta(\cdot\ |$`); the `$`-pairing check cannot catch it. Not observed in the local corpus; left for follow-up.
- A **literal `$`** inside the selection (a real dollar sign printed in the text) can, in an extreme shape, produce a false "N formulas were not preserved" note. Recorded; it does not affect the translation itself.
- **No formula replacement in the Chinese / dual views** (the bbox only holds for original pages), which is why the "译" button only appears in the original view.

## Notes

**How to use**: selecting text still opens the original "select-to-ask" bubble exactly as before, now with two extra small buttons — **Note** saves the passage with its page, and **Global search** finds that passage in the document. Annotated text gets a blue wavy underline; hover to read the note, click to edit or delete it. The **Notes** button in the toolbar opens the notes window, which shares the find window's behaviour (draggable, edge-resizable, position remembered); the list is ordered by page and clicking an entry jumps back and flashes the source. Notes taken in the Chinese column of the split view jump back correctly too.

**Where they live**: one `<paper>.notes.json` per paper, next to `.txt` / `.study.json`. Notes follow the paper file — they survive a browser change, and move with the library if you take it to another machine; they also move with the paper on rename/delete (deletion goes to the trash and is recoverable). The file is plain JSON, so you can back it up or migrate it by hand.

**Known limitations (stated plainly)**:

- **No cross-tab lock**: saving is a whole-file read-modify-write. If the same paper is saved from two tabs at once, the later write wins (a note can be lost); saving concurrently with delete/rename can, in an extreme race, recreate the notes file at the old path. Accepted for a single-user plugin.
- Anchors are character ranges in that page's text layer. If the PDF itself is replaced or re-parsed so its text layer changes, the wavy underline may no longer match; the note body is still there and the list entry jumps to the page.
- A corrupted notes file (hand-edited invalid JSON) reads as an empty list rather than blocking the paper; fix it by replacing/removing that `.notes.json`.

## One-click Chinese: live progress & no more truncated paragraphs

**Progress bar (top bar, shown while generating)**: a slim bar plus stage text (e.g. "Translate Paragraphs · 76%", "Add Fonts (0/10) · 90%"), tracking babeldoc's overall progress. Translations started **elsewhere** keep showing progress too (another session, or after refreshing the page, polling resumes automatically); the bar disappears on completion and the existing success/failure notice takes over.

**Long paragraphs are no longer truncated (driven by `runtime/babeldoc-driver.py`)**:

- babeldoc used to omit `max_tokens` when calling the LLM (many endpoints default to only 2k–4k, silently truncating long Chinese translations). The driver sizes it explicitly from the input (≈4 chars/token for Latin, ≈1.5 for CJK; budget ≈2.6× the input, capped at 8192).
- If still truncated (`finish_reason=length`): retry once at the full cap, then **split the input on newline/sentence boundaries, translate pieces separately, and join back**. If splitting would tear a rich-text placeholder (`<b12>…</b12>`, formula placeholders) in half, it **refuses to split**.
- Endpoints that reject `max_tokens` (or only accept `max_completion_tokens`): the parameter is dropped and the request resent. Endpoints that refuse disabling thinking: the field is removed and retried with `reasoning_effort=low`. Each fallback fires **at most once** and is logged; no infinite retries.
- **Honest degradation**: if no python is found next to babeldoc's venv (or the driver script is missing), it falls back to running plain babeldoc — **no progress bar**, and single requests may still hit the endpoint's default cap (the old behavior). A failed in-driver patch install likewise falls back to vanilla babeldoc: translation still works, progress and length fixes are lost.
- During translation, full logs land in `<paper>.babeldoc.log` (under `.pdf2zh-tmp/` in the data dir) — debugging no longer depends on a 400-character tail.
- **Multiple endpoints & model choice**: add, edit, and remove multiple provider/model/API-key combinations in the settings popover. A legacy single-endpoint config automatically becomes the first list item. Generation and regeneration ask which endpoint to use, remember the choice, and share it with selection translation; with no configured endpoint, the settings popover opens directly. Keys are stored 0600 and only shown masked.
- **Cancellable, visible failures**: the toolbar can cancel an in-flight translation and immediately allows retrying with another endpoint; stale callbacks cannot overwrite a newer task. Periodic quota exhaustion (for example 1310 / weekly or monthly caps) fails without pointless retries, with the reason and reset time kept visible in the toolbar; transient rate limits are still retried.

**Verification scope**: the behaviors above were verified against a local mock OpenAI endpoint with the real babeldoc 0.6.4 pipeline (event stream 0→100, input-dependent max_tokens, escalation retry after `length`, clean exit). No long-document regression against a real paid endpoint has been run.

## Find in document (Ctrl+F / the 🔍 top-bar button)

**How to use**: click 🔍 or press Ctrl+F; typing searches as you go (220 ms debounce, **no auto-jumping** — jumping is left to Enter / Shift+Enter / clicking a result). The window is draggable, resizable by its edges, and toggles compact↔full; its position and size are remembered locally.

**Scope & limits (stated honestly)**:

- The index is built from the **pdf.js text layer**, not the DOM — full-document search works in paged/split modes too (not just the visible page). **Scanned PDFs without a text layer cannot be searched**; the UI says so (transcribe/MinerU first).
- Normalization ignores whitespace, hyphens, soft hyphens, and case; words broken across lines by hyphenation (`dis-tributed`) still match. **No stemming/synonyms**: searching `distributing` will not match `distributed`.
- In-page highlights are word-level rectangles (`Range.getClientRects` converted to percentage boxes, zoom-stable) and pointer-transparent — select-to-ask keeps working. If geometry fails in an edge case, whole-line spans get a background tint as a fallback (rough, but never "found yet invisible").
- Defensive caps: 2000 hits per document, 600 highlight boxes per page (excess is honestly labelled as truncated).

## Bilingual split view (two modes)

Two toolbar buttons; switch any time and **click again to return to the original**. Each paper remembers its last view (and the memory follows the paper across renames):

| Button | Mode | What you are looking at | Prerequisite |
| --- | --- | --- | --- |
| **对照** | A: side-by-side page | babeldoc's `-dual.pdf` (original + translation on one doubled-width page) | needs `-dual.pdf` |
| **分屏** | B: two panes | left: original `<paper>.pdf`; right: `<paper>-zh.pdf` | needs `-zh.pdf` |

- **Both artifacts come from babeldoc**: click "中" in the toolbar (**the first run installs the engine and translates — a few minutes**, and needs the translation endpoint). If the artifact is missing the button is **greyed out with the reason stated** — never a dead click.
- **Synchronised scrolling**: scrolling either pane moves the other to the **same page + same in-page ratio**; whichever pane you are scrolling leads, so the two never fight each other. In paged mode (`▣`) both panes show the same page. **If the Chinese PDF has a different page count, the panes are mapped proportionally** and a one-off notice appears in the status bar.
- **Width**: the split view needs a panel at least **640px** wide; narrower, clicking "分屏" only explains and does **not** switch. Shrinking below 640px while split falls back to the original automatically.
- **Interaction with existing features**: while split, the left pane is the ordinary original view — **formula hotspots stay clickable** (the right pane neither participates in hit-testing nor gets a hotspot layer), the formula panel keeps working, and the "中" toggle is disabled during split (to avoid conflicting semantics). Switching to the Chinese / dual view still disables hotspots, exactly as before (the bbox only holds for original pages).

## PDF dark mode

When dsh switches to its dark theme, the PDF reading area follows (**follow** is the default). The settings panel and the reader's "A" toolbar button share one config — changing either applies everywhere.

- **Four strength presets**: levels 0–3 from measured curves (white maps to 0 / 6 / 13 / 19), plus brightness / contrast sliders (0.5–1, overriding the preset); theme options are follow / never dark / force light / force dark.
- **How it works & the cost**: whole-page inversion with hue rotation back — **not a content-aware true night mode**. Photos, figures, and colour charts visibly desaturate and shift (measured: pure red `[255,0,0]` becomes pink `[229,134,134]`). For figure-heavy pages, switch it off temporarily (one click).
- **Downloads/exports are always the original bytes**: inversion happens only on screen.

## Per-paper folders (incl. old-library migration)

The new layout gathers every artifact of a paper into one folder `<topic>/<paper>/`: the `.pdf`, translation variants, transcript, study file, and notes all live there, and rename/delete moves the whole folder together.

An existing flat library (artifacts loose in the topic folder) **does not need manual moving**:

- The in-app migration entry produces a **dry-run report first** (which files move, any conflicts); nothing happens until you confirm.
- The migration is **idempotent, interruptible, and revertible**: copy-first-then-delete, any interruption can be resumed by re-running; every step is logged, and one `--rollback` restores everything along the log.
- CLI form: `npm run migrate` (i.e. `node dist/migrate.js`), flags `--data-dir <dir>`, `--dry-run` (default; read-only, changes nothing) / `--apply` / `--rollback <log>`, `--yes`, `--no-hash`; usage errors exit 64, and a corrupt migration log **fails loudly pointing at the line** instead of the classic "rolled back 0 files" false success.
- Running transcriptions or translations block migration (409 busy); execution yields the event loop file-by-file and does not freeze other requests.

## Nested subtopics

Topics can contain subtopics to any depth (limits: 16 levels, 100 chars per segment); rename and move-under-another-parent are supported.

- Deleting a non-empty topic still goes through the clear-plan + typed-name confirmation: the plan lists every paper in the **entire subtree**, and any paper with a running session or in-flight translation blocks the delete (409) — you never see just the first level.
- Creating / renaming / uploading runs **collision prechecks**: hitting an existing paper folder, old flat-layout artifacts, or a same-name-different-case object is a 409 naming the real on-disk entry — data is never silently shadowed.
- Over-long topic names from old libraries (beyond current limits) can still be **deleted, renamed, and cleared** (boundary operations skip the length limit); you just cannot create new structures with those names.

## Scoped asking

When asking, you can pick a scope: **this paper** (default) or **this topic (including all subtopics)**. Only that scope's directory contents and retrieval hits reach the model; out-of-scope content never appears.

- **Honest budget**: body text + hit fragments share a 40,000-character cap, manifests cap at 2,000; truncation is marked per paper (`full` / `truncated` / `omitted-no-room`…), and wholesale omissions say exactly who was omitted — no silent shrinking.
- **Honest name conflicts**: same-named papers inside a scope (different subtopics) are both explicitly omitted (`omitted-duplicate`) with reasons — one is never quietly picked over the other.
- **Missing scopes error**: a topic that was renamed or deleted returns 404 rather than assembling an empty-but-normal-looking scope.
## Long-document performance & view switching

Aimed at papers of dozens or hundreds of pages, and at reading that keeps flipping between the original and the Chinese version.

- **Lazy rendering while scrolling**: in scroll mode with 12+ pages, only pages near the viewport (roughly one and a half screens of margin above and below) get a canvas and text layer; the rest stay as **equal-height placeholders** — so the scrollbar length and page numbers are correct from the start and never grow while you scroll. Pages that leave the viewport release their canvas bitmap (formula hotspots are invalidated with them and rebuilt on return), so long documents no longer accumulate memory as you scroll.
- **Paged mode** already renders only the current page; documents under 12 pages still render in full (faster, and no placeholder flicker).
- **Switching between original and Chinese no longer reloads**: each view (original / Chinese / bilingual) keeps its own cache of already-painted page nodes, so switching just re-attaches the DOM — no re-parsing the PDF, no repainting; zoom, page number, scroll position and formula geometry come back with it. When idle the translation is pre-rendered into a hidden pane, so even the first switch is usually instant.
- **Switching language or reopening a paper no longer re-sends the PDF**: `/api/pdf` sends an `ETag` (file mtime + size) and `Last-Modified`, so the browser gets a 304 on a hit; **re-translating changes the file and therefore the ETag**, so you never see a stale translation.

**Known limits (stated plainly)**：

- Lazy rendering is scroll-mode only; where `IntersectionObserver` is unavailable it falls back to full rendering — never to blank pages.
- Text on placeholder pages is not in the DOM, but **find-in-document is unaffected** — its index is built on the pdf.js text layer rather than the DOM, so the whole paper stays searchable and a jump paints the target page first.
- There is a brief empty placeholder between a page entering the viewport and being painted; that is the cost of on-demand rendering, and not pre-rendering farther pages is what keeps memory in check.
- Formula hotspots and note underlines exist only for **painted pages**; they are filled in when you scroll back or jump.
- Very long bilingual documents (e.g. a `-dual.pdf` with doubled page width) held in the view cache at the same time noticeably raise memory use; switching papers releases inactive documents automatically.

## Library management details

- Deletion = **moved to trash** `data/.trash/<timestamp>/` (with a manifest); move files back into the paper folder to recover. No auto-cleanup or one-click restore UI in this version
- Files moved to trash = the paper's same-named artifacts: `<paper>.pdf`, `.txt`, `.pages.json`, `.transcript.json`, `.mineru.md`, `.mineru.json`, `.embeddings.json`, `.study.json`, `.notes.json`, plus translation variants `<paper>-en.pdf` / `-zh.pdf` / `-dual.pdf` (including leftover `.tmp-*`); chat history is **not** deleted (it lives in dsh's session store)
- **Preconditions**: deletion/rename is refused while the paper has a running session, a translation in progress, or another delete/rename in flight
- **Safety boundary**: deletes/renames only ever touch the library directory; path traversal (`..`, absolute paths, symlink escapes) is rejected; a mid-way failure rolls back already-moved files
- After a rename: transcripts/translations/study profiles/notes move along; past chat sessions are **kept** but no longer listed under the new name (session ids encode the old name); case-only renames work on macOS/Windows
- Oddly named files placed into `data/` by hand (e.g. `.hidden.pdf`) can still be deleted/renamed — nothing becomes a visible-but-undeletable orphan
