import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { missingAiAssetMessages } from '../../../../electron/ai-asset-missing'
import {
  AddToCanvasMenu, canvasIntakeDoneMessage, canvasIntakeErrorMessage, canvasIntakeFailureMessage, canvasIntakeProjectName, canvasIntakeProjects, canvasIntakeRequest,
  sameCanvasIntakeProjects, unnamedCanvasProjectName,
} from './canvas-intake'

const assetId = 'a'.repeat(43)
const projectId = '11111111-1111-4111-8111-111111111111'
function nothing() { /* a static render never calls back */ }

describe('the name a new canvas project gets from a picture', () => {
  it('is the first twenty characters of the description on one line', () => {
    expect(canvasIntakeProjectName('一只橘猫坐在窗台上')).toBe('一只橘猫坐在窗台上')
    expect(canvasIntakeProjectName('  帮我画一张双十一主图，\n橙色渐变背景，中间放产品，右下角留出价格的位置  ')).toBe('帮我画一张双十一主图， 橙色渐变背景，中')
    // 正好切在标点上：名字不以逗号、句号收尾。
    expect(canvasIntakeProjectName('一只橘猫坐在窗台上，午后阳光，水彩风格，暖色调的光')).toBe('一只橘猫坐在窗台上，午后阳光，水彩风格')
    expect(canvasIntakeProjectName('海边日落。')).toBe('海边日落')
    // 一个表情算一个字，不会从中间切开。
    expect(canvasIntakeProjectName('🐱'.repeat(30))).toBe('🐱'.repeat(20))
    expect(canvasIntakeProjectName('a\u0000b\u007fc')).toBe('a b c')
  })

  it('falls back to a plain name when there is no description', () => {
    for (const description of ['', '   ', '\n\t', '\u0000', '，。！']) expect(canvasIntakeProjectName(description)).toBe(unnamedCanvasProjectName)
    expect(unnamedCanvasProjectName).toBe('未命名项目')
  })
})

describe('what the page hands the main process', () => {
  it('names one picture and either the chosen project or the name of a new one, nothing else', () => {
    expect(canvasIntakeRequest(projectId, assetId, '一只橘猫')).toEqual({ assetId, projectId })
    expect(canvasIntakeRequest(null, assetId, '一只橘猫')).toEqual({ assetId, newProjectName: '一只橘猫' })
    expect(canvasIntakeRequest(null, assetId, '')).toEqual({ assetId, newProjectName: '未命名项目' })
  })
})

describe('the projects the menu lists', () => {
  const now = new Date(2026, 10, 22, 12, 0).getTime()

  it('keeps the order it was given and says when each was last changed', () => {
    const listed = canvasIntakeProjects([
      { id: 'p1', name: '双 11 主图', updatedAt: new Date(2026, 10, 22, 10, 0).getTime() },
      { id: 'p2', name: '门店海报', updatedAt: 0 },
    ], now)
    expect(listed).toEqual([{ id: 'p1', title: '双 11 主图', detail: '今天 10:00 修改' }, { id: 'p2', title: '门店海报', detail: '' }])
  })

  it('counts two lists with the same projects, names and times as the same list', () => {
    const one = [{ id: 'p1', title: '双 11 主图', detail: '今天 10:00 修改' }]
    expect(sameCanvasIntakeProjects(one, [{ ...one[0] }])).toBe(true)
    expect(sameCanvasIntakeProjects(one, [{ ...one[0], title: '改过名' }])).toBe(false)
    expect(sameCanvasIntakeProjects(one, [{ ...one[0], detail: '今天 10:05 修改' }])).toBe(false)
    expect(sameCanvasIntakeProjects(one, [])).toBe(false)
    expect(sameCanvasIntakeProjects(one, [...one, { id: 'p2', title: '门店海报', detail: '' }])).toBe(false)
  })
})

describe('what the page says afterwards', () => {
  it('names the project, and says so when the project is new', () => {
    expect(canvasIntakeDoneMessage({ projectName: '双 11 主图', created: false })).toBe('已添加到画布项目「双 11 主图」的素材库')
    expect(canvasIntakeDoneMessage({ projectName: '一只橘猫', created: true })).toBe('已新建画布项目「一只橘猫」，并将此图添加到其素材库')
  })

  it('shows what the main process said in Chinese without the IPC prefix, and a plain sentence for anything else', () => {
    expect(canvasIntakeErrorMessage(new Error("Error invoking remote method 'canvas:add-project-image': Error: 未找到该画布项目，可能已归档或删除。"))).toBe('未找到该画布项目，可能已归档或删除。')
    expect(canvasIntakeErrorMessage(new Error('该画布项目的工作文件夹当前无法访问，图片未添加。'))).toBe('该画布项目的工作文件夹当前无法访问，图片未添加。')
    expect(canvasIntakeErrorMessage(new Error(`Error invoking remote method 'canvas:add-project-image': Error: ${missingAiAssetMessages.image}`))).toBe(missingAiAssetMessages.image)
    for (const reason of [new Error("EPERM: operation not permitted, open 'C:\\Users\\yoyo\\Documents\\a.png'"), new Error(''), undefined, 'ENOSPC']) {
      expect(canvasIntakeErrorMessage(reason)).toBe(canvasIntakeFailureMessage)
    }
    expect(canvasIntakeFailureMessage).toBe('添加失败，请稍后重试。')
  })
})

describe('the add-to-canvas button', () => {
  it('is one button named in formal words, with a tip that says where the picture goes', () => {
    const html = renderToStaticMarkup(<AddToCanvasMenu projects={[{ id: projectId, title: '双 11 主图', detail: '今天 10:00 修改' }]} onPick={nothing} testId="add" />)
    expect(html).toMatch(/<button[^>]*data-testid="add"[^>]*>[^]*?添加到画布/)
    expect(html).toContain('title="将此图添加到画布项目的素材库"')
    expect(html).toContain('aria-haspopup="menu"')
    // 菜单点开才画：收着的时候页面上没有项目名。
    expect(html).not.toContain('双 11 主图')
    expect(html).not.toContain('放进画布')
  })
})
