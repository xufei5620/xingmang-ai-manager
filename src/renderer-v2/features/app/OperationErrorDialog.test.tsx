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
    expect(markup).not.toContain('写不进安装目录')
    expect(markup).toContain('找客服')
  })

  it('shows the directory and offers 复制路径 once the caller knows one', () => {
    const raw = 'Claude Code 安装失败：npm 官方源：EPERM: operation not permitted, rename'
    const directory = 'C:\\Users\\peaker\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code'
    const markup = renderToStaticMarkup(
      <OperationErrorDialog failure={{ message: raw, tool: 'claude' }} installDirectory={directory}
        onClose={() => undefined} onAction={() => undefined} />,
    )
    expect(markup).toContain('写不进安装目录')
    expect(markup).toContain('operation-error-copyPath')
    // 剪贴板写不进去时用户还要能自己选中它，所以路径必须上屏，不只是躺在按钮后面。
    expect(markup).toContain('operation-error-path')
    expect(markup).toContain(directory)
  })

  it('hides 复制路径 when no directory is known, rather than copying an empty string', () => {
    const raw = 'Claude Code 安装失败：npm 官方源：EPERM: operation not permitted, rename'
    const markup = renderToStaticMarkup(
      <OperationErrorDialog failure={{ message: raw, tool: 'claude' }} onClose={() => undefined} onAction={() => undefined} />,
    )
    expect(markup).not.toContain('operation-error-copyPath')
    expect(markup).not.toContain('operation-error-path')
    // 按钮被过滤光了也不能只剩「返回」：目录的另一颗按钮仍在。
    expect(markup).toContain('operation-error-log')
  })

  it('filters 复制路径 the same way it filters 重试', () => {
    const permission = 'Claude Code 安装失败：npm 官方源：EPERM: operation not permitted, rename'
    expect(operationErrorActions({ message: permission }).map((action) => action.id)).toEqual(['log'])
    expect(operationErrorActions({ message: permission }, '/tmp/npm/@anthropic-ai/claude-code').map((action) => action.id))
      .toEqual(['copyPath', 'log'])
  })
})
