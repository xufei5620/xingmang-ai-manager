import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NodeReplaceDialog } from './NodeReplaceDialog'

describe('renderer-v2 node replace dialog', () => {
  it('says what will happen before anything is replaced, without jargon', () => {
    const markup = renderToStaticMarkup(<NodeReplaceDialog version="v20.11.1" onConfirm={() => undefined} onClose={() => undefined} />)
    expect(markup).toContain('是否更新 Node.js？')
    expect(markup).toContain('本机的 Node.js 版本为 v20.11.1')
    expect(markup).toContain('请点击「是」')
    expect(markup).toContain('已安装的工具无需重新安装')
    expect(markup).toContain('node-replace-confirm')
    expect(markup).toContain('暂不更新')
    for (const jargon of ['PATH', 'npm', 'MSI', '环境变量', 'winget', '证书库']) expect(markup).not.toContain(jargon)
  })
})
