import { AlertCircle, Check, Circle, LoaderCircle, ShieldAlert } from 'lucide-react'
import type { ManagedBootstrapProgress } from '../../managed-bootstrap-progress'

export function ManagedBootstrapPanel({
  progress,
  locked,
}: {
  progress: ManagedBootstrapProgress
  locked: boolean
}) {
  const current = progress.activeStep
  const summary = current?.status === 'failed'
    ? '自动配置未完成'
    : current?.message ?? (progress.percent === 100 ? '自动配置已完成' : '正在准备下一步')
  return (
    <section className="managed-bootstrap-panel" aria-label="自动初始化详细进度">
      <div className="managed-bootstrap-summary">
        <div>
          <strong>{summary}</strong>
          <span>{current?.status === 'failed'
            ? '问题已保留，可以使用下方恢复操作重试。'
            : locked ? '正在自动配置，请勿关闭软件或重复操作。' : '准备继续自动配置。'}</span>
        </div>
        <b>{progress.percent}%</b>
      </div>
      <progress max="100" value={progress.percent} aria-label={'自动初始化进度 ' + progress.percent + '%'} />
      <div className="managed-bootstrap-steps">
        {progress.steps.map((step) => (
          <div className={'managed-bootstrap-step status-' + step.status} key={step.id}>
            <span className="managed-bootstrap-step-icon" aria-hidden="true">
              {step.status === 'completed' ? <Check size={13} />
                : step.status === 'active' ? <LoaderCircle size={13} className="spin" />
                  : step.status === 'failed' ? <AlertCircle size={13} /> : <Circle size={11} />}
            </span>
            <div>
              <strong>{step.label}</strong>
              <small>{step.message ?? step.detail}</small>
            </div>
          </div>
        ))}
      </div>
      {locked && (
        <div className="managed-bootstrap-lock" role="status">
          <ShieldAlert size={14} />
          自动流程运行期间已锁定返回、重试和重复提交操作
        </div>
      )}
    </section>
  )
}
