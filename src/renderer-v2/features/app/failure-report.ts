import type { RendererErrorPayload } from '../../../../electron/ipc-contract'

// parseRendererError (electron/ipc/parsers/system.ts) refuses the whole report
// once a field runs past its cap or carries a NUL. Sending React's component
// stack as context overran the 256-character cap on every real tree, so a
// full-page failure reached neither the runtime log nor Sentry: all that was
// left was one "错误上下文格式错误" line. The caps stay in the main process (I5);
// the report is fitted under them here instead.
const contextLimit = 256
const contextLabel = 'renderer-v2 error-boundary'
const messageLimit = 2000
const stackLimit = 6000

function withoutNul(value: string): string {
  return value.replaceAll('\0', '')
}

// React lists the component that threw first, so whole frames are kept from the
// top down: the cut drops the outer providers, never the failing component.
function compactComponentStack(componentStack: string, budget: number): string {
  let kept = ''
  for (const line of componentStack.split('\n')) {
    const frame = line.trim()
    if (!frame) continue
    const next = kept ? `${kept}\n${frame}` : frame
    if (next.length > budget) return kept || frame.slice(0, budget)
    kept = next
  }
  return kept
}

export function buildFailureBoundaryReport(error: unknown, componentStack?: string | null): RendererErrorPayload {
  const message = withoutNul(error instanceof Error ? error.message : typeof error === 'string' ? error : '').trim()
  const stack = error instanceof Error && error.stack ? withoutNul(error.stack).slice(0, stackLimit) : undefined
  const frames = compactComponentStack(withoutNul(componentStack ?? ''), contextLimit - contextLabel.length - 1)
  return {
    message: (message || '界面渲染发生异常').slice(0, messageLimit),
    stack,
    context: frames ? `${contextLabel}\n${frames}` : contextLabel,
  }
}
