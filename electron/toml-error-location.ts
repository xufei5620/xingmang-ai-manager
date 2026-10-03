/**
 * @iarna/toml's message quotes the lines around the failure, and in these
 * files those lines are often `api_key = "..."` or an MCP server's token. The
 * message reaches the screen, the runtime log and the feedback export (I13),
 * so only the row number is kept -- the same reason config-files.ts's
 * requireJson drops V8's. config-files.ts (writing keys) and
 * codex-extensions.ts (Skills and MCP servers) read the same Codex
 * config.toml, so they share this one rule instead of each deciding how much
 * of the parser's text is safe to show.
 */
export function tomlErrorLocation(error: unknown): string {
  const line = error && typeof error === 'object' && 'line' in error ? error.line : null
  return typeof line === 'number' && Number.isInteger(line) && line >= 0 ? `（第 ${line + 1} 行附近）` : ''
}
