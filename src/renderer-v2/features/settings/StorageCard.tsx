import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Archive, Download, FileText, FolderOpen, Image, Images, MessageSquare, Trash2, type LucideIcon } from 'lucide-react'
import { Button, Card, Dialog, ListRow, useToast } from '../../ui'
import { ResultNotice, useOperation, useReloadWhenShown } from '../../business-common'
import { useLatestRequest } from '../../latest-request'
import { diagnosticFolderUnavailableMessage } from '../app/diagnostic-folder'
import type { StorageCleanResult, StorageCleanTarget, StorageUsagePart, StorageUsagePartReport } from '../../../../electron/ipc-contract'
import type { V2Bridge } from '../../types'

/** 「清理旧备份」留下最近这么多份，和主进程 storage-usage-service.ts 的 RETAINED_BACKUPS_AFTER_CLEANUP 一样。 */
export const retainedBackups = 10

type StorageReports = Partial<Record<StorageUsagePart, StorageUsagePartReport>>

interface StorageRowDefinition {
  part: StorageUsagePart
  icon: LucideIcon
  title: string
  /** 行下面的小字；备份那一行的份数要等算出来才写得上，由 storageRowDescription 拼。 */
  description: string | null
}

/** 六行，按页面上的顺序（决定单 D100，yoyo 2026-11-11 回「空间页改」）。 */
export const storageRows: readonly StorageRowDefinition[] = [
  { part: 'works', icon: Image, title: 'AI 作品', description: '聊天、画布、视频剪辑里生成的图片、视频和音频。' },
  { part: 'thumbnails', icon: Images, title: '作品缩略图', description: '作品库里的小图。删掉以后，看作品库时会重新生成。' },
  { part: 'chat-history', icon: MessageSquare, title: '聊天记录', description: '换电脑时可以用上面的「导出设置和聊天记录」带走。' },
  { part: 'logs', icon: FileText, title: '运行日志', description: '给客服查问题用的。' },
  { part: 'backups', icon: Archive, title: '工具配置备份', description: null },
  { part: 'downloads', icon: Download, title: '装工具时下载的文件', description: '装和更新命令行工具时下载下来的文件。删掉以后，下次装会重新下载。' },
]

/** 「约 820 KB」「约 35 MB」「约 2.1 GB」：KB、MB 取整，GB 留一位小数；进位到下一级时换单位，不写「约 1024 KB」。 */
export function storageSizeText(bytes: number): string {
  const safe = Math.max(0, bytes)
  const kilobytes = Math.round(safe / 1024)
  if (kilobytes < 1024) return `约 ${safe > 0 ? Math.max(1, kilobytes) : 0} KB`
  const megabytes = Math.round(safe / 1024 / 1024)
  if (megabytes < 1024) return `约 ${megabytes} MB`
  return `约 ${(safe / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 每一行右边：还在算、没算出来，或者大小。 */
export function storageRowValue(report: StorageUsagePartReport | undefined): string {
  if (!report) return '正在算…'
  return report.bytes === null ? '没算出来' : storageSizeText(report.bytes)
}

/** 最上面那一行的合计：六行都回来了才加，没算出来的那几行不算在里面；一行都没算出来就说没算出来。 */
export function storageTotalText(reports: StorageReports): string {
  const values = storageRows.map((row) => reports[row.part])
  if (values.some((report) => !report)) return '正在算…'
  const known = values.flatMap((report) => (report && report.bytes !== null ? [report.bytes] : []))
  if (!known.length) return '没算出来'
  return `一共${storageSizeText(known.reduce((sum, bytes) => sum + bytes, 0))}`
}

export function storageRowDescription(row: StorageRowDefinition, report: StorageUsagePartReport | undefined): string | null {
  if (row.part !== 'backups') return row.description
  return typeof report?.backupCount === 'number' ? `改工具配置之前自动存的旧配置，一共 ${report.backupCount} 份。` : null
}

/** 清完的提示条，三个「清理」共用；有文件被占着没删掉时换成另一句。 */
export function storageCleanedText(result: StorageCleanResult): string {
  return result.kept > 0
    ? `有些文件正被占用，没删掉，腾出${storageSizeText(result.freedBytes)}。关掉正在用的工具后可以再清一次。`
    : `已清理，腾出${storageSizeText(result.freedBytes)}。`
}

export interface StorageCardViewProps {
  reports: StorageReports
  /** 正在做的那一件（useOperation 的 busy）：清理哪一样、打开文件夹。 */
  busy: string
  onOpenWorks: () => void
  onClean: (target: StorageCleanTarget) => void
  /** 「清理旧备份」先弹确认框，由外面开。 */
  onAskBackupCleanup: () => void
  notice?: ReactNode
}

function CleanButton({ target, label, busy, disabled, onClick }: { target: StorageCleanTarget; label: string; busy: string; disabled: boolean; onClick: () => void }) {
  const running = busy === `clean-${target}`
  return (
    <Button size="sm" icon={Trash2} loading={running} disabled={disabled || (Boolean(busy) && !running)} onClick={onClick} testId={`settings-storage-clean-${target}`}>
      {label}
    </Button>
  )
}

/** 按钮灰着时旁边那句小字。 */
function DisabledNote({ text }: { text: string }) {
  return <span className="v2-storage-note">{text}</span>
}

function rowActions(part: StorageUsagePart, report: StorageUsagePartReport | undefined, props: StorageCardViewProps) {
  const { busy } = props
  if (part === 'works') {
    return (
      <Button size="sm" icon={FolderOpen} loading={busy === 'open-works'} disabled={Boolean(busy) && busy !== 'open-works'} onClick={props.onOpenWorks} testId="settings-storage-open-works">
        打开文件夹
      </Button>
    )
  }
  if (part === 'thumbnails') {
    return <CleanButton target="thumbnails" label="清理" busy={busy} disabled={!report || report.bytes === null} onClick={() => props.onClean('thumbnails')} />
  }
  if (part === 'backups') {
    const count = report?.backupCount
    const nothingToClean = typeof count === 'number' && count <= retainedBackups
    return (
      <>
        {nothingToClean && <DisabledNote text={`只有最近 ${retainedBackups} 份，不用清理`} />}
        <CleanButton target="backups" label="清理旧备份" busy={busy} disabled={typeof count !== 'number' || nothingToClean} onClick={props.onAskBackupCleanup} />
      </>
    )
  }
  if (part === 'downloads') {
    const installing = report?.installing === true
    return (
      <>
        {installing && <DisabledNote text="正在装工具，装完再清理" />}
        <CleanButton target="downloads" label="清理" busy={busy} disabled={!report || installing} onClick={() => props.onClean('downloads')} />
      </>
    )
  }
  // 聊天记录、运行日志只列大小，不给删的按钮。
  return null
}

/** 只管画：给什么数就摆什么，测试直接渲染各种状态。 */
export function StorageCardView(props: StorageCardViewProps) {
  return (
    <Card
      title="星芒占用的空间"
      meta="星芒在这台电脑上存了哪些东西、各占多少。清理只删能重新生成或重新下载的东西，作品和聊天记录不会动。"
      padding="none"
      testId="settings-storage"
    >
      <div className="v2-storage-total" data-testid="settings-storage-total">{storageTotalText(props.reports)}</div>
      {props.notice && <div className="v2-storage-notice">{props.notice}</div>}
      {storageRows.map((row) => {
        const report = props.reports[row.part]
        return (
          <ListRow
            key={row.part}
            icon={row.icon}
            title={row.title}
            desc={storageRowDescription(row, report) ?? undefined}
            meta={<span data-testid={`settings-storage-size-${row.part}`}>{storageRowValue(report)}</span>}
            actions={rowActions(row.part, report, props)}
            testId={`settings-storage-row-${row.part}`}
          />
        )
      })}
    </Card>
  )
}

/**
 * 设置 › 备份迁移最下面的「星芒占用的空间」（决定单 D100）。挂上时（客户点开这一组）六行各问一次主进程，
 * 快的先出来；不在后台常驻算。从别的页回来时再算一次。清理完只重算那一行。
 */
export function StorageCard({ api, active, onBackupsCleaned }: {
  api: Pick<V2Bridge, 'inspectStorageUsage' | 'cleanStorage' | 'openDiagnosticFolder'>
  /** 设置页正在眼前；从别的页回来时重算。缺省 = 只在挂上时算。 */
  active?: boolean
  /** 旧备份清掉以后，上面那张「工具配置备份」要重读列表。 */
  onBackupsCleaned?: () => void
}) {
  const [reports, setReports] = useState<StorageReports>({})
  const [askBackups, setAskBackups] = useState(false)
  const latest = useLatestRequest()
  const operation = useOperation()
  const toast = useToast()
  const inspect = useCallback((part: StorageUsagePart, current: () => boolean) => {
    // 包一层：桥上缺这个方法（旧主进程）时同步抛的错也落到「没算出来」，不让整页崩。
    void Promise.resolve()
      .then(() => api.inspectStorageUsage(part))
      .catch((): StorageUsagePartReport => ({ bytes: null }))
      .then((report) => {
        if (current()) setReports((previous) => ({ ...previous, [part]: report }))
      })
  }, [api])
  const inspectAll = useCallback(() => {
    // 重算一遍时先前没回来的全部作废（T6）。
    const current = latest.begin()
    setReports({})
    for (const row of storageRows) inspect(row.part, current)
  }, [inspect, latest])
  useEffect(() => { inspectAll() }, [inspectAll])
  useReloadWhenShown(active, inspectAll)
  function inspectAgain(part: StorageUsagePart) {
    setReports((previous) => {
      const next = { ...previous }
      delete next[part]
      return next
    })
    inspect(part, latest.capture())
  }
  function clean(target: StorageCleanTarget) {
    void operation.execute(
      `clean-${target}`,
      async () => {
        try {
          return await api.cleanStorage(target)
        } finally {
          setAskBackups(false)
          if (target === 'backups') onBackupsCleaned?.()
          inspectAgain(target)
        }
      },
      (result) => {
        if (result.kept === 0) return storageCleanedText(result)
        toast.show(storageCleanedText(result), 'warn')
        return null
      },
    )
  }
  const backupCount = reports.backups?.backupCount ?? 0
  return (
    <>
      <StorageCardView
        reports={reports}
        busy={operation.busy}
        onOpenWorks={() => void operation.execute(
          'open-works',
          async () => {
            if (!(await api.openDiagnosticFolder('ai-output'))) throw new Error(diagnosticFolderUnavailableMessage)
          },
          '',
        )}
        onClean={clean}
        onAskBackupCleanup={() => setAskBackups(true)}
        notice={!askBackups && <ResultNotice error={operation.error} detail={operation.detail} />}
      />
      <Dialog
        open={askBackups}
        title="清理旧备份？"
        onClose={() => setAskBackups(false)}
        testId="settings-storage-backups-dialog"
        footer={
          <>
            <Button onClick={() => setAskBackups(false)}>取消</Button>
            <Button variant="danger" icon={Trash2} loading={operation.busy === 'clean-backups'} onClick={() => clean('backups')} testId="settings-storage-backups-confirm">
              清理
            </Button>
          </>
        }
      >
        <p>只留最近 {retainedBackups} 份，更早的 {Math.max(0, backupCount - retainedBackups)} 份删掉。最近这 {retainedBackups} 份照样能在上面的「工具配置备份」里恢复。</p>
        <ResultNotice error={operation.error} detail={operation.detail} />
      </Dialog>
    </>
  )
}
