import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { workflowExportedNotice, workflowHasVideoOrAudio, workflowSavedNotice } from './workflow-file-notices'
import type { WorkflowNode } from '../model'

function node(id: string, result?: WorkflowNode['data']['result']): WorkflowNode {
  return { id, kind: 'image-input', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle', ...(result ? { result } : {}) } }
}

describe('workflow save and export notices', () => {
  it('tells a desktop customer the local assets went into the file, as the v2 editor did', () => {
    expect(workflowSavedNotice('desktop')).toBe('工作流已保存')
    expect(workflowExportedNotice('desktop')).toBe('项目和本地素材已导出')
  })

  // 桌面 #1368 第 14 条：桌面的项目包只带图片，有视频、音频时原来那句「项目和本地素材已导出」说多了。
  it('says on the desktop that videos and audio stayed behind when the workflow has them', () => {
    expect(workflowSavedNotice('desktop', true)).toBe('工作流已保存；视频、音频不在文件里，换电脑打开前先在素材库另存出来')
    expect(workflowExportedNotice('desktop', true)).toBe('项目和图片已导出；视频、音频不在文件里，换电脑打开前先在素材库另存出来')
  })

  it('keeps the browser download wording everywhere else', () => {
    for (const host of ['web', 'embed'] as const) {
      for (const media of [false, true]) {
        expect(workflowSavedNotice(host, media)).toBe('已请求浏览器下载工作流；素材文件需在素材库单独下载')
        expect(workflowExportedNotice(host, media)).toBe('工作流已导出；素材文件需在素材库单独下载')
      }
    }
  })

  it('counts a node whose result is a saved video or audio, not images or empty slots', () => {
    const image = node('image', { kind: 'image', assetId: 'A'.repeat(43), localUrl: `xingmang-asset://image/${'A'.repeat(43)}` })
    expect(workflowHasVideoOrAudio({ nodes: [] })).toBe(false)
    expect(workflowHasVideoOrAudio({ nodes: [image, node('blank')] })).toBe(false)
    expect(workflowHasVideoOrAudio({ nodes: [image, node('pending-video', { kind: 'video' })] })).toBe(false)
    expect(workflowHasVideoOrAudio({ nodes: [image, node('video', { kind: 'video', assetId: 'V'.repeat(43) })] })).toBe(true)
    expect(workflowHasVideoOrAudio({ nodes: [node('audio', { kind: 'audio', assetId: 'S'.repeat(43) })] })).toBe(true)
  })

  it('is what the editor shows after saving and exporting', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('if (result) setBanner(workflowSavedNotice(canvasCapabilities().host, workflowHasVideoOrAudio(workflow)))')
    expect(app).toContain('if (result) setBanner(workflowExportedNotice(canvasCapabilities().host, workflowHasVideoOrAudio(workflow)))')
  })
})

// 同一条：素材卡片和节点上的「素材操作菜单」打不开时（素材已删、换了账号），宿主报的原因原来没人接，点了没反应。
describe('asset menu failures', () => {
  it('reach the banner from every place that opens the menu', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain("void hostBridge().showAssetMenu(assetId).catch((cause) => setBanner(cause instanceof Error && cause.message ? cause.message : '素材菜单没打开，请稍后再试'))")
    // The helper above is the only direct call; every other place goes through it.
    expect(app.match(/hostBridge\(\)\.showAssetMenu\(/g)).toHaveLength(1)
    expect(app).toContain('onShowAssetMenu: showNodeAssetMenu,')
    expect(app).toContain('onShowCandidateMenu: showAssetMenu,')
    expect(app.match(/onAssetMenu=\{showAssetMenu\}/g)?.length).toBeGreaterThanOrEqual(4)
  })
})
