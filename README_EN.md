# dsh-paper-reader

[![npm version](https://img.shields.io/npm/v/@ggboy123/dsh-paper-reader)](https://www.npmjs.com/package/@ggboy123/dsh-paper-reader)
[![npm downloads](https://img.shields.io/npm/dm/@ggboy123/dsh-paper-reader)](https://www.npmjs.com/package/@ggboy123/dsh-paper-reader)
[![license](https://img.shields.io/github/license/GGboya/dsh-paper-reader)](https://github.com/GGboya/dsh-paper-reader/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/GGboya/dsh-paper-reader?style=social)](https://github.com/GGboya/dsh-paper-reader/stargazers)

**中文**: [README.md](README.md)

A [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) plugin: a **paper reading workbench** — paper library + PDF reader + AI companion. Every answer cites page numbers, and clicking a page jumps back to the exact highlighted passage. Current version: **v1.5.0**.

> 💬 **QQ group: 1127244508** — questions, feature requests, and bug reports are all welcome.

![Demo: select-to-ask, answers cite page numbers, click a page to jump back to the highlighted passage](docs/demo.gif)

![Default: official sidebar untouched, just one extra toggle](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/screenshot-default.png)

![Reading mode: paper library + PDF reader + native chat](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/screenshot-reading.png)

## Core capabilities

- 📚 **Three-pane workbench**: Topics → Papers library, centered PDF reader (zoom / fit-width / scroll ↔ single-page paged mode / keyboard paging), native chat on the right
- 💬 **Page-cited companion**: every answer cites page numbers; click one to jump back and flash the passage; select-to-ask on any text; 🕐 conversation history, ＋ new chat
- 🤖 **Tutor mode**: paper sessions automatically use a dedicated preset — step-by-step reading plans, section-by-section coaching, graded quizzes; progress accumulates across sessions
- 🀄 **Chinese version**: original ↔ full-Chinese in-place toggle (babeldoc auto-installed, zero preinstall); one-click export (Chinese / bilingual PDF)
- 🗂️ **Library management**: rename/delete topics and papers (deletion shows a file manifest first, goes to a **recoverable** trash; non-empty topics support batch-clear with one confirmation)
- 🈯 **Selection translation (formulas preserved)** (v1.5.0): select text in the reader → the ask bubble gains a **"译" (Translate)** button → a **translation-only** bubble opens (there is **no** "insert into chat" and **no** "copy" button, and the plugin never writes to your clipboard on its own). **When the selection overlaps a formula**, the plugin replaces the garbage formula glyphs in the PDF text layer with the LaTeX MinerU recognized and asks the model to **keep formulas verbatim** (nothing inside `$…$` is translated or rewritten). **Costs and prerequisites**: ① you must configure the translation endpoint first (the same config the Chinese-PDF generation uses; with nothing configured, clicking "译" opens the endpoint form and retries automatically after saving); ② **formula preservation requires that paper to have been parsed by MinerU** — without an artifact it **falls back to plain translation**, and since formulas are unreadable in the text layer the bubble **says so honestly** ("translation may be inaccurate"). That is by design, not a defect.
- 🖥️ **Bilingual split view (two modes, switchable)** (v1.5.0): two new toolbar buttons, **"对照" (Side-by-side page)** and **"分屏" (Split)** — switch any time, click again to go back to the original; the choice is remembered per paper. **Mode A 「对照」** shows babeldoc's `-dual.pdf` (original and translation laid out on the same doubled-width page, auto fit-width); **Mode B 「分屏」** puts the original on the left and `<paper>-zh.pdf` on the right with **synchronised scrolling** (same page + same in-page ratio). **Costs and prerequisites**: mode A needs `-dual.pdf` and mode B needs `-zh.pdf`; both are produced by babeldoc (click "中" in the toolbar — **the first run takes a few minutes** and needs the translation endpoint); **without the artifact the button is greyed out with an explanation**; the split view needs a panel at least 640px wide — narrower than that it explains instead of switching.
- ➕ **Two optional add-ons** (off by default, see "Advanced"): MinerU parsing — scanned PDFs become readable, formulas become click-citable and searchable; an embeddings endpoint — plain-language semantic search

Installing **does not modify the official UI**: a single "📚 Paper Reading" toggle appears at the bottom of the sidebar; click to enter reading mode, click again to restore.

## Install

### Everyday users: official desktop app (recommended)

**Two steps**: install the official DeepSeek desktop app → add the plugin inside it.

1. Install [the official DeepSeek desktop app](https://www.deepseek.com/download/) (the DeepSeek Harness desktop) and sign in
2. Sidebar → **Plugins** → **Add plugin**, enter `@ggboy123/dsh-paper-reader@latest`, open the plugin's detail page and flip the **Enable** switch, then **restart the app**

Done. Click "📚 Paper Reading" at the bottom of the sidebar, upload a PDF, and start reading.

Full walkthrough (add plugin → enable → restart → open a paper and ask):

![Install and use the paper-reading plugin on the official desktop app](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/desktop-official-use.gif)

> Verified on official desktop V0.2.0-rc.2 (bundled dsh 0.2.0-rc.2, macOS arm64).
> Requires ≥1.2.0 — older versions are rejected by the 0.2.x runtime's peer-compatibility check.

> To browse a plugin marketplace inside the client (4000+ plugins, categories, one-click install), also install the community plugin [`dshmarket`](https://github.com/dsh-market/dsh-market); this plugin is listed there.

**Pitfalls (all hit in real testing)**:

- **After upgrading, the plugin's enable switch resets to off**: sidebar → Plugins → flip **Enable** → restart. The symptom is misleading — the library tree is still there but clicking papers does nothing
- **Always add with `@latest`**: a bare add on an already-installed plugin is a no-op (dsh's plugin manager keeps the first-recorded version)
- If pnpm's `minimumReleaseAge` supply-chain policy is on (desktop default): wait out the window, or add `minimum-release-age-exclude[]=@ggboy123/dsh-paper-reader` to `~/.dsh/profiles/web/.npmrc`; the desktop's exclusion list lives in `~/.dsh/profiles/desktop/pnpm-workspace.yaml` (`minimumReleaseAgeExclude`)
- The old PaperReader desktop bundle (community DSH Desktop) is **no longer maintained** — migrate to this path

### Developers: CLI dsh

```bash
dsh plugin --profile web add @ggboy123/dsh-paper-reader@latest
```

> The package lives under the `@ggboy123` scope: the bare name is taken by a different plugin.
> Do NOT install via `github:GGboya/dsh-paper-reader` — dist is not committed, so a git install leaves the profile unable to start.

**Upgrades** also use `@latest` (or an explicit version) — a bare `add` on an installed dependency is a no-op:

```bash
dsh plugin --profile web add @ggboy123/dsh-paper-reader@latest   # always newest
# dsh plugin --profile web add @ggboy123/dsh-paper-reader@1.5.0  # or pin a version
grep '"version"' ~/.dsh/profiles/web/node_modules/@ggboy123/dsh-paper-reader/package.json   # check current version
# Restart dsh web; hard-refresh the browser (Cmd+Shift+R) to avoid cached reader pages
```

## How to use

1. **Enter**: click "📚 Paper Reading" at the bottom of the sidebar — it becomes the library tree (click again to restore the official workspace list)
2. **Add papers**: ＋ create a topic → ⬆ upload PDFs (with an empty library, "Upload PDF" auto-creates a default topic)
3. **Read + ask**: click a paper — reader in the middle, chat on the right. Ask in the input box (no need to name the paper; answers cite pages), or **select text** in the reader for a pop-up question box; click "page N" in an answer to jump back
4. **Chinese version**: the "中" button — one click generates a translation if none exists (first use auto-installs the engine; fill in an OpenAI-compatible endpoint once — DeepSeek/GLM/Kimi keys all work); ⤓ downloads the version you're viewing; ▣ toggles single-page mode
5. **Manage**: hover a row for ✎ rename / 🗑 delete. Deletion lists the files first, then moves them to a **recoverable trash** (`data/.trash/`); deleting a non-empty topic = batch-clear with one confirmation
6. **Chats**: 🕐 in the chat header shows that paper's history; ＋ starts a new conversation

## Advanced (optional, off by default)

### MinerU parsing: scanned PDFs & click-to-cite formulas

By default text is extracted locally with pdf.js — **plain text-native PDFs need no configuration at all**. Two scenarios need MinerU:

- **Scanned PDFs** (old papers, book chapters, scanned handouts): no text layer, pdf.js can't read them; MinerU (OCR) can
- **Formulas**: formulas in PDFs are graphical garbage — unselectable and unsearchable. Once MinerU recovers them as LaTeX, **click a formula and its LaTeX is cited straight into the chat**; formula queries like `QK^T` hit search; the "∑ 公式" panel lists every formula by page

**You need to set this up yourself (pick one)**, configured under **Settings → Paper Reader → "MinerU parser"**:

| Option | Setup | For |
| --- | --- | --- |
| Cloud (easiest) | Register at [mineru.net](https://mineru.net) → create a token under "API Management" → in settings pick mode "Cloud", paste the token, "Test connection" → save. ~1 minute, free quota | Most people |
| Self-hosted (no signup) | `pip install -U "mineru[core]"` → `mineru-api --host 127.0.0.1 --port 8000` → pick mode "Local" in settings | Heavy/privacy-minded users; free, unlimited, papers never leave your machine |

Once configured: newly uploaded scanned PDFs go through MinerU automatically; for papers already in the library, open the "∑" panel and click "Re-parse with MinerU" (**old caches are not re-parsed automatically** — re-parse a paper explicitly if you want its formulas searchable).

> Notes: the cloud `pipeline` channel is verified end-to-end with a real token (19-page paper, 18/18 formulas identical to local output); `vlm`-series models are unverified. The token is stored 0600 and only ever shown masked. See [docs/reader-ux-requirements.md](docs/reader-ux-requirements.md) for troubleshooting.

### Embedding semantic search

Point `search_paper` at an OpenAI-compatible `/embeddings` endpoint (Settings → Paper Reader → "Embedding search (optional)" card: URL / model / key — a real request is fired as a precheck before saving): semantically close passages that share **zero keywords** with your query still enter the candidate set — plain-language questions ("how is the learning rate scheduled") hit terminology passages, fused with keyword hits, never replacing them. Unconfigured (or half-configured) = off by default: not a single request is sent, and search behaves exactly as before.

> ⚠️ **Privacy notice**: once enabled, two kinds of text are sent to the endpoint you configure — ① the paper's chunk texts (body passages, for chunk vectors); ② the query text of every search (your input at each retrieval, for the query vector). The endpoint must be one you trust; if unconfigured, not a single request is sent.

Configure one of three ways (same priority as the translate endpoint): the settings panel (recommended) > profile YAML `config.embed` > the environment variable `DSH_EMBED_API_KEY` (key only). Vectors are cached in `<topic>/<paper>.embeddings.json` (vectors only — no plaintext key, no query text), invalidated automatically by endpoint/model/content hash — switching endpoint or model, or re-transcribing, triggers recomputation; chunks are submitted in `batchSize` batches (default 32) — any failed batch degrades the whole retrieval and writes nothing. If the endpoint is unreachable during a search, keyword results return as usual with the degradation reason noted — no silent failures.

> **Non-goals** (for later): local ONNX / transformers.js models, whole-library precomputation, vector databases — this round is API endpoints only.

## Library management details

- Deletion = **moved to trash** `data/.trash/<timestamp>/` (with a manifest); move files back into the topic folder to recover. No auto-cleanup or one-click restore UI in this version
- Files moved to trash = the paper's same-named artifacts: `<paper>.pdf`, `.txt`, `.pages.json`, `.transcript.json`, `.mineru.md`, `.mineru.json`, `.embeddings.json`, `.study.json`, plus translation variants `<paper>-en.pdf` / `-zh.pdf` / `-dual.pdf` (including leftover `.tmp-*`); chat history is **not** deleted (it lives in dsh's session store)
- **Preconditions**: deletion/rename is refused while the paper has a running session, a translation in progress, or another delete/rename in flight
- **Safety boundary**: deletes/renames only ever touch the library directory; path traversal (`..`, absolute paths, symlink escapes) is rejected; a mid-way failure rolls back already-moved files
- After a rename: transcripts/translations/study profiles move along; past chat sessions are **kept** but no longer listed under the new name (session ids encode the old name); case-only renames work on macOS/Windows
- Oddly named files placed into `data/` by hand (e.g. `.hidden.pdf`) can still be deleted/renamed — nothing becomes a visible-but-undeletable orphan

## Selection translation and bilingual split view (v1.5.0)

### Selection translation (formulas preserved)

**How to use**: select a passage in the reader → the familiar "select-to-ask" bubble appears (behaviour unchanged) → click **"译" (Translate)** → a **translation bubble** opens containing **only the translation** (plus one honest note line). Re-select to retranslate; click outside or press Esc to dismiss.

That bubble has **no** "insert into chat" and **no** "copy" button (as requested), and the plugin **never** writes to your clipboard automatically. The asking path is untouched: just select again and you are back in the original ask bubble.

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

### Bilingual split view (two modes)

Two new toolbar buttons; switch any time and **click again to return to the original**. Each paper remembers its last view (and the memory follows the paper across renames):

| Button | Mode | What you are looking at | Prerequisite |
| --- | --- | --- | --- |
| **对照** | A: side-by-side page | babeldoc's `-dual.pdf` (original + translation on one doubled-width page) | needs `-dual.pdf` |
| **分屏** | B: two panes | left: original `<paper>.pdf`; right: `<paper>-zh.pdf` | needs `-zh.pdf` |

- **Both artifacts come from babeldoc**: click "中" in the toolbar (**the first run installs the engine and translates — a few minutes**, and needs the translation endpoint). If the artifact is missing the button is **greyed out with the reason stated** — never a dead click.
- **Synchronised scrolling**: scrolling either pane moves the other to the **same page + same in-page ratio**; whichever pane you are scrolling leads, so the two never fight each other. In paged mode (`▣`) both panes show the same page. **If the Chinese PDF has a different page count, the panes are mapped proportionally** and a one-off notice appears in the status bar.
- **Width**: the split view needs a panel at least **640px** wide; narrower, clicking "分屏" only explains and does **not** switch. Shrinking below 640px while split falls back to the original automatically.
- **Interaction with existing features**: while split, the left pane is the ordinary original view — **formula hotspots stay clickable** (the right pane neither participates in hit-testing nor gets a hotspot layer), the formula panel keeps working, and the "中" toggle is disabled during split (to avoid conflicting semantics). Switching to the Chinese / dual view still disables hotspots, exactly as before (the bbox only holds for original pages).

## Contributing

```bash
git clone https://github.com/GGboya/dsh-paper-reader
cd dsh-paper-reader && pnpm install && pnpm run build
dsh plugin --profile web add ./dsh-paper-reader   # run from the parent dir, or use an absolute path
dsh --profile web                                  # sidebar becomes the library tree
```

![Contributing: clone → pnpm install → build → local install](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/dev-workflow.gif)

- After changes, `pnpm run build` and restart the profile; `npm test` runs the full suite (354 cases; CI runs on ubuntu/macos/windows)
- Library directory defaults to `~/.dsh-paper-reader/data`, override in the profile's `cordis.patch.yml` (can point straight at pdfqa's `data/` to reuse caches); translation/MinerU/embedding endpoints are best filled in the settings UI (stored under `$DSH_HOME/.dsh-paper-reader/`, 0600) — YAML `config.translate` / `config.mineru` / `config.embed` fall back to deployer defaults
- Translation-engine smoke tests (Windows dependency integrity, no local Windows needed): `pnpm smoke:engine clean|managed-uv|pip-fallback|repair|translate`; CI runs them on fresh machines weekly

## Architecture

```
src/
  index.ts      Cordis shell: injects tools; mounts routes once webServer etc. are ready
  tools.ts      5 agent tools: list_papers / transcribe_pdf / search_paper / study_progress / study_update
  host.ts       webServer routes (/paper-reader/*), connection.requestRejection auth;
                sessionController.create/prompt (agentPreset=paper-reader) + follow SSE bridge
  library.ts    pure functions: library directory conventions & parsing (.txt/.pages.json/.transcript.json/.mineru.* paths)
  library-manage.ts pure functions: delete/rename (trash, exact-stem matching, path-traversal guards, batch clear)
  transcribe.ts pure functions: pdf.js extraction + page offsets + MinerU backend selection & cache-source semantics
  mineru.ts     pure functions: MinerU client (local /tasks polling; mineru.net v4 cloud + minimal ZIP reader)
  mineru-config.ts / embed-config.ts / translate-config.ts / typesafe-config.ts pure functions: endpoint config I/O (0600) + prechecks
  search.ts     pure functions: chunking + keyword scoring + formula-query normalization + hybrid embedding recall
  embed.ts      pure functions: /embeddings client + chunk-vector cache
  formulas.ts   pure functions: MinerU formula index (LaTeX + bbox → reader hot zones/panel)
  study.ts      pure functions: study profile (plan + quiz scores) I/O
  translate.ts  pure functions: babeldoc invocation (Chinese / bilingual PDF generation)
  babeldoc-install.ts pure functions: auto-install babeldoc without a Python env (uv → managed Python → venv)
  translate-selection.ts pure functions: selection translation with formula preservation (aligns inline formulas against MinerU block text, prompt/request-body contract, per-formula preservation check, in-memory LRU cache)
  rerank.ts     pure functions: search_paper semantic rerank (TypeSafe/Jev; falls back to keyword ranking)
  preset.ts     pure functions: installs the bundled agent preset into $DSH_HOME/.agent-presets/
presets/paper-reader/  the "Paper Tutor" agent preset (full persona prompt + compaction)
reader/index.html      the reader page (pdf.js, independent of the React host, iframe-carried)
lib/client.js          browser half: library tree (sidebar.workspaces takeover) + PDF tab + main panel
```

## Contributors

Thanks to everyone who has contributed:

<a href="https://github.com/GGboya/dsh-paper-reader/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=GGboya/dsh-paper-reader" alt="Contributor avatars" />
</a>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=GGboya/dsh-paper-reader&type=Date)](https://star-history.com/#GGboya/dsh-paper-reader&Date)

## License

MIT
