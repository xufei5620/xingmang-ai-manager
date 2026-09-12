import { useEffect, useRef, useState } from 'react'
import { Eye, FolderOpen, KeyRound, RefreshCw, Save, Settings } from 'lucide-react'
import type { AccountKey, AppConfigSummary, ProviderId } from '../../../../electron/ipc-contract'
import { BrandIcon, Button, Confirm, Dialog, Input, Pill, Segment, Select, Tabs } from '../../ui'
import { tools } from '../../registry/tools'
import { isToolId, providerFor, sourceFor, type ToolId } from './model'
import { getSourceMarkerStorage, writeManualSourceMarker } from './source-marker'
import type { ToolsApi } from './api'
import { accountKeyLabel, AUTOMATIC_KEY, CURRENT_KEY, currentKeyLabel, initialKeyChoice, manualKeyPreview, type ConfigKeyMetadata } from './key-selection'

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
  const [keyRevision, setKeyRevision] = useState(0)
  const [keysLoading, setKeysLoading] = useState(false)
  const [keyMetadata, setKeyMetadata] = useState<Partial<Record<ProviderId, ConfigKeyMetadata>>>({})
  const [metadataErrors, setMetadataErrors] = useState<Partial<Record<ProviderId, string>>>({})
  const [metadataLoading, setMetadataLoading] = useState<Partial<Record<ProviderId, boolean>>>({})
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [confirmation, setConfirmation] = useState<'choose' | 'reset' | null>(null)
  const [exitAction, setExitAction] = useState<(() => void) | null>(null)
  const [localeText, setLocaleText] = useState('')
  const request = useRef(0)
  const active = useRef(true)
  const locked = useRef(false)
  const metadataRequest = useRef(0)
  const lastKeyRefresh = useRef(0)
  const saveCancel = useRef<HTMLButtonElement>(null)
  const provider = providerFor(tab)
  const native = config.providers[provider]
  const definition = tools.find((item) => item.id === tab)!
  const sourceStorage = getSourceMarkerStorage()
  const currentSource = sourceFor(native, provider, sourceStorage)
  const draft: ConfigDraft = drafts[provider] ?? {
    source: currentSource === 'missing' ? 'account' : currentSource,
    keyId: initialKeyChoice(native), secret: '', model: native.model, validatedSecret: '', dirty: false,
  }
  const selectedKey = keys.find((key) => String(key.id) === draft.keyId && key.status === 1)
  const metadata = keyMetadata[provider] ?? null
  const usingCurrentKey = draft.keyId === CURRENT_KEY
  const usingAutomaticKey = draft.keyId === AUTOMATIC_KEY
  function refreshKeyOptions(force = false) {
    if (!signedIn || locked.current || keysLoading) return
    if (!force && Date.now() - lastKeyRefresh.current < 500) return
    lastKeyRefresh.current = Date.now()
    setKeyRevision((value) => value + 1)
  }
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
  useEffect(() => { active.current = true; return () => { active.current = false; request.current++; metadataRequest.current++ } }, [])
  useEffect(() => {
    if (!signedIn) return
    let current = true
    lastKeyRefresh.current = Date.now()
    setKeysLoading(true); setKeyError('')
    void api.readKeys().then((page) => { if (current) setKeys(page.keys) }).catch((cause) => {
      if (current) setKeyError(cause instanceof Error ? cause.message : '密钥列表暂时没有读到')
    }).finally(() => { if (current) setKeysLoading(false) })
    return () => { current = false }
  }, [api, signedIn, keyRevision])
  useEffect(() => {
    const owner = ++metadataRequest.current
    if (!signedIn) return
    setMetadataLoading((current) => ({ ...current, [provider]: true }))
    setMetadataErrors((current) => ({ ...current, [provider]: '' }))
    void api.readKeyOptions(tab).then((value) => {
      if (active.current && owner === metadataRequest.current) setKeyMetadata((current) => ({ ...current, [provider]: value }))
    }).catch((cause) => {
      if (active.current && owner === metadataRequest.current) setMetadataErrors((current) => ({ ...current, [provider]: cause instanceof Error ? cause.message : '当前密钥信息暂时没有读到' }))
    }).finally(() => {
      if (active.current && owner === metadataRequest.current) setMetadataLoading((current) => ({ ...current, [provider]: false }))
    })
    return () => { metadataRequest.current++ }
  }, [api, provider, signedIn, tab, keyRevision])
  useEffect(() => {
    request.current++
    setModels([])
    setError('')
  }, [tab, draft.source, draft.keyId])
  useEffect(() => { setWarning(''); setMessage('') }, [tab])
  async function detectModels() {
    if (locked.current) return
    if (draft.source === 'account' && usingAutomaticKey) { setError('自动配置会准备或复用专属密钥。请先保存配置，再检测模型。'); return }
    if (draft.source === 'account' && !usingCurrentKey && !selectedKey) { setError('所选密钥已不可用，请重新选择。'); return }
    locked.current = true
    const id = ++request.current
    setBusy('检测模型'); setError('')
    try {
      const result = draft.source === 'manual' ? await api.manualModels(draft.secret)
        : usingCurrentKey ? await api.configuredModels(tab) : await api.keyModels(selectedKey!.id)
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
  function requestSave() {
    if (draft.source === 'unknown') return
    if (draft.source === 'account' && !signedIn && !usingCurrentKey) { onLogin(); return }
    if (draft.source === 'account') {
      if (usingCurrentKey && !native.hasApiKey) { setError('当前工具没有可保留的密钥，请重新选择。'); return }
      if (usingAutomaticKey && (!metadata || metadataLoading[provider] || metadataErrors[provider])) { setError('请先读取当前工具的自动配置分组。'); return }
      if (!usingCurrentKey && !usingAutomaticKey && (!selectedKey || selectedKey.status !== 1)) { setError('所选密钥已不可用，请重新选择。'); return }
      if (!usingCurrentKey && !usingAutomaticKey && (keysLoading || keyError)) { setError('请先获取最新的账号密钥列表。'); return }
      if (!usingAutomaticKey && !draft.model) { setError('请选择默认模型。'); return }
    }
    if (draft.source === 'manual' && (!draft.secret || draft.validatedSecret !== draft.secret || !models.includes(draft.model))) {
      setError('请先检测这把密钥的可用模型，再选择模型保存。'); return
    }
    setError('')
    setConfirmation('choose')
  }
  function save(mode: 'merge' | 'reset') {
    if (!confirmation) return
    void run('保存配置', async () => {
      const provider = providerFor(tab)
      let markerWarning = ''
      if (draft.source === 'official') {
        await api.official(tab, mode)
        writeManualSourceMarker(sourceStorage, native.baseUrl, provider, false)
      }
      else if (draft.source === 'manual') {
        await api.saveManual({ provider, apiKey: draft.secret, model: draft.model, mode })
        if (!writeManualSourceMarker(sourceStorage, native.baseUrl, provider, true)) {
          markerWarning = '配置已保存，但本机没有记住“手动填写密钥”来源。下次登录星芒账号前，请先确认工具配置，避免密钥被自动替换。'
        }
      }
      else if (usingCurrentKey) {
        // Empty is the main-process reuse sentinel. It never reveals or
        // replaces the local key and must not mark its source as manual.
        await api.saveManual({ provider, apiKey: '', model: draft.model, mode })
      }
      else if (selectedKey) {
        await api.saveAccountKey({ provider, keyId: selectedKey.id, model: draft.model, mode })
        writeManualSourceMarker(sourceStorage, native.baseUrl, provider, false)
      }
      else if (usingAutomaticKey) {
        const result = await api.configureManaged(tab, draft.model || undefined, mode)
        if (result.failed.length) throw new Error(result.failed.map((item) => item.message).join('；'))
        if (!result.configured.includes(provider)) throw new Error('工具没有返回配置写入结果，请重新检测后再试。')
        writeManualSourceMarker(sourceStorage, native.baseUrl, provider, false)
      }
      else throw new Error('请选择要保存的密钥。')
      if (!active.current) return
      setWarning(markerWarning)
      setDrafts((current) => ({ ...current, [provider]: { ...draft, keyId: draft.source === 'account' ? CURRENT_KEY : draft.keyId, secret: '', validatedSecret: '', dirty: false } }))
      setConfirmation(null)
      setMessage(mode === 'reset' ? '配置已重置为初始状态。Codex 桌面端运行中时，可关闭此面板后选择重新打开。' : '配置已保存。Codex 桌面端运行中时，可关闭此面板后选择重新打开。')
      try {
        await onSaved()
        const savedConfig = await api.readConfig()
        const savedNative = savedConfig.providers[provider]
        if (active.current) {
          const savedSource = sourceFor(savedNative, provider, sourceStorage)
          setDrafts((current) => ({ ...current, [provider]: { ...draft, source: savedSource === 'missing' ? 'account' : savedSource,
            keyId: savedNative.hasApiKey ? CURRENT_KEY : AUTOMATIC_KEY, model: savedNative.model, secret: '', validatedSecret: '', dirty: false } }))
        }
        if (signedIn) {
          const latest = await api.readKeyOptions(tab)
          if (active.current) setKeyMetadata((current) => ({ ...current, [provider]: latest }))
        }
      }
      catch { if (active.current) setError('配置已保存，但最新状态没有读到。关闭后重新检测即可，无需重复保存。') }
    })
  }
  const officialName = providerFor(tab) === 'codex' ? 'ChatGPT 账号' : providerFor(tab) === 'claude' ? 'Claude 账号' : 'Google 账号'
  const sourceOptions = [
    { value: 'account', label: '使用星芒账号' },
    ...(definition.sources.includes('official') ? [{ value: 'official', label: officialName }] : []),
    { value: 'manual', label: '自己填写密钥' },
  ]
  const keyDescription = draft.source === 'manual'
    ? { name: '手动填写', group: '分组未确认', preview: manualKeyPreview(draft.secret) }
    : usingCurrentKey
      ? { name: metadata?.current.name || '名称未确认', group: metadata?.current.group || '分组未确认', preview: metadata?.current.preview || native.apiKeyPreview || '密钥预览未提供' }
      : usingAutomaticKey
        ? { name: metadata?.automatic.name || '正在读取', group: metadata?.automatic.group || '分组未确认', preview: '保存时准备或复用' }
        : { name: selectedKey?.name || '密钥已不可用', group: selectedKey?.group || '分组未确认', preview: selectedKey?.maskedKey || '密钥预览未提供' }
  const automaticLabel = metadata
    ? `自动准备/复用 · ${metadata.automatic.group} · ${metadata.automatic.name}`
    : metadataErrors[provider] ? '自动配置 · 分组读取失败' : '自动配置 · 正在读取专属分组'
  const saveSummary = <div data-testid="tool-save-summary">{draft.source === 'official' ? <p>来源：{officialName}</p> : <><p>密钥：{keyDescription.name}</p><p>分组：{keyDescription.group}</p><p>预览：{keyDescription.preview}</p><p>模型：{draft.model || '使用该分组默认模型'}</p></>}</div>
  return <>
    <Dialog open title={`${definition.name} 配置`} subtitle="选好账号后，保存并打开工具即可开始。" icon={Settings} width={640}
      onClose={onClose} busy={Boolean(busy)} dirty={Object.values(drafts).some((entry) => entry?.dirty)} testId="config-dialog"
      footer={<><Button variant="ghost" onClick={() => requestExit(onClose)} disabled={Boolean(busy)}>取消</Button><Button variant="primary" icon={Save} loading={Boolean(busy)} disabled={draft.source === 'unknown'} onClick={requestSave} testId="tool-save-config">保存配置</Button></>}>
      <fieldset className="v2-config-controls" disabled={Boolean(busy)}>
      <Tabs label="选择要配置的工具" items={tools.filter((entry) => isToolId(entry.id)).map((entry) => ({ value: entry.id, label: entry.name, disabled: Boolean(busy) }))}
        value={tab} onChange={(value) => { if (isToolId(value)) setTab(value) }} />
      {providerFor(tab) === 'codex' && <p className="v2-callout">Codex 桌面端与 Codex CLI 共用这份配置。模型和来源在任一入口修改后会同步。</p>}
      {draft.source === 'unknown' ? <><p className="v2-callout is-warn">这份配置连接了其他服务。保存新来源前会备份当前配置，历史会话会保留。</p><div className="v2-inline-actions"><Button onClick={() => change({ source: 'account' })}>切换为星芒账号</Button><Button onClick={() => change({ source: 'manual' })}>填写星芒密钥</Button><Button variant="ghost" onClick={onHelp}>查看处理步骤</Button></div></> : <>
        <div className="v2-config-field"><strong>用哪个账号使用 AI</strong><Segment options={sourceOptions} value={draft.source} onChange={(value) => {
          if (value === 'account' || value === 'manual' || value === 'official') change({ source: value })
        }} /></div>
        {draft.source === 'official' ? <div className="v2-official-summary"><BrandIcon tool={tab} /><div><strong>{native.officialAccountEmail || `使用 ${officialName}`}</strong><p>{native.officialAccountPlan ?? '保存来源后，在工具中完成官方登录。'}</p></div><Pill tone={native.officialAccountEmail ? 'ok' : 'warn'}>{native.officialAccountEmail ? '已登录' : '待登录'}</Pill></div> : <>
          {draft.source === 'account' ? <div className="v2-config-field"><Select label="访问密钥（Key）" testId="tool-key-select" value={draft.keyId} onFocus={() => refreshKeyOptions()} onPointerDown={() => refreshKeyOptions()} onKeyDown={(event) => { if (['ArrowDown', 'ArrowUp', ' ', 'Enter', 'F4'].includes(event.key)) refreshKeyOptions() }} onChange={(event) => change({ keyId: event.target.value })}
            options={[
              ...(native.hasApiKey || usingCurrentKey ? [{ value: CURRENT_KEY, label: currentKeyLabel(metadata, native.apiKeyPreview), disabled: !native.hasApiKey }] : []),
              { value: AUTOMATIC_KEY, label: automaticLabel, disabled: !metadata || Boolean(metadataLoading[provider]) || Boolean(metadataErrors[provider]) },
              ...keys.filter((key) => key.status === 1).map((key) => ({ value: String(key.id), label: accountKeyLabel(key) })),
              ...(!usingCurrentKey && !usingAutomaticKey && !selectedKey ? [{ value: draft.keyId, label: '所选密钥已不可用，请重新选择', disabled: true }] : []),
            ]} disabled={!signedIn} />
            <p data-testid="tool-key-summary">{usingCurrentKey ? '将保留当前密钥' : usingAutomaticKey ? '将准备或复用专属密钥' : '将使用所选密钥'}：{keyDescription.name} · {keyDescription.group} · {keyDescription.preview}</p>
            {metadataErrors[provider] && <p role="alert">{metadataErrors[provider]}</p>}
            {keyError && <p role="alert">{keyError}</p>}<div className="v2-inline-actions"><Button variant="ghost" size="sm" icon={RefreshCw} testId="tool-key-refresh" loading={keysLoading || metadataLoading[provider]} onClick={() => refreshKeyOptions(true)} disabled={!signedIn}>刷新密钥</Button><Button variant="ghost" size="sm" icon={KeyRound} onClick={() => requestExit(onKeys)}>管理密钥</Button></div></div>
            : <div className="v2-config-field"><Input label="星芒访问密钥" type="password" value={draft.secret} onChange={(event) => change({ secret: event.target.value, validatedSecret: '' })} placeholder={native.apiKeyPreview ?? '粘贴你在星芒创建的密钥'} />
              {native.hasApiKey && <Button size="sm" variant="ghost" icon={Eye} onClick={() => void run('读取密钥', async () => { const secret = await api.reveal(tab); if (active.current) change({ secret, validatedSecret: '' }) })}>读取当前密钥</Button>}</div>}
          <div className="v2-config-field"><Select label="默认模型" value={draft.model} options={[...new Set([draft.model, ...models].filter(Boolean))].map((model) => ({ value: model, label: model }))} onChange={(event) => change({ model: event.target.value })} />
            <Button size="sm" variant="secondary" icon={RefreshCw} testId="tool-detect-models" loading={busy === '检测模型'} onClick={() => void detectModels()} disabled={(draft.source === 'manual' && !draft.secret) || (draft.source === 'account' && usingAutomaticKey)}>检测模型</Button>
            {draft.source === 'account' && usingAutomaticKey && <p>先保存以准备专属密钥，再检测模型。保存前不会使用当前密钥进行检测。</p>}</div>
        </>}
      </>}
      <div className="v2-config-field"><Input label="打开工具时进入的文件夹" readOnly value={config.workspace} /><Button size="sm" icon={FolderOpen} onClick={() => void run('选择文件夹', async () => { if (await api.chooseWorkspace()) await onSaved() })}>选择文件夹</Button></div>
      {tab === 'codexDesktop' && <details><summary>界面语言与文件夹权限</summary><div className="v2-inline-actions"><Button size="sm" onClick={() => void run('检查中文界面', async () => { const value = await api.getLocale(); if (value.error) throw new Error(value.error); if (active.current) setLocaleText(!value.installed ? 'Codex 桌面端尚未安装' : !value.chineseResources.available ? '当前安装版本缺少中文资源，请更新桌面端后重试。' : `当前界面语言：${value.effectiveLocale === 'zh-CN' ? '简体中文' : value.effectiveLocale}${value.needsRestart ? '，重启后生效' : ''}`) })}>检查中文界面</Button>
        <Button size="sm" onClick={() => void run('启用中文界面', async () => { const result = await api.setLocale(); if (result.error) throw new Error(result.error); if (active.current) setLocaleText(result.needsRestart ? '中文界面设置已保存，重启 Codex 后生效' : '中文界面设置已完成') })}>启用中文界面</Button>
        <Button size="sm" onClick={() => void run('查看文件夹权限', async () => { const result = await api.getPermissions(); if (active.current) setLocaleText(`工作目录：${result.workspace}，信任状态：${result.trustLevel}`) })}>查看文件夹权限</Button>
        <Button size="sm" onClick={() => void run('信任当前文件夹', async () => { await api.trustWorkspace(); if (active.current) setLocaleText('文件夹信任已保存') })}>信任当前文件夹</Button></div>{localeText && <p role="status">{localeText}</p>}</details>}
      <details><summary>查看配置文件与保存方式</summary><div className="v2-code-preview">{native.files.map((file) => <div key={file.path}><code>{file.path}</code><span>{file.exists ? '已存在' : '尚未创建'}</span></div>)}</div>
        <p>点击“保存配置”后，可选择保留自定义设置或重置为初始状态。修改已有配置前会创建备份。</p></details>
      </fieldset>
      {error && <p className="v2-callout is-bad" role="alert">{error}</p>}{warning && <p className="v2-callout is-warn" role="status">{warning}</p>}{message && <p className="v2-callout is-ok" role="status">{message}</p>}
    </Dialog>
    {confirmation === 'choose' && <Dialog open title="保存这份配置？" onClose={() => setConfirmation(null)} busy={Boolean(busy)} initialFocus={saveCancel}
      footer={<Button ref={saveCancel} disabled={Boolean(busy)} onClick={() => setConfirmation(null)}>取消</Button>}>
      {saveSummary}
      {provider === 'codex' && <p className="v2-save-profile-note">星芒与 ChatGPT 各自保留一份配置；切换来源时，优先恢复该来源上次保存的自定义设置。</p>}
      <div className="v2-save-options">
        <Button variant="primary" disabled={Boolean(busy)} loading={busy === '保存配置'} onClick={() => save('merge')} testId="tool-save-merge"><strong>仅更新账号来源、密钥和模型</strong><small>其他自定义设置会保留。</small></Button>
        <Button variant="danger" disabled={Boolean(busy)} onClick={() => { setError(''); setConfirmation('reset') }} testId="tool-save-reset"><strong>重置为初始状态</strong><small>先备份，再按所选账号来源重建配置。历史会话会保留。</small></Button>
      </div>
      {error && <p role="alert" className="v2-callout is-bad">{error}</p>}
    </Dialog>}
    {confirmation === 'reset' && <Confirm title="重置为初始状态？" body={<><p>将先备份当前配置，再按所选账号来源重建配置。{provider === 'codex' ? '该来源' : '当前工具'}的自定义设置（如权限、MCP 和推理参数）会重置，历史会话和官方登录凭据会保留。</p>{saveSummary}{error && <p role="alert" className="v2-callout is-bad">{error}</p>}</>} okLabel="备份并重置" cancelLabel="返回选择" danger loading={Boolean(busy)} onClose={() => { setError(''); setConfirmation('choose') }} onOk={() => save('reset')} />}
    {exitAction && <Confirm title="要放弃未保存的修改吗？" body="关闭后，这次修改不会保存。" okLabel="放弃修改" cancelLabel="继续编辑" danger onClose={() => setExitAction(null)} onOk={() => { const action = exitAction; setExitAction(null); action() }} />}
  </>
}
