import type { CanvasTemplate } from '../templates/template-types'

const assetIdPattern = /^[A-Za-z0-9_-]{43}$/

export type TemplateConfiguratorState = Readonly<Record<string, string>>

export interface TemplateConfiguratorValidation {
  valid: boolean
  errors: Readonly<Record<string, string>>
  values?: Readonly<Record<string, unknown>>
}

export function createTemplateConfiguratorState(template: CanvasTemplate): TemplateConfiguratorState {
  return Object.fromEntries(template.variables.map((variable) => [
    variable.id,
    variable.defaultValue === undefined || variable.defaultValue === null ? '' : String(variable.defaultValue),
  ]))
}

export function validateTemplateConfiguratorState(
  template: CanvasTemplate,
  state: TemplateConfiguratorState,
  availableAssetIds: ReadonlySet<string> = new Set(),
): TemplateConfiguratorValidation {
  const errors: Record<string, string> = {}
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const variable of template.variables) {
    const raw = state[variable.id] ?? ''
    const value = raw.trim()
    if (!value) {
      if (variable.required) errors[variable.id] = '此项为必填'
      continue
    }
    if (variable.type === 'select' && !variable.options?.includes(value)) {
      errors[variable.id] = '请选择列表中的有效选项'
      continue
    }
    if (variable.type === 'asset' && (!assetIdPattern.test(value) || !availableAssetIds.has(value))) {
      errors[variable.id] = '请选择素材库中的有效素材'
      continue
    }
    values[variable.id] = value
  }
  return Object.keys(errors).length > 0 ? { valid: false, errors } : { valid: true, errors, values }
}
