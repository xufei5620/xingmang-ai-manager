import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { workflowExportedNotice, workflowSavedNotice } from './workflow-file-notices'

describe('workflow save and export notices', () => {
  it('tells a desktop customer the local assets went into the file, as the v2 editor did', () => {
    expect(workflowSavedNotice('desktop')).toBe('工作流已保存')
    expect(workflowExportedNotice('desktop')).toBe('项目和本地素材已导出')
  })

  it('keeps the browser download wording everywhere else', () => {
    for (const host of ['web', 'embed'] as const) {
      expect(workflowSavedNotice(host)).toBe('已请求浏览器下载工作流；素材文件需在素材库单独下载')
      expect(workflowExportedNotice(host)).toBe('工作流已导出；素材文件需在素材库单独下载')
    }
  })

  it('is what the editor shows after saving and exporting', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('if (result) setBanner(workflowSavedNotice(canvasCapabilities().host))')
    expect(app).toContain('if (result) setBanner(workflowExportedNotice(canvasCapabilities().host))')
  })
})
