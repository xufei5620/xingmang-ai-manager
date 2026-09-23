import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Save, Settings } from 'lucide-react'
import type { AccountKey, AppConfigSummary, ExternalClientConfigResult, ExternalClientCredential, ExternalToolId, ProviderId, XingmangApi } from '../../../../electron/ipc-contract'
import { Button, Confirm, Dialog, Input, Notice, Select } from '../../ui'
import { clientConnections, clientKeySources } from '../../registry/clients'
import { connectionCheckView } from './connection-check'
import { accountKeyLabel, readAllAccountKeys } from './key-selection'
import { beginBusinessOperation, errorMessage } from '../../business-common'

export function ExternalClientDialog({ api, tool, signedIn, onClose, onSaved }: {
  api: XingmangApi
  tool: ExternalToolId
  signedIn: boolean
  onClose(): void
  onSaved(): void
}) {
  const definition = clientConnections.find((entry) => entry.id === tool)!
  const [config, setConfig] = useState<AppConfigSummary | null>(null)
  const [keys, setKeys] = useState<AccountKey[]>([])
  const [source, setSource] = useState('manual')
  const [secret, setSecret] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [protocol, setProtocol] = useState<'responses' | 'chat-completions'>('responses')
  const [busy, setBusy] = useState('load')
  const [error, setError] = useState('')
  const [keyError, setKeyError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [result, setResult] = useState<ExternalClientConfigResult | null>(null)
  const alive = useRef(true)
  const lock = useRef(false)
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
    setSource(next); setModels([]); setModel(''); setResult(null); setError(''); setDirty(true)
  }
  function credential(): ExternalClientCredential {
    if (source.startsWith('configured:')) return { kind: 'configured', provider: source.slice(11) as ProviderId }
    if (source.startsWith('account:')) return { kind: 'account', keyId: Number(source.slice(8)) }
    return { kind: 'manual', apiKey: secret.trim() }
  }
  async function detect() {
    if (lock.current) return
    lock.current = true; setBusy('models'); setError(''); setResult(null)
    try {
      const selected = credential()
      const values = selected.kind === 'configured' ? await api.listConfiguredModels(selected.provider)
        : selected.kind === 'account' ? await api.listAccountKeyModels(selected.keyId) : await api.listModels(selected.apiKey)
      if (!alive.current) return
      setModels(values)
      const preferred = tool === 'claudeDesktop' ? values.find((id) => /claude/i.test(id)) : undefined
      setModel(values.includes(model) ? model : preferred ?? values[0] ?? '')
      if (!values.length) setError('这把密钥没有可用模型，请换一把密钥后重新检测。')
    } catch (cause) { if (alive.current) { setModels([]); setError(errorMessage(cause)) } }
    finally { lock.current = false; if (alive.current) setBusy('') }
  }
  async function save() {
    if (lock.current || !models.includes(model)) return
    lock.current = true; setBusy('save'); setError(''); setResult(null)
    const finish = beginBusinessOperation(`配置 ${definition.name}`)
    try {
      const saved = await api.configureExternalTool(tool, { credential: credential(), model, ...(tool === 'opencode' ? { protocol } : {}) })
      if (alive.current) { setResult(saved); setDirty(false); onSaved() }
    } catch (cause) { if (alive.current) setError(errorMessage(cause)) }
    finally { finish(); lock.current = false; if (alive.current) setBusy('') }
  }
  const currentSources = clientKeySources.filter((item) => config?.providers[item.id].hasApiKey && config.providers[item.id].matchesRelay)
  // 保存完主进程会把刚写下去的配置回读一遍再核对一次当前账号，结论跟在同一张
  // Notice 里：0.2.8 之前这里只能说一句「未验证实际模型调用」。
  const connectionView = result?.connection ? connectionCheckView(result.connection) : null
  return <><Dialog open title={`${definition.name} 配置`} subtitle={definition.description} icon={Settings} width={640}
    onClose={onClose} busy={Boolean(busy)} dirty={dirty} testId="external-client-dialog"
    footer={<><Button onClick={() => dirty ? setDiscard(true) : onClose()} disabled={Boolean(busy)}>{result ? '完成' : '取消'}</Button><Button variant="primary" icon={Save} loading={busy === 'save'} disabled={Boolean(busy) || !model || !models.includes(model)} onClick={() => void save()} testId="external-client-save">保存配置</Button></>}>
    <fieldset className="v2-config-controls" disabled={Boolean(busy)}>
      <div className="v2-config-field"><Select label="密钥来源" value={source} onChange={(event) => changeSource(event.target.value)} testId="external-client-source" options={[
        ...currentSources.map((entry) => ({ value: `configured:${entry.id}`, label: `使用 ${entry.name} 当前的星芒密钥` })),
        ...keys.map((key) => ({ value: `account:${key.id}`, label: accountKeyLabel(key) })),
        { value: 'manual', label: '自己填写星芒密钥' },
      ]} />
        {keyError && <p role="status">账号密钥列表读取失败：{keyError}。可以使用已有工具密钥或自行填写。</p>}
        {source === 'manual' && <Input label="星芒访问密钥" type="password" autoComplete="off" value={secret} onChange={(event) => { setSecret(event.target.value); setModels([]); setResult(null); setDirty(true) }} testId="external-client-secret" />}
      </div>
      <div className="v2-config-field"><Select label="使用模型" value={model} options={models.length ? models.map((id) => ({ value: id, label: id })) : [{ value: model, label: model || '先检测这把密钥的可用模型' }]} onChange={(event) => { setModel(event.target.value); setDirty(true); setResult(null) }} disabled={!models.length} testId="external-client-model" />
        <Button icon={RefreshCw} size="sm" loading={busy === 'models'} disabled={source === 'manual' && !secret.trim()} onClick={() => void detect()} testId="external-client-detect">检测模型</Button>
      </div>
      {tool === 'opencode' && <div className="v2-config-field"><Select label="模型类型" value={protocol} options={[{ value: 'responses', label: 'Codex / GPT 系列模型' }, { value: 'chat-completions', label: '其他模型' }]} onChange={(event) => { setProtocol(event.target.value as typeof protocol); setDirty(true); setResult(null) }} testId="external-client-protocol" /><p>按上面选的模型挑一项；拿不准就选和模型名对应的那一项。配置会同时给 OpenCode 命令行版和桌面版用。</p></div>}
      {tool === 'workbuddy' && <p className="v2-callout">配置腾讯 WorkBuddy 的自定义模型。请选择能调用工具的模型；保存后在 WorkBuddy 的模型列表选择它。</p>}
      {tool === 'claudeDesktop' && <p className="v2-callout">让 Claude Desktop 用当前账号的模型。保存后请完全退出并重新打开 Claude Desktop。</p>}
      <p>保存前会重新校验模型权限并备份已有配置。密钥只写入对应客户端的本地配置，现有配置内容不会返回界面。</p>
    </fieldset>
    {error && <p className="v2-callout is-bad" role="alert">{error}</p>}
    {result && <Notice tone="ok" title="配置已保存" body={<><p>{result.message}</p>
      {connectionView
        ? <><p data-testid="external-client-connection">连接自检：{connectionView.statusLabel} · {connectionView.title}</p><p>{connectionView.body}</p></>
        : <p data-testid="external-client-connection">连接自检：这次没测成。配置已经写好了，可以到「检查」页点一次「测试连接」。</p>}
      <p className="v2-client-config-path">{result.path}</p>{result.backups.length > 0 && <p>已保留 {result.backups.length} 份备份。</p>}</>} testId="external-client-result" />}
  </Dialog>{discard && <Confirm title="放弃未保存的修改？" body="本次选择的密钥与模型还没有保存。" okLabel="放弃修改" cancelLabel="继续编辑" danger onClose={() => setDiscard(false)} onOk={onClose} />}</>
}
