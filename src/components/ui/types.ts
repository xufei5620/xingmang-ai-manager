import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export type UiSize = 'md' | 'sm' | 'xs'
export type UiTone = 'neutral' | 'accent' | 'info' | 'ok' | 'warn' | 'bad'
export type UiSkin = 'dawn' | 'obsidian' | 'mist' | 'aurora'

export interface UiOption<T extends string = string> {
  value: T
  label: ReactNode
  icon?: LucideIcon
  disabled?: boolean
}

export const UI_SKINS: ReadonlyArray<{ value: UiSkin; label: string }> = [
  { value: 'dawn', label: '晨曦金' },
  { value: 'obsidian', label: '极夜黑金' },
  { value: 'mist', label: '雾青' },
  { value: 'aurora', label: '极光紫' },
]

export function resolveUiSkin(theme: 'light' | 'dark', skin?: UiSkin | 'auto'): UiSkin {
  return skin && skin !== 'auto' ? skin : theme === 'dark' ? 'obsidian' : 'dawn'
}

export function adjacentOption<T extends string>(
  options: ReadonlyArray<UiOption<T>>,
  current: T,
  key: string,
  orientation: 'horizontal' | 'vertical' = 'horizontal',
): T | null {
  const available = options.filter((option) => !option.disabled)
  if (!available.length) return null
  if (key === 'Home') return available[0].value
  if (key === 'End') return available[available.length - 1].value
  const previous = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp'
  const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown'
  if (key !== previous && key !== next) return null
  const index = available.findIndex((option) => option.value === current)
  if (index < 0) return key === previous ? available[available.length - 1].value : available[0].value
  return available[(index + (key === next ? 1 : -1) + available.length) % available.length].value
}
