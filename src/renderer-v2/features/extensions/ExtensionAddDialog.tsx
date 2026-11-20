// 「自定义连接」「从文件夹导入」「添加插件」「添加插件市场」那张表单，和 Grok 装插件前那句「信任并安装」（0.2.25 从
// ExtensionsPage.tsx 原样搬出来）。外接工具、技能、插件三页和合成以后的「插件」页共用这一份，字和校验一处改。
import { useMemo, useState, type ReactNode } from 'react'
import { Download, FolderOpen, Plus } from 'lucide-react'
import { Button, Dialog, Input, Notice, Segment, Select, Textarea } from '../../ui'
import { ResultNotice, useOperation } from '../../business-common'
import type { CuratedExtension } from '../../registry/curated-extensions'
import type { V2Bridge } from '../../types'
import type { ActiveProviderId } from '../../../../electron/catalog'
import {
  ExtensionToolPicker,
  activeTools,
  customMcpProblem,
  extensionFailureTarget,
  extensionFormOffersProject,
  extensionInstallNeedsTrust,
  extensionToolChoices,
  extensionToolName,
  extensionToolNames,
  fillCuratedPlaceholders,
  mcpNamesInScope,
  mcpNameTakenIn,
  mcpRuntimeNotice,
  parseCommandArguments,
  parseEnvironmentVariables,
  parseHttpHeaders,
  submitMcpInstall,
  unresolvedInstallPlaceholders,
  type McpRuntimeNotice,
} from './extensions-common'
import {
  buildLaunchCommand,
  launchCommandSplitsArguments,
  mcpHeaderLines,
  mcpPasteChoiceLabel,
  mcpPasteNotice,
  parseMcpPaste,
  type PastedMcpServer,
} from './mcp-paste'

type Provider = ActiveProviderId
type ExtensionSnapshot = Awaited<ReturnType<V2Bridge['listProviderExtensions']>>
type ExtensionItem = ExtensionSnapshot['items'][number]
type ExtensionKind = ExtensionItem['kind']
type RuntimeInstallManagement = Awaited<ReturnType<V2Bridge['getPlatformCapabilities']>>['pythonRuntimeInstall']
type Operation = Pick<ReturnType<typeof useOperation>, 'busy' | 'error' | 'detail' | 'failed' | 'execute' | 'clear'>

export interface ExtensionAddRequest {
  form: 'add' | 'market'
  /** 精选里要先填路径的那条：表单照它填好，把该换的那一项留在附加参数里。 */
  curated?: CuratedExtension | null
}

/**
 * 表单每次打开都是新的一张（调用方换 key 重挂），所以状态全在这里，不用打开时一项项清。
 * kind / provider：添加的是哪一类、给哪个工具（「自定义连接」能多勾几个，这个是默认勾上、查重名的那个）。
 */
export function ExtensionAddDialog({
  api,
  kind,
  provider,
  request,
  items,
  runtimes,
  pythonInstall,
  usable,
  codexViaDesktop,
  operation,
  runtimeNoticeActions,
  onClose,
  onChanged,
}: {
  api: V2Bridge
  kind: ExtensionKind
  provider: Provider
  request: ExtensionAddRequest
  /** 当前这个工具已经有的条目：查「已经有叫这个名字的连接了」。 */
  items: readonly ExtensionItem[]
  runtimes: ExtensionSnapshot['runtimes']
  pythonInstall: RuntimeInstallManagement
  usable: readonly string[] | undefined
  codexViaDesktop: boolean
  operation: Operation
  /** 缺 Python、缺 uv 那条提示上的按钮（自动安装 Python、找客服），由页面给。 */
  runtimeNoticeActions: (notice: McpRuntimeNotice) => ReactNode
  onClose: () => void
  /** 加上了（全部或一部分）以后重读列表。 */
  onChanged: () => Promise<void>
}) {
  const page = kind === 'skill' ? 'skills' : kind === 'plugin' ? 'plugins' : 'mcp'
  const form = request.form
  const curatedForm = request.curated && request.curated.install.type !== 'plugin' ? request.curated : null
  const curatedInstall = curatedForm?.install.type === 'plugin' ? null : curatedForm?.install
  const toolName = extensionToolName(provider, codexViaDesktop)
  const [formName, setFormName] = useState(curatedForm?.id ?? '')
  const [source, setSource] = useState(curatedInstall ? (curatedInstall.type === 'http' ? curatedInstall.url : curatedInstall.command) : '')
  const [transport, setTransport] = useState(curatedInstall?.type === 'http' ? 'http' : 'stdio')
  const [args, setArgs] = useState(curatedInstall?.type === 'stdio' ? JSON.stringify(curatedInstall.args) : '[]')
  const [environment, setEnvironment] = useState(curatedInstall?.type === 'stdio' ? JSON.stringify(curatedInstall.env) : '{}')
  const [bearerEnv, setBearerEnv] = useState('')
  const [oauthClient, setOauthClient] = useState('')
  const [oauthResource, setOauthResource] = useState('')
  const [headers, setHeaders] = useState('')
  // 粘贴框里的原文、多条时选的第几条、替他填上的名字（他自己改过名字就不再动）。
  const [pasteText, setPasteText] = useState('')
  const [pasteChoice, setPasteChoice] = useState(0)
  const [pastedName, setPastedName] = useState('')
  // 粘贴填好以后把「更多设置」展开，让他看得见要启动什么、带了哪些设置和请求头；换 key 是为了每次粘贴都重新展开。
  const [moreOpen, setMoreOpen] = useState(false)
  const [moreKey, setMoreKey] = useState(0)
  const [formScope, setFormScope] = useState<'user' | 'project'>('user')
  // 「自定义连接」给哪几个工具加；打开时只勾当前这个。
  const [formTools, setFormTools] = useState<Provider[]>([provider])
  const [curatedValues, setCuratedValues] = useState<Record<string, string>>({})
  // 「添加插件」表单点了「添加」、等用户在确认框里点「信任并安装」（只有 Grok 有这一步）。
  const [trusting, setTrusting] = useState(false)
  const addFormRuntimeNotice = kind === 'mcp' && transport === 'stdio'
    ? mcpRuntimeNotice(source, runtimes, pythonInstall)
    : null
  // 粘贴进来的那一条照原样填进下面几项。名字只在空着、或者还是上次替他填的那个时才换，他自己起的不动。
  const fillPasted = (server: PastedMcpServer | undefined) => {
    const config = server?.config
    if (!server || !config) return
    setTransport(config.type)
    if (config.type === 'stdio') {
      setSource(config.command)
      setArgs(JSON.stringify(config.args))
      setEnvironment(JSON.stringify(config.env))
      setHeaders('')
    } else {
      setSource(config.url)
      setArgs('[]')
      setEnvironment('{}')
      setHeaders(mcpHeaderLines(config.headers))
      if (config.bearerTokenEnvVar) setBearerEnv(config.bearerTokenEnvVar)
    }
    if (!formName.trim() || formName === pastedName) {
      setFormName(server.name)
      setPastedName(server.name)
    }
    setMoreOpen(
      config.type === 'stdio'
        ? config.args.length > 0 || Object.keys(config.env).length > 0
        : Object.keys(config.headers).length > 0,
    )
    setMoreKey((key) => key + 1)
  }
  const pasted = useMemo(() => parseMcpPaste(pasteText), [pasteText])
  const pasteNotice = mcpPasteNotice(pasted, pasteChoice)
  const pasteConfig = (value: string) => {
    setPasteText(value)
    setPasteChoice(0)
    const result = parseMcpPaste(value)
    if (result.status === 'ok') fillPasted(result.servers[0])
  }
  const choosePasted = (index: number) => {
    setPasteChoice(index)
    if (pasted.status === 'ok') fillPasted(pasted.servers[index])
  }
  const formChoices = extensionToolChoices(
    activeTools.map((tool) => tool.id),
    usable,
    [],
    codexViaDesktop,
  )
  // 勾选按导航次序装，成功提示里的工具名也按这个次序。
  const formTargets = formChoices
    .filter((choice) => choice.note === null && formTools.includes(choice.id))
    .map((choice) => choice.id)
  // Codex CLI 的连接只有全局一层，submitMcpInstall 给它的范围会被丢掉。勾上它时整张表就只能装到「我的（全局）」，
  // 不然框里写着装进当前项目，Codex CLI 那边其实是全局的。
  const mcpGlobalOnly = kind === 'mcp' && formTargets.includes('codex')
  // OAuth 那两项是 `codex mcp add` 当场去登录时用的，没装 Codex CLI 时写不进配置，不给填。
  const oauthUnavailable = codexViaDesktop && formTargets.includes('codex')
  const formOffersProject = kind === 'mcp' ? !mcpGlobalOnly : extensionFormOffersProject(provider, kind)
  const shownScope = formOffersProject ? formScope : 'user'
  const addMcp = async () => {
    const name = formName.trim()
    const problem = customMcpProblem({
      name,
      transport,
      source,
      existing: formTargets.includes(provider)
        ? mcpNamesInScope(items, shownScope)
        : [],
    })
    if (problem) throw new Error(problem)
    const headerValues = transport === 'http' ? parseHttpHeaders(headers) : {}
    const mcp =
      transport === 'http'
        ? {
            type: 'http' as const,
            url: source.trim(),
            ...(Object.keys(headerValues).length ? { headers: headerValues } : {}),
          }
        : {
            type: 'stdio' as const,
            // 「启动命令」里填了整行（npx -y 包名）的，交出去前拆成程序和参数；表单里他填的字不动。
            ...buildLaunchCommand(source, parseCommandArguments(args)),
            env: parseEnvironmentVariables(environment),
          }
    if (mcp.type === 'stdio') {
      const filled = fillCuratedPlaceholders(mcp.args, mcp.env, curatedValues)
      mcp.args = filled.args
      mcp.env = filled.env
      const pending = unresolvedInstallPlaceholders(mcp.args, mcp.env)
      if (pending.length)
        throw new Error(
          `${pending.join('、')} 还没换成真实内容，请先填好再添加。`,
        )
    }
    const advanced = {
      ...(bearerEnv ? { bearerTokenEnvVar: bearerEnv.trim() } : {}),
      ...(oauthClient && !oauthUnavailable ? { oauthClientId: oauthClient.trim() } : {}),
      ...(oauthResource && !oauthUnavailable ? { oauthResource: oauthResource.trim() } : {}),
    }
    // 当前这个工具的同名在上面 customMcpProblem 里已经拦过；勾上的别的工具要现问一遍，免得把那边原来那条换掉。
    const taken = await mcpNameTakenIn(api, formTargets.filter((target) => target !== provider), name, shownScope)
    if (taken.length) {
      const names = extensionToolNames(taken, codexViaDesktop)
      throw new Error(`${names} 里已经有叫「${name}」的连接了，为了不动原来那条，这次没有添加。换个名字，或者不勾 ${names}。`)
    }
    const done: Provider[] = []
    try {
      for (const target of formTargets) {
        await submitMcpInstall(api, target, name, mcp, shownScope, advanced)
        done.push(target)
      }
    } finally {
      // 一个工具没加上就停在那里：已经加上的从勾选里拿掉，改好再点一次只补剩下的，不会在加过的工具上撞名。
      if (done.length && done.length < formTargets.length) {
        setFormTools(formTargets.filter((target) => !done.includes(target)))
        await onChanged()
      }
    }
    return { name, tools: done }
  }
  const add = (trusted = false) => {
    // 来源空着照旧在表单里报「请填写来源」，不先弹一个没有来源的确认框。
    if (!trusted && form === 'add' && extensionInstallNeedsTrust(provider, kind) && source.trim()) {
      operation.clear()
      setTrusting(true)
      return
    }
    void operation.execute(
      'add',
      async () => {
        if (kind === 'mcp' && form !== 'market') {
          const added = await addMcp()
          onClose()
          await onChanged()
          return added
        }
        if (!source.trim()) throw new Error('请填写来源。')
        if (form === 'market')
          await api.addMarketplace({ source: source.trim() })
        else if (kind === 'skill' && provider === 'codex')
          await api.importSkill({
            sourcePath: source.trim(),
            scope: formScope === 'project' ? 'repo' : 'user',
          })
        else if (kind === 'plugin' && provider === 'codex')
          await api.addPlugin(source.trim())
        else
          await api.mutateProviderExtension({
            provider,
            kind,
            action: 'install',
            source: source.trim(),
            scope: shownScope,
            ...(trusted ? { trust: true } : {}),
          })
        setTrusting(false)
        onClose()
        await onChanged()
        return null
      },
      (added) =>
        added
          ? `已添加「${added.name}」，给 ${extensionToolNames(added.tools, codexViaDesktop)} 使用，下次打开工具时生效`
          : '已添加，列表已更新',
    )
  }
  return (
    <>
      <Dialog
        open
        title={
          form === 'market'
            ? '添加插件市场'
            : kind === 'mcp'
              ? '自定义连接'
              : kind === 'skill'
                ? `给 ${toolName} 导入技能`
                : `给 ${toolName} 添加插件`
        }
        onClose={() => {
          if (!operation.busy) onClose()
        }}
        dirty={Boolean(operation.busy)}
        footer={
          <>
            <Button
              onClick={onClose}
              disabled={Boolean(operation.busy)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => add()}
              loading={operation.busy === 'add'}
              disabled={kind === 'mcp' && form === 'add' && formTargets.length === 0}
              testId={`${page}-form-submit`}
            >
              添加
            </Button>
          </>
        }
      >
        <ResultNotice error={operation.error} detail={operation.detail} target={extensionFailureTarget(operation.failed)} />
        {curatedForm?.inputs.map((input) => (
          <Notice
            key={input.key}
            tone={curatedValues[input.key]?.trim() ? 'ok' : 'warn'}
            title={curatedValues[input.key]?.trim() ? `${input.label}：${curatedValues[input.key]}` : `还缺一样：${input.label}`}
            body={`点「选择文件夹」挑一个，软件会替你填好，不用手改。${input.hint}`}
            testId={`curated-input-${input.key}`}
            actions={
              <Button
                size="sm"
                icon={FolderOpen}
                disabled={Boolean(operation.busy)}
                onClick={() => void operation.execute('choose-directory', async () => {
                  const chosen = await api.chooseExtensionDirectory()
                  if (chosen) setCuratedValues((values) => ({ ...values, [input.key]: chosen }))
                }, () => null)}
                testId={`curated-choose-${input.key}`}
              >
                选择文件夹
              </Button>
            }
          />
        ))}
        {addFormRuntimeNotice && (
          <Notice
            tone="warn"
            title={addFormRuntimeNotice.title}
            body={addFormRuntimeNotice.body}
            testId="mcp-runtime-notice"
            actions={runtimeNoticeActions(addFormRuntimeNotice)}
          />
        )}
        {kind === 'mcp' && form === 'add' && !curatedForm && (
          <>
            <Textarea
              label="粘贴整段配置"
              value={pasteText}
              onChange={(event) => pasteConfig(event.target.value)}
              placeholder="把提供方给的一整段配置粘贴到这里，下面几项会自动填好。没有的话直接往下填。"
              rows={4}
              mono
              testId="mcp-paste"
            />
            {pasteNotice && (
              <Notice
                tone={pasteNotice.tone}
                title={pasteNotice.title}
                body={pasteNotice.body}
                testId="mcp-paste-result"
              />
            )}
            {pasted.status === 'ok' && pasted.servers.length > 1 && (
              <Select
                label={`这段里有 ${pasted.servers.length} 个连接，先加哪一个`}
                options={pasted.servers.map((server, index) => ({
                  value: String(index),
                  label: mcpPasteChoiceLabel(server, index),
                }))}
                value={String(pasteChoice)}
                onChange={(event) => choosePasted(Number(event.target.value))}
                testId="mcp-paste-choice"
              />
            )}
          </>
        )}
        {kind === 'mcp' && form === 'add' && (
          <>
            <Input
              label="名称"
              value={formName}
              onChange={(event) => setFormName(event.target.value)}
              placeholder="比如：my-database"
              hint="只能用字母、数字和 - _"
              testId="mcp-name"
            />
            <div className="xm-field">
              {/* 读屏从按钮组自己的名字读到它，这里只给眼睛看。 */}
              <label aria-hidden="true">类型</label>
              <Segment
                label="类型"
                options={[
                  { value: 'stdio', label: '本地程序' },
                  { value: 'http', label: '网络服务' },
                ]}
                value={transport}
                onChange={setTransport}
              />
            </div>
          </>
        )}
        <Input
          label={
            form === 'market'
              ? '市场来源'
              : kind === 'mcp'
                ? transport === 'http'
                  ? '服务地址'
                  : '启动命令'
                : kind === 'skill'
                  ? '技能文件夹路径'
                  : '来源'
          }
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder={
            kind === 'mcp' && form === 'add'
              ? transport === 'http'
                ? 'https://example.com/mcp'
                : '比如：从提供方说明里复制的启动命令'
              : undefined
          }
          hint={
            kind === 'mcp' && form === 'add' && transport === 'stdio' && launchCommandSplitsArguments(source)
              ? '已经帮你把后面的参数分出去了'
              : undefined
          }
          mono
          testId={`${page}-source`}
        />
        {kind === 'mcp' && form === 'add' && transport === 'stdio' && (
          <details key={`more-${moreKey}`} className="v2-ext-more" open={moreOpen || undefined}>
            <summary>更多设置</summary>
            <Textarea
              label="附加参数"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              mono
              hint="按提供方说明原样粘贴"
            />
            <Textarea
              label="附加设置"
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
              mono
              hint="按提供方说明原样粘贴"
            />
          </details>
        )}
        {kind === 'mcp' && form === 'add' && transport === 'http' && (
          <details key={`more-${moreKey}`} className="v2-ext-more" open={moreOpen || undefined}>
            <summary>更多设置</summary>
            <Textarea
              label="请求头"
              value={headers}
              onChange={(event) => setHeaders(event.target.value)}
              placeholder="Authorization: Bearer 你的密钥"
              mono
              hint="一行一个，写成「名称: 值」。按提供方说明原样粘贴"
              testId="mcp-headers"
            />
          </details>
        )}
        {kind === 'mcp' && form === 'add' && transport === 'http' && formTargets.includes('codex') && (
          <details className="v2-ext-more">
            <summary>高级认证设置</summary>
            <Input
              label="登录信息的名称"
              value={bearerEnv}
              onChange={(event) => setBearerEnv(event.target.value)}
            />
            {!oauthUnavailable && (
              <>
                <Input
                  label="OAuth Client ID"
                  value={oauthClient}
                  onChange={(event) => setOauthClient(event.target.value)}
                />
                <Input
                  label="OAuth Resource"
                  value={oauthResource}
                  onChange={(event) => setOauthResource(event.target.value)}
                />
              </>
            )}
          </details>
        )}
        {form !== 'market' && (
          // 外接工具的弹框照清单加小标题「装到哪里」；技能、插件的弹框只改了标题，下拉照旧不带字。
          <Select
            label={kind === 'mcp' ? '装到哪里' : undefined}
            aria-label={kind === 'mcp' ? undefined : '添加范围'}
            options={[
              { value: 'user', label: '我的（全局）' },
              // Codex 的连接和插件、Grok 的插件只有全局一层；几个工具一起加连接时，勾了 Codex CLI 就不给这一项。
              ...(formOffersProject ? [{ value: 'project', label: '当前项目' }] : []),
            ]}
            value={shownScope}
            onChange={(event) =>
              setFormScope(
                event.target.value === 'project' ? 'project' : 'user',
              )
            }
          />
        )}
        {kind === 'mcp' && form === 'add' && (
          <ExtensionToolPicker
            choices={formChoices}
            selected={formTools}
            disabled={Boolean(operation.busy)}
            onToggle={(id) =>
              setFormTools((current) =>
                current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
              )
            }
            testId="mcp-form-tools"
          />
        )}
      </Dialog>
      {/* 叠在「添加插件」表单上面：点「先不装」回到表单，填过的来源还在。 */}
      <Dialog
        open={trusting}
        title={`给 ${toolName} 装这个插件？`}
        testId="plugins-trust-confirm"
        busy={operation.busy === 'add'}
        onClose={() => setTrusting(false)}
        footer={
          <>
            <Button
              onClick={() => setTrusting(false)}
              disabled={operation.busy === 'add'}
            >
              先不装
            </Button>
            <Button
              variant="primary"
              icon={Download}
              loading={operation.busy === 'add'}
              onClick={() => add(true)}
              testId="plugins-trust-confirm-submit"
            >
              信任并安装
            </Button>
          </>
        }
      >
        <p>
          插件里带的技能、命令和连接，装好后每次打开 {toolName} 都会自动运行，能像你本人一样读写这台电脑上的文件。
        </p>
        <dl className="v2-business-kv">
          <dt>来源</dt>
          <dd>{source.trim()}</dd>
        </dl>
        <p>只装你认识、信得过的来源；拿不准就先别装。</p>
        <ResultNotice error={operation.error} detail={operation.detail} target={extensionFailureTarget(operation.failed)} />
      </Dialog>
    </>
  )
}
