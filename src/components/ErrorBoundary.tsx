import { Component, type ReactNode } from 'react'
import { Download, Home, LoaderCircle, RotateCw, TriangleAlert } from 'lucide-react'
import { errorMessage } from '../error-message'
import { rendererErrorDeduper, reportRendererError } from '../renderer-error-report'

export interface ErrorBoundaryToast {
  type: 'success' | 'error'
  message: string
}

export interface ErrorBoundaryProps {
  children: ReactNode
  // Whenever this changes while the fallback is showing, the boundary
  // retries rendering children on its own. App.tsx passes activePage, so
  // switching pages through the sidebar — not just the buttons below —
  // recovers a crashed page the moment the user navigates away from it.
  resetKey: string
  onReturnOverview: () => void
  notify?: (toast: ErrorBoundaryToast) => void
}

interface ErrorBoundaryState {
  // Tracked separately from `error`: a thrown value can legally be `null` or
  // `undefined` (`throw null`), and treating that as "no error" would make
  // the boundary call itself healthy, re-render the same crashing children,
  // and throw again in a tight loop.
  hasError: boolean
  error: unknown
  exporting: boolean
}

// React error boundaries must be class components — there is no hook
// equivalent of getDerivedStateFromError/componentDidCatch. This is the
// repo's one sanctioned exception to "module top level uses function
// declarations"; everything inside still follows house style (no
// semicolons, single quotes, 2-space indent).
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null, exporting: false }

  static getDerivedStateFromError(error: unknown): Pick<ErrorBoundaryState, 'hasError' | 'error'> {
    return { hasError: true, error }
  }

  componentDidCatch(error: unknown): void {
    // error is typed unknown, not Error: JS allows `throw null` or `throw
    // 'x'`, and reaching into .message/.stack on those would throw again
    // from inside a lifecycle method. errorMessage() already handles both.
    //
    // Deduped against main.tsx's window.onerror listener: React's dev build
    // can surface this exact error there too (see renderer-error-report.ts).
    if (rendererErrorDeduper.claim(error)) {
      reportRendererError(
        errorMessage(error),
        error instanceof Error ? error.stack : undefined,
        `error-boundary:${this.props.resetKey}`,
      )
    }
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps, prevState: ErrorBoundaryState): void {
    // Only auto-recover when the fallback was already showing before this
    // update (prevState.hasError). Without that guard, a page that crashes
    // on its very first render under a *new* resetKey would have its
    // just-caught error cleared immediately, dropping the fallback and
    // retrying children in a tight loop instead of showing the crash.
    if (
      this.state.hasError
      && prevState.hasError
      && prevProps.resetKey !== this.props.resetKey
    ) {
      this.reset()
    }
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null })
  }

  handleReturnOverview = (): void => {
    // setActivePage('overview') is a no-op re-render when the crash happened
    // on the overview page itself (state already equals 'overview'), so the
    // boundary must also clear its own error instead of relying solely on
    // componentDidUpdate noticing a resetKey change.
    this.reset()
    this.props.onReturnOverview()
  }

  handleReload = (): void => {
    window.location.reload()
  }

  handleExportLogs = (): void => {
    this.setState({ exporting: true })
    window.xingmang.exportFeedbackReport()
      .then((result) => {
        this.props.notify?.(
          result
            ? { type: 'success', message: `诊断报告已导出：${result.outputPath}` }
            : { type: 'error', message: '已取消导出' },
        )
      })
      .catch((cause: unknown) => {
        this.props.notify?.({ type: 'error', message: errorMessage(cause) })
      })
      .finally(() => {
        this.setState({ exporting: false })
      })
  }

  render(): ReactNode {
    const { hasError, error, exporting } = this.state
    if (!hasError) return this.props.children

    return (
      <div className="page page-crash-page" data-page-id="error-boundary">
        <div className="workspace-empty page-crash-panel" role="alert">
          <div className="workspace-empty-icon page-crash-icon"><TriangleAlert size={24} /></div>
          <h2>页面出现异常</h2>
          <p className="page-crash-message">{errorMessage(error)}</p>
          <div className="page-crash-actions">
            <button className="primary-button" type="button" onClick={this.handleReturnOverview}>
              <Home size={16} /> 返回概览
            </button>
            <button className="secondary-button" type="button" onClick={this.handleReload}>
              <RotateCw size={16} /> 重新加载
            </button>
            <button className="secondary-button" type="button" onClick={this.handleExportLogs} disabled={exporting}>
              {exporting ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
              导出诊断日志
            </button>
          </div>
        </div>
      </div>
    )
  }
}
