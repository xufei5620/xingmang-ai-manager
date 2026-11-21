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
      ? <Splash phase="界面加载失败" error="本机已保存的数据不受影响。请重新打开界面，未保存的内容需重新填写。" onRetry={() => this.setState({ failed: false })} />
      : this.props.children
  }
}
