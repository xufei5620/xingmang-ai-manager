import { useRef, useState } from 'react'
import type { NodeExecutor } from './engine/engine'
import type { AssetRef, NodeKind, WorkflowFile } from './model'
import { hostBridge } from './host'

// 简单模式 = 单节点工作流的固定表单形态(M2 双模式,规划第 1 节):
// 小白用户不见画布也能出图/出片;「展开到画布」把同一次输入物化成
// 文本→图像(→视频)节点链,交给画布继续加工——两种模式共享同一套
// executors,不维护第二份生成逻辑。

interface SimpleModeProps {
  executors: Record<NodeKind, NodeExecutor>
  connected: boolean
  onExpandToCanvas(workflow: WorkflowFile): void
}

let simpleSequence = 0

function simpleNodeId(): string {
  simpleSequence += 1
  return `s${Date.now().toString(36)}-${simpleSequence}`
}

export function SimpleMode({ executors, connected, onExpandToCanvas }: SimpleModeProps) {
  const [prompt, setPrompt] = useState('')
  const [imageModel, setImageModel] = useState('')
  const [wantVideo, setWantVideo] = useState(false)
  const [videoModel, setVideoModel] = useState('')
  const [videoPrompt, setVideoPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [image, setImage] = useState<AssetRef | null>(null)
  const [video, setVideo] = useState<AssetRef | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const generate = async () => {
    if (busy) return
    setError(null)
    setImage(null)
    setVideo(null)
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      setStage('正在生成图像…')
      const imageResult = await executors.image(
        {
          id: simpleNodeId(),
          kind: 'image',
          position: { x: 0, y: 0 },
          data: { prompt, model: imageModel, status: 'idle' },
        },
        {},
        controller.signal,
      )
      const imageAsset = imageResult.output.asset ?? null
      setImage(imageAsset)
      if (wantVideo) {
        setStage('正在生成视频(可能需要一两分钟)…')
        const videoResult = await executors.video(
          {
            id: simpleNodeId(),
            kind: 'video',
            position: { x: 0, y: 0 },
            data: { prompt: videoPrompt, model: videoModel, status: 'idle' },
          },
          { image: imageAsset ?? undefined },
          controller.signal,
        )
        setVideo(videoResult.output.asset ?? null)
      }
      setStage('完成')
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : String(generateError))
      setStage(null)
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  const expand = () => {
    const textId = simpleNodeId()
    const imageId = simpleNodeId()
    const workflow: WorkflowFile = {
      schemaVersion: 1,
      name: '来自简单模式',
      nodes: [
        { id: textId, kind: 'text', position: { x: 60, y: 160 }, data: { prompt, model: '', status: prompt ? 'succeeded' : 'idle' } },
        {
          id: imageId,
          kind: 'image',
          position: { x: 360, y: 140 },
          data: { prompt: '', model: imageModel, status: image ? 'succeeded' : 'idle', result: image ?? undefined },
        },
      ],
      edges: [
        { id: `${textId}->${imageId}`, source: textId, sourceHandle: 'out:text', target: imageId, targetHandle: 'in:text' },
      ],
    }
    if (wantVideo) {
      const videoId = simpleNodeId()
      workflow.nodes.push({
        id: videoId,
        kind: 'video',
        position: { x: 660, y: 140 },
        data: { prompt: videoPrompt, model: videoModel, status: video ? 'succeeded' : 'idle', result: video ?? undefined },
      })
      workflow.edges.push({
        id: `${imageId}->${videoId}`,
        source: imageId,
        sourceHandle: 'out:image',
        target: videoId,
        targetHandle: 'in:image',
      })
    }
    onExpandToCanvas(workflow)
  }

  const download = (asset: AssetRef) => {
    if (!asset.remoteUrl) return
    const suggestedName = asset.kind === 'image' ? 'xingmang-image.png' : 'xingmang-video.mp4'
    void hostBridge().downloadAsset(asset.remoteUrl, suggestedName)
  }

  return (
    <div className="simple-mode">
      <div className="simple-card">
        <h1>AI 生成</h1>
        <p className="simple-hint">{connected ? '已连接星芒账号,生成消耗账户额度' : '演示模式:未连接账号,生成为模拟结果'}</p>
        <label>
          <span>想要生成什么?</span>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder="描述画面,例如:一只在霓虹雨夜里撑伞的橘猫" />
        </label>
        <label>
          <span>图像模型</span>
          <input value={imageModel} onChange={(event) => setImageModel(event.target.value)} placeholder="模型名(渠道配置后填写)" />
        </label>
        <label className="simple-check">
          <input type="checkbox" checked={wantVideo} onChange={(event) => setWantVideo(event.target.checked)} />
          <span>继续用这张图生成视频</span>
        </label>
        {wantVideo && (
          <>
            <label>
              <span>视频提示词</span>
              <textarea value={videoPrompt} onChange={(event) => setVideoPrompt(event.target.value)} rows={2} placeholder="描述镜头运动与氛围" />
            </label>
            <label>
              <span>视频模型</span>
              <input value={videoModel} onChange={(event) => setVideoModel(event.target.value)} placeholder="模型名(渠道配置后填写)" />
            </label>
          </>
        )}
        <div className="simple-actions">
          {busy
            ? <button type="button" onClick={() => abortRef.current?.abort()}>取消</button>
            : <button type="button" className="simple-primary" onClick={() => void generate()} disabled={!prompt.trim()}>生成</button>}
          <button type="button" onClick={expand} disabled={!prompt.trim()}>展开到画布</button>
        </div>
        {stage && <p className="simple-stage">{stage}</p>}
        {error && <p className="simple-error" role="alert">{error}</p>}
        {image?.remoteUrl && !image.remoteUrl.startsWith('mock://') && (
          <div className="simple-result">
            <img src={image.remoteUrl} alt="生成的图像" />
            <button type="button" onClick={() => download(image)}>下载图像</button>
          </div>
        )}
        {video?.remoteUrl && (
          <div className="simple-result">
            <p>视频已生成:{video.remoteUrl.startsWith('mock://') ? '(模拟产物)' : video.remoteUrl}</p>
            {!video.remoteUrl.startsWith('mock://') && (
              <button type="button" onClick={() => download(video)}>下载视频</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
