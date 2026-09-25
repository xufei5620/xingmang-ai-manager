import { EventEmitter } from 'node:events'
import type { ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { attachEditContextMenu, buildEditContextMenuTemplate, resolveCopyableLink, type EditContextMenuParams } from './context-menu'

const allFlags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false }
const noFlags = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false, canSelectAll: false, canEditRichly: false }

function params(overrides: Partial<EditContextMenuParams> = {}): EditContextMenuParams {
  return { isEditable: false, selectionText: '', editFlags: noFlags, linkURL: '', ...overrides }
}

function labels(template: MenuItemConstructorOptions[]) {
  return template.map((item) => item.type === 'separator' ? '-' : `${item.label}${item.enabled === false ? '(off)' : ''}`)
}

describe('context menu', () => {
  it('offers cut, copy, paste and select all inside editable fields', () => {
    const template = buildEditContextMenuTemplate(params({ isEditable: true, editFlags: allFlags }), { copyLink: () => {} })
    expect(labels(template)).toEqual(['剪切', '复制', '粘贴', '-', '全选'])
    expect(template.filter((item) => item.role).map((item) => item.role)).toEqual(['cut', 'copy', 'paste', 'selectAll'])
  })

  it('greys out edit actions Chromium reports as unavailable', () => {
    const template = buildEditContextMenuTemplate(params({ isEditable: true, editFlags: { ...noFlags, canPaste: true, canSelectAll: true } }), { copyLink: () => {} })
    expect(labels(template)).toEqual(['剪切(off)', '复制(off)', '粘贴', '-', '全选'])
  })

  it('offers only copy for selected plain text', () => {
    const template = buildEditContextMenuTemplate(params({ selectionText: '  npm install  ', editFlags: { ...noFlags, canCopy: true } }), { copyLink: () => {} })
    expect(labels(template)).toEqual(['复制'])
    expect(template[0].role).toBe('copy')
  })

  it('shows nothing on blank areas and whitespace-only selections', () => {
    expect(buildEditContextMenuTemplate(params(), { copyLink: () => {} })).toEqual([])
    expect(buildEditContextMenuTemplate(params({ selectionText: ' \n ' }), { copyLink: () => {} })).toEqual([])
  })

  it('copies http links through the injected clipboard writer', () => {
    const copied: string[] = []
    const template = buildEditContextMenuTemplate(params({ selectionText: '官网', editFlags: allFlags, linkURL: 'https://xm.solov.cc/wallet' }), { copyLink: (url) => copied.push(url) })
    expect(labels(template)).toEqual(['复制', '-', '复制链接'])
    const click = template[2].click as (() => void) | undefined
    click?.()
    expect(copied).toEqual(['https://xm.solov.cc/wallet'])
  })

  it('never offers to copy non-web links', () => {
    expect(resolveCopyableLink('javascript:alert(1)')).toBeNull()
    expect(resolveCopyableLink('file:///C:/Windows/system32')).toBeNull()
    expect(resolveCopyableLink('xingmang-canvas://app/index.html')).toBeNull()
    expect(resolveCopyableLink('not a url')).toBeNull()
    expect(resolveCopyableLink('http://example.com/a b')).toBe('http://example.com/a%20b')
  })

  it('pops up a menu only when there is something to show', () => {
    const contents = new EventEmitter()
    const shown: MenuItemConstructorOptions[][] = []
    attachEditContextMenu(contents as unknown as WebContents, { popup: (template) => shown.push(template), writeText: () => {} })
    contents.emit('context-menu', {}, params() as ContextMenuParams)
    contents.emit('context-menu', {}, params({ isEditable: true, editFlags: allFlags }) as ContextMenuParams)
    expect(shown.map(labels)).toEqual([['剪切', '复制', '粘贴', '-', '全选']])
  })
})
