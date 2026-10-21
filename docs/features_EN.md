# Feature details & configuration guide

The README lists only the core capabilities; prerequisites, costs, known limitations and configuration live here.（中文版本：[features.md](features.md)）

## Contents

- [Guided reading & stage checks](#guided-reading--stage-checks)
- [MinerU parsing: scanned PDFs & click-to-cite formulas](#mineru-parsing-scanned-pdfs--click-to-cite-formulas)
- [Embedding semantic search](#embedding-semantic-search)
- [Selection translation (formulas preserved)](#selection-translation-formulas-preserved)
- [Bilingual split view (two modes)](#bilingual-split-view-two-modes)
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

Once configured: newly uploaded scanned PDFs go through MinerU automatically; for papers already in the library, open the "∑" panel and click "Re-parse with MinerU" (**old caches are not re-parsed automatically** — re-parse a paper explicitly if you want its formulas searchable).

> Notes: the cloud `pipeline` channel is verified end-to-end with a real token (19-page paper, 18/18 formulas identical to local output); `vlm`-series models are unverified. The token is stored 0600 and only ever shown masked. See [reader-ux-requirements.md](reader-ux-requirements.md) for troubleshooting.

## Embedding semantic search

Point `search_paper` at an OpenAI-compatible `/embeddings` endpoint (Settings → Paper Reader → "Embedding search (optional)" card: URL / model / key — a real request is fired as a precheck before saving): semantically close passages that share **zero keywords** with your query still enter the candidate set — plain-language questions ("how is the learning rate scheduled") hit terminology passages, fused with keyword hits, never replacing them. Unconfigured (or half-configured) = off by default: not a single request is sent, and search behaves exactly as before.

> ⚠️ **Privacy notice**: once enabled, two kinds of text are sent to the endpoint you configure — ① the paper's chunk texts (body passages, for chunk vectors); ② the query text of every search (your input at each retrieval, for the query vector). The endpoint must be one you trust; if unconfigured, not a single request is sent.

Configure one of three ways (same priority as the translate endpoint): the settings panel (recommended) > profile YAML `config.embed` > the environment variable `DSH_EMBED_API_KEY` (key only). Vectors are cached in `<topic>/<paper>.embeddings.json` (vectors only — no plaintext key, no query text), invalidated automatically by endpoint/model/content hash — switching endpoint or model, or re-transcribing, triggers recomputation; chunks are submitted in `batchSize` batches (default 32) — any failed batch degrades the whole retrieval and writes nothing. If the endpoint is unreachable during a search, keyword results return as usual with the degradation reason noted — no silent failures.

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

**Known limitations (stated plainly, not glossed over)**:

- **No request has ever been sent to a real LLM endpoint**: all development verification used a fake upstream (to avoid spending money and to avoid using your key). "Does the model really keep formulas verbatim" is backed by two decidable assertions — a **byte-level prompt contract** and a **per-formula check on the reply** — but there is no end-to-end run against a real provider key.
- MinerU occasionally splits **one formula into two `$…$` fragments** (the first ending in `=`). In that shape only half a formula may be restored (e.g. `action $\hat{a}_t\sim\pi_\theta(\cdot\ |$`); the `$`-pairing check cannot catch it. Not observed in the local corpus; left for follow-up.
- A **literal `$`** inside the selection (a real dollar sign printed in the text) can, in an extreme shape, produce a false "N formulas were not preserved" note. Recorded; it does not affect the translation itself.
- **No formula replacement in the Chinese / dual views** (the bbox only holds for original pages), which is why the "译" button only appears in the original view.

## One-click Chinese: live progress & no more truncated paragraphs

**Progress bar (top bar, shown while generating)**: a slim bar plus stage text (e.g. "Translate Paragraphs · 76%", "Add Fonts (0/10) · 90%"), tracking babeldoc's overall progress. Translations started **elsewhere** keep showing progress too (another session, or after refreshing the page, polling resumes automatically); the bar disappears on completion and the existing success/failure notice takes over.

**Long paragraphs are no longer truncated (driven by `runtime/babeldoc-driver.py`)**:

- babeldoc used to omit `max_tokens` when calling the LLM (many endpoints default to only 2k–4k, silently truncating long Chinese translations). The driver sizes it explicitly from the input (≈4 chars/token for Latin, ≈1.5 for CJK; budget ≈2.6× the input, capped at 8192).
- If still truncated (`finish_reason=length`): retry once at the full cap, then **split the input on newline/sentence boundaries, translate pieces separately, and join back**. If splitting would tear a rich-text placeholder (`<b12>…</b12>`, formula placeholders) in half, it **refuses to split**.
- Endpoints that reject `max_tokens` (or only accept `max_completion_tokens`): the parameter is dropped and the request resent. Endpoints that refuse disabling thinking: the field is removed and retried with `reasoning_effort=low`. Each fallback fires **at most once** and is logged; no infinite retries.
- **Honest degradation**: if no python is found next to babeldoc's venv (or the driver script is missing), it falls back to running plain babeldoc — **no progress bar**, and single requests may still hit the endpoint's default cap (the old behavior). A failed in-driver patch install likewise falls back to vanilla babeldoc: translation still works, progress and length fixes are lost.
- During translation, full logs land in `<paper>.babeldoc.log` (under `.pdf2zh-tmp/` in the data dir) — debugging no longer depends on a 400-character tail.

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

## Library management details

- Deletion = **moved to trash** `data/.trash/<timestamp>/` (with a manifest); move files back into the topic folder to recover. No auto-cleanup or one-click restore UI in this version
- Files moved to trash = the paper's same-named artifacts: `<paper>.pdf`, `.txt`, `.pages.json`, `.transcript.json`, `.mineru.md`, `.mineru.json`, `.embeddings.json`, `.study.json`, plus translation variants `<paper>-en.pdf` / `-zh.pdf` / `-dual.pdf` (including leftover `.tmp-*`); chat history is **not** deleted (it lives in dsh's session store)
- **Preconditions**: deletion/rename is refused while the paper has a running session, a translation in progress, or another delete/rename in flight
- **Safety boundary**: deletes/renames only ever touch the library directory; path traversal (`..`, absolute paths, symlink escapes) is rejected; a mid-way failure rolls back already-moved files
- After a rename: transcripts/translations/study profiles move along; past chat sessions are **kept** but no longer listed under the new name (session ids encode the old name); case-only renames work on macOS/Windows
- Oddly named files placed into `data/` by hand (e.g. `.hidden.pdf`) can still be deleted/renamed — nothing becomes a visible-but-undeletable orphan
