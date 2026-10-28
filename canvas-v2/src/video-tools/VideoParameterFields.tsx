import { arkSeedanceVideoDefaults, arkSeedanceVideoDurationRange, arkSeedanceVideoModelSupported, arkSeedanceVideoModelResolutions, arkSeedanceVideoModes, arkSeedanceVideoRatios, videoAspectRatioFromSize, xaiNativeVideoDefaults, xaiNativeVideoModelSupported, xaiNativeVideoModelResolutions, xaiNativeVideoRatios, type VideoProtocol } from '../lib/video-request-protocol'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import type { WorkflowNodeData } from '../model'
import { videoAspectRatioOptions, videoModeOptions, videoModelPresets, videoResolutionOptions, videoSizeOptions } from '../models'
import { inspectVideoNodeParameters, type VideoParameterPatch } from './video-node-parameters'
import { parseVideoCandidateCount, videoCandidateCounts, videoCandidateCountNotice, type VideoCandidateCount } from '../runtime/video-candidate-count'
import { hostCandidateCountChoices } from '../components/host-feature-controls'
import './video-parameter-fields.css'

interface Props { videoProtocol?: VideoProtocol; imageCount?: number; model: string; data: WorkflowNodeData; disabled?: boolean; compact?: boolean; onChange(patch: VideoParameterPatch): void; onReset(): void; onCandidateCountChange?(count: VideoCandidateCount): void
  /** The host's maximum; omitted, all four counts are offered. */
  candidateCountMaximum?: number
  /** False hides the audio switch on a host that does not take it. */
  generateAudioShown?: boolean }

export function VideoParameterFields({ videoProtocol, imageCount = 0, model, data, disabled, compact, onChange, onReset, onCandidateCountChange, candidateCountMaximum, generateAudioShown = true }: Props) {
  const countChoices = hostCandidateCountChoices(videoCandidateCounts, data.videoCandidateCount ?? 1, candidateCountMaximum)
  const preset = videoModelPresets.find((entry) => entry.id === model)
  const native = videoProtocol === 'xai-native'
  const ark = videoProtocol === 'ark-seedance'
  const arkSupported = ark && arkSeedanceVideoModelSupported(model)
  const nativeSupported = native && xaiNativeVideoModelSupported(model)
  const followsImage = native && (imageCount > 0 || data.settings?.videoMode === 'i2va')
  const inspection = inspectVideoNodeParameters(data, model, videoProtocol, imageCount)
  const saved = [
    ['模型', model], ['时长', data.seconds], ['尺寸', data.size], ['模式', data.settings?.videoMode],
    ['分辨率', data.settings?.videoResolution], ['比例', data.settings?.videoAspectRatio], ['提示词优化', data.settings?.promptOptimization], ['生成数量', data.videoCandidateCount], ['生成音频', data.settings?.generateAudio],
  ].filter(([, value]) => value !== undefined)
  function select(label: string, aria: string, value: string, choices: readonly { value: string; label: string }[], change: (value: string) => void) {
    return <label className="video-parameter-field"><span>{label}</span><select aria-label={aria} value={value} disabled={disabled} onChange={(event) => { if (!disabled) change(event.target.value) }}>
      {!choices.some((choice) => choice.value === value) && <option value={value} disabled>{value || '空值'}（已保存，当前不支持）</option>}
      {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
    </select></label>
  }
  return <section className={`video-parameter-fields nodrag nowheel${compact ? ' is-compact' : ''}`} aria-label="视频生成参数" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    {arkSupported && <div className="video-parameter-grid">
      {select('生成模式', 'Seedance 生成模式', String(data.settings?.videoMode ?? 'auto'), arkSeedanceVideoModes.map((value) => ({ value, label: ({ auto: '自动判断', t2va: '文生视频', i2va: '首帧生成', fl2va: '首尾帧', ref2va: '多模态参考' })[value] })), (value) => onChange({ videoMode: value as VideoParameterPatch['videoMode'] }))}
      {select('清晰度', 'Seedance 视频分辨率', String(data.settings?.videoResolution ?? arkSeedanceVideoDefaults.resolution), arkSeedanceVideoModelResolutions(model).map((value) => ({ value, label: value })), (value) => onChange({ videoResolution: value as VideoParameterPatch['videoResolution'] }))}
      {select('画面比例', 'Seedance 视频比例', String(data.settings?.videoAspectRatio ?? arkSeedanceVideoDefaults.aspectRatio), arkSeedanceVideoRatios.map((value) => ({ value, label: value === 'adaptive' ? '自适应' : value })), (value) => onChange({ videoAspectRatio: value as VideoParameterPatch['videoAspectRatio'], size: 'auto' }))}
      {select('视频时长', '视频时长', data.seconds ?? arkSeedanceVideoDefaults.seconds, Array.from({ length: arkSeedanceVideoDurationRange.max - arkSeedanceVideoDurationRange.min + 1 }, (_, index) => { const value = String(index + arkSeedanceVideoDurationRange.min); return { value, label: `${value} 秒` } }), (value) => onChange({ seconds: value }))}
    </div>}
    {nativeSupported && <div className="video-parameter-grid">
      {select('生成模式', 'xAI 生成模式', String(data.settings?.videoMode ?? 'auto'), [{ value: 'auto', label: '自动判断' }, { value: 't2va', label: '文生视频' }, { value: 'i2va', label: '首帧生成' }], (value) => onChange({ videoMode: value as VideoParameterPatch['videoMode'] }))}
      {select('清晰度', 'xAI 视频分辨率', String(data.settings?.videoResolution ?? xaiNativeVideoDefaults.resolution), xaiNativeVideoModelResolutions(model).map((value) => ({ value, label: value === '1080p' && model.endsWith('-lite') ? '1080p · 升采样' : value })), (value) => onChange({ videoResolution: value as VideoParameterPatch['videoResolution'] }))}
      {followsImage ? <div className="video-parameter-field"><span>画面比例</span><span className="video-parameter-derived">跟随首帧图片</span></div> : select('画面比例', 'xAI 视频比例', String(data.settings?.videoAspectRatio ?? videoAspectRatioFromSize(data.size) ?? xaiNativeVideoDefaults.aspectRatio), xaiNativeVideoRatios.map((value) => ({ value, label: value })), (value) => onChange({ videoAspectRatio: value as VideoParameterPatch['videoAspectRatio'], size: '1280x720' }))}
      {select('视频时长', '视频时长', data.seconds ?? xaiNativeVideoDefaults.seconds, Array.from({ length: 15 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 秒` })), (value) => onChange({ seconds: value }))}
    </div>}
    {!native && !ark && preset && preset.provider !== 'ark-seedance' && <div className="video-parameter-grid">
      {preset.provider === 'minimax-h3' ? <>
        {select('生成模式', 'MiniMax 生成模式', String(data.settings?.videoMode ?? 'auto'), videoModeOptions.map((entry) => ({ ...entry, label: ({ auto: '自动判断', t2va: '文生视频', i2va: '首帧生成', fl2va: '首尾帧', l2va: '尾帧生成', ref2va: '多模态参考' })[entry.value] })), (value) => onChange({ videoMode: value as VideoParameterPatch['videoMode'] }))}
        {select('清晰度', 'MiniMax 视频分辨率', String(data.settings?.videoResolution ?? '720p'), videoResolutionOptions, (value) => onChange({ videoResolution: value as VideoParameterPatch['videoResolution'] }))}
        {select('画面比例', 'MiniMax 视频比例', String(data.settings?.videoAspectRatio ?? '16:9'), videoAspectRatioOptions, (value) => onChange({ videoAspectRatio: value as VideoParameterPatch['videoAspectRatio'] }))}
      </> : select('画面比例', '视频比例', data.size || preset.defaultSize, videoSizeOptions.filter((choice) => preset.sizes.includes(choice.value)), (value) => onChange({ size: value }))}
      {select('视频时长', '视频时长', data.seconds ?? String(preset.defaultSeconds), Array.from({ length: preset.maximumSeconds - preset.minimumSeconds + 1 }, (_, index) => ({ value: String(preset.minimumSeconds + index), label: `${preset.minimumSeconds + index} 秒` })), (value) => onChange({ seconds: value }))}
    </div>}
    {onCandidateCountChange && countChoices.length > 1 && <div className="video-parameter-count"><label className="video-parameter-field"><span>生成数量</span><select aria-label="视频生成数量" value={data.videoCandidateCount ?? 1} disabled={disabled} title={videoCandidateCountNotice(data.videoCandidateCount ?? 1)} onChange={(event) => { if (!disabled) onCandidateCountChange(parseVideoCandidateCount(Number(event.target.value), 'video-generate')!) }}>{countChoices.map((count) => <option value={count} key={count}>×{count}</option>)}</select></label><small>{videoCandidateCountNotice(data.videoCandidateCount ?? 1)}</small></div>}
    {!native && !ark && preset?.provider === 'minimax-h3' && <label className="video-parameter-toggle"><input type="checkbox" disabled={disabled} checked={data.settings?.promptOptimization === true} onChange={(event) => { if (!disabled) onChange({ promptOptimization: event.target.checked }) }} /><span>优化提示词</span></label>}
    {generateAudioShown && <div className="video-parameter-audio"><span>生成音频</span>{nativeSupported || arkSupported ? <><div className="video-audio-options" role="group" aria-label="生成音频">{[{ value: undefined, label: '默认' }, { value: true, label: '开启' }, { value: false, label: '关闭' }].map((choice) => <button key={choice.label} type="button" aria-pressed={data.settings?.generateAudio === choice.value} disabled={disabled} onClick={() => { if (!disabled) onChange({ generateAudio: choice.value }) }}>{choice.label}</button>)}</div><small>{data.settings?.generateAudio === false ? '将明确请求无声视频' : data.settings?.generateAudio === true ? '将请求同步生成声音' : '使用服务默认音频设置'}</small></> : <small>当前来源未接通音频控制{data.settings?.generateAudio === undefined ? '' : '，已保留原设置，请核对后重置'}</small>}</div>}
    {ark && <p className="video-parameter-derived">运行时会将明确选中的参考素材交付所选 Ark 来源。参考视频通过服务器最长 65 分钟的临时读取授权发送，任务完成、确认失败或主动停止后失效；画布不会取得签名地址或密钥。</p>}
    {inspection.errors.length > 0 && <div className="video-parameter-warning" role="status"><AlertTriangle size={14} aria-hidden="true" /><div>{inspection.errors.map((error) => <p key={error}>{error}</p>)}<dl className="video-parameter-saved" aria-label="已保存的视频参数">{saved.map(([label, value]) => <div key={String(label)}><dt>{String(label)}</dt><dd>{typeof value === 'boolean' ? value ? '开启' : '关闭' : value === '' ? '空值' : String(value)}</dd></div>)}</dl>{inspection.resetLabels.length > 0 && <><small>将重置：{inspection.resetLabels.join('、')}。其他参数和素材保留。</small><button type="button" disabled={disabled} onClick={() => { if (!disabled) onReset() }}><RotateCcw size={13} aria-hidden="true" />按当前模型重置视频参数</button></>}</div></div>}
  </section>
}
