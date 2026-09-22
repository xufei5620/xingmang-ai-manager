import path from 'node:path'
import {
  ensureSafeDataDirectory,
  readSafeUtf8FileSync,
  writeAtomicSafeUtf8File,
} from '../safe-local-data'
import type { PlatformPreferences, PlatformThemePreference } from './contract'

export function isPlatformTheme(
  value: unknown,
): value is PlatformThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function parsePlatformPreferences(value: unknown): PlatformPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('系统界面设置格式无效，请先保留文件再重试。')
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    !isPlatformTheme(record.themePreference) ||
    typeof record.highContrast !== 'boolean'
  )
    throw new Error('系统界面设置版本或字段无法识别，请先保留文件。')
  // 缺的开关按默认值补齐，不当成坏文件：0.2.8 及更早版本写下的文件里没有
  // cliUpdate 这一项，若按「每个键都必须在」来判，老用户升级后连主题都读不出来。
  // 值不是布尔仍然拒绝——那才是真被改坏了。
  const booleanRecord = <K extends string>(
    candidate: unknown,
    defaults: Record<K, boolean>,
  ): Record<K, boolean> | undefined => {
    if (candidate === undefined) return undefined
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new Error('系统偏好设置格式无效。')
    const fields = candidate as Record<string, unknown>
    const keys = Object.keys(defaults) as K[]
    if (
      !keys.every(
        (key) => fields[key] === undefined || typeof fields[key] === 'boolean',
      )
    )
      throw new Error('系统偏好开关值无法识别。')
    return Object.fromEntries(
      keys.map((key) => [key, fields[key] ?? defaults[key]]),
    ) as Record<K, boolean>
  }
  const notifications = booleanRecord(record.notifications, {
    install: true,
    balance: true,
    task: true,
    cliUpdate: true,
    acceleration: true,
  })
  // 老文件里的 crashReports 会在这里被丢掉：键不在清单里就不会被读出，
  // 下一次写入自然不再落盘，不需要单独的迁移步骤。
  const privacy = booleanRecord(record.privacy, { anonymousUsage: false })
  return {
    version: 1,
    themePreference: record.themePreference,
    highContrast: record.highContrast,
    ...(notifications ? { notifications } : {}),
    ...(privacy ? { privacy } : {}),
  }
}

export interface PlatformPreferenceStore {
  read(): PlatformPreferences
  update(
    patch: Partial<Omit<PlatformPreferences, 'version'>>,
  ): Promise<PlatformPreferences>
}

export class PlatformSettingsStore implements PlatformPreferenceStore {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly filename: string,
    private readonly fallbackTheme: PlatformThemePreference = 'system',
  ) {}

  read(): PlatformPreferences {
    const source = readSafeUtf8FileSync(
      this.filename,
      '系统界面设置',
      16 * 1024,
    )
    if (source === null)
      return {
        version: 1,
        themePreference: this.fallbackTheme,
        highContrast: false,
      }
    try {
      return parsePlatformPreferences(JSON.parse(source))
    } catch (error) {
      throw new Error(
        error instanceof SyntaxError
          ? '系统界面设置无法读取，原文件已保留。'
          : error instanceof Error
            ? error.message
            : '系统界面设置无法读取。',
      )
    }
  }

  update(patch: Partial<Omit<PlatformPreferences, 'version'>>) {
    const task = this.tail
      .catch(() => undefined)
      .then(async () => {
        const next = parsePlatformPreferences({ ...this.read(), ...patch })
        ensureSafeDataDirectory(path.dirname(this.filename), '系统界面设置目录')
        await writeAtomicSafeUtf8File(
          this.filename,
          JSON.stringify(next, null, 2) + '\n',
          '系统界面设置',
        )
        return next
      })
    this.tail = task
    return task
  }
}
