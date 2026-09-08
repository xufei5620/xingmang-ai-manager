import { useEffect, useRef, useState } from 'react'
import { Eye, FolderOpen, KeyRound, RefreshCw, Save, Settings } from 'lucide-react'
import type { AccountKey, AppConfigSummary, ProviderId } from '../../../../electron/ipc-contract'
import { BrandIcon, Button, Confirm, Dialog, Input, Pill, Segment, Select, Tabs } from '../../ui'
import { tools } from '../../registry/tools'
import { isToolId, providerFor, sourceFor, type ToolId } from './model'
import { getSourceMarkerStorage, writeManualSourceMarker } from './source-marker'
import type { ToolsApi } from './api'

type SourceChoice = 'account' | 'official' | 'manual' | 'unknown'
interface ConfigDraft { source: SourceChoice; keyId: string; secret: string; model: string; validatedSecret: string; dirty: boolean }
interface ConfigDialogProps {
  api: ToolsApi
  tool: ToolId
  config: AppConfigSummary
  signedIn: boolean
  onClose(): void
  onSaved(): Promise<void>
  onLogin(): void
  onKeys(): void
  onHelp(): void
}

export function ConfigDialog({ api, tool, config, signedIn, onClose, onSaved, onLogin, onKeys, onHelp }: ConfigDialogProps) {
  const [tab, setTab] = useState<ToolId>(tool)
  const [drafts, setDrafts] = useState<Partial<Record<ProviderId, ConfigDraft>>>({})
  const [keys, setKeys] = useState<AccountKey[]>([])
  const [models, setModels] = useState<string[]>([])
  const [keyError, setKeyError] = useState('')
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [confirmation, setConfirmation] = useState<'merge' | 'reset' | null>(null)
  const [exitAction, setExitAction] = useState<(() => void) | null>(null)
  const [localeText, setLocaleText] = useState('')
  const request = useRef(0)
  const active = useRef(true)
  const locked = useRef(false)
  const native = config.providers[providerFor(tab)]
  const definition = tools.find((item) => item.id === tab)!
  const sourceStorage = getSourceMarkerStorage()
  const currentSource = sourceFor(native, providerFor(tab), sourceStorage)
  const draft: ConfigDraft = drafts[providerFor(tab)] ?? {
    source: currentSource === 'missing' ? 'account' : currentSource,
    keyId: '', secret: '', model: native.model, validatedSecret: '', dirty: false,
  }
  const selectedKey = keys.find((key) => String(key.id) === draft.keyId)
  function requestExit(action: () => void) {
    if (busy) return
    if (Object.values(drafts).some((entry) => entry?.dirty)) setExitAction(() => action)
    else action()
  }
  function change(patch: Partial<ConfigDraft>) {
    setDrafts((current) => ({ ...current, [providerFor(tab)]: { ...draft, ...patch, dirty: true } }))
    setError('')
    setWarning('')
    setMessage('')
  }
  useEffect(() => { active.current = true; return () => { active.current = false; request.current++ } }, [])
  useEffect(() => {
    if (!signedIn) return
    let current = true
    void api.readKeys().then((page) => { if (current) setKeys(page.keys) }).catch((cause) => {
      if (current) setKeyError(cause instanceof Error ? cause.message : '密钥列表暂时没有读到')
    })
    return () => { current = false }
  }, [api, signedIn])
  useEffect(() => {
    request.current++
    setModels([])
    setError('')
    setWarning('')
    setMessage('')
  }, [tab, draft.source, draft.keyId])
  async function detectModels() {
    if (locked.current) return
    locked.current = true
    const id = ++request.current
    setBusy('检测模型'); setError('')
    try {
      const result = draft.source === 'manual' ? await api.manualModels(draft.secret)
        : selectedKey ? await api.keyModels(selectedKey.id) : await api.configuredModels(tab)
      if (!active.current || id !== request.current) return
      setModels(result)
      if (draft.source === 'manual') change({ validatedSecret: draft.secret, model: result.includes(draft.model) ? draft.model : result[0] ?? '' })
      else if (!draft.model && result[0]) change({ model: result[0] })
    } catch (cause) { if (active.current && id === request.current) setError(cause instanceof Error ? cause.message : '模型检测未完成') }
    finally { locked.current = false; if (active.current) setBusy('') }
  }
  async function run(label: string, operation: () => Promise<void>) {
    if (locked.current) return
    locked.current = true; setBusy(label); setError(''); setWarning('')
    try { await operation() }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : `${label}没有成功`) }
    finally { locked.current = false; if (active.current) setBusy('') }
  }
  function requestSave(mode: 'merge' | 'reset') {
    if (draft.source === 'unknown') return
    if (draft.source === 'account' && !signedIn) { onLogin(); return }
    if (mode === 'reset' && draft.source === 'account' && !selectedKey) { setError('重置前请先选择一把访问密钥。'); return }
    if (draft.source === 'manual' && (!draft.secret || draft.validatedSecret !== draft.secret || !models.includes(draft.model))) {
      setError('请先检测这把密钥的可用模型，再选择模型保存。'); return
    }
    setConfirmation(mode)
  }
  function save() {
    const mode = confirmation
    if (!mode) return
    void run('保存配置', async () => {
      const provider = providerFor(tab)
      let markerWarning = ''
      if (draft.source === 'official') {
        await api.official(tab)
        writeManualSourceMarker(sourceStorage, native.baseUrl, provider, false)
      }
      else if (draft.source === 'manual') {
        await api.saveManual({ provider, apiKey: draft.secret, model: draft.model, mode })
        if (!writeManualSourceMarker(sourceStorage, native.baseUrl, provider, true)) {
          markerWarning = '配置已保存，但本机没有记住“手动填写密钥”来源。下次登录星芒账号前，请先确认工具配置，避免密钥被自动替换。'
        }
      }
      else if (selectedKey) {
        await api.saveAccountKey({ provider, keyId: selectedKey.id, model: draft.model, mode })
        writeManualSourceMarker(sourceStorage, native.baseUrl, provider, false)
      }
      else {
        const result = await api.configureManaged(tab, draft.model || undefined)
        if (result.failed.length) throw new Error(result.failed.map((item) => item.message).join('；'))
        if (!result.configured.includes(provider)) throw new Error('工具没有返回配置写入结果，请重新检测后再试。')
        writeManualSourceMarker(sourceStorage, native.baseUrl, provider, false)
      }
      if (!active.current) return
      setWarning(markerWarning)
      setDrafts((current) => ({ ...current, [provider]: { ...draft, secret: '', validatedSecret: '', dirty: false } }))
      setConfirmation(null)
      setMessage('配置已保存。Codex 桌面端运行中时，可关闭此面板后选择重新打开。')
      try { await onSaved() }
      catch { if (active.current) setError('配置已保存，但最新状态没有读到。关闭后重新检测即可，无需重复保存。') }
    })
  }
  const officialName = providerFor(tab) === 'codex' ? 'ChatGPT 账号' : providerFor(tab) === 'claude' ? 'Claude 账号' : 'Google 账号'
  const sourceOptions = [
    { value: 'account', label: '使用星芒账号' },
    ...(definition.sources.includes('official') ? [{ value: 'official', label: officialName }] : []),
    { value: 'manual', label: '自己填写密钥' },
  ]
  return <>
    <Dialog open title={`${definition.name} 配置`} subtitle="选好账号后，保存并打开工具即可开始。" icon={Settings} width={640}
      onClose={onClose} busy={Boolean(busy)} dirty={Object.values(drafts).some((entry) => entry?.dirty)} testId="config-dialog"
      footer={<><Button variant="ghost" onClick={() => requestExit(onClose)} disabled={Boolean(busy)}>取消</Button><Button variant="primary" icon={Save} loading={Boolean(busy)} disabled={draft.source === 'unknown'} onClick={() => requestSave('merge')} testId="tool-save-config">保存配置</Button></>}>
      <fieldset className="v2-config-controls" disabled={Boolean(busy)}>
      <Tabs label="选择要配置的工具" items={tools.filter((entry) => isToolId(entry.id)).map((entry) => ({ value: entry.id, label: entry.name, disabled: Boolean(busy) }))}
        value={tab} onChange={(value) => { if (isToolId(value)) setTab(value) }} />
      {providerFor(tab) === 'codex' && <p className="v2-callout">Codex 桌面端与 Codex CLI 共用这份配置。模型和来源在任一入口修改后会同步。</p>}
      {draft.source === 'unknown' ? <><p className="v2-callout is-warn">这份配置连接了其他服务。保存新来源前会备份当前配置，历史会话会保留。</p><div className="v2-inline-actions"><Button onClick={() => change({ source: 'account' })}>切换为星芒账号</Button><Button onClick={() => change({ source: 'manual' })}>填写星芒密钥</Button><Button variant="ghost" onClick={onHelp}>查看处理步骤</Button></div></> : <>
        <div className="v2-config-field"><strong>用哪个账号使用 AI</strong><Segment options={sourceOptions} value={draft.source} onChange={(value) => {
          if (value === 'account' || value === 'manual' || value === 'official') change({ source: value })
        }} /></div>
        {draft.source === 'official' ? <div className="v2-official-summary"><BrandIcon tool={tab} /><div><strong>{native.officialAccountEmail || `使用 ${officialName}`}</strong><p>{native.officialAccountPlan ?? '保存来源后，在工具中完成官方登录。'}</p></div><Pill tone={native.officialAccountEmail ? 'ok' : 'warn'}>{native.officialAccountEmail ? '已登录' : '待登录'}</Pill></div> : <>
          {draft.source === 'account' ? <div className="v2-config-field"><Select label="访问密钥（Key）" value={draft.keyId} onChange={(event) => change({ keyId: event.target.value })}
            options={[{ value: '', label: '自动准备当前工具专属密钥' }, ...keys.filter((key) => key.status === 1).map((key) => ({ value: String(key.id), label: `${key.name} · ${key.maskedKey}` }))]} disabled={!signedIn} />
            {keyError && <p role="alert">{keyError}</p>}<Button variant="ghost" size="sm" icon={KeyRound} onClick={() => requestExit(onKeys)}>管理密钥</Button></div>
            : <div className="v2-config-field"><Input label="星芒访问密钥" type="password" value={draft.secret} onChange={(event) => change({ secret: event.target.value, validatedSecret: '' })} placeholder={native.apiKeyPreview ?? '粘贴你在星芒创建的密钥'} />
              {native.hasApiKey && <Button size="sm" variant="ghost" icon={Eye} onClick={() => void run('读取密钥', async () => { const secret = await api.reveal(tab); if (active.current) change({ secret, validatedSecret: '' }) })}>读取当前密钥</Button>}</div>}
          <div className="v2-config-field"><Select label="默认模型" value={draft.model} options={[...new Set([draft.model, ...models].filter(Boolean))].map((model) => ({ value: model, label: model }))} onChange={(event) => change({ model: event.target.value })} />
            <Button size="sm" variant="secondary" icon={RefreshCw} loading={busy === '检测模型'} onClick={() => void detectModels()} disabled={draft.source === 'manual' && !draft.secret}>检测模型</Button></div>
        </>}
      </>}
      <div className="v2-config-field"><Input label="打开工具时进入的文件夹" readOnly value={config.workspace} /><Button size="sm" icon={FolderOpen} onClick={() => void run('选择文件夹', async () => { if (await api.chooseWorkspace()) await onSaved() })}>选择文件夹</Button></div>
      {tab === 'codexDesktop' && <details><summary>界面语言与文件夹权限</summary><div className="v2-inline-actions"><Button size="sm" onClick={() => void run('检查中文界面', async () => { const value = await api.getLocale(); if (value.error) throw new Error(value.error); if (active.current) setLocaleText(!value.installed ? 'Codex 桌面端尚未安装' : !value.chineseResources.available ? '当前安装版本缺少中文资源，请更新桌面端后重试。' : `当前界面语言：${value.effectiveLocale === 'zh-CN' ? '简体中文' : value.effectiveLocale}${value.needsRestart ? '，重启后生效' : ''}`) })}>检查中文界面</Button>
        <Button size="sm" onClick={() => void run('启用中文界面', async () => { const result = await api.setLocale(); if (result.error) throw new Error(result.error); if (active.current) setLocaleText(result.needsRestart ? '中文界面设置已保存，重启 Codex 后生效' : '中文界面设置已完成') })}>启用中文界面</Button>
        <Button size="sm" onClick={() => void run('查看文件夹权限', async () => { const result = await api.getPermissions(); if (active.current) setLocaleText(`工作目录：${result.workspace}，信任状态：${result.trustLevel}`) })}>查看文件夹权限</Button>
        <Button size="sm" onClick={() => void run('信任当前文件夹', async () => { await api.trustWorkspace(); if (active.current) setLocaleText('文件夹信任已保存') })}>信任当前文件夹</Button></div>{localeText && <p role="status">{localeText}</p>}</details>}
      <details><summary>查看配置文件与保存方式</summary><div className="v2-code-preview">{native.files.map((file) => <div key={file.path}><code>{file.path}</code><span>{file.exists ? '已存在' : '尚未创建'}</span></div>)}</div>
        <p>保存前会创建备份。默认保留其他设置，也可以选择重新建立初始配置。</p><Button variant="danger" size="sm" onClick={() => requestSave('reset')} disabled={draft.source === 'unknown' || draft.source === 'official'}>备份并重置配置</Button></details>
      </fieldset>
      {error && <p className="v2-callout is-bad" role="alert">{error}</p>}{warning && <p className="v2-callout is-warn" role="status">{warning}</p>}{message && <p className="v2-callout is-ok" role="status">{message}</p>}
    </Dialog>
    {confirmation && <Confirm title={confirmation === 'reset' ? '使用初始配置？' : '保存这份配置？'} body={<>{confirmation === 'reset' ? '将先备份当前配置，再替换为初始配置。历史会话会保留。' : '仅更新账号来源、密钥和模型，其他自定义设置会保留。'}{error && <p role="alert" className="v2-callout is-bad">{error}</p>}</>} okLabel={confirmation === 'reset' ? '备份并重置' : '保存配置'} danger={confirmation === 'reset'} loading={Boolean(busy)} onClose={() => setConfirmation(null)} onOk={save} />}
    {exitAction && <Confirm title="要放弃未保存的修改吗？" body="关闭后，这次修改不会保存。" okLabel="放弃修改" cancelLabel="继续编辑" danger onClose={() => setExitAction(null)} onOk={() => { const action = exitAction; setExitAction(null); action() }} />}
  </>
}
