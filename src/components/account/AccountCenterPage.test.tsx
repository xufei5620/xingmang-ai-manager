import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AccountKeySecretCell } from './AccountCenterPage'

const sharedProps = {
  keyName: 'xingmang-desktop-codex',
  maskedKey: 'sk-abcd**********wxyz',
  copying: false,
  copied: false,
  revealing: false,
  copyDisabled: false,
  revealDisabled: false,
  onCopy: vi.fn(),
  onToggleReveal: vi.fn(),
}

describe('AccountKeySecretCell', () => {
  it('shows only the masked key and the reveal control by default', () => {
    const markup = renderToStaticMarkup(
      <AccountKeySecretCell {...sharedProps} revealedSecret={null} />,
    )

    expect(markup).toContain('sk-abcd**********wxyz')
    expect(markup).toContain('显示 API Key')
    expect(markup).toContain('aria-pressed="false"')
    expect(markup).not.toContain('sk-plaintext-secret')
  })

  it('shows the complete key and the hide control only after reveal succeeds', () => {
    const markup = renderToStaticMarkup(
      <AccountKeySecretCell {...sharedProps} revealedSecret="sk-plaintext-secret" />,
    )

    expect(markup).toContain('sk-plaintext-secret')
    expect(markup).toContain('隐藏 API Key')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).not.toContain('sk-abcd**********wxyz')
  })
})
