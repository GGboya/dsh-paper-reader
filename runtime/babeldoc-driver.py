#!/usr/bin/env python
"""babeldoc 驱动（dsh-paper-reader 专用）：进度事件 + 去掉单次请求的输出长度上限。

用法与 babeldoc 完全一致——argv 原样交给 babeldoc 的 CLI 解析：

    python babeldoc-driver.py --files a.pdf --lang-in en --lang-out zh-CN --openai ...

只打两处补丁，都是「尽力而为」，任何一步失败就退回 babeldoc 原行为：

1. 进度：把 babeldoc 的 ProgressMonitor 事件按行写到 stdout，前缀 `@@DPR@@`，
   内容是一行 JSON（Node 侧逐行解析）。babeldoc 自己的 logger 被它自己设成
   ERROR 级并摘掉 handler，所以只能这么传。
2. 长度：babeldoc 调 LLM 时不传 max_tokens（端点默认值常常只有 2k~4k，
   长段落的中文译文会被静默截断），这里显式给足；万一仍被截断
   （finish_reason=length）或端点直接报「输入太长」，就把输入按换行/句子
   拆成小段分别翻译再拼回，避免整段丢译文或整篇失败。

环境变量（都可选）：
  DPR_MAX_OUTPUT_TOKENS  单次请求的 max_tokens 上限，默认 8192；0 = 不传该参数
  DPR_SPLIT_TOKENS       触发拆分的输入上限（估算 token），默认 3000
  DPR_DEBUG=1            额外把补丁动作打到 stderr
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import sys
import time

PREFIX = "@@DPR@@"


def _reconfigure_streams() -> None:
    """Windows 控制台默认 GBK，中文事件会乱码或被丢弃，改成 UTF-8。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass


_STDOUT_LOCK = None


def emit(payload: dict) -> None:
    """翻译在线程池里跑，多线程写 stdout 会撕行，加锁保证一行一条。"""
    global _STDOUT_LOCK
    if _STDOUT_LOCK is None:
        import threading

        _STDOUT_LOCK = threading.Lock()
    try:
        line = PREFIX + " " + json.dumps(payload, ensure_ascii=False) + "\n"
        with _STDOUT_LOCK:
            sys.stdout.write(line)
            sys.stdout.flush()
    except Exception:
        pass


def note(message: str) -> None:
    try:
        sys.stderr.write(f"[dpr] {message}\n")
        sys.stderr.flush()
    except Exception:
        pass


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(float(raw))
    except ValueError:
        return default


MAX_OUT = _env_int("DPR_MAX_OUTPUT_TOKENS", 8192)
SPLIT_TOKENS = max(200, _env_int("DPR_SPLIT_TOKENS", 3000))
DEBUG = os.environ.get("DPR_DEBUG", "") not in ("", "0", "false", "False")
REPORT_MIN_INTERVAL = 0.35  # 进度事件最小间隔（秒），别把 stdout 刷爆


# --------------------------------------------------------------------------
# 补丁 1：进度事件
# --------------------------------------------------------------------------
def install_progress() -> None:
    import babeldoc.main as bmain

    last = [0.0]

    def handle(event: dict) -> None:
        kind = event.get("type")
        if kind == "stage_summary":
            stages = [
                {"name": (s or {}).get("name"), "weight": (s or {}).get("percent")}
                for s in (event.get("stages") or [])
            ]
            emit({"kind": "stages", "stages": stages})
            return
        now = time.monotonic()
        if kind == "progress_update" and now - last[0] < REPORT_MIN_INTERVAL:
            return
        last[0] = now
        emit(
            {
                "kind": "progress",
                "type": kind,
                "stage": event.get("stage"),
                "stageCurrent": event.get("stage_current"),
                "stageTotal": event.get("stage_total"),
                "stagePercent": event.get("stage_progress"),
                "overall": event.get("overall_progress"),
                "part": event.get("part_index"),
                "totalParts": event.get("total_parts"),
            }
        )

    def create_progress_handler(config, show_log=False):  # noqa: ARG001
        return contextlib.nullcontext(), handle

    bmain.create_progress_handler = create_progress_handler
    if DEBUG:
        note("progress handler installed")


# --------------------------------------------------------------------------
# 补丁 2：不再让单次请求「长度受限」
# --------------------------------------------------------------------------
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_SENT_RE = re.compile(r"(?<=[.!?;:。！？；：])\s+")
_STYLE_OPEN_RE = re.compile(r"<b\d+>")
_STYLE_CLOSE_RE = re.compile(r"</b\d+>")
_FORMULA_RE = re.compile(r"\{(?:v\d+|\\s*v\s*\d+\s*)\}")
_PARAM_ERROR_RE = re.compile(r"max_(completion_)?tokens|unrecognized|unknown (parameter|field)|invalid_request", re.I)
_TOO_LONG_RE = re.compile(
    r"too long|context length|maximum context|max.*tokens.*exceed|prompt is too|"
    r"input.*(length|size).*(limit|exceed)|超过.*(长度|上限)|过长|too many tokens",
    re.I,
)
_THINKING_RE = re.compile(r"始终思考|不支持关闭思考|thinking|推理", re.I)


def rough_tokens(text: str) -> int:
    """粗估 token：英文约 4 字符 1 token，CJK 约 1.5 字符 1 token。"""
    if not text:
        return 0
    cjk = len(_CJK_RE.findall(text))
    latin = len(text) - cjk
    return int(latin / 4 + cjk / 1.5) + 1


def placeholders_balanced(text: str) -> bool:
    """拆段时不能把 <b12>…</b12> 这类富文本占位符劈成两半。"""
    if len(_STYLE_OPEN_RE.findall(text)) != len(_STYLE_CLOSE_RE.findall(text)):
        return False
    formulas = _FORMULA_RE.findall(text)
    # 公式占位符是单侧的，只要没被截断在中间就算平衡（正则已保证整体匹配）
    return all(f.strip() for f in formulas)


def split_text(text: str, limit_tokens: int) -> tuple[list[str], str]:
    """把一段文本拆成若干 <= limit_tokens 的片段，尽量在换行/句子边界切。

    返回 (片段列表, 拼回时用的分隔符)；拆不动时返回 ([text], "")。
    """
    if rough_tokens(text) <= limit_tokens:
        return [text], ""
    units = [line for line in text.split("\n") if line.strip()]
    joiner = "\n"
    if len(units) <= 1:
        units = [s for s in _SENT_RE.split(text) if s.strip()]
        joiner = " "
    if len(units) <= 1:
        # 连句子边界都没有：按字符硬切（极少见，兜底别死循环）
        step = max(200, limit_tokens * 3)
        return [text[i : i + step] for i in range(0, len(text), step)], ""

    pieces: list[str] = []
    current: list[str] = []
    for unit in units:
        candidate = joiner.join([*current, unit])
        if current and rough_tokens(candidate) > limit_tokens:
            pieces.append(joiner.join(current))
            current = [unit]
        else:
            current.append(unit)
    if current:
        pieces.append(joiner.join(current))
    pieces = [p for p in pieces if p.strip()]
    for piece in pieces:
        if not placeholders_balanced(piece):
            return [text], ""  # 拆了会破坏占位符 → 宁可不拆
    return (pieces, joiner) if len(pieces) > 1 else ([text], "")


def install_translation() -> None:
    import logging

    import openai
    from tenacity import before_sleep_log
    from tenacity import retry
    from tenacity import retry_if_exception_type
    from tenacity import stop_after_attempt
    from tenacity import wait_exponential

    from babeldoc.translator.translator import OpenAITranslator

    log = logging.getLogger("dpr.babeldoc")

    stats = {"splits": 0, "truncated": 0, "param_fallback": 0, "thinking_fallback": 0}

    def budget_for(text: str) -> int:
        """给一次请求配的 max_tokens：中文译文约为英文原文的 2.5~3 倍 token。"""
        if MAX_OUT <= 0:
            return 0
        return min(MAX_OUT, max(1024, int(rough_tokens(text) * 2.6) + 256))

    def raw_request(self, text, budget, llm_mode, rate_limit_params):
        options = {}
        if getattr(self, "send_temperature", True):
            options.update(self.options)
        params = rate_limit_params or {}
        if (
            llm_mode
            and getattr(self, "enable_json_mode_if_requested", False)
            and params.get("request_json_mode", False)
        ):
            options["response_format"] = {"type": "json_object"}
        extra_headers = {}
        if getattr(self, "send_dashscope_header", False):
            extra_headers["X-DashScope-DataInspection"] = (
                '{"input": "disable", "output": "disable"}'
            )
        extra_body = dict(getattr(self, "extra_body", {}) or {})
        if getattr(self, "_dpr_drop_thinking", False):
            # 端点明确拒绝 thinking 开关（如常思考模型）时彻底不提这个字段
            extra_body.pop("thinking", None)
            extra_body.pop("reasoning", None)
        # babeldoc 的 LLM 模式自己带完整提示词（[role]/[glossary] 模板），普通模式用 prompt()
        messages = [{"role": "user", "content": text}] if llm_mode else self.prompt(text)
        kwargs = {"model": self.model, **options, "messages": messages, "extra_body": extra_body}
        if getattr(self, "_dpr_low_reasoning", False):
            # 常思考模型（如 glm-5.x）关不掉 thinking，但可以降推理强度：
            # 实测 reasoning_tokens 由 436 降到 0、单段 7.0s→1.9s，且不再把 max_tokens 吃光
            kwargs["reasoning_effort"] = "low"
        if extra_headers:
            kwargs["extra_headers"] = extra_headers
        if budget and not getattr(self, "_dpr_no_max_tokens", False):
            kwargs["max_tokens"] = int(budget)
        response = self.client.chat.completions.create(**kwargs)
        self.update_token_count(response)
        choice = response.choices[0]
        return (choice.message.content or "").strip(), choice.finish_reason

    def call(self, text, budget, llm_mode, rate_limit_params):
        """一次请求；端点拒绝 thinking 开关时去掉该字段重试（只做一次）。"""
        try:
            return raw_request(self, text, budget, llm_mode, rate_limit_params)
        except openai.BadRequestError as exc:
            message = str(exc)
            if _THINKING_RE.search(message) and not getattr(self, "_dpr_drop_thinking", False):
                self.__dict__["_dpr_drop_thinking"] = True
                self.__dict__["_dpr_low_reasoning"] = True
                stats["thinking_fallback"] += 1
                note("endpoint refuses thinking=disabled, retrying without the field + reasoning_effort=low")
                return raw_request(self, text, budget, llm_mode, rate_limit_params)
            raise

    @retry(
        retry=retry_if_exception_type(openai.RateLimitError),
        stop=stop_after_attempt(100),
        wait=wait_exponential(multiplier=1, min=1, max=15),
        before_sleep=before_sleep_log(log, logging.WARNING),
    )
    def send(self, text, budget, llm_mode, rate_limit_params):
        return call(self, text, budget, llm_mode, rate_limit_params)

    def split_translate(self, text, llm_mode, rate_limit_params, depth=0):
        """输出被截断/输入太长时的兜底：拆段翻译再拼回（占位符不平衡就不拆）。"""
        fallback_budget = MAX_OUT if MAX_OUT > 0 else 0
        if depth >= 2:
            return send(self, text, fallback_budget, llm_mode, rate_limit_params)[0]
        limit = max(400, SPLIT_TOKENS // (2**depth))
        pieces, joiner = split_text(text, limit)
        if len(pieces) <= 1:
            return send(self, text, fallback_budget, llm_mode, rate_limit_params)[0]
        stats["splits"] += 1
        note(f"long input split into {len(pieces)} pieces (depth={depth}, llm={llm_mode})")
        outputs = []
        for piece in pieces:
            out, reason = send(
                self, piece, budget_for(piece), llm_mode, rate_limit_params
            )
            if reason == "length":
                out = split_translate(self, piece, llm_mode, rate_limit_params, depth + 1)
            outputs.append(out)
        return joiner.join(outputs)

    def run(self, text, llm_mode, rate_limit_params):
        if not isinstance(text, str) or not text.strip():
            return ""
        budget = budget_for(text)
        try:
            out, reason = send(self, text, budget, llm_mode, rate_limit_params)
        except openai.BadRequestError as exc:
            message = str(exc)
            if _PARAM_ERROR_RE.search(message) and not getattr(self, "_dpr_no_max_tokens", False):
                # 端点不认 max_tokens（或只认 max_completion_tokens）：去掉参数重发
                self.__dict__["_dpr_no_max_tokens"] = True
                stats["param_fallback"] += 1
                note("endpoint rejected max_tokens, retrying without it")
                out, reason = send(self, text, 0, llm_mode, rate_limit_params)
            elif _TOO_LONG_RE.search(message):
                stats["truncated"] += 1
                note("endpoint says input too long, splitting")
                return split_translate(self, text, llm_mode, rate_limit_params)
            else:
                raise
        if reason == "length":
            stats["truncated"] += 1
            note("output truncated (finish_reason=length)")
            if budget < MAX_OUT:
                out, reason = send(self, text, MAX_OUT, llm_mode, rate_limit_params)
            if reason == "length":
                return split_translate(self, text, llm_mode, rate_limit_params)
        return out

    def do_translate(self, text, rate_limit_params=None):
        return run(self, text, False, rate_limit_params)

    def do_llm_translate(self, text, rate_limit_params=None):
        # babeldoc 0.6.4 的段落翻译走这条：原实现把 max_tokens 硬写成 2048
        return run(self, text, True, rate_limit_params)

    OpenAITranslator.do_translate = do_translate
    OpenAITranslator.do_llm_translate = do_llm_translate
    if DEBUG:
        note(f"translation patch installed (max_out={MAX_OUT}, split={SPLIT_TOKENS})")
    return stats


def main() -> int:
    _reconfigure_streams()
    emit({"kind": "driver", "version": 1, "maxOutputTokens": MAX_OUT, "splitTokens": SPLIT_TOKENS})
    import asyncio

    try:
        install_progress()
        install_translation()
    except Exception as exc:  # 补丁失败也要能翻：退回原版 babeldoc
        note(f"patch failed, falling back to plain babeldoc: {exc!r}")

    import babeldoc.main as bmain

    try:
        asyncio.run(bmain.main())
    except SystemExit as exc:
        emit({"kind": "exit", "code": exc.code if isinstance(exc.code, int) else 1})
        return exc.code if isinstance(exc.code, int) else 1
    except BaseException as exc:  # noqa: BLE001 - 交给 Node 侧展示
        note(f"babeldoc failed: {type(exc).__name__}: {exc}")
        traceback = __import__("traceback")
        traceback.print_exc()
        emit({"kind": "exit", "code": 1, "error": f"{type(exc).__name__}: {exc}"})
        return 1
    emit({"kind": "exit", "code": 0})
    return 0


if __name__ == "__main__":
    sys.exit(main())
