// 记录页和扩展三页各在自己的文件里（#1070 第 11 步，原样搬出）：记录页 features/sessions/SessionsPage.tsx，
// 外接工具、技能、插件三页 features/extensions/ExtensionsPage.tsx；扩展三页和「星芒精选」页共用的判断、解析和卡片
// 在 features/extensions/extensions-common.tsx，记录页和扩展页共用的工具选单在 features/tools/provider-options.ts。
// 这里只转出，原来从这里 import 的地方不用改。
// ExtensionsPage 排在最前：它经 pages-maintenance 先带进教程页那几份样式，再带进 extensions.css，业务页那份样式表里
// 两者的先后跟拆之前一样（排反了样式表会换个次序）。
export { ExtensionsPage } from './features/extensions/ExtensionsPage'
export type {
  CodexExtensionMetadata,
  ExtensionGroup,
  ExtensionRowState,
  ExtensionToolChoice,
  McpRuntimeNotice,
} from './features/extensions/extensions-common'
export {
  CuratedDetails,
  CuratedShelf,
  ExtensionCard,
  ExtensionToolPicker,
  curatedIcon,
  curatedRuntimeCommand,
  curatedTags,
  curatedVersionText,
  customMcpProblem,
  extensionFailureTarget,
  extensionFormOffersProject,
  extensionInstallNeedsTrust,
  extensionItemsForView,
  extensionMutationScope,
  extensionNoToolInstalled,
  extensionRowState,
  extensionScopeLabel,
  extensionShowsUpdatePill,
  extensionToolChoices,
  extensionToolName,
  extensionToolNames,
  extensionUpdateStatus,
  extensionUsableTools,
  fillCuratedPlaceholders,
  filterExtensionMarkets,
  findNativeSkill,
  groupExtensionItems,
  mcpCommandRuntime,
  mcpAuthorized,
  mcpHealthView,
  mcpNamesInScope,
  mcpNeedsLogin,
  mcpRuntimeNotice,
  officialMarketplaceNotice,
  parseCommandArguments,
  parseEnvironmentVariables,
  preferredExtensionProvider,
  readCodexExtensionMetadata,
  runExtensionAction,
  submitMcpInstall,
  unresolvedInstallPlaceholders,
} from './features/extensions/extensions-common'
export { SessionsPage, sessionRowMeta, sessionToolCounts } from './features/sessions/SessionsPage'
