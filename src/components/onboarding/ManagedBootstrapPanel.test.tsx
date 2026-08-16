import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createManagedBootstrapProgress, updateManagedBootstrapProgress } from '../../managed-bootstrap-progress'
import { ManagedBootstrapPanel } from './ManagedBootstrapPanel'

describe('ManagedBootstrapPanel', () => {
  it('renders the ten-step progress and explicit interaction lock', () => {
    const progress = updateManagedBootstrapProgress(createManagedBootstrapProgress(), {
      id: 'prepare-node',
      status: 'active',
      message: '正在安装 Node.js',
    })
    const markup = renderToStaticMarkup(<ManagedBootstrapPanel progress={progress} locked />)

    expect(markup.match(/managed-bootstrap-step status-/g)).toHaveLength(10)
    expect(markup).toContain('正在安装 Node.js')
    expect(markup).toContain('自动流程运行期间已锁定返回、重试和重复提交操作')
    expect(markup).toContain('value="30"')
  })

  it('shows a failed step without the running lock notice', () => {
    const progress = updateManagedBootstrapProgress(createManagedBootstrapProgress(), {
      id: 'sync-keys',
      status: 'failed',
      message: 'Key 同步失败',
    })
    const markup = renderToStaticMarkup(<ManagedBootstrapPanel progress={progress} locked={false} />)

    expect(markup).toContain('自动配置未完成')
    expect(markup).toContain('Key 同步失败')
    expect(markup).not.toContain('已锁定返回')
  })
})
