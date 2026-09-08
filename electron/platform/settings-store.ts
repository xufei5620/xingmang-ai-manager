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
  const booleanRecord = <K extends string>(
    candidate: unknown,
    keys: readonly K[],
  ): Record<K, boolean> | undefined => {
    if (candidate === undefined) return undefined
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new Error('系统偏好设置格式无效。')
    const fields = candidate as Record<string, unknown>
    if (!keys.every((key) => typeof fields[key] === 'boolean'))
      throw new Error('系统偏好开关值无法识别。')
    return Object.fromEntries(keys.map((key) => [key, fields[key]])) as Record<
      K,
      boolean
    >
  }
  const notifications = booleanRecord(record.notifications, [
    'install',
    'balance',
    'task',
  ])
  const privacy = booleanRecord(record.privacy, [
    'crashReports',
    'anonymousUsage',
  ])
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
