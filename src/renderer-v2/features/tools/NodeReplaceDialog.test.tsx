import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NodeReplaceDialog } from './NodeReplaceDialog'

describe('renderer-v2 node replace dialog', () => {
  it('says what will happen before anything is replaced, without jargon', () => {
    const markup = renderToStaticMarkup(<NodeReplaceDialog version="v20.11.1" onConfirm={() => undefined} onClose={() => undefined} />)
    expect(markup).toContain('换成新版 Node.js？')
    expect(markup).toContain('这台电脑上的 Node.js 是 v20.11.1')
    expect(markup).toContain('点「是」就行')
    expect(markup).toContain('已经装好的工具不用重装')
    expect(markup).toContain('node-replace-confirm')
    expect(markup).toContain('先不换')
    for (const jargon of ['PATH', 'npm', 'MSI', '环境变量', 'winget', '证书库']) expect(markup).not.toContain(jargon)
  })
})
