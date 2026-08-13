import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { AlertCircle, BookmarkPlus, Check, CheckCircle2, Circle, Clock3, FolderOpen, LoaderCircle, MoreHorizontal, Play, Upload } from 'lucide-react'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { NodeDefinition } from '../domain/node-definition'
import type { AssetRef, NodeKind, WorkflowNodeData } from '../model'
import {
  defaultImageQuality,
  defaultImageSize,
  imageModelPreset,
  imageModelPresets,
  imageQualityOptions,
  presetVideoModels,
} from '../models'
import { SafeImage, ViewportVideo, isLocalCanvasAssetUrl } from '../components/MediaPreview'

export function ModelSuggestions() {
  return (
    <datalist id="wf-video-models">
      {presetVideoModels.map((model) => <option key={model} value={model} />)}
    </datalist>
  )
}

export type CanvasNode = Node<WorkflowNodeData & Record<string, unknown>, NodeKind> & {
  definitionVersion: number
  disabled?: boolean
  unknownKind?: string
}

const statusLabel: Record<WorkflowNodeData['status'], string> = {
  idle: '待运行',
  queued: '排队中',
  running: '生成中',
  succeeded: '完成',
  failed: '失败',
}

const statusIcon = {
  idle: Circle,
  queued: Clock3,
  running: LoaderCircle,
  succeeded: CheckCircle2,
  failed: AlertCircle,
} satisfies Record<WorkflowNodeData['status'], typeof Circle>

interface NodeChangeHandlers {
  onPromptChange(nodeId: string, prompt: string): void
  onModelChange(nodeId: string, model: string): void
  onQualityChange(nodeId: string, quality: string): void
  onSizeChange(nodeId: string, size: string): void
  onSettingsChange(nodeId: string, patch: Record<string, unknown>): void
  onSavePromptPreset(nodeId: string): void
  onRerun(nodeId: string): void
  onDownloadAsset(nodeId: string): void
  onShowAssetMenu(nodeId: string): void
  onResumeTask(nodeId: string): void
  onSelectCandidate(nodeId: string, candidateId: string): void
  onAdoptCandidate(nodeId: string, candidateId: string): void
  onShowCandidateMenu(assetId: string): void
  onBindAsset(nodeId: string, assetId: string): void
  onPickAsset(nodeId: string): void
  onImportAssetFile(nodeId: string, file: File): void
  onPreviewAsset(asset: AssetRef): void
}

let handlers: NodeChangeHandlers = {
  onPromptChange: () => undefined,
  onModelChange: () => undefined,
  onQualityChange: () => undefined,
  onSizeChange: () => undefined,
  onSettingsChange: () => undefined,
  onSavePromptPreset: () => undefined,
  onRerun: () => undefined,
  onDownloadAsset: () => undefined,
  onShowAssetMenu: () => undefined,
  onResumeTask: () => undefined,
  onSelectCandidate: () => undefined,
  onAdoptCandidate: () => undefined,
  onShowCandidateMenu: () => undefined,
  onBindAsset: () => undefined,
  onPickAsset: () => undefined,
  onImportAssetFile: () => undefined,
  onPreviewAsset: () => undefined,
}

export function registerNodeChangeHandlers(next: NodeChangeHandlers): void {
  handlers = next
}

function textSetting(data: WorkflowNodeData, key: string, fallback = ''): string {
  const value = data.settings?.[key]
  return typeof value === 'string' ? value : fallback
}

function numberSetting(data: WorkflowNodeData, key: string, fallback: number): number {
  const value = data.settings?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function supportsPrompt(kind: NodeKind): boolean {
  return ['text', 'prompt', 'image', 'video', 'image-generate', 'image-edit', 'video-generate'].includes(kind)
}

function supportsModel(kind: NodeKind): boolean {
  return ['image', 'video', 'image-generate', 'image-edit', 'video-generate'].includes(kind)
}

function NodeSettings({ id, data, kind }: { id: string; data: WorkflowNodeData; kind: NodeKind }) {
  if (kind === 'note') {
    return (
      <textarea
        className="nodrag wf-note"
        aria-label="备注内容"
        value={textSetting(data, 'text')}
        placeholder="记录思路、参数或交付说明"
        onChange={(event) => handlers.onSettingsChange(id, { text: event.target.value })}
        rows={5}
      />
    )
  }
  if (kind === 'group') {
    return (
      <input
        className="nodrag wf-model"
        value={textSetting(data, 'title', '新建分组')}
        aria-label="分组名称"
        onChange={(event) => handlers.onSettingsChange(id, { title: event.target.value })}
      />
    )
  }
  if (kind === 'image-input') {
    return (
      <div
        className={`wf-drop-target nodrag${data.result?.assetId ? ' has-asset' : ''}`}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('application/x-xingmang-asset-id') || event.dataTransfer.types.includes('Files')) {
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = 'copy'
            event.currentTarget.classList.add('is-drag-over')
          }
        }}
        onDragLeave={(event) => event.currentTarget.classList.remove('is-drag-over')}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          event.currentTarget.classList.remove('is-drag-over')
          const assetId = event.dataTransfer.getData('application/x-xingmang-asset-id')
          if (assetId) handlers.onBindAsset(id, assetId)
          else if (event.dataTransfer.files[0]) handlers.onImportAssetFile(id, event.dataTransfer.files[0])
        }}
      >
        <Upload size={16} aria-hidden="true" />
        <span>{data.result?.assetId ? '拖入其他图片可替换素材' : '将图片拖到这里'}</span>
        <button type="button" className="wf-pick-asset" onClick={() => handlers.onPickAsset(id)}>
          <FolderOpen size={13} aria-hidden="true" />从文件选择
        </button>
      </div>
    )
  }
  if (kind === 'video-input') return <div className="wf-gallery-empty">视频素材导入将在视频链路启用后开放</div>
  if (kind === 'frame-extract') {
    return (
      <label className="wf-inline-field nodrag">
        <span>时间点</span>
        <input
          type="number"
          aria-label="提取时间点（秒）"
          min="0"
          step="0.1"
          value={numberSetting(data, 'timestampSeconds', 0)}
          onChange={(event) => handlers.onSettingsChange(id, { timestampSeconds: Number(event.target.value) })}
        />
        <span>秒</span>
      </label>
    )
  }
  if (kind === 'router') {
    return (
      <select
        className="nodrag wf-model"
        aria-label="路由策略"
        value={textSetting(data, 'strategy', 'first-available')}
        onChange={(event) => handlers.onSettingsChange(id, { strategy: event.target.value })}
      >
        <option value="first-available">优先使用首个可用输入</option>
        <option value="all">保留全部输入</option>
      </select>
    )
  }
  if (kind === 'gallery') {
    const count = data.candidateAssetIds?.length ?? (data.result?.assetId ? 1 : 0)
    return <div className="wf-gallery-empty">{count > 0 ? `${count} 个候选，可在运行结果中采纳` : '运行生成节点后在此汇总候选'}</div>
  }
  if (kind === 'output') {
    return <p className="wf-result-note">{data.result?.assetId ? '最终产物已确认' : '连接并采纳上游结果后完成交付'}</p>
  }
  if (kind === 'unknown') {
    return <p className="wf-error">{data.errorMessage || '当前版本无法识别这个节点'}</p>
  }
  return null
}

function NodeShell({ id, data, kind }: { id: string; data: WorkflowNodeData & Record<string, unknown>; kind: NodeKind }) {
  const definition = builtinNodeRegistry.resolve(kind) ?? builtinNodeRegistry.require('unknown')
  const disabled = data.__canvasDisabled === true
  const inputs = definition.ports.filter((port) => port.direction === 'input')
  const outputs = definition.ports.filter((port) => port.direction === 'output')
  const imageOperation = kind === 'image' || kind === 'image-generate' || kind === 'image-edit'
  const videoOperation = kind === 'video' || kind === 'video-generate'
  const canRunNode = !disabled && ['image', 'video', 'image-generate', 'image-edit', 'video-generate', 'frame-extract'].includes(kind)
  const nodeRunning = data.status === 'running' || data.status === 'queued'
  const selectedCandidate = data.candidates?.find((candidate) => candidate.candidateId === data.selectedCandidateId)
    ?? data.candidates?.find((candidate) => candidate.candidateId === data.adoptedCandidateId)
    ?? data.candidates?.[0]
  const displayedResult = selectedCandidate?.asset ?? data.result
  const StatusIcon = statusIcon[data.status]

  return (
    <div className={`wf-node wf-node-${kind} wf-category-${definition.category} wf-status-${data.status}${data.dirty ? ' wf-is-dirty' : ''}${disabled ? ' wf-is-disabled' : ''}`}>
      {inputs.map((port, index) => (
        <Handle
          key={port.id}
          type="target"
          id={port.id}
          position={Position.Left}
          style={{ top: 52 + index * 26 }}
          className={`wf-port wf-port-${port.kind}`}
          title={port.label}
        />
      ))}
      <header>
        <span className="wf-node-title">
          <strong>{definition.title}</strong>
          <small>{definition.description}</small>
        </span>
        <span className="wf-head-right">
          {supportsPrompt(kind) && data.prompt.trim() && (
            <button type="button" className="nodrag wf-icon-command" title="保存为提示词预设" aria-label="保存为提示词预设" onClick={() => handlers.onSavePromptPreset(id)}><BookmarkPlus size={14} /></button>
          )}
          <span className={`wf-status wf-status-${data.status}`}><StatusIcon size={12} aria-hidden="true" />{statusLabel[data.status]}</span>
          {disabled && <span className="wf-disabled" title="此节点不会参与运行">已禁用</span>}
          {data.dirty && <span className="wf-dirty" title="输入或采纳结果已变化，需要重新运行">待更新</span>}
        </span>
      </header>

      {supportsPrompt(kind) && (
        <textarea
          className="nodrag"
          aria-label={`${definition.title}提示词`}
          value={data.prompt}
          placeholder={kind === 'text' || kind === 'prompt' ? '输入提示词或指令' : '补充这个节点的提示词'}
          onChange={(event) => handlers.onPromptChange(id, event.target.value)}
          rows={3}
        />
      )}

      {imageOperation && (() => {
        const preset = imageModelPreset(data.model || imageModelPresets[0].id)
        return (
          <>
            <select className="nodrag wf-model" aria-label="图像模型" value={data.model || imageModelPresets[0].id} onChange={(event) => handlers.onModelChange(id, event.target.value)}>
              {imageModelPresets.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              {!imageModelPresets.some((entry) => entry.id === data.model) && data.model && <option value={data.model}>{data.model}</option>}
            </select>
            <div className="wf-params nodrag">
              {preset.supportsQuality && (
                <select className="wf-model" value={data.quality || defaultImageQuality} title="画质" aria-label="生成画质" onChange={(event) => handlers.onQualityChange(id, event.target.value)}>
                  {imageQualityOptions.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                </select>
              )}
              <select className="wf-model" value={preset.sizes.includes(data.size || '') ? data.size : (preset.sizes[0] ?? defaultImageSize)} title="尺寸" aria-label="生成尺寸" onChange={(event) => handlers.onSizeChange(id, event.target.value)}>
                {preset.sizes.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </div>
          </>
        )
      })()}

      {videoOperation && supportsModel(kind) && (
        <input className="nodrag wf-model" aria-label="视频模型" value={data.model} list="wf-video-models" placeholder="选择或输入视频模型" onChange={(event) => handlers.onModelChange(id, event.target.value)} />
      )}

      <NodeSettings id={id} data={data} kind={kind} />

      {data.status === 'failed' && data.errorMessage && kind !== 'unknown' && <p className="wf-error" role="alert">{data.errorMessage}</p>}
      {displayedResult?.localUrl && displayedResult.kind === 'image' && (
        <SafeImage
          className="wf-preview"
          src={displayedResult.localUrl}
          alt={selectedCandidate ? '生成候选预览' : '生成结果'}
          loading="lazy"
          title="双击放大预览"
          onDoubleClick={(event) => {
            event.stopPropagation()
            handlers.onPreviewAsset(displayedResult)
          }}
          onContextMenu={(event) => {
            event.preventDefault()
            if (selectedCandidate?.asset.assetId) handlers.onShowCandidateMenu(selectedCandidate.asset.assetId)
            else handlers.onShowAssetMenu(id)
          }}
        />
      )}
      {displayedResult?.kind === 'video' && isLocalCanvasAssetUrl(displayedResult.localUrl) && (
        <ViewportVideo className="wf-preview" src={displayedResult.localUrl} controls />
      )}
      {data.result?.remoteUrl && (data.result.remoteUrl.startsWith('mock://') || data.result.kind === 'video') && <p className="wf-result-note">产物：{data.result.remoteUrl.slice(0, 120)}</p>}
      {typeof data.costQuota === 'number' && data.costQuota > 0 && <p className="wf-cost">本次消耗 {data.costQuota} quota</p>}
      {data.candidates && data.candidates.length > 0 && (
        <div className="wf-candidates nodrag">
          <div className="wf-candidate-strip" aria-label="生成候选">
            {data.candidates.map((candidate, index) => (
              <button
                key={candidate.candidateId}
                type="button"
                className={candidate.candidateId === selectedCandidate?.candidateId ? 'is-selected' : ''}
                title={`预览候选 ${index + 1}`}
                aria-label={`预览候选 ${index + 1}`}
                onClick={() => handlers.onSelectCandidate(id, candidate.candidateId)}
              >
                {candidate.asset.kind === 'image' && candidate.asset.localUrl
                  ? <SafeImage src={candidate.asset.localUrl} alt="" fallbackLabel="候选不可用" />
                  : <span>{index + 1}</span>}
              </button>
            ))}
          </div>
          {selectedCandidate && (
            <div className="wf-candidate-actions">
              <button
                type="button"
                className="wf-rerun"
                disabled={selectedCandidate.candidateId === data.adoptedCandidateId}
                onClick={() => handlers.onAdoptCandidate(id, selectedCandidate.candidateId)}
              >
                <Check size={12} />{selectedCandidate.candidateId === data.adoptedCandidateId ? '已采纳' : '采纳此候选'}
              </button>
              <button
                type="button"
                className="wf-icon-command"
                title="候选资产操作"
                aria-label="候选资产操作"
                onClick={() => selectedCandidate.asset.assetId && handlers.onShowCandidateMenu(selectedCandidate.asset.assetId)}
              ><MoreHorizontal size={14} /></button>
            </div>
          )}
        </div>
      )}
      {(data.attemptCount || data.latestAttemptDurationMs !== undefined) && (
        <p className="wf-runtime-meta">
          {data.attemptCount ? `${data.attemptCount} 次尝试` : ''}
          {data.attemptCount && data.latestAttemptDurationMs !== undefined ? ' · ' : ''}
          {data.latestAttemptDurationMs !== undefined ? `${(data.latestAttemptDurationMs / 1000).toFixed(1)} 秒` : ''}
        </p>
      )}
      <div className="wf-actions">
        {canRunNode && (
          <button
            type="button"
            className="nodrag wf-run-node"
            aria-label={`运行${definition.title}节点`}
            title="使用已有上游结果运行此节点"
            disabled={nodeRunning}
            onClick={() => handlers.onRerun(id)}
          >
            {nodeRunning ? <LoaderCircle size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
            {nodeRunning ? '运行中' : '运行此节点'}
          </button>
        )}
        {data.result?.assetId && <button type="button" className="nodrag wf-rerun" onClick={() => handlers.onDownloadAsset(id)}>另存</button>}
        {videoOperation && data.result?.taskId && !data.result.remoteUrl && data.status !== 'running' && data.status !== 'queued' && (
          <button type="button" className="nodrag wf-rerun" onClick={() => handlers.onResumeTask(id)}>续查任务</button>
        )}
      </div>
      {outputs.map((port, index) => (
        <Handle
          key={port.id}
          type="source"
          id={port.id}
          position={Position.Right}
          style={{ top: 52 + index * 26 }}
          className={`wf-port wf-port-${port.kind}`}
          title={port.label}
        />
      ))}
    </div>
  )
}

function createRenderer(definition: NodeDefinition) {
  const Renderer = ({ id, data }: NodeProps<CanvasNode>) => <NodeShell id={id} data={data} kind={definition.type as NodeKind} />
  Renderer.displayName = `${definition.type}Node`
  return memo(Renderer)
}

export const nodeTypes = Object.fromEntries(
  builtinNodeRegistry.list().map((definition) => [definition.type, createRenderer(definition)]),
)
