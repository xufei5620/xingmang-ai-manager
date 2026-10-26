import { useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, Clapperboard, Download, Film, Play, Plus, RefreshCw, RotateCcw, Sparkles, Square, Trash2, Wand2 } from 'lucide-react'
import { videoStudioPlanLimits } from '../../../../electron/video-studio-plan'
import { BrandIcon, Button, Card, ChoiceMenu, Confirm, Empty, Input, Notice, PageHead, Pill, Progress, Select, Switch, Textarea } from '../../ui'
import { chatModelVendor, chatModelVendors, pickChatGroup, type ChatCatalogEntry, type ChatSite } from '../chat/state'
import {
  canAddVideoStudioShot,
  isVideoStudioShotBusy,
  videoStudioAspectNames,
  videoStudioFitNames,
  videoStudioReadyToCompose,
  videoStudioSecondsChoices,
  videoStudioShotCounts,
  type VideoStudioShot,
} from './project'
import { isVideoStudioAspect, isVideoStudioFit, isVideoStudioResolution, videoStudioAspects, videoStudioFits, videoStudioResolutions } from './timeline'
import { useVideoStudio, type VideoStudioBridge, type VideoStudioController, type VideoStudioOptions } from './useVideoStudio'
import './video-studio.css'

export type VideoStudioAccess = 'ready' | 'guest' | 'unsupported'

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
type Confirmation = { kind: 'generate', ids: string[] } | { kind: 'plan' } | { kind: 'reset' } | { kind: 'remove', id: string }

export function VideoStudioPage({ bridge, accountScope, site, access, active = true, onLogin, onOpenAccount, options }: VideoStudioPageProps) {
  if (access !== 'ready') {
    return <section className="v2-page video-studio" data-page-id="video" data-testid="page-video">
      <PageHead title="视频剪辑" lead={pageLead} />
      {access === 'guest'
        ? <Empty icon={Clapperboard} title="登录后才能用" description="生成视频用的是星芒账号的额度，先登录。" action={onLogin && <Button variant="primary" onClick={onLogin} testId="video-login">登录</Button>} testId="video-guest" />
        : <Empty icon={Clapperboard} title="当前账号用不了视频剪辑" description="视频剪辑要用星芒账号里的视频模型，历史账号没有。换成星芒账号登录就能用。" testId="video-unsupported" />}
    </section>
  }
  return <VideoStudioWorkspace bridge={bridge} accountScope={accountScope} site={site} active={active} onOpenAccount={onOpenAccount} options={options} />
}

function VideoStudioWorkspace({ bridge, accountScope, site, active, onOpenAccount, options }: Omit<VideoStudioPageProps, 'access' | 'onLogin'> & { active: boolean }) {
  const studio = useVideoStudio(bridge, accountScope, site, true, options)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const { project } = studio
  const { settings, shots, exported } = project
  const generating = shots.some(isVideoStudioShotBusy)
  const composing = studio.composeState.phase !== 'idle'
  const missing = shots.filter((shot) => !shot.clip).length
  const quotaAction = /余额|额度/.test(studio.error) && onOpenAccount
  const confirmGenerate = (ids: string[]) => setConfirmation({ kind: 'generate', ids })
  const runConfirmation = () => {
    const current = confirmation
    setConfirmation(null)
    if (!current) return
    if (current.kind === 'generate') studio.generate(current.ids)
    if (current.kind === 'plan') void studio.writePlan()
    if (current.kind === 'reset') studio.reset()
    if (current.kind === 'remove') studio.removeShot(current.id)
  }
  const writePlan = () => { if (shots.some((shot) => shot.clip)) setConfirmation({ kind: 'plan' }); else void studio.writePlan() }
  const confirmCount = confirmation?.kind === 'generate' ? confirmation.ids.length : 0
  const regenerating = confirmation?.kind === 'generate' && confirmation.ids.some((id) => shots.find((shot) => shot.id === id)?.clip)

  return <section className="v2-page video-studio" data-page-id="video" data-testid="page-video">
    <PageHead title="视频剪辑" lead={pageLead}
      actions={(shots.length > 0 || settings.idea) && <Button icon={RotateCcw} disabled={studio.busy} onClick={() => setConfirmation({ kind: 'reset' })} testId="video-reset">重新开始</Button>} />
    {studio.error && <Notice tone="bad" title="没有完成" body={studio.error} onDismiss={() => studio.setError('')}
      actions={quotaAction ? <Button size="sm" variant="primary" onClick={() => onOpenAccount?.(/额度上限/.test(studio.error) ? 'keys' : 'recharge')}>{/额度上限/.test(studio.error) ? '去调额度' : '去充值'}</Button> : undefined} testId="video-error" />}
    {studio.notice && <Notice tone="accent" title="提示" body={studio.notice} onDismiss={() => studio.setNotice('')} testId="video-notice" />}
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
          <div className="video-studio-switch"><Switch label="烧字幕" description="每个镜头配一句字幕，拼片时烧在画面上" checked={settings.captions} disabled={studio.planning || composing} onChange={(captions) => studio.changeSettings({ captions })} testId="video-captions" /></div>
        </div>
        <div className="video-studio-models">
          <ModelPicker studio={studio} kind="text" />
          <ModelPicker studio={studio} kind="video" />
        </div>
      </div>
      <div className="video-studio-actions">
        {studio.planning
          ? <Button icon={Square} onClick={() => void studio.stopPlan()} testId="video-plan-stop">停止</Button>
          : <Button variant="primary" icon={Wand2} disabled={!settings.idea.trim() || generating || composing} onClick={writePlan} testId="video-plan">{shots.length ? '重新写分镜' : '写分镜'}</Button>}
        {studio.planning && <span className="video-studio-hint" role="status">AI 正在写分镜…</span>}
        <small className="video-studio-hint">写分镜按文字模型的用量计费；之后每生成一段视频单独计费。</small>
      </div>
    </Card>

    {shots.length > 0 && <Card title={project.title || '分镜'} meta={`${shots.length} 个镜头 · 每段 ${settings.secondsPerShot} 秒 · 共约 ${shots.length * settings.secondsPerShot} 秒`} testId="video-shots"
      actions={generating
        ? <Button icon={Square} onClick={() => void studio.stopGenerating()} testId="video-generate-stop">停止生成</Button>
        : missing > 0 && <Button variant="primary" icon={Sparkles} disabled={studio.planning || composing} onClick={() => confirmGenerate(shots.filter((shot) => !shot.clip).map((shot) => shot.id))} testId="video-generate-all">{missing === shots.length ? `生成全部 ${missing} 段` : `生成剩下的 ${missing} 段`}</Button>}>
      <ol className="video-studio-shots">
        {shots.map((shot, index) => <ShotRow key={shot.id} shot={shot} index={index} total={shots.length} captions={settings.captions} locked={studio.planning || composing}
          onEdit={(patch) => studio.editShot(shot.id, patch)} onMove={(offset) => studio.moveShot(shot.id, offset)}
          onRemove={() => shot.clip ? setConfirmation({ kind: 'remove', id: shot.id }) : studio.removeShot(shot.id)}
          onGenerate={() => confirmGenerate([shot.id])} onOpen={() => shot.clip && void studio.openClip(shot.clip.assetId)} />)}
      </ol>
      {canAddVideoStudioShot(project) && <Button variant="ghost" icon={Plus} disabled={studio.planning || composing} onClick={studio.addShot} testId="video-shot-add">加一个镜头</Button>}
    </Card>}

    {shots.length > 0 && <Card title="拼成一条视频" testId="video-export">
      <div className="video-studio-options">
        <Select label="清晰度" value={String(settings.resolution)} disabled={composing} options={videoStudioResolutions.map((resolution) => ({ value: String(resolution), label: `${resolution}p` }))}
          onChange={(event) => { const resolution = Number(event.target.value); if (isVideoStudioResolution(resolution)) studio.changeSettings({ resolution }) }} testId="video-resolution" />
        <Select label="画面对不上时" value={settings.fit} disabled={composing} options={videoStudioFits.map((fit) => ({ value: fit, label: videoStudioFitNames[fit] }))}
          onChange={(event) => { if (isVideoStudioFit(event.target.value)) studio.changeSettings({ fit: event.target.value }) }} testId="video-fit" />
      </div>
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
          <img src={exported.thumbnailUrl} alt="" /><Play size={20} aria-hidden="true" />
        </button>
        <div className="video-studio-result-copy">
          <strong>{project.title || '成片'}</strong>
          <small>{[exported.durationSeconds ? `${formatSeconds(exported.durationSeconds)}` : '', exported.width && exported.height ? `${exported.width} × ${exported.height}` : ''].filter(Boolean).join(' · ') || '已存进 AI 作品文件夹'}</small>
          <div className="video-studio-result-actions">
            <Button size="sm" icon={Play} onClick={() => void studio.openClip(exported.assetId)} testId="video-result-open">用播放器打开</Button>
            <Button size="sm" icon={Download} onClick={() => void studio.saveClip(exported.assetId)} testId="video-result-save">另存为</Button>
          </div>
        </div>
      </div>}
    </Card>}

    {active && confirmation && <Confirm testId="video-confirm"
      title={confirmation.kind === 'generate' ? regenerating ? '重新生成这一段？' : `生成 ${confirmCount} 段视频？` : confirmation.kind === 'plan' ? '重新写分镜？' : confirmation.kind === 'reset' ? '重新开始？' : '删掉这个镜头？'}
      body={confirmation.kind === 'generate'
        ? <><p>{regenerating ? '会再扣一次费，新片段生成好以后换掉现在这一段；旧的那段还在 AI 作品文件夹里。' : `用「${settings.videoModel}」生成 ${confirmCount} 段、每段 ${settings.secondsPerShot} 秒，每段单独计费。`}</p><p>一段要几分钟。中途停下的话，已经交给服务端的那几段照样生成、照样扣费。</p></>
        : confirmation.kind === 'plan' ? <p>现在的镜头和片段会换成新写的分镜。生成过的片段还在 AI 作品文件夹里，这里不再列出。</p>
        : confirmation.kind === 'reset' ? <p>想法、分镜和片段都从这一页清掉。生成过的片段和拼好的成片还在 AI 作品文件夹里。</p>
        : <p>这个镜头和它的片段从分镜里拿掉，片段还在 AI 作品文件夹里。</p>}
      okLabel={confirmation.kind === 'generate' ? regenerating ? '重新生成' : '开始生成' : confirmation.kind === 'plan' ? '重新写' : confirmation.kind === 'reset' ? '重新开始' : '删掉'}
      danger={confirmation.kind === 'reset' || confirmation.kind === 'remove'}
      onOk={runConfirmation} onClose={() => setConfirmation(null)} />}
  </section>
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

function ModelPicker({ studio, kind }: { studio: VideoStudioController, kind: 'text' | 'video' }) {
  const { settings } = studio.project
  const catalog: ChatCatalogEntry[] = studio.catalogs[kind]
  const model = kind === 'text' ? settings.textModel : settings.videoModel
  const group = kind === 'text' ? settings.textGroup : settings.videoGroup
  const mode = kind === 'text' ? 'text' : 'image'
  const preparing = studio.catalogLoading || Object.values(studio.preparations).some((preparation) => preparation.phase === 'loading')
  const label = model || (preparing ? '正在读取模型' : '暂无可用模型')
  const billing = (entry: ChatCatalogEntry) => entry.model === model && entry.groups.includes(group) ? group : pickChatGroup(entry.groups, { current: group, mode, groups: studio.groups, site: studio.site })
  const vendors = chatModelVendors.map((vendor) => ({ vendor, entries: catalog.filter((entry) => chatModelVendor(entry.model) === vendor) })).filter((section) => section.entries.length > 0)
  const select = (value: string) => {
    const entry = catalog.find((item) => item.model === value)
    if (!entry) return
    if (kind === 'text') studio.selectTextModel(entry.model, billing(entry)); else studio.selectVideoModel(entry.model, billing(entry))
  }
  const empty = preparing ? '正在读取模型' : studio.catalogError || (kind === 'text' ? '暂无可用的文字模型' : '暂无可用的视频模型')
  const sections = vendors.length
    ? vendors.map(({ vendor, entries }) => ({ label: vendor, value: model, options: entries.map((entry) => ({ value: entry.model, label: entry.model, hint: `${billing(entry)}分组` })), onChange: select }))
    : [{ label: '模型', value: '', options: [], empty, onChange: () => undefined }]
  return <div className="video-studio-model">
    <span>{kind === 'text' ? '写分镜' : '出视频'}</span>
    <ChoiceMenu label={kind === 'text' ? '写分镜的模型' : '出视频的模型'} align="start" testId={`video-${kind}-model-menu`}
      anchor={<Button size="sm" iconRight={ChevronDown} disabled={studio.busy} title={[group, model].filter(Boolean).join(' · ') || undefined} data-model={model} data-group={group} testId={`video-${kind}-model`}><span aria-hidden="true"><BrandIcon model={model} size={16} /></span><span className="video-studio-model-name">{label}</span></Button>}
      sections={sections} actions={[{ label: '刷新模型', icon: RefreshCw, loading: preparing, keepOpen: true, onSelect: () => void studio.refreshModels(), testId: `video-${kind}-model-refresh` }]} />
  </div>
}

const stageNames: Record<NonNullable<VideoStudioShot['stage']>, string> = { processing: '生成中', downloading: '正在下载', saving: '正在保存' }

function ShotRow({ shot, index, total, captions, locked, onEdit, onMove, onRemove, onGenerate, onOpen }: {
  shot: VideoStudioShot, index: number, total: number, captions: boolean, locked: boolean
  onEdit(patch: Partial<Pick<VideoStudioShot, 'prompt' | 'caption'>>): void, onMove(offset: -1 | 1): void, onRemove(): void, onGenerate(): void, onOpen(): void
}) {
  const busy = isVideoStudioShotBusy(shot)
  const status = shot.status === 'queued' ? <Pill tone="neutral">排队中</Pill>
    : shot.status === 'generating' ? <Pill tone="accent" dot>{shot.delayed ? '排队较久' : stageNames[shot.stage ?? 'processing']}{shot.progress !== undefined && shot.stage !== 'saving' ? ` ${shot.progress}%` : ''}</Pill>
    : shot.status === 'failed' ? <Pill tone="bad">没生成出来</Pill>
    : shot.clip ? <Pill tone="ok">已生成</Pill> : <Pill tone="neutral">还没生成</Pill>
  return <li className="video-studio-shot" data-status={shot.status} data-testid={`video-shot-${index}`}>
    {shot.clip
      ? <button type="button" className="video-studio-thumb" onClick={onOpen} aria-label={`用播放器打开第 ${index + 1} 段`} title="用播放器打开"><img src={shot.clip.thumbnailUrl} alt="" /><Play size={18} aria-hidden="true" /><b>{index + 1}</b></button>
      : <div className="video-studio-thumb is-empty" aria-hidden="true"><b>{index + 1}</b></div>}
    <div className="video-studio-shot-body">
      <Textarea label={`第 ${index + 1} 个镜头 · 画面`} value={shot.prompt} rows={3} maxLength={videoStudioPlanLimits.maximumPromptLength} disabled={busy || locked}
        onChange={(event) => onEdit({ prompt: event.target.value })} testId={`video-shot-prompt-${index}`} />
      {captions && <Input label="字幕" value={shot.caption} maxLength={videoStudioPlanLimits.maximumCaptionLength} disabled={locked} placeholder="这一镜不要字幕就空着"
        onChange={(event) => onEdit({ caption: event.target.value })} testId={`video-shot-caption-${index}`} />}
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

function ComposeProgress({ studio }: { studio: VideoStudioController }) {
  const state = studio.composeState
  if (state.phase === 'idle') return null
  const label = state.phase === 'reading' ? `正在读取第 ${state.done + 1} / ${state.total} 段`
    : state.phase === 'storing' ? '正在存进 AI 作品文件夹'
    : state.progress.stage === 'reading' ? '正在读取片段' : state.progress.stage === 'rendering' ? '正在拼接画面' : '正在写入文件'
  const value = state.phase === 'reading' ? 0 : state.phase === 'storing' ? 100 : Math.round(state.progress.ratio * 100)
  return <div className="video-studio-progress" data-testid="video-compose-progress"><Progress value={value} label={label} /></div>
}
