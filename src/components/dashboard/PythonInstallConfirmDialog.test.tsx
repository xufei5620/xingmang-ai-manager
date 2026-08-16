import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PythonInstallConfirmDialog } from './PythonInstallConfirmDialog'

function elementText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(elementText).join('')
  if (!isValidElement<{ children?: ReactNode }>(node)) return ''
  return elementText(node.props.children)
}

function findButton(node: ReactNode, label: string): ReactElement<{ onClick?: () => void }> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findButton(child, label)
      if (match) return match
    }
    return null
  }
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return null
  if (node.type === 'button' && elementText(node).includes(label)) return node
  return findButton(node.props.children, label)
}

describe('PythonInstallConfirmDialog', () => {
  it('explains the current-user signed install before execution', () => {
    const markup = renderToStaticMarkup(
      <PythonInstallConfirmDialog onConfirm={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(markup).toContain('role="alertdialog"')
    expect(markup).toContain('仅为当前用户静默安装')
    expect(markup).toContain('Python Software Foundation')
    expect(markup).toContain('确认安装')
  })

  it('keeps cancel and confirmation as separate actions', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const tree = PythonInstallConfirmDialog({ onConfirm, onCancel })

    findButton(tree, '取消')?.props.onClick?.()
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()

    findButton(tree, '确认安装')?.props.onClick?.()
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})
