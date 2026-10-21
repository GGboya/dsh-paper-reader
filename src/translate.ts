// translate.ts — 中文对照 PDF 生成（纯函数，不依赖 Cordis）。
// 移植 pdfqa 的 runPdf2zh：shell 调 babeldoc（pdf2zh 2.x），版式/图/公式原地保留，
// 产出 <文献>-zh.pdf（纯中文）与 <文献>-dual.pdf（中英对照）。
// babeldoc 只支持 OpenAI 兼容端点 → 端点/key/模型由插件配置提供。
//
// 注：本文件里 TranslatePaperRef / TranslateEndpoint 是「结构最小要求」，只声明本模块真正
// 用到的字段；仓库里若已有 library.ts 的 PaperRef 与 translate-config.ts 的端点类型，
// 直接把这两行 import 换成本地类型即可（形状是兼容子集）。
import { execFile, spawn } from 'node:child_process';
import { existsSync, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { mkdir, rename, rm, readdir } from 'node:fs/promises';
import { join, dirname, basename, extname, isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { dshHome } from "./library.js";
import { ensureBabeldoc } from "./babeldoc-install.js";

/** 文献引用（paperRefFor 的返回形状；本模块只用到 pdfPath / name / topic）。 */
export interface TranslatePaperRef {
    topic?: string;
    name?: string;
    pdfPath: string;
}

/** OpenAI 兼容翻译端点（baseUrl + key + 模型名）。 */
export interface TranslateEndpoint {
    baseUrl: string;
    apiKey: string;
    model: string;
}

/** 一条翻译进度（驱动脚本事件折算后的前端可画形态）。 */
export interface TranslateProgress {
    stage: string | null;
    label: string;
    stagePercent: number | null;
    stageCurrent: number | null;
    stageTotal: number | null;
    part: number | null;
    totalParts: number | null;
    overall: number | null;
    text: string;
    updatedAt: number;
}

/** 一篇文献的译文状态（GET /api/zh 直接展开这个对象）。 */
export interface ZhStatus {
    zh: boolean;
    dual: boolean;
    busy: boolean;
    error?: string;
    phase?: string;
    progress?: TranslateProgress;
}

/** startTranslation / restartTranslation 的返回（started=false 时带 reason/code）。 */
export interface StartResult {
    started: boolean;
    reason?: string;
    code?: string;
    firstRun?: boolean;
}

/** babeldoc 的阶段权重（驱动脚本 stage_summary 事件带下来的）。 */
interface StageWeight {
    name: string;
    weight: number;
}

/** 进程内任务态：null=进行中（无阶段说明）；{phase,progress}=进行中；{error}=已失败。 */
interface BusyState {
    phase?: string;
    progress?: TranslateProgress;
    error?: string;
}

/** 驱动脚本写到 stdout 的 @@DPR@@ 事件（字段一律 unknown，用时再判类型）。 */
interface DriverEvent {
    kind?: unknown;
    type?: unknown;
    stage?: unknown;
    stageCurrent?: unknown;
    stageTotal?: unknown;
    stagePercent?: unknown;
    overall?: unknown;
    part?: unknown;
    totalParts?: unknown;
    stages?: unknown;
    message?: unknown;
}

export function zhPdfPath(ref: TranslatePaperRef): string {
    return ref.pdfPath.slice(0, -extname(ref.pdfPath).length) + '-zh.pdf';
}

export function dualPdfPath(ref: TranslatePaperRef): string {
    return ref.pdfPath.slice(0, -extname(ref.pdfPath).length) + '-dual.pdf';
}

/** 进程内每篇文献一个翻译任务（幂等：进行中/已生成直接返回）。 */
// key=pdfPath；null=进行中（无阶段说明）；{phase,progress}=进行中；{error}=已失败
const busy = new Map<string, BusyState | null>();

/** 整篇翻译的硬超时（babeldoc 自己不死，靠这里收尸）。 */
const TRANSLATE_TIMEOUT_MS = 45 * 60 * 1000;

/** 失败时保留的日志尾巴长度。 */
const MAX_TAIL_CHARS = 1200;

export function zhStatus(ref: TranslatePaperRef): ZhStatus {
    const zh = existsSync(zhPdfPath(ref));
    const dual = existsSync(dualPdfPath(ref));
    const b = busy.get(ref.pdfPath);
    return {
        zh,
        dual,
        busy: b === null || Boolean(b && !b.error),
        ...(b?.error ? { error: b.error } : {}),
        ...(b && !b.error && b.phase ? { phase: b.phase } : {}),
        ...(b && !b.error && b.progress ? { progress: b.progress } : {}),
    };
}

/** 找 babeldoc 可执行文件：pdfqa venv（文献库同级 .venv-pdf2zh）→ PATH → miniconda（仅 macOS）。 */
async function findBabeldoc(dataDir: string): Promise<string | null> {
    const isWin = process.platform === 'win32';
    const candidates = [
        // 与 babeldoc-install.ts installBabeldoc 的安装位严格一致（win32 venv 用 Scripts/）
        isWin
            ? join(dirname(dataDir), '.venv-pdf2zh', 'Scripts', 'babeldoc.exe')
            : join(dirname(dataDir), '.venv-pdf2zh', 'bin', 'babeldoc'),
        'babeldoc',
        ...(process.platform === 'darwin' ? ['/opt/homebrew/Caskroom/miniconda/base/bin/babeldoc'] : []),
    ];
    for (const c of candidates) {
        if (isAbsolute(c)) {
            if (existsSync(c))
                return c;
            continue;
        }
        // PATH 查找（win32 用 where）
        const found = await new Promise<boolean>((res) => {
            execFile(isWin ? 'where' : 'which', [c], (err, stdout) => res(!err && stdout.trim() !== ''));
        });
        if (found)
            return c;
    }
    return null;
}

/**
 * 探测 babeldoc 支持的 CLI 参数（按 bin 缓存，进程内只跑一次 --help）。
 * 必要性：--skip-figure-text 目前只在 GGboya 的 fork（PR#616）里，PyPI 版没有；
 * 不认识的参数会让 babeldoc 启动即报错，所以可选参数必须探测后再传。
 * 探测失败返回空集合——只丢可选功能，不影响核心参数。
 */
const flagSupport = new Map<string, Promise<Set<string>>>();

function babeldocFlags(bin: string): Promise<Set<string>> {
    let p = flagSupport.get(bin);
    if (!p) {
        p = new Promise<Set<string>>((res) => {
            try {
                execFile(bin, ['--help'], { timeout: 60000 }, (err, stdout, stderr) => {
                    if (err)
                        console.warn('[dsh-paper-reader] babeldoc --help 探测失败，按最老参数集运行:', err.code ?? err.message);
                    const flags = new Set<string>();
                    for (const m of ((stdout ?? '') + '\n' + (stderr ?? '')).matchAll(/--[a-z0-9-]+/g)) {
                        flags.add(m[0].slice(2));
                    }
                    res(flags);
                });
            }
            catch (e) {
                // 某些受限环境（沙箱里跑 node）连探测进程都起不来：只丢可选参数，别拖垮整次翻译
                console.warn('[dsh-paper-reader] babeldoc --help 无法执行，按最老参数集运行:', e instanceof Error ? e.message : String(e));
                res(new Set<string>());
            }
        });
        flagSupport.set(bin, p);
    }
    return p;
}

/**
 * 启动 babeldoc 后台翻译。幂等：已生成或进行中直接返回 false 表示未新启动。
 * 完成/失败结果写进 busy map，由 zhStatus 暴露。
 * babeldoc 缺失时不再报错：后台自动走 uv 安装链路（首次约几分钟），
 * 期间 zhStatus.phase 展示安装进度，装完直接接着翻译。
 */
export async function startTranslation(ref: TranslatePaperRef, dataDir: string, endpoint: TranslateEndpoint): Promise<StartResult> {
    const st = zhStatus(ref);
    if (st.zh || st.dual)
        return { started: false, reason: 'already-exists' };
    if (st.busy)
        return { started: false, reason: 'busy' };
    const pre = precheck(endpoint);
    if (pre)
        return pre;
    const firstRun = !(await findBabeldoc(dataDir));
    void runPipeline(ref, dataDir, endpoint);
    return { started: true, firstRun };
}

/** 端点预检：不齐全时返回与 startTranslation 同形的失败结果。 */
function precheck(endpoint: TranslateEndpoint): StartResult | null {
    if (!endpoint.baseUrl || !endpoint.apiKey || !endpoint.model) {
        // code 供前端判定「该弹配置表单了」，别让它去匹配中文文案
        return {
            started: false,
            code: 'no-endpoint',
            reason: '未配置翻译端点：在阅读器里点「中」按钮填写（OpenAI 兼容端点即可），或改 profile 的 translate 配置',
        };
    }
    return null;
}

/** 后台流水线：确保 babeldoc 可用（缺失则自动安装）→ 拉起翻译。 */
async function runPipeline(ref: TranslatePaperRef, dataDir: string, endpoint: TranslateEndpoint): Promise<void> {
    const setPhase = (phase: string) => busy.set(ref.pdfPath, { phase });
    try {
        setPhase('正在检查翻译引擎…');
        // DPR_SKIP_ENGINE_ENSURE=1：跳过「自检 + 缺失则自动安装」，只用现成的 babeldoc
        // （受限环境里起不了探测子进程时手工兜底用，正常路径永远走 ensureBabeldoc）
        const bin = process.env.DPR_SKIP_ENGINE_ENSURE === '1'
            ? await findBabeldoc(dataDir)
            : await ensureBabeldoc(dataDir, dshHome(), () => findBabeldoc(dataDir), setPhase);
        if (!bin)
            throw new Error('找不到 babeldoc 可执行文件');
        await launch(ref, dataDir, endpoint, bin);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[dsh-paper-reader] babeldoc 自动安装失败:', msg);
        busy.set(ref.pdfPath, { error: `翻译引擎安装失败：${msg}` });
    }
}

/**
 * 重新翻译：删除已有译文产物后再启动（换模型/翻得不好时用）。
 * 先预检再删——端点不齐时不动旧译文，免得删完才发现跑不起来。
 * babeldoc 的段落缓存 key 含模型名，换模型自然失效，无需 --ignore-cache。
 */
export async function restartTranslation(ref: TranslatePaperRef, dataDir: string, endpoint: TranslateEndpoint): Promise<StartResult> {
    if (zhStatus(ref).busy)
        return { started: false, reason: 'busy' };
    const pre = precheck(endpoint);
    if (pre)
        return pre;
    await rm(zhPdfPath(ref), { force: true });
    await rm(dualPdfPath(ref), { force: true });
    const firstRun = !(await findBabeldoc(dataDir));
    void runPipeline(ref, dataDir, endpoint);
    return { started: true, firstRun };
}

/** 驱动脚本：包装 babeldoc（加结构化进度事件 + 解除单次请求的输出长度限制）。 */
const DRIVER_PATH = fileURLToPath(new URL('../runtime/babeldoc-driver.py', import.meta.url));

/** babeldoc 的阶段名 → 中文（进度条上给人看）。 */
const STAGE_LABELS: Record<string, string> = {
    'Parse PDF and Create Intermediate Representation': '解析 PDF',
    DetectScannedFile: '检测扫描件',
    'Parse Page Layout': '分析版面',
    'Parse Table': '解析表格',
    'Parse Paragraphs': '解析段落',
    'Parse Formulas and Styles': '解析公式',
    AutomaticTermExtractor: '抽取术语',
    'Automatic Term Extraction': '抽取术语',
    'Translate Paragraphs': '翻译段落',
    Typesetting: '排版',
    'Add Fonts': '嵌入字体',
    'Generate drawing instructions': '生成绘图指令',
    'Subset font': '字体子集化',
    'Save PDF': '保存 PDF',
};

function stageLabel(stage: string | null): string {
    return (stage && STAGE_LABELS[stage]) || stage || '翻译';
}

/** 0..1 或 0..100 都归一成百分比。 */
function toPercent(v: unknown): number | null {
    if (typeof v !== 'number' || !Number.isFinite(v))
        return null;
    return Math.max(0, Math.min(100, v <= 1 ? v * 100 : v));
}

/**
 * 把驱动脚本的一条 progress 事件变成前端能直接画的进度对象。
 * babeldoc 的 overall_progress 只在 update 事件里有，start 阶段用阶段权重自己算。
 */
function buildProgress(event: DriverEvent, stages: StageWeight[]): TranslateProgress {
    const stage = typeof event.stage === 'string' && event.stage ? event.stage : null;
    const stagePercent = toPercent(event.stagePercent);
    let overall = toPercent(event.overall);
    if (overall === null && stage && stagePercent !== null && stages.length) {
        const weightOf = (s: Partial<StageWeight>): number => (typeof s.weight === 'number' && s.weight > 0 ? s.weight : 0);
        const totalWeight = stages.reduce((a, s) => a + weightOf(s), 0) || 1;
        const doneWeight = stages
            .filter((s) => s.name !== stage)
            .reduce((a, s) => a + weightOf(s), 0);
        const mine = stages.find((s) => s.name === stage);
        overall = ((doneWeight + weightOf(mine ?? {}) * (stagePercent / 100)) / totalWeight) * 100;
    }
    const stageCurrent = typeof event.stageCurrent === 'number' ? event.stageCurrent : null;
    const stageTotal = typeof event.stageTotal === 'number' ? event.stageTotal : null;
    const label = stageLabel(stage);
    const fraction = stageTotal && stageCurrent !== null && stageTotal > 1
        ? `（${Math.min(stageCurrent, stageTotal)}/${stageTotal}）`
        : '';
    const percentText = overall === null ? '' : ` · ${Math.round(overall)}%`;
    return {
        stage,
        label,
        stagePercent,
        stageCurrent,
        stageTotal,
        part: typeof event.part === 'number' ? event.part : null,
        totalParts: typeof event.totalParts === 'number' ? event.totalParts : null,
        overall,
        text: `${label}${fraction}${percentText}`,
        updatedAt: Date.now(),
    };
}

/** 找与 babeldoc 同 venv 的 python（驱动脚本要 import babeldoc）。 */
function resolveDriverPython(bin: string | null): string | null {
    if (!bin || !isAbsolute(bin))
        return null;
    const candidates = process.platform === 'win32'
        ? [join(dirname(bin), 'python.exe')]
        : [join(dirname(bin), 'python'), join(dirname(bin), 'python3')];
    return candidates.find((c) => existsSync(c)) ?? null;
}

/** 真正拉起 babeldoc 子进程（bin 已就绪、产物不存在/已删）。 */
async function launch(ref: TranslatePaperRef, dataDir: string, endpoint: TranslateEndpoint, bin: string): Promise<void> {
    const tmpDir = join(dataDir, '.pdf2zh-tmp');
    await mkdir(tmpDir, { recursive: true });
    busy.set(ref.pdfPath, null); // 清掉安装阶段说明，回到「翻译进行中」
    const stem = basename(ref.pdfPath, extname(ref.pdfPath));
    const dstStem = ref.pdfPath.slice(0, -extname(ref.pdfPath).length);
    // 推理型模型（glm-5.x / k3 / deepseek-flash）默认每段都先跑隐藏推理，翻译慢好几倍还偶尔返回空。
    // 这三家的 OpenAI 兼容端点都接受 DeepSeek 风格 thinking 开关（babeldoc --openai-thinking 即发该字段）；
    // 自定义端点不加——OpenAI 官方等严格校验参数的端点会因未知字段 400。
    // 可选参数统一过一遍探测：babeldoc 对不认识的参数直接报错退出，探测不到就不传（功能降级但不炸）。
    const supported = await babeldocFlags(bin);
    const opt = (flag: string): string[] => (supported.has(flag) ? [`--${flag}`] : []);
    // 探测失败（支持集为空，比如受限环境里起不了子进程）时按现代版 babeldoc 猜：这两个参数
    // 0.6.x 都有，没有的话 babeldoc 会立刻报 unrecognized arguments，比默默用错的临时目录好排查。
    const assumeModern = supported.size === 0;
    const hasFlag = (flag: string): boolean => assumeModern || supported.has(flag);
    const noThink = /bigmodel|kimi|moonshot|deepseek/i.test(endpoint.baseUrl) && hasFlag('openai-thinking')
        ? ['--openai-thinking', 'disabled']
        : [];
    // 工作目录必须自己指定：babeldoc 默认在 cwd 下建 my_temp 并反复重建 PDF，
    // cwd 只读（装上后从任意目录启动、或沙箱里）就会 code=2 Permission denied。
    const workParent = hasFlag('working-dir') ? join(tmpDir, 'work') : null;
    if (workParent)
        await mkdir(workParent, { recursive: true });
    const babelArgs = [
        '--files', ref.pdfPath,
        '--lang-in', 'en', '--lang-out', 'zh-CN',
        '--openai', '--openai-model', endpoint.model,
        '--openai-base-url', endpoint.baseUrl, '--openai-api-key', endpoint.apiKey,
        ...noThink,
        '--qps', '16', '--no-watermark', '--output', tmpDir,
        ...(workParent ? ['--working-dir', workParent] : []),
        // 图/图片区域内的文字保持原文（架构图术语不翻）——目前仅 fork(PR#616)支持
        ...opt('skip-figure-text'),
        // 跳过术语表自动抽取：该阶段要额外跑十几轮 LLM（推理型模型上能拖十几分钟，比正文还慢），
        // 换来的术语一致性提升有限
        ...opt('no-auto-extract-glossary'),
    ];
    // 优先用驱动脚本（能报进度、能解长度限制）；python 找不到或脚本缺失就退回直接跑 babeldoc
    const python = resolveDriverPython(bin);
    const useDriver = Boolean(python) && existsSync(DRIVER_PATH);
    const cmd = useDriver && python ? python : bin;
    const args = useDriver ? [DRIVER_PATH, ...babelArgs] : babelArgs;
    await new Promise<void>((resolveDone) => {
        const stages: StageWeight[] = [];
        let tail = '';
        let settled = false;
        // 子进程输出写文件而不是管道：①DSH 沙箱里 node 拿不到子进程管道（spawn EPERM）
        // ②翻译跑十几分钟，留一份完整日志比留 400 字符的尾巴好排查
        const logPath = join(tmpDir, `${stem}.babeldoc.log`);
        let spawnError: Error | null = null;
        let logFd = -1;
        try {
            logFd = openSync(logPath, 'w');
        }
        catch (e) {
            spawnError = e instanceof Error ? e : new Error(String(e));
        }
        const child = spawnError
            ? null
            : spawn(cmd, args, {
                env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com', PYTHONIOENCODING: 'utf-8' },
                windowsHide: true,
                stdio: ['ignore', logFd, logFd],
            });
        if (logFd >= 0)
            try {
                closeSync(logFd);
            }
            catch { /* 子进程已持有自己的副本 */ }
        const timer = setTimeout(() => {
            tail = `${tail}\n（超时 ${TRANSLATE_TIMEOUT_MS / 60000} 分钟，已中止）`;
            child?.kill();
        }, TRANSLATE_TIMEOUT_MS);
        const handleLine = (line: string): void => {
            const raw = line.trim();
            if (!raw)
                return;
            if (!raw.startsWith('@@DPR@@ ')) {
                // babeldoc 自己的输出（错误/warning）：留最后一段当失败原因
                tail = `${tail}\n${raw}`.slice(-MAX_TAIL_CHARS);
                return;
            }
            let event: DriverEvent;
            try {
                event = JSON.parse(raw.slice('@@DPR@@ '.length)) as DriverEvent;
            }
            catch {
                return;
            }
            if (event.kind === 'stages' && Array.isArray(event.stages)) {
                stages.length = 0;
                for (const s of event.stages as Array<{ name?: unknown; weight?: unknown }>)
                    if (s && typeof s.name === 'string')
                        stages.push({ name: s.name, weight: typeof s.weight === 'number' ? s.weight : 0 });
                return;
            }
            if (event.kind !== 'progress')
                return;
            if (event.type === 'error') {
                if (typeof event.message === 'string')
                    tail = `${tail}\n${event.message}`.slice(-MAX_TAIL_CHARS);
                return;
            }
            if (event.type === 'finish' || event.type === 'progress_end')
                return;
            const progress = buildProgress(event, stages);
            busy.set(ref.pdfPath, { phase: `${progress.text}…`, progress });
        };
        // 增量 tail 日志文件（按字节偏移读，用 StringDecoder 防多字节字符被切断）
        const decoder = new StringDecoder('utf8');
        let readFd = -1;
        let readPos = 0;
        let pending = '';
        try {
            readFd = openSync(logPath, 'r');
        }
        catch { /* 读不到就只靠退出码判断 */ }
        const pump = (): void => {
            if (readFd < 0)
                return;
            let size = 0;
            try {
                size = fstatSync(readFd).size;
            }
            catch {
                return;
            }
            if (size <= readPos)
                return;
            const buf = Buffer.allocUnsafe(Math.min(size - readPos, 256 * 1024));
            let n = 0;
            try {
                n = readSync(readFd, buf, 0, buf.length, readPos);
            }
            catch {
                return;
            }
            if (n <= 0)
                return;
            readPos += n;
            pending += decoder.write(buf.subarray(0, n));
            let idx: number;
            while ((idx = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, idx);
                pending = pending.slice(idx + 1);
                handleLine(line);
            }
            if (pending.length > 64 * 1024)
                pending = pending.slice(-4096);
        };
        const pumpTimer = setInterval(pump, 250);
        const end = (code: number | null, error: Error | null): void => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            clearInterval(pumpTimer);
            pump();
            pending += decoder.end();
            if (pending.trim())
                handleLine(pending);
            if (readFd >= 0)
                try {
                    closeSync(readFd);
                }
                catch { /* 无所谓 */ }
            void (async () => {
                if (error || code !== 0) {
                    const detail = (tail.trim() || error?.message || '').slice(-MAX_TAIL_CHARS);
                    console.error('[dsh-paper-reader] babeldoc failed:', detail);
                    busy.set(ref.pdfPath, { error: `babeldoc 执行失败: ${detail || `退出码 ${code}`}` });
                    resolveDone();
                    return;
                }
                // 产出从 scratch 挪回文献目录：<名>.zh-CN.mono.pdf → -zh.pdf，.dual.pdf → -dual.pdf
                try {
                    // 不用 glob：其 pattern 里反斜杠是转义符，win32 的 join 路径会踩雷；readdir + 前后缀匹配全平台稳
                    const files = await readdir(tmpDir);
                    for (const f of files) {
                        if (f.startsWith(stem) && f.endsWith('.zh-CN.mono.pdf'))
                            await rename(join(tmpDir, f), dstStem + '-zh.pdf');
                        if (f.startsWith(stem) && f.endsWith('.zh-CN.dual.pdf'))
                            await rename(join(tmpDir, f), dstStem + '-dual.pdf');
                    }
                    if (!existsSync(zhPdfPath(ref)) && !existsSync(dualPdfPath(ref))) {
                        const why = tail.trim().split('\n').pop() ?? '';
                        busy.set(ref.pdfPath, { error: `babeldoc 未产出译文 PDF${why ? `：${why}` : ''}` });
                        resolveDone();
                        return;
                    }
                    busy.delete(ref.pdfPath);
                    console.log(`[dsh-paper-reader] babeldoc done: ${ref.name}`);
                }
                catch (e) {
                    busy.set(ref.pdfPath, { error: `移动译文产物失败: ${e instanceof Error ? e.message : String(e)}` });
                }
                resolveDone();
            })();
        };
        if (!child) {
            end(null, spawnError ?? new Error('无法启动翻译进程'));
            return;
        }
        child.on('error', (err) => end(null, err));
        child.on('close', (code) => end(code, null));
    });
}

/** 解析 PDF 变体路径（原文/zh/dual）。 */
export function pdfVariantPath(ref: TranslatePaperRef, variant: string | null): string {
    if (variant === 'zh')
        return zhPdfPath(ref);
    if (variant === 'dual')
        return dualPdfPath(ref);
    return ref.pdfPath;
}
