# dsh-paper-reader

[![npm version](https://img.shields.io/npm/v/@ggboy123/dsh-paper-reader)](https://www.npmjs.com/package/@ggboy123/dsh-paper-reader)
[![npm downloads](https://img.shields.io/npm/dm/@ggboy123/dsh-paper-reader)](https://www.npmjs.com/package/@ggboy123/dsh-paper-reader)
[![license](https://img.shields.io/github/license/GGboya/dsh-paper-reader)](https://github.com/GGboya/dsh-paper-reader/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/GGboya/dsh-paper-reader?style=social)](https://github.com/GGboya/dsh-paper-reader/stargazers)

**中文**: [README.md](README.md)

A [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) plugin that turns your agent workspace into a **paper reading workbench**: PDF transcription & search, native chat-based companion reading, and a built-in PDF reader — with answers that cite page numbers and **jump back to the exact highlighted passage in the PDF**.

> **👉 Just want a working app?** Skip this page and grab [**PaperReader**](https://github.com/GGboya/PaperReader) — a desktop app with this plugin preinstalled. Download the DMG, drag it into Applications, done. No environment setup. This repository is for people who want to install the plugin themselves or hack on the code.

The agent loop, model layer, and session persistence are all handled by the dsh framework; this plugin is a thin shell composing transcription + retrieval + reader UI.

**Does not modify the official UI on install** — a single "📚 Paper Reading" toggle appears at the bottom of the sidebar. Click it to enter reading mode (sidebar becomes a paper library tree), click again to restore the official workspace list:

![Demo: select-to-ask, answers cite page numbers, click a page to jump back to the highlighted passage](docs/demo.gif)

![Default: official sidebar untouched, just one extra toggle](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/screenshot-default.png)

![Reading mode: paper library + PDF reader + native chat](https://raw.githubusercontent.com/GGboya/dsh-paper-reader/main/docs/screenshot-reading.png)

## Features

- 📚 **Sidebar paper library**: when reading mode is on, the workspace sidebar shows Topics → Papers; create topics and upload PDFs (off by default — the official UI is never overwritten)
- 💬 **Native chat companion**: clicking a paper opens its own native dsh conversation (streaming / tool cards / usage bars are all official UI); the 🕐 dropdown in the chat header replays **conversation history** with real titles and dates; ＋ starts a new conversation
- 🔗 **Sessions bound to papers**: the session id encodes the paper's identity, so tool calls auto-locate the current paper — just ask questions in the input box without naming the paper; every answer cites page numbers
- 🤖 **Dedicated agent preset "Paper Tutor"**: paper sessions automatically use a tutor-style preset — like a teacher guiding your reading: builds a step-by-step reading plan (each step with page numbers and reflection questions) → guides section by section, comments on your answers → quizzes you and grades each answer → scores and weak points are recorded in a `<paper>.study.json` study profile that accumulates across sessions; quick Q&A (select-to-ask) gets a direct answer, no lecture
- 📖 **Centered PDF reader**: the paper sits in the middle (PDF.js zoom / Retina rendering / text-layer selection / fit-width mode), its native chat on the right — implemented via visual swapping, so column dragging/collapsing stays native dsh behavior; closing the PDF tab restores the official layout
- 💬 **Select-to-ask**: select text in the reader → a question box pops up → injects into the current session, answered live in the native chat
- 📍 **Citation jumping**: "Page N" in an answer is clickable — smooth-scrolls back to that PDF page and flashes the cited passage
- 🀄 **Chinese/English toggle**: the "中" button in the top bar switches original ↔ full Chinese; if no translation exists, one click generates it in the background (babeldoc) — **no Python preinstall required**: first use auto-downloads uv + managed Python + babeldoc (macOS / Linux / Windows, a few minutes), everything stays in the user directory
- 🔍 **PDF transcription + search**: local extraction (pdf.js, pure Node, no Python), header/footer stripping / ligature / hyphenation repair / paragraph reflow, with a page-offset table; compatible with pdfqa's `data/` cache layout
- 🧲 **Optional MinerU parsing backend**: for scanned PDFs / complex layouts / tables and formulas you can switch to MinerU (local API or mineru.net v4 cloud); output is the same page-indexed cache. Off by default — with no configuration the behavior is identical to previous versions (see "MinerU parsing backend" below)

## MinerU parsing backend (optional)

By default text is extracted locally with pdf.js (pure Node, no Python, milliseconds for text PDFs). Optionally you can
use **MinerU** as the parsing backend for scanned PDFs / complex layouts / tables and formulas — the output is still the
same page-indexed cache (`.txt` + `.pages.json`), and search / page jumping / old caches behave exactly as before.

Pick a mode in **Settings → Paper Reader → "MinerU parser"** (or set it in the config file):

| Mode | Meaning |
| --- | --- |
| `off` (default) | Disabled; behavior is identical to previous versions |
| `local` | Local MinerU API (default `http://127.0.0.1:8000`) |
| `cloud` | mineru.net v4 cloud; requires a token |

**Local MinerU** (the official API server; this repo was tested against 3.4.5):

```bash
pip install -U "mineru[core]"
mineru-api --host 127.0.0.1 --port 8000        # or: uvicorn mineru.cli.fast_api:app
curl -s http://127.0.0.1:8000/health           # {"status":"healthy","version":"3.4.5",...}
```

The default backend is `pipeline` (general purpose, no VLM model needed); with a GPU you can switch to `hybrid-engine`
(needs the VLM model ready — a 2-page synthetic PDF took ~5s here). For scanned PDFs keep the parse method on `auto`
and let MinerU decide on OCR.

**Cloud MinerU**: sign up at [mineru.net](https://mineru.net) → create a token under API management → paste it into the
card's "Cloud token" field. One parse runs: request batch upload URLs → PUT upload → poll results → download and parse
the zip. ⚠️ **The cloud path is not live-tested in this repo** (the dev machine has no token); it is covered only by
mock-HTTP unit tests — treat it as experimental. The token is stored only in
`~/.dsh/.dsh-paper-reader/mineru.json` (0600); read endpoints return a masked hint only, and no log / error / response
ever contains the plaintext key.

**Config file / environment variables** (per-field priority: file > profile YAML `config.mineru` > env > defaults):

```yaml
- id: dsh-paper-reader
  config:
    mineru:
      mode: local
      local:
        baseUrl: http://127.0.0.1:8000
        backend: pipeline
        parseMethod: auto
      # cloud:
      #   apiKey: ''          # usually unnecessary — fill it in the UI
```

| Environment variable | Field |
| --- | --- |
| `DSH_MINERU_LOCAL_URL` | `local.baseUrl` |
| `MINERU_API_KEY` | `cloud.apiKey` |

**Cache and provenance**: MinerU still writes `.txt` + `.pages.json` (`page` starts at 1, used to map search hits back to
pages), plus `.transcript.json` (origin marker: `pdfjs` / `mineru-local` / `mineru-cloud`) and the MinerU rich artifacts
`.mineru.md` / `.mineru.json` (Markdown + content_list for manual inspection). An old cache without an origin marker is
treated as pdfjs, and **upgrading never triggers a re-parse**; to switch origins, ask explicitly for one paper
(agent-side: the `source` parameter of `transcribe_pdf`; HTTP-side: `source` in `POST /api/transcribe`, values
`auto|pdfjs|mineru-local|mineru-cloud`). When MinerU fails, the existing cache is left **untouched** and the error carries
the HTTP status plus a sanitized server message.

**Searchable formulas (since v1.3.4)**: MinerU emits LaTeX with a space between *every* token (`x _ { t - 1 }`), so
previously `search_paper` only matched when that spaced form was copied verbatim. Projecting into `.txt` now strips the
whitespace inside math regions (`$...$` / `$$...$$`) and then normalizes the braces of *single-token* sub/superscripts
(`Q_{t}` → `Q_t`, `^{2}` → `^2`). Normal-looking queries such as `x_{t-1}`, `\mathbb{R}`, `Q_t` and `q(x_t|x_{t-1})`
therefore match directly (measured on a real paper: 0 hits before → hits on the matching page after). Commands whose
spaces are semantic (`\text{...}`) are kept verbatim as a whole group; multi-token arguments (`x_{t-1}`, `x_{ij}`,
`^{K \times K}`) keep their braces; `.mineru.md` / `.mineru.json` remain exactly as MinerU produced them.

> **Upgrade note**: existing `.txt` caches on disk are **not rewritten** (they stay in the old format, so formula
> queries still miss). To make a given paper's formulas searchable, re-transcribe that paper explicitly: pass
> `source: mineru-local` (or `force: true`) to `transcribe_pdf`, or the same `source` to `POST /api/transcribe`.
>
> **Notation convention**: the `.txt` stores the **compact form** (`Q_t`). On the query side the *same rule* is
> applied first and matched **alongside your original query**, so both `Q_t` and `Q_{t}` hit the same page (the
> original query is always kept, so no existing hit is ever lost); multi-token forms such as `x_{t-1}` / `x_{ij}`
> are not normalized and match as written.
>
> **Two low-severity items (scheduled for the next round, registered in [docs/embed-plan.md](docs/embed-plan.md) "追加项二")**:
> F-R1 `keepsInnerSpaces` prefix-matches the two-argument `\textcolor` into the "spaces are semantic" guard (the second
> group of `$\textcolor{red}{hello world}$` gets its spaces compressed); F-R2 the region scanner does not look inside
> `\text{}` groups (`$\text{costs $5}$` is split at the inner `$` — a sub-case of the documented boundary).

**API** (used by the settings panel, behind the usual `/paper-reader` prefix and auth): `GET|POST|DELETE /api/mineru/config`
(GET returns masked values only; POST persists only after a successful pre-check; DELETE falls back to profile/env),
plus `POST /api/mineru/test` and `GET /api/mineru/health` for connectivity checks (they never persist anything).

**Common errors**:

| Symptom | Cause / fix |
| --- | --- |
| Save fails with "local MinerU connection test failed: HTTP 404 …" | The URL points at another service, or MinerU is too old (2.x has no `/health`); check with `curl {baseUrl}/health` |
| "not a recognized MinerU API server" | `/health` lacks `status`/`version` — not MinerU |
| Parse fails with "local MinerU parse failed (HTTP 409)" | The server-side task failed; read the `error` field. On MinerU 3.4.5 a 409 means **parse failure**, not "server busy" |
| "result is empty / no content" | The server produced no md/content_list (models not ready, etc.); validate the service itself with `curl -F files=@x.pdf http://127.0.0.1:8000/file_parse` |
| Parse times out | A single paper is capped at 30 minutes by default (`jobTimeoutMs`); raise it in the config file |
| Cloud says the token is invalid | The token expired, or you pasted the `Bearer ` prefix too (enter the token body only) |

> **Known limitations**: the cloud path (mineru.net v4) follows the official API but is covered by mock tests only —
> it has never been exercised with a real token, so treat it as experimental. The local path is verified end-to-end
> against MinerU 3.4.5. A few low-severity items remain (non-transactional multi-file writes and a non-increasing
> poll interval on the cloud path, leftover dead code in the ZIP reader). None of them affect the default path:
> `mode` defaults to `off`, and behaviour is identical to before when MinerU is not configured.


## Embedding search (optional, off by default)

Besides keyword substring matching, `search_paper` can use an **OpenAI-compatible `/embeddings` endpoint** for
semantic recall: passages that are semantically close but share **no keyword** with the query still enter the
candidate set (fused with keyword hits, never replacing them). This helps a lot with paraphrased questions,
cross-language phrasings, or "the passage with the diffusion formula" style queries.

**How to configure** (same precedence as the translate/rerank endpoints: settings panel > profile YAML > env var):

| Way | How |
| --- | --- |
| Settings panel (recommended) | Settings → Paper Reader → **"Embedding search (optional)"** card; fill endpoint URL / model / API key. A real `/embeddings` call is made as a pre-check before saving |
| profile YAML | `config.embed: { baseUrl, apiKey, model }` |
| Env var | `DSH_EMBED_API_KEY` (key only; baseUrl/model still need to be configured) |

Stored at `$DSH_HOME/.dsh-paper-reader/embed.json` (**0600**, same convention as `translate.json`/`typesafe.json`);
the read API returns only `hasApiKey` plus a masked `apiKeyHint` — never the plaintext key.

> ⚠️ **Privacy notice**: once enabled, **two kinds of text are sent to the endpoint you configure** — ① the paper's
> **chunk texts** (to compute chunk vectors; a mock capture confirms the bodies themselves are what gets sent), and
> ② **the query text of every search** (it is embedded first to get a query vector). Only point it at a service you
> trust; **with nothing configured, not a single request is made**. Neither the cache file nor any error message
> contains the API key (query vectors live only in an in-process memo and are never written to disk).

**Behaviour and degradation**: unconfigured (or partially configured) = **off by default** — `search_paper` behaves
**exactly as before** (pure keyword ranking, zero extra requests). When configured: keyword candidates ∪ embedding
candidates → RRF fusion → existing Jev/TypeSafe rerank if configured → top-k.
**Fusion behaviour, stated plainly**: keyword and semantic candidates are fused by **rank** (RRF, k=60) — ranks only, **score magnitude is ignored** — so the two lists **alternate occupying the final top-k slots** (a top-ranked semantic hit can land ahead of a second-ranked keyword hit); "keyword wins" applies only to **exact ties**. Embedding is a **recall** step, not a replacement (keyword search always runs and keeps contributing candidates), but semantic candidates really can take some of the top-k slots — that is intentional (no real embedding endpoint is available to tune against, so score-interpolation or reserved-slot strategies are deliberately not introduced). **With no endpoint configured nothing changes at all**: no requests are made and ranking is byte-identical to before. If the endpoint
is unreachable / times out / errors / returns invalid dimensions or non-numeric values, the keyword results are still
returned and the degradation reason is stated verbatim at the end of the result
(`（嵌入检索不可用，已降级为纯关键词：…）`) — never a silent failure, never a broken search.

**Cache and invalidation**: `<topic>/<paper>.embeddings.json`, keyed by `{baseUrl, model, dimensions, content hash}`.
**Changed endpoint (baseUrl) / changed model / changed `.txt` (re-transcribed) / changed chunk size / returned
dimensions that disagree with the cache** → the cache is invalidated and recomputed; **on a cache hit no chunk-embedding request is made** (query vectors
have an in-process memo, so repeating the same query makes zero requests). Chunks are submitted in batches
(`batchSize`, default 32); **if any batch fails the whole recall degrades and nothing is written** — no half-written cache.

Lazy by design: embeddings are computed **on the first search of that paper**; transcription (`transcribe_pdf`) never
touches embeddings, so transcription speed and failure surface are unaffected.

> **Non-goals (future work)**: local ONNX / transformers.js embedding models, precomputing the whole library,
> vector databases — this round is API endpoints only.

## Install

### Option 1: PaperReader desktop app (one-click, recommended)

[PaperReader](https://github.com/GGboya/PaperReader) is a desktop app with this plugin **preinstalled** (packaged on top of the community desktop client [DSH Desktop](https://github.com/anywhere-labs/dsh-desktop)):

1. Download the DMG from [Releases](https://github.com/GGboya/PaperReader/releases/latest) (macOS Universal — Intel and Apple Silicon; Windows build coming)
2. Open the DMG, drag PaperReader into Applications
3. On first launch use right-click → Open (unsigned release — it only asks once); the first launch also runs a one-time initialization of a few minutes

You get the library + reader + companion chat out of the box — no commands needed.

### Option 2: Install the plugin into an existing desktop client

**DeepSeek official desktop** (download from [deepseek.com/download](https://www.deepseek.com/download/) — the DeepSeek Harness desktop app):

1. Install, launch, and sign in
2. Sidebar → **Plugins** → **Add plugin**, enter `@ggboy123/dsh-paper-reader@1.4.0`
3. Newly installed plugins start **disabled**: open the plugin's detail and flip the **Enable** switch
4. **Restart the desktop app** (with the plugin enabled live, opening papers silently fails until a restart brings it into the boot composition — tested)

> Verified on official desktop V0.2.0-rc.2 (bundled dsh 0.2.0-rc.2, macOS arm64): library tree, new topic, PDF upload, PDF reader, native companion chat, history/new-chat buttons all work.
> Requires >= 1.2.0 — older versions are denied by the 0.2.x runtime's peer-compatibility check (shown as an error in the plugin list).

**Community DSH Desktop** ([anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop), the community DeepSeek Harness desktop client for macOS / Windows, no Node.js required):

1. Launch DSH Desktop
2. Tray menu → **Open DSH Terminal** (that terminal comes with `dsh`/`pnpm`)
3. Run `dsh plugin add @ggboy123/dsh-paper-reader@1.4.0`
4. Quit and reopen DSH Desktop (plugin changes need a restart to enter the Loader composition)

### Option 3: CLI dsh (developers)

```bash
dsh plugin --profile web add @ggboy123/dsh-paper-reader
```

> The package lives under the `@ggboy123` scope: the bare name `dsh-paper-reader` is taken by a different plugin (a one-shot "feed a paper, get a report" analyzer — different positioning from this plugin's "reader + conversational companion").
> Do NOT install via `github:GGboya/dsh-paper-reader` — dist is not committed to git, so a git install leaves the profile unable to start (build artifacts ship only with the npm package).

### Upgrading

**Existing users must pass an explicit version** — a bare `add` is a no-op for an already-installed dependency (pnpm resolves from the range recorded at first install and won't chase newer releases):

```bash
dsh plugin --profile web add @ggboy123/dsh-paper-reader@1.4.0
# Restart dsh web; hard-refresh the browser (Cmd+Shift+R) to avoid cached reader pages
```

Check which version you currently have:

```bash
grep '"version"' ~/.dsh/profiles/web/node_modules/@ggboy123/dsh-paper-reader/package.json
```

> If pnpm has the supply-chain policy `minimumReleaseAge` enabled (rejects packages published within N hours): either wait out the window, or add `minimum-release-age-exclude[]=@ggboy123/dsh-paper-reader` to `~/.dsh/profiles/web/.npmrc` (exempts only this plugin).

Local development:

```bash
git clone https://github.com/GGboya/dsh-paper-reader
cd dsh-paper-reader && pnpm install && pnpm run build
dsh plugin --profile web add ./dsh-paper-reader   # run from the parent dir, or use an absolute path
dsh --profile web
```

The library directory defaults to `~/.dsh-paper-reader/data`; override it in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-paper-reader
  config:
    dataDir: /path/to/pdfqa/data   # point at a pdfqa library to reuse all caches
    # translate:                    # optional: OpenAI-compatible endpoint for Chinese
    #   baseUrl: https://api.deepseek.com/v1   # translation via babeldoc. Usually you
    #   apiKey: sk-...                          # don't need it here — click "中" or ⚙
    #   model: deepseek-chat                    # in the reader to fill it in; saved to
    #                                           # ~/.dsh/.dsh-paper-reader/translate.json
    #                                           # (mode 0600).
```

> Translation endpoint: **prefer filling it in the reader UI** (click "中" — a form pops up if unset — or ⚙). The connection is tested before saving; takes effect without a restart.
> The `translate` config above falls back to a **deployer-side default**, effective only when the UI is unset. babeldoc only speaks the OpenAI protocol — Anthropic-protocol endpoints (e.g. `api.kimi.com/coding/`) can't be used directly.

> Translation engine **zero preinstall**: when babeldoc is missing, it auto-installs via the uv chain — standalone uv binary (GitHub Releases API download + sha256 verification) → uv-managed Python 3.12 → `uv pip install babeldoc`, landing in `~/.dsh/.dsh-paper-reader/bin/` and a sibling `.venv-pdf2zh/`, never touching system Python. Existing uv / babeldoc installs (including pdfqa's `.venv-pdf2zh`) are reused. Windows auto-install is not supported yet — install uv manually and retry.

> Reading mode is **opt-in**: by default `sidebar.workspaces` is not registered (official workspace/session list untouched); the "📚 Paper Reading" toggle at the bottom of the sidebar takes over only when clicked, and restores on second click; the mode choice is remembered in localStorage. Open PDF tabs and companion sessions are unaffected when leaving the mode.

## Architecture

```
src/
  index.ts      Cordis shell: injects tools; mounts routes once webServer etc. are ready
  tools.ts      5 agent tools: list_papers / transcribe_pdf / search_paper / study_progress / study_update
  host.ts       webServer routes (/paper-reader/*), connection.requestRejection auth;
                sessionController.create/prompt (agentPreset=paper-reader) + follow SSE bridge
  library.ts    pure functions: library directory conventions & parsing (.txt/.pages.json/.transcript.json/.mineru.*)
  transcribe.ts pure functions: pdf.js extraction + page-offset table + MinerU backend selection & cache provenance
  mineru.ts     pure functions: MinerU client (local legacy /tasks polling + /file_parse; mineru.net v4 cloud + minimal ZIP reader)
  mineru-config.ts pure functions: MinerU config I/O (0600) + masking + connectivity pre-check
  search.ts     pure functions: chunking + keyword scoring (fast search) + page mapping
  study.ts      pure functions: study profile (plan + quiz scores) I/O
  translate.ts  pure functions: babeldoc invocation (Chinese / bilingual PDF generation)
  babeldoc-install.ts  pure functions: auto-install babeldoc without a Python env (uv → managed Python → venv)
  translate-config.ts  pure functions: translation endpoint config I/O (0600) + pre-save connection check
  preset.ts     pure functions: installs the bundled agent preset into $DSH_HOME/.agent-presets/
presets/paper-reader/  the "Paper Tutor" agent preset (full persona prompt + compaction)
reader/index.html      the reader page (pdf.js, independent of the React host, iframe-carried)
lib/client.js          browser half: library tree (sidebar.workspaces takeover) + PDF tab + main panel
```

## License

MIT
