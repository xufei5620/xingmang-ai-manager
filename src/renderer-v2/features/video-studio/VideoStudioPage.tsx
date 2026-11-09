import { useState } from 'react'
import { ArrowDown, ArrowUp, Brush, ChevronDown, Clapperboard, Download, Film, FolderOpen, ImagePlus, Music, Play, Plus, RefreshCw, RotateCcw, Sparkles, Square, Trash2, Wand2, X } from 'lucide-react'
import { videoStudioPlanLimits } from '../../../../electron/video-studio-plan'
import { BrandIcon, Button, Card, ChoiceMenu, Confirm, Empty, Input, Notice, PageHead, Pill, Progress, Select, Switch, Textarea } from '../../ui'
import { dollars } from '../../business-common'
import { useSharedAccountBalance } from '../app/balance-context'
import { chatModelVendor, chatModelVendors, pickChatGroup, type ChatCatalogEntry, type ChatSite } from '../chat/state'
import {
  canAddVideoStudioShot,
  isVideoStudioShotBusy,
  isVideoStudioShotDrawing,
  videoStudioAspectNames,
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
  type VideoStudioShot,
  type VideoStudioTrimSide,
} from './project'
import { isVideoStudioAspect, isVideoStudioFit, isVideoStudioResolution, isVideoStudioTransition, videoStudioAspects, videoStudioFits, videoStudioResolutions, videoStudioTransitions } from './timeline'
import { useVideoStudio, type VideoStudioBridge, type VideoStudioController, type VideoStudioOptions } from './useVideoStudio'
import './video-studio.css'

/** suspended：状态文件关掉了视频剪辑（remote-features.ts），工程照样留在本机。 */
export type VideoStudioAccess = 'ready' | 'guest' | 'unsupported' | 'suspended'

export interface VideoStudioPageProps {
  bridge: VideoStudioBridge
  accountScope: string
  site: ChatSite
  access: VideoStudioAccess
  active?: boolean
  onLogin?: () => void
  onOpenAccount?: (tab: 'recharge' | 'keys') => void
  /** 测试用：换掉拼片和存工程的那两样。 */
  options?: VideoStudioOptions
}

const pageLead = '说一句想拍什么，AI 写好分镜、一段一段生成，再在这台电脑上拼成一条带字幕的视频。'
type Confirmation = { kind: 'generate', ids: string[] } | { kind: 'draw', id: string } | { kind: 'plan' } | { kind: 'reset' } | { kind: 'remove', id: string }

export function VideoStudioPage({ bridge, accountScope, site, access, active = true, onLogin, onOpenAccount, options }: VideoStudioPageProps) {
  if (access !== 'ready') {
    return <section className="v2-page video-studio" data-page-id="video" data-testid="page-video">
      <PageHead title="视频剪辑" lead={pageLead} />
      {access === 'guest'
        ? <Empty icon={Clapperboard} title="登录后才能用" description="生成视频用的是星芒账号的额度，先登录。" action={onLogin && <Button variant="primary" onClick={onLogin} testId="video-login">登录</Button>} testId="video-guest" />
        : access === 'suspended'
          // yoyo 2026-10-28 批的字（「停用改」）。
          ? <Empty icon={Clapperboard} title="视频剪辑暂时停用" description="你的工程都还在，修好以后会自动恢复。" testId="video-suspended" />
          : <Empty icon={Clapperboard} title="当前账号用不了视频剪辑" description="视频剪辑要用星芒账号里的视频模型，历史账号没有。换成星芒账号登录就能用。" testId="video-unsupported" />}
    </section>
  }
  return <VideoStudioWorkspace bridge={bridge} accountScope={accountScope} site={site} active={active} onOpenAccount={onOpenAccount} options={options} />
}

function VideoStudioWorkspace({ bridge, accountScope, site, active, onOpenAccount, options }: Omit<VideoStudioPageProps, 'access' | 'onLogin'> & { active: boolean }) {
  const studio = useVideoStudio(bridge, accountScope, site, true, options)
  // 确认框「每段单独计费」后面报一句当前余额（yoyo 2026-10-29 批的字「余额改」，#1406 P2-1）。读不到就不写这句，
  // 同充值页卡头；按型号报准价格放到 0.2.23 之后。
  const { snapshot: balanceState } = useSharedAccountBalance()
  const balance = balanceState.scope === accountScope ? balanceState.balance : null
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const { project } = studio
  const { settings, shots, exported } = project
  const generating = shots.some(isVideoStudioShotBusy)
  const drawing = shots.some(isVideoStudioShotDrawing)
  const composing = studio.composeState.phase !== 'idle'
  const missing = shots.filter((shot) => !shot.clip).length
  const quotaAction = /余额|额度/.test(studio.error) && onOpenAccount
  const folderAction = /AI 作品文件夹/.test(studio.notice)
  const confirmGenerate = (ids: string[]) => setConfirmation({ kind: 'generate', ids })
  const runConfirmation = () => {
    const current = confirmation
    setConfirmation(null)
    if (!current) return
    if (current.kind === 'generate') studio.generate(current.ids)
    if (current.kind === 'draw') void studio.drawShotImage(current.id)
    if (current.kind === 'plan') void studio.writePlan()
    if (current.kind === 'reset') studio.reset()
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
  const drawIndex = confirmation?.kind === 'draw' ? shots.findIndex((shot) => shot.id === confirmation.id) : -1
  const redrawing = drawIndex >= 0 && Boolean(shots[drawIndex].image)

  return <section className="v2-page video-studio" data-page-id="video" data-testid="page-video">
    <PageHead title="视频剪辑" lead={pageLead}
      actions={(shots.length > 0 || settings.idea) && <Button icon={RotateCcw} disabled={studio.busy} onClick={() => setConfirmation({ kind: 'reset' })} testId="video-reset">重新开始</Button>} />
    {studio.error && <Notice tone="bad" title="没有完成" body={studio.error} onDismiss={() => studio.setError('')}
      actions={quotaAction ? <Button size="sm" variant="primary" onClick={() => onOpenAccount?.(/额度上限/.test(studio.error) ? 'keys' : 'recharge')}>{/额度上限/.test(studio.error) ? '去调额度' : '去充值'}</Button> : undefined} testId="video-error" />}
    {studio.notice && <Notice tone="accent" title="提示" body={studio.notice} onDismiss={() => studio.setNotice('')}
      actions={folderAction ? <Button size="sm" icon={FolderOpen} onClick={() => void studio.openFolder()} testId="video-notice-folder">打开文件夹</Button> : undefined} testId="video-notice" />}
    {studio.storageWarning && <Notice tone="warn" title="存不下这份分镜" body={studio.storageWarning} testId="video-storage-warning" />}

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
          <ModelPicker studio={studio} kind="image" />
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
          canDraw={Boolean(settings.imageModel && settings.imageGroup)} onDraw={() => setConfirmation({ kind: 'draw', id: shot.id })} onStopDrawing={() => void studio.stopDrawing(shot.id)}
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
      </div>
      <MusicRow studio={studio} disabled={composing} />
      <ComposeProgress studio={studio} />
      <div className="video-studio-actions">
        {composing
          ? <Button icon={Square} disabled={studio.composeState.phase === 'storing'} onClick={studio.stopCompose} testId="video-compose-stop">停止</Button>
          : <Button variant="primary" icon={Film} disabled={studio.planning || !videoStudioReadyToCompose(project)} onClick={() => void studio.compose()} testId="video-compose">拼成一条视频</Button>}
        {!composing && studio.planning && <small className="video-studio-hint">等分镜写完再拼。</small>}
        {!composing && !studio.planning && !videoStudioReadyToCompose(project) && <small className="video-studio-hint">{generating ? '等片段都生成好再拼。' : `还有 ${missing} 个镜头没生成片段。`}</small>}
        {!composing && !studio.planning && videoStudioReadyToCompose(project) && <small className="video-studio-hint">在这台电脑上拼，不花钱。</small>}
      </div>
      {exported && !composing && <div className="video-studio-result" data-testid="video-result">
        <button type="button" className="video-studio-thumb" onClick={() => void studio.openClip(exported.assetId)} aria-label="用播放器打开成片" title="用播放器打开">
          <ClipThumbnail src={exported.thumbnailUrl} /><Play size={20} aria-hidden="true" />
        </button>
        <div className="video-studio-result-copy">
          <strong>{project.title || '成片'}</strong>
          <small>{[exported.durationSeconds ? `${formatSeconds(exported.durationSeconds)}` : '', exported.width && exported.height ? `${exported.width} × ${exported.height}` : ''].filter(Boolean).join(' · ') || '已存进 AI 作品文件夹'}</small>
          <div className="video-studio-result-actions">
            <Button size="sm" icon={Play} onClick={() => void studio.openClip(exported.assetId)} testId="video-result-open">用播放器打开</Button>
            <Button size="sm" icon={Download} onClick={() => void studio.saveClip(exported.assetId, project.title)} testId="video-result-save">另存为</Button>
            <Button size="sm" icon={FolderOpen} onClick={() => void studio.openFolder()} testId="video-result-folder">打开文件夹</Button>
          </div>
        </div>
      </div>}
    </Card>}

    {active && confirmation && <Confirm testId="video-confirm"
      title={confirmation.kind === 'generate' ? regenerating ? '重新生成这一段？' : `生成 ${confirmCount} 段视频？` : confirmation.kind === 'draw' ? redrawing ? '再画一张？' : '画一张镜头图？' : confirmation.kind === 'plan' ? '重新写分镜？' : confirmation.kind === 'reset' ? '重新开始？' : '删掉这个镜头？'}
      body={confirmation.kind === 'generate'
        ? <><p>{regenerating ? '会再扣一次费，新片段生成好以后换掉现在这一段；旧的那段还在 AI 作品文件夹里。' : `用「${settings.videoModel}」生成 ${confirmCount} 段、${confirmSeconds === null ? `共 ${confirmShots.reduce((total, shot) => total + videoStudioShotSeconds(shot, settings), 0)} 秒` : `每段 ${confirmSeconds} 秒`}，每段单独计费。${balance ? `当前余额 ${dollars(balance.displayAmount)}。` : ''}`}</p>{unconfirmed.length > 0 && <p data-testid="video-confirm-unconfirmed">{unconfirmedWarning(unconfirmed, confirmCount)}</p>}<p>一段要几分钟。中途停下的话，已经交给服务端的那几段照样生成、照样扣费。</p></>
        // yoyo 2026-11-09 批的字（「画图改」）。
        : confirmation.kind === 'draw' ? <><p>{redrawing ? '会再扣一次费，新图画好以后换掉现在这一张；旧的那张还在 AI 作品文件夹里。' : `用「${settings.imageModel}」按第 ${drawIndex + 1} 个镜头的画面描述画一张图，单独计费。${balance ? `当前余额 ${dollars(balance.displayAmount)}。` : ''}`}</p><p>中途停下的话，已经交给服务端的这一张照样扣费。</p></>
        : confirmation.kind === 'plan' ? <p>现在的镜头和片段会换成新写的分镜。生成过的片段还在 AI 作品文件夹里，这里不再列出。</p>
        : confirmation.kind === 'reset' ? <p>想法、分镜和片段都从这一页清掉。生成过的片段和拼好的成片还在 AI 作品文件夹里。</p>
        : <p>这个镜头和它的片段从分镜里拿掉，片段还在 AI 作品文件夹里。</p>}
      okLabel={confirmation.kind === 'generate' ? regenerating ? '重新生成' : '开始生成' : confirmation.kind === 'draw' ? redrawing ? '再画一张' : '开始画' : confirmation.kind === 'plan' ? '重新写' : confirmation.kind === 'reset' ? '重新开始' : '删掉'}
      danger={confirmation.kind === 'reset' || confirmation.kind === 'remove' || unconfirmed.length > 0}
      // 同聊天页重新生成「上次请求可能仍在服务端处理」那一下：先勾「我已了解影响」才能点。
      requireAck={unconfirmed.length > 0}
      onOk={runConfirmation} onClose={() => setConfirmation(null)} />}
  </section>
}

/** 确认框里那句「可能多扣一次」。indexes 是这几段在分镜里的位置（从 0 数），total 是这次要生成几段。 */
function unconfirmedWarning(indexes: readonly number[], total: number): string {
  const subject = total === 1 ? '这一段' : indexes.length === total ? '这几段' : `其中第 ${indexes.map((index) => index + 1).join('、')} 段`
  return `${subject}上次提交时没收到服务端答复：钱可能已经扣了，片段却拿不回来。再生成会重新计费，可能多扣一次。`
}

function secondsOptions(model: string, current: number) {
  const choices = videoStudioSecondsChoices(model)
  const all = choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b)
  return all.map((seconds) => ({ value: String(seconds), label: `${seconds} 秒` }))
}

function formatSeconds(seconds: number): string {
  const whole = Math.round(seconds)
  return whole >= 60 ? `${Math.floor(whole / 60)} 分 ${whole % 60} 秒` : `${whole} 秒`
}

const modelPickerNames: Record<'text' | 'video' | 'image', { title: string, menu: string, empty: string }> = {
  text: { title: '写分镜', menu: '写分镜的模型', empty: '暂无可用的文字模型' },
  video: { title: '出视频', menu: '出视频的模型', empty: '暂无可用的视频模型' },
  // 菜单名用批过的「画镜头图」，空表那句同对话页出图（ChatPage 的「暂无可用的图片模型」），不另加新字。
  image: { title: '画镜头图', menu: '画镜头图', empty: '暂无可用的图片模型' },
}

function ModelPicker({ studio, kind }: { studio: VideoStudioController, kind: 'text' | 'video' | 'image' }) {
  const { settings } = studio.project
  const catalog: ChatCatalogEntry[] = studio.catalogs[kind]
  const model = kind === 'text' ? settings.textModel : kind === 'video' ? settings.videoModel : settings.imageModel
  const group = kind === 'text' ? settings.textGroup : kind === 'video' ? settings.videoGroup : settings.imageGroup
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
    else if (kind === 'video') studio.selectVideoModel(entry.model, billing(entry))
    else studio.selectImageModel(entry.model, billing(entry))
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
const drawTip = '按这一镜的画面描述先画一张图，满意了再拿它生成视频；画图单独计费'

function ShotRow({ shot, index, total, captions, seconds, videoModel, locked, canDraw, onEdit, onMove, onRemove, onGenerate, onOpen, onPickImage, onRemoveImage, onDraw, onStopDrawing, onTrim, onSeconds }: {
  shot: VideoStudioShot, index: number, total: number, captions: boolean, seconds: number, videoModel: string, locked: boolean, canDraw: boolean
  onEdit(patch: Partial<Pick<VideoStudioShot, 'prompt' | 'caption'>>): void, onMove(offset: -1 | 1): void, onRemove(): void, onGenerate(): void, onOpen(): void
  onPickImage(): void, onRemoveImage(): void, onDraw(): void, onStopDrawing(): void, onTrim(side: VideoStudioTrimSide, seconds: number): void, onSeconds(seconds: number): void
}) {
  // 画着图的这一镜和出着视频一样：画面描述、图、出视频、删都先不让动，画好的图才对得上这一镜。
  const drawing = isVideoStudioShotDrawing(shot)
  const busy = isVideoStudioShotBusy(shot) || drawing
  const status = shot.status === 'queued' ? <Pill tone="neutral">排队中</Pill>
    : shot.status === 'generating' ? <Pill tone="accent" dot>{shot.delayed ? '排队较久' : stageNames[shot.stage ?? 'processing']}{shot.progress !== undefined && shot.stage !== 'saving' ? ` ${shot.progress}%` : ''}</Pill>
    : shot.status === 'failed' ? <Pill tone="bad">没生成出来</Pill>
    : shot.clip ? <Pill tone="ok">已生成</Pill> : <Pill tone="neutral">还没生成</Pill>
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
          : shot.image
          ? <>
            {/* 已经生成过片段时左边是片段，选的图在这里留一张小的，看得出用的是哪张。 */}
            {shot.clip && <span className="video-studio-shot-image-preview" aria-hidden="true" data-testid={`video-shot-image-preview-${index}`}><ClipThumbnail src={shot.image.url} /></span>}
            <Button size="sm" variant="ghost" icon={ImagePlus} disabled={busy || locked} onClick={onPickImage} testId={`video-shot-image-change-${index}`}>换一张</Button>
            <Button size="sm" variant="ghost" icon={X} disabled={busy || locked} onClick={onRemoveImage} testId={`video-shot-image-remove-${index}`}>不用这张图</Button>
            <Button size="sm" variant="ghost" icon={Brush} title={drawTip} disabled={busy || locked || !canDraw} onClick={onDraw} testId={`video-shot-draw-${index}`}>再画一张</Button>
          </>
          : <>
            <Button size="sm" variant="ghost" icon={ImagePlus} title="生成时从这张图动起来，适合商品图、人物照片" disabled={busy || locked} onClick={onPickImage} testId={`video-shot-image-${index}`}>用一张图开头</Button>
            <Button size="sm" variant="ghost" icon={Brush} title={drawTip} disabled={busy || locked || !canDraw} onClick={onDraw} testId={`video-shot-draw-${index}`}>让 AI 画一张</Button>
          </>}
      </div>
      {/* 这一镜出多长（重新生成才用上），生成好以后再加剪头剪尾。 */}
      <div className="video-studio-shot-length">
        <Select label="时长" value={String(seconds)} disabled={busy || locked} options={secondsOptions(videoModel, seconds)}
          onChange={(event) => onSeconds(Number(event.target.value))} testId={`video-shot-seconds-${index}`} />
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
        <Button size="sm" variant={shot.clip ? 'ghost' : 'secondary'} icon={shot.clip ? RefreshCw : Sparkles} disabled={busy || locked} onClick={onGenerate} testId={`video-shot-generate-${index}`}>{shot.clip || shot.status === 'failed' ? '重新生成' : '生成'}</Button>
        <Button size="sm" variant="ghost" icon={ArrowUp} aria-label="上移" title="上移" disabled={index === 0 || locked} onClick={() => onMove(-1)} testId={`video-shot-up-${index}`} />
        <Button size="sm" variant="ghost" icon={ArrowDown} aria-label="下移" title="下移" disabled={index === total - 1 || locked} onClick={() => onMove(1)} testId={`video-shot-down-${index}`} />
        <Button size="sm" variant="ghost" icon={Trash2} aria-label="删掉这个镜头" title="删掉这个镜头" disabled={busy || locked} onClick={onRemove} testId={`video-shot-remove-${index}`} />
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
    <Button size="sm" variant="ghost" icon={X} disabled={disabled} onClick={studio.removeMusic} testId="video-music-remove">不用配乐</Button>
    <Select label="片段原声" value={music.clipSound} disabled={disabled} options={videoStudioClipSounds.map((sound) => ({ value: sound, label: videoStudioClipSoundNames[sound] }))}
      onChange={(event) => { const sound = videoStudioClipSounds.find((candidate) => candidate === event.target.value); if (sound) studio.setClipSound(sound) }} testId="video-clip-sound" />
  </div>
}

function ComposeProgress({ studio }: { studio: VideoStudioController }) {
  const state = studio.composeState
  if (state.phase === 'idle') return null
  const label = state.phase === 'reading' ? `正在读取第 ${state.done + 1} / ${state.total} 段`
    : state.phase === 'storing' ? '正在存进 AI 作品文件夹'
    : state.progress.stage === 'reading' ? '正在读取片段' : state.progress.stage === 'rendering' ? '正在拼接画面' : '正在写入文件'
  const value = state.phase === 'reading' ? 0 : state.phase === 'storing' ? 100 : Math.round(state.progress.ratio * 100)
  return <div className="video-studio-progress" data-testid="video-compose-progress"><Progress value={value} label={label} /></div>
}
