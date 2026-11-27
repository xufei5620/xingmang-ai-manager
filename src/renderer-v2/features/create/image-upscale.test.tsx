import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AI_CHAT_LIMITS } from '../../../../electron/ai-chat-protocol'
import { ImageUpscaleMenu, imageUpscaleErrorMessage, imageUpscalePrompt, imageUpscaleWording } from './image-upscale'

function nothing() { /* a static render never calls back */ }

describe('image upscale menu', () => {
  it('uses the wording of section 26 of the image plan, word for word', () => {
    // yoyo 2026-11-27 回「本机变清晰」同意的就是这几句；改一个字都要重新问。
    expect(imageUpscaleWording).toEqual({
      menu: '变清晰',
      twice: '放大 2 倍',
      fourTimes: '放大 4 倍',
      working: '正在提升清晰度…',
      done: '已另存为清晰版，原图保持不变。',
      note: '小字或标识放大后可能变形，用于商品页面前请核对。',
    })
  })

  it('shows the menu button, and the working words on a button that cannot be pressed while that picture is upscaled', () => {
    const idle = renderToStaticMarkup(<ImageUpscaleMenu assetId="a" control={{ busy: new Set(['b']), run: nothing }} testId="t" />)
    expect(idle).toMatch(/data-testid="t-button"[^>]*><svg[^]*?<span>变清晰<\/span>/)
    expect(idle).not.toContain('disabled')
    const working = renderToStaticMarkup(<ImageUpscaleMenu assetId="a" compact control={{ busy: new Set(['a']), run: nothing }} testId="t" />)
    expect(working).toContain('xm-btn-xs')
    expect(working).toContain('disabled=""')
    expect(working).toContain('<span>正在提升清晰度…</span>')
  })

  it('puts the main process words on screen, and its failure sentence in place of anything not in Chinese', () => {
    // electron/image-upscale-service.ts 的 imageUpscaleMessages：主进程那边的测试钉着原话，这里只看是不是原样上屏。
    expect(imageUpscaleErrorMessage(new Error("Error invoking remote method 'chat:upscale-asset': Error: 该图片放大 4 倍后超出尺寸上限，请改用放大 2 倍。"))).toBe('该图片放大 4 倍后超出尺寸上限，请改用放大 2 倍。')
    expect(imageUpscaleErrorMessage(new Error('账号刚刚切换，请重试'))).toBe('账号刚刚切换，请重试')
    expect(imageUpscaleErrorMessage(new Error("Error invoking remote method 'chat:upscale-asset': Error: worker exited"))).toBe('提升清晰度失败，请稍后重试；如持续失败，请联系客服。')
  })

  it('carries the original description, trimmed to what the channel accepts, and nothing when there is none', () => {
    expect(imageUpscalePrompt('  一只猫  ')).toBe('一只猫')
    expect(imageUpscalePrompt('   ')).toBeUndefined()
    expect(imageUpscalePrompt(undefined)).toBeUndefined()
    expect(imageUpscalePrompt('猫'.repeat(AI_CHAT_LIMITS.promptLength + 5))).toHaveLength(AI_CHAT_LIMITS.promptLength)
  })
})
