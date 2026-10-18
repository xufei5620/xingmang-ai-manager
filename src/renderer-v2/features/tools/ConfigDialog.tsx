import { useEffect, useRef, useState } from 'react'
import { Archive, Check, Copy, Eye, FolderOpen, KeyRound, RefreshCw, Save, ShieldCheck } from 'lucide-react'
import type { AccountKey, AccountSourceSwitchResult, AppConfigSummary, CliModelHints, CodexDesktopLocaleStatus, CodexWorkspacePermissionStatus } from '../../../../electron/ipc-contract'
import { resolveCliModelDefault, resolveDefaultCliModel } from '../../../../electron/cli-model-defaults'
import { BrandIcon, Button, Dialog, Input, Pill, Segment, Select, useToast } from '../../ui'
import { officialAccountNames, officialAccountNotes, tools } from '../../registry/tools'
import { brokenConfigOf, brokenConfigRepairTarget, codexNeedsRepair, foreignKeyKind, isToolId, providerFor, sourceFor, switchAccountLabel, type ToolId } from './model'
import { applyManualSourceMarker, getSourceMarkerStorage } from './source-marker'
import type { ToolsApi } from './api'
import { accountKeyDescription, AUTOMATIC_KEY, CURRENT_KEY, currentKeyLabel, initialKeyChoice, listedAccountKeys, manualKeyIssue, manualKeyPreview, type ConfigKeyMetadata } from './key-selection'
import { describeChineseLocale, describeChineseLocaleResult, describeWorkspaceTrustResult, macLocaleNote } from './locale-status'
import { codexModelChoices, isHiddenCodexModel, type CodexModelFilter } from './model-filter'
import { DialogExitButton, DialogExitLink, RadioCards, type RadioCardOption } from './dialog-parts'
import { OptionPicker, type PickerOption } from './OptionPicker'
import { OtherModelsDialog } from './OtherModelsDialog'
import { errorMessage, FailureReason, failureWithDetail } from '../../business-common'
import { currentWindowOs } from '../app/window-os'

type SourceChoice = 'account' | 'official' | 'manual' | 'unknown'
// 保存这类操作失败时连原话一起留着，红字和页顶红条一个认法（FailureReason）：认得出是「工具正在
// 运行」这类原因就先说原因，原来那句跟在后面。没过前置检查的提示还是一句话。
type DialogError = string | ReturnType<typeof failureWithDetail>
interface ConfigDraft { source: SourceChoice; keyId: string; secret: string; model: string; validatedSecret: string; dirty: boolean }
/** 保存成功后页顶那句按哪种说：重置、换成官方账号，还是一般的保存。 */
export type ConfigSaveOutcome = 'saved' | 'reset' | 'official'
export interface ConfigDialogProps {
  api: ToolsApi
  tool: ToolId
  config: AppConfigSummary
  signedIn: boolean
  /** 'non-gpt' = Codex 首页「换用别家模型」进来的，开的是那个小弹窗，不是整份配置。 */
  initialModelFilter?: CodexModelFilter
  /** 只有星芒的密钥确定是 sk- 开头，填密钥时才按这个格式拦；缺省 = 只拦空的（旧行为）。 */
  strictKeyFormat?: boolean
  /**
   * 「查看 ChatGPT 账号额度」：先关掉配置（有没保存的修改照旧先问），再打开额度弹窗——同一时间只开一个弹窗。
   * 缺省 = 不给这个链接。
   */
  onOfficialQuota?(): void
  onClose(): void
  onRefresh(): Promise<void>
  onSaved(warning?: string, outcome?: ConfigSaveOutcome): void
  /**
   * 主进程已经把一把新的 Key（或官方登录）写进这个工具；原样沿用现有 Key 的保存不算。
   * 密钥页靠它收起「还在用刚撤销的密钥」（#546）。缺省 = 不通知（旧行为）。
   */
  onKeyWritten?(tool: ToolId): void
  onLogin(): void
  onKeys(): void
  /** 「高级」里的「查看配置备份」；缺省 = 不给这颗按钮。 */
  onBackups?(): void
  onHelp(): void
  /** 按钮上写的账号名（「改用 <名>」）；没登录为 null。 */
  accountName?: string | null
  /**
   * 来源没确认时的一键「改用当前账号」：备份、写入、自检、失败恢复都在主进程做完，
   * 失败由调用方弹统一的错误框；返回 null = 没切成（没登录时先去登录，或失败了）。
   * 缺省 = 旧行为，只能自己选来源再保存。
   */
  onSwitchAccount?(tool: ToolId): Promise<AccountSourceSwitchResult | null>
}

/**
 * 只给注册表里的工具开配置框。已下线的工具（Gemini）不在注册表里，就算有地方点名它也不开：
 * 星芒不再替它改配置，下面也找不到它的定义。
 */
export function ConfigDialog(props: ConfigDialogProps) {
  if (!isToolId(props.tool)) return null
  if (props.initialModelFilter === 'non-gpt' && providerFor(props.tool) === 'codex') return <OtherModelsDialog {...props} />
  return <RegisteredToolConfigDialog {...props} />
}

function RegisteredToolConfigDialog({ api, tool, config, signedIn, strictKeyFormat = false, onOfficialQuota, onClose, onRefresh, onSaved, onKeyWritten, onLogin, onKeys, onBackups, accountName = null, onSwitchAccount }: ConfigDialogProps) {
  const [edited, setEdited] = useState<ConfigDraft | null>(null)
  const [keys, setKeys] = useState<AccountKey[]>([])
  const [models, setModels] = useState<string[]>([])
  const [modelsDetected, setModelsDetected] = useState(false)
  // 服务状态文件里的型号表：没设型号的工具预选哪个、检测完替他挑哪个，跟登录自动配置一个口径（#1154 附录）。
  // 读到之前（和读不到）按程序自带的那份。
  const [modelHints, setModelHints] = useState<CliModelHints | null>(null)
  // 「保存并检测」的检测这一步没读成：已有密钥的照旧能直接保存，按钮换回「保存配置」。
  const [detectTried, setDetectTried] = useState(false)
  // 打开时自动读的那一次的编号，0 = 没在读。按编号清：先发的那次晚到时，关不掉后发那次的转圈。
  const [autoDetectId, setAutoDetectId] = useState(0)
  const [keyError, setKeyError] = useState('')
  const [keyRevision, setKeyRevision] = useState(0)
  const [keysLoading, setKeysLoading] = useState(false)
  const [metadata, setMetadata] = useState<ConfigKeyMetadata | null>(null)
  const [metadataError, setMetadataError] = useState('')
  const [metadataLoading, setMetadataLoading] = useState(false)
  const [error, setError] = useState<DialogError>('')
  const [secretError, setSecretError] = useState('')
  const [warning, setWarning] = useState('')
  const [busy, setBusy] = useState('')
  const [resetAsk, setResetAsk] = useState(false)
  const [notice, setNotice] = useState('')
  const [locale, setLocale] = useState<CodexDesktopLocaleStatus | null>(null)
  const [permission, setPermission] = useState<CodexWorkspacePermissionStatus | null>(null)
  const [localeText, setLocaleText] = useState('')
  const request = useRef(0)
  const active = useRef(true)
  const locked = useRef(false)
  const metadataRequest = useRef(0)
  const lastKeyRefresh = useRef(0)
  const desktopLoaded = useRef(false)
  const toast = useToast()
  // 只用来分 Mac 的说法：Mac 上星芒不会替人重开 Codex，也不开那条本机通道。
  const os = currentWindowOs()
  const provider = providerFor(tool)
  const native = config.providers[provider]
  const definition = tools.find((item) => item.id === tool)!
  const sourceStorage = getSourceMarkerStorage()
  const switchLabel = switchAccountLabel(accountName)
  const currentSource = sourceFor(native, provider, sourceStorage)
  // 工具自己读不了的文件，星芒读不出 Key 时会认成官方账号（已知44）。这时先选上首页「修好它」
  // 会用的那边，展开「高级」点重置就和点「修好它」一样；读得出官方登录的照旧是官方账号。
  const broken = brokenConfigOf(native, provider)
  const initialSource = currentSource === 'official' && broken && brokenConfigRepairTarget(broken, native) === 'account' ? 'account' : currentSource
  const draft: ConfigDraft = edited ?? {
    // 「被改过」在这个对话框里和「来源未确认」走同一条路：都要先让用户挑一个来源，
    // 挑完保存就把所有权重新写清楚。
    source: initialSource === 'missing' ? 'account' : initialSource === 'changed' ? 'unknown' : initialSource,
    keyId: initialKeyChoice(native), secret: '', model: native.model || resolveCliModelDefault(provider, modelHints), validatedSecret: '', dirty: false,
  }
  const selectedKey = keys.find((key) => String(key.id) === draft.keyId && key.status === 1)
  const usingCurrentKey = draft.keyId === CURRENT_KEY
  const usingAutomaticKey = draft.keyId === AUTOMATIC_KEY
  const modelChoices = codexModelChoices(models, 'all', draft.model)
  function refreshKeyOptions(force = false) {
    if (!signedIn || locked.current || keysLoading) return
    if (!force && Date.now() - lastKeyRefresh.current < 500) return
    lastKeyRefresh.current = Date.now()
    setKeyRevision((value) => value + 1)
  }
  function change(patch: Partial<ConfigDraft>) {
    setEdited({ ...draft, ...patch, dirty: true })
    setError('')
    setSecretError('')
    setWarning('')
    setNotice('')
    setResetAsk(false)
  }
  useEffect(() => { active.current = true; return () => { active.current = false; request.current++; metadataRequest.current++ } }, [])
  useEffect(() => {
    let current = true
    void api.cliModelHints().then((value) => { if (current) setModelHints(value) })
    return () => { current = false }
  }, [api])
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
    setMetadataLoading(true)
    setMetadataError('')
    void api.readKeyOptions(tool).then((value) => {
      if (active.current && owner === metadataRequest.current) setMetadata(value)
    }).catch((cause) => {
      if (active.current && owner === metadataRequest.current) setMetadataError(errorMessage(cause, '当前密钥信息暂时没有读到'))
    }).finally(() => {
      if (active.current && owner === metadataRequest.current) setMetadataLoading(false)
    })
    return () => { metadataRequest.current++ }
  }, [api, signedIn, tool, keyRevision])
  useEffect(() => {
    request.current++
    setModels([])
    setModelsDetected(false)
    setDetectTried(false)
    setAutoDetectId(0)
    setError('')
  }, [draft.source, draft.keyId, draft.secret])
  // 下拉框里只有已选的那一个型号时，客户会以为只能用它（「为什么没有 6.1 Sol」）。
  // 工具里已经是当前账号的 Key，就在打开窗口时替他读一次：只把读到的放进下拉框，选中的
  // 型号不动、也不算改动（关窗口不会问要不要放弃）；不锁窗口；读不到不出红字，「检测模型」
  // 还在，点了照旧说清原因。没登录不读（这时账号相关的选项都是灰的），也免得没登录跑的
  // Mac 界面检查拿占位 Key 去请求正式服务。
  useEffect(() => {
    if (!signedIn || draft.source !== 'account' || !usingCurrentKey || !native.hasApiKey || !native.matchesRelay) return
    const id = ++request.current
    setAutoDetectId(id)
    void api.configuredModels(tool).then(offeredModels).then((result) => {
      if (!active.current || id !== request.current) return
      setModels(result)
      setModelsDetected(true)
    }).catch(() => undefined).finally(() => {
      if (active.current) setAutoDetectId((current) => current === id ? 0 : current)
    })
  }, [])
  /** 读到的型号先过一遍：Codex 不列 grok-4.6（isHiddenCodexModel），别的工具照原样。 */
  function offeredModels(result: string[]) {
    return provider === 'codex' ? result.filter((model) => !isHiddenCodexModel(model)) : result
  }
  function listModels(target: ConfigDraft) {
    const chosen = keys.find((key) => String(key.id) === target.keyId && key.status === 1)
    return (target.source === 'manual' ? api.manualModels(target.secret)
      : target.keyId === CURRENT_KEY || !chosen ? api.configuredModels(tool) : api.keyModels(chosen.id)).then(offeredModels)
  }
  /** 检测完替用户选好型号：自己填的密钥按读到的挑；已经选了的、工具里本来就配着的不动。 */
  function detectedDraft(target: ConfigDraft, result: string[]): ConfigDraft {
    const suggested = resolveDefaultCliModel(provider, result, target.model, modelHints) ?? ''
    if (target.source === 'manual') return { ...target, validatedSecret: target.secret, model: suggested }
    if (!target.model || (!native.model && !result.includes(target.model))) return { ...target, model: suggested }
    return target
  }
  /** 检测前的检查，过了返回 true；没过的已经写进了提示（没登录的直接去登录）。 */
  function readyToDetect(target: ConfigDraft): boolean {
    if (target.source === 'manual') {
      const issue = manualKeyIssue(target.secret, strictKeyFormat)
      if (issue) { setSecretError(issue); return false }
    }
    if (target.source === 'account' && !signedIn && target.keyId !== CURRENT_KEY) { onLogin(); return false }
    if (target.source === 'account' && target.keyId !== CURRENT_KEY && !keys.some((key) => String(key.id) === target.keyId && key.status === 1)) {
      setError('所选密钥已不可用，请重新选择。'); return false
    }
    return true
  }
  async function detectModels() {
    if (locked.current || !readyToDetect(draft)) return
    const target = draft
    locked.current = true
    const id = ++request.current
    setModelsDetected(false)
    setBusy('检测模型'); setError('')
    try {
      const result = await listModels(target)
      if (!active.current || id !== request.current) return
      setModels(result)
      setModelsDetected(true)
      const next = detectedDraft(target, result)
      if (next !== target) change(next)
      if (!result.length) setError('这把密钥没有可用模型，请换一把密钥后重新检测。')
    } catch (cause) {
      if (active.current && id === request.current) { setError(errorMessage(cause, '模型检测未完成')); setDetectTried(true) }
    }
    finally { locked.current = false; if (active.current) setBusy('') }
  }
  // 底栏「保存并检测」：先列出这把密钥能用的模型，选中的型号能用就接着保存；不能用就停在
  // 这里让用户自己挑，按钮跟着变回「保存配置」。
  async function detectThenSave() {
    if (locked.current || !readyToDetect(draft)) return
    const target = draft
    locked.current = true
    const id = ++request.current
    setModelsDetected(false)
    setBusy('保存并检测'); setError(''); setWarning(''); setNotice('')
    let result: string[] | null = null
    try { result = await listModels(target) }
    catch (cause) { if (active.current && id === request.current) { setError(errorMessage(cause, '模型检测未完成')); setDetectTried(true) } }
    finally { locked.current = false; if (active.current) setBusy('') }
    if (!result || !active.current || id !== request.current) return
    setModels(result)
    setModelsDetected(true)
    const next = detectedDraft(target, result)
    if (next !== target) change(next)
    if (!result.length) { setError('这把密钥没有可用模型，请换一把密钥后重新检测。'); return }
    if (!result.includes(next.model)) { setError('请选择默认模型。'); return }
    if (readyToSave(next, result)) commit('merge', next)
  }
  async function run(label: string, operation: () => Promise<void>) {
    if (locked.current) return
    locked.current = true; setBusy(label); setError(''); setWarning('')
    try { await operation() }
    catch (cause) { if (active.current) setError(failureWithDetail(cause, `${label}没有成功`)) }
    finally { locked.current = false; if (active.current) setBusy('') }
  }
  // 一键改用当前账号：成功后留在对话框里说一句结果（一闪而过的提示容易看漏），
  // 草稿跟着新配置重来；失败由调用方弹统一的错误框。
  async function switchAccount() {
    if (!onSwitchAccount || locked.current) return
    if (!signedIn) { onLogin(); return }
    locked.current = true; setBusy('改用当前账号'); setError(''); setWarning(''); setNotice('')
    try {
      const result = await onSwitchAccount(tool)
      if (result) onKeyWritten?.(tool)
      if (!active.current || !result) return
      setEdited(null)
      setNotice(result.verified ? `已${switchLabel}，可以开始用了。` : `已${switchLabel}。${result.message.replace(/^已改用当前账号[，。]?/, '')}`)
    } finally { locked.current = false; if (active.current) setBusy('') }
  }
  /** 保存与重置共用同一套前置检查；返回 false 表示已经把原因写进了提示。 */
  function readyToSave(target: ConfigDraft, detected: readonly string[]): boolean {
    const current = target.keyId === CURRENT_KEY
    const automatic = target.keyId === AUTOMATIC_KEY
    const chosen = keys.find((key) => String(key.id) === target.keyId && key.status === 1)
    if (target.source === 'unknown') return false
    if (target.source === 'account' && !signedIn && !current) { onLogin(); return false }
    if (target.source === 'account') {
      if (current && !native.hasApiKey) { setError('当前工具没有可保留的密钥，请重新选择。'); return false }
      if (automatic && (!metadata || metadataLoading || metadataError)) { setError('还没读到当前账号的密钥信息，请稍等片刻或点「刷新密钥」。'); return false }
      if (!current && !automatic && !chosen) { setError('所选密钥已不可用，请重新选择。'); return false }
      if (!current && !automatic && (keysLoading || keyError)) { setError('请先获取最新的账号密钥列表。'); return false }
      if (!automatic && !target.model) { setError('请选择默认模型。'); return false }
    }
    if (target.source === 'manual') {
      const issue = manualKeyIssue(target.secret, strictKeyFormat)
      if (issue) { setSecretError(issue); return false }
      if (target.validatedSecret !== target.secret || !detected.includes(target.model)) { setError('请先检测这把密钥的可用模型，再选择模型保存。'); return false }
    }
    setError('')
    return true
  }
  // 自动准备的密钥要先写进配置才有模型可查。以前让用户「先保存、再打开、再检测」，
  // 这里一步做完：保存（merge）后留在对话框里，用刚写好的配置列出模型。
  async function saveAndDetectModels() {
    if (locked.current || !usingAutomaticKey || !readyToSave(draft, models)) return
    locked.current = true
    const id = ++request.current
    setModelsDetected(false)
    setBusy('保存并检测'); setError(''); setWarning(''); setNotice('')
    let saved = false
    try {
      const outcome = await api.configureManaged(tool, draft.model || undefined, 'merge')
      if (outcome.failed.length) throw new Error(outcome.failed.map((item) => item.message).join('；'))
      if (!outcome.configured.includes(provider)) throw new Error('工具没有返回配置写入结果，请重新检测后再试。')
      saved = true
      onKeyWritten?.(tool)
      const markerWarning = applyManualSourceMarker(sourceStorage, native.baseUrl, provider, false)
      if (!active.current) return
      // 首页状态刷新失败不影响已经写好的配置，模型照样检测。主进程可能因为分组里
      // 没有所选模型而换了一个，以实际写进去的为准，别让下拉框和配置文件对不上。
      await onRefresh().catch(() => undefined)
      const latest = await api.readConfig().catch(() => null)
      const savedModel = latest?.providers[provider].model || draft.model
      if (!active.current) return
      const savedDraft = { ...draft, model: savedModel, dirty: false }
      setEdited(savedDraft)
      const result = offeredModels(await api.configuredModels(tool))
      if (!active.current || id !== request.current) return
      setModels(result)
      setModelsDetected(true)
      const suggested = result.includes(savedModel) ? savedModel : resolveDefaultCliModel(provider, result, savedModel, modelHints) ?? ''
      if (suggested && suggested !== savedModel) setEdited({ ...savedDraft, model: suggested, dirty: true })
      if (markerWarning) setWarning(markerWarning)
      setNotice('密钥已准备好并保存。想换模型就在上面选，选完再点「保存配置」。')
    } catch (cause) {
      if (!active.current || id !== request.current) return
      // 写进去了就要说清楚，否则用户会以为什么都没改、再去点一遍。
      setError(saved ? `配置已保存，但模型列表暂时没读到：${errorMessage(cause, '请稍后再点一次')}` : failureWithDetail(cause, '保存并检测没有成功'))
    }
    finally { locked.current = false; if (active.current) setBusy('') }
  }
  // 小白分不清「只更新」和「重置」，保存默认就是只改账号、密钥和模型（merge）；
  // 重置收进「高级」，仍要再点一次确认。两条路都由主进程先备份再两阶段写入（I9）。
  function commit(mode: 'merge' | 'reset', target: ConfigDraft) {
    const chosen = keys.find((key) => String(key.id) === target.keyId && key.status === 1)
    void run('保存配置', async () => {
      let markerWarning = ''
      let keyWritten = true
      if (target.source === 'official') {
        await api.official(tool, mode)
        markerWarning = applyManualSourceMarker(sourceStorage, native.baseUrl, provider, false)
      }
      else if (target.source === 'manual') {
        await api.saveManual({ provider, apiKey: target.secret, model: target.model, mode })
        markerWarning = applyManualSourceMarker(sourceStorage, native.baseUrl, provider, true)
      }
      else if (target.keyId === CURRENT_KEY) {
        // Empty is the main-process reuse sentinel. It never reveals or
        // replaces the local key and must not mark its source as manual.
        await api.saveManual({ provider, apiKey: '', model: target.model, mode })
        keyWritten = false
      }
      else if (chosen) {
        await api.saveAccountKey({ provider, keyId: chosen.id, model: target.model, mode })
        markerWarning = applyManualSourceMarker(sourceStorage, native.baseUrl, provider, false)
      }
      else if (target.keyId === AUTOMATIC_KEY) {
        const result = await api.configureManaged(tool, target.model || undefined, mode)
        if (result.failed.length) throw new Error(result.failed.map((item) => item.message).join('；'))
        if (!result.configured.includes(provider)) throw new Error('工具没有返回配置写入结果，请重新检测后再试。')
        markerWarning = applyManualSourceMarker(sourceStorage, native.baseUrl, provider, false)
      }
      else throw new Error('请选择要保存的密钥。')
      if (keyWritten) onKeyWritten?.(tool)
      if (!active.current) return
      // The host has committed the write. Close through the owner so feedback
      // survives this dialog's unmount; a later refresh cannot undo that save.
      onSaved(markerWarning || undefined, mode === 'reset' ? 'reset' : target.source === 'official' && currentSource !== 'official' ? 'official' : 'saved')
    })
  }
  function requestReset() {
    if (readyToSave(draft, models)) setResetAsk(true)
  }
  // 「界面语言与文件夹权限」头一次展开时替用户读一次，原来要点「检查中文界面」才知道。
  // 只读不改，也不锁窗口；读不到的那一半照旧能点。
  function loadDesktopState() {
    if (desktopLoaded.current) return
    desktopLoaded.current = true
    void api.getLocale().then((value) => {
      if (!active.current) return
      setLocale(value)
      if (value.error) setLocaleText(value.error)
      else if (!value.installed || !value.chineseResources.available) setLocaleText(describeChineseLocale(value, os))
    }, (cause) => { if (active.current) setLocaleText(errorMessage(cause)) })
    void api.getPermissions().then((value) => { if (active.current) setPermission(value) }, () => undefined)
  }
  function changeLocale(value: string) {
    if (value !== 'zh-CN' && value !== 'system') return
    void run(value === 'zh-CN' ? '启用中文界面' : '跟随系统语言', async () => {
      setLocaleText('')
      const result = await api.setLocale(value)
      if (result.error) throw new Error(result.error)
      if (!active.current) return
      setLocale(result)
      if (value === 'zh-CN' && result.warning) setWarning(result.warning)
      else setLocaleText(describeChineseLocaleResult(result, os))
    })
  }
  function copyPath(path: string) {
    const copied = navigator.clipboard?.writeText ? navigator.clipboard.writeText(path) : Promise.reject(new Error('clipboard unavailable'))
    void copied.then(() => toast.show('路径已复制', 'ok'), () => toast.show('没复制上，请手动选中这行文字复制。', 'warn'))
  }
  const officialName = officialAccountNames[provider] ?? '官方账号'
  const officialEmail = native.officialAccountEmail
  const officialPlan = native.officialAccountPlan
  // 官方来源仍然可选,但它的限制要跟选项一起出现,而不是等用户选完再弹窗。
  const officialNote = definition.sources.includes('official') ? officialAccountNotes[provider] : null
  const sourceCards: RadioCardOption[] = [
    { value: 'account', label: '当前账号', badge: <Pill tone="accent">推荐</Pill>, description: '按用量从当前账号扣费', testId: 'tool-source-account' },
    ...(definition.sources.includes('official') ? [{ value: 'official', label: officialName, description: officialEmail ? officialPlan ? `已登录 ${officialPlan}` : '已登录' : '用你自己的官方订阅', testId: 'tool-source-official' }] : []),
    { value: 'manual', label: '自己填写密钥', description: '粘贴星芒创建的密钥', testId: 'tool-manual-key' },
  ]
  const keyDescription = draft.source === 'manual'
    ? { name: '手动填写', group: '分组未确认', preview: manualKeyPreview(draft.secret) }
    : usingCurrentKey
      ? { name: metadata?.current.name || '名称未确认', group: metadata?.current.group || '分组未确认', preview: metadata?.current.preview || native.apiKeyPreview || '密钥预览未提供' }
      : usingAutomaticKey
        ? { name: metadata?.automatic.name || '正在读取', group: metadata?.automatic.group || '分组未确认', preview: '保存时准备或复用' }
        : { name: selectedKey?.name || '密钥已不可用', group: selectedKey?.group || '分组未确认', preview: selectedKey?.maskedKey || '密钥预览未提供' }
  const automaticLabel = metadata
    ? '自动准备（推荐）'
    : metadataError ? '自动准备 · 账号信息暂时没读到' : '自动准备 · 正在读取账号信息'
  const keyOptions: PickerOption[] = [
    // 别的站的 Key 不给「保持当前」：选了也存不进去（主进程报「属于其他账号」）。
    ...((native.hasApiKey && native.matchesRelay) || usingCurrentKey ? [{ value: CURRENT_KEY, label: currentKeyLabel(metadata, native.apiKeyPreview), disabled: !native.hasApiKey || !native.matchesRelay }] : []),
    { value: AUTOMATIC_KEY, label: automaticLabel, description: '保存时自动准备好密钥，不用自己创建', disabled: !metadata || metadataLoading || Boolean(metadataError) },
    ...listedAccountKeys(keys, draft.keyId).map((key) => ({ value: String(key.id), label: key.name || key.maskedKey || '密钥预览未提供', description: accountKeyDescription(key) })),
    ...(!usingCurrentKey && !usingAutomaticKey && !selectedKey ? [{ value: draft.keyId, label: '所选密钥已不可用，请重新选择', disabled: true }] : []),
  ]
  const detectedForDraft = modelsDetected && (draft.source !== 'manual' || draft.validatedSecret === draft.secret)
  const detecting = busy === '检测模型' || autoDetectId !== 0
  const modelCount = new Set(models.filter(Boolean)).size
  const settledSource = currentSource === 'account' || currentSource === 'official' || currentSource === 'manual'
  // 没改动、来源也清楚的，底栏就是「完成」：点了只是关上，不再写一遍。工具里还没配模型、
  // 下拉框先替他填了默认的那个，也算要保存的改动，否则点「完成」默认模型就没写进去。
  const done = !draft.dirty && settledSource && !broken && !codexNeedsRepair(native, provider)
    && (draft.source === 'official' || draft.model === native.model)
  // 自动准备的密钥要先保存才查得到模型；已有密钥的检测没读成，可以照旧直接保存。
  const needsDetect = draft.source !== 'official' && draft.source !== 'unknown' && !detectedForDraft
    && !(detectTried && draft.source === 'account' && !usingAutomaticKey)
  const saving = busy === '保存配置' || busy === '保存并检测'
  const primaryLabel = saving ? '正在保存' : done ? '完成' : needsDetect ? '保存并检测' : '保存配置'
  function primary() {
    if (done) { onClose(); return }
    if (draft.source === 'account' && usingAutomaticKey && needsDetect) void saveAndDetectModels()
    else if (needsDetect) void detectThenSave()
    else if (readyToSave(draft, models)) commit('merge', draft)
  }
  // 这个窗口里的动作改的都是工具的配置文件：没权限时说「写不进配置文件」，不说安装目录（已知29）。
  const errorText = typeof error === 'string' ? error : <FailureReason error={error.message} detail={error.detail} target="config" />
  const saveSummary = <div data-testid="tool-save-summary">{draft.source === 'official' ? <p>来源：{officialName}</p> : <><p>密钥：{keyDescription.name}</p><p>分组：{keyDescription.group}</p><p>预览：{keyDescription.preview}</p><p>模型：{draft.model || '使用该分组默认模型'}</p></>}</div>
  const permissionText = !permission ? '' : permission.error ? permission.error
    : permission.trustLevel === 'trusted' ? 'Codex 已信任这个文件夹，可以直接改里面的文件'
      : permission.trustLevel === 'untrusted' ? 'Codex 没有信任这个文件夹' : 'Codex 还没对这个文件夹做过选择'
  const modelField = <div className="xm-field v2-config-model">
    <div className="v2-config-model-row"><Select label="默认模型" testId="tool-default-model" value={draft.model} options={[...(!draft.model ? [{ value: '', label: '请先检测模型', disabled: true }] : []), ...modelChoices.options]} onChange={(event) => change({ model: event.target.value })} />
      {!(draft.source === 'account' && usingAutomaticKey) && <Button icon={RefreshCw} testId="tool-detect-models" loading={detecting} onClick={() => void detectModels()} disabled={draft.source === 'manual' && !draft.secret}>{detecting ? '检测中' : '检测模型'}</Button>}</div>
    {detectedForDraft && draft.model && models.includes(draft.model) && <p className="v2-ok-line" data-testid="tool-model-ok"><Check size={13} aria-hidden="true" />这把密钥能用 {modelCount} 个模型，{draft.model} 可以用</p>}
    {notice && <p role="status" data-testid="tool-save-detect-notice">{notice}</p>}
  </div>
  return <Dialog open title={`${definition.name} 配置`} subtitle={provider === 'codex' ? 'Codex CLI 和 Codex 桌面端共用这一份配置，在哪边改都一样' : undefined} width={640}
    onClose={onClose} busy={Boolean(busy)} dirty={draft.dirty} testId="config-dialog"
    footer={<><span className="v2-dialog-footer-start v2-config-foot-note">只改账号、密钥和模型，改之前会自动备份。</span><DialogExitButton disabled={Boolean(busy)}>取消</DialogExitButton>
      <Button variant="primary" icon={done ? undefined : Save} loading={saving} disabled={Boolean(busy) || (!done && draft.source === 'unknown')} onClick={primary} testId="tool-save-config">{primaryLabel}</Button></>}>
    <fieldset className="v2-config-controls" disabled={Boolean(busy)} data-unsaved={draft.dirty ? 'true' : undefined}>
    {draft.source === 'unknown' && <><p className="v2-callout is-warn" data-testid="tool-foreign-key-note">{foreignKeyKind(native, 'unknown') === 'otherAccount' ? '这把 Key 可能不是当前账号的，用量可能算到别的账号上。' : '这个工具现在用的不是当前账号的 Key，在这里打不开。'}点「{switchLabel}」换成你自己的，改之前会先备份现在的设置。</p><div className="v2-inline-actions">{onSwitchAccount
      ? <Button variant="primary" icon={KeyRound} loading={busy === '改用当前账号'} onClick={() => void switchAccount()} testId="tool-switch-account">{signedIn ? switchLabel : '登录后改用我的账号'}</Button>
      : <Button onClick={() => change({ source: 'account' })}>{switchLabel}</Button>}</div></>}
      {/* 来源没确认时三张卡都不选中：一键改用当前账号最省事，没登录的人还能挑「自己填写密钥」。 */}
      <div className="xm-field"><span className="v2-field-label">用哪个账号使用 AI</span><RadioCards label="用哪个账号使用 AI" testId="tool-source" value={draft.source} options={sourceCards} onChange={(value) => {
        if (value === 'account' || value === 'manual' || value === 'official') change({ source: value })
      }} />{officialNote && <p data-testid="tool-source-note">{officialNote}</p>}</div>
      {draft.source === 'unknown' ? null : draft.source === 'official' ? <><div className="v2-official-summary"><BrandIcon tool={tool} /><div><strong>{officialEmail || `使用 ${officialName}`}</strong><p>{officialEmail ? [officialPlan, '不扣当前账号余额'].filter(Boolean).join('，') : `还没登录。保存后打开 ${definition.name}，按提示登录官方账号`}</p></div><Pill tone={officialEmail ? 'ok' : 'warn'}>{officialEmail ? '已登录' : '待登录'}</Pill></div>
        {provider === 'codex' && officialEmail && onOfficialQuota && <div><DialogExitLink after={onOfficialQuota} testId="tool-official-quota">查看 ChatGPT 账号额度</DialogExitLink></div>}</> : <>
        {draft.source === 'account' ? <div className="v2-config-key">
          <OptionPicker label="访问密钥" testId="tool-key-select" value={draft.keyId} options={keyOptions} disabled={!signedIn} onOpen={() => refreshKeyOptions()} onChange={(value) => change({ keyId: value })}
            aside={<span className="v2-option-picker-aside"><Button variant="ghost" size="sm" icon={RefreshCw} aria-label="刷新密钥" title="刷新密钥" testId="tool-key-refresh" loading={keysLoading || metadataLoading} onClick={() => refreshKeyOptions(true)} disabled={!signedIn} /><DialogExitLink after={onKeys}>管理密钥</DialogExitLink></span>} />
          {usingCurrentKey && <p className="v2-field-note" data-testid="tool-key-summary">继续用现在这把密钥：{keyDescription.name} · {keyDescription.preview}</p>}
          {metadataError && <p role="alert">{metadataError}</p>}
          {keyError && <p role="alert">{keyError}</p>}</div>
          : <div className="v2-config-key"><Input label="星芒密钥" password mono autoComplete="off" testId="tool-manual-secret" value={draft.secret} error={secretError || undefined} onChange={(event) => change({ secret: event.target.value, validatedSecret: '' })}
            placeholder={native.apiKeyPreview ?? (strictKeyFormat ? '粘贴你在星芒创建的密钥，以 sk- 开头' : '粘贴你在星芒创建的密钥')} />
            {native.hasApiKey && <Button size="sm" variant="ghost" icon={Eye} onClick={() => void run('读取密钥', async () => { const secret = await api.reveal(tool); if (active.current) change({ secret, validatedSecret: '' }) })}>读取当前密钥</Button>}</div>}
        {modelField}
      </>}
    <Input label="打开工具时进入的文件夹" readOnly mono value={config.workspace} error={config.workspace ? undefined : '请选择打开工具时进入的文件夹'}
      addon={<Button size="sm" onClick={() => void run('选择文件夹', async () => { if (await api.chooseWorkspace()) await onRefresh() })}>选择文件夹</Button>} />
    {tool === 'codexDesktop' && <details className="v2-config-disclosure" data-testid="tool-config-language" onToggle={(event) => { if (event.currentTarget.open) loadDesktopState() }}>
      <summary><span>界面语言与文件夹权限</span>{locale?.installed && <small>{locale.configuredLocale === 'zh-CN' ? '中文界面' : '跟随系统语言'}</small>}</summary>
      <div className="v2-config-disclosure-body">
        <div className="xm-field"><span className="v2-field-label">Codex 界面语言</span><Segment label="Codex 界面语言" testId="tool-codex-language" activation="manual" value={locale?.installed ? locale.configuredLocale === 'zh-CN' ? 'zh-CN' : 'system' : ''}
          options={[{ value: 'zh-CN', label: '启用中文界面' }, { value: 'system', label: '跟随系统语言' }]} onChange={changeLocale} />
          {os === 'mac' ? <p className="v2-field-note">{macLocaleNote}</p> : <><p className="v2-field-note">中文界面只在从星芒打开 Codex 时生效；从开始菜单或任务栏直接打开还是英文。运行中的 Codex 会重新打开，请先保存手头的工作。</p>
            <p className="v2-field-note">要让 Codex 界面显示中文，星芒每次打开 Codex 时会顺带开一个只有这台电脑自己能连的通道，关掉 Codex 就关上。不想要这个通道，选「跟随系统语言」即可。</p></>}</div>
        {localeText && <p role="status" data-testid="tool-locale-status">{localeText}</p>}
        <div className="v2-config-perm">{permission?.trustLevel === 'trusted' && <ShieldCheck size={15} aria-hidden="true" />}{permissionText && <span>{permissionText}</span>}
          <button type="button" className="v2-link-button" onClick={() => void run('查看文件夹权限', async () => { const result = await api.getPermissions(); if (active.current) setPermission(result) })}>查看文件夹权限</button>
          {permission && permission.trustLevel !== 'trusted' && <Button size="sm" onClick={() => void run('信任当前文件夹', async () => { const result = await api.trustWorkspace(); if (active.current) { setPermission(result.status); setLocaleText(describeWorkspaceTrustResult(result.changed, os)) } })}>信任当前文件夹</Button>}</div>
      </div></details>}
    <details className="v2-config-disclosure" data-testid="tool-config-advanced"><summary><span>高级</span><small>配置文件位置、重置</small></summary>
      <div className="v2-config-disclosure-body">
        {native.files.map((file) => <div className="v2-path-row" key={file.path}><code>{file.path}</code>{!file.exists && <Pill>尚未创建</Pill>}<Button variant="ghost" size="sm" icon={Copy} aria-label="复制路径" title="复制路径" onClick={() => copyPath(file.path)} /></div>)}
        <div className="v2-inline-actions"><Button size="sm" icon={FolderOpen} onClick={() => void run('打开配置文件夹', async () => { await api.openConfigDirectory(tool) })}>打开配置文件夹</Button>
          {onBackups && <DialogExitButton size="sm" icon={Archive} after={onBackups}>查看配置备份</DialogExitButton>}</div>
        {draft.source !== 'unknown' && saveSummary}
        {provider === 'codex' && <p className="v2-save-profile-note">星芒与 ChatGPT 各自保留一份配置；切换来源时，优先恢复该来源上次保存的自定义设置。</p>}
        {draft.source !== 'unknown' && <div className="v2-reset-box"><div><strong>重置为初始状态</strong><small>会先备份，再按上面选的账号重新生成配置，历史会话会保留。</small></div>
          {resetAsk ? <><span className="v2-reset-warn" role="status">这个工具里自己改过的设置也会重置</span><Button size="sm" onClick={() => setResetAsk(false)}>取消</Button><Button size="sm" variant="danger" testId="tool-save-reset-confirm" onClick={() => commit('reset', draft)}>确认重置</Button></>
            : <Button size="sm" variant="ghost" testId="tool-save-reset" onClick={requestReset}>重置</Button>}</div>}
      </div></details>
    </fieldset>
    {error && <p className="v2-callout is-bad" role="alert">{errorText}</p>}{warning && <p className="v2-callout is-warn" role="status">{warning}</p>}
  </Dialog>
}
