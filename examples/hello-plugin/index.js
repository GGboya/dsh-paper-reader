// Minimal dsh (Cordis) plugin: proves the --patch overlay can load a local module.
export const name = 'dsh-paper-reader-hello'

export function apply(ctx, config) {
  ctx.logger?.info?.('hello from dsh-paper-reader minimal plugin, config = %j', config)
  console.log('[dsh-paper-reader] minimal plugin applied, config =', config)
}

export default apply
