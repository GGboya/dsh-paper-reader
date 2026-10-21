# dsh-paper-reader

[![npm version](https://img.shields.io/npm/v/@ggboy123/dsh-paper-reader)](https://www.npmjs.com/package/@ggboy123/dsh-paper-reader)
[![npm downloads](https://img.shields.io/npm/dm/@ggboy123/dsh-paper-reader)](https://www.npmjs.com/package/@ggboy123/dsh-paper-reader)
[![license](https://img.shields.io/github/license/GGboya/dsh-paper-reader)](https://github.com/GGboya/dsh-paper-reader/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/GGboya/dsh-paper-reader?style=social)](https://github.com/GGboya/dsh-paper-reader/stargazers)

**中文**: [README.md](README.md)

A [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) plugin: a **paper reading workbench** — paper library + PDF reader + AI companion. Every answer cites page numbers, and clicking a page jumps back to the exact highlighted passage. Current version: **v1.6.0**.

> 💬 **QQ group: 1127244508** — questions, feature requests, and bug reports are all welcome.

![Demo: select-to-ask, answers cite page numbers, click a page to jump back to the highlighted passage](docs/demo.gif)

![Default: official sidebar untouched, just one extra toggle](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/screenshot-default.png)

![Reading mode: paper library + PDF reader + native chat](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/screenshot-reading.png)

## Core capabilities

- 📚 **Three-pane workbench**: topic library + PDF reader + native chat on the right; installing does not modify the official UI — just one extra toggle in the sidebar
- 💬 **Page-cited companion**: every answer cites page numbers; click one to jump back and flash the passage; select-to-ask on any text; conversation history supported
- 🤖 **Tutor mode**: a dedicated preset makes step-by-step reading plans, coaches section by section, and grades quizzes; progress accumulates across sessions
- 🀄 **One-click Chinese version**: in-place original ↔ Chinese toggle; exportable translation PDFs (Chinese / bilingual); the translation engine auto-installs, zero preinstall
- 📏 **No more truncated paragraphs + live progress**: translation runs through `babeldoc-driver.py` — per-input output budgets (instead of babeldoc's hard-wired 2048), auto split-and-retry on `finish_reason=length`; a top-bar progress bar shows live stage progress like "Translate Paragraphs 76% (521/798)", and the driver retries with lower reasoning effort when the endpoint refuses to disable thinking
- 🈯 **Selection translation (formulas preserved)** (v1.6.0): select text, click "译" (Translate) for a translation-only bubble; when the selection overlaps a formula, the garbage text-layer glyphs are replaced with the LaTeX MinerU recognized and the model is asked to keep formulas verbatim
- 🖥️ **Bilingual side-by-side / split view** (v1.6.0): a doubled-width对照 page or a two-pane split with synchronised scrolling — switch any time, remembered per paper
- 🗂️ **Library management**: rename/delete topics and papers; deletion goes to a recoverable trash
- ➕ **Optional add-ons** (off by default): MinerU parsing — scanned PDFs become readable, formulas become **Click to cite a formula** and searchable; an embeddings endpoint — plain-language semantic search

Prerequisites and configuration details live in [docs/features_EN.md](docs/features_EN.md)（中文：[docs/features.md](docs/features.md)）.

## Install

### Everyday users: official desktop app (recommended)

**Two steps**: install the official DeepSeek desktop app → add the plugin inside it.

1. Install [the official DeepSeek desktop app](https://www.deepseek.com/download/) (the DeepSeek Harness desktop) and sign in
2. Sidebar → **Plugins** → **Add plugin**, enter `@ggboy123/dsh-paper-reader@latest`, open the plugin's detail page and flip the **Enable** switch, then **restart the app**

Done. Click "📚 Paper Reading" at the bottom of the sidebar, upload a PDF, and start reading.

![Install and use the paper-reading plugin on the official desktop app](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/desktop-official-use.gif)

> Verified on official desktop V0.2.0-rc.2 (bundled dsh 0.2.0-rc.2, macOS arm64); plugin requires ≥1.2.0.
> To browse a plugin marketplace inside the client, also install the community plugin [`dshmarket`](https://github.com/dsh-market/dsh-market); this plugin is listed there.

**Pitfalls (all hit in real testing)**:

- **After upgrading, the enable switch resets to off**: flip **Enable** again and restart. The symptom is misleading — the library tree is still there but clicking papers does nothing
- **Always add with `@latest`**: a bare add on an already-installed plugin is a no-op
- If pnpm's `minimumReleaseAge` policy blocks the new package: wait out the window, or exempt this package (`minimum-release-age-exclude[]` in `~/.dsh/profiles/web/.npmrc`; on desktop, `minimumReleaseAgeExclude` in `~/.dsh/profiles/desktop/pnpm-workspace.yaml`)

### Developers: CLI dsh

```bash
dsh plugin --profile web add @ggboy123/dsh-paper-reader@latest   # same command upgrades; a bare add is a no-op
```

> Do NOT install via `github:GGboya/dsh-paper-reader` — dist is not committed, so a git install leaves the profile unable to start.

## How to use

1. **Enter**: click "📚 Paper Reading" at the bottom of the sidebar (click again to restore)
2. **Add papers**: ＋ create a topic → ⬆ upload PDFs
3. **Read + ask**: just ask (answers cite pages), or select text for a pop-up question; click "page N" to jump back
4. **Chinese version**: the "中" button generates a translation (first use asks for an OpenAI-compatible endpoint once — DeepSeek/GLM/Kimi keys all work)
5. **Manage**: hover a row for ✎ rename / 🗑 delete; 🕐 in the chat header shows history, ＋ starts a new chat

## Library management (safety notes)

- Deletion = **moved to trash** `data/.trash/` (with a manifest; move files back to recover); it handles every artifact of the paper: `<paper>.pdf`, `.txt`, `.pages.json`, `.transcript.json`, `.mineru.md`, `.mineru.json`, `.embeddings.json`, `.study.json`, plus translation variants `<paper>-en.pdf` / `-zh.pdf` / `-dual.pdf` (including leftover `.tmp-*`); chat history is not deleted. Papers with a running session or an in-flight translation are refused up front; path traversal is rejected and mid-way failures roll back — details in [docs/features_EN.md](docs/features_EN.md)

## Contributing

```bash
git clone https://github.com/GGboya/dsh-paper-reader
cd dsh-paper-reader && pnpm install && pnpm run build
dsh plugin --profile web add ./dsh-paper-reader   # run from the parent dir, or use an absolute path
dsh --profile web                                  # sidebar becomes the library tree
```

After changes, `pnpm run build` and restart the profile; `npm test` runs the full suite (354 cases; CI on ubuntu/macos/windows). Architecture, test guards and dev conventions: see [AGENTS.md](AGENTS.md).

## Contributors

Thanks to everyone who has contributed:

<a href="https://github.com/GGboya/dsh-paper-reader/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=GGboya/dsh-paper-reader" alt="Contributor avatars" />
</a>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=GGboya/dsh-paper-reader&type=Date)](https://star-history.com/#GGboya/dsh-paper-reader&Date)

## License

MIT
