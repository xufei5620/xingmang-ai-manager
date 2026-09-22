import { useEffect, useId, useRef, useState } from 'react'
import { Eye, FolderOpen, KeyRound, RefreshCw, Save, Settings } from 'lucide-react'
import type { AccountKey, AppConfigSummary, ProviderId } from '../../../../electron/ipc-contract'
import { defaultCliModels, resolveDefaultCliModel } from '../../../../electron/cli-model-defaults'
import { BrandIcon, Button, Confirm, Dialog, Input, Pill, Segment, Select, Tabs } from '../../ui'
import { officialAccountNames, officialAccountNotes, tools } from '../../registry/tools'
import { isToolId, providerFor, sourceFor, type ToolId } from './model'
import { applyManualSourceMarker, getSourceMarkerStorage } from './source-marker'
import type { ToolsApi } from './api'
import { accountKeyLabel, AUTOMATIC_KEY, CURRENT_KEY, currentKeyLabel, initialKeyChoice, manualKeyPreview, type ConfigKeyMetadata } from './key-selection'
import { describeChineseLocale, describeChineseLocaleResult } from './locale-status'
import { codexModelChoices, codexModelFilterSaveIssue, type CodexModelFilter } from './model-filter'
import { errorMessage } from '../../business-common'

type SourceChoice = 'account' | 'official' | 'manual' | 'unknown'
interface ConfigDraft { source: SourceChoice; keyId: string; secret: string; model: string; validatedSecret: string; dirty: boolean }
interface ConfigDialogProps {
  api: ToolsApi
  tool: ToolId
  config: AppConfigSummary
  signedIn: boolean
  initialModelFilter?: CodexModelFilter
  onClose(): void
  onRefresh(): Promise<void>
  onSaved(warning?: string): void
  onLogin(): void
  onKeys(): void
  onHelp(): void
}

export function ConfigDialog({ api, tool, config, signedIn, initialModelFilter = 'all', onClose, onRefresh, onSaved, onLogin, onKeys, onHelp }: ConfigDialogProps) {
  const [tab, setTab] = useState<ToolId>(tool)
  const [drafts, setDrafts] = useState<Partial<Record<ProviderId, ConfigDraft>>>({})
  const [keys, setKeys] = useState<AccountKey[]>([])
  const [models, setModels] = useState<string[]>([])
  const [modelsDetected, setModelsDetected] = useState(false)
  const [modelFilter, setModelFilter] = useState<CodexModelFilter>(initialModelFilter)
  const [keyError, setKeyError] = useState('')
  const [keyRevision, setKeyRevision] = useState(0)
  const [keysLoading, setKeysLoading] = useState(false)
  const [keyMetadata, setKeyMetadata] = useState<Partial<Record<ProviderId, ConfigKeyMetadata>>>({})
  const [metadataErrors, setMetadataErrors] = useState<Partial<Record<ProviderId, string>>>({})
  const [metadataLoading, setMetadataLoading] = useState<Partial<Record<ProviderId, boolean>>>({})
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [busy, setBusy] = useState('')
  const [confirmation, setConfirmation] = useState<'reset' | null>(null)
  const [exitAction, setExitAction] = useState<(() => void) | null>(null)
  const [localeText, setLocaleText] = useState('')
  const [notice, setNotice] = useState('')
  const request = useRef(0)
  const active = useRef(true)
  const locked = useRef(false)
  const metadataRequest = useRef(0)
  const lastKeyRefresh = useRef(0)
  const modelFilterStatusId = useId()
  const provider = providerFor(tab)
  const native = config.providers[provider]
  const definition = tools.find((item) => item.id === tab)!
  const sourceStorage = getSourceMarkerStorage()
  const currentSource = sourceFor(native, provider, sourceStorage)
  const draft: ConfigDraft = drafts[provider] ?? {
    // 「被改过」在这个对话框里和「来源未确认」走同一条路：都要先让用户挑一个来源，
    // 挑完保存就把所有权重新写清楚。
    source: currentSource === 'missing' ? 'account' : currentSource === 'changed' ? 'unknown' : currentSource,
    keyId: initialKeyChoice(native), secret: '', model: native.model || defaultCliModels[provider], validatedSecret: '', dirty: false,
  }
  const selectedKey = keys.find((key) => String(key.id) === draft.keyId && key.status === 1)
  const metadata = keyMetadata[provider] ?? null
  const usingCurrentKey = draft.keyId === CURRENT_KEY
  const usingAutomaticKey = draft.keyId === AUTOMATIC_KEY
  const activeModelFilter = provider === 'codex' ? modelFilter : 'all'
  const modelChoices = codexModelChoices(models, activeModelFilter, draft.model)
  const nonGptSaveIssue = provider === 'codex' && draft.source !== 'unknown'
    ? codexModelFilterSaveIssue({
      filter: activeModelFilter, models, selectedModel: draft.model,
      detected: modelsDetected && (draft.source !== 'manual' || draft.validatedSecret === draft.secret),
      automaticKey: draft.source === 'account' && usingAutomaticKey,
      officialSource: draft.source === 'official',
    }) : null
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
    setNotice('')
  }
  useEffect(() => { active.current = true; return () => { active.current = false; request.current++; metadataRequest.current++ } }, [])
  useEffect(() => {
    if (!signedIn) return
    let current = true
    lastKeyRefresh.current = Date.now()
    setKeysLoading(true); setKeyError('')
    void api.readKeys().then((page) => { if (current) setKeys(page.keys) }).catch((cause) => {
      if (current) setKeyError(errorMessage(cause, '密钥列表暂时没有读到'))
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
      if (active.current && owner === metadataRequest.current) setMetadataErrors((current) => ({ ...current, [provider]: errorMessage(cause, '当前密钥信息暂时没有读到') }))
    }).finally(() => {
      if (active.current && owner === metadataRequest.current) setMetadataLoading((current) => ({ ...current, [provider]: false }))
    })
    return () => { metadataRequest.current++ }
  }, [api, provider, signedIn, tab, keyRevision])
  useEffect(() => {
    request.current++
    setModels([])
    setModelsDetected(false)
    setError('')
  }, [tab, draft.source, draft.keyId, draft.secret])
  useEffect(() => { setWarning(''); setNotice('') }, [tab])
  async function detectModels() {
    if (locked.current) return
    if (draft.source === 'account' && usingAutomaticKey) { setError('选了自动准备时，请点「保存并检测模型」。'); return }
    if (draft.source === 'account' && !usingCurrentKey && !selectedKey) { setError('所选密钥已不可用，请重新选择。'); return }
    locked.current = true
    const id = ++request.current
    setModelsDetected(false)
    setBusy('检测模型'); setError('')
    try {
      const result = draft.source === 'manual' ? await api.manualModels(draft.secret)
        : usingCurrentKey ? await api.configuredModels(tab) : await api.keyModels(selectedKey!.id)
      if (!active.current || id !== request.current) return
      setModels(result)
      setModelsDetected(true)
      // Filtering does not change the user's existing selection. In this mode
      // they must explicitly pick a detected non-GPT model before saving.
      if (activeModelFilter === 'non-gpt') {
        if (draft.source === 'manual') change({ validatedSecret: draft.secret })
        return
      }
      const suggested = resolveDefaultCliModel(provider, result, draft.model) ?? ''
      if (draft.source === 'manual') change({ validatedSecret: draft.secret, model: suggested })
      else if (!draft.model || (!native.model && !result.includes(draft.model))) change({ model: suggested })
    } catch (cause) { if (active.current && id === request.current) setError(errorMessage(cause, '模型检测未完成')) }
    finally { locked.current = false; if (active.current) setBusy('') }
  }
  async function run(label: string, operation: () => Promise<void>) {
    if (locked.current) return
    locked.current = true; setBusy(label); setError(''); setWarning('')
    try { await operation() }
    catch (cause) { if (active.current) setError(errorMessage(cause, `${label}没有成功`)) }
    finally { locked.current = false; if (active.current) setBusy('') }
  }
  /** 保存与重置共用同一套前置检查；返回 false 表示已经把原因写进了错误提示。 */
  function readyToSave(): boolean {
    if (draft.source === 'unknown') return false
    if (nonGptSaveIssue) { setError(nonGptSaveIssue); return false }
    if (draft.source === 'account' && !signedIn && !usingCurrentKey) { onLogin(); return false }
    if (draft.source === 'account') {
      if (usingCurrentKey && !native.hasApiKey) { setError('当前工具没有可保留的密钥，请重新选择。'); return false }
      if (usingAutomaticKey && (!metadata || metadataLoading[provider] || metadataErrors[provider])) { setError('还没读到当前账号的密钥信息，请稍等片刻或点「刷新密钥」。'); return false }
      if (!usingCurrentKey && !usingAutomaticKey && (!selectedKey || selectedKey.status !== 1)) { setError('所选密钥已不可用，请重新选择。'); return false }
      if (!usingCurrentKey && !usingAutomaticKey && (keysLoading || keyError)) { setError('请先获取最新的账号密钥列表。'); return false }
      if (!usingAutomaticKey && !draft.model) { setError('请选择默认模型。'); return false }
    }
    if (draft.source === 'manual' && (!draft.secret || draft.validatedSecret !== draft.secret || !models.includes(draft.model))) {
      setError('请先检测这把密钥的可用模型，再选择模型保存。'); return false
    }
    setError('')
    return true
  }
  // 小白分不清「只更新」和「重置」，保存默认就是只改账号、密钥和模型（merge）；
  // 重置收进「高级」，仍要二次确认。两条路都由主进程先备份再两阶段写入（I9）。
  function requestSave() {
    if (readyToSave()) save('merge')
  }
  function requestReset() {
    if (readyToSave()) setConfirmation('reset')
  }
  // 自动准备的密钥要先写进配置才有模型可查。以前让用户「先保存、再打开、再检测」，
  // 这里一步做完：保存（merge）后留在对话框里，用刚写好的配置列出模型。
  async function saveAndDetectModels() {
    if (locked.current || !usingAutomaticKey || !readyToSave()) return
    locked.current = true
    const id = ++request.current
    setModelsDetected(false)
    setBusy('保存并检测'); setError(''); setWarning(''); setNotice('')
    let saved = false
    try {
      const outcome = await api.configureManaged(tab, draft.model || undefined, 'merge')
      if (outcome.failed.length) throw new Error(outcome.failed.map((item) => item.message).join('；'))
      if (!outcome.configured.includes(provider)) throw new Error('工具没有返回配置写入结果，请重新检测后再试。')
      saved = true
      const markerWarning = applyManualSourceMarker(sourceStorage, native.baseUrl, provider, false)
      if (!active.current) return
      // 首页状态刷新失败不影响已经写好的配置，模型照样检测。主进程可能因为分组里
      // 没有所选模型而换了一个，以实际写进去的为准，别让下拉框和配置文件对不上。
      await onRefresh().catch(() => undefined)
      const latest = await api.readConfig().catch(() => null)
      const savedModel = latest?.providers[provider].model || draft.model
      if (!active.current) return
      setDrafts((current) => ({ ...current, [provider]: { ...draft, model: savedModel, dirty: false } }))
      const result = await api.configuredModels(tab)
      if (!active.current || id !== request.current) return
      setModels(result)
      setModelsDetected(true)
      const suggested = result.includes(savedModel) ? savedModel : resolveDefaultCliModel(provider, result, savedModel) ?? ''
      if (suggested && suggested !== savedModel) change({ model: suggested })
      if (markerWarning) setWarning(markerWarning)
      setNotice('密钥已准备好并保存。想换模型就在上面选，选完再点「保存配置」。')
    } catch (cause) {
      if (!active.current || id !== request.current) return
      // 写进去了就要说清楚，否则用户会以为什么都没改、再去点一遍。
      setError(saved ? `配置已保存，但模型列表暂时没读到：${errorMessage(cause, '请稍后再点一次')}` : errorMessage(cause, '保存并检测模型没有成功'))
    }
    finally { locked.current = false; if (active.current) setBusy('') }
  }
  function save(mode: 'merge' | 'reset') {
    if (nonGptSaveIssue) { setError(nonGptSaveIssue); return }
    void run('保存配置', async () => {
      const provider = providerFor(tab)
      let markerWarning = ''
      if (draft.source === 'official') {
        await api.official(tab, mode)
        markerWarning = applyManualSourceMarker(sourceStorage, native.baseUrl, provider, false)
      }
      else if (draft.source === 'manual') {
        await api.saveManual({ provider, apiKey: draft.secret, model: draft.model, mode })
        markerWarning = applyManualSourceMarker(sourceStorage, native.baseUrl, provider, true)
      }
      else if (usingCurrentKey) {
        // Empty is the main-process reuse sentinel. It never reveals or
        // replaces the local key and must not mark its source as manual.
        await api.saveManual({ provider, apiKey: '', model: draft.model, mode })
      }
      else if (selectedKey) {
        await api.saveAccountKey({ provider, keyId: selectedKey.id, model: draft.model, mode })
        markerWarning = applyManualSourceMarker(sourceStorage, native.baseUrl, provider, false)
      }
      else if (usingAutomaticKey) {
        const result = await api.configureManaged(tab, draft.model || undefined, mode)
        if (result.failed.length) throw new Error(result.failed.map((item) => item.message).join('；'))
        if (!result.configured.includes(provider)) throw new Error('工具没有返回配置写入结果，请重新检测后再试。')
        markerWarning = applyManualSourceMarker(sourceStorage, native.baseUrl, provider, false)
      }
      else throw new Error('请选择要保存的密钥。')
      if (!active.current) return
      // The host has committed the write. Close through the owner so feedback
      // survives this dialog's unmount; a later refresh cannot undo that save.
      onSaved(markerWarning || undefined)
    })
  }
  const officialName = officialAccountNames[provider] ?? '官方账号'
  // 官方来源仍然可选,但它的限制要跟选项一起出现,而不是等用户选完再弹窗。
  const officialNote = definition.sources.includes('official') ? officialAccountNotes[provider] : null
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
  // 「分组」对小白没有意义，下拉框和摘要都不再写它；需要核对时在「高级」里看。
  const automaticLabel = metadata
    ? '自动准备（推荐）'
    : metadataErrors[provider] ? '自动准备 · 账号信息暂时没读到' : '自动准备 · 正在读取账号信息'
  const keySummary = usingAutomaticKey ? '保存时自动准备好密钥，不用自己创建'
    : `${usingCurrentKey ? '继续用现在这把密钥' : '用你选的这把密钥'}：${keyDescription.name} · ${keyDescription.preview}`
  const saveSummary = <div data-testid="tool-save-summary">{draft.source === 'official' ? <p>来源：{officialName}</p> : <><p>密钥：{keyDescription.name}</p><p>分组：{keyDescription.group}</p><p>预览：{keyDescription.preview}</p><p>模型：{draft.model || '使用该分组默认模型'}</p></>}</div>
  return <>
    <Dialog open title={`${definition.name} 配置`} subtitle="选好账号后，保存并打开工具即可开始。" icon={Settings} width={640}
      onClose={onClose} busy={Boolean(busy)} dirty={Object.values(drafts).some((entry) => entry?.dirty)} testId="config-dialog"
      footer={<><Button variant="ghost" onClick={() => requestExit(onClose)} disabled={Boolean(busy)}>取消</Button><Button variant="primary" icon={Save} loading={Boolean(busy)} disabled={draft.source === 'unknown' || Boolean(nonGptSaveIssue)} aria-describedby={nonGptSaveIssue ? modelFilterStatusId : undefined} onClick={requestSave} testId="tool-save-config">保存配置</Button></>}>
      <fieldset className="v2-config-controls" disabled={Boolean(busy)}>
      <Tabs label="选择要配置的工具" items={tools.filter((entry) => isToolId(entry.id)).map((entry) => ({ value: entry.id, label: entry.name, disabled: Boolean(busy) }))}
        value={tab} onChange={(value) => { if (isToolId(value)) setTab(value) }} />
      {providerFor(tab) === 'codex' && <p className="v2-callout">Codex 桌面端与 Codex CLI 共用这份配置。模型和来源在任一入口修改后会同步。</p>}
      {draft.source === 'unknown' ? <><p className="v2-callout is-warn">{native.matchesRelay ? '这份配置的密钥来源尚未确认，已保留原配置。' : '这份配置连接了其他服务。'}保存新来源前会备份当前配置，历史会话会保留。</p><div className="v2-inline-actions"><Button onClick={() => change({ source: 'account' })}>切换为星芒账号</Button><Button onClick={() => change({ source: 'manual' })}>填写星芒密钥</Button><Button variant="ghost" onClick={onHelp}>查看处理步骤</Button></div></> : <>
        <div className="v2-config-field"><strong>用哪个账号使用 AI</strong><Segment options={sourceOptions} value={draft.source} onChange={(value) => {
          if (value === 'account' || value === 'manual' || value === 'official') change({ source: value })
        }} />{officialNote && <p data-testid="tool-source-note">{officialNote}</p>}</div>
        {draft.source === 'official' ? <><div className="v2-official-summary"><BrandIcon tool={tab} /><div><strong>{native.officialAccountEmail || `使用 ${officialName}`}</strong><p>{native.officialAccountPlan ?? '保存来源后，在工具中完成官方登录。'}</p></div><Pill tone={native.officialAccountEmail ? 'ok' : 'warn'}>{native.officialAccountEmail ? '已登录' : '待登录'}</Pill></div>
          {nonGptSaveIssue && <div className="v2-config-field"><p id={modelFilterStatusId} role="status" data-testid="tool-model-filter-status">{nonGptSaveIssue}</p><Button size="sm" variant="ghost" onClick={() => setModelFilter('all')}>继续配置官方模型</Button></div>}</> : <>
          {draft.source === 'account' ? <div className="v2-config-field"><Select label="访问密钥（Key）" testId="tool-key-select" value={draft.keyId} onFocus={() => refreshKeyOptions()} onPointerDown={() => refreshKeyOptions()} onKeyDown={(event) => { if (['ArrowDown', 'ArrowUp', ' ', 'Enter', 'F4'].includes(event.key)) refreshKeyOptions() }} onChange={(event) => change({ keyId: event.target.value })}
            options={[
              ...(native.hasApiKey || usingCurrentKey ? [{ value: CURRENT_KEY, label: currentKeyLabel(metadata, native.apiKeyPreview), disabled: !native.hasApiKey }] : []),
              { value: AUTOMATIC_KEY, label: automaticLabel, disabled: !metadata || Boolean(metadataLoading[provider]) || Boolean(metadataErrors[provider]) },
              ...keys.filter((key) => key.status === 1).map((key) => ({ value: String(key.id), label: accountKeyLabel(key) })),
              ...(!usingCurrentKey && !usingAutomaticKey && !selectedKey ? [{ value: draft.keyId, label: '所选密钥已不可用，请重新选择', disabled: true }] : []),
            ]} disabled={!signedIn} />
            <p data-testid="tool-key-summary">{keySummary}</p>
            {metadataErrors[provider] && <p role="alert">{metadataErrors[provider]}</p>}
            {keyError && <p role="alert">{keyError}</p>}<div className="v2-inline-actions"><Button variant="ghost" size="sm" icon={RefreshCw} testId="tool-key-refresh" loading={keysLoading || metadataLoading[provider]} onClick={() => refreshKeyOptions(true)} disabled={!signedIn}>刷新密钥</Button><Button variant="ghost" size="sm" icon={KeyRound} onClick={() => requestExit(onKeys)}>管理密钥</Button></div></div>
            : <div className="v2-config-field"><Input label="星芒访问密钥" type="password" value={draft.secret} onChange={(event) => change({ secret: event.target.value, validatedSecret: '' })} placeholder={native.apiKeyPreview ?? '粘贴你在星芒创建的密钥'} />
              {native.hasApiKey && <Button size="sm" variant="ghost" icon={Eye} onClick={() => void run('读取密钥', async () => { const secret = await api.reveal(tab); if (active.current) change({ secret, validatedSecret: '' }) })}>读取当前密钥</Button>}</div>}
          <div className="v2-config-field">
            {provider === 'codex' && <Segment label="Codex 模型筛选" testId="tool-codex-model-filter" options={[{ value: 'all', label: '全部模型' }, { value: 'non-gpt', label: '别家模型' }]} value={modelFilter} onChange={(value) => { if (value === 'all' || value === 'non-gpt') { setModelFilter(value); setError('') } }} />}
            <Select label="默认模型" testId="tool-default-model" value={draft.model} options={[...(!draft.model ? [{ value: '', label: activeModelFilter === 'non-gpt' ? '请选择别家模型' : '请先检测模型', disabled: true }] : []), ...modelChoices.options]} onChange={(event) => change({ model: event.target.value })} />
            {draft.source === 'account' && usingAutomaticKey
              ? <Button size="sm" variant="secondary" icon={RefreshCw} testId="tool-save-detect-models" loading={busy === '保存并检测'} onClick={() => void saveAndDetectModels()} disabled={activeModelFilter !== 'all' || !metadata || Boolean(metadataLoading[provider]) || Boolean(metadataErrors[provider])}>保存并检测模型</Button>
              : <Button size="sm" variant="secondary" icon={RefreshCw} testId="tool-detect-models" loading={busy === '检测模型'} onClick={() => void detectModels()} disabled={draft.source === 'manual' && !draft.secret}>检测模型</Button>}
            {provider === 'codex' && <p>列表里的模型来自当前账号，不是每个都能在 Codex 里用，拿不准就选默认的。</p>}
            {nonGptSaveIssue && <p id={modelFilterStatusId} role="status" data-testid="tool-model-filter-status">{nonGptSaveIssue}</p>}
            {draft.source === 'account' && usingAutomaticKey && activeModelFilter === 'all' && <p>点「保存并检测模型」会先把密钥准备好、保存，再列出能用的模型。</p>}
            {notice && <p role="status" data-testid="tool-save-detect-notice">{notice}</p>}</div>
        </>}
      </>}
      <div className="v2-config-field"><Input label="打开工具时进入的文件夹" readOnly value={config.workspace} /><Button size="sm" icon={FolderOpen} onClick={() => void run('选择文件夹', async () => { if (await api.chooseWorkspace()) await onRefresh() })}>选择文件夹</Button></div>
      {tab === 'codexDesktop' && <details><summary>界面语言与文件夹权限</summary><p>已设置中文但仍显示英文时，可再次点击启用。运行中的 Codex 会重新打开，请先保存手头的工作。</p>
        <p>Codex 自己的界面翻译需要星芒在每次打开 Codex 时附带一个仅限本机的调试端口，Codex 关闭后端口随之关闭。不需要中文界面时，选「跟随系统语言」即可不再开启该端口。</p><div className="v2-inline-actions"><Button size="sm" onClick={() => void run('检查中文界面', async () => { const value = await api.getLocale(); if (value.error) throw new Error(value.error); if (active.current) setLocaleText(describeChineseLocale(value)) })}>检查中文界面</Button>
        <Button size="sm" onClick={() => void run('启用中文界面', async () => { setLocaleText(''); const result = await api.setLocale(); if (result.error) throw new Error(result.error); if (active.current) { if (result.warning) setWarning(result.warning); else setLocaleText(describeChineseLocaleResult(result)) } })}>启用中文界面</Button>
        <Button size="sm" onClick={() => void run('跟随系统语言', async () => { setLocaleText(''); const result = await api.setLocale('system'); if (result.error) throw new Error(result.error); if (active.current) setLocaleText(describeChineseLocaleResult(result)) })}>跟随系统语言</Button>
        <Button size="sm" onClick={() => void run('查看文件夹权限', async () => { const result = await api.getPermissions(); if (active.current) setLocaleText(`工作目录：${result.workspace}，信任状态：${result.trustLevel}`) })}>查看文件夹权限</Button>
        <Button size="sm" onClick={() => void run('信任当前文件夹', async () => { await api.trustWorkspace(); if (active.current) setLocaleText('文件夹信任已保存') })}>信任当前文件夹</Button></div>{localeText && <p role="status">{localeText}</p>}</details>}
      <details data-testid="tool-config-advanced"><summary>高级</summary>
        <p>点「保存配置」只改账号、密钥和模型，你在工具里做的其他设置都会留着；改之前会先自动备份。</p>
        {draft.source !== 'unknown' && saveSummary}
        {provider === 'codex' && <p className="v2-save-profile-note">星芒与 ChatGPT 各自保留一份配置；切换来源时，优先恢复该来源上次保存的自定义设置。</p>}
        <div className="v2-code-preview">{native.files.map((file) => <div key={file.path}><code>{file.path}</code><span>{file.exists ? '已存在' : '尚未创建'}</span></div>)}</div>
        {draft.source !== 'unknown' && <div className="v2-save-options"><Button variant="danger" onClick={requestReset} disabled={Boolean(nonGptSaveIssue)} testId="tool-save-reset"><strong>重置为初始状态</strong><small>配置乱了想从头来过时再用：先备份，再按上面选的账号重新生成配置。历史会话会保留。</small></Button></div>}</details>
      </fieldset>
      {error && !confirmation && <p className="v2-callout is-bad" role="alert">{error}</p>}{warning && <p className="v2-callout is-warn" role="status">{warning}</p>}
    </Dialog>
    {confirmation === 'reset' && <Confirm title="重置为初始状态？" body={<><p>将先备份当前配置，再按所选账号来源重建配置。{provider === 'codex' ? '该来源' : '当前工具'}的自定义设置（如权限、MCP 和推理参数）会重置，历史会话和官方登录凭据会保留。</p>{saveSummary}{error && <p role="alert" className="v2-callout is-bad">{error}</p>}</>} okLabel="备份并重置" cancelLabel="取消" danger loading={Boolean(busy)} onClose={() => { setError(''); setConfirmation(null) }} onOk={() => save('reset')} />}
    {exitAction && <Confirm title="要放弃未保存的修改吗？" body="关闭后，这次修改不会保存。" okLabel="放弃修改" cancelLabel="继续编辑" danger onClose={() => setExitAction(null)} onOk={() => { const action = exitAction; setExitAction(null); action() }} />}
  </>
}
