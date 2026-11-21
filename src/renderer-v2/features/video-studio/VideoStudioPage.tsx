import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Brush, ChevronDown, Clapperboard, Download, Film, FolderOpen, ImagePlus, Images, Music, Play, Plus, RefreshCw, Sparkles, Square, Trash2, Wand2, X } from 'lucide-react'
import { videoStudioPlanLimits } from '../../../../electron/video-studio-plan'
import { BrandIcon, Button, Card, ChoiceMenu, Confirm, Empty, Input, Notice, Pill, Progress, Select, Switch, Textarea } from '../../ui'
import { dollars } from '../../business-common'
import { useSharedBalanceSelector } from '../app/balance-context'
import { chatModelVendor, chatModelVendors, pickChatGroup, type ChatCatalogEntry, type ChatSite } from '../chat/state'
import { isVideoStudioCaptionPosition, isVideoStudioCaptionSize, videoStudioCaptionPositions, videoStudioCaptionSizes } from './captions'
import {
  canAddVideoStudioShot,
  isVideoStudioShotBusy,
  isVideoStudioShotDrawing,
  videoStudioAspectNames,
  videoStudioCaptionPositionNames,
  videoStudioCaptionSizeNames,
  videoStudioClipSoundNames,
  videoStudioClipSounds,
  videoStudioCommonSeconds,
  videoStudioFitNames,
  videoStudioReadyToCompose,
  videoStudioSecondsChoices,
  videoStudioShotCounts,
  videoStudioShotSeconds,
  videoStudioTransitionNames,
  videoStudioTotalSeconds,
  videoStudioTrimOptions,
  videoStudioUnconfirmedIndexes,
  videoStudioUnconfirmedWarning,
  type VideoStudioClipSource,
  type VideoStudioShot,
  type VideoStudioTrimSide,
} from './project'
import { useVideoStudioPriceList, videoStudioPerCallUsd, videoStudioQuoteText, type VideoStudioPriceBridge } from './prices'
import { formatVideoStudioDuration, isVideoStudioAspect, isVideoStudioFit, isVideoStudioResolution, isVideoStudioTransition, videoStudioAspects, videoStudioFits, videoStudioResolutions, videoStudioTransitions } from './timeline'
import { ShotImageDialog } from './ShotImageDialog'
import { useVideoStudio, type VideoStudioBridge, type VideoStudioController, type VideoStudioOptions } from './useVideoStudio'
import type { VideoStudioSource } from './useVideoStudioLibrary'
import './video-studio.css'

/** suspended：状态文件关掉了视频剪辑（remote-features.ts），工程照样留在本机。 */
export type VideoStudioAccess = 'ready' | 'guest' | 'unsupported' | 'suspended'

export interface VideoStudioPageProps {
  bridge: VideoStudioBridge & VideoStudioPriceBridge
  accountScope: string
  site: ChatSite
  access: VideoStudioAccess
  active?: boolean
  onLogin?: () => void
  onOpenAccount?: (tab: 'recharge' | 'keys') => void
  /** 开着的是哪一条视频：从哪读、改了存到哪（useVideoStudioLibrary 的 source）。换一条视频时外面按编号换 key，这里重新挂。 */
  source: VideoStudioSource
  /** 这一条手上有没有事在做（写分镜、出片、画图、拼片）。外面据此决定能不能换别的视频、能不能删它；卸掉时报一次 false。 */
  onBusyChange?: (busy: boolean) => void
  /** 「创作」页给的作品库选择框（融合第 3 步）。单独摆着的工作台不给，镜头上那两个按钮就不出现。 */
  library?: VideoStudioLibraryPicker
  /** 测试用：换掉拼片那一样。 */
  options?: VideoStudioOptions
}

/** 从作品库里选东西：一张图的编号，或者一段现成的片段；关掉没选是 null。 */
export interface VideoStudioLibraryPicker {
  pickImage(): Promise<string | null>
  pickClip(): Promise<VideoStudioClipSource | null>
}

type Confirmation = { kind: 'generate', ids: string[] } | { kind: 'plan' } | { kind: 'remove', id: string }

/**
 * 一条视频的工作台：「想法」「分镜」「拼成一条视频」三张卡。它放在「创作」页右边（融合第 1 步），这条视频的名字、
 * 「重命名」「删除此视频」在外面那一条顶栏上，这里不再有整页的大标题、「新建一条」「重新开始」和草稿箱：
 * 每一条视频都是左边那一列里的一行。
 */
export function VideoStudioPage({ bridge, accountScope, site, access, active = true, onLogin, onOpenAccount, source, onBusyChange, library, options }: VideoStudioPageProps) {
  if (access !== 'ready') {
    return <section className="v2-page video-studio" data-page-id="video" data-testid="page-video">
      {access === 'guest'
        ? <Empty icon={Clapperboard} title="登录后可用" description="生成视频将使用星芒账号的额度，请先登录。" action={onLogin && <Button variant="primary" onClick={onLogin} testId="video-login">登录</Button>} testId="video-guest" />
        : access === 'suspended'
          // yoyo 2026-10-28 批的字（「停用改」）。
          ? <Empty icon={Clapperboard} title="视频剪辑暂时停用" description="您的工程均已保留，修复后将自动恢复。" testId="video-suspended" />
          : <Empty icon={Clapperboard} title="当前账号无法使用视频剪辑" description="视频剪辑需使用星芒账号中的视频模型，历史账号不支持。请使用星芒账号登录后使用。" testId="video-unsupported" />}
    </section>
  }
  return <VideoStudioWorkspace bridge={bridge} accountScope={accountScope} site={site} active={active} onOpenAccount={onOpenAccount} source={source} onBusyChange={onBusyChange} library={library} options={options} />
}

function VideoStudioWorkspace({ bridge, accountScope, site, active, onOpenAccount, source, onBusyChange, library, options }: Omit<VideoStudioPageProps, 'access' | 'onLogin'> & { active: boolean }) {
  const studio = useVideoStudio(bridge, source, site, true, options)
  useEffect(() => { onBusyChange?.(studio.busy) }, [studio.busy])
  useEffect(() => () => onBusyChange?.(false), [])
  // 确认框「每段单独计费」后面报一句当前余额（yoyo 2026-10-29 批的字「余额改」，#1406 P2-1）。读不到就不写这句，
  // 同充值页卡头。
  // 只挑余额本身：转圈、更新时间这些每次刷新都变，订阅整份会让这一页去过以后藏着也跟着重画（R8）。
  const balance = useSharedBalanceSelector((state) => state.scope === accountScope ? state.balance : null)
  // 余额前面再报「预计约 $x」（#1406 P2-1 后半）：页面一露面就读好价目，确认框打开时已经在手上；放久了打开确认框时再读一次。
  const prices = useVideoStudioPriceList(bridge, accountScope, active)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  // 「让 AI 画一张」点的是哪个镜头：出图框开着时是它的编号（融合第 4 步）。镜头被删了，框跟着关。
  const [drawTarget, setDrawTarget] = useState<string | null>(null)
  const { project } = studio
  const { settings, shots, exported } = project
  const generating = shots.some(isVideoStudioShotBusy)
  const drawing = shots.some(isVideoStudioShotDrawing)
  const composing = studio.composeState.phase !== 'idle'
  const missing = shots.filter((shot) => !shot.clip).length
  const quotaAction = /余额|额度/.test(studio.error) && onOpenAccount
  const folderAction = /AI 作品文件夹/.test(studio.notice)
  const confirmGenerate = (ids: string[]) => { prices.refresh(); setConfirmation({ kind: 'generate', ids }) }
  const openDraw = (id: string) => { prices.refresh(); setDrawTarget(id) }
  const runConfirmation = () => {
    const current = confirmation
    setConfirmation(null)
    if (!current) return
    if (current.kind === 'generate') studio.generate(current.ids)
    if (current.kind === 'plan') void studio.writePlan()
    if (current.kind === 'remove') studio.removeShot(current.id)
  }
  const writePlan = () => { if (shots.some((shot) => shot.clip)) setConfirmation({ kind: 'plan' }); else void studio.writePlan() }
  const confirmCount = confirmation?.kind === 'generate' ? confirmation.ids.length : 0
  const regenerating = confirmation?.kind === 'generate' && confirmation.ids.some((id) => shots.find((shot) => shot.id === id)?.clip)
  // 上次提交没收到答复的那几段：钱可能已经扣了，再生成可能多扣一次，确认框要另外说清（#1489 N2）。
  const unconfirmed = confirmation?.kind === 'generate' ? videoStudioUnconfirmedIndexes(project, confirmation.ids) : []
  // 各镜单独定了时长、长短不一时，分镜卡和确认框不说「每段 S 秒」，改说一共多少秒。
  const commonSeconds = videoStudioCommonSeconds(project)
  const confirmShots = confirmation?.kind === 'generate' ? shots.filter((shot) => confirmation.ids.includes(shot.id)) : []
  const confirmSeconds = confirmShots.length ? videoStudioCommonSeconds(project, confirmShots) : null
  const drawIndex = drawTarget ? shots.findIndex((shot) => shot.id === drawTarget) : -1
  const drawShot = drawIndex >= 0 ? shots[drawIndex] : null
  // 按这次要用的模型和分组报价，一段一次；视频站点还可能按时长、尺寸调，标「估算」（同画布）。没有按次的价就不写。
  const quote = confirmation?.kind === 'generate' ? videoStudioQuoteText(videoStudioPerCallUsd(prices.list, settings.videoModel, settings.videoGroup), confirmCount, true) : null

  return <section className="v2-page video-studio" data-page-id="video" data-testid="page-video">
    {studio.error && <Notice tone="bad" title="未完成" body={studio.error} onDismiss={() => studio.setError('')}
      actions={quotaAction ? <Button size="sm" variant="primary" onClick={() => onOpenAccount?.(/额度上限/.test(studio.error) ? 'keys' : 'recharge')}>{/额度上限/.test(studio.error) ? '去调额度' : '前往充值'}</Button> : undefined} testId="video-error" />}
    {studio.notice && <Notice tone="accent" title="提示" body={studio.notice} onDismiss={() => studio.setNotice('')}
      actions={folderAction ? <Button size="sm" icon={FolderOpen} onClick={() => void studio.openFolder()} testId="video-notice-folder">打开文件夹</Button> : undefined} testId="video-notice" />}
    {studio.storageWarning && <Notice tone="warn" title="无法保存此分镜" body={studio.storageWarning} testId="video-storage-warning" />}

    <Card title="想法" testId="video-idea">
      <div className="video-studio-idea">
        <Textarea label="想拍什么" value={settings.idea} maxLength={videoStudioPlanLimits.maximumIdeaLength} rows={3} disabled={studio.planning}
          placeholder="比如：一只橘猫在下雨的东京街头找回家的路，温暖治愈，最后它在家门口被主人抱起来"
          onChange={(event) => studio.changeSettings({ idea: event.target.value })} testId="video-idea-input" />
        <div className="video-studio-options">
          <Select label="画面" value={settings.aspect} disabled={studio.busy} options={videoStudioAspects.map((aspect) => ({ value: aspect, label: videoStudioAspectNames[aspect] }))}
            onChange={(event) => { if (isVideoStudioAspect(event.target.value)) studio.changeSettings({ aspect: event.target.value }) }} testId="video-aspect" />
          <Select label="镜头数" value={String(settings.shotCount)} disabled={studio.planning} options={videoStudioShotCounts.map((count) => ({ value: String(count), label: `${count} 个` }))}
            onChange={(event) => studio.changeSettings({ shotCount: Number(event.target.value) })} testId="video-shot-count" />
          <Select label="每段时长" value={String(settings.secondsPerShot)} disabled={studio.busy} options={secondsOptions(settings.videoModel, settings.secondsPerShot)}
            onChange={(event) => studio.changeSettings({ secondsPerShot: Number(event.target.value) })} testId="video-seconds" />
          <div className="video-studio-switch"><Switch label="加字幕" description="每个镜头配一句字幕，直接印在画面上" checked={settings.captions} disabled={studio.planning || composing} onChange={(captions) => studio.changeSettings({ captions })} testId="video-captions" /></div>
        </div>
        <div className="video-studio-models">
          <ModelPicker studio={studio} kind="text" />
          <ModelPicker studio={studio} kind="video" />
        </div>
      </div>
      <div className="video-studio-actions">
        {studio.planning
          ? <Button icon={Square} onClick={() => void studio.stopPlan()} testId="video-plan-stop">停止</Button>
          : <Button variant="primary" icon={Wand2} disabled={!settings.idea.trim() || generating || drawing || composing} onClick={writePlan} testId="video-plan">{shots.length ? '重新写分镜' : '写分镜'}</Button>}
        {studio.planning && <span className="video-studio-hint" role="status">AI 正在写分镜…</span>}
        <small className="video-studio-hint">写分镜按文字模型的用量计费；之后每生成一段视频单独计费。</small>
      </div>
    </Card>

    {shots.length > 0 && <Card title={project.title || '分镜'} meta={[`${shots.length} 个镜头`, commonSeconds === null ? '' : `每段 ${commonSeconds} 秒`, `共约 ${videoStudioTotalSeconds(project)} 秒`].filter(Boolean).join(' · ')} testId="video-shots"
      actions={generating
        ? <Button icon={Square} onClick={() => void studio.stopGenerating()} testId="video-generate-stop">停止生成</Button>
        : missing > 0 && <Button variant="primary" icon={Sparkles} disabled={studio.planning || composing || drawing} onClick={() => confirmGenerate(shots.filter((shot) => !shot.clip).map((shot) => shot.id))} testId="video-generate-all">{missing === shots.length ? `生成全部 ${missing} 段` : `生成剩下的 ${missing} 段`}</Button>}>
      <ol className="video-studio-shots">
        {shots.map((shot, index) => <ShotRow key={shot.id} shot={shot} index={index} total={shots.length} captions={settings.captions} seconds={videoStudioShotSeconds(shot, settings)} videoModel={settings.videoModel} locked={studio.planning || composing}
          onEdit={(patch) => studio.editShot(shot.id, patch)} onMove={(offset) => studio.moveShot(shot.id, offset)}
          onRemove={() => shot.clip ? setConfirmation({ kind: 'remove', id: shot.id }) : studio.removeShot(shot.id)}
          onGenerate={() => confirmGenerate([shot.id])} onOpen={() => shot.clip && void studio.openClip(shot.clip.assetId)}
          onPickImage={() => void studio.pickShotImage(shot.id)} onRemoveImage={() => studio.removeShotImage(shot.id)}
          onPickLibraryImage={library ? () => void studio.pickLibraryImage(shot.id, library.pickImage) : undefined}
          onPickLibraryClip={library ? () => void studio.pickLibraryClip(shot.id, library.pickClip) : undefined} onRemoveClip={() => studio.removeShotClip(shot.id)}
          onDraw={() => openDraw(shot.id)} onStopDrawing={() => void studio.stopDrawing(shot.id)}
          onTrim={(side, seconds) => studio.setShotTrim(shot.id, side, seconds)} onSeconds={(seconds) => studio.setShotSeconds(shot.id, seconds)} />)}
      </ol>
      {canAddVideoStudioShot(project) && <Button variant="ghost" icon={Plus} disabled={studio.planning || composing} onClick={studio.addShot} testId="video-shot-add">加一个镜头</Button>}
    </Card>}

    {shots.length > 0 && <Card title="拼成一条视频" testId="video-export">
      <div className="video-studio-options">
        <Select label="清晰度" value={String(settings.resolution)} disabled={composing} options={videoStudioResolutions.map((resolution) => ({ value: String(resolution), label: `${resolution}p` }))}
          onChange={(event) => { const resolution = Number(event.target.value); if (isVideoStudioResolution(resolution)) studio.changeSettings({ resolution }) }} testId="video-resolution" />
        <Select label="画面对不上时" value={settings.fit} disabled={composing} options={videoStudioFits.map((fit) => ({ value: fit, label: videoStudioFitNames[fit] }))}
          onChange={(event) => { if (isVideoStudioFit(event.target.value)) studio.changeSettings({ fit: event.target.value }) }} testId="video-fit" />
        <Select label="镜头之间" value={settings.transition} disabled={composing} options={videoStudioTransitions.map((transition) => ({ value: transition, label: videoStudioTransitionNames[transition] }))}
          onChange={(event) => { if (isVideoStudioTransition(event.target.value)) studio.changeSettings({ transition: event.target.value }) }} testId="video-transition" />
        <div className="video-studio-switch"><Switch label="结尾淡出" description="最后一秒画面和声音慢慢淡掉" checked={settings.fadeOut} disabled={composing} onChange={(fadeOut) => studio.changeSettings({ fadeOut })} testId="video-fade-out" /></div>
        {/* 关了「加字幕」就不印字幕，这两项也不用出来。 */}
        {settings.captions && <>
          <Select label="字幕大小" value={settings.captionSize} disabled={composing} options={videoStudioCaptionSizes.map((size) => ({ value: size, label: videoStudioCaptionSizeNames[size] }))}
            onChange={(event) => { if (isVideoStudioCaptionSize(event.target.value)) studio.changeSettings({ captionSize: event.target.value }) }} testId="video-caption-size" />
          <Select label="字幕位置" value={settings.captionPosition} disabled={composing} options={videoStudioCaptionPositions.map((position) => ({ value: position, label: videoStudioCaptionPositionNames[position] }))}
            onChange={(event) => { if (isVideoStudioCaptionPosition(event.target.value)) studio.changeSettings({ captionPosition: event.target.value }) }} testId="video-caption-position" />
        </>}
      </div>
      <MusicRow studio={studio} disabled={composing} />
      <ComposeProgress studio={studio} />
      <div className="video-studio-actions">
        {composing
          ? <Button icon={Square} disabled={studio.composeState.phase === 'storing'} onClick={studio.stopCompose} testId="video-compose-stop">停止</Button>
          : <Button variant="primary" icon={Film} disabled={studio.planning || !videoStudioReadyToCompose(project)} onClick={() => void studio.compose()} testId="video-compose">拼成一条视频</Button>}
        {!composing && studio.planning && <small className="video-studio-hint">请等待分镜编写完成后再合成。</small>}
        {!composing && !studio.planning && !videoStudioReadyToCompose(project) && <small className="video-studio-hint">{generating ? '请等待所有片段生成完成后再合成。' : `仍有 ${missing} 个镜头未生成片段。`}</small>}
        {!composing && !studio.planning && videoStudioReadyToCompose(project) && <small className="video-studio-hint">在本机合成，不产生费用。</small>}
      </div>
      {exported && !composing && <div className="video-studio-result" data-testid="video-result">
        <button type="button" className="video-studio-thumb" onClick={() => void studio.openClip(exported.assetId)} aria-label="用播放器打开成片" title="用播放器打开">
          <ClipThumbnail src={exported.thumbnailUrl} /><Play size={20} aria-hidden="true" />
        </button>
        <div className="video-studio-result-copy">
          <strong>{project.title || '成片'}</strong>
          <small>{[exported.durationSeconds ? formatVideoStudioDuration(exported.durationSeconds) : '', exported.width && exported.height ? `${exported.width} × ${exported.height}` : ''].filter(Boolean).join(' · ') || '已存进 AI 作品文件夹'}</small>
          <div className="video-studio-result-actions">
            <Button size="sm" icon={Play} onClick={() => void studio.openClip(exported.assetId)} testId="video-result-open">用播放器打开</Button>
            <Button size="sm" icon={Download} onClick={() => void studio.saveClip(exported.assetId, project.title)} testId="video-result-save">另存为</Button>
            <Button size="sm" icon={FolderOpen} onClick={() => void studio.openFolder()} testId="video-result-folder">打开文件夹</Button>
          </div>
        </div>
      </div>}
    </Card>}

    {active && confirmation && <Confirm testId="video-confirm"
      title={confirmation.kind === 'generate' ? regenerating ? '是否重新生成此片段？' : `是否生成 ${confirmCount} 段视频？` : confirmation.kind === 'plan' ? '是否重新编写分镜？' : '是否删除此镜头？'}
      body={confirmation.kind === 'generate'
        ? <><p>{regenerating ? `将再次扣费，${quote ? `${quote}。` : ''}新片段生成后将替换当前片段，原片段仍保留在 AI 作品文件夹中。` : `用「${settings.videoModel}」生成 ${confirmCount} 段、${confirmSeconds === null ? `共 ${confirmShots.reduce((total, shot) => total + videoStudioShotSeconds(shot, settings), 0)} 秒` : `每段 ${confirmSeconds} 秒`}，每段单独计费${quote ? `，${quote}` : ''}。${balance ? `当前余额 ${dollars(balance.displayAmount)}。` : ''}`}</p>{unconfirmed.length > 0 && <p data-testid="video-confirm-unconfirmed">{videoStudioUnconfirmedWarning(unconfirmed, confirmCount)}</p>}<p>每段约需几分钟。如中途停止，已提交至服务端的片段仍将生成并扣费。</p></>
        : confirmation.kind === 'plan' ? <p>当前镜头和片段将替换为新编写的分镜。已生成的片段仍保留在 AI 作品文件夹中，此处不再列出。</p>
        : <p>此镜头及其片段将从分镜中移除，片段仍保留在 AI 作品文件夹中。</p>}
      okLabel={confirmation.kind === 'generate' ? regenerating ? '重新生成' : '开始生成' : confirmation.kind === 'plan' ? '重新编写' : '删除'}
      danger={confirmation.kind === 'remove' || unconfirmed.length > 0}
      // 同聊天页重新生成「上次请求可能仍在服务端处理」那一下：先勾「我已了解影响」才能点。
      requireAck={unconfirmed.length > 0}
      onOk={runConfirmation} onClose={() => setConfirmation(null)} />}
    {active && drawShot && <ShotImageDialog key={drawShot.id} index={drawIndex} prompt={drawShot.prompt} redrawing={Boolean(drawShot.image)} settings={settings} accountScope={accountScope}
      studio={studio} prices={prices.list} balance={balance ? dollars(balance.displayAmount) : null} onClose={() => setDrawTarget(null)}
      onConfirm={(draft) => { setDrawTarget(null); void studio.drawShotImage(drawShot.id, draft) }} />}
  </section>
}

function secondsOptions(model: string, current: number) {
  const choices = videoStudioSecondsChoices(model)
  const all = choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b)
  return all.map((seconds) => ({ value: String(seconds), label: `${seconds} 秒` }))
}

// 画镜头图的型号不在这里选了：点「让 AI 画一张」时在出图框里选，同对话里「生成图片」那一档（融合第 4 步）。
const modelPickerNames: Record<'text' | 'video', { title: string, menu: string, empty: string }> = {
  text: { title: '写分镜', menu: '写分镜的模型', empty: '暂无可用的文字模型' },
  video: { title: '出视频', menu: '出视频的模型', empty: '暂无可用的视频模型' },
}

function ModelPicker({ studio, kind }: { studio: VideoStudioController, kind: 'text' | 'video' }) {
  const { settings } = studio.project
  const catalog: ChatCatalogEntry[] = studio.catalogs[kind]
  const model = kind === 'text' ? settings.textModel : settings.videoModel
  const group = kind === 'text' ? settings.textGroup : settings.videoGroup
  const mode = kind === 'text' ? 'text' : 'image'
  const names = modelPickerNames[kind]
  const preparing = studio.catalogLoading || Object.values(studio.preparations).some((preparation) => preparation.phase === 'loading')
  const label = model || (preparing ? '正在读取模型' : '暂无可用模型')
  const billing = (entry: ChatCatalogEntry) => entry.model === model && entry.groups.includes(group) ? group : pickChatGroup(entry.groups, { current: group, mode, groups: studio.groups, site: studio.site })
  const vendors = chatModelVendors.map((vendor) => ({ vendor, entries: catalog.filter((entry) => chatModelVendor(entry.model) === vendor) })).filter((section) => section.entries.length > 0)
  const select = (value: string) => {
    const entry = catalog.find((item) => item.model === value)
    if (!entry) return
    if (kind === 'text') studio.selectTextModel(entry.model, billing(entry))
    else studio.selectVideoModel(entry.model, billing(entry))
  }
  const empty = preparing ? '正在读取模型' : studio.catalogError || names.empty
  const sections = vendors.length
    ? vendors.map(({ vendor, entries }) => ({ label: vendor, value: model, options: entries.map((entry) => ({ value: entry.model, label: entry.model, hint: `${billing(entry)}分组` })), onChange: select }))
    : [{ label: '模型', value: '', options: [], empty, onChange: () => undefined }]
  return <div className="video-studio-model">
    <span>{names.title}</span>
    <ChoiceMenu label={names.menu} align="start" testId={`video-${kind}-model-menu`}
      anchor={<Button size="sm" iconRight={ChevronDown} disabled={studio.busy} title={[group, model].filter(Boolean).join(' · ') || undefined} data-model={model} data-group={group} testId={`video-${kind}-model`}><span aria-hidden="true"><BrandIcon model={model} size={16} /></span><span className="video-studio-model-name">{label}</span></Button>}
      sections={sections} actions={[{ label: '刷新模型', icon: RefreshCw, loading: preparing, keepOpen: true, onSelect: () => void studio.refreshModels(), testId: `video-${kind}-model-refresh` }]} />
  </div>
}

/** 缩略图出不来（Linux 上取不到视频封面、片段在作品库里被删了）就不放裂图，留底色、播放键和镜头号。 */
function ClipThumbnail({ src }: { src: string }) {
  const [failed, setFailed] = useState('')
  return failed === src ? null : <img src={src} alt="" onError={() => setFailed(src)} />
}

const stageNames: Record<NonNullable<VideoStudioShot['stage']>, string> = { processing: '生成中', downloading: '正在下载', saving: '正在保存' }
// yoyo 2026-11-09 批的字（「画图改」）。
const drawTip = '根据此镜头的画面描述先生成一张图片，确认后再用于生成视频；生成图片单独计费'

function ShotRow({ shot, index, total, captions, seconds, videoModel, locked, onEdit, onMove, onRemove, onGenerate, onOpen, onPickImage, onRemoveImage, onPickLibraryImage, onPickLibraryClip, onRemoveClip, onDraw, onStopDrawing, onTrim, onSeconds }: {
  shot: VideoStudioShot, index: number, total: number, captions: boolean, seconds: number, videoModel: string, locked: boolean
  onEdit(patch: Partial<Pick<VideoStudioShot, 'prompt' | 'caption'>>): void, onMove(offset: -1 | 1): void, onRemove(): void, onGenerate(): void, onOpen(): void
  onPickImage(): void, onRemoveImage(): void, onDraw(): void, onStopDrawing(): void, onTrim(side: VideoStudioTrimSide, seconds: number): void, onSeconds(seconds: number): void
  /** 「从作品库选图」「使用已有片段」：「创作」页给了作品库才有。 */
  onPickLibraryImage?: () => void, onPickLibraryClip?: () => void, onRemoveClip(): void
}) {
  // 画着图的这一镜和出着视频一样：画面描述、图、出视频、删都先不让动，画好的图才对得上这一镜。
  const drawing = isVideoStudioShotDrawing(shot)
  const busy = isVideoStudioShotBusy(shot) || drawing
  // 这一镜用的是作品库里现成的一段（融合第 3 步）：不用生成，那一排换成「更换片段」「不使用此片段」。
  const borrowed = Boolean(shot.clip && shot.borrowed)
  const libraryButtons = <>
    {onPickLibraryImage && <Button size="sm" variant="ghost" icon={Images} title="从作品库选择一张图片作为开头图" disabled={busy || locked} onClick={onPickLibraryImage} testId={`video-shot-library-image-${index}`}>从作品库选图</Button>}
    {onPickLibraryClip && <Button size="sm" variant="ghost" icon={Film} title="使用作品库中已有的视频片段，无需生成" disabled={busy || locked} onClick={onPickLibraryClip} testId={`video-shot-library-clip-${index}`}>使用已有片段</Button>}
  </>
  const status = shot.status === 'queued' ? <Pill tone="neutral">排队中</Pill>
    : shot.status === 'generating' ? <Pill tone="accent" dot>{shot.delayed ? '排队较久' : stageNames[shot.stage ?? 'processing']}{shot.progress !== undefined && shot.stage !== 'saving' ? ` ${shot.progress}%` : ''}</Pill>
    : shot.status === 'failed' ? <Pill tone="bad">生成失败</Pill>
    : shot.clip ? <Pill tone="ok">{borrowed ? '已有片段' : '已生成'}</Pill> : <Pill tone="neutral">尚未生成</Pill>
  return <li className="video-studio-shot" data-status={shot.status} data-testid={`video-shot-${index}`}>
    {shot.clip
      ? <button type="button" className="video-studio-thumb" onClick={onOpen} aria-label={`用播放器打开第 ${index + 1} 段`} title="用播放器打开"><ClipThumbnail src={shot.clip.thumbnailUrl} /><Play size={18} aria-hidden="true" /><b>{index + 1}</b></button>
      // 还没生成片段时，选好的图就放在这里（yoyo 2026-11-09 批的字「图开头改」：选好以后左边的小图换成这张图）。
      : shot.image
        ? <div className="video-studio-thumb is-still" aria-hidden="true" data-testid={`video-shot-image-thumb-${index}`}><ClipThumbnail src={shot.image.url} /><b>{index + 1}</b></div>
        : <div className="video-studio-thumb is-empty" aria-hidden="true"><b>{index + 1}</b></div>}
    <div className="video-studio-shot-body">
      <Textarea label={`第 ${index + 1} 个镜头 · 画面`} value={shot.prompt} rows={3} maxLength={videoStudioPlanLimits.maximumPromptLength} disabled={busy || locked}
        onChange={(event) => onEdit({ prompt: event.target.value })} testId={`video-shot-prompt-${index}`} />
      {captions && <Input label="字幕" value={shot.caption} maxLength={videoStudioPlanLimits.maximumCaptionLength} disabled={locked} placeholder="这一镜不要字幕就空着"
        onChange={(event) => onEdit({ caption: event.target.value })} testId={`video-shot-caption-${index}`} />}
      <div className="video-studio-shot-image">
        {drawing
          ? <>
            <Pill tone="accent" dot>正在画图</Pill>
            <Button size="sm" variant="ghost" icon={Square} onClick={onStopDrawing} testId={`video-shot-draw-stop-${index}`}>停止画图</Button>
          </>
          : borrowed
          ? <>
            {onPickLibraryClip && <Button size="sm" variant="ghost" icon={Film} disabled={busy || locked} onClick={onPickLibraryClip} testId={`video-shot-clip-change-${index}`}>更换片段</Button>}
            <Button size="sm" variant="ghost" icon={X} disabled={busy || locked} onClick={onRemoveClip} testId={`video-shot-clip-remove-${index}`}>不使用此片段</Button>
          </>
          : shot.image
          ? <>
            {/* 已经生成过片段时左边是片段，选的图在这里留一张小的，看得出用的是哪张。 */}
            {shot.clip && <span className="video-studio-shot-image-preview" aria-hidden="true" data-testid={`video-shot-image-preview-${index}`}><ClipThumbnail src={shot.image.url} /></span>}
            <Button size="sm" variant="ghost" icon={ImagePlus} disabled={busy || locked} onClick={onPickImage} testId={`video-shot-image-change-${index}`}>换一张</Button>
            <Button size="sm" variant="ghost" icon={X} disabled={busy || locked} onClick={onRemoveImage} testId={`video-shot-image-remove-${index}`}>不使用此图</Button>
            <Button size="sm" variant="ghost" icon={Brush} title={drawTip} disabled={busy || locked} onClick={onDraw} testId={`video-shot-draw-${index}`}>再画一张</Button>
            {libraryButtons}
          </>
          : <>
            <Button size="sm" variant="ghost" icon={ImagePlus} title="生成时从这张图动起来，适合商品图、人物照片" disabled={busy || locked} onClick={onPickImage} testId={`video-shot-image-${index}`}>用一张图开头</Button>
            <Button size="sm" variant="ghost" icon={Brush} title={drawTip} disabled={busy || locked} onClick={onDraw} testId={`video-shot-draw-${index}`}>让 AI 画一张</Button>
            {libraryButtons}
          </>}
      </div>
      {/* 这一镜出多长（重新生成才用上），生成好以后再加剪头剪尾。用着现成片段的不生成，没有「时长」那一格。 */}
      <div className="video-studio-shot-length">
        {!borrowed && <Select label="时长" value={String(seconds)} disabled={busy || locked} options={secondsOptions(videoModel, seconds)}
          onChange={(event) => onSeconds(Number(event.target.value))} testId={`video-shot-seconds-${index}`} />}
        {shot.clip && (['start', 'end'] as const).map((side) => <Select key={side} label={side === 'start' ? '开头剪掉' : '结尾剪掉'} value={String((side === 'start' ? shot.trimStart : shot.trimEnd) ?? 0)} disabled={busy || locked}
          options={videoStudioTrimOptions(shot, side, seconds).map((trim) => ({ value: String(trim), label: trim ? `${trim} 秒` : '不剪' }))}
          onChange={(event) => onTrim(side, Number(event.target.value))} testId={`video-shot-trim-${side}-${index}`} />)}
      </div>
      {shot.drawError && !drawing && <p className="video-studio-shot-error" role="alert" data-testid={`video-shot-draw-error-${index}`}>{shot.drawError}</p>}
      {shot.status === 'failed' && shot.error && <p className="video-studio-shot-error" role="alert">{shot.error}</p>}
      {shot.status === 'generating' && shot.progress !== undefined && <Progress value={shot.progress} label={`第 ${index + 1} 段生成进度`} />}
    </div>
    <div className="video-studio-shot-side">
      {status}
      <div className="video-studio-shot-tools">
        {/* 用着现成片段的这一镜不用生成；想自己生成一段，先点「不使用此片段」。 */}
        {!borrowed && <Button size="sm" variant={shot.clip ? 'ghost' : 'secondary'} icon={shot.clip ? RefreshCw : Sparkles} disabled={busy || locked} onClick={onGenerate} testId={`video-shot-generate-${index}`}>{shot.clip || shot.status === 'failed' ? '重新生成' : '生成'}</Button>}
        <Button size="sm" variant="ghost" icon={ArrowUp} aria-label="上移" title="上移" disabled={index === 0 || locked} onClick={() => onMove(-1)} testId={`video-shot-up-${index}`} />
        <Button size="sm" variant="ghost" icon={ArrowDown} aria-label="下移" title="下移" disabled={index === total - 1 || locked} onClick={() => onMove(1)} testId={`video-shot-down-${index}`} />
        <Button size="sm" variant="ghost" icon={Trash2} aria-label="删除此镜头" title="删除此镜头" disabled={busy || locked} onClick={onRemove} testId={`video-shot-remove-${index}`} />
      </div>
    </div>
  </li>
}

// 配乐：歌名、换一首、不用配乐，和有歌时片段原声放多大。没选歌时只有「加配乐」一个按钮。
function MusicRow({ studio, disabled }: { studio: VideoStudioController, disabled: boolean }) {
  const music = studio.project.music
  if (!music) {
    return <div className="video-studio-music" data-testid="video-music">
      <Button size="sm" icon={Music} title="从电脑里选一首歌当背景音乐，支持 MP3、M4A、WAV、OGG" disabled={disabled} onClick={() => void studio.pickMusic()} testId="video-music-add">加配乐</Button>
    </div>
  }
  return <div className="video-studio-music" data-testid="video-music">
    <span className="video-studio-music-name" title={music.name} data-testid="video-music-name"><Music size={14} aria-hidden="true" /><span>{music.name}</span></span>
    <Button size="sm" variant="ghost" icon={RefreshCw} disabled={disabled} onClick={() => void studio.pickMusic()} testId="video-music-change">换一首</Button>
    <Button size="sm" variant="ghost" icon={X} disabled={disabled} onClick={studio.removeMusic} testId="video-music-remove">不使用配乐</Button>
    <Select label="片段原声" value={music.clipSound} disabled={disabled} options={videoStudioClipSounds.map((sound) => ({ value: sound, label: videoStudioClipSoundNames[sound] }))}
      onChange={(event) => { const sound = videoStudioClipSounds.find((candidate) => candidate === event.target.value); if (sound) studio.setClipSound(sound) }} testId="video-clip-sound" />
  </div>
}

function ComposeProgress({ studio }: { studio: VideoStudioController }) {
  const state = studio.composeState
  if (state.phase === 'idle') return null
  const label = state.phase === 'reading' ? `正在读取第 ${state.done + 1} / ${state.total} 段`
    : state.phase === 'storing' ? '正在存进 AI 作品文件夹'
    : state.progress.stage === 'reading' ? '正在读取片段' : state.progress.stage === 'rendering' ? '正在合成画面' : '正在写入文件'
  const value = state.phase === 'reading' ? 0 : state.phase === 'storing' ? 100 : Math.round(state.progress.ratio * 100)
  return <div className="video-studio-progress" data-testid="video-compose-progress"><Progress value={value} label={label} /></div>
}
