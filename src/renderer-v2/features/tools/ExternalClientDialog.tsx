import { useEffect, useRef, useState } from 'react'
import { Check, RefreshCw, Save } from 'lucide-react'
import type { AccountKey, AppConfigSummary, ExternalClientConfigResult, ExternalClientCredential, ExternalToolId, ProviderId, XingmangApi } from '../../../../electron/ipc-contract'
import { BrandIcon, Button, Dialog, Input, Notice, Select, useToast } from '../../ui'
import { clientConnections, clientKeySources } from '../../registry/clients'
import { connectionCheckView } from './connection-check'
import { accountKeyListFailureText, externalClientSavedTone } from './external-client-notice'
import { accountKeyDescription, manualKeyIssue, readAllAccountKeys } from './key-selection'
import { DialogExitButton } from './dialog-parts'
import { OptionPicker, type PickerOption } from './OptionPicker'
import { beginBusinessOperation, errorMessage } from '../../business-common'

// 选模型之前要知道的那一句，放在最上面（v4 原型）。
const clientHints: Record<ExternalToolId, string> = {
  claudeDesktop: '保存后要完全退出再重新打开 Claude Desktop。',
  workbuddy: '请选择能调用工具的模型；保存后在 WorkBuddy 的模型列表里选它。',
  opencode: '命令行版和桌面版共用这份配置。',
}

// 连好以后页顶说一句下一步。WorkBuddy 列表里显示的就是型号本身（主进程写进 models.json 的
// name 缺省是型号 ID），所以直接点名让他选哪一个。
function connectedText(tool: ExternalToolId, model: string): string {
  if (tool === 'claudeDesktop') return '已连好 Claude Desktop，完全退出后重新打开就能用'
  if (tool === 'workbuddy') return `已连好 WorkBuddy，在它的模型列表里选「${model}」`
  return '已连好 OpenCode，命令行版和桌面版都能用'
}

export function ExternalClientDialog({ api, tool, signedIn, ready = false, version = null, strictKeyFormat = false, onClose, onSaved }: {
  api: XingmangApi
  tool: ExternalToolId
  signedIn: boolean
  /** 首页这一行已经连好：标题写「{名称} 配置」，没连好写「连接 {名称}」。缺省 = 没连好。 */
  ready?: boolean
  /** 首页识别到的版本号，写在名称旁边；没识别到就不写。 */
  version?: string | null
  /** 同配置弹窗：只有星芒的密钥确定是 sk- 开头。缺省 = 只拦空的。 */
  strictKeyFormat?: boolean
  onClose(): void
  onSaved(): void
}) {
  const definition = clientConnections.find((entry) => entry.id === tool)!
  const [config, setConfig] = useState<AppConfigSummary | null>(null)
  const [keys, setKeys] = useState<AccountKey[]>([])
  const [source, setSource] = useState('manual')
  const [secret, setSecret] = useState('')
  const [secretError, setSecretError] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [protocol, setProtocol] = useState<'responses' | 'chat-completions'>('responses')
  const [busy, setBusy] = useState('load')
  const [error, setError] = useState('')
  const [keyError, setKeyError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [result, setResult] = useState<ExternalClientConfigResult | null>(null)
  const alive = useRef(true)
  const lock = useRef(false)
  const toast = useToast()
  useEffect(() => {
    let current = true
    alive.current = true
    void Promise.allSettled([
      api.getConfig(),
      signedIn ? readAllAccountKeys((query) => api.getAccountKeys(query)) : Promise.resolve({ keys: [] as AccountKey[] }),
    ]).then(([configResult, keyResult]) => {
      if (!current || !alive.current) return
      const availableKeys = keyResult.status === 'fulfilled' ? keyResult.value.keys.filter((key) => key.status === 1) : []
      setKeys(availableKeys)
      if (keyResult.status === 'rejected') setKeyError(errorMessage(keyResult.reason))
      if (configResult.status === 'fulfilled') {
        const value = configResult.value
        setConfig(value)
        const choices = [definition.preferredProvider, ...clientKeySources.map((item) => item.id)]
        const current = choices.find((id) => value.providers[id].hasApiKey && value.providers[id].matchesRelay)
        setSource(current ? `configured:${current}` : availableKeys.length ? `account:${availableKeys[0].id}` : 'manual')
        setModel(current ? value.providers[current].model : '')
      } else {
        setSource(availableKeys.length ? `account:${availableKeys[0].id}` : 'manual')
        setError(errorMessage(configResult.reason))
      }
      setBusy('')
    })
    return () => { current = false; alive.current = false }
  }, [api, signedIn, definition.preferredProvider])

  function changeSource(next: string) {
    setSource(next); setModels([]); setModel(''); setResult(null); setError(''); setSecretError(''); setDirty(true)
  }
  function credential(): ExternalClientCredential {
    if (source.startsWith('configured:')) return { kind: 'configured', provider: source.slice(11) as ProviderId }
    if (source.startsWith('account:')) return { kind: 'account', keyId: Number(source.slice(8)) }
    return { kind: 'manual', apiKey: secret.trim() }
  }
  /** 列出这把密钥能用的模型。kept = 拿得准替用户选的那个，拿不准是 null，让他自己挑。 */
  async function detect(): Promise<{ values: string[]; kept: string | null } | null> {
    if (source === 'manual') {
      const issue = manualKeyIssue(secret, strictKeyFormat)
      if (issue) { setSecretError(issue); return null }
    }
    if (lock.current) return null
    lock.current = true; setBusy('models'); setError(''); setResult(null)
    try {
      const selected = credential()
      const values = selected.kind === 'configured' ? await api.listConfiguredModels(selected.provider)
        : selected.kind === 'account' ? await api.listAccountKeyModels(selected.keyId) : await api.listModels(selected.apiKey)
      if (!alive.current) return null
      setModels(values)
      const preferred = tool === 'claudeDesktop' ? values.find((id) => /claude/i.test(id)) : undefined
      const kept = values.includes(model) ? model : preferred
      setModel(kept ?? values[0] ?? '')
      if (!values.length) setError('这把密钥没有可用模型，请换一把密钥后重新检测。')
      return { values, kept: kept ?? null }
    } catch (cause) { if (alive.current) { setModels([]); setError(errorMessage(cause)) } return null }
    finally { lock.current = false; if (alive.current) setBusy('') }
  }
  async function save(chosen: string, list: readonly string[]) {
    if (lock.current || !list.includes(chosen)) return
    lock.current = true; setBusy('save'); setError(''); setResult(null)
    const finish = beginBusinessOperation(`配置 ${definition.name}`)
    try {
      const saved = await api.configureExternalTool(tool, { credential: credential(), model: chosen, ...(tool === 'opencode' ? { protocol } : {}) })
      if (!alive.current) return
      setResult(saved); setDirty(false); onSaved()
      if (saved.connection && connectionCheckView(saved.connection).tone === 'ok') toast.show(connectedText(tool, chosen), 'ok')
    } catch (cause) { if (alive.current) setError(errorMessage(cause)) }
    finally { finish(); lock.current = false; if (alive.current) setBusy('') }
  }
  // 「保存并检测」：先检测，选中的型号拿得准（原来就配着的、Claude Desktop 认得出的 Claude）
  // 就接着保存；拿不准就停下让用户自己挑，按钮跟着变成「保存配置」。
  async function detectThenSave() {
    const listed = await detect()
    if (listed?.kept && alive.current) await save(listed.kept, listed.values)
  }
  const detected = models.length > 0
  const currentSources = clientKeySources.filter((item) => config?.providers[item.id].hasApiKey && config.providers[item.id].matchesRelay)
  const sourceOptions: PickerOption[] = [
    ...currentSources.map((entry) => ({ value: `configured:${entry.id}`, label: `使用 ${entry.name} 当前的星芒密钥` })),
    ...keys.map((key) => ({ value: `account:${key.id}`, label: key.name || key.maskedKey || '密钥预览未提供', description: accountKeyDescription(key) })),
    { value: 'manual', label: '自己填写星芒密钥', description: '粘贴一把已有的密钥' },
  ]
  // 保存完主进程会把刚写下去的配置回读一遍再核对一次当前账号，结论跟在同一张
  // Notice 里：0.2.8 之前这里只能说一句「未验证实际模型调用」。
  const connectionView = result?.connection ? connectionCheckView(result.connection) : null
  return <Dialog open title={ready ? `${definition.name} 配置` : `连接 ${definition.name}`} width={640}
    onClose={onClose} busy={Boolean(busy)} dirty={dirty} testId="external-client-dialog"
    footer={<><DialogExitButton disabled={Boolean(busy)}>{result ? '完成' : '取消'}</DialogExitButton><Button variant="primary" icon={Save} loading={busy === 'save'} disabled={Boolean(busy) || (detected ? !model || !models.includes(model) : source === 'manual' && !secret.trim())}
      onClick={() => void (detected ? save(model, models) : detectThenSave())} testId="external-client-save">{detected ? '保存配置' : '保存并检测'}</Button></>}>
    <div className="v2-client-head"><BrandIcon tool={tool} /><strong>{definition.name}</strong>{version && <span>v{version.replace(/^v/, '')}</span>}</div>
    <p className="v2-field-note">{clientHints[tool]}</p>
    <fieldset className="v2-config-controls" disabled={Boolean(busy)} data-unsaved={dirty ? 'true' : undefined}>
      <div className="v2-config-key"><OptionPicker label="访问密钥" value={source} options={sourceOptions} onChange={changeSource} testId="external-client-source" />
        {keyError && <p role="status">{accountKeyListFailureText(keyError)}</p>}
        {source === 'manual' && <Input label="星芒密钥" password mono autoComplete="off" value={secret} error={secretError || undefined} placeholder={strictKeyFormat ? '粘贴你在星芒创建的密钥，以 sk- 开头' : undefined}
          onChange={(event) => { setSecret(event.target.value); setSecretError(''); setModels([]); setModel(''); setResult(null); setDirty(true) }} testId="external-client-secret" />}
      </div>
      <div className="xm-field v2-config-model">
        <div className="v2-config-model-row"><Select label="默认模型" value={model} options={models.length ? models.map((id) => ({ value: id, label: id })) : [{ value: model, label: model || '先检测这把密钥的可用模型' }]} onChange={(event) => { setModel(event.target.value); setDirty(true); setResult(null) }} disabled={!models.length} testId="external-client-model" />
          <Button icon={RefreshCw} loading={busy === 'models'} disabled={source === 'manual' && !secret.trim()} onClick={() => void detect()} testId="external-client-detect">{busy === 'models' ? '检测中' : '检测模型'}</Button></div>
        {detected && models.includes(model) && <p className="v2-ok-line"><Check size={13} aria-hidden="true" />这把密钥能用 {new Set(models).size} 个模型，{model} 可以用</p>}
      </div>
      {tool === 'opencode' && <div className="xm-field"><Select label="模型类型" value={protocol} options={[{ value: 'responses', label: 'Codex / GPT 系列模型' }, { value: 'chat-completions', label: '其他模型' }]} onChange={(event) => { setProtocol(event.target.value as typeof protocol); setDirty(true); setResult(null) }} testId="external-client-protocol" /><p className="v2-field-note">按上面选的模型挑一项；拿不准就选和模型名对应的那一项。</p></div>}
    </fieldset>
    {error && <p className="v2-callout is-bad" role="alert">{error}</p>}
    {result && <Notice tone={externalClientSavedTone(connectionView)} title="配置已保存" body={<><p>{result.message}</p>
      {connectionView
        ? <><p data-testid="external-client-connection">连接自检：{connectionView.statusLabel} · {connectionView.title}</p><p>{connectionView.body}</p></>
        : <p data-testid="external-client-connection">连接自检：这次没测成。配置已经写好了，可以到「检查」页点一次「测试连接」。</p>}
      <p className="v2-client-config-path">{result.path}</p>{result.backups.length > 0 && <p>已保留 {result.backups.length} 份备份。</p>}</>} testId="external-client-result" />}
  </Dialog>
}
