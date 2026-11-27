import { describe, expect, it } from 'vitest'
import { newCanvasErrorMessage, newCanvasFailureMessage, newCanvasNotOpenedMessage } from './new-canvas'

describe('new canvas messages', () => {
  it('shows what the main process said when it said it in Chinese', () => {
    const said = '无法在「星芒画布」文件夹中新建项目（没有写入权限）。请打开画布，在「项目中心」中新建。'
    expect(newCanvasErrorMessage(new Error(`Error invoking remote method 'canvas:create-project': Error: ${said}`))).toBe(said)
    expect(newCanvasErrorMessage(new Error('画布项目数量已达上限，请先归档或删除不需要的项目'))).toBe('画布项目数量已达上限，请先归档或删除不需要的项目')
  })

  it('replaces a system error, and nothing at all, with the fallback in the same words', () => {
    expect(newCanvasErrorMessage(new Error("EPERM: operation not permitted, mkdir 'C:\\Users\\yoyo\\Documents\\星芒画布'"))).toBe(newCanvasFailureMessage)
    expect(newCanvasErrorMessage(undefined)).toBe(newCanvasFailureMessage)
    expect(newCanvasFailureMessage).toBe('无法在「星芒画布」文件夹中新建项目（无法创建文件夹）。请打开画布，在「项目中心」中新建。')
  })

  it('tells where the project went when the canvas window kept its own project open', () => {
    expect(newCanvasNotOpenedMessage('未命名画布 11 月 27 日 14:30')).toBe('已新建「未命名画布 11 月 27 日 14:30」，可稍后在左侧列表中打开。')
  })
})
