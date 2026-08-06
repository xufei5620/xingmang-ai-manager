export function localPathForDisplay(value: string | null | undefined): string {
  if (!value) return ''

  const windowsHome = value.match(/^([A-Za-z]:[\\/]Users[\\/])[^\\/]+(?<suffix>[\\/].*)?$/i)
  if (windowsHome) {
    const suffix = (windowsHome.groups?.suffix ?? '').replaceAll('/', '\\')
    const roaming = suffix.match(/^\\AppData\\Roaming(?<rest>\\.*)?$/i)
    if (roaming) return `%APPDATA%${roaming.groups?.rest ?? ''}`
    const local = suffix.match(/^\\AppData\\Local(?<rest>\\.*)?$/i)
    if (local) return `%LOCALAPPDATA%${local.groups?.rest ?? ''}`
    return `%USERPROFILE%${suffix}`
  }

  const posixHome = value.match(/^\/(?:Users|home)\/[^/]+(?<suffix>\/.*)?$/)
  if (posixHome) return `~${posixHome.groups?.suffix ?? ''}`
  return value
}
