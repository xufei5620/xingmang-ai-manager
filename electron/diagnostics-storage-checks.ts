// 一键检测里「磁盘与文件夹」那几项（#1070 第 9 步，从 diagnostics.ts 的 runDiagnostics 原样搬来）：磁盘空间（工具安装
// 目录、软件数据目录所在的盘还剩多少）、「文档」文件夹能不能写（只在 Windows 上查）、AI 作品保存位置、加速功能用的
// 文件是否完好、文件夹位置（用户文件夹、软件数据文件夹、各家工具的配置文件夹有没有被「C 盘搬家」一类的工具挪走）。
//
// 各类检查共用的那份在 diagnostics-context.ts；这里只 import diagnostics.ts 的类型，免得两个文件互相 require。
import path from 'node:path'
import { activeProviderIds, cliCatalog, providerConfigDirectoryNames } from './catalog'
import type { CheckDefinition, CheckOutcome, DiagnosticsDependencies, DiagnosticState } from './diagnostics'
import { errorChainText, type DiagnosticsContext } from './diagnostics-context'
import { pathForDisplay } from './diagnostics-redaction'
import {
  formatFreeSpace,
  installMinimumFreeBytes,
  lowDiskSpaceBytes,
  mergeSameDeviceReadings,
  readDiskSpace,
  type DiskSpaceReading,
} from './disk-space'
import { inspectDocumentsWritability, type DocumentsWritability } from './documents-fallback'
import { managedCliRoot } from './managed-cli-paths'
import { resolveRelocatedPath } from './relocated-folders'
import { findReparseComponent, type ReparseComponent } from './safe-local-data'

const accelerationBundleDamagedSummary = '加速用的文件被删掉或改动了，多半是杀毒软件拦的。'
  + '打开杀毒软件的「隔离区」或「恢复区」把星芒的文件恢复，并把星芒加入信任；也可以重新安装一次星芒，装在原来的位置就行。'

/**
 * 「磁盘空间」这一项只看两处：CLI 落点（托管目录）和软件数据目录。托管目录在
 * Windows 上要有可信的 ProgramData 才算得出来，算不出就不看这一处；软件数据目录
 * 由宿主给出（诊断自己算不出 Electron 的 userData 在哪）。
 */
function resolveDiskSpaceTargets(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  userDataDirectory?: string,
): readonly { label: string, path: string }[] {
  const targets: { label: string, path: string }[] = []
  try {
    targets.push({ label: '工具安装目录', path: managedCliRoot(env, platform) })
  } catch {
    // 托管目录都算不出来的机器上装不了工具，这一项也就无从说起。
  }
  if (userDataDirectory?.trim()) targets.push({ label: '软件数据目录', path: userDataDirectory })
  return targets
}

export interface RelocatedFolderTarget {
  label: string
  path: string
}

export interface RelocatedFolderFinding {
  /** 被重定向的那一级，已按原样给出。 */
  component: string
  /** 它实际指向哪里；读不出来时为 null。 */
  target: string | null
  /** 受影响的文件夹（去重后按出现顺序）。 */
  labels: string[]
}

/**
 * 搬过去的位置多半带着用户名（D:\Users\alice），而报告的脱敏只认原来的用户目录，
 * 认不出它。客服要知道的只是「搬到了哪块盘」，所以只说盘，不写整条路径。
 */
export function describeRelocationTarget(target: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const drive = /^(?:\\\\[?.]\\)?([A-Za-z]):/.exec(target)?.[1]
    if (drive) return ` ${drive.toUpperCase()} 盘`
    return target.startsWith('\\\\') ? '另一台电脑的共享文件夹' : '别的位置'
  }
  const volume = /^\/Volumes\/([^/]+)/.exec(target)?.[1]
  return volume ? `外接磁盘「${volume}」` : '别的位置'
}

/**
 * 同一级被重定向时（最常见的是整个用户文件夹被搬走），下面几个文件夹全受牵连，
 * 按那一级合并成一条，免得用户读到四遍同一件事。
 */
export function findRelocatedFolders(
  targets: readonly RelocatedFolderTarget[],
  find: (target: string) => ReparseComponent | null,
): RelocatedFolderFinding[] {
  const findings: RelocatedFolderFinding[] = []
  for (const entry of targets) {
    let found: ReparseComponent | null
    try {
      found = find(entry.path)
    } catch {
      continue
    }
    if (!found) continue
    const existing = findings.find((finding) => finding.component === found.component)
    if (existing) {
      if (!existing.labels.includes(entry.label)) existing.labels.push(entry.label)
      continue
    }
    findings.push({ component: found.component, target: found.target, labels: [entry.label] })
  }
  return findings
}

function relocatedFolderTargets(
  userHome: string,
  codexHome: string,
  userDataDirectory: string | undefined,
): RelocatedFolderTarget[] {
  const targets: RelocatedFolderTarget[] = [{ label: '用户文件夹', path: userHome }]
  if (userDataDirectory?.trim()) targets.push({ label: '软件数据文件夹', path: userDataDirectory })
  for (const provider of activeProviderIds) {
    targets.push({
      label: `${cliCatalog[provider].name} 配置文件夹`,
      path: provider === 'codex' ? codexHome : path.join(userHome, providerConfigDirectoryNames[provider]),
    })
  }
  return targets
}

export function documentsWritabilityOutcome(
  result: DocumentsWritability,
  log: DiagnosticsDependencies['log'],
  sanitizeText: (value: string) => string,
): CheckOutcome {
  if (result.state === 'writable') {
    return { state: 'pass', summary: '能正常写入，新项目和 AI 作品放在「文档」里' }
  }
  if (result.state === 'not-used') {
    return {
      state: 'pass',
      summary: result.why === 'cloud'
        ? '「文档」在 OneDrive 同步里，新项目和 AI 作品放在个人文件夹里，免得拖慢电脑'
        : '没找到「文档」文件夹，新项目和 AI 作品放在个人文件夹里',
    }
  }
  // 原因原文（EPERM 之类，带着路径）只进日志，报告里只有中文结论。
  log?.('warn', 'diagnostics.documents.unwritable', '「文档」文件夹写不进去', {
    kind: result.state,
    raw: sanitizeText(result.reason),
  })
  if (result.state === 'denied') {
    return {
      state: 'warn',
      summary: '「文档」文件夹不让本软件写入，常见原因是 Windows 安全中心开了「受控文件夹访问」，'
        + '或者安全软件开了文档保护。新建的项目和 AI 作品已经改放在个人文件夹里，照常能用。',
      details: { openFolder: 'projects' },
    }
  }
  return {
    state: 'warn',
    summary: '「文档」文件夹这次没写进去，可能是磁盘满了或者文件夹是只读的。'
      + '新建项目和保存 AI 作品可能会失败，清理一些空间后再点「重新检测」。',
  }
}

export function buildStorageChecks(context: DiagnosticsContext): CheckDefinition[] {
  const { dependencies, env, userHome, codexHome, displayRoots, platform, sanitize, log } = context
  const probeDiskSpace = dependencies.readDiskSpace ?? readDiskSpace
  const probeAiOutput = dependencies.probeAiOutput
  const diskSpaceTargets = resolveDiskSpaceTargets(env, platform, dependencies.userDataDirectory)

  return [
    {
      // 8G 内存的机器通常也是 128/256G 的小硬盘，C 盘剩几百兆很常见，而装一个
      // CLI 的峰值要两份空间（临时目录装完整份再原子替换）。装到一半才报
      // ENOSPC 是最难受的失败方式，所以这一项的用处是「还没出事先说一声」。
      code: 'DISK_SPACE',
      title: '磁盘空间',
      run: async () => {
        const readings = mergeSameDeviceReadings(
          (await Promise.all(diskSpaceTargets.map(async (entry) => {
            const reading = await probeDiskSpace(entry.path)
            return reading ? { ...entry, reading } : null
          })))
            .filter((entry): entry is { label: string, path: string, reading: DiskSpaceReading } => entry !== null)
            .map((entry) => ({ ...entry.reading, label: entry.label })),
        )
        // 读不到不算失败：网络盘、交接点上 statfs 本来就可能不给数字，为此报一
        // 条待处理只会让人去修一个没坏的东西。
        if (!readings.length) {
          return {
            state: 'warn',
            summary: '未能读取磁盘剩余空间，这一项这次跳过',
            details: { measured: 0 },
          }
        }
        const tightest = readings.reduce(
          (left, right) => (right.availableBytes < left.availableBytes ? right : left),
        )
        const state: DiagnosticState = tightest.availableBytes < installMinimumFreeBytes
          ? 'fail'
          : tightest.availableBytes < lowDiskSpaceBytes ? 'warn' : 'pass'
        const summary = readings
          .map((reading) => `${reading.label}所在磁盘剩余 ${formatFreeSpace(reading.availableBytes)}`)
          .join('；')
        const details: Record<string, boolean | number | string | null> = { measured: readings.length }
        for (const [index, reading] of readings.entries()) {
          details[`disk${index + 1}`] = `${reading.label}：${formatFreeSpace(reading.availableBytes)} / `
            + `${formatFreeSpace(reading.totalBytes)}`
          details[`path${index + 1}`] = pathForDisplay(reading.measuredPath, displayRoots)
        }
        return {
          state,
          summary: state === 'fail'
            ? `${summary}，已经装不下新工具了，请清理后再安装或更新`
            : state === 'warn'
              ? `${summary}，空间偏紧，安装或更新工具前建议先清理一些`
              : summary,
          details,
        }
      },
    },
    // 受控文件夹访问、安全软件的文档保护会让「文档」只读，新项目和 AI 作品默认都在
    // 它下面。只在 Windows 上查：Mac 的新项目本来就放个人文件夹（#587），往「文稿」里
    // 试写还会平白弹一次系统的访问询问。
    ...(platform === 'win32' && dependencies.documentsDirectory !== undefined ? [{
      code: 'DOCUMENTS_WRITABLE',
      title: '「文档」文件夹能不能写',
      run: (): CheckOutcome => {
        const inspect = dependencies.inspectDocuments ?? inspectDocumentsWritability
        const result = inspect(dependencies.documentsDirectory ?? null, { platform, home: userHome, env })
        return documentsWritabilityOutcome(result, log, sanitize)
      },
    }] : []),
    // 写不进时生成前就会拦下、不会扣费，而且只影响用 AI 生图、生视频的人，所以这里
    // 标「需留意」而不是「待处理」：不为它在每次开机时弹提示，检查页照实标黄。
    ...(probeAiOutput ? [{
      code: 'AI_OUTPUT',
      title: 'AI 作品保存位置',
      run: async (): Promise<CheckOutcome> => {
        try {
          await probeAiOutput()
        } catch (error) {
          log?.('warn', 'diagnostics.ai-output.unwritable', 'AI 作品保存位置写不进去', {
            raw: sanitize(errorChainText(error)),
          })
          return {
            state: 'warn',
            summary: '保存位置写不进去。用 AI 生成图片或视频时，软件会在扣费前先拦下来；'
              + '可以在画布里新建一个项目、给它选一个自己的文件夹，在那里生成就能存下来。',
          }
        }
        const placement = dependencies.aiOutputPlacement?.() ?? null
        if (placement?.movedFromDocuments) {
          return {
            state: 'pass',
            summary: '「文档」文件夹不让写，AI 生成的图片和视频改存在个人文件夹里的 XingmangAI'
              + (placement.earlierWorksLeftInDocuments ? '。以前的作品还在「文档」里的 XingmangAI，没有搬动' : ''),
            details: { openFolder: 'ai-output' },
          }
        }
        // Mac 的访达里这个文件夹叫「文稿」，开关叫「桌面与文稿」，所以那边写「文稿」。
        if (placement?.earlierWorksLeftInSyncedDocuments) {
          const [folder, cloud] = placement.earlierWorksLeftInSyncedDocuments === 'icloud' ? ['文稿', 'iCloud'] : ['文档', 'OneDrive']
          return {
            state: 'pass',
            summary: `AI 生成的图片和视频能正常保存。「${folder}」开了 ${cloud} 同步，新作品改存在个人文件夹里的 XingmangAI；`
              + `以前的作品还在「${folder}」里的 XingmangAI，没有丢，也没有搬动`,
            details: { openFolder: 'ai-output' },
          }
        }
        return { state: 'pass', summary: 'AI 生成的图片和视频能正常保存' }
      },
    }] : []),
    // 杀毒软件隔离了加速内核时，加速页以前只写「线路准备中」，客户会一直等下去。
    // 这里说同一句话；读文件是启动时做的，这一项只报告结果、不再读一遍几十 MB 的内核。
    // 标黄不标红（同 AI_OUTPUT）：只影响用加速的人，不为它在每次开机时弹「需要处理」。
    ...(dependencies.accelerationBundle ? [{
      code: 'ACCELERATION_BUNDLE',
      title: '加速功能',
      run: (): CheckOutcome => dependencies.accelerationBundle === 'damaged'
        ? { state: 'warn', summary: accelerationBundleDamagedSummary }
        : { state: 'pass', summary: '加速用的文件完好' },
    }] : []),
    {
      // 「C 盘搬家」工具或 mklink /J 把用户文件夹、软件数据文件夹挪到别的盘之后，
      // 路径上多出一级目录联接。普通权限运行时，用户文件夹里、搬到本机硬盘的联接
      // 会被跟过去读写（relocated-folders.ts），这一项只报告一句「搬到了哪」；
      // 仍被写入校验（I8）拒绝的（管理员身份运行、网络盘、共享位置）才算失败。
      code: 'FOLDER_RELOCATED',
      title: '文件夹位置',
      run: (): CheckOutcome => {
        const find = dependencies.findReparseComponent ?? findReparseComponent
        const resolveRelocated = dependencies.resolveRelocatedPath ?? resolveRelocatedPath
        const targets = relocatedFolderTargets(userHome, codexHome, dependencies.userDataDirectory)
        const relocated = findRelocatedFolders(targets, find)
        if (!relocated.length) {
          return {
            state: 'pass',
            summary: '软件要用到的文件夹都在原来的位置',
            details: { relocated: 0 },
          }
        }
        const findings = findRelocatedFolders(targets, (target) => find(resolveRelocated(target)))
        if (!findings.length) {
          const moved = relocated.map((finding) => `${finding.labels.join('、')}${finding.target
            ? `在${describeRelocationTarget(finding.target, platform)}`
            : '在别的位置'}`)
          return {
            state: 'pass',
            summary: `${moved.join('；')}，软件会跟过去读写，能正常使用`,
            details: { relocated: relocated.length, followed: true },
          }
        }
        const elevated = platform === 'win32' && dependencies.windowsExecution?.mode === 'trusted-only'
        const described = findings.map((finding) => `${finding.labels.join('、')}${finding.target
          ? `被搬到了${describeRelocationTarget(finding.target, platform)}`
          : '被搬走了，但读不出它现在在哪里'}`)
        const hint = platform === 'win32' ? '（常见于用过「C 盘搬家」一类的工具）' : ''
        const details: Record<string, boolean | number | string | null> = { relocated: findings.length }
        for (const [index, finding] of findings.entries()) {
          details[`folder${index + 1}`] = finding.labels.join('、')
          details[`from${index + 1}`] = finding.component
          details[`to${index + 1}`] = finding.target ? describeRelocationTarget(finding.target, platform).trim() : null
        }
        if (elevated) details.elevated = true
        return {
          state: 'fail',
          summary: elevated
            ? `${described.join('；')}${hint}。软件现在是用管理员身份运行的，为了安全不往被搬过的文件夹里写东西，`
              + '所以写入 Key、保存设置、记录日志都可能失败。关掉软件，直接双击打开（不要选「以管理员身份运行」）就能恢复'
            : `${described.join('；')}${hint}。为了安全，软件不往被搬过的文件夹里写东西，`
              + '所以写入 Key、保存设置、记录日志都可能失败。把文件夹搬回原来的位置就能恢复；'
              + '搬不回来请在「反馈与客服」页导出报告发给客服',
          details,
        }
      },
    },
  ]
}
