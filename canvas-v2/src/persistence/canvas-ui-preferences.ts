export const canvasUiPreferencesVersion = 1 as const

export type CanvasRightPanel = 'assets' | 'runs' | null

export interface CanvasUiPreferences {
  version: typeof canvasUiPreferencesVersion
  libraryCollapsed: boolean
  focusMode: boolean
  rightPanel: CanvasRightPanel
  minimapOpen: boolean
}

export interface CanvasUiPreferencesStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const defaultCanvasUiPreferences: CanvasUiPreferences = {
  version: canvasUiPreferencesVersion,
  libraryCollapsed: true,
  focusMode: false,
  rightPanel: null,
  minimapOpen: false,
}

/** Opening a project always starts with the node library as a rail. Expanding
 *  it during the session still writes back; the next launch collapses again. */
export function canvasStartupUiPreferences(stored: CanvasUiPreferences): CanvasUiPreferences {
  return { ...stored, libraryCollapsed: true }
}

const projectIdPattern = /^[a-f0-9-]{36}$/i
const storagePrefix = 'xingmang.canvas.ui.'

function storageKey(projectId: string): string | null {
  return projectIdPattern.test(projectId) ? `${storagePrefix}${projectId}` : null
}

function storageOrNull(storage?: CanvasUiPreferencesStorage): CanvasUiPreferencesStorage | null {
  if (storage) return storage
  try {
    return typeof window === 'undefined' || !window.localStorage ? null : window.localStorage
  } catch {
    return null
  }
}

function normalizePreferences(value: unknown): CanvasUiPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaultCanvasUiPreferences }
  const raw = value as Partial<CanvasUiPreferences>
  return {
    version: canvasUiPreferencesVersion,
    libraryCollapsed: raw.libraryCollapsed === true,
    focusMode: raw.focusMode === true,
    rightPanel: raw.rightPanel === 'assets' || raw.rightPanel === 'runs' ? raw.rightPanel : null,
    minimapOpen: raw.minimapOpen === true,
  }
}

function parseStoredPreferences(value: unknown): CanvasUiPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaultCanvasUiPreferences }
  // The version field only earns its place if reads enforce it. An unrecognized
  // version means some other build wrote this payload, so the meaning of its
  // fields cannot be assumed — fall back rather than reinterpret them.
  if ((value as Partial<CanvasUiPreferences>).version !== canvasUiPreferencesVersion) {
    return { ...defaultCanvasUiPreferences }
  }
  return normalizePreferences(value)
}

export function readCanvasUiPreferences(
  projectId: string,
  storage?: CanvasUiPreferencesStorage,
): CanvasUiPreferences {
  const key = storageKey(projectId)
  const target = storageOrNull(storage)
  if (!key || !target) return { ...defaultCanvasUiPreferences }
  try {
    const content = target.getItem(key)
    if (!content) return { ...defaultCanvasUiPreferences }
    return parseStoredPreferences(JSON.parse(content))
  } catch {
    return { ...defaultCanvasUiPreferences }
  }
}

export function writeCanvasUiPreferences(
  projectId: string,
  preferences: CanvasUiPreferences,
  storage?: CanvasUiPreferencesStorage,
): void {
  const key = storageKey(projectId)
  const target = storageOrNull(storage)
  if (!key || !target) return
  try {
    target.setItem(key, JSON.stringify(normalizePreferences(preferences)))
  } catch {
    // UI preferences are an enhancement. Storage quota and private-window
    // failures must never block opening or saving a project.
  }
}
