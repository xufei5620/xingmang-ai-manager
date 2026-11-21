// 「插件」页的几个对话框：点「+」弹的安装框（精选、官方目录、自己加的连接复制、技能复制都走它）、技能「从文件夹导入」、
// 「添加插件」时先问装到哪一家。字照扩展合并方案第二版逐字写（yoyo 11-20 回「改」），装的路子全是现有那几条。
import { useState, type ReactNode } from 'react'
import { Check, Download, FileArchive, FolderOpen, Headset, Plus } from 'lucide-react'
import { BrandIcon, Button, Dialog, Input, Notice, Select } from '../../ui'
import { ResultNotice, useOperation } from '../../business-common'
import { curatedDisclaimer, curatedInstallTarget, curatedNeedsInput } from '../../registry/curated-extensions'
import { extensionFamilies } from '../../registry/extensions'
import type { V2Bridge } from '../../types'
import { activeProviderIds, type ActiveProviderId } from '../../../../electron/catalog'
import {
  CuratedDetails,
  curatedRuntimeCommand,
  extensionFailureTarget,
  extensionToolName,
  extensionToolNames,
  fillCuratedPlaceholders,
  mcpCopyOffered,
  mcpNameTakenIn,
  mcpRuntimeNotice,
  runExtensionAction,
  submitMcpInstall,
  unresolvedInstallPlaceholders,
  type McpRuntimeNotice,
} from './extensions-common'
import {
  entryTargetState,
  skillSourceDirectory,
  type HubEntry,
  type HubTargetContext,
  type HubTargetState,
} from './plugins-hub-model'

type Provider = ActiveProviderId
type ExtensionSnapshot = Awaited<ReturnType<V2Bridge['listProviderExtensions']>>
type RuntimeInstallManagement = Awaited<ReturnType<V2Bridge['getPlatformCapabilities']>>['pythonRuntimeInstall']
type Operation = Pick<ReturnType<typeof useOperation>, 'busy' | 'error' | 'detail' | 'failed' | 'execute' | 'clear'>

/** 「Claude、GPT」：提示里用的三家叫法，次序同导航。 */
export function familyNames(ids: readonly string[]): string {
  return activeProviderIds.filter((id) => ids.includes(id)).map((id) => extensionFamilies[id].name).join('、')
}

/** 灰着不能勾的那一行为什么灰；能勾的回 null。 */
export function hubChoiceNote(state: HubTargetState, provider: Provider): string | null {
  if (state.state === 'installed') return '已经装好了'
  if (state.state === 'tool-missing') return `这台电脑还没装 ${extensionToolName(provider)}`
  if (state.state === 'vendor-only') return `插件各家格式不通用，这一条只有 ${extensionFamilies[state.vendor].name} 版`
  if (state.state === 'unsupported') return '不支持'
  return null
}

/** 「装到 {N} 个」，只勾一个时写「安装」。 */
export function hubInstallLabel(count: number): string {
  return count === 1 ? '安装' : `装到 ${count} 个`
}

/**
 * 「装到哪里」三行：Claude、GPT、Grok，每行底下小字写清是哪几个工具。能装的是勾选框；装好了的打勾灰着；
 * 这台电脑没装那个工具的灰着，旁边给「去首页安装」；插件只有别家版的灰着说明为什么。
 */
export function HubToolPicker({
  entry,
  context,
  selected,
  onToggle,
  onOpenHome,
  disabled,
  testId,
}: {
  entry: HubEntry
  context: HubTargetContext
  selected: readonly Provider[]
  onToggle: (id: Provider) => void
  onOpenHome?: () => void
  disabled?: boolean
  testId: string
}) {
  return (
    <div className="xm-field">
      {/* 读屏从按钮组自己的名字读到它，这里只给眼睛看。 */}
      <label aria-hidden="true">装到哪里</label>
      <div className="v2-hub-picker" role="group" aria-label="装到哪里" data-testid={testId}>
        {activeProviderIds.map((id) => {
          const state = entryTargetState(entry, id, context)
          const note = hubChoiceNote(state, id)
          const installed = state.state === 'installed'
          const on = installed || (state.state === 'addable' && selected.includes(id))
          const family = extensionFamilies[id]
          return (
            <div key={id} className={`v2-hub-picker-row${state.state === 'addable' ? '' : ' is-off'}`}>
              <button
                type="button"
                aria-pressed={on}
                disabled={disabled || state.state !== 'addable'}
                onClick={() => onToggle(id)}
                data-testid={`${testId}-${id}`}
              >
                <span className="v2-ext-tool-picker-check" aria-hidden="true">
                  {on && <Check size={10} strokeWidth={3.4} />}
                </span>
                <BrandIcon tool={id} size={18} variant="xs" />
                <span className="v2-hub-picker-text">
                  <strong>{family.name}</strong>
                  <small>{entry.kind === 'skill' ? family.skillHint : family.hint}</small>
                  {note && <small className="v2-hub-picker-note">{note}</small>}
                </span>
              </button>
              {state.state === 'tool-missing' && onOpenHome && (
                <Button size="sm" icon={Download} onClick={onOpenHome} testId={`${testId}-${id}-home`}>
                  去首页安装
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 复制一条自己加的连接时从哪一家拿：Claude Code、Codex「我的（全局）」里自己加的那份。 */
function mcpCopySource(entry: HubEntry) {
  return entry.installs.find((install) => mcpCopyOffered(install.provider, install.item))
}

function skillCopySource(entry: HubEntry) {
  for (const install of entry.installs) {
    const directory = skillSourceDirectory(install.item)
    if (directory) return directory
  }
  return null
}

/**
 * 点「+」、详情页「装上」「装到 {家}」弹的安装框。一家一家装，中途哪家没装上就停在那里：装上了的从勾选里拿掉，
 * 再点一次只补剩下的（同精选页的规矩）。装的路子按这一条是什么分：精选照清单（submitMcpInstall / 装插件），
 * 市场里的插件照列表那一份装，自己加的连接用「也装到别的工具」那条（copyMcpToTool），技能把同一个文件夹再导一次。
 */
export function HubInstallDialog({
  api,
  entry,
  initial,
  context,
  runtimes,
  pythonInstall,
  operation,
  onClose,
  onChanged,
  onOpenHome,
  onOpenHelp,
  onSystemChanged,
  codexViaDesktop = false,
}: {
  api: V2Bridge
  entry: HubEntry
  /** 打开时勾上哪几家（详情页每一行的「装上」只勾那一家）。 */
  initial: readonly Provider[]
  context: HubTargetContext
  runtimes: ExtensionSnapshot['runtimes']
  pythonInstall: RuntimeInstallManagement
  operation: Operation
  onClose: () => void
  onChanged: () => Promise<void>
  onOpenHome?: () => void
  onOpenHelp?: () => void
  onSystemChanged?: () => void
  /** 只装了 Codex 桌面端时，提示里 Codex 那一家叫「Codex 桌面端」（同外接工具页）；插件要 CLI，不算。 */
  codexViaDesktop?: boolean
}) {
  const [selected, setSelected] = useState<Provider[]>([...initial])
  const [stage, setStage] = useState<'details' | 'input'>('details')
  const [values, setValues] = useState<Record<string, string>>({})
  const curated = entry.curated
  const targets = activeProviderIds.filter((id) => selected.includes(id) && entryTargetState(entry, id, context).state === 'addable')
  const needsInput = Boolean(curated && curatedNeedsInput(curated))
  const runtimeNotice = curated ? mcpRuntimeNotice(curatedRuntimeCommand(curated), runtimes, pythonInstall) : null
  const busy = operation.busy === 'hub-install'
  const close = () => {
    if (!operation.busy) onClose()
  }
  const installPython = () =>
    void operation.execute(
      'python',
      async () => {
        await api.installPythonRuntime()
        onSystemChanged?.()
        await onChanged()
      },
      'Python 已经装好了，可以继续添加这条连接',
    )
  const installInto = async (target: Provider) => {
    if (curated) {
      const plan = curated.install
      if (plan.type === 'plugin') {
        await api.mutateProviderExtension({ provider: target, kind: 'plugin', action: 'install', source: curatedInstallTarget(curated) })
        return
      }
      const filled = plan.type === 'stdio' ? fillCuratedPlaceholders(plan.args, plan.env, values) : null
      await submitMcpInstall(api, target, curated.id, plan.type === 'stdio' && filled ? { ...plan, ...filled } : plan, 'user')
      return
    }
    if (entry.kind === 'plugin') {
      const item = entry.available[target]
      if (!item) throw new Error('这一条在市场里找不到了，请重新加载后再试。')
      await runExtensionAction(api, item, 'install')
      return
    }
    if (entry.kind === 'mcp') {
      const source = mcpCopySource(entry)
      if (!source) throw new Error('这条连接找不到了，请重新加载后再试。')
      await api.copyMcpToTool({ from: source.provider, to: target, name: source.item.id })
      return
    }
    const directory = skillCopySource(entry)
    if (!directory) throw new Error('这个技能的文件位置已经变化，请刷新列表后再操作。')
    if (target === 'codex') await api.importSkill({ sourcePath: directory, scope: 'user' })
    else await api.mutateProviderExtension({ provider: target, kind: 'skill', action: 'install', source: directory, scope: 'user' })
  }
  const install = () =>
    void operation.execute(
      'hub-install',
      async () => {
        if (curated?.install.type === 'stdio') {
          const filled = fillCuratedPlaceholders(curated.install.args, curated.install.env, values)
          const pending = unresolvedInstallPlaceholders(filled.args, filled.env)
          if (pending.length) throw new Error(`${pending.join('、')} 还没换成真实内容，请先填好再添加。`)
        }
        // 自己加的连接复制过去之前先问一遍那边有没有同名的：Codex、Grok 加同名的会把原来那条整条换掉。
        if (!curated && entry.kind === 'mcp') {
          const name = mcpCopySource(entry)?.item.id ?? ''
          const taken = await mcpNameTakenIn(api, targets, name, 'user')
          if (taken.length) {
            const names = familyNames(taken)
            throw new Error(`${names} 里已经有叫「${name}」的连接了，为了不动原来那条，这次没有装。不勾 ${names} 再试。`)
          }
        }
        const done: Provider[] = []
        try {
          for (const target of targets) {
            await installInto(target)
            done.push(target)
          }
        } finally {
          if (done.length) {
            if (done.length < targets.length) setSelected(targets.filter((target) => !done.includes(target)))
            await onChanged()
          }
        }
        onClose()
        return done
      },
      (done) => `已安装「${entry.name}」，给 ${extensionToolNames(done, codexViaDesktop && entry.kind !== 'plugin')} 使用，下次打开工具时生效`,
    )
  const runtimeActions = (notice: McpRuntimeNotice): ReactNode =>
    notice.installPython || (notice.support && onOpenHelp) ? (
      <>
        {notice.installPython && (
          <Button size="sm" icon={Download} loading={operation.busy === 'python'} disabled={Boolean(operation.busy)} onClick={installPython} testId="mcp-install-python">
            自动安装 Python
          </Button>
        )}
        {/* 缺 uv 星芒装不了，交给客服教（D20）。 */}
        {notice.support && onOpenHelp && (
          <Button size="sm" icon={Headset} onClick={onOpenHelp} testId="mcp-runtime-support">
            联系客服
          </Button>
        )}
      </>
    ) : undefined
  return (
    <Dialog
      open
      title={`安装「${entry.name}」`}
      testId="hub-install-dialog"
      busy={busy}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            icon={Plus}
            loading={busy}
            disabled={targets.length === 0}
            onClick={() => {
              if (needsInput && stage === 'details') setStage('input')
              else install()
            }}
            testId="hub-install-submit"
          >
            {needsInput && stage === 'details' ? '继续填写' : hubInstallLabel(targets.length)}
          </Button>
        </>
      }
    >
      {curated && stage === 'details' && <CuratedDetails item={curated} hideScope />}
      {!curated && entry.summary && <p>{entry.summary}</p>}
      {!curated && entry.kind === 'mcp' && (
        <p>连接里填过的密钥、环境变量和请求头会原样带过去，装在那些工具的「我的（全局）」里，下次打开工具时生效。</p>
      )}
      {!curated && entry.kind === 'skill' && (
        <dl className="v2-business-kv">
          <dt>来源</dt>
          <dd className="v2-business-path">{skillCopySource(entry)}</dd>
        </dl>
      )}
      {!curated && entry.kind === 'plugin' && <p>{curatedDisclaimer}</p>}
      {curated && stage === 'input' &&
        curated.inputs.map((input) => (
          <Notice
            key={input.key}
            tone={values[input.key]?.trim() ? 'ok' : 'warn'}
            title={values[input.key]?.trim() ? `${input.label}：${values[input.key]}` : `还缺一样：${input.label}`}
            body={`点「选择文件夹」挑一个，软件会替你填好，不用手改。${input.hint}`}
            testId={`curated-input-${input.key}`}
            actions={
              <Button
                size="sm"
                icon={FolderOpen}
                disabled={Boolean(operation.busy)}
                onClick={() =>
                  void operation.execute(
                    'choose-directory',
                    async () => {
                      const chosen = await api.chooseExtensionDirectory()
                      if (chosen) setValues((current) => ({ ...current, [input.key]: chosen }))
                    },
                    () => null,
                  )
                }
                testId={`curated-choose-${input.key}`}
              >
                选择文件夹
              </Button>
            }
          />
        ))}
      {runtimeNotice && (
        <Notice tone="warn" title={runtimeNotice.title} body={runtimeNotice.body} testId="curated-runtime-notice" actions={runtimeActions(runtimeNotice)} />
      )}
      <HubToolPicker
        entry={entry}
        context={context}
        selected={selected}
        disabled={Boolean(operation.busy)}
        onToggle={(id) => setSelected((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))}
        onOpenHome={
          onOpenHome
            ? () => {
                onClose()
                onOpenHome()
              }
            : undefined
        }
        testId="hub-install-tools"
      />
      <ResultNotice error={operation.error} detail={operation.detail} onSupport={onOpenHelp} target={extensionFailureTarget(operation.failed)} />
    </Dialog>
  )
}

/**
 * 技能「从文件夹导入」：选一个技能文件夹，一次导进勾上的几家。Codex 走它自己的导入（importSkill），
 * Claude Code、Grok CLI 由主进程照 Codex 那套复制进它们自己的技能文件夹；一家一家导，中途失败只留没导上的。
 * 「从压缩包导入」（总单 Q4 C4）是同一张表单：压缩包只能从系统的选文件窗口选，主进程查完解开，
 * 交回解开的那个技能文件夹，后面照「从文件夹导入」一家一家导。
 */
export function HubSkillImportDialog({
  api,
  from = 'folder',
  tools,
  importable,
  operation,
  onClose,
  onChanged,
}: {
  api: V2Bridge
  /** 从文件夹还是从压缩包导入；缺省是文件夹。 */
  from?: 'folder' | 'archive'
  /** 能导进去的几家（工具装好了、主进程没说不行），次序同导航；打开时都勾上。 */
  tools: readonly Provider[]
  /** 三家各自能不能导（不能的灰着写「不支持」，没装的写「这台电脑还没装 …」）。 */
  importable: Record<Provider, 'ready' | 'tool-missing' | 'unsupported'>
  operation: Operation
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [source, setSource] = useState('')
  const [archive, setArchive] = useState<{ archiveName: string; directory: string } | null>(null)
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [selected, setSelected] = useState<Provider[]>([...tools])
  const targets = activeProviderIds.filter((id) => selected.includes(id) && importable[id] === 'ready')
  const busy = operation.busy === 'hub-import'
  const submit = () =>
    void operation.execute(
      'hub-import',
      async () => {
        const path = from === 'archive' ? archive?.directory ?? '' : source.trim()
        if (!path) throw new Error('请填写来源。')
        const done: Provider[] = []
        try {
          for (const target of targets) {
            if (target === 'codex') await api.importSkill({ sourcePath: path, scope: scope === 'project' ? 'repo' : 'user' })
            else await api.mutateProviderExtension({ provider: target, kind: 'skill', action: 'install', source: path, scope })
            done.push(target)
          }
        } finally {
          if (done.length) {
            if (done.length < targets.length) setSelected(targets.filter((target) => !done.includes(target)))
            await onChanged()
          }
        }
        onClose()
        return done
      },
      (done) => {
        const path = from === 'archive' ? archive?.directory ?? '' : source.trim()
        return `已添加「${path.split(/[\\/]/).filter(Boolean).pop() ?? path}」，给 ${extensionToolNames(done)} 使用，下次打开工具时生效`
      },
    )
  return (
    <Dialog
      open
      title={from === 'archive' ? '从压缩包导入' : '从文件夹导入'}
      testId="hub-skill-import"
      busy={busy}
      onClose={() => {
        if (!operation.busy) onClose()
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            icon={Plus}
            loading={busy}
            disabled={targets.length === 0 || (from === 'archive' && !archive)}
            onClick={submit}
            testId="hub-skill-import-submit"
          >
            添加
          </Button>
        </>
      }
    >
      <ResultNotice error={operation.error} detail={operation.detail} target={extensionFailureTarget(operation.failed)} />
      {from === 'archive' ? (
        <div className="v2-hub-path-row">
          <Input label="压缩包" value={archive?.archiveName ?? ''} readOnly mono testId="hub-skill-archive-name" />
          <Button
            icon={FileArchive}
            loading={operation.busy === 'choose-archive'}
            disabled={Boolean(operation.busy)}
            onClick={() =>
              void operation.execute(
                'choose-archive',
                async () => {
                  const chosen = await api.chooseSkillArchive()
                  if (chosen) setArchive(chosen)
                },
                () => null,
              )
            }
            testId="hub-skill-archive-choose"
          >
            选择压缩包
          </Button>
        </div>
      ) : (
        <div className="v2-hub-path-row">
          <Input label="技能文件夹路径" value={source} onChange={(event) => setSource(event.target.value)} mono testId="hub-skill-import-source" />
          <Button
            icon={FolderOpen}
            disabled={Boolean(operation.busy)}
            onClick={() =>
              void operation.execute(
                'choose-directory',
                async () => {
                  const chosen = await api.chooseExtensionDirectory()
                  if (chosen) setSource(chosen)
                },
                () => null,
              )
            }
            testId="hub-skill-import-choose"
          >
            选择文件夹
          </Button>
        </div>
      )}
      <Select
        aria-label="添加范围"
        options={[
          { value: 'user', label: '我的（全局）' },
          { value: 'project', label: '当前项目' },
        ]}
        value={scope}
        onChange={(event) => setScope(event.target.value === 'project' ? 'project' : 'user')}
      />
      <div className="xm-field">
        <label aria-hidden="true">装到哪里</label>
        <div className="v2-hub-picker" role="group" aria-label="装到哪里" data-testid="hub-skill-import-tools">
          {activeProviderIds.map((id) => {
            const state = importable[id]
            const on = state === 'ready' && selected.includes(id)
            const family = extensionFamilies[id]
            return (
              <div key={id} className={`v2-hub-picker-row${state === 'ready' ? '' : ' is-off'}`}>
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={Boolean(operation.busy) || state !== 'ready'}
                  onClick={() => setSelected((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))}
                  data-testid={`hub-skill-import-tools-${id}`}
                >
                  <span className="v2-ext-tool-picker-check" aria-hidden="true">
                    {on && <Check size={10} strokeWidth={3.4} />}
                  </span>
                  <BrandIcon tool={id} size={18} variant="xs" />
                  <span className="v2-hub-picker-text">
                    <strong>{family.name}</strong>
                    <small>{family.skillHint}</small>
                    {state === 'tool-missing' && <small className="v2-hub-picker-note">{`这台电脑还没装 ${extensionToolName(id)}`}</small>}
                    {state === 'unsupported' && <small className="v2-hub-picker-note">不支持</small>}
                  </span>
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </Dialog>
  )
}

/** 「添加插件」时「装到」选着「全部」：插件各家格式不通用，先问装进哪一家，再打开那一家的添加表单。 */
export function HubToolChooser({
  tools,
  onChoose,
  onClose,
}: {
  /** 装好了命令行工具的几家；没装的灰着。 */
  tools: readonly string[] | undefined
  onChoose: (id: Provider) => void
  onClose: () => void
}) {
  return (
    <Dialog
      open
      title="装到哪里"
      testId="hub-tool-chooser"
      onClose={onClose}
      footer={<Button onClick={onClose}>取消</Button>}
    >
      <div className="v2-hub-picker" role="group" aria-label="装到哪里">
        {activeProviderIds.map((id) => {
          const ready = !tools || tools.includes(id)
          const family = extensionFamilies[id]
          return (
            <div key={id} className={`v2-hub-picker-row${ready ? '' : ' is-off'}`}>
              <button type="button" disabled={!ready} onClick={() => onChoose(id)} data-testid={`hub-tool-chooser-${id}`}>
                <BrandIcon tool={id} size={18} variant="xs" />
                <span className="v2-hub-picker-text">
                  <strong>{family.name}</strong>
                  <small>{family.hint}</small>
                  {!ready && <small className="v2-hub-picker-note">{`这台电脑还没装 ${extensionToolName(id)}`}</small>}
                </span>
              </button>
            </div>
          )
        })}
      </div>
    </Dialog>
  )
}
