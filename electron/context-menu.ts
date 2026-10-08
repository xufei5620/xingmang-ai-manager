import type { ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron'

export type EditContextMenuParams = Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags' | 'linkURL'>

export interface EditContextMenuActions {
  copyLink(url: string): void
}

// Chromium 在不能用的场景下会把对应 editFlags 置 false（比如密码框的复制、剪切），
// 照它置灰即可，不用自己再判断输入框类型。
export function buildEditContextMenuTemplate(params: EditContextMenuParams, actions: EditContextMenuActions): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []
  if (params.isEditable) {
    template.push(
      { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
      { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
      { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: '全选', enabled: params.editFlags.canSelectAll },
    )
  } else if (params.selectionText.trim()) {
    template.push({ role: 'copy', label: '复制', enabled: params.editFlags.canCopy })
  }
  const link = resolveCopyableLink(params.linkURL)
  if (link) {
    if (template.length) template.push({ type: 'separator' })
    template.push({ label: '复制链接', click: () => actions.copyLink(link) })
  }
  return template
}

// 只给 http(s) 链接复制地址。打开链接仍然只能走导航白名单，这里不提供「打开」，
// 免得绕开 will-navigate / setWindowOpenHandler 那层校验。
export function resolveCopyableLink(value: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

export interface EditContextMenuRuntime {
  popup(template: MenuItemConstructorOptions[], contents: WebContents): void
  writeText(text: string): void
}

// 渲染层自己 preventDefault 的右键（比如聊天图片的菜单）不会走到这里。
export function attachEditContextMenu(contents: WebContents, runtime: EditContextMenuRuntime): void {
  contents.on('context-menu', (_event, params) => {
    const template = buildEditContextMenuTemplate(params, { copyLink: (url) => runtime.writeText(url) })
    if (template.length) runtime.popup(template, contents)
  })
}
