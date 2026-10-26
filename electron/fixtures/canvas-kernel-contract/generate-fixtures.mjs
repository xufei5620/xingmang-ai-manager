// Regenerates the canvas kernel contract samples next to this file (#1392).
// Run from the repository root: node electron/fixtures/canvas-kernel-contract/generate-fixtures.mjs
// Edit the cases here, never the JSON by hand, so the large workflow sample
// stays reproducible. electron/canvas-kernel-contract.test.ts checks them
// against the desktop parsers.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const out = process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url))
const assetId = 'A'.repeat(43)
const imageAsset = { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png', width: 64, height: 48 }

// One stroke at the kernel's total-point ceiling (image-edit-mask.ts: 4 096).
const points = Array.from({ length: 4096 }, (_, index) => ({ x: Number(((index % 64) / 64).toFixed(4)), y: Number((Math.floor(index / 64) / 64).toFixed(4)) }))
const noteText = `https://example.com/brief\n/imagine 一只猫\nD:\\素材\\参考.png\n${'便签正文'.repeat(2600)}`

const workflow = {
  schemaVersion: 2,
  name: '内核契约样例',
  viewport: { x: 0, y: 0, zoom: 1 },
  mediaGroups: { image: '图片模型', video: '视频模型', text: 'Gemini', imageModel: 'gpt-image-2' },
  nodes: [
    {
      id: 'prompt-1', kind: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 },
      data: {
        prompt: '电影感海报，主体居中',
        promptReferences: [{ start: 0, end: 5, presetId: 'cinematic-poster', version: 1, name: '名'.repeat(160), prompt: '电影感海报' }],
        dirty: true, model: '',
      },
    },
    {
      id: 'image-1', kind: 'image-generate', definitionVersion: 1, position: { x: 400, y: 0 },
      data: { prompt: '', dirty: true, model: 'gpt-image-2', group: '图片模型', imageResolution: '2K', imageCandidateCount: 4, result: imageAsset, candidateAssetIds: [assetId] },
    },
    {
      id: 'edit-1', kind: 'image-edit', definitionVersion: 1, position: { x: 800, y: 0 },
      data: {
        prompt: '把背景换成海边', model: 'gpt-image-2', group: '图片模型',
        settings: { imageEditMask: { version: 1, sourceAssetId: assetId, width: 64, height: 48, strokes: [{ tool: 'brush', size: 0.05, points }] } },
      },
    },
    {
      id: 'video-1', kind: 'video-generate', definitionVersion: 1, position: { x: 0, y: 400 },
      data: { prompt: '镜头缓慢推进', model: 'grok-imagine-video', group: '视频模型', seconds: '5', videoCandidateCount: 2, settings: { videoReferenceOrder: { version: 1, slots: [] } } },
    },
    {
      id: 'text-1', kind: 'text-generate', definitionVersion: 1, position: { x: 400, y: 400 },
      data: { prompt: '写一段文案', model: 'gpt-5.5', group: 'Gemini', textWebSearch: false, outputText: '生成好的文案'.repeat(500) },
    },
    {
      id: 'note-1', kind: 'note', definitionVersion: 1, position: { x: 800, y: 400 }, width: 320, height: 240,
      data: { prompt: '', model: '', settings: { text: noteText, color: 'yellow' } },
    },
  ],
  edges: [
    { id: 'edge-1', source: 'prompt-1', sourceHandle: 'out:text', target: 'image-1', targetHandle: 'in:text' },
    { id: 'edge-2', source: 'image-1', sourceHandle: 'out:image', target: 'edit-1', targetHandle: 'in:image' },
  ],
}
fs.writeFileSync(path.join(out, 'workflow-accepted.json'), `${JSON.stringify(workflow)}\n`)

// Keys the kernel's toCanvasRunGraph writes even when their value is
// undefined. JSON cannot carry an undefined value, so each case lists them and
// the test adds them back before cloning the input the way IPC does.
const kernelUndefinedKeys = ['quality', 'size', 'imageResolution', 'imageCandidateCount', 'videoCandidateCount', 'seconds', 'adoptedAssetId', 'videoMode', 'videoResolution', 'videoAspectRatio', 'promptOptimization']
const twoNodes = {
  nodes: [
    { id: 'prompt-1', kind: 'prompt', definitionVersion: 1, data: { prompt: '一只猫', model: '' } },
    { id: 'image-1', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: assetId } },
  ],
  edges: [],
}
function graphWith(extra) {
  return {
    nodes: [
      { id: 'prompt-1', kind: 'prompt', definitionVersion: 1, data: { prompt: '一只猫', model: '' } },
      { id: 'target', definitionVersion: 1, ...extra },
    ],
    edges: [{ id: 'edge-1', source: 'prompt-1', sourceHandle: 'out:text', target: 'target', targetHandle: 'in:text' }],
  }
}
const refused = '桌面版暂不支持，本次没有提交任何付费请求'
const runGraphs = {
  kernelUndefinedKeys,
  cases: [
    { name: 'prompt and image asset, kernel shape', input: { graph: twoNodes, scope: { kind: 'all' } }, expect: { refusal: null } },
    {
      name: 'defaults that leave the request unchanged',
      input: { graph: graphWith({ kind: 'video-generate', data: { prompt: '', model: 'grok-imagine-video', group: '视频模型', seconds: '5', videoProtocol: 'relay-videos', videoReferenceOrder: { version: 1, slots: [] }, videoCandidateCount: 1 } }), scope: { kind: 'all' } },
      expect: { refusal: null },
    },
    { name: 'image candidates above one', input: { graph: graphWith({ kind: 'image-generate', data: { prompt: '', model: 'gpt-image-2', group: '图片模型', imageCandidateCount: 4 } }), scope: { kind: 'all' } }, expect: { refusal: `「一次出多张图」${refused}` } },
    { name: 'web search on', input: { graph: graphWith({ kind: 'text-generate', data: { prompt: '', model: 'gpt-5.5', textWebSearch: true } }), scope: { kind: 'all' } }, expect: { refusal: `「文字生成」节点${refused}` } },
    { name: 'image edit mask', input: { graph: graphWith({ kind: 'image-edit', data: { prompt: '改背景', model: 'gpt-image-2', group: '图片模型', imageEditMask: { version: 1, width: 64, height: 48, strokes: [{ tool: 'brush', size: 0.1, points: [{ x: 0.5, y: 0.5 }] }] } } }), scope: { kind: 'all' } }, expect: { refusal: `「蒙版局部修改」${refused}` } },
    { name: 'native video protocol', input: { graph: graphWith({ kind: 'video-generate', data: { prompt: '', model: 'grok-imagine-video', group: '视频模型', seconds: '5', videoProtocol: 'xai-native' } }), scope: { kind: 'all' } }, expect: { refusal: `「这个视频接口」${refused}` } },
    { name: 'kernel-only node in scope', input: { graph: graphWith({ kind: 'image-compare', data: { prompt: '', model: '' } }), scope: { kind: 'all' } }, expect: { refusal: `「图片对比」节点${refused}` } },
    { name: 'kernel-only node outside the scope', input: { graph: graphWith({ kind: 'image-compare', data: { prompt: '', model: '' } }), scope: { kind: 'to-node', nodeId: 'prompt-1' } }, expect: { refusal: null } },
    { name: '1080p video', input: { graph: graphWith({ kind: 'video-generate', data: { prompt: '', model: 'minimax-h3-fast', group: '视频模型', seconds: '6', videoResolution: '1080p' } }), scope: { kind: 'all' } }, expect: { parseError: '画布 MiniMax 分辨率不受支持' } },
    { name: '3:2 video', input: { graph: graphWith({ kind: 'video-generate', data: { prompt: '', model: 'minimax-h3-fast', group: '视频模型', seconds: '6', videoAspectRatio: '3:2' } }), scope: { kind: 'all' } }, expect: { parseError: '画布 MiniMax 视频比例不受支持' } },
    { name: 'agent execution', input: { graph: twoNodes, scope: { kind: 'all' }, agentExecution: { sessionId: 's', turnId: 't' } }, expect: { parseError: '桌面版不支持由 Agent 发起运行' } },
  ],
}
fs.writeFileSync(path.join(out, 'run-graphs.json'), `${JSON.stringify(runGraphs, null, 2)}\n`)

const presets = {
  accepted: { name: '名'.repeat(160), prompt: '电影感海报，主体居中', tags: ['海报'] },
  rejected: { input: { name: '名'.repeat(161), prompt: '电影感海报' }, error: '画布提示词名称格式错误' },
}
fs.writeFileSync(path.join(out, 'prompt-presets.json'), `${JSON.stringify(presets, null, 2)}\n`)
