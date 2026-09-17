// dsh-paper-reader — Cordis 插件壳。
// 壳保持薄：agent 循环/模型层交给 dsh 框架，本插件只注册工具和 HTTP 路由。
// 核心逻辑（转录/检索）是 src/ 下不依赖 Cordis 的纯函数模块，方便日后迁移。

import type { Context } from '@deepseek-ai/cordis'
import { registerTools, type PluginConfig } from './tools.ts'
import { registerRoutes } from './host.ts'

export const name = 'dsh-paper-reader'

// 等宿主的工具注册服务（ctx.tools）就绪后再运行。
export const inject = ['tools']

export function apply(ctx: Context, config: PluginConfig = {}) {
  registerTools(ctx, config)
  console.log(`[dsh-paper-reader] registered tools: list_papers, transcribe_pdf, search_paper, study_progress, study_update`)

  // webServer 是可选服务（web profile 有，headless 没有）：出现时再挂路由。
  // connection/sessionController/workspaceController/workspaceRegistry 同属 web profile（cordis 要求访问前先声明 inject）。
  ctx.inject(['webServer', 'connection', 'sessionController', 'workspaceController', 'workspaceRegistry'], (rctx) => {
    registerRoutes(rctx, config)
  })
}
