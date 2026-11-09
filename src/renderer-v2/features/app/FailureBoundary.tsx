import { Component, type ErrorInfo, type ReactNode } from 'react'
import type { XingmangApi } from '../../../../electron/ipc-contract'
import { Splash } from '../auth/Splash'
import { buildFailureBoundaryReport } from './failure-report'

export class FailureBoundary extends Component<{ native: XingmangApi; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    void this.props.native.reportRendererError(buildFailureBoundaryReport(error, info.componentStack)).catch(() => undefined)
  }
  render() {
    return this.state.failed
      ? <Splash phase="界面暂时没有打开" error="本机已保存的数据仍在。可以重新打开界面；尚未保存的编辑需要重新填写。" onRetry={() => this.setState({ failed: false })} />
      : this.props.children
  }
}
