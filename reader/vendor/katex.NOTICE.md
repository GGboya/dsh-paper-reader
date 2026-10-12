# KaTeX（vendored，离线；**扁平放置**）

> **为什么这些文件是扁平的（不放在 `vendor/katex/` 子目录）**：阅读器的静态资源路由
> `/paper-reader/vendor/*` 只服务**扁平文件名**（`^[\w.-]+$`，不含 `/`，且只放行
> `.mjs/.js/.css/.map/.woff2/.woff/.ttf` 这些后缀）。子目录形态会让 `katex.min.js` 直接 400
> `bad asset name`、CSS 里的相对 `url(fonts/…woff2)` 也取不到 ⇒ `window.katex` 不存在 ⇒
> **每个数学段都降级**（这正是 PR #7「公式经常未渲染」的主因，见 docs/pr7-render-diagnosis.md 的 P0）。
> 拉平是最安全的修法：不动路由的路径校验逻辑、不新增 `..`/编码变形的穿越面，
> 且 `test/reader-vendor-http.test.mjs` 会真发 HTTP 把页面/CSS 引到的每个资源逐个取 200。

- **版本**：0.16.22
- **来源**：npm 包 `katex@0.16.22`（`https://registry.npmjs.org/katex/-/katex-0.16.22.tgz`，
  sha256 `e9e0d167db3175481cbadaff38e8d90b130f6a3ddb451a47e43c577fd511f365`）；
  上游仓库 `https://github.com/KaTeX/KaTeX`（`https://katex.org`）。
- **许可证**：MIT（全文见同目录 `LICENSE`，Copyright (c) 2013-2020 Khan Academy and other contributors）。
- **扁平文件**（都在 `reader/vendor/`）：`katex.min.js`（276,701 B）、`katex.min.css`（23,352 B）、
  `KaTeX_*.woff2`（20 个，259,792 B）、`katex.LICENSE`、`katex.NOTICE.md`。CSS 内部的字体 URL 已从 `fonts/X.woff2` 改写为同目录 `X.woff2`。
  **刻意省略** woff/ttf 两种字体格式：CSS 的 `@font-face` 以 `.woff2` 为首选源，
  当前目标运行环境（Electron/Chromium、现代 Safari/Firefox）均支持 woff2；省略可把体积从 ~1.05 MB 降到 ~254 KB。
- **为什么这不算「新增依赖」**（可直接写进 PR）：
  「KaTeX 是**随包分发的静态资源**，不是依赖树里的包 —— 它没有进入 `package.json` / lockfile，不参与
  安装或解析；`pnpm install` 的依赖集合、`node_modules` 内容与构建产物都不变。选 vendored 而非 `npm i katex`
  的原因：论文伴读是**离线场景**，读者页面不允许任何运行时 CDN 请求；把渲染器与字体随插件一起分发，
  才能保证断网可用、且版本与字体一一对应（不会出现「CSS 更新了但字体没跟上」的半坏渲染）。」
- **更新方式**：`npm pack katex@<version>` → 覆盖 `reader/vendor/` 下的 `katex.min.js` / `katex.min.css` / `KaTeX_*.woff2` / `katex.LICENSE`，
  并同步上面的版本号、URL 与 sha256。
