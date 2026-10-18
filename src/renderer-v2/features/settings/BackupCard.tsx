import { useCallback, useRef, useState } from 'react'
import { ChevronDown, FileText, RefreshCw, Trash2 } from 'lucide-react'
import { BrandIcon, Button, Card, Dialog, ListRow, Menu, Notice, Pill, Segment, type MenuItem } from '../../ui'
import { ListState, ResultNotice, displayDate, errorMessage, useOperation, useReloadWhenShown, useResource } from '../../business-common'
import { formatClockTime } from '../../calendar-time'
import { tools } from '../../registry/tools'
import { backupKeyView } from '../tools/backup-key'
import { connectionCheckView } from '../tools/connection-check'
import { isActiveProviderId, type ActiveProviderId } from '../../../../electron/catalog'
import type { V2Bridge, V2Page } from '../../types'

type Provider = ActiveProviderId
type Backup = Awaited<ReturnType<V2Bridge['listBackups']>>[number]
type Preview = Awaited<ReturnType<V2Bridge['inspectBackup']>>
type RestoreCheck = {
  provider: Provider
  result: Awaited<ReturnType<V2Bridge['checkProviderConnection']>> | null
  error: string | null
}

// 已下线的工具（Gemini）不在筛选、备份里出现，主进程回来的数据里带着它也不认。
const backupTools = tools.flatMap((tool) => tool.kind === 'cli' && isActiveProviderId(tool.id) ? [{ id: tool.id, name: tool.name }] : [])

function providerName(id: string | null | undefined) {
  return tools.find((tool) => tool.id === id)?.name ?? id ?? ''
}

/** 列表和预览上的大小一律写 KB（原来预览里写字节，字表批09）。 */
export function backupSizeText(bytes: number): string {
  return `${(Math.max(0, bytes) / 1024).toFixed(1)} KB`
}

/** 备份原因的小标签；校验没过的不管原因，一律「校验失败」。 */
export function backupReasonTag(backup: Pick<Backup, 'valid' | 'reason'>): string {
  if (!backup.valid) return '校验失败'
  return backup.reason === 'manual' ? '手工' : backup.reason === 'pre-restore' ? '恢复前' : '配置前'
}

/**
 * 大小和原因：「3.2 KB，改 Codex CLI 配置前自动备份」。原因只说得出改配置前和恢复前两种，
 * 手工备份没有后半句。预览弹窗里那一行接在时间后面。
 */
export function backupDetail(backup: Pick<Backup, 'provider' | 'reason' | 'totalSize'>): string {
  const why = backup.reason === 'pre-save' ? `，改 ${providerName(backup.provider)} 配置前自动备份` : backup.reason === 'pre-restore' ? '，恢复前自动备份' : ''
  return `${backupSizeText(backup.totalSize)}${why}`
}

/** 列表那一行的说明：「Codex CLI 配置，3.2 KB，改 Codex CLI 配置前自动备份」。 */
export function backupDescription(backup: Pick<Backup, 'provider' | 'reason' | 'totalSize'>): string {
  return `${providerName(backup.provider)} 配置，${backupDetail(backup)}`
}

function backupTime(createdAt: string | null | undefined, now: number): string {
  const time = createdAt ? Date.parse(createdAt) : Number.NaN
  return formatClockTime(time, now) ?? displayDate(createdAt)
}

/**
 * 恢复完只在这张卡上说「已恢复」是不够的：用户接下来是回首页看、或者直接打开工具，
 * 所以恢复成功后通知外层重读配置（`onRestored`），并当场测一次这个工具的连接，
 * 把结论留在卡上。
 */
function RestoreCheckNotice({ check, navigate }: { check: RestoreCheck; navigate?: (page: V2Page, section?: string) => void }) {
  const name = providerName(check.provider)
  if (!check.result) {
    return (
      <Notice
        tone={check.error ? 'bad' : 'neutral'}
        title={check.error ? `${name} · 没测成` : `正在测 ${name} 的连接`}
        body={check.error ?? '配置已恢复，正在用恢复出来的配置发一次最小请求。'}
        testId="backups-restore-check"
      />
    )
  }
  const view = connectionCheckView(check.result)
  const target = view.target
  const section = view.section ?? undefined
  return (
    <Notice
      tone={view.tone}
      title={`${name} · ${view.statusLabel}`}
      body={<><div>{view.title}</div><div>{view.body}</div></>}
      actions={target && navigate ? <Button size="sm" onClick={() => navigate(target, section)} testId="backups-restore-check-fix">去处理</Button> : undefined}
      testId="backups-restore-check"
    />
  )
}

function BackupKeyPill({ backup }: { backup: Backup }) {
  const view = backup.valid ? backupKeyView(backup) : null
  if (!view) return null
  // 「账号 xxx 的密钥」里是账号名，太长时省略、悬停看全文（components.css 的 .xm-row-title）。
  return <Pill tone={view.tone} testId={`backups-key-${backup.id}`}><span title={view.label}>{view.label}</span></Pill>
}

/**
 * 设置 › 备份迁移最上面的「工具配置备份」（v4 批09，原来是单独的备份页）。每次露面都重读一次：
 * 改配置、改用账号前都会自动留一份，改用失败的错误框还叫人到这里恢复改用之前的那一份。
 */
export function BackupCard({ api, active, onRestored, navigate, installedProviders }: {
  api: V2Bridge
  /** 设置页正在眼前；从别的页回来时重读一次。缺省 = 只在挂上时读。 */
  active?: boolean
  /** 恢复成功后回调，用来让首页重读配置。 */
  onRestored?: (provider: Provider) => void
  /** 连接测试结论的「去处理」；缺省 = 不给这颗按钮。 */
  navigate?: (page: V2Page, section?: string) => void
  /**
   * 装好的命令行工具：「立即备份 › 全部工具」只备份这几家，免得给没装的工具存一份空备份。单独点哪一家都能备份
   * （只装了 Codex 桌面端的也要能备份 Codex 那份配置），和原来的备份页一样。缺省 = 全部工具就是每一家。
   */
  installedProviders?: readonly string[]
}) {
  const load = useCallback(() => api.listBackups(), [api])
  const resource = useResource(load)
  useReloadWhenShown(active, () => void resource.reload())
  const operation = useOperation()
  // 恢复写的是工具的配置文件，没权限时说「写不进配置文件」（已知29）；建备份、删备份写的是星芒自己的备份文件夹，照旧。
  const restoreFailureTarget = operation.failed === 'restore' ? 'config' : undefined
  const [provider, setProvider] = useState<Provider | 'all'>('all')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [restoring, setRestoring] = useState<Backup | null>(null)
  const [deletion, setDeletion] = useState<Backup | null>(null)
  const [restoreCheck, setRestoreCheck] = useState<RestoreCheck | null>(null)
  const checkSequence = useRef(0)
  const now = Date.now()
  // 连着恢复两份时只认最后一次的结论（T6）。
  async function checkRestored(restored: Provider) {
    const sequence = ++checkSequence.current
    setRestoreCheck({ provider: restored, result: null, error: null })
    let next: RestoreCheck
    try {
      next = { provider: restored, result: await api.checkProviderConnection(restored), error: null }
    } catch (error) {
      next = { provider: restored, result: null, error: errorMessage(error) }
    }
    if (checkSequence.current === sequence) setRestoreCheck(next)
  }
  const all = resource.data?.filter((item) => isActiveProviderId(item.provider)) ?? []
  const list = provider === 'all' ? all : all.filter((item) => item.provider === provider)
  const installedTools = backupTools.filter((tool) => !installedProviders || installedProviders.includes(tool.id))
  function create(targets: readonly Provider[]) {
    void operation.execute(
      'create',
      async () => {
        // 「全部工具」中途哪一家没备份成，前面已经存好的也要摆进列表。
        try {
          for (const target of targets) await api.createBackup(target)
        } finally {
          await resource.reload()
        }
      },
      '备份完成',
    )
  }
  function inspect(backup: Backup) {
    void operation.execute('inspect', async () => { setPreview(await api.inspectBackup(backup.id)) }, '')
  }
  const backupItems: MenuItem[] = [
    { label: '全部工具', disabled: !installedTools.length, testId: 'backups-create-all', onSelect: () => create(installedTools.map((tool) => tool.id)) },
    ...backupTools.map((tool): MenuItem => ({
      label: tool.name,
      testId: `backups-create-${tool.id}`,
      onSelect: () => create([tool.id]),
    })),
  ]
  const restoringKey = restoring ? backupKeyView(restoring) : null
  const restoringTime = restoring ? backupTime(restoring.createdAt, now) : ''
  const previewKey = preview ? backupKeyView(preview) : null
  return (
    <Card
      title="工具配置备份"
      meta={resource.data && !resource.error ? `${list.length} 份备份` : undefined}
      padding="none"
      testId="page-backups"
      actions={
        <Menu
          label="立即备份"
          items={backupItems}
          anchor={
            <Button variant="primary" size="sm" iconRight={operation.busy === 'create' ? undefined : ChevronDown} loading={operation.busy === 'create'} testId="backups-create">
              {operation.busy === 'create' ? '正在备份' : '立即备份'}
            </Button>
          }
        />
      }
    >
      <div className="v2-backup-card-tools">
        <Segment
          options={[{ value: 'all', label: '全部工具' }, ...backupTools.map((tool) => ({ value: tool.id, label: tool.name }))]}
          value={provider}
          onChange={(next) => {
            if (next === 'all' || isActiveProviderId(next)) setProvider(next)
            operation.clear()
          }}
        />
      </div>
      <div className="v2-backup-card-notices">
        <ResultNotice {...operation} target={restoreFailureTarget} />
        {restoreCheck && <RestoreCheckNotice check={restoreCheck} navigate={navigate} />}
      </div>
      <ListState
        page="backups"
        noun="备份"
        loading={resource.loading}
        error={resource.error}
        count={list.length}
        retry={() => void resource.reload()}
        emptyTitle={provider === 'all' ? '还没有备份' : `${providerName(provider)} 还没有备份`}
        emptyDescription="点「立即备份」存一份当前的工具配置。"
      >
        {list.map((backup) => (
          <ListRow
            key={backup.id}
            leading={<BrandIcon tool={backup.provider ?? ''} size={18} />}
            title={backupTime(backup.createdAt, now)}
            badge={<><Pill tone={backup.valid ? 'neutral' : 'bad'}>{backupReasonTag(backup)}</Pill><BackupKeyPill backup={backup} /></>}
            desc={backupDescription(backup)}
            actions={
              <>
                <Button size="sm" variant="ghost" icon={FileText} onClick={() => inspect(backup)}>预览</Button>
                <Button size="sm" disabled={!backup.valid} onClick={() => setRestoring(backup)} testId={`backups-restore-${backup.id}`}>恢复</Button>
                <Button size="sm" variant="ghost" icon={Trash2} aria-label="删除这份备份" onClick={() => setDeletion(backup)} testId={`backups-delete-${backup.id}`} />
              </>
            }
            testId={`backups-row-${backup.id}`}
          />
        ))}
      </ListState>
      {/* 预览从抽屉换成弹窗（v4 不用抽屉），testId 沿用。 */}
      <Dialog
        open={Boolean(preview)}
        title="备份内容"
        onClose={() => setPreview(null)}
        testId="backup-preview-drawer"
        footer={
          <>
            <Button onClick={() => setPreview(null)}>关闭</Button>
            <Button variant="primary" icon={RefreshCw} disabled={!preview?.valid} onClick={() => { if (preview) setRestoring(preview) }}>
              恢复这份配置
            </Button>
          </>
        }
      >
        {preview && (
          <>
            <p className="v2-backup-preview-line">
              <Pill tone={preview.valid ? 'neutral' : 'bad'}>{backupReasonTag(preview)}</Pill>
              <span>{backupTime(preview.createdAt, now)}，{backupDetail(preview)}</span>
            </p>
            <p className={preview.valid ? 'v2-backup-preview-check' : 'v2-backup-preview-check is-bad'}>{preview.valid ? '已校验，文件完整' : preview.error}</p>
            <dl className="v2-business-kv">
              <dt>密钥</dt>
              <dd data-testid="backup-preview-key">{previewKey?.label ?? '这份备份没有记下密钥属于哪个账号'}</dd>
            </dl>
            {preview.files.map((file) => (
              <ListRow
                key={file.targetRelativePath}
                icon={FileText}
                title={file.targetRelativePath}
                desc={file.existed ? backupSizeText(file.size) : '原来不存在，恢复后将移除该文件'}
              />
            ))}
            <p className="v2-backup-preview-note">恢复前会先把当前配置另存一份，恢复后需要重新打开工具。</p>
            <p className="v2-backup-preview-note">备份在本机，可能含凭据，请妥善保管。</p>
          </>
        )}
      </Dialog>
      <Dialog
        open={Boolean(restoring)}
        title={`恢复到 ${restoringTime} 的配置？`}
        onClose={() => setRestoring(null)}
        footer={
          <>
            <Button onClick={() => setRestoring(null)}>取消</Button>
            <Button
              variant="primary"
              icon={RefreshCw}
              loading={operation.busy === 'restore'}
              testId="backups-restore-confirm"
              onClick={() => {
                if (restoring)
                  void operation.execute(
                    'restore',
                    async () => {
                      const result = await api.restoreBackup(restoring.id)
                      setRestoring(null)
                      setPreview(null)
                      // 列表里只有还在用的工具的备份，恢复出来的不会是已下线的那个；类型上仍要排除它。
                      if (isActiveProviderId(result.provider)) {
                        onRestored?.(result.provider)
                        void checkRestored(result.provider)
                      }
                      await resource.reload()
                      if (!result.preRestoreBackupId) throw new Error('恢复结果缺少恢复前备份信息，请查看反馈日志。')
                    },
                    `已恢复到 ${restoringTime} 的配置，原来的配置已另存`,
                  )
              }}
            >
              恢复
            </Button>
          </>
        }
      >
        <p>当前配置会先另存一份，恢复后需要重新打开工具。</p>
        {restoringKey?.restoreWarning && (
          <Notice tone="warn" title="密钥不是当前账号的" body={restoringKey.restoreWarning} testId="backups-restore-key-warning" />
        )}
        <ResultNotice error={operation.error} detail={operation.detail} target={restoreFailureTarget} />
      </Dialog>
      <Dialog
        open={Boolean(deletion)}
        title={`删除 ${deletion ? backupTime(deletion.createdAt, now) : ''} 的备份？`}
        onClose={() => setDeletion(null)}
        footer={
          <>
            <Button onClick={() => setDeletion(null)}>取消</Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={operation.busy === 'delete'}
              onClick={() => {
                if (deletion)
                  void operation.execute(
                    'delete',
                    async () => {
                      await api.deleteBackup(deletion.id)
                      setDeletion(null)
                      await resource.reload()
                    },
                    '备份已删除',
                  )
              }}
            >
              删除
            </Button>
          </>
        }
      >
        <p>删除后就不能用它恢复配置了。</p>
        <ResultNotice error={operation.error} detail={operation.detail} />
      </Dialog>
    </Card>
  )
}
