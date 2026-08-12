import { memo } from 'react'
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { nodeInputKinds, nodeOutputKind, type NodeKind, type WorkflowNodeData } from '../model'
import { presetImageModels, presetVideoModels } from '../models'
import { inputHandleId, outputHandleId } from '../ports'

/** 全画布共享的模型建议清单(datalist 只需渲染一次,App 根部挂载)。 */
export function ModelSuggestions() {
  return (
    <>
      <datalist id="wf-image-models">
        {presetImageModels.map((model) => <option key={model} value={model} />)}
      </datalist>
      <datalist id="wf-video-models">
        {presetVideoModels.map((model) => <option key={model} value={model} />)}
      </datalist>
    </>
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
  onRerun: () => undefined,
  onDownloadAsset: () => undefined,
  onResumeTask: () => undefined,
}

export function registerNodeChangeHandlers(next: NodeChangeHandlers): void {
  handlers = next
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
      {kind !== 'text' && (
        <input
          className="nodrag wf-model"
          value={data.model}
          list={kind === 'image' ? 'wf-image-models' : 'wf-video-models'}
          placeholder={kind === 'image' ? '选择或输入图像模型' : '视频模型(渠道接入后可用)'}
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
        <p className="wf-result-note">产物:{data.result.remoteUrl}</p>
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
