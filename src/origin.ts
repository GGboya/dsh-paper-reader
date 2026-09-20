// origin.ts — 记录 dsh web 服务的外部地址（从插件路由收到的请求 Host 头捕获）。
// 工具进程不是 HTTP 请求，自己不知道服务端口；但浏览器客户端会持续打 /paper-reader/api
// （文献库 30s 轮询等），借它的 Host 头还原出可点击链接的基址。

let origin: string | null = null

/** 每次插件路由被请求时调用；Host 已过宿主围栏校验，可信。 */
export function noteOrigin(host: unknown) {
  if (typeof host === 'string' && host.length > 0) origin = `http://${host}`
}

/** 当前服务 origin；尚无任何请求时为 null（此时工具输出不带链接基址）。 */
export function readerOrigin(): string | null {
  return origin
}
