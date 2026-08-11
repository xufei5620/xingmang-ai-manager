export type ConfigModelDetectionSource =
  | { kind: 'typed'; apiKey: string }
  | { kind: 'configured' }

/**
 * A newly typed key must be validated as entered. Otherwise an existing CLI
 * config can be inspected entirely in the main process without revealing its
 * key to the renderer merely to refresh the model picker.
 */
export function resolveConfigModelDetectionSource(
  rawApiKey: string,
  hasSavedApiKey: boolean,
): ConfigModelDetectionSource | null {
  const apiKey = rawApiKey.trim()
  if (apiKey) return { kind: 'typed', apiKey }
  return hasSavedApiKey ? { kind: 'configured' } : null
}
