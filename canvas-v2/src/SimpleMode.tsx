import { useEffect, useMemo, useRef, useState } from 'react'
import type { NodeExecutor } from './engine/engine'
import type { AssetRef, NodeKind, WorkflowFile } from './model'
import {
  defaultImageModel,
  defaultImageQuality,
  defaultImageResolution,
  availableImageModelPresets,
  availableVideoModelPresets,
  imageModelPreset,
  imageModelPresets,
  imageQualityOptions,
  imageResolutionOptions,
  videoModelPresets,
} from './models'
import { SafeImage } from './components/MediaPreview'
import { hostBridge } from './host'

// 简单模式 = 单节点工作流的固定表单形态(M2 双模式,规划第 1 节):
// 小白用户不见画布也能出图/出片;「展开到画布」把同一次输入物化成
// 文本→图像(→视频)节点链,交给画布继续加工——两种模式共享同一套
// executors,不维护第二份生成逻辑。

interface SimpleModeProps {
  executors: Record<NodeKind, NodeExecutor>
  connected: boolean
  imageGroup: string | null
  videoGroup: string | null
  imageModels: readonly string[]
  videoModels: readonly string[]
  preparingMedia: boolean
  onExpandToCanvas(workflow: WorkflowFile): void
}

let simpleSequence = 0

function simpleNodeId(): string {
  simpleSequence += 1
  return `s${Date.now().toString(36)}-${simpleSequence}`
}

export function SimpleMode({
  executors,
  connected,
  imageGroup,
  videoGroup,
  imageModels,
  videoModels,
  preparingMedia,
  onExpandToCanvas,
}: SimpleModeProps) {
  const [prompt, setPrompt] = useState('')
  const [imageModel, setImageModel] = useState(defaultImageModel)
  const [imageQuality, setImageQuality] = useState(defaultImageQuality)
  const [imageResolution, setImageResolution] = useState(defaultImageResolution)
  const [imageSize, setImageSize] = useState(imageModelPreset(defaultImageModel).sizes[0])
  const modelPreset = imageModelPreset(imageModel)
  const [wantVideo, setWantVideo] = useState(false)
  const [videoModel, setVideoModel] = useState('')
  const [videoPrompt, setVideoPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [image, setImage] = useState<AssetRef | null>(null)
  const [video, setVideo] = useState<AssetRef | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const imagePresets = useMemo(
    () => connected ? availableImageModelPresets(imageModels) : [...imageModelPresets],
    [connected, imageModels],
  )
  const videoPresets = useMemo(
    () => connected ? availableVideoModelPresets(videoModels) : [...videoModelPresets],
    [connected, videoModels],
  )
  const imageModelAvailable = imagePresets.some((preset) => preset.id === imageModel)
  const videoModelAvailable = videoPresets.some((preset) => preset.id === videoModel)
  const generationBlocked = preparingMedia
    || !prompt.trim()
    || (connected && (!imageGroup || !imageModelAvailable || (wantVideo && (!videoGroup || !videoModelAvailable))))

  useEffect(() => {
    if (imagePresets.some((preset) => preset.id === imageModel)) return
    setImageModel(imagePresets[0]?.id ?? '')
  }, [imageModel, imagePresets])

  useEffect(() => {
    if (videoPresets.some((preset) => preset.id === videoModel)) return
    setVideoModel(videoPresets[0]?.id ?? '')
  }, [videoModel, videoPresets])

  const generate = async () => {
    if (busy) return
    if (preparingMedia) {
      setError('生成配置正在准备，请稍候')
      return
    }
    if (connected && !imageGroup) {
      setError('请先在顶部「生成配置」中选择生图分组')
      return
    }
    const selectedImagePreset = imagePresets.find((preset) => preset.id === imageModel)
    if (connected && !selectedImagePreset) {
      setError(`生图分组「${imageGroup ?? '未选择'}」没有可用的图像模型`)
      return
    }
    if (connected && wantVideo && !videoGroup) {
      setError('请先在顶部「生成配置」中选择视频分组')
      return
    }
    const selectedVideoPreset = videoPresets.find((preset) => preset.id === videoModel)
    if (connected && wantVideo && !selectedVideoPreset) {
      setError(`视频分组「${videoGroup ?? '未选择'}」没有可用的视频模型`)
      return
    }
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
          data: {
            prompt,
            model: imageModel,
            quality: imageQuality,
            imageResolution,
            size: modelPreset.sizes.includes(imageSize) ? imageSize : modelPreset.sizes[0],
            status: 'idle',
          },
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
      mediaGroups: {
        ...(imageGroup ? { image: imageGroup } : {}),
        ...(videoGroup ? { video: videoGroup } : {}),
      },
      nodes: [
        { id: textId, kind: 'text', position: { x: 60, y: 160 }, data: { prompt, model: '', status: prompt ? 'succeeded' : 'idle' } },
        {
          id: imageId,
          kind: 'image',
          position: { x: 360, y: 140 },
          data: {
            prompt: '', model: imageModel, quality: imageQuality, imageResolution,
            size: modelPreset.sizes.includes(imageSize) ? imageSize : modelPreset.sizes[0],
            status: image ? 'succeeded' : 'idle', result: image ?? undefined,
          },
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
        targetHandle: 'in:images',
      })
    }
    onExpandToCanvas(workflow)
  }

  const download = (asset: AssetRef) => {
    if (!asset.assetId) return
    void hostBridge().saveAsset(asset.assetId)
  }

  return (
    <div className="simple-mode">
      <div className="simple-card">
        <h1>AI 生成</h1>
        <p className="simple-hint">{connected
          ? `图片${imageGroup ? `使用「${imageGroup}」` : '未配置'} · 视频${videoGroup ? `使用「${videoGroup}」` : '未配置'}`
          : '演示模式:未连接账号,生成为模拟结果'}</p>
        <label>
          <span>想要生成什么?</span>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder="描述画面,例如:一只在霓虹雨夜里撑伞的橘猫" />
        </label>
        <label>
          <span>图像模型</span>
          <select
            value={imageModel}
            disabled={preparingMedia}
            onChange={(event) => {
              const nextModel = event.target.value
              setImageModel(nextModel)
              const sizes = imageModelPreset(nextModel).sizes
              if (!sizes.includes(imageSize)) setImageSize(sizes[0])
              const resolutions = imageModelPreset(nextModel).resolutions
              if (!resolutions.includes(imageResolution)) setImageResolution(resolutions[0] ?? defaultImageResolution)
            }}
          >
            {imagePresets.length === 0 && <option value="">当前分组没有可用图像模型</option>}
            {imagePresets.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.label}</option>
            ))}
          </select>
        </label>
        <div className="simple-params">
          {modelPreset.supportsQuality && (
            <label>
              <span>画质</span>
              <select value={imageQuality} onChange={(event) => setImageQuality(event.target.value)}>
                {imageQualityOptions.map((entry) => (
                  <option key={entry.value} value={entry.value}>{entry.label}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>清晰度</span>
            <select value={modelPreset.resolutions.includes(imageResolution) ? imageResolution : modelPreset.resolutions[0]} onChange={(event) => setImageResolution(event.target.value as typeof imageResolution)}>
              {imageResolutionOptions.map((entry) => <option key={entry.value} value={entry.value} disabled={!modelPreset.resolutions.includes(entry.value)}>{entry.label}{modelPreset.resolutions.includes(entry.value) ? '' : '（当前模型不支持）'}</option>)}
            </select>
          </label>
          {modelPreset.supportsSize && (
            <label>
              <span>尺寸</span>
              <select value={modelPreset.sizes.includes(imageSize) ? imageSize : modelPreset.sizes[0]} onChange={(event) => setImageSize(event.target.value)}>
                {modelPreset.sizes.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
          )}
        </div>
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
              <select value={videoModel} disabled={preparingMedia} onChange={(event) => setVideoModel(event.target.value)}>
                {videoPresets.length === 0 && <option value="">当前分组没有可用视频模型</option>}
                {videoPresets.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
            </label>
          </>
        )}
        <div className="simple-actions">
          {busy
            ? <button type="button" onClick={() => abortRef.current?.abort()}>取消</button>
            : <button
                type="button"
                className="simple-primary"
                onClick={() => void generate()}
                disabled={generationBlocked}
              >生成</button>}
          <button type="button" onClick={expand} disabled={preparingMedia || !prompt.trim()}>展开到画布</button>
        </div>
        {stage && <p className="simple-stage">{stage}</p>}
        {error && <p className="simple-error" role="alert">{error}</p>}
        {image?.localUrl && (
          <div className="simple-result">
            <SafeImage src={image.localUrl} alt="生成的图像" fallbackLabel="生成图片不可用" onContextMenu={(event) => {
              event.preventDefault()
              if (image.assetId) void hostBridge().showAssetMenu(image.assetId)
            }} />
            <button type="button" onClick={() => download(image)}>下载图像</button>
          </div>
        )}
        {image?.remoteUrl?.startsWith('mock://') && <p className="simple-stage">演示图片已生成</p>}
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
