import { useCallback, useState } from 'react'
import { Download, FolderOpen, MessageSquare, Plus, Sparkles } from 'lucide-react'
import { BrandIcon, Button, Dialog, Empty, Notice, PageHead, Pill, Segment } from './ui'
import { ResultNotice, useOperation, useReloadWhenShown, useResource } from './business-common'
import {
  curatedDisclaimer,
  curatedExtensions,
  curatedInstallTarget,
  curatedKinds,
  curatedNeedsInput,
  type CuratedExtension,
} from './registry/curated-extensions'
import { extensionKindLabels } from './registry/extensions'
import {
  CuratedDetails,
  ExtensionCard,
  ExtensionToolPicker,
  curatedIcon,
  curatedRuntimeCommand,
  curatedTags,
  extensionFailureTarget,
  extensionToolChoices,
  extensionToolNames,
  fillCuratedPlaceholders,
  mcpRuntimeNotice,
  submitMcpInstall,
  unresolvedInstallPlaceholders,
} from './pages-management'
import { activeProviderIds, isActiveProviderId, type ActiveProviderId } from '../../electron/catalog'
import type { V2Bridge } from './types'
import './extensions.css'

type ExtensionSnapshot = Awaited<ReturnType<V2Bridge['listProviderExtensions']>>

/** 每个读到了的工具里已经装上的条目，记成「类别:id」（MCP 用连接名，插件用 插件名@市场名）。 */
export type FeaturedAdded = Partial<Record<ActiveProviderId, string[]>>

function featuredKey(kind: string, id: string): string {
  return `${kind}:${id}`
}

/** 把几个工具各自的列表收成「哪个工具装了哪些」；没读到的工具不写进去，当作不知道。 */
export function featuredAddedFrom(snapshots: readonly ExtensionSnapshot[]): FeaturedAdded {
  const added: FeaturedAdded = {}
  for (const snapshot of snapshots) {
    if (!isActiveProviderId(snapshot.provider)) continue
    added[snapshot.provider] = snapshot.items
      .filter((item) => item.installed)
      .map((item) => featuredKey(item.kind, item.id))
  }
  return added
}

/** 这一条已经装进了哪几个工具。 */
export function featuredAddedTools(item: CuratedExtension, added: FeaturedAdded): ActiveProviderId[] {
  const key = featuredKey(item.kind, curatedInstallTarget(item))
  return item.providers.filter((id) => added[id]?.includes(key))
}

/**
 * 卡上写「已添加」的条件：它支持、这台电脑也装了的工具里，每一个都已经装上它。一个能用的工具都没装、
 * 或者有哪个还没读到，都照旧给按钮，点进去再看。installedProviders 缺省 = 还没检测完，当作都装了。
 */
export function featuredFullyAdded(
  item: CuratedExtension,
  installedProviders: readonly string[] | undefined,
  added: FeaturedAdded,
): boolean {
  const usable = item.providers.filter((id) => !installedProviders || installedProviders.includes(id))
  const done = featuredAddedTools(item, added)
  return usable.length > 0 && usable.every((id) => done.includes(id))
}

// 只列有条目的类型：现在的清单里没有技能，就不放一个点进去永远是空的「技能」。
const kindOptions = [
  { value: 'all', label: '全部类型' },
  ...curatedKinds
    .filter((kind) => curatedExtensions.some((item) => item.kind === kind))
    .map((kind) => ({ value: kind, label: extensionKindLabels[kind] })),
]

/**
 * 精选页：把「星芒精选」的条目摆成一页，一次装进几个工具。装的路子和外接工具、插件两页底下的精选完全
 * 同一条（submitMcpInstall / mutateProviderExtension），不另开通道，主进程的校验照样过一遍。
 */
export function FeaturedPage({
  api,
  installedProviders,
  onRecommend,
  onOpenHelp,
  onSystemChanged,
  active,
}: {
  api: V2Bridge
  /** 这台电脑上装好的命令行工具；缺省 = 还没检测完，三个都去读、都当作装了。 */
  installedProviders?: readonly string[]
  /** 「推荐一个」：去「反馈与客服」；缺省 = 不放这颗按钮。 */
  onRecommend?: () => void
  onOpenHelp?: () => void
  /** 「自动安装 Python」装好以后叫一声，首页「运行环境」跟着变（同 ExtensionsPage）。 */
  onSystemChanged?: () => void
  /** 同 BusinessActions.active：再显示时重读一遍哪些已经装上了。 */
  active?: boolean
}) {
  const installedKey = installedProviders?.join(',')
  // 卡上的「已添加」要问每个装了的工具一遍；读不到的那个只当不知道，不让整页读不出来。
  const load = useCallback(async () => {
    const targets = activeProviderIds.filter((id) => installedKey === undefined || installedKey.split(',').includes(id))
    const [snapshots, platform] = await Promise.all([
      Promise.allSettled(targets.map((id) => api.listProviderExtensions(id))),
      api.getPlatformCapabilities().catch(() => null),
    ])
    const read = snapshots.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    return {
      added: featuredAddedFrom(read),
      // 有没有 Python、uv 是这台电脑的事，哪个工具读回来的都一样，取第一份。
      runtimes: read.find((snapshot) => snapshot.runtimes)?.runtimes,
      pythonInstall: platform?.pythonRuntimeInstall ?? 'external',
    }
  }, [api, installedKey])
  const resource = useResource(load)
  useReloadWhenShown(active, () => {
    if (!resource.loading) void resource.reload()
  })
  const operation = useOperation()
  const [kind, setKind] = useState('all')
  const [picking, setPicking] = useState<CuratedExtension | null>(null)
  // 要填文件夹的条目点「继续填写」以后换成选文件夹那一步，还在同一个对话框里。
  const [stage, setStage] = useState<'details' | 'input'>('details')
  const [selectedTools, setSelectedTools] = useState<ActiveProviderId[]>([])
  const [values, setValues] = useState<Record<string, string>>({})
  const added = resource.data?.added ?? {}
  const shown = curatedExtensions.filter((item) => kind === 'all' || item.kind === kind)
  const choices = picking
    ? extensionToolChoices(picking.providers, installedProviders, featuredAddedTools(picking, added))
    : []
  const targets = choices
    .filter((choice) => choice.note === null && selectedTools.includes(choice.id))
    .map((choice) => choice.id)
  const runtimeNotice = picking
    ? mcpRuntimeNotice(curatedRuntimeCommand(picking), resource.data?.runtimes, resource.data?.pythonInstall ?? 'external')
    : null
  const open = (item: CuratedExtension) => {
    const available = extensionToolChoices(item.providers, installedProviders, featuredAddedTools(item, added))
      .filter((choice) => choice.note === null)
      .map((choice) => choice.id)
    setPicking(item)
    setStage('details')
    setValues({})
    setSelectedTools(available)
    operation.clear()
  }
  const close = () => {
    if (!operation.busy) setPicking(null)
  }
  const installPython = () =>
    void operation.execute(
      'python',
      async () => {
        await api.installPythonRuntime()
        onSystemChanged?.()
        await resource.reload()
      },
      'Python 已经装好了，可以继续添加这条连接',
    )
  const install = (item: CuratedExtension) =>
    void operation.execute(
      'featured',
      async () => {
        const plan = item.install
        const filled = plan.type === 'stdio' ? fillCuratedPlaceholders(plan.args, plan.env, values) : null
        if (filled) {
          const pending = unresolvedInstallPlaceholders(filled.args, filled.env)
          if (pending.length)
            throw new Error(`${pending.join('、')} 还没换成真实内容，请先填好再添加。`)
        }
        const done: ActiveProviderId[] = []
        try {
          for (const target of targets) {
            if (plan.type === 'plugin')
              await api.mutateProviderExtension({
                provider: target,
                kind: 'plugin',
                action: 'install',
                source: curatedInstallTarget(item),
              })
            else await submitMcpInstall(api, target, item.id, plan.type === 'stdio' && filled ? { ...plan, ...filled } : plan, 'user')
            done.push(target)
          }
        } finally {
          // 一个工具没装上就停在那里：装上了的从勾选里拿掉，再点一次只补剩下的。
          if (done.length) {
            if (done.length < targets.length) setSelectedTools(targets.filter((target) => !done.includes(target)))
            await resource.reload()
          }
        }
        setPicking(null)
        return done
      },
      (done) => `${item.kind === 'mcp' ? '已添加' : '已安装'}「${item.name}」，给 ${extensionToolNames(done)} 使用`,
    )
  const verb = picking?.kind === 'mcp' ? '添加' : '安装'
  const needsInput = Boolean(picking && curatedNeedsInput(picking))
  return (
    <section className="v2-page v2-ext-page" data-page-id="featured" data-testid="page-featured">
      <PageHead
        title="精选"
        actions={
          onRecommend && (
            <Button icon={MessageSquare} onClick={onRecommend} testId="featured-recommend">
              推荐一个
            </Button>
          )
        }
      />
      <div className="v2-featured-filter">
        <span>{curatedDisclaimer}</span>
        <Segment options={kindOptions} value={kind} onChange={setKind} testId="featured-kind" />
      </div>
      {shown.length > 0 ? (
        <div className="v2-ext-grid" data-testid="featured-list">
          {shown.map((item) => (
            <ExtensionCard
              key={item.id}
              icon={curatedIcon(item)}
              name={item.name}
              badge={<Pill>{extensionKindLabels[item.kind]}</Pill>}
              byline={item.publisher}
              summary={item.summary}
              tags={curatedTags(item)}
              footer={
                <>
                  <span
                    className="v2-featured-tools"
                    role="img"
                    aria-label={`能用的工具：${extensionToolNames(item.providers)}`}
                  >
                    {item.providers.map((id) => (
                      <span key={id} title={extensionToolNames([id])}>
                        <BrandIcon tool={id} size={16} variant="xs" />
                      </span>
                    ))}
                  </span>
                  {featuredFullyAdded(item, installedProviders, added) ? (
                    <Pill tone="ok">已添加</Pill>
                  ) : (
                    <Button
                      size="sm"
                      icon={Plus}
                      disabled={Boolean(operation.busy)}
                      onClick={() => open(item)}
                      testId={`featured-install-${item.id}`}
                    >
                      {item.kind === 'mcp' ? '添加' : '安装'}
                    </Button>
                  )}
                </>
              }
              testId={`featured-card-${item.id}`}
            />
          ))}
        </div>
      ) : (
        <Empty icon={Sparkles} title="这一类暂时没有" description="换个类型看看。" testId="featured-empty" />
      )}
      <Dialog
        open={Boolean(picking)}
        title={`${verb}「${picking?.name ?? ''}」`}
        testId="featured-install-dialog"
        busy={operation.busy === 'featured'}
        onClose={close}
        footer={
          <>
            <Button onClick={close} disabled={operation.busy === 'featured'}>
              取消
            </Button>
            <Button
              variant="primary"
              icon={Plus}
              loading={operation.busy === 'featured'}
              disabled={targets.length === 0}
              onClick={() => {
                if (!picking) return
                if (needsInput && stage === 'details') setStage('input')
                else install(picking)
              }}
              testId="featured-install-submit"
            >
              {needsInput && stage === 'details' ? '继续填写' : verb}
            </Button>
          </>
        }
      >
        {picking && stage === 'details' && <CuratedDetails item={picking} hideScope />}
        {picking && stage === 'input' &&
          picking.inputs.map((input) => (
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
          <Notice
            tone="warn"
            title={runtimeNotice.title}
            body={runtimeNotice.body}
            testId="curated-runtime-notice"
            actions={
              runtimeNotice.installPython ? (
                <Button
                  size="sm"
                  icon={Download}
                  loading={operation.busy === 'python'}
                  disabled={Boolean(operation.busy)}
                  onClick={installPython}
                  testId="mcp-install-python"
                >
                  自动安装 Python
                </Button>
              ) : undefined
            }
          />
        )}
        <ExtensionToolPicker
          choices={choices}
          selected={selectedTools}
          disabled={Boolean(operation.busy)}
          onToggle={(id) =>
            setSelectedTools((current) =>
              current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
            )
          }
          testId="featured-install-tools"
        />
        <ResultNotice
          error={operation.error}
          detail={operation.detail}
          onSupport={onOpenHelp}
          target={extensionFailureTarget(operation.failed)}
        />
      </Dialog>
    </section>
  )
}
