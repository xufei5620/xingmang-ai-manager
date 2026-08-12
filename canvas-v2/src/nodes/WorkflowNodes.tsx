import { memo } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { nodeInputKinds, nodeOutputKind, type NodeKind, type WorkflowNodeData } from '../model'
import {
  defaultImageQuality,
  defaultImageSize,
  imageModelPreset,
  imageModelPresets,
  imageQualityOptions,
  presetVideoModels,
} from '../models'
import { inputHandleId, outputHandleId } from '../ports'

/** 全画布共享的模型建议清单(datalist 只需渲染一次,App 根部挂载)。 */
export function ModelSuggestions() {
  return (
    <datalist id="wf-video-models">
      {presetVideoModels.map((model) => <option key={model} value={model} />)}
    </datalist>
  )
}

// 三种节点共用一个外壳:标题条(状态灯)/ 提示词输入 / 模型名 / 结果预览。
// 全部定义在组件树外并 memo —— React Flow 官方性能指南的第一条硬要求。

export type CanvasNode = Node<WorkflowNodeData & Record<string, unknown>, NodeKind>

const nodeTitle: Record<NodeKind, string> = {
  text: '文本',
  image: '图像生成',
  video: '视频生成',
}

const statusLabel: Record<WorkflowNodeData['status'], string> = {
  idle: '待运行',
  queued: '排队中',
  running: '生成中…',
  succeeded: '完成',
  failed: '失败',
}

interface NodeChangeHandlers {
  onPromptChange(nodeId: string, prompt: string): void
  onModelChange(nodeId: string, model: string): void
  onQualityChange(nodeId: string, quality: string): void
  onSizeChange(nodeId: string, size: string): void
  /** 单节点重跑:只执行本节点,输入取当前画布状态里上游节点的既有产物。 */
  onRerun(nodeId: string): void
  /** 媒体产物落盘(经宿主第 6 能力,主进程拉 URL 写盘)。 */
  onDownloadAsset(nodeId: string): void
  /** 断线恢复:凭已存 taskId 继续轮询视频任务。 */
  onResumeTask(nodeId: string): void
}

// React Flow 的自定义节点组件只收 NodeProps,可变回调经模块级注册表注入
// (App.tsx 挂载时注册)。比把回调塞进每个节点 data 更省重渲染。
let handlers: NodeChangeHandlers = {
  onPromptChange: () => undefined,
  onModelChange: () => undefined,
  onQualityChange: () => undefined,
  onSizeChange: () => undefined,
  onRerun: () => undefined,
  onDownloadAsset: () => undefined,
  onResumeTask: () => undefined,
}

export function registerNodeChangeHandlers(next: NodeChangeHandlers): void {
  handlers = next
}

// 端口悬浮说明 —— 图像节点的第二个输入口是"接上就变改图"的唯一线索,
// 不解释用户不会发现(节点自身看不到连线,做不成常驻提示)。
const inputPortHint: Record<NodeKind, Partial<Record<string, string>>> = {
  text: {},
  image: { text: '文本输入:作为提示词', image: '图像输入:接上即转为图生图(改图),仅 GPT Image 系支持' },
  video: { text: '文本输入:作为提示词', image: '图像输入:作为首帧参考图' },
}

function NodeShell({ id, data, kind }: { id: string; data: WorkflowNodeData; kind: NodeKind }) {
  const inputs = nodeInputKinds[kind]
  const output = nodeOutputKind[kind]
  return (
    <div className={`wf-node wf-node-${kind} wf-status-${data.status}`}>
      {inputs.map((portKind, index) => (
        <Handle
          key={portKind}
          type="target"
          id={inputHandleId(portKind)}
          position={Position.Left}
          style={{ top: 36 + index * 22 }}
          className={`wf-port wf-port-${portKind}`}
          title={inputPortHint[kind][portKind]}
        />
      ))}
      <header>
        <strong>{nodeTitle[kind]}</strong>
        <span className="wf-head-right">
          {kind !== 'text' && data.status !== 'running' && data.status !== 'queued' && (
            <button
              type="button"
              className="nodrag wf-rerun"
              title="只重跑此节点(输入取上游现有产物)"
              onClick={() => handlers.onRerun(id)}
            >重跑</button>
          )}
          <span className={`wf-status wf-status-${data.status}`}>{statusLabel[data.status]}</span>
        </span>
      </header>
      <textarea
        className="nodrag"
        value={data.prompt}
        placeholder={kind === 'text' ? '输入文本内容…' : '输入提示词…'}
        onChange={(event) => handlers.onPromptChange(id, event.target.value)}
        rows={3}
      />
      {kind === 'image' && (() => {
        const preset = imageModelPreset(data.model || imageModelPresets[0].id)
        return (
          <>
            <select
              className="nodrag wf-model"
              value={data.model || imageModelPresets[0].id}
              onChange={(event) => handlers.onModelChange(id, event.target.value)}
            >
              {imageModelPresets.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.label}</option>
              ))}
              {!imageModelPresets.some((entry) => entry.id === data.model) && data.model && (
                <option value={data.model}>{data.model}</option>
              )}
            </select>
            <div className="wf-params nodrag">
              {preset.supportsQuality && (
                <select
                  className="wf-model"
                  value={data.quality || defaultImageQuality}
                  title="画质档位(费用与耗时差异大)"
                  onChange={(event) => handlers.onQualityChange(id, event.target.value)}
                >
                  {imageQualityOptions.map((entry) => (
                    <option key={entry.value} value={entry.value}>{entry.label}</option>
                  ))}
                </select>
              )}
              <select
                className="wf-model"
                value={preset.sizes.includes(data.size || '') ? (data.size as string) : (preset.sizes[0] ?? defaultImageSize)}
                title="输出尺寸"
                onChange={(event) => handlers.onSizeChange(id, event.target.value)}
              >
                {preset.sizes.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </div>
          </>
        )
      })()}
      {kind === 'video' && (
        <input
          className="nodrag wf-model"
          value={data.model}
          list="wf-video-models"
          placeholder="视频模型(渠道接入后可用)"
          onChange={(event) => handlers.onModelChange(id, event.target.value)}
        />
      )}
      {data.status === 'failed' && data.errorMessage && (
        <p className="wf-error" role="alert">{data.errorMessage}</p>
      )}
      {data.result?.remoteUrl && data.result.kind === 'image' && !data.result.remoteUrl.startsWith('mock://') && (
        <img className="wf-preview" src={data.result.remoteUrl} alt="生成结果" loading="lazy" />
      )}
      {data.result?.remoteUrl && (data.result.remoteUrl.startsWith('mock://') || data.result.kind === 'video') && (
        <p className="wf-result-note">产物:{data.result.remoteUrl.slice(0, 120)}</p>
      )}
      {kind === 'image' && data.result?.remoteUrl?.startsWith('https://') && imageModelPreset(data.model).ephemeralUrl && (
        <p className="wf-result-note">⚠️ 该模型的图片链接 24 小时后过期,请尽快下载保存</p>
      )}
      {typeof data.costQuota === 'number' && data.costQuota > 0 && (
        <p className="wf-cost">本次消耗 {data.costQuota} quota</p>
      )}
      <div className="wf-actions">
        {data.result?.remoteUrl && !data.result.remoteUrl.startsWith('mock://') && (
          <button
            type="button"
            className="nodrag wf-rerun"
            title="把生成产物保存到本机"
            onClick={() => handlers.onDownloadAsset(id)}
          >下载</button>
        )}
        {kind === 'video' && data.result?.taskId && !data.result.remoteUrl
          && data.status !== 'running' && data.status !== 'queued' && (
          <button
            type="button"
            className="nodrag wf-rerun"
            title="凭已保存的任务 ID 继续查询生成结果(断线恢复)"
            onClick={() => handlers.onResumeTask(id)}
          >续查任务</button>
        )}
      </div>
      <Handle
        type="source"
        id={outputHandleId(output)}
        position={Position.Right}
        className={`wf-port wf-port-${output}`}
      />
    </div>
  )
}

function TextNodeComponent({ id, data }: NodeProps<CanvasNode>) {
  return <NodeShell id={id} data={data} kind="text" />
}

function ImageNodeComponent({ id, data }: NodeProps<CanvasNode>) {
  return <NodeShell id={id} data={data} kind="image" />
}

function VideoNodeComponent({ id, data }: NodeProps<CanvasNode>) {
  return <NodeShell id={id} data={data} kind="video" />
}

export const nodeTypes = {
  text: memo(TextNodeComponent),
  image: memo(ImageNodeComponent),
  video: memo(VideoNodeComponent),
}
