import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { AccountPriceList } from '../../../../electron/ipc-contract'
import { forgetSharedImageSettings, writeSharedImageSettings } from '../chat/image-settings'
import { ShotImageDialog, type ShotImageDialogProps } from './ShotImageDialog'

// 只渲染首屏：不会真去读模型、挑参考图。
function unused(): never { throw new Error('not expected during a static render') }

const groups = [{ name: 'default', description: '', ratio: 1, recommended: true }, { name: '图片模型', description: '', ratio: 1, image: true }]
const catalog = [{ model: 'gpt-image-2', groups: ['图片模型'] }, { model: 'gemini-3.1-flash-image', groups: ['图片模型'] }, { model: 'grok-imagine-image', groups: ['default'] }]
const prices: AccountPriceList = { rows: [{ model: 'grok-imagine-image', group: 'default', kind: 'call', perCall: 0.04 }, { model: 'gpt-image-2', group: '图片模型', kind: 'token', input: 10, output: 40 }] }

function studio(image = catalog, patch: Partial<ShotImageDialogProps['studio']> = {}): ShotImageDialogProps['studio'] {
  return { catalogs: { text: [], video: [], image }, groups, site: 'solov', catalogLoading: false, catalogError: '', preparations: {}, refreshModels: unused, pickReferenceImages: unused, ...patch }
}

function render(patch: Partial<ShotImageDialogProps> = {}) {
  return renderToStaticMarkup(<ShotImageDialog index={3} prompt="雨夜街头的橘猫" redrawing={false} settings={{ aspect: '9:16', imageModel: '', imageGroup: '' }} accountScope="solov:7"
    studio={studio()} prices={null} balance={null} onClose={() => undefined} onConfirm={() => undefined} {...patch} />)
}

describe('video studio shot picture dialog', () => {
  afterEach(() => forgetSharedImageSettings())

  it('says which shot the picture is for, that it shares the chat settings, and fills in the shot description', () => {
    const markup = render()
    expect(markup).toContain('为第 4 个镜头生成图片')
    expect(markup).toContain('与对话中的「生成图片」共用同一设置，生成的图片将保存至作品库。')
    expect(markup).not.toContain('生成后将替换此镜头当前的图片')
    expect(markup).toMatch(/<textarea[^>]*data-testid="video-draw-prompt"[^>]*>雨夜街头的橘猫<\/textarea>/)
    expect(markup).toMatch(/<label[^>]*>画面<\/label>/)
    expect(markup).toContain('生成开始后如中途停止，服务端仍可能继续生成并计费。')
    expect(markup).toMatch(/<button(?![^>]*disabled)[^>]*data-testid="video-draw-ok"[^>]*>[^]*?生成图片/)
    expect(markup).toMatch(/data-testid="video-draw-cancel"[^>]*>[^]*?取消/)
    // Drawing over a picture already there says the old one is kept.
    expect(render({ redrawing: true })).toContain('与对话中的「生成图片」共用同一设置，生成的图片将保存至作品库。生成后将替换此镜头当前的图片，原图仍保留在作品库中。')
  })

  it('starts on the default picture model with the size following the frame of the film', () => {
    const tall = render()
    expect(tall).toMatch(/data-model="gpt-image-2" data-group="图片模型"[^>]*data-testid="video-image-model"/)
    expect(tall).toMatch(/data-value="720x1280"[^>]*data-testid="video-draw-size"[^>]*><span>720 × 1280</)
    expect(tall).toMatch(/data-value="low"[^>]*data-testid="video-draw-quality"[^>]*><span>画质：低</)
    expect(tall).toMatch(/data-value="1K"[^>]*data-testid="video-draw-resolution"[^>]*><span>分辨率：1K</)
    expect(render({ settings: { aspect: '16:9', imageModel: '', imageGroup: '' } })).toMatch(/data-value="1280x720"[^>]*data-testid="video-draw-size"/)
    // What this film used before the shared record existed still opens first.
    const film = render({ settings: { aspect: '9:16', imageModel: 'grok-imagine-image', imageGroup: 'default' } })
    expect(film).toMatch(/data-model="grok-imagine-image" data-group="default"[^>]*data-testid="video-image-model"/)
    expect(film).toMatch(/data-value="auto"[^>]*data-testid="video-draw-size"[^>]*><span>自动尺寸</)
    // A model with one resolution and no quality tiers shows neither menu.
    expect(film).not.toContain('data-testid="video-draw-quality"')
    expect(film).not.toContain('data-testid="video-draw-resolution"')
  })

  it('opens on what the chat composer remembered for this account', () => {
    writeSharedImageSettings('solov:7', { model: 'gemini-3.1-flash-image', group: '图片模型', size: '1024x1536', quality: 'auto', imageResolution: '2K' }, null)
    const markup = render({ settings: { aspect: '9:16', imageModel: 'grok-imagine-image', imageGroup: 'default' } })
    expect(markup).toMatch(/data-model="gemini-3.1-flash-image" data-group="图片模型"[^>]*data-testid="video-image-model"/)
    // The remembered size is already upright like the film: kept as it is.
    expect(markup).toMatch(/data-value="1024x1536"[^>]*data-testid="video-draw-size"/)
    expect(markup).toMatch(/data-value="2K"[^>]*data-testid="video-draw-resolution"/)
    // A wide film gets a wide size instead; another account does not see the record at all.
    expect(render({ settings: { aspect: '16:9', imageModel: '', imageGroup: '' } })).toMatch(/data-value="1280x720"[^>]*data-testid="video-draw-size"/)
    expect(render({ accountScope: 'solov:8' })).toMatch(/data-model="gpt-image-2"[^>]*data-testid="video-image-model"/)
  })

  it('quotes a per-call price and the balance when it has them', () => {
    expect(render()).toMatch(/data-testid="video-draw-cost">按实际用量计费。<\/span>/)
    expect(render({ balance: '$12.40' })).toMatch(/data-testid="video-draw-cost">按实际用量计费。当前余额 \$12\.40。<\/span>/)
    // gpt-image-2 is billed by tokens: no estimate.
    expect(render({ prices, balance: '$12.40' })).toMatch(/data-testid="video-draw-cost">按实际用量计费。当前余额 \$12\.40。<\/span>/)
    const perCall = render({ prices, balance: '$12.40', settings: { aspect: '9:16', imageModel: 'grok-imagine-image', imageGroup: 'default' } })
    expect(perCall).toMatch(/data-testid="video-draw-cost">按实际用量计费，预计约 \$0\.04。当前余额 \$12\.40。<\/span>/)
  })

  it('offers reference pictures only on a model that can edit pictures', () => {
    expect(render()).toMatch(/<button title="添加参考图后，将参照该图片生成"(?![^>]*disabled)[^>]*data-testid="video-draw-attach"[^>]*>[^]*?添加参考图/)
    writeSharedImageSettings('solov:7', { model: 'gemini-3.1-flash-image', group: '图片模型', size: '1024x1024', quality: 'auto', imageResolution: '1K' }, null)
    expect(render()).toMatch(/<button title="当前模型不支持图片编辑，请更换支持图片编辑的模型后再添加图片"[^>]*data-testid="video-draw-attach" disabled=""/)
  })

  it('cannot start without a description or a picture model', () => {
    expect(render({ prompt: ' \n ' })).toMatch(/data-testid="video-draw-ok" disabled=""/)
    const empty = render({ studio: studio([]) })
    expect(empty).toMatch(/data-testid="video-draw-ok" disabled=""/)
    expect(empty).toMatch(/data-model="" data-group=""[^>]*data-testid="video-image-model"[^>]*>[^]*?暂无可用模型/)
    expect(empty).not.toContain('data-testid="video-draw-size"')
    expect(render({ studio: studio([], { catalogLoading: true }) })).toMatch(/data-testid="video-image-model"[^>]*>[^]*?正在读取模型/)
  })
})
