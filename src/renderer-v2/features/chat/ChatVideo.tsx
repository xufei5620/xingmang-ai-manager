import { useState } from 'react'
import { ArrowUpRight, Clapperboard, Download, Film, MoreHorizontal, Play, Plus, RefreshCw, Square } from 'lucide-react'
import { missingAiAssetMessages } from '../../../../electron/ai-asset-missing'
import type { AiVideoClip } from '../../../../electron/ipc-contract'
import { Button, Menu, Progress } from '../../ui'
import { videoClipPlayUrl } from '../video-studio/clip'
import { chatVideoDetail, chatVideoDuration, chatVideoProgressText, type ChatVideoProgress } from './video'

// 对话里的一段视频（融合第 2 步）：等着的那一块，和出好以后的那一段。字是方案第 2.6 节那几句，按 2026-11-21 定的正式口吻重写过。

/** 「添加到视频」菜单里的一条视频。full：镜头已经满了，放不进去。 */
export interface ChatVideoFilm { id: string; title: string; detail: string; full?: boolean }

export function ChatVideoPending({ progress, stopping, onStop }: { progress?: ChatVideoProgress; stopping: boolean; onStop: () => void }) {
  const text = chatVideoProgressText(progress)
  return <div className="chat-video" data-state="pending" data-testid="chat-video-pending">
    <div className="chat-video-frame"><span className="chat-generating" role="status"><RefreshCw size={15} aria-hidden="true" />{text}</span></div>
    {progress?.value !== undefined && progress.stage !== 'saving' && <Progress value={progress.value} testId="chat-video-progress" />}
    <p className="chat-video-hint">生成需要几分钟，可先进行其他操作，完成后将保留在此处</p>
    <div className="chat-asset-actions"><Button size="xs" icon={Square} variant="ghost" loading={stopping} onClick={onStop} testId="chat-video-stop">停止</Button></div>
  </div>
}

interface ChatVideoClipProps {
  clip: AiVideoClip
  /** 给了才有「添加到视频」（这个账号用得了出视频时）。 */
  films?: readonly ChatVideoFilm[]
  onCompose: (filmId: string | null) => void
  onSave: () => void
  onOpen: () => void
}

export function ChatVideoClip({ clip, films, onCompose, onSave, onOpen }: ChatVideoClipProps) {
  // 点了才放：先只摆第一帧的图，一屏十几段视频不会一起去读文件。
  const [playing, setPlaying] = useState(false)
  const [missing, setMissing] = useState(false)
  const [thumbnailFailed, setThumbnailFailed] = useState(false)
  const detail = chatVideoDetail(clip), duration = chatVideoDuration(clip)
  return <div className="chat-video" data-state="done" data-testid="chat-video">
    <div className="chat-video-frame" data-portrait={clip.width && clip.height && clip.height > clip.width ? 'true' : undefined}>
      {missing ? <p className="chat-video-missing" role="alert">{missingAiAssetMessages.video}</p>
        : playing ? <video src={videoClipPlayUrl(clip.assetId)} poster={thumbnailFailed ? undefined : clip.thumbnailUrl} controls autoPlay playsInline onError={() => { setPlaying(false); setMissing(true) }} data-testid="chat-video-player" />
          : <button type="button" className="chat-video-play" aria-label="播放" title="播放" onClick={() => setPlaying(true)} data-testid="chat-video-play">
            {!thumbnailFailed && <img src={clip.thumbnailUrl} alt="" loading="lazy" decoding="async" onError={() => setThumbnailFailed(true)} />}
            <span className="chat-video-play-mark" aria-hidden="true"><Play size={22} /></span>
            {duration && <b>{duration}</b>}
          </button>}
    </div>
    <div className="chat-asset-actions">
      {films && <Menu label="选择要添加到的视频" heading="选择要添加到的视频" align="start" anchor={<Button size="xs" icon={Film} variant="ghost" testId="chat-video-compose">添加到视频</Button>} items={[
        { label: '新建视频', icon: Plus, testId: 'chat-video-compose-new', onSelect: () => onCompose(null) },
        ...(films.length ? ['divider' as const] : []),
        ...films.map((film) => ({ label: film.title, hint: film.detail, icon: Clapperboard, disabled: film.full, testId: `chat-video-compose-${film.id}`, onSelect: () => onCompose(film.id) })),
      ]} />}
      <Button size="xs" icon={Download} variant="ghost" aria-label="另存视频" title="另存视频" onClick={onSave} testId="chat-video-save" />
      <Menu label="更多操作" align="start" anchor={<Button size="xs" icon={MoreHorizontal} variant="ghost" aria-label="更多操作" title="更多操作" testId="chat-video-menu" />} items={[{ label: '用播放器打开', icon: ArrowUpRight, testId: 'chat-video-open', onSelect: onOpen }]} />
      {detail && <small>{detail}</small>}
    </div>
  </div>
}
