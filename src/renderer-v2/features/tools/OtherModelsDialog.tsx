import { useEffect, useId, useRef, useState } from 'react'
import { KeyRound, RefreshCw, Save } from 'lucide-react'
import { DEFAULT_CODEX_MODEL } from '../../../../electron/cli-model-defaults'
import { Button, Dialog } from '../../ui'
import { sourceFor } from './model'
import { getSourceMarkerStorage } from './source-marker'
import { otherModelChoices, otherModelSaveIssue } from './model-filter'
import { DialogExitButton, RadioCards } from './dialog-parts'
import type { ConfigDialogProps } from './ConfigDialog'
import { errorMessage, FailureReason, failureWithDetail } from '../../business-common'

type DialogError = string | ReturnType<typeof failureWithDetail>

/**
 * Codex 首页「换用别家模型」。原来是整份配置弹窗外加一个「别家模型」筛选，进去要先认出
 * 来源、密钥、筛选三样；现在只问一件事：用哪个模型。只用工具里现在那把当前账号的密钥
 * （主进程的沿用通道，不读出、不换掉 Key）；用的是 ChatGPT 账号或别的来源时，先一键改用
 * 当前账号（备份、写入、自检都在主进程），再列出这把密钥能用的模型。
 */
export function OtherModelsDialog({ api, tool, config, signedIn, onClose, onSaved, onKeyWritten, onLogin, onSwitchAccount }: ConfigDialogProps) {
  const native = config.providers.codex
  const currentSource = sourceFor(native, 'codex', getSourceMarkerStorage())
  const official = currentSource === 'official'
  const reusable = native.hasApiKey && native.matchesRelay && (currentSource === 'account' || currentSource === 'manual')
  const [models, setModels] = useState<string[]>([])
  const [detected, setDetected] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pick, setPick] = useState('')
  const [picked, setPicked] = useState(false)
  const [error, setError] = useState<DialogError>('')
  const [busy, setBusy] = useState('')
  const [revision, setRevision] = useState(0)
  const active = useRef(true)
  const locked = useRef(false)
  const statusId = useId()
  const choices = otherModelChoices(models, DEFAULT_CODEX_MODEL)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  // 能沿用的密钥一打开就替用户读一次；没登录不读，免得没登录跑的界面检查拿占位 Key 去请求
  // 正式服务（同配置弹窗）。读不到就留着「检测模型」让他再点。
  useEffect(() => {
    if (!reusable || (!signedIn && revision === 0)) return
    let current = true
    setLoading(true); setError('')
    void api.configuredModels(tool).then((result) => {
      if (!current) return
      setModels(result)
      setDetected(true)
      const options = otherModelChoices(result, DEFAULT_CODEX_MODEL)
      setPick((value) => value && options.includes(value) ? value : options.includes(native.model) ? native.model : '')
    }).catch((cause) => { if (current) { setDetected(false); setError(errorMessage(cause, '模型检测未完成')) } })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, tool, reusable, signedIn, revision])
  async function switchAccount() {
    if (!onSwitchAccount || locked.current) return
    if (!signedIn) { onLogin(); return }
    locked.current = true; setBusy('改用当前账号'); setError('')
    try {
      const result = await onSwitchAccount(tool)
      if (result) onKeyWritten?.(tool)
      // 切好以后配置跟着刷新，能沿用了就自动列出模型；这里再催一次，免得刷新比这里先到。
      if (active.current && result) setRevision((value) => value + 1)
    } finally { locked.current = false; if (active.current) setBusy('') }
  }
  const issue = reusable ? otherModelSaveIssue({ models, defaultModel: DEFAULT_CODEX_MODEL, selectedModel: pick, detected }) : null
  async function save() {
    if (locked.current) return
    if (issue) { setError(issue); return }
    locked.current = true; setBusy('保存'); setError('')
    try {
      // Empty is the main-process reuse sentinel: the configured key stays in
      // place with its current ownership, only the model changes.
      await api.saveManual({ provider: 'codex', apiKey: '', model: pick, mode: 'merge' })
      if (active.current) onSaved(undefined, 'saved')
    } catch (cause) { if (active.current) setError(failureWithDetail(cause, '保存没有成功')) }
    finally { locked.current = false; if (active.current) setBusy('') }
  }
  const errorText = typeof error === 'string' ? error : <FailureReason error={error.message} detail={error.detail} target="config" />
  // 「没有别家模型」这句挂在列表下面一直显示；其余的没过（还没读到、还没选）只让「保存」先灰着。
  const listIssue = detected && issue && !choices.some((model) => model !== DEFAULT_CODEX_MODEL) ? issue : ''
  return <Dialog open title="Codex 换用别家模型" subtitle="用量从当前账号余额里扣。" width={480} onClose={onClose} busy={Boolean(busy)} dirty={picked} testId="codex-other-models-dialog"
    footer={<><DialogExitButton disabled={Boolean(busy)}>取消</DialogExitButton>{reusable
      ? <Button variant="primary" icon={Save} loading={busy === '保存'} disabled={Boolean(busy) || loading || Boolean(issue)} aria-describedby={listIssue ? statusId : undefined} onClick={() => void save()} testId="tool-save-config">保存</Button>
      : <Button variant="primary" icon={KeyRound} loading={busy === '改用当前账号'} disabled={Boolean(busy) || !onSwitchAccount} onClick={() => void switchAccount()} testId="tool-switch-account">改用当前账号并保存</Button>}</>}>
    <fieldset className="v2-config-controls" disabled={Boolean(busy)} data-unsaved={picked ? 'true' : undefined}>
      {official && <p className="v2-callout is-warn" data-testid="tool-model-filter-official">Codex 现在用的是 ChatGPT 账号。换别家模型要先改用当前账号，原来的配置会先备份。</p>}
      {reusable && <>
        {choices.length > 0 && <RadioCards label="模型" layout="stack" testId="tool-codex-model-filter" value={pick} onChange={(value) => { setPick(value); setPicked(true); setError('') }}
          options={choices.map((model) => ({ value: model, label: <span className="v2-model-name">{model}</span>, description: model === DEFAULT_CODEX_MODEL ? 'Codex 默认' : undefined }))} />}
        {listIssue && <p id={statusId} role="status" data-testid="tool-model-filter-status">{listIssue}</p>}
        {(!detected || loading) && <div><Button size="sm" icon={RefreshCw} loading={loading} onClick={() => setRevision((value) => value + 1)} testId="tool-detect-models">{loading ? '检测中' : '检测模型'}</Button></div>}
        <p className="v2-field-note">列表里的模型来自当前账号，不是每个都能在 Codex 里用，拿不准就选默认的。</p>
      </>}
    </fieldset>
    {error && <p className="v2-callout is-bad" role="alert">{errorText}</p>}
  </Dialog>
}
