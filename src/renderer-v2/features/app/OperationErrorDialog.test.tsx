import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OperationErrorDialog, operationErrorActions } from './OperationErrorDialog'

describe('renderer-v2 operation error dialog', () => {
  it('leads with the catalog heading and keeps the backend sentence underneath', () => {
    const raw = 'Claude Code 更新失败：SHA-512 完整性校验不一致'
    const markup = renderToStaticMarkup(
      <OperationErrorDialog failure={{ message: raw, retry: () => undefined }} onClose={() => undefined} onAction={() => undefined} />,
    )
    expect(markup).toContain('更新没有装上')
    expect(markup).toContain('当前版本不受影响。')
    expect(markup).toContain(raw)
    expect(markup).toContain('operation-error-retry')
    expect(markup).toContain('operation-error-log')
  })

  it('gives an unrecognised failure the fallback buttons instead of only 返回', () => {
    const raw = 'spawn ENOSYS'
    const markup = renderToStaticMarkup(
      <OperationErrorDialog failure={{ message: raw }} onClose={() => undefined} onAction={() => undefined} />,
    )
    expect(markup).toContain('操作没有完成')
    expect(markup).toContain(raw)
    expect(markup).toContain('查看日志')
    expect(markup).toContain('找客服')
    // 这次失败没有可重试的入口，按钮就不该画出来。
    expect(markup).not.toContain('operation-error-retry')
  })

  it('drops 重试 when the failure carries no retry, and keeps it when it does', () => {
    expect(operationErrorActions({ message: 'spawn ENOSYS' }).map((action) => action.id)).toEqual(['log', 'support'])
    expect(operationErrorActions({ message: 'spawn ENOSYS', retry: () => undefined }).map((action) => action.id))
      .toEqual(['retry', 'log', 'support'])
  })

  it('does not reassure when the backend says the rollback failed too', () => {
    const raw = '托管 npm 更新失败，且旧版本回滚失败：EPERM: operation not permitted'
    const markup = renderToStaticMarkup(
      <OperationErrorDialog failure={{ message: raw }} onClose={() => undefined} onAction={() => undefined} />,
    )
    expect(markup).toContain(raw)
    expect(markup).not.toContain('当前版本不受影响')
    expect(markup).not.toContain('需要管理员权限')
    expect(markup).toContain('找客服')
  })
})
