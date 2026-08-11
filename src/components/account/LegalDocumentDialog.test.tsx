import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import {
  privacyPolicyUrl,
  userAgreementUrl,
  type LegalDocument,
  type LegalDocumentKind,
} from '../../types'

const hookState = vi.hoisted(() => ({ values: [] as unknown[] }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => [
      hookState.values.length > 0
        ? hookState.values.shift()
        : typeof initial === 'function' ? initial() : initial,
      vi.fn(),
    ],
    useRef: (initial: unknown) => ({ current: initial }),
    useCallback: (callback: unknown) => callback,
    useEffect: () => undefined,
  }
})

import { LegalDocumentDialog, legalDocumentTitle } from './LegalDocumentDialog'

const getLegalDocument = vi.fn()
const openExternal = vi.fn(async () => true)

function documentFixture(markdown: string, kind: LegalDocumentKind = 'user-agreement'): LegalDocument {
  return {
    kind,
    markdown,
    fetchedAt: '2026-08-11T00:00:00.000Z',
  }
}

function prepareDialogState(document: LegalDocument | null, loading: boolean, error: string | null): void {
  hookState.values = [document, loading, error]
}

function renderDocument(markdown: string): string {
  prepareDialogState(documentFixture(markdown), false, null)
  return renderToStaticMarkup(
    <LegalDocumentDialog kind="user-agreement" onClose={vi.fn()} />,
  )
}

function elementText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(elementText).join('')
  if (!isValidElement<{ children?: ReactNode }>(node)) return ''
  return elementText(node.props.children)
}

function findButton(node: ReactNode, label: string): ReactElement<{
  children?: ReactNode
  onClick?: () => void
}> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label)
      if (found) return found
    }
    return null
  }
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return null
  if (node.type === 'button' && elementText(node.props.children).includes(label)) return node
  return findButton(node.props.children, label)
}

beforeEach(() => {
  hookState.values = []
  getLegalDocument.mockReset()
  openExternal.mockReset()
  openExternal.mockResolvedValue(true)
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      xingmang: {
        getLegalDocument,
        openExternal,
      },
    },
  })
})

describe('legalDocumentTitle', () => {
  it('extracts the first level-one Markdown heading', () => {
    expect(legalDocumentTitle(
      documentFixture('前言\n\n#   服务条款   \n\n正文'),
      'user-agreement',
    )).toBe('服务条款')
  })

  it('uses the document-specific fallback when no level-one heading exists', () => {
    expect(legalDocumentTitle(documentFixture('## 二级标题'), 'user-agreement')).toBe('用户协议')
    expect(legalDocumentTitle(null, 'privacy-policy')).toBe('隐私政策')
  })
})

describe('LegalDocumentDialog safe Markdown rendering', () => {
  it('skips raw HTML and script content while preserving ordinary Markdown', () => {
    const html = renderDocument([
      '# 安全条款',
      '<script>globalThis.compromised = true</script>',
      '<div><strong>raw html</strong></div>',
      '**正常正文**',
    ].join('\n\n'))

    expect(html).toContain('<h1>安全条款</h1>')
    expect(html).toContain('<strong>正常正文</strong>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('globalThis.compromised')
    expect(html).not.toContain('<div><strong>raw html</strong></div>')
  })

  it('turns remote images into inert text without a src or request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const html = renderDocument('![追踪像素](https://attacker.example/pixel.png)')

    expect(html).toContain('图片已隐藏')
    expect(html).toContain('追踪像素')
    expect(html).not.toContain('src=')
    expect(html).not.toContain('attacker.example')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(getLegalDocument).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('turns Markdown links into inert text without a navigable anchor', () => {
    const html = renderDocument('[危险链接](https://attacker.example/phish)')

    expect(html).toContain('危险链接')
    expect(html).not.toMatch(/<a(?:\s|>)/)
    expect(html).not.toContain('href=')
    expect(html).not.toContain('attacker.example')
  })

  it.each([
    ['user-agreement', userAgreementUrl],
    ['privacy-policy', privacyPolicyUrl],
  ] as const)('opens only the canonical %s browser fallback', (kind, expectedUrl) => {
    prepareDialogState(null, false, '网络不可用')
    const tree = LegalDocumentDialog({ kind, onClose: vi.fn() })
    const browserButton = findButton(tree, '浏览器查看')

    expect(browserButton).not.toBeNull()
    browserButton?.props.onClick?.()
    expect(openExternal).toHaveBeenCalledOnce()
    expect(openExternal).toHaveBeenCalledWith(expectedUrl)
  })
})
