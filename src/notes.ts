// notes.ts — 文献级笔记：每篇论文一个 `<论文>.notes.json`，与 `<论文>.txt` / `.study.json` 同目录。
//
// 为什么放在论文旁边而不是浏览器 localStorage：笔记是用户的积累，必须跟文献走（换浏览器/换机器不丢），
// 而且和 `.study.json` 一样待在专题目录里，删除/改名论文时天然跟着一起搬。
//
// 这个文件只做「读 / 写 / 校验 / 原子落盘」；HTTP 转接在 host.ts（路由与错误码都在那边）。
// 锚点约定：`anchor = {page, start, end}` 是「该页文本层拼接串」里的字符区间，由阅读器在划词时算出来；
// 阅读器重渲染/缩放后按同一偏移重建 Range，所以这里只当不透明数据校验范围，不解释其语义。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface NoteAnchor {
    page: number;
    start: number;
    end: number;
    /** 锚点算在哪一列：原文列 'orig'（默认）还是译文列 'zh'（分屏时在中文列划的词） */
    doc?: 'orig' | 'zh';
}

export interface PaperNote {
    id: string;
    quote: string;
    anchor?: NoteAnchor;
    body: string;
    created: string;
    updated: string;
}

export interface NotesFile {
    v: 1;
    updated: string | null;
    notes: PaperNote[];
}

/** 单条正文上限：与阅读器 `NOTE_BODY_MAX` 对齐（超出截断而不是报错，用户不会因为写太长丢内容）。 */
export const MAX_NOTE_BODY = 20000;
/** 单篇上限：防御性封顶，避免一条脏数据把文件写成几 MB。 */
export const MAX_NOTES_PER_PAPER = 2000;
const MAX_QUOTE = 1200;
const MAX_PAGE = 100000;

/** `<dataDir>/<topic>/<name>.pdf` → `<dataDir>/<topic>/<name>.notes.json` */
export function notesPathFor(pdfPath: string): string {
    return pdfPath.slice(0, -4) + '.notes.json';
}

export class NoteError extends Error {
    readonly code: string;
    constructor(message: string, code = 'bad-note') {
        super(message);
        this.name = 'NoteError';
        this.code = code;
    }
}

export function isNoteError(err: unknown): err is NoteError {
    return err instanceof NoteError;
}

function emptyFile(): NotesFile {
    return { v: 1, updated: null, notes: [] };
}

function clampInt(v: unknown, lo: number, hi: number): number | null {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return null;
    const i = Math.trunc(n);
    return i < lo || i > hi ? null : i;
}

function normalizeAnchor(raw: unknown): NoteAnchor | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const o = raw as Record<string, unknown>;
    const page = clampInt(o.page, 1, MAX_PAGE);
    const start = clampInt(o.start, 0, 10_000_000);
    const end = clampInt(o.end, 0, 10_000_000);
    if (page === null || start === null || end === null || end <= start) return undefined;
    const anchor: NoteAnchor = { page, start, end };
    if (o.doc === 'zh' || o.doc === 'orig') anchor.doc = o.doc;
    return anchor;
}

/** 只保留形状正确的条目（坏数据不连累整份文件） */
function normalizeNote(raw: unknown): PaperNote | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id || o.id.length > 80) return null;
    const body = typeof o.body === 'string' ? o.body : '';
    if (!body.trim()) return null;
    const now = new Date().toISOString();
    const quote = typeof o.quote === 'string' ? o.quote.slice(0, MAX_QUOTE) : '';
    const created = typeof o.created === 'string' && o.created ? o.created : now;
    const updated = typeof o.updated === 'string' && o.updated ? o.updated : created;
    const out: PaperNote = { id: o.id, quote, body: body.slice(0, MAX_NOTE_BODY), created, updated };
    const anchor = normalizeAnchor(o.anchor);
    if (anchor) out.anchor = anchor;
    return out;
}

/** 读：文件不存在 → 空文件；坏 JSON → 空文件（笔记坏了也别让阅读器打不开论文）。 */
export async function readNotes(pdfPath: string): Promise<NotesFile> {
    const path = notesPathFor(pdfPath);
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch {
        return emptyFile();
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return emptyFile();
    }
    const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const list = Array.isArray(o.notes) ? o.notes : [];
    const notes: PaperNote[] = [];
    for (const item of list) {
        const n = normalizeNote(item);
        if (n) notes.push(n);
    }
    return {
        v: 1,
        updated: typeof o.updated === 'string' ? o.updated : null,
        notes: notes.slice(0, MAX_NOTES_PER_PAPER),
    };
}

/** 写：先写同目录临时文件再 rename（半截文件永远不会被读到）。 */
export async function writeNotes(pdfPath: string, file: NotesFile): Promise<void> {
    const path = notesPathFor(pdfPath);
    await mkdir(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.notes-tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
    await writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
    await rename(tmp, path);
}

/** 校验「用户提交的一条笔记」：id 可空（新建由服务端发），正文必填。 */
export function validateNoteInput(raw: unknown): PaperNote {
    if (!raw || typeof raw !== 'object') throw new NoteError('笔记内容不合法');
    const o = raw as Record<string, unknown>;
    const body = typeof o.body === 'string' ? o.body.trim() : '';
    if (!body) throw new NoteError('笔记内容不能为空');
    const now = new Date().toISOString();
    const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim().slice(0, 80) : `n-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const quote = typeof o.quote === 'string' ? o.quote.slice(0, MAX_QUOTE) : '';
    const created = typeof o.created === 'string' && o.created ? o.created : now;
    const updated = typeof o.updated === 'string' && o.updated ? o.updated : now;
    const out: PaperNote = { id, quote, body: body.slice(0, MAX_NOTE_BODY), created, updated };
    const anchor = normalizeAnchor(o.anchor);
    if (anchor) out.anchor = anchor;
    return out;
}

/** 新建或更新一条（按 id 判重）；返回整份文件，客户端整体替换即可。 */
export async function upsertNote(pdfPath: string, input: unknown): Promise<NotesFile> {
    const incoming = validateNoteInput(input);
    const file = await readNotes(pdfPath);
    const i = file.notes.findIndex((n) => n.id === incoming.id);
    if (i >= 0) {
        const old = file.notes[i] as PaperNote;
        // 已经存在的笔记：created 保持第一次的时间，updated 用这次的时间
        const next: PaperNote = {
            id: old.id,
            quote: incoming.quote,
            body: incoming.body,
            created: old.created,
            updated: new Date().toISOString(),
        };
        const anchor = incoming.anchor;
        if (anchor) next.anchor = anchor;
        file.notes[i] = next;
    } else {
        if (file.notes.length >= MAX_NOTES_PER_PAPER) throw new NoteError(`笔记太多了（上限 ${MAX_NOTES_PER_PAPER} 条）`, 'too-many-notes');
        file.notes.push(incoming);
    }
    file.updated = new Date().toISOString();
    await writeNotes(pdfPath, file);
    return file;
}

/** 删除一条；找不到就当作已删除（幂等，避免双开两边点删除时报错）。 */
export async function deleteNote(pdfPath: string, id: unknown): Promise<NotesFile> {
    const key = typeof id === 'string' ? id.trim() : '';
    if (!key) throw new NoteError('缺少要删除的笔记 id');
    const file = await readNotes(pdfPath);
    const before = file.notes.length;
    file.notes = file.notes.filter((n) => n.id !== key);
    if (file.notes.length === before) return file;
    file.updated = new Date().toISOString();
    await writeNotes(pdfPath, file);
    return file;
}
