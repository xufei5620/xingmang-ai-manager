import { useState } from 'react'
import { ChevronDown, Image as ImageIcon, ImagePlus, RefreshCw, X } from 'lucide-react'
import type { ImageModelCapability } from '../../../../electron/ai-chat-protocol'
import type { AccountPriceList, AiChatAsset } from '../../../../electron/ipc-contract'
import { videoStudioPlanLimits } from '../../../../electron/video-studio-plan'
import { BrandIcon, Button, ChoiceMenu, Dialog, Textarea } from '../../ui'
import { useLatestRequest } from '../../latest-request'
import { canEditImages, chatLimits, inspectModel, noImageEditModelMessage } from '../chat/api'
import { ChatImage } from '../chat/ChatImage'
import { ImageOptionMenus } from '../chat/ImageOptions'
import { fitImageOptions, readSharedImageSettings, writeSharedImageSettings, type ImageOptionValues } from '../chat/image-settings'
import { chatModelVendor, chatModelVendors, customImageSizeRule, pickChatGroup, type ChatCatalogEntry } from '../chat/state'
import { videoStudioImageModelChoice, videoStudioImageOptions, videoStudioImageSettingsToShare, videoStudioPlainText, type VideoStudioImageDraft, type VideoStudioSettings } from './project'
import { videoStudioPerCallUsd, videoStudioQuoteText } from './prices'
import { videoStudioErrorMessage, type VideoStudioController } from './useVideoStudio'

export interface ShotImageDialogProps {
  /** 第几个镜头，从 0 数。 */
  index: number
  /** 这一镜的画面描述：框里先填上它。在框里改的只管这一张图，不写回镜头。 */
  prompt: string
  /** 这一镜已经有图：生成好以后换掉它。 */
  redrawing: boolean
  settings: Pick<VideoStudioSettings, 'aspect' | 'imageModel' | 'imageGroup'>
  accountScope: string
  studio: Pick<VideoStudioController, 'catalogs' | 'groups' | 'site' | 'catalogLoading' | 'catalogError' | 'preparations' | 'refreshModels' | 'pickReferenceImages'>
  prices: AccountPriceList | null
  /** 当前余额，已经写成「$12.40」的样子；读不到就不写那半句。 */
  balance: string | null
  onClose(): void
  onConfirm(draft: VideoStudioImageDraft): void
}

function imageCapabilityOf(model: string): ImageModelCapability | null {
  if (!model) return null
  try {
    const capability = inspectModel(model)
    return capability.kind === 'image' ? capability : null
  } catch {
    return null
  }
}

/**
 * 「AI 生成图片」点了以后的出图框（融合第 4 步）。跟对话里「生成图片」那一档是同一个：型号、尺寸、画质、分辨率
 * 用的是同一排（ImageOptionMenus），记的也是同一份（image-settings.ts）；交出去走的是同一条 chat:generate-image，
 * 画好的图进作品库。以前这里是一个只问「画不画」的确认框，型号在「想法」卡的「画镜头图」里选。
 */
export function ShotImageDialog({ index, prompt, redrawing, settings, accountScope, studio, prices, balance, onClose, onConfirm }: ShotImageDialogProps) {
  const catalog = studio.catalogs.image
  const shared = readSharedImageSettings(accountScope)
  const [text, setText] = useState(prompt)
  const [picked, setPicked] = useState<{ model: string, group: string } | null>(null)
  // 客户在这个框里动过的那几样。没动过的跟着记的那一份和这条视频的画面走（videoStudioImageOptions）。
  const [touched, setTouched] = useState<Partial<ImageOptionValues>>({})
  const [customSize, setCustomSize] = useState(false)
  const [sizeRuleShown, setSizeRuleShown] = useState(false)
  const [references, setReferences] = useState<AiChatAsset[]>([])
  const [attaching, setAttaching] = useState(false)
  const [error, setError] = useState('')
  const picking = useLatestRequest()
  // 在框里选的型号还在表里就用它；没选过、或者刷新模型以后它不在了，按记的那一份、这条视频以前选的、默认型号的次序挑。
  const { model, group } = picked && catalog.some((entry) => entry.model === picked.model && entry.groups.includes(picked.group))
    ? picked
    : videoStudioImageModelChoice(shared, settings, catalog, { groups: studio.groups, site: studio.site })
  const capability = imageCapabilityOf(model)
  const values = videoStudioImageOptions(model, settings.aspect, shared, touched)
  const sizeRule = capability ? customImageSizeRule({ mode: 'image', model, size: values.size }) : ''
  const preparing = studio.catalogLoading || Object.values(studio.preparations).some((preparation) => preparation.phase === 'loading')
  const billing = (entry: ChatCatalogEntry) => entry.model === model && entry.groups.includes(group) ? group : pickChatGroup(entry.groups, { current: group, mode: 'image', groups: studio.groups, site: studio.site })
  const selectModel = (value: string) => {
    const entry = catalog.find((item) => item.model === value)
    if (!entry) return
    setPicked({ model: entry.model, group: billing(entry) })
    setCustomSize(false)
    setSizeRuleShown(false)
    // 换了型号：框里改过的尺寸新型号不收就放下，回到按画面挑的那个（同对话里换型号）。
    setTouched(({ size, ...rest }) => size !== undefined && fitImageOptions(entry.model, { ...values, size }).size === size ? { ...rest, size } : rest)
  }
  const vendors = chatModelVendors.map((vendor) => ({ vendor, entries: catalog.filter((entry) => chatModelVendor(entry.model) === vendor) })).filter((section) => section.entries.length > 0)
  const sections = vendors.length
    ? vendors.map(({ vendor, entries }) => ({ label: vendor, value: model, options: entries.map((entry) => ({ value: entry.model, label: entry.model, hint: `${billing(entry)}分组` })), onChange: selectModel }))
    : [{ label: '模型', value: '', options: [], empty: preparing ? '正在读取模型' : studio.catalogError || '暂无可用的图片模型', onChange: () => undefined }]

  const canEdit = Boolean(model) && canEditImages(model)
  const room = chatLimits.imagesPerMessage - references.length
  const referencesBlocked = references.length > 0 && !canEdit
  const attach = async () => {
    if (attaching || !canEdit || room <= 0) return
    const current = picking.begin()
    setAttaching(true)
    setError('')
    try {
      const added = await studio.pickReferenceImages(room)
      if (!current()) return
      setReferences((list) => [...list, ...added.filter((asset) => !list.some((item) => item.assetId === asset.assetId))].slice(0, chatLimits.imagesPerMessage))
    } catch (reason) {
      if (current()) setError(videoStudioErrorMessage(reason))
    } finally {
      if (current()) setAttaching(false)
    }
  }
  const attachTitle = !canEdit ? '当前模型不支持图片编辑，请更换支持图片编辑的模型后再添加图片' : room <= 0 ? `最多添加 ${chatLimits.imagesPerMessage} 张参考图` : '添加参考图后，将参照该图片生成'

  const ready = Boolean(model && group && videoStudioPlainText(text)) && !referencesBlocked
  const confirm = () => {
    if (!ready) return
    // 手填的尺寸不合这个型号的规矩：不交，在下面说清规矩（同对话里）。
    if (sizeRule) { setSizeRuleShown(true); return }
    const draft: VideoStudioImageDraft = { prompt: text, model, group, ...values, ...(references.length ? { sourceAssetIds: references.map((asset) => asset.assetId) } : {}) }
    writeSharedImageSettings(accountScope, videoStudioImageSettingsToShare(draft, shared, touched.size !== undefined))
    onConfirm(draft)
  }
  const quote = videoStudioQuoteText(videoStudioPerCallUsd(prices, model, group), 1, false)
  const showSizeRule = Boolean(sizeRule) && (sizeRuleShown || !customSize)

  return <Dialog open width={640} title={`为第 ${index + 1} 个镜头生成图片`} onClose={onClose} testId="video-draw-dialog"
    subtitle={`与对话中的「生成图片」共用同一设置，生成的图片将保存至作品库。${redrawing ? '生成后将替换此镜头当前的图片，原图仍保留在作品库中。' : ''}`}
    footer={<>
      <span className="v2-dialog-footer-start video-studio-draw-cost" data-testid="video-draw-cost">按实际用量计费{quote ? `，${quote}` : ''}。{balance ? `当前余额 ${balance}。` : ''}</span>
      <Button onClick={onClose} testId="video-draw-cancel">取消</Button>
      <Button variant="primary" icon={ImageIcon} disabled={!ready} onClick={confirm} testId="video-draw-ok">生成图片</Button>
    </>}>
    <div className="video-studio-draw">
      <Textarea label="画面" value={text} rows={4} maxLength={videoStudioPlanLimits.maximumPromptLength} onChange={(event) => setText(event.target.value)} testId="video-draw-prompt" />
      {references.length > 0 && <div className="video-studio-draw-references" data-testid="video-draw-references">
        {references.map((asset) => <div className="video-studio-draw-reference" key={asset.assetId}>
          <ChatImage asset={asset} alt="参考图" />
          <Button size="xs" variant="ghost" icon={X} aria-label="移除此参考图" title="移除此参考图" onClick={() => setReferences((list) => list.filter((item) => item.assetId !== asset.assetId))} testId="video-draw-reference-remove" />
        </div>)}
      </div>}
      <div className="video-studio-draw-options">
        <span className="video-studio-model">
          <ChoiceMenu label="模型" align="start" testId="video-image-model-menu"
            anchor={<Button variant="ghost" size="sm" iconRight={ChevronDown} title={[group, model].filter(Boolean).join(' · ') || undefined} data-model={model} data-group={group} testId="video-image-model"><span aria-hidden="true"><BrandIcon model={model} size={16} /></span><span className="video-studio-model-name">{model || (preparing ? '正在读取模型' : '暂无可用模型')}</span></Button>}
            sections={sections} actions={[{ label: '刷新模型', icon: RefreshCw, loading: preparing, keepOpen: true, onSelect: () => void studio.refreshModels(), testId: 'video-image-model-refresh' }]} />
        </span>
        {capability && <ImageOptionMenus capability={capability} values={values} customSize={customSize} onCustomSize={setCustomSize} testIdPrefix="video-draw"
          onChange={(patch) => setTouched((current) => ({ ...current, ...patch }))} onLeaveCustomSize={() => setSizeRuleShown(true)} sizeRuleId={showSizeRule ? 'videoDrawSizeRule' : undefined} />}
        <Button variant="ghost" size="sm" icon={ImagePlus} title={attachTitle} loading={attaching} disabled={!canEdit || room <= 0} onClick={() => void attach()} testId="video-draw-attach">添加参考图</Button>
      </div>
      {showSizeRule && <p className="video-studio-shot-error" id="videoDrawSizeRule" role="status" data-testid="video-draw-size-rule">{sizeRule}</p>}
      {referencesBlocked && <p className="video-studio-shot-error" role="alert" data-testid="video-draw-references-blocked">{noImageEditModelMessage}</p>}
      {error && <p className="video-studio-shot-error" role="alert" data-testid="video-draw-error">{error}</p>}
      <p className="video-studio-hint">生成开始后如中途停止，服务端仍可能继续生成并计费。</p>
    </div>
  </Dialog>
}
