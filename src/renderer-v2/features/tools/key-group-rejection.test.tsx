import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isKeyGroupRejection, KeyGroupRejectedNotice, keyGroupRejectedText, modelCheckFailure } from './key-group-rejection'

const rejected = new Error("Error invoking remote method 'account:list-key-models': Error: 模型查询失败，服务返回 403：无权访问 Claude-ANTI 分组 (request id: 20261119133735330170236)")

describe('key group rejection notice', () => {
  it('turns a group rejection from the model check into its own failure and leaves other failures as one sentence', () => {
    const failure = modelCheckFailure(rejected)
    expect(isKeyGroupRejection(failure)).toBe(true)
    expect(isKeyGroupRejection(failure) && failure.detail).toContain('无权访问 Claude-ANTI 分组')
    expect(modelCheckFailure(new Error('模型查询失败，服务返回 401：无效的令牌'))).toEqual(expect.any(String))
    expect(isKeyGroupRejection(modelCheckFailure(new Error('当前账号不可使用分组「vip」'), '模型检测未完成'))).toBe(false)
    expect(isKeyGroupRejection('无权访问')).toBe(false)
  })

  it('says it in plain words with the switch button and keeps the server words behind the details', () => {
    const failure = { groupRejected: true as const, detail: '模型查询失败，服务返回 403：无权访问 Claude-ANTI 分组 (request id: 1)' }
    const markup = renderToStaticMarkup(<KeyGroupRejectedNotice failure={failure} onSwitch={() => undefined} stuckText="去换一把" testId="notice" switchTestId="notice-switch" />)
    const lead = markup.slice(0, markup.indexOf('<details'))
    expect(lead).toContain(keyGroupRejectedText)
    expect(lead).toContain('换一把能用的')
    expect(lead).toContain('notice-switch')
    expect(lead).not.toMatch(/403|Claude-ANTI|request id/)
    expect(markup).toContain('<summary>查看详情</summary>')
    expect(markup).toContain('request id: 1')
  })

  it('drops the button and says where to switch when nothing usable is left', () => {
    const failure = { groupRejected: true as const, detail: '' }
    const stuck = renderToStaticMarkup(<KeyGroupRejectedNotice failure={failure} stuckText="去换一把" testId="notice" switchTestId="notice-switch" />)
    expect(stuck).toContain('去换一把')
    expect(stuck).not.toContain('notice-switch')
    expect(stuck).not.toContain('查看详情')
    const plain = renderToStaticMarkup(<KeyGroupRejectedNotice failure={failure} testId="notice" switchTestId="notice-switch" />)
    expect(plain).toContain(keyGroupRejectedText)
  })
})
