import { describe, expect, it } from 'vitest'
import {
  buildVideoStudioPlanMessages,
  parseVideoStudioPlanJson,
  videoStudioPlanLimits,
  videoStudioPlanUnreadableMessage,
  type VideoStudioPlanRequest,
} from './video-studio-plan'

const request: VideoStudioPlanRequest = { idea: '  一只橘猫在雨夜的东京找回家的路\n', shotCount: 3, secondsPerShot: 6, aspect: '9:16', captions: true }

describe('video studio storyboard plan', () => {
  it('tells the model the shot count, length, framing and to repeat the look in every shot', () => {
    const { system, user } = buildVideoStudioPlanMessages(request)
    expect(user).toBe('一只橘猫在雨夜的东京找回家的路')
    expect(system).toContain('shots 正好 3 个')
    expect(system).toContain('竖屏 9:16')
    expect(system).toContain('每个镜头 6 秒')
    expect(system).toContain('每一个 prompt 里完整重复写')
    expect(system).toContain('15 个字以内')
    expect(buildVideoStudioPlanMessages({ ...request, captions: false, aspect: '16:9' }).system)
      .toContain('caption 一律写空字符串')
    expect(buildVideoStudioPlanMessages({ ...request, aspect: '1:1' }).system).toContain('方形 1:1')
  })

  it('reads a fenced answer, keeps the requested number of shots and cleans control characters', () => {
    const answer = [
      '好的，分镜如下：',
      '```json',
      JSON.stringify({
        title: '回家\n的猫',
        shots: [
          { prompt: '雨夜东京街头，\t一只橘猫\n抬头看霓虹', caption: '下雨了' },
          { prompt: '橘猫穿过人群', caption: '' },
          { prompt: '橘猫跳上台阶', caption: '找到了' },
          { prompt: '多出来的第四镜', caption: '多余' },
        ],
      }),
      '```',
    ].join('\n')
    expect(parseVideoStudioPlanJson(answer, request)).toEqual({
      title: '回家 的猫',
      shots: [
        { prompt: '雨夜东京街头， 一只橘猫 抬头看霓虹', caption: '下雨了' },
        { prompt: '橘猫穿过人群' },
        { prompt: '橘猫跳上台阶', caption: '找到了' },
      ],
    })
  })

  it('accepts fewer shots than asked, drops captions when they are off and falls back to the idea for a title', () => {
    const answer = '{"shots":[{"prompt":"橘猫在雨里","caption":"别写"}]}'
    expect(parseVideoStudioPlanJson(answer, { ...request, captions: false })).toEqual({
      title: '一只橘猫在雨夜的东京找回',
      shots: [{ prompt: '橘猫在雨里' }],
    })
  })

  it('cuts overlong prompts, captions and titles to their limits', () => {
    const answer = JSON.stringify({
      title: '题'.repeat(100),
      shots: [{ prompt: '画'.repeat(2_000), caption: '字'.repeat(100) }],
    })
    const plan = parseVideoStudioPlanJson(answer, request)
    expect(plan.title).toHaveLength(videoStudioPlanLimits.maximumTitleLength)
    expect(plan.shots[0].prompt).toHaveLength(videoStudioPlanLimits.maximumPromptLength)
    expect(plan.shots[0].caption).toHaveLength(videoStudioPlanLimits.maximumCaptionLength)
  })

  it('answers with one sentence for every unreadable reply', () => {
    for (const answer of [
      '我没法写',
      '{"shots": [',
      '{"title":"x"}',
      '{"shots":[]}',
      '{"shots":["橘猫"]}',
      '{"shots":[{"prompt":"  \\n "}]}',
      '{"shots":[{"prompt":42}]}',
    ]) {
      expect(() => parseVideoStudioPlanJson(answer, request), answer).toThrow(videoStudioPlanUnreadableMessage)
    }
  })
})
