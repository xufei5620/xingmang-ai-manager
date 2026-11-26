import type { PageId } from './pages';
import { cliTutorialTopic, macDesktopTutorialTopic, macRuntimeTutorialTopic, phoneRemoteTutorialTopic, updatesTutorialTopic, type accountTabs, type FeedbackTabValue, type settingsGroups } from './business';
import { errors } from './errors';
import { statuses } from './status';
import { firstRunHints } from './tools';
import { runtimeButtonLabel, runtimeHomebrewCommand } from '../features/tools/runtime-install-guide';
import type { WindowOs } from '../features/app/window-os';
import { gitLinuxInstallCommand } from '../../../electron/git-runtime';

export type TutorialIllustrationId = 'desktop-home' | 'desktop-install' | 'desktop-config' | 'desktop-project' | 'desktop-message' | 'home' | 'account' | 'install' | 'config' | 'launch' | 'chat' | 'canvas' | 'extensions' | 'skills' | 'plugins' | 'backup' | 'health';

/**
 * 备份、更新并进设置以后（v4 批09），教程直接落到那一行：外壳打开它那一组、
 * 再翻到那一行，比只落到组上少找一次。行的 id 在 business.ts 的 settingsItems 里是 string，
 * 这里只收教程真用到的几个，写错照样编译不过；tutorials.test.ts 核对它们都登记过。
 * 网络加速那一章 2026-10-30 随加速下线去掉了。
 */
type TutorialSettingsRow = 'backups' | 'version';

/**
 * 按钮落到哪一页、哪个分页。个人中心和设置里分页很多，只跳页会停在默认的
 * 「我的账号」「外观显示」（或上次看的那页），用户还得自己再找一遍（全面检测 Q48）。
 * section 按页收窄类型：给首页写分页、把设置分组写到个人中心上都编译不过。
 */
export type TutorialStepTarget =
  | { page: 'account'; section?: (typeof accountTabs)[number]['value'] }
  | { page: 'settings'; section?: (typeof settingsGroups)[number]['value'] | TutorialSettingsRow }
  | { page: 'feedback'; section?: FeedbackTabValue }
  | { page: Exclude<PageId, 'account' | 'settings' | 'feedback'>; section?: never };

interface TutorialStepContent {
  title: string;
  detail: string;
  where?: string;
  bullets?: readonly string[];
  expected?: string;
  tip?: string;
  example?: string;
  illustration?: TutorialIllustrationId;
  extra?: readonly { title: string; detail: string }[];
  action: string;
}

export type TutorialStep = TutorialStepContent & TutorialStepTarget;

// 教程页的分类按钮（v4 问8 选「卡片」）。「全部」不是分类，只是不筛；每一篇必须落在后四类之一。
export const tutorialCategories = [
  { value: 'all', label: '全部' },
  { value: 'start', label: '入门' },
  { value: 'tools', label: '工具' },
  { value: 'account', label: '账号与费用' },
  { value: 'trouble', label: '出问题时' },
] as const;
export type TutorialCategoryFilter = (typeof tutorialCategories)[number]['value'];
export type TutorialCategory = Exclude<TutorialCategoryFilter, 'all'>;

export interface TutorialTopic {
  id: string;
  title: string;
  lead: string;
  category: TutorialCategory;
  minutes: number;
  keywords: readonly string[];
  steps: readonly TutorialStep[];
  reminders?: readonly string[];
}

// 自签证书没有苹果团队号，钥匙串只能按每一版程序自己的指纹认人，所以 Mac 上每换
// 一个版本，第一次读本机加密的登录信息都会弹一次「登录」钥匙串密码框。代码绕不开，
// 只能提前告诉客户该怎么点：点「拒绝」看上去像被退出登录，客户会以为更新坏了。
export const macKeychainTutorialTitle = 'Mac 更新后弹出钥匙串密码框？';
export const macKeychainTutorialDetail = 'Mac 上更新后首次打开，系统可能提示「星芒AI管理工具」要使用钥匙串中「xingmang-ai-manager Safe Storage」的信息。这是星芒在读取本机保存的登录信息：请输入本机开机密码并点击「始终允许」，更新后通常仅提示一次。如点击「拒绝」，将视同退出登录，下次打开时会再次提示。Windows 不会出现此提示。';

// 「设置 › 版本更新」里「磁盘空间不够」那条提示的「查看清理方法」展开的就是这段。只讲点哪里、删什么，不出现
// 缓存、临时目录这类词；删之前先看清楚是什么，别让客户把项目文件清掉。
export const updateDiskCleanupTitle = '磁盘空间不足导致无法下载更新？';
// 清理步骤单独导出：「必须更新」那层门里也用它，但门里进不了「设置 › 版本更新」，收尾那句换成门自己的按钮。
export const updateDiskCleanupSteps = 'Windows：打开「设置 → 系统 → 存储」，点击「临时文件」，勾选「回收站」「临时文件」「Windows 更新清理」后点击「删除文件」；再将「下载」「桌面」中不需要的大文件移至其他磁盘或 U 盘。Mac：点击左上角苹果标志 →「系统设置 → 通用 → 储存空间」，按建议清理并清空废纸篓。请勿删除项目文件夹。';
export const updateDiskCleanupDetail = `${updateDiskCleanupSteps}清出空间后，「自动下载更新」开着会自己下载，关着就到「设置 › 版本更新」点「下载更新」。`;
// Linux 各家桌面的设置页不一样，只说每台都有的「文件」和回收站。
export const linuxUpdateDiskCleanupSteps = '打开「文件」（文件管理器），清空「回收站」，再删除「下载」「桌面」中不需要的大文件，或移至 U 盘。请勿删除项目文件夹。';

export function updateDiskCleanupStepsFor(os: WindowOs): string {
  return os === 'linux' ? linuxUpdateDiskCleanupSteps : updateDiskCleanupSteps;
}

// 第一章的登录这一步和读完的两句提醒，Windows / Mac 版和 Linux 版共用。
const signInTutorialStep: TutorialStep = {
  title: '登录星芒账号',
  where: '星芒左下角 › 账号',
  detail: '使用您的星芒账号登录。如左下角已显示账号名称，请直接查看第 2 步。',
  bullets: ['点左下角账号区域，输入账号和密码。', '如无账号，请通过登录窗口中的注册入口注册。'],
  expected: '左下角显示您的账号名称。',
  illustration: 'account',
  action: '打开个人中心',
  page: 'account',
};
const firstUseReminders = ['AI 生成的代码和结论都可能出错，合并或执行前请自行复核。', '粘贴来源不明的网页、文档或日志时请注意，其中可能包含诱导 AI 执行其他操作的指令。'] as const;

export const tutorialTopics: readonly TutorialTopic[] = [
  {
    id: 'start',
    title: '首次使用？请按以下 4 步操作',
    lead: '星芒将为您安装并配置 Codex 桌面端。按以下步骤操作，最后在 Codex 窗口中发送第一条消息。',
    category: 'start',
    minutes: 5,
    keywords: ['新手', '入门', '第一次', '不会用', '安装', '登录', '首页', 'Codex', '桌面端', '图形界面'],
    steps: [
      signInTutorialStep,
      {
        title: '安装 Codex 桌面端',
        where: '星芒首页 › Codex 桌面端',
        detail: '找到「Codex 桌面端」卡片。如已显示版本号，无需重复安装。',
        bullets: ['Windows：点「安装」，等进度结束。', 'Mac：同样点击「安装」，等待进度完成；安装后在「应用程序」中名为 ChatGPT。'],
        expected: 'Codex 桌面端显示已安装版本。',
        illustration: 'desktop-install',
        extra: [{ title: '安装报错怎么办？', detail: 'Windows 安装报错时请按提示处理，详细步骤见「Codex 桌面端怎么安装？」。Mac 一键安装失败时，也可按「Mac 上装桌面端」一章从官网下载安装。桌面端无需预先安装 Codex CLI、Node.js 或 Python。' }, { title: '装的时候能走开吗？', detail: '可以。安装工具、安装 Codex 桌面端及下载新版本期间，电脑不会自动睡眠（屏幕仍按您的设置关闭），完成后恢复原有睡眠设置。合上笔记本盖子仍会睡眠，请勿合盖。' }],
        action: '去首页找 Codex 桌面端',
        page: 'home',
      },
      {
        title: '看到「当前账号」就继续',
        where: '星芒首页 › Codex 桌面端卡片 › 左下角',
        detail: '星芒通常会自动配好。卡片左下角写着「当前账号」就看第 4 步；写着「待连接」时，才需要下面的操作。',
        bullets: ['点卡片上的「确认连接」，选择「当前账号」。', '如需准备密钥，请选择「自动准备（推荐）」；密钥是工具调用 AI 时使用的凭证。', '点击「保存并检测」，完成后点击「完成」；您在工具中的其他设置将保持不变。'],
        expected: 'Codex 桌面端卡片左下角显示「当前账号」。',
        illustration: 'desktop-config',
        extra: [{ title: '配置失败怎么办？', detail: '提示账号信息或密钥读取失败时，请先点击「刷新密钥」，读取成功后再保存；自动准备将先使用默认模型。如已有密钥或需更换模型，详见「Codex 怎么连接账号、换模型？」。' }],
        action: '去首页看是否已连好',
        page: 'home',
      },
      {
        title: '打开 Codex 并发送第一条消息',
        where: '星芒首页 › Codex 桌面端「打开」→ Codex 对话框',
        detail: '点击「打开」，后续操作在新打开的 Codex 窗口中完成。先提一个简单问题，无需选择文件夹。',
        bullets: ['在窗口左侧栏最上面把模式切到「Codex」，再开始新对话（英文界面可能写 New chat）。', '请勿在「ChatGPT」的「聊天」「工作」中发送：这两项需登录 ChatGPT 账号，使用当前账号会提示「提交消息时出错」。', '输入下面这句话并发送，等待回复。'],
        example: '你好，请用中文告诉我你能帮我做什么。',
        expected: 'Codex 返回完整回复后，即可开始使用。',
        illustration: 'desktop-message',
        extra: [{ title: '提示 Codex 桌面端正在运行？', detail: '点击「打开窗口」返回现有窗口。如刚修改配置需重新读取，请先保存任务再选择「重开 Codex」；Mac 上不会出现此提示，请先在 Codex 窗口中按 ⌘Q 完全退出，再返回首页点击「打开」。' }],
        action: '回首页打开 Codex',
        page: 'home',
      },
    ],
    reminders: firstUseReminders,
  },
  {
    id: 'install',
    title: 'Codex 桌面端怎么安装？',
    lead: 'Windows 与 Mac 的安装步骤不同，请选择您正在使用的系统。',
    category: 'start',
    minutes: 4,
    keywords: ['Codex', '桌面端', 'Windows', 'Mac', 'macOS', '苹果', 'ChatGPT', '安装', '下载', '已安装', '未安装', '检测失败', '商店'],
    steps: [
      {
        title: '确认看的是「Codex 桌面端」',
        where: '星芒首页 › 工具',
        detail: '找到名字完整写着「Codex 桌面端」的工具。它和「Codex CLI」是两个程序。',
        bullets: ['未安装的卡片显示为灰色，左下角标注「未安装」。', '已安装的卡片中间一行显示版本号。'],
        expected: '找到 Codex 桌面端自己的安装状态。',
        illustration: 'desktop-install',
        action: '去首页找 Codex 桌面端',
        page: 'home',
      },
      {
        title: 'Windows：点安装，等它装完',
        where: '星芒首页 › Codex 桌面端 › 安装',
        detail: '安装由星芒完成，无需预先安装 Node.js 或 Python。',
        bullets: ['点一次「安装」，等待下载和安装进度结束。', '出现版本号后再看账号连接状态。'],
        expected: 'Codex 桌面端显示版本号。',
        extra: [{ title: '安装报错，或电脑上没有微软商店？', detail: '电脑没有微软商店也可安装，星芒将改用 OpenAI 官网离线安装包或国内线路；安装失败时请按错误框中的按钮操作，安装完成后返回点击「重新检测」。安装日志位于「反馈与客服」的运行日志中。' }],
        action: '去首页安装桌面端',
        page: 'home',
      },
      {
        title: 'Mac：点安装，等它装完',
        where: '星芒首页 › Codex 桌面端 › 安装',
        detail: '星芒会从 OpenAI 官网下载 Mac 版，确认是官方原版后放进「应用程序」。Mac 版的名字是 ChatGPT。',
        bullets: ['点一次「安装」，等下载和安装进度结束；安装包有六七百 MB，网速慢要多等一会儿。', '如「应用程序」中已有旧版 ChatGPT，请先将其移至废纸篓，再点击「安装」。', '出现版本号后再看账号连接状态。'],
        expected: 'Codex 桌面端显示版本号。',
        extra: [{ title: 'Mac 需要预先安装 Homebrew 吗？', detail: '使用桌面端无需安装 Homebrew、Node.js 或 Codex CLI。「Mac 上准备 Node.js 和 Python」一章仅适用于命令行工具。' }, { title: '一键安装失败？', detail: '请按错误框中的按钮操作；也可按「Mac 上装桌面端」一章从官网下载安装，安装完成后返回点击「重新检测」。' }],
        action: '去首页安装桌面端',
        page: 'home',
      },
      {
        title: '已安装但未显示，请先重新检测',
        where: '星芒首页 › 重新检测',
        detail: '先确认电脑本身能打开 Codex，再让星芒重新检测。',
        bullets: ['Windows：使用安装 Codex 的同一个系统用户。', 'Mac：在「应用程序」里找 ChatGPT，确认它能打开。'],
        expected: '识别成功后将显示版本；如仍失败，请记录具体错误信息。',
        extra: [{ title: '显示检测失败，不是未安装？', detail: '表示星芒本次未获取到可靠结果。请前往「检查」查看原因；如仍无法解决，请在「反馈」中预览报告并发送给客服。' }],
        action: '回首页核对桌面端',
        page: 'home',
      },
    ],
  },
  {
    id: 'config',
    title: 'Codex 怎么连接账号、换模型？',
    lead: '如卡片左下角已显示「当前账号」且能正常回复，则无需修改。需要连接账号或更换模型时，请按本章操作。',
    category: 'start',
    minutes: 4,
    keywords: ['Codex', '桌面端', '配置', '模型', 'Key', 'API Key', '密钥', '分组', '自动配置', '保存', '重置', 'ChatGPT', '官方账号'],
    steps: [
      {
        title: '打开配置，选择当前账号',
        where: '星芒首页 › Codex 桌面端 › … › 配置…',
        detail: '配置用于指定 Codex 使用的账号。如使用星芒额度，请选择「当前账号」。',
        bullets: ['未连接时点击卡片上的「确认连接」；已连接时点击「…」中的「配置…」。', '确认弹窗写的是「Codex 桌面端 配置」。'],
        expected: '「当前账号」已选中。',
        extra: [{ title: '想用自己的密钥或 ChatGPT 账号？', detail: '自己的星芒密钥选「手动填写密钥」，粘贴完整内容；官方账号选「ChatGPT 账号」，保存后到 Codex 完成官方登录。Codex CLI 与桌面端共用配置，修改会影响两者。' }],
        illustration: 'desktop-config',
        action: '去首页打开 Codex 配置',
        page: 'home',
      },
      {
        title: '确认密钥',
        where: 'Codex 配置窗口 › 密钥',
        detail: '密钥是调用 AI 的凭证。已有可用密钥可保留，如无可选择自动准备。',
        bullets: ['保留正在正常使用的「当前密钥」。', '首次配置选「自动准备（推荐）」，保存时会自动准备好密钥。', '提示读取失败时请点击「刷新密钥」，读取成功后再保存。'],
        expected: '已选择密钥，且无读取失败提示。',
        extra: [{ title: '选择已有密钥有何区别？', detail: '将使用该密钥的分组和模型权限。请通过名称、分组和掩码预览核对，不要仅凭相似名称判断；ChatGPT 官方账号来源无需选择星芒密钥。' }],
        action: '返回首页配置密钥',
        page: 'home',
      },
      {
        title: '需要换模型时，再检测和选择',
        where: 'Codex 配置窗口 › 检测模型 › 默认模型',
        detail: '模型即回答问题的 AI。首次自动配置可使用默认模型，无需立即更换。',
        bullets: ['使用当前、已有或手填密钥时，点「检测模型」；选了自动准备就点「保存并检测」。', '在「默认模型」里选择想用的一个。'],
        expected: '已选中默认模型，且无检测失败提示。',
        extra: [{ title: '自动准备时怎么选模型？', detail: '点击「保存并检测」：星芒将先准备并保存密钥，再列出可用模型。选择后再次点击「保存配置」。' }, { title: '官方账号或模型兼容问题', detail: 'ChatGPT 账号在 Codex 自己的界面里选模型。星芒模型需要支持 Codex 使用的接口，列表中出现不保证每次调用成功。' }],
        action: '返回首页选择模型',
        page: 'home',
      },
      {
        title: '保存后，让 Codex 重新读取配置',
        where: 'Codex 配置窗口 › 保存配置',
        detail: '点「保存配置」只改账号、密钥和模型，其他设置都会留着。',
        bullets: ['核对账号、密钥和模型后，点「保存配置」。', '如 Codex 正在运行，请先保存任务，再在首页「打开」中选择「重开 Codex」；Mac 上请先在 Codex 窗口中按 ⌘Q 完全退出，再点击「打开」。'],
        expected: '窗口关闭并提示保存成功，重开 Codex 后使用新配置。',
        extra: [{ title: '「重置为初始状态」在哪、什么时候用？', detail: '在配置窗口底部的「高级」里，仅在配置乱了想从头来过时使用。它先备份，再重置该来源的权限、MCP 和推理参数等自定义设置；历史会话保留。' }],
        action: '回首页保存并打开 Codex',
        page: 'home',
      },
    ],
  },
  {
    id: 'switch-account',
    title: '官方账号和当前账号怎么切换？',
    lead: '曾使用 Claude 或 ChatGPT 官方账号的，可一键改用当前账号，也可一键切换回去，无需手动备份或重新安装。',
    category: 'account',
    minutes: 2,
    keywords: ['切换', '官方账号', '当前账号', 'ChatGPT', 'Claude 账号', '中转', '切回', '登录', '401', 'Please run /login', '报错', '备份', 'Claude Desktop'],
    steps: [
      {
        title: '看卡片上写的是哪个账号',
        where: '星芒首页 › 工具卡片左下角',
        detail: '卡片左下角的小标签说明现在用的是谁的账号，点它也能直接切换。',
        bullets: ['「官方账号」：使用您自己的 Claude 或 ChatGPT 订阅。', '「当前账号」：使用星芒左下角已登录账号的额度。'],
        expected: '确认该工具当前使用的账号。',
        illustration: 'home',
        action: '回首页看工具卡片',
        page: 'home',
      },
      {
        title: '点小标签或「…」切换',
        where: '星芒首页 › 卡片左下角的小标签，或右下角 … › 改用当前账号 / 切回官方账号',
        detail: '点击后星芒将自动完成：先备份原配置，再移开可能冲突的旧登录，写入新配置，最后自动测试连接。Claude Desktop 仅更换登录方式（同样先备份），不自动测试。',
        bullets: ['改用前需先登录左下角的账号。', '如测试连接失败，将自动恢复原设置并提示原因。', 'Claude Desktop 原来那份配置用不上时（比如换过星芒账号），会弹出「连接 Claude Desktop」，点「保存并检测」保存一次就改用当前账号。'],
        expected: '右下角提示「已改用当前账号」或「已切回官方账号」。',
        extra: [{ title: '原来的配置去哪了？', detail: '切换前的配置自动放进「设置 › 备份迁移」，想退回去可以在那里恢复。挪开的官方登录只是换了个位置，切回官方时会放回原处。' }],
        action: '去首页切换',
        page: 'home',
      },
      {
        title: '关闭并重新打开已运行的工具',
        where: 'Claude Code / Codex / Claude Desktop 窗口',
        detail: '已打开的工具仍使用旧账号，需关闭后重新打开才会切换。Codex 桌面端同理；Claude Desktop 需完全退出后重新打开。',
        bullets: ['请先保存当前工作，再关闭工具窗口。', 'Claude Desktop 关闭窗口不等于退出：Mac 上请按 ⌘Q，Windows 上还需退出屏幕右下角托盘中的 Claude 图标。', '回到首页点「打开」。'],
        expected: '重开后能正常回复。',
        action: '回首页打开工具',
        page: 'home',
      },
      {
        title: '切回官方后提示要登录',
        where: 'Claude Code / Codex / Claude Desktop 窗口',
        detail: '如本机未登录过官方账号，切换回去后需在工具中登录一次。',
        bullets: ['Claude Code：打开后输入 /login，按提示登录 Claude 账号。', 'Codex：打开后按提示用 ChatGPT 账号登录。', 'Claude Desktop：重新打开后，在它的登录页用 Claude 账号登录。用星芒时的聊天记录不会删，切回当前账号还能看到。', '提示「refresh token has expired」时，在 Codex 里退出后重新登录。'],
        expected: '工具里显示已登录，能正常回复。',
        extra: [{ title: '切换后仍提示 401 或「Please run /login」？', detail: '请前往「检查」页重新检查，查看「电脑中另行设置的工具地址或密钥」是否有提示：电脑中另行设置的密钥会覆盖当前账号的设置。' }],
        action: '前往检查页',
        page: 'health',
      },
    ],
  },
  {
    id: 'launch',
    title: '打开 Codex 后，怎么开始用？',
    lead: '先发送一个问题，再尝试处理文件。每次描述清楚一项任务即可。',
    category: 'start',
    minutes: 4,
    keywords: ['Codex', '桌面端', '打开', '启动', '聊天', '文件夹', '项目', '第一次对话', 'New chat', '记录', '权限'],
    steps: [
      {
        title: '打开 Codex 窗口',
        where: '星芒首页 › Codex 桌面端 › 打开',
        detail: '卡片左下角写着「当前账号」、「官方账号」或「自己的密钥」时，点「打开」，接下来在 Codex 窗口里操作。',
        bullets: ['点击 Codex 桌面端卡片上的「打开」。', '提示已经运行时，点「打开窗口」。'],
        expected: '屏幕上出现 Codex 的独立窗口。',
        illustration: 'desktop-home',
        action: '去首页打开 Codex',
        page: 'home',
      },
      {
        title: '先发一句简单的话',
        where: 'Codex 窗口 → 新对话 → 输入框',
        detail: '仅提问无需选择文件夹。请先发送一条消息，确认能收到回复。',
        bullets: ['在窗口左侧栏最上面把模式切到「Codex」，开始一段新对话，英文界面可能显示 New chat。', '输入下面这句话并发送。'],
        example: '请帮我列一份今天的工作计划，先问我有哪些事情要做。',
        expected: 'Codex 返回文字后，可继续回复。',
        extra: [{ title: '发出去报「提交消息时出错」？', detail: '通常是因为在「ChatGPT」的「聊天」或「工作」中发送。使用当前账号或自有密钥时，这两项无法发送，请切换到「Codex」中发送。详见「出问题怎么办」。' }],
        illustration: 'desktop-message',
        action: '返回首页打开桌面端',
        page: 'home',
      },
      {
        title: '要处理文件，再添加本地项目',
        where: 'Codex 窗口 → 本地项目 / 打开文件夹',
        detail: '本地项目即本次要处理的电脑文件夹。首次使用建议先选择一个练习文件夹。',
        bullets: ['在 Codex 里添加本地项目或打开文件夹。', '选这次任务的文件夹，不选整个桌面或磁盘。', '说明要做什么，先让 AI 列计划再修改文件。'],
        expected: 'Codex 使用的是您选中的项目文件夹。',
        extra: [{ title: '在哪里选文件夹、怎么给权限？', detail: '请在 Codex 窗口中选择项目，星芒配置中的工作文件夹不能替代此操作。文件操作仍受 Codex 权限限制，弹出确认时请核对范围后再允许。' }],
        illustration: 'desktop-project',
        action: '返回首页打开桌面端',
        page: 'home',
      },
      {
        title: '下次继续原来的对话',
        where: 'Codex 窗口 → 已有对话',
        detail: '同一任务请在原对话中继续，更换目标时请新建对话。',
        bullets: ['找到刚才的对话，继续补充要求。', '有文件修改时先查看结果，再交代下一步。'],
        expected: '能回到原来的项目和对话继续工作。',
        extra: [{ title: '星芒的「创作」是同一个窗口吗？', detail: '不是。「创作」里的对话是星芒自带的问答功能；Codex 桌面端的对话要回到 Codex 窗口继续。星芒「记录」可辅助查看支持的工具会话。' }],
        action: '回首页继续使用 Codex',
        page: 'home',
      },
    ],
  },
  {
    id: 'account',
    title: '账号、充值与额度',
    lead: '查看自己的账号、充值到账情况和使用费用。',
    category: 'account',
    minutes: 4,
    keywords: ['个人中心', '登录', '注册', 'QQ邮箱', '密码', '余额', '充值', '订阅', '兑换码', '订单', 'Key', '费用'],
    steps: [
      {
        title: '在个人中心确认当前账号',
        where: '左下角账号卡 › 账号概览',
        detail: '请先确认当前登录的是您本人的账号。',
        bullets: ['点左下角账号，未登录就先登录。', '查看资料与余额，读取失败时点「刷新余额」。'],
        expected: '账号名字正确，余额已读取。',
        illustration: 'account',
        action: '打开个人中心',
        page: 'account',
      },
      {
        title: '分清账号密码、密钥和模型分组',
        where: '个人中心 › 密钥管理',
        detail: '密码用于登录；密钥是调用 AI 的凭证；分组决定可用模型和计费规则。日常使用通常无需手动复制密钥。',
        bullets: ['在「密钥管理」里查看已有密钥。', '工具配置里核对所用密钥的名称、分组和掩码预览。'],
        expected: '知道当前工具用了哪个分组。',
        extra: [{ title: '官方账号也扣星芒余额吗？', detail: '切换到官方账号来源后，登录和额度按官方服务的规则使用。' }],
        action: '查看账号与密钥',
        page: 'account',
        section: 'keys',
      },
      {
        title: '充值或兑换，并确认到账',
        where: '侧栏「充值」',
        detail: '按页面提供的金额和支付方式充值。手里有充值码的，也可以直接兑换。',
        bullets: ['选金额和支付方式，点「充值」，核对报价后支付。', '有充值码的，点「有充值码？」，填好后点「兑换」。', '付款后等成功提示，核对余额或权益。'],
        expected: '显示充值或兑换成功，余额或权益已更新。',
        extra: [{ title: '已付款但未提示到账？', detail: '关闭支付窗口后，星芒仍会在后台确认一段时间，到账后余额将自动更新。如需核对，请点击提示中的「查看我的订单」。关闭支付窗口不会取消订单，请勿因未看到提示而重复付款；可用的支付和订阅入口以页面实际显示为准。' }],
        action: '打开个人中心办理充值',
        page: 'account',
        section: 'recharge',
      },
      {
        title: '查看每次调用消耗了多少',
        where: '个人中心 › 用量账单',
        detail: '「用量账单」上面看整体趋势，下面的「调用明细」看每次用了多少。',
        bullets: ['按刚才使用的时间找到调用。', '打开详情，核对模型、分组和费用。'],
        expected: '能找到对应请求的用量和计费信息。',
        extra: [{ title: '余额未变化，或需要重试？', detail: '可以手动刷新余额；显示更新失败时可能仍是旧金额。聊天、生图和重试都是实际请求，费用以服务端记录为准。' }],
        action: '查看用量与调用明细',
        page: 'account',
        section: 'usage',
      },
    ],
  },
  {
    id: 'chat',
    title: '直接聊天与生成图片',
    lead: '在星芒中直接提问或生成图片，无需另行安装工具。',
    category: 'start',
    minutes: 3,
    keywords: ['聊天', '问答', '文案', '图片', '生图', '发送', '停止', '分组', '模型', '新对话', '历史'],
    steps: [
      {
        title: '打开聊天，选好模型',
        where: '左侧创作 › 新建 › 输入框底部',
        detail: '请先选择回答问题的模型，无需选择分组：星芒将自动匹配，模型旁的小字标注计费分组。',
        bullets: ['点「新建」，保持「文本对话」。', '点击输入框底部的模型按钮，按厂商选择模型；如列表未显示，请点击菜单底部的「刷新模型」。'],
        expected: '模型已选中，输入文字后可以发送。',
        illustration: 'chat',
        action: '打开聊天',
        page: 'chat',
      },
      {
        title: '先发送一个清楚的小问题',
        where: '创作 › 消息输入框',
        detail: '说清想做什么、给谁看、希望输出什么。',
        bullets: ['输入问题，点向上的发送箭头。', '需要中止时点「停止生成」。'],
        example: '请写一封客户进度说明：本周完成首页，下周做支付。语气专业，200 字以内。',
        expected: '消息区出现 AI 回复。',
        action: '去聊天发送第一个问题',
        page: 'chat',
      },
      {
        title: '生成图片后复制或另存',
        where: '创作 › 生成图片',
        detail: '描述想要的画面，生成后可保存到电脑。',
        bullets: ['切到「生成图片」，选模型和尺寸。', '输入描述后点「生成图片」。', '完成后点预览，选「复制图片」或「另存图片」。'],
        example: '一只橘猫坐在窗边看雨，温暖的室内灯光，水彩插画，方形构图，不要文字。',
        expected: '看到图片预览，另存后能找到图片文件。',
        extra: [{ title: '没有模型或生成较慢？', detail: '如模型菜单中没有图片模型，请点击菜单底部的「刷新模型」；如仍没有，表示当前账号暂不支持生成图片，可咨询客服。停止等待不一定会取消服务端生成，请先确认状态再重试。' }],
        action: '打开聊天生成图片',
        page: 'chat',
      },
      {
        title: '找回历史，谨慎重试',
        where: '创作 › 左边那一列',
        detail: '同一件事继续原对话，换主题就开新对话。',
        bullets: ['点左侧已有对话继续。', '回复下方可复制，需重试时选「重新生成」。'],
        expected: '回到原对话能看到已有消息。',
        extra: [{ title: '重新生成或编辑重发会怎样？', detail: '会提交新的请求，并替换对应消息之后的回复，可能产生新费用；费用在个人中心「用量账单」查看。' }],
        action: '打开聊天历史',
        page: 'chat',
      },
    ],
  },
  {
    id: 'sessions',
    title: '记录',
    lead: '查找本机的工具对话，继续上次的任务，也可查看、导出和整理。',
    category: 'start',
    minutes: 3,
    keywords: ['记录', '会话', '历史', '搜索', '接着聊', '继续对话', '续接', '归档', '恢复', '导出', 'Markdown', '保留期', '一年', '本机'],
    steps: [
      {
        title: '找到要看的那次对话',
        where: '左侧记录 › 工具筛选 / 搜索框',
        detail: '此处显示 Claude Code、Codex CLI、Grok CLI 的本机对话，记录仅保存在本机。',
        bullets: ['顶部按工具筛选，或搜索标题、文件夹、模型。', '核对这一行的工作文件夹、消息条数和时间。'],
        expected: '找到正确工具和项目的记录。',
        action: '打开记录查找对话',
        page: 'sessions',
      },
      {
        title: '继续之前的对话',
        where: '记录 › 对应行 › 继续对话',
        detail: '「继续对话」将在记录的文件夹中打开对应工具，并继续这次对话。',
        bullets: ['核对工作文件夹，点击「继续对话」。', '首页「最近对话」中也有此按钮。'],
        expected: '对应工具打开，并接上这次对话。',
        extra: [{ title: '为什么该记录没有「继续对话」？', detail: '已归档的记录、未记录文件夹的记录不显示此按钮。' }],
        action: '打开记录继续任务',
        page: 'sessions',
      },
      {
        title: '查看、导出或归档记录',
        where: '记录 › 点击一条记录 › 右侧详情',
        detail: '先查看内容，需要保存一份就导出，不常用的记录可以归档。',
        bullets: ['点击一条记录，在右侧查看对话。', '点「导出」，按提示找到导出文件。', '不想放在当前列表时点「归档」，需要时再「恢复」。'],
        expected: '能阅读或导出对话，归档状态也能恢复。',
        extra: [{ title: '归档会影响继续聊天吗？', detail: '归档会将记录移出工具自身的目录，因此已归档记录无法「继续对话」。如需继续，请先恢复。' }],
        action: '打开记录查看详情',
        page: 'sessions',
      },
      {
        title: '看懂不可续接和保留期',
        where: '记录 › 状态提示',
        detail: '显示「文件夹已不存在」时，原目录已删除或搬走，不能继续，但仍可查看和导出。',
        bullets: ['按钮按不动时，先看旁边的文件夹状态。', '重要内容及时「导出」，不要只依赖工具保留记录。'],
        expected: '知道不能续接的原因，也能保留需要的内容。',
        extra: [{ title: '记录会保留多久？', detail: '记录由各工具自行管理。由星芒写入配置的 Claude Code，默认保留期已从一个月延长至一年；您自行设置过的保留期保持不变。' }],
        action: '打开记录核对状态',
        page: 'sessions',
      },
    ],
  },
  {
    id: 'canvas',
    title: '画布：从项目到生成结果',
    lead: '节点是一张处理卡片。先跑通一张，再连接成连续的工作步骤。',
    category: 'tools',
    minutes: 5,
    keywords: ['画布', '节点', '工作流', '项目', '生图', '素材', '模板', '生成', '保存'],
    steps: [
      {
        title: '打开画布，创建一个练习项目',
        where: '左侧创作 › 在画布中分步创作 › 项目中心',
        detail: '先给这次创作建一个项目，已有项目可直接打开。',
        bullets: ['点「新建项目」，输入名称。', '点击「创建」，无需选择文件夹。如需保存到其他位置，请点击「换个位置创建…」。'],
        expected: '进入带项目名称的画布。',
        illustration: 'canvas',
        action: '打开画布',
        page: 'canvas',
      },
      {
        title: '先配置要用的生成类型',
        where: '画布顶部 › 生成配置',
        detail: '为这次要做的文字或图片任务选择模型。',
        bullets: ['打开「生成配置」，选择对应类型。', '选择可用的分组和模型，暂不使用的类型可不配置。'],
        expected: '本次要用的类型有可用模型。',
        action: '去画布确认生成配置',
        page: 'canvas',
      },
      {
        title: '添加节点，填写内容并运行',
        where: '画布创作库 › 节点 › 运行此节点',
        detail: '先添加一张节点卡片，填写想让 AI 做的事。',
        bullets: ['从创作库或「快速创建」添加节点，填提示词和必需输入。', '点「运行此节点」，核对运行前检查里的模型和分组。', '点「确认运行」，等待完成。'],
        expected: '节点显示已完成，出现生成结果。',
        extra: [{ title: '缺少输入或想用现成流程？', detail: '缺少输入先补内容或连接上游，不要反复运行。现成流程可从创作库模板，或「更多操作」›「打开行业模板库」添加。' }],
        action: '打开画布尝试一个节点',
        page: 'canvas',
      },
      {
        title: '确认保存，查看结果与失败原因',
        where: '画布底部 › 保存状态；顶部 › 运行历史',
        detail: '离开前看一眼保存状态，失败时查看运行记录。',
        bullets: ['确认底部显示「已自动保存」。', '点「运行历史」查看结果或错误。', '要转移项目，在「更多操作」里选「导出工作流」，图片会一起导出。'],
        expected: '重新打开项目仍能看到画布与素材。',
        extra: [{ title: '还有任务时可以关闭吗？', detail: '按关闭窗口的提示处理。停止本地等待后，服务端仍可能继续生成和计费。' }],
        action: '打开画布查看项目',
        page: 'canvas',
      },
    ],
  },
  // 按钮名、下拉名照视频剪辑页上的字写，tutorials.test.ts 把能导出的几处钉在页面那份文案上。
  {
    id: 'video',
    title: '视频剪辑：一句话生成短视频',
    lead: '描述想拍摄的内容，AI 将编写分镜并逐段生成，再在本机合成一条带字幕的视频。',
    category: 'tools',
    minutes: 5,
    keywords: ['视频', '剪视频', '剪辑', '生成视频', '短视频', '分镜', '字幕', '配乐', '背景音乐', '拼视频', '成片', '淡入淡出'],
    steps: [
      {
        title: '输入想法，由 AI 编写分镜',
        where: '左侧创作 › 做一条带字幕的短视频 › 想法',
        detail: '用一两句话描述想拍摄的内容：人物、地点、事件和想要的氛围。',
        bullets: ['在「想拍什么」中输入想法，再选择「画面」（横屏、竖屏或方形）、「镜头数」和「每段时长」；如不需要字幕，请关闭「加字幕」。', '模型通常使用默认即可，如需更换，请点击「编写分镜」「生成视频」旁的模型名称。', '点击「编写分镜」，等待 AI 编写完成。'],
        expected: '下方出现分镜卡，列出每个镜头的画面描述。',
        extra: [{ title: '「创作」中没有「做一条带字幕的短视频」？', detail: '视频剪辑需使用星芒账号中的视频模型，历史账号不支持。请使用星芒账号登录后使用。' }],
        action: '打开视频剪辑',
        page: 'video',
      },
      {
        title: '修改分镜，为需要从图片开始的镜头配图',
        where: '创作 › 这条视频 › 分镜卡 › 每个镜头',
        detail: 'AI 编写的分镜为初稿。请在生成前修改至满意，以免重新生成产生额外费用。',
        bullets: ['修改「画面」和「字幕」中的文字；使用上移、下移调整顺序，删除不需要的镜头，或点击「加一个镜头」。', '如需让此镜头从商品图或人物照片开始动起来，请点击「用一张图开头」选择图片；如无图片，可点击「AI 生成图片」，生成图片单独计费。', '如需调整某个镜头的长度，请修改其「时长」。'],
        expected: '每个镜头的画面描述、字幕和时长均符合预期。',
        action: '去视频剪辑改分镜',
        page: 'video',
      },
      {
        title: '生成每一段视频',
        where: '创作 › 这条视频 › 分镜卡 › 生成全部 … 段',
        detail: '每段单独计费，确认框中会显示生成段数、每段时长和当前余额。每段约需几分钟。',
        bullets: ['点击「生成全部 … 段」，核对确认框内容后点击「开始生成」。', '如对某段不满意，请点击其「重新生成」，将再次扣费；原片段仍保留在作品库中。', '如开头停滞或结尾变形，可使用「开头剪掉」「结尾剪掉」裁去几秒，无需重新生成。'],
        expected: '每个镜头均显示「已生成」，点击左侧缩略图可用播放器查看该片段。',
        extra: [
          { title: '如何中途停止？', detail: '点击「停止生成」。已提交至服务端的片段仍将生成并扣费。' },
          { title: '提示余额不足？', detail: '点击提示中的「前往充值」，充值完成后返回点击生成。' },
        ],
        action: '去视频剪辑生成片段',
        page: 'video',
      },
      {
        title: '添加配乐，合成视频',
        where: '创作 › 这条视频 › 合成视频',
        detail: '所有片段生成后，在本机合成完整视频，不产生费用。',
        bullets: ['如需背景音乐，请点击「加配乐」，从本机选择一首歌曲；「片段原声」可选「照常」「调小」或「关掉」。', '如需柔和过渡，可将「镜头之间」设为「淡入淡出」，或开启「结尾淡出」；开启字幕时还可设置「字幕大小」和「字幕位置」。', '选择「清晰度」后，点击「合成视频」，等待进度完成。'],
        expected: '下方出现成片，可点击「用播放器打开」「另存为」，或点击「打开文件夹」在 AI 作品文件夹中查看。',
        extra: [{ title: '如何下次继续编辑，或同时制作多条？', detail: '分镜、片段和配乐将自动保存，下次打开「创作」时，该视频仍在左侧列表中，点击即可继续编辑。如需另做一条，请点击左上角的「新建」，再点击「做一条带字幕的短视频」。不需要的视频，请点击其右上角的「删除此视频」；已生成的片段和合成的成片仍保留在作品库中。' }],
        action: '去视频剪辑合成成片',
        page: 'video',
      },
    ],
  },
  {
    id: cliTutorialTopic,
    title: '进阶：安装与使用命令行工具',
    lead: '命令行工具是在终端窗口里和 AI 一起处理项目的方式。只用 Codex 桌面端可以跳过这一章。',
    category: 'tools',
    minutes: 5,
    keywords: ['CLI', '命令行', '终端', 'Claude Code', 'Codex CLI', 'Grok', 'Node.js', 'npm', 'Python', 'Git', '安装', '首次命令', '接着聊', '继续对话'],
    steps: [
      {
        title: '选择命令行工具，检查运行环境是否齐全',
        where: '星芒首页 › 运行环境',
        detail: '点击工具的「安装」时，所需的 Node.js 将自动准备，无需手动下载；Windows 上仅安装 Grok 时不需要 Node.js。命令行工具均无需安装 Python。',
        bullets: ['个别插件需要 Python，安装时会提示；Mac 上的安装方法见「Mac 上准备 Node.js 和 Python」。'],
        expected: '所需运行环境显示版本号。',
        extra: [{ title: 'Claude Code 为什么提示 Git？', detail: 'Windows 上部分技能、插件命令和首次添加官方插件市场需要 Git，按「检查」页的指引安装。' }],
        illustration: 'install',
        action: '去首页看运行环境',
        page: 'home',
      },
      {
        title: '安装命令行工具并确认账号连接',
        where: '星芒首页 › 要用的工具 › 安装',
        detail: '选择要使用的工具，安装后确认账号连接。',
        bullets: ['点「安装」，等进度和账号同步结束。', '卡片上还写着「待连接」时点「确认连接」，选来源、密钥和模型后保存。'],
        expected: '卡片上出现版本号，左下角写着「当前账号」。',
        extra: [{ title: '已有安装或正在使用 Codex 桌面端？', detail: '已有工具先检测；官方安装器或其他来源管理的工具按原方式更新。Codex CLI 与桌面端共用配置，修改会影响两者；点「保存配置」只改账号、密钥和模型。' }],
        action: '查看安装状态',
        page: 'home',
      },
      {
        title: '点击打开，选择这次的工作文件夹',
        where: '星芒首页 › 工具的「打开」 › 选择文件夹',
        detail: '文件夹决定 AI 在哪里处理项目。第一次先用练习目录。',
        bullets: ['点击「打开」：使用过的工具将回到上次的文件夹（鼠标悬停在按钮上可查看）；如从未选择过文件夹，将自动新建项目文件夹并在其中打开。', '想换文件夹，在卡片的「…」里点「选择其他文件夹…」。', '等终端里工具启动好，再输入中文任务。'],
        expected: '工具已在正确的文件夹中启动，无需再次输入启动命令。',
        extra: [{ title: '不知道选哪个文件夹？', detail: '请点击新建：在卡片的「…」中选择「新建项目文件夹并打开」（如从未选择过文件夹，直接点击「打开」效果相同）。软件将创建一个空的项目文件夹并直接打开，无需选择位置或命名。' }],
        illustration: 'launch',
        action: '回首页打开工具',
        page: 'home',
      },
      {
        title: '发出第一个任务，再从记录继续',
        where: '工具的终端窗口 → 输入任务；星芒 › 记录',
        detail: '在启动好的工具里输入任务，收到回复后再继续。',
        bullets: ['发送下面的例句。', '下次可从「记录」或首页「最近对话」中查找项目，支持时可点击「继续对话」。'],
        example: firstRunHints.claude.prompt,
        expected: '收到项目相关的回复。',
        extra: [{ title: '自己打开终端怎么启动？', detail: '新开终端，粘贴首页「运行第一条命令」中的启动命令即可。仅支持续接的最近会话显示「继续对话」。' }],
        action: '打开记录',
        page: 'sessions',
      },
    ],
  },
  // Claude Code 2.1.318 起不再在编辑器终端里自己装插件（更新说明原文），客户得自己去插件市场装；
  // 不用登录那一半是星芒保存 Claude Code 配置时补的（editor-claude-login-prompt.ts），编辑器没打开过就补不上，
  // 所以第 4 步让客户先打开过编辑器、再回来保存一次。
  {
    id: 'editor',
    title: '在 VS Code 或 Cursor 里用 Claude Code',
    lead: '在编辑器侧边栏与 Claude Code 对话，使用星芒为 Claude Code 关联的同一账号，无需另行登录。',
    category: 'tools',
    minutes: 3,
    keywords: ['VS Code', 'VSCode', 'Cursor', '编辑器', '插件', '扩展', 'Claude Code', '侧边栏', '登录', 'Anthropic', 'IDE', '/ide'],
    steps: [
      {
        title: '先在星芒中安装 Claude Code 并关联当前账号',
        where: '星芒首页 › Claude Code',
        detail: '编辑器中的 Claude Code 与终端中的使用同一份设置，在星芒中关联后，编辑器中无需再次填写。',
        bullets: ['未安装时请点击「安装」。', '卡片左下角显示「当前账号」即表示已关联。'],
        expected: 'Claude Code 卡片上有版本号，左下角写着「当前账号」。',
        action: '回首页看 Claude Code',
        page: 'home',
      },
      {
        title: '在编辑器的插件市场里装 Claude Code',
        where: 'VS Code 或 Cursor › 左侧的扩展图标',
        detail: '新版 Claude Code 不会再自己往编辑器里装插件，要在编辑器里装一次。',
        bullets: ['点编辑器左侧的扩展图标（四个小方块），搜「Claude Code」。', '认准发布者是 Anthropic，点「安装」（英文界面是 Install）。'],
        expected: '编辑器侧边多了一个 Claude 图标。',
        action: '回首页确认 Claude Code 已连好',
        page: 'home',
      },
      {
        title: '点击 Claude 图标，无需登录即可发送消息',
        where: 'VS Code 或 Cursor › 侧边的 Claude 图标',
        detail: '星芒保存 Claude Code 设置时，已为编辑器关闭登录页。费用从当前账号余额中扣除。',
        bullets: ['先在编辑器里打开要处理的项目文件夹。', '点 Claude 图标，在输入框里用中文说要做什么。'],
        expected: '编辑器里收到 Claude Code 的回复。',
        action: '回首页看 Claude Code',
        page: 'home',
      },
      {
        title: '仍提示登录？请返回星芒重新保存',
        where: '星芒首页 › Claude Code › … › 配置…',
        detail: '如星芒保存 Claude Code 设置时编辑器尚未打开过，登录页将无法关闭。请在打开编辑器后重新保存一次。',
        bullets: ['请先关闭编辑器。', '返回星芒首页，在 Claude Code 卡片的「…」中点击「配置…」，再点击「保存配置」。', '重新打开编辑器，再点击 Claude 图标。'],
        expected: '编辑器不再提示登录，可直接发送消息。',
        action: '回首页重新保存 Claude Code 配置',
        page: 'home',
      },
    ],
  },
  // 0.2.25 起精选、外接工具、技能、插件合成一页「插件」（#1993）：这三章按新页面写，章的 id 和按钮跳的旧页名照旧（别名落到新页对应那一栏）。
  // 外接工具在页面上也叫「插件」，这一章改叫「连上浏览器和文件夹」，免得跟下面「官方插件和插件市场」撞名。
  {
    id: 'mcp',
    title: '连上浏览器和文件夹',
    lead: '浏览器、本地文件这类插件让 AI 用上更多服务（官方叫 MCP 服务器）。在「插件」页挑好，一次装进 Claude 和 GPT。',
    category: 'tools',
    minutes: 4,
    keywords: ['MCP', 'MCP 服务器', '浏览器', '外接工具', '插件', '精选', '推荐', '连接', '本地程序', '网络服务', '授权', 'JSON'],
    steps: [
      {
        title: '先看它能做什么',
        where: '左侧插件 › 推荐',
        detail: '「常用」中为星芒精选的几项：「浏览器」可让 AI 打开网页，「本地文件」可让 AI 读写您指定的文件夹。每行右侧的小图标表示可安装到的工具，已安装的工具带绿点。',
        bullets: ['点击一项，先查看「它会做什么」和所需权限。', '「装到：全部」可以只看能装进某一家的。'],
        expected: '每项均标注已安装到的工具；左侧「已安装」为本机已安装的项。',
        extra: [{ title: '读项目文件一定要装插件吗？', detail: '不需要。命令行工具本身即可读取您允许的项目文件；「本地文件」类插件用于让 AI 读写您另外指定的文件夹。' }],
        illustration: 'extensions',
        action: '打开插件',
        page: 'mcp',
      },
      {
        title: '安装一项',
        where: '插件 › 推荐 / 添加 › 自定义连接',
        detail: '首次建议从「推荐」中安装；服务方提供连接配置时再自行添加。',
        bullets: ['点击条目右侧的「+」，确认权限后，在「装到哪里」中勾选要使用的工具再安装。', '自行添加：点击右上角「添加」›「自定义连接」，粘贴服务方提供的完整配置，或按说明填写名称、地址或启动命令。'],
        expected: '左侧「已安装」中新增一项，并标明已安装到哪些工具。',
        extra: [{ title: '附加参数和附加设置怎么填？', detail: '在「更多设置」中。附加参数使用 JSON 字符串数组，例如 ["--help"]；附加设置使用文字对象，例如 {"MODE":"read-only"}。此处仅为格式示例，实际值请按服务说明填写；本地程序须预先安装。' }],
        action: '前往安装',
        page: 'mcp',
      },
      {
        title: '确认连接成功',
        where: '插件 › 点开条目 › 装在哪里',
        detail: '需要登录的连接，先授权再使用。',
        bullets: ['左侧「已安装」中名称后带橙点的，表示无法连接或需登录授权。', '点开该条目，在「装在哪里」中对应工具的行上点击「登录授权」，并在浏览器中确认授权。', '到对应 AI 工具里试一个必须用它的任务。'],
        example: '请用我刚添加的浏览器工具打开指定页面，并告诉我页面标题。',
        expected: '各工具均显示「已安装」，AI 可正常使用。',
        action: '查看装在哪里',
        page: 'mcp',
      },
      {
        title: '添加失败怎么办',
        where: '插件 › 错误提示',
        detail: '请先按页面提示修正对应字段，无需重新安装所有工具。',
        bullets: ['地址为空时请补充地址；整段配置无法识别时请核对格式。', '「装到哪里」中显示「本机尚未安装 …」时，请先点击「前往首页安装」。'],
        expected: '修正后可以保存或完成授权。',
        action: '去首页核对安装',
        page: 'home',
      },
    ],
  },
  {
    id: 'skills',
    title: '技能',
    lead: '技能是一份做事说明，让 AI 按固定方法完成某类任务。几家 AI 通用，导入一次可以给几家用。',
    category: 'tools',
    minutes: 4,
    keywords: ['技能', 'Skill', '导入', '全局', '当前项目', '启用', '来源', '文件夹'],
    steps: [
      {
        title: '先看技能是什么',
        where: '左侧插件 › 技能',
        detail: '「已安装在本机」汇总了各工具安装的技能，小图标标注所属工具；「Codex 自带」随 Codex 一同更新，仅可查看。',
        bullets: ['在「插件」页左边点「技能」切过去。', '点击条目查看已安装到哪些工具及其范围。'],
        expected: '每个技能都标出装在哪几家。',
        illustration: 'skills',
        action: '打开技能',
        page: 'skills',
      },
      {
        title: '添加自己的技能',
        where: '技能 › 添加 › 从文件夹导入',
        detail: '选一个本机的技能文件夹，勾上要给哪几家用。',
        bullets: ['点击右上角「添加」›「从文件夹导入」，再点击「选择文件夹」。', '选「我的（全局）」用于多个项目，或「当前项目」只用于此项目。', '已经装在一家、想给另一家也用，点那一行右边的「+」。'],
        expected: '列表出现新技能，标出装在哪几家。',
        action: '去导入技能',
        page: 'skills',
      },
      {
        title: '确认生效',
        where: '技能 › 点开条目',
        detail: '看到技能后，再用一个相关任务验证。',
        bullets: ['确认对应工具未显示「已停用」。', '到对应工具里交代一个技能负责的任务。'],
        expected: 'AI 按技能的方法处理任务。',
        extra: [{ title: '为什么未触发？', detail: '技能只在相关任务中触发，不是所有问题都会使用。' }],
        action: '查看技能状态',
        page: 'skills',
      },
      {
        title: '无法导入怎么办',
        where: '技能 › 错误提示',
        detail: '请先确认是文件夹选择有误，还是对应工具尚未在本机安装。',
        bullets: ['路径为空时请点击「选择文件夹」；「装到哪里」中某个工具显示为灰色时，请查看旁边的原因说明。', '「部分信息需要确认」时，处理具体原因后点「重新加载」。'],
        expected: '列表能正常读取并找到技能。',
        action: '打开技能检查提示',
        page: 'skills',
      },
    ],
  },
  {
    id: 'plugins',
    title: '官方插件和插件市场',
    lead: '插件是一整套扩展能力，可能包含命令、技能和连接。各家插件格式不通用，只能安装到对应的工具。',
    category: 'tools',
    minutes: 4,
    keywords: ['插件', 'plugin', '市场', '官方市场', '插件市场', 'Claude 官方', 'GPT 官方', '安装', '来源', '仓库', '更新'],
    steps: [
      {
        title: '确认插件适用的工具',
        where: '插件 › 推荐 › Claude 官方 / GPT 官方',
        detail: '「Claude 官方」是 Anthropic 官方市场，只能装进 Claude；「GPT 官方」是 OpenAI 插件目录，只能装进 GPT。点标题展开看全部。',
        bullets: ['安装前请点开查看用途、提供方和所需权限。', '左侧「已安装」为已安装的项。'],
        expected: '可清楚看到每个插件适用的工具。',
        illustration: 'plugins',
        action: '打开插件',
        page: 'plugins',
      },
      {
        title: '添加插件',
        where: '插件 › 「+」/ 添加',
        detail: '建议从官方目录安装；作者提供来源时再自行添加。',
        bullets: ['点击条目右侧的「+」，确认后安装。', '有现成来源时点右上角「添加」›「添加插件」；要加一整个市场点「添加插件市场」。'],
        expected: '左侧「已安装」中新增一项。',
        extra: [{ title: '市场入口和来源有什么要求？', detail: '「Claude 官方」首次使用需点击「添加官方市场」，此步骤需要 Git；「GPT 官方」的目录将自动下载。自行添加的市场位于「自己加的」中，可更新或移除。Grok 没有插件市场。来源请填写作者提供的名称或地址，不要填写普通网页。' }],
        action: '去添加插件',
        page: 'plugins',
      },
      {
        title: '确认安装成功',
        where: '插件 › 点开条目 › 装在哪里',
        detail: '先核对安装状态，再到 AI 工具里试用。',
        bullets: ['确认对应工具显示「已安装」，且未显示「已停用」。', '在「它会做什么」里核对提供方和装的是哪一版。'],
        expected: '名称和状态正确，工具内能使用插件。',
        extra: [{ title: '哪些插件能在这里更新、开关？', detail: 'Claude、Grok 的插件能开关和更新；GPT 的插件能装和移除。' }],
        action: '查看已安装插件',
        page: 'plugins',
      },
      {
        title: '安装后无反应怎么办',
        where: '插件状态 → 对应 AI 工具',
        detail: '工具运行中安装的插件，可能需要重新打开工具才生效。',
        bullets: ['先保存当前工作，再重新打开工具。', '仍失败时，记录插件名称、工具版本和报错。'],
        expected: '重开后能使用插件，或已取得明确错误。',
        extra: [{ title: '没有市场、缺少 Git 或来源不确定？', detail: 'Grok 没有插件市场，已安装的插件仍显示在左侧「已安装」中。「Claude 官方」首次添加官方市场需要 Git，请按检查页指引安装。来源不可信时请勿安装，插件可能拥有与工具相同的操作权限。' }],
        action: '打开插件检查状态',
        page: 'plugins',
      },
    ],
  },
  // 页面上的按钮名、步骤以手机遥控页为准（features/settings/codex-remote），这里只说走哪几步，不抄页面上的字，
  // 页面改字不用跟着改这一章。
  {
    id: phoneRemoteTutorialTopic,
    title: '用手机遥控 Codex',
    lead: '即使不在电脑前，也可通过飞书或微信操作本机的 Codex，使用当前账号的额度。',
    category: 'tools',
    minutes: 4,
    keywords: ['手机', '遥控', '远程', '飞书', '微信', 'ClawBot', '机器人', '配对', '配对码', '不在电脑前'],
    steps: [
      {
        title: '找到「遥控」，选择工作文件夹',
        where: '左侧栏 › 遥控',
        detail: 'Codex 仅在此文件夹中运行。请选择具体的项目文件夹，不要选择整个桌面或整个磁盘。',
        expected: '页面上显示已选择的文件夹。',
        action: '前往遥控',
        page: 'remote',
      },
      {
        title: '选择飞书或微信，登录机器人',
        where: '左侧栏 › 遥控 › 连接方式 › 飞书 / 微信',
        detail: '飞书：按页面上的步骤创建您的机器人，并填写其凭据。微信：使用手机微信扫码登录。',
        bullets: ['微信通道为实验功能，可能随时中断，长期使用建议选择飞书。'],
        expected: '页面上显示已登录。',
        action: '前往遥控登录机器人',
        page: 'remote',
      },
      {
        title: '开启遥控，在手机上配对',
        where: '左侧栏 › 遥控',
        detail: '开启遥控后开始配对，将页面上的配对码私聊发送给机器人。仅响应已配对的用户。',
        expected: '页面上显示配对用户及配对时间。',
        action: '前往遥控进行配对',
        page: 'remote',
      },
      {
        title: '在手机上下达任务并确认操作',
        where: '飞书或微信里和机器人的私聊；左侧栏 › 遥控',
        detail: '直接发送要执行的任务。默认权限下，Codex 在所选文件夹内修改文件、执行命令无需确认；联网或修改该文件夹以外的内容前，将先在聊天中征求您的确认，回复「同意」后才执行。',
        bullets: ['任何能使用您绑定的飞书或微信发送消息的人，均可操作本机，请勿将账号借予他人。'],
        expected: '手机上将收到 Codex 的进度和结果。',
        action: '前往遥控查看状态',
        page: 'remote',
      },
    ],
  },
  {
    id: updatesTutorialTopic,
    title: '备份、更新与数据',
    lead: '改配置前留备份，更新前保存工作，项目文件另外保管。',
    category: 'trouble',
    minutes: 3,
    keywords: ['备份', '恢复', '更新', '自动更新', '退回', '授权', '重置', '数据', '隐私', '卸载', '版本', 'Mac', '钥匙串', '开机密码', '始终允许', 'C 盘', '磁盘满', '空间不够', '清理'],
    steps: [
      {
        title: '先备份工具配置',
        where: '设置 › 备份迁移',
        detail: '配置备份保存工具设置，不包含整个项目或所有聊天记录。',
        bullets: ['点「立即备份」，选工具。', '恢复时核对工具、时间和文件范围，再确认。'],
        expected: '列表出现对应工具的新备份。',
        illustration: 'backup',
        action: '打开备份迁移',
        page: 'settings',
        section: 'backups',
      },
      {
        title: '星芒自己更新，AI 工具在首页更新',
        where: '设置 › 版本更新；首页 › 工具卡片上的「可更新到 v…」',
        detail: '星芒的新版本将在后台下载，下载完成后弹窗询问是否立即安装：点击「现在安装」，星芒将关闭、安装完成后自动打开；点击「稍后再说」，将在关闭软件或下次打开时自动安装，Mac 上在电脑空闲时通常也会自动完成安装。首页工具卡片上的「可更新到 v…」针对的是对应 AI 工具。',
        bullets: ['自动安装前，右下角将弹出通知；Windows 将弹出授权窗口，请点击「是」。', '如需立即安装：进入「设置」›「版本更新」，点击「下载更新」，下载完成后请先保存工具中未完成的工作，再点击「重启并安装」。'],
        expected: '重新打开后，「设置 › 版本更新」显示「已是最新版本」。',
        extra: [
          { title: '不想让它自动装？', detail: '在「设置」›「版本更新」中关闭「自动下载更新」后，有新版本时将先提醒您，由您手动安装。如未显示此开关，表示本机仅支持手动更新。' },
          { title: '自动安装失败？', detail: '例如在授权窗口点击了「否」：下次打开时将提示上次安装失败及原因，点击「重新安装」即可，不会每次打开都自动弹出授权窗口。' },
          { title: 'AI 工具更新后用着不对劲？', detail: '通过星芒更新过的 Claude Code、Codex CLI，可在首页对应工具卡片的「…」中选择「回退到更新前的 v…」，确认后将恢复为原版本；更新 14 天后此选项将自动消失。' },
          { title: '更新失败怎么办？', detail: '请查看提示中的原因（磁盘已满、被安全软件拦截、安装包损坏），处理后点击提示中的按钮重试。星芒的版本与 Codex 等工具的版本相互独立，请勿混淆。' },
          { title: updateDiskCleanupTitle, detail: updateDiskCleanupDetail },
          { title: macKeychainTutorialTitle, detail: macKeychainTutorialDetail },
        ],
        action: '打开版本更新',
        page: 'settings',
        section: 'version',
      },
      {
        title: '知道哪些数据需要另外保存',
        where: '设置 › 隐私数据；自己的项目文件夹',
        detail: '换电脑或清理文件前，单独保留项目和重要资料。',
        bullets: ['找到自己的项目目录和画布项目目录。', '分别确认配置、对话和登录信息如何保留。'],
        expected: '知道哪些文件要另外备份。',
        action: '查看隐私数据设置',
        page: 'settings',
        section: 'privacy',
      },
    ],
  },
  {
    id: macRuntimeTutorialTopic,
    title: 'Mac 上准备 Node.js 和 Python',
    lead: '仅使用 Codex 桌面端可跳过此步骤。Node.js 可在首页一键准备；如需安装 Python 或自行安装 Node.js，请参阅后续两种安装方式。',
    category: 'tools',
    minutes: 4,
    keywords: ['Mac', 'macOS', '苹果', 'CLI', '命令行', 'Node.js', 'npm', 'Python', 'Homebrew', 'brew', 'pkg', '环境'],
    steps: [
      {
        title: '先看首页缺哪一个',
        where: '星芒首页 › 运行环境',
        detail: '命令行工具需要 Node.js。命令行工具均不需要 Python，仅个别插件需要。',
        bullets: ['查看哪一项未显示版本号。', '仅安装需要的环境，已安装的无需重复安装。'],
        expected: '知道这次缺少 Node.js 还是 Python。',
        illustration: 'install',
        action: '返回首页看环境',
        page: 'home',
      },
      {
        title: `Node.js：点「${runtimeButtonLabel('node', 'managed')}」`,
        where: '星芒首页 › 运行环境',
        detail: '星芒将下载官方版本并放在专用文件夹中，无需输入开机密码，也不影响本机其他软件。安装命令行工具时如缺少 Node.js，也将自动准备。',
        bullets: ['点运行环境卡里的按钮，等它下载、核对、解压完。', '如本机已安装 Node.js，星芒将继续使用您已有的版本。'],
        expected: 'Node.js 一行显示版本号，无需再点击「重新检测」。',
        action: '返回首页准备 Node.js',
        page: 'home',
      },
      {
        title: '想自己装：装过 Homebrew 的走这条',
        where: 'Mac 终端 → 安装命令',
        detail: `Node.js 使用 ${runtimeHomebrewCommand('node')}，Python 使用 ${runtimeHomebrewCommand('python')}。星芒不会代为执行此命令。`,
        bullets: ['打开 Mac 自带的「终端」：按 Command + 空格，输入「终端」后回车。', '只粘贴缺少的那项命令，回车并等它完成。'],
        example: `${runtimeHomebrewCommand('node')}\n${runtimeHomebrewCommand('python')}`,
        expected: '所需安装命令执行完成，且无失败提示。',
        extra: [{ title: '不知道 Homebrew 是什么？', detail: 'Homebrew 是在「终端」中输入一行命令即可安装软件的工具。如未使用过，可直接选择下一步的官网安装包方式；星芒不会代为执行命令，也不会在软件内要求输入管理员密码。' }],
        action: '返回首页查看安装提示',
        page: 'home',
      },
      {
        title: '自行安装：未安装 Homebrew 时使用此方式',
        where: '星芒首页 › 运行环境 › 官网下载',
        detail: `Python 点「${runtimeButtonLabel('python', 'external')}」，Node.js 到它的官网下载，都选 macOS 的 .pkg 安装包。`,
        bullets: ['Node.js 选 LTS 版本，下载对应安装包。', '双击安装包，按安装器提示完成。'],
        expected: '安装器提示完成，且无失败提示。',
        extra: [{ title: '点击官网按钮后未开始安装？', detail: '该按钮仅打开官网，下载和运行安装包需手动完成。' }],
        action: '返回首页打开官网',
        page: 'home',
      },
      {
        title: '装完回来重新检测',
        where: '星芒首页 › 重新检测',
        detail: '装完回星芒，让它再找一次新安装的环境。',
        bullets: ['点「重新检测」，查看对应环境的版本号。', '如仍未识别，请重新打开终端和星芒后再次检测。'],
        expected: '环境显示版本号，可以继续安装命令行工具。',
        extra: [{ title: '重开后仍找不到？', detail: '进入「检查」查看具体环境结果，把错误和已安装版本提供给客服。' }],
        action: '打开检查',
        page: 'health',
      },
    ],
  },
  {
    id: macDesktopTutorialTopic,
    title: 'Mac 上装桌面端',
    lead: 'Codex 桌面端、Claude Desktop 和 OpenCode 可在首页点击「安装」完成安装，安装后返回星芒检测和配置。无需全部安装。',
    category: 'tools',
    minutes: 4,
    keywords: ['Mac', 'macOS', '苹果', 'Codex', 'ChatGPT', 'Claude Desktop', 'OpenCode', '桌面端', '安装指南', '一键安装', 'dmg', 'pkg', '应用程序', 'arm64', '检测不到'],
    steps: [
      {
        title: '选择要使用的桌面端',
        where: '星芒首页 › 对应桌面端 › 安装 / 安装指南',
        detail: '点击 Codex 桌面端、Claude Desktop 或 OpenCode 的「安装」，星芒将下载官方安装包并放入「应用程序」，安装后请直接查看第 4 步。',
        bullets: ['选择 Codex 桌面端、Claude Desktop 或 OpenCode。', '已显示版本号的无需重新安装，请直接查看第 4 步。'],
        expected: '知道这次要安装哪个应用。',
        extra: [
          { title: '一键安装失败怎么办？', detail: '请按第 2、3 步手动安装。安装桌面端不会改动已安装的命令行工具。' },
          { title: 'Codex 桌面端安装后为何名为 ChatGPT？', detail: 'OpenAI 的 Mac 版 Codex 桌面端在「应用程序」中名为 ChatGPT。如「应用程序」中已有旧版 ChatGPT（原聊天程序），请先将其移到废纸篓，再点击「安装」。' },
          { title: '装到哪里去了？', detail: '管理员账号安装到「应用程序」；非管理员账号安装到个人文件夹中的「应用程序」，星芒均可识别。' },
        ],
        action: '回首页选择桌面端',
        page: 'home',
      },
      {
        title: '去对应官网下载 Mac 版',
        where: '浏览器 → 对应应用的官方下载页',
        detail: '展开下方应用名称，找到对应官网来源。',
        bullets: ['请下载 macOS 桌面端安装包，不要选择命令行版本。', 'Apple 芯片的 Mac 选择 Apple Silicon（arm64）版本。'],
        expected: '得到所选应用的 Mac 安装包。',
        extra: [
          { title: 'Codex 桌面端', detail: '在 OpenAI 的 ChatGPT 下载页查找 Mac 安装包；安装后可能名为 Codex 或 ChatGPT，星芒均可识别对应的官方应用。' },
          { title: 'Claude Desktop', detail: '到 Claude 官网的下载页选择 macOS 版桌面应用。' },
          { title: 'OpenCode', detail: '到 OpenCode 官网下载 macOS 桌面端，注意与同名命令行版本区分。' },
        ],
        action: '回首页核对应用名称',
        page: 'home',
      },
      {
        title: '装进「应用程序」文件夹',
        where: '下载好的安装包 → 应用程序',
        detail: '仅下载或直接打开安装包，并不代表已完成安装。',
        bullets: ['.dmg：双击打开，把应用图标拖入「应用程序」。', '.pkg：双击，按系统安装器提示完成。', '保留官方应用名，不要改名；首次打开按 macOS 的提示操作。'],
        expected: '可在「应用程序」中找到并打开该应用。',
        extra: [
          { title: '放在下载文件夹为什么找不到？', detail: '这些桌面端的检测使用系统或当前用户的「应用程序」目录。不要只留在「下载」文件夹或安装镜像里运行，也不要改掉官方应用名。' },
          { title: '为什么安装时问密码？', detail: '安装 .pkg 时 macOS 可能要求一次系统登录密码，这是系统安装器的提示；星芒本身不要求管理员权限。' },
        ],
        action: '回首页准备重新检测',
        page: 'home',
      },
      {
        title: '重新检测，确认已连好',
        where: '星芒首页 › 重新检测 › 对应桌面端卡片',
        detail: '先确认显示版本号。卡片左下角写着「当前账号」的，直接打开即可。',
        bullets: ['点「重新检测」，核对对应桌面端的版本和配置状态。', '显示「待连接」时，请点击「确认连接」，选择密钥来源，再点击「检测模型」，选择模型并保存。', '打开应用，发一个简单问题确认能回复。'],
        expected: '桌面端使用当前账号配置，并能正常回复。',
        extra: [
          { title: 'Claude Desktop 保存后未生效？', detail: '先保存当前工作，把 Claude Desktop 完全退出，再重新打开，让它读取新配置。' },
          { title: 'Codex 桌面端和 Codex CLI 为什么一起变了？', detail: 'Codex 桌面端与 Codex CLI 共用一份配置。配好其中一个，另一个也会使用这份设置。' },
          { title: '重新检测后仍显示未安装？', detail: '先确认应用真的放在「应用程序」目录里、仍使用官方名称，并且能从那里打开。仍失败时到「检查」查看具体原因。' },
        ],
        action: '回首页检测并配置',
        page: 'home',
      },
    ],
  },
  // Claude Code 的「退回」在 2.1.319 安装包里核过：/rewind（别名 /undo）、连按两下 Esc，选项是英文的
  // Restore code and conversation / Restore code。Codex CLI 0.167.0 的命令表里没有撤回（旧的留底功能只剩
  // 「跳过旧记录」），所以只能劝客户先留一份。两边都没真机演过。
  {
    id: 'undo',
    title: 'AI 修改出错，如何撤回？',
    lead: 'Claude Code 可恢复到修改前的状态；通过终端命令或其他工具所做的修改无法恢复，重要文件夹请提前备份。',
    category: 'trouble',
    minutes: 2,
    keywords: ['撤回', '撤销', '退回', '还原', '恢复', '改坏了', '改错了', '回到之前', 'rewind', 'undo', 'Esc', '留一份', '复制文件夹'],
    steps: [
      {
        title: 'Claude Code：连按两下 Esc，退回到改之前',
        where: 'Claude Code 的终端窗口',
        detail: '在输入框为空时连按两下 Esc，或输入 /rewind 后回车，将列出您发送过的每条消息。',
        bullets: ['用上下键选到改坏之前的那一句，回车。', '选「Restore code and conversation」，文件和对话一起退回去；只想退文件，选「Restore code」。'],
        expected: 'Claude Code 改过的文件回到那一句之前的样子。',
        action: '回首页打开 Claude Code',
        page: 'home',
      },
      {
        title: '在终端里跑命令改的，退不回来',
        where: 'Claude Code、Codex、Grok 均适用',
        detail: '恢复仅针对 Claude Code 直接修改的文件。通过终端命令删除、移动或安装的内容无法恢复。',
        bullets: ['修改重要文件夹前，请先将整个文件夹复制到其他位置。'],
        expected: '重要文件夹已在其他位置备份。',
        action: '回首页',
        page: 'home',
      },
      {
        title: 'Codex：不支持一键撤回',
        where: 'Codex CLI',
        detail: 'Codex CLI 不提供一键撤回修改的命令。修改出错时，请从备份中恢复文件，或直接要求它「撤销刚才的修改」。',
        expected: '文件回到改之前的样子。',
        action: '回首页打开 Codex CLI',
        page: 'home',
      },
    ],
  },
  {
    id: 'messages',
    title: '出现此提示怎么办',
    lead: '找到界面上的原话，展开对应说明，再按提示处理。',
    category: 'trouble',
    minutes: 4,
    keywords: ['报错', '提示', '安装失败', '更新失败', '登录过期', '密钥失效', '余额', '证书', '网络', '配置被改过', '检测失败', '文件夹', '日志'],
    steps: [
      {
        title: '无法安装或更新',
        where: '失败提示 › 查看日志；反馈与客服 › 运行日志',
        detail: '先记录失败提示，再展开下面同名的说明。',
        bullets: ['确认失败的是星芒更新，还是某个 AI 工具的安装。', '按对应原因处理后再重试，不要连续重复点击安装。'],
        expected: '安装继续进行，或日志里有明确的失败原因。',
        extra: [
          { title: errors.diskFull.title, detail: '清理系统盘和安装目录所在磁盘的空间。可以复制界面提供的路径，看安装目录在哪个盘。' },
          { title: errors.permission.title, detail: '检查当前用户是否能写入安装目录，以及安全软件是否拦截。本软件以普通权限运行，不会自动提权。' },
          { title: errors.installBlocked.title, detail: '检查杀毒软件的隔离记录；确认文件可信后恢复，并将可信的安装目录加入信任。' },
          { title: errors.toolRunning.title, detail: '正在使用的工具占用了文件。先保存工作并关闭对应工具窗口，再重试。' },
          { title: errors.downloadTimeout.title, detail: '已经安装的工具不受这次下载失败影响。检查网络后点「重试」。' },
        ],
        action: '查看安装与更新结果',
        page: 'feedback',
        section: 'log',
      },
      {
        title: '无法连接或登录',
        where: '左侧检查 › 连接自检',
        detail: '按错误区分网络、登录、密钥和余额问题。',
        bullets: ['点「重新检查」，再测试当前连接。', '请找到下方同名提示，处理后返回原工具重试。'],
        expected: '连接测试恢复正常，或已取得需要交给客服的错误信息。',
        illustration: 'health',
        extra: [
          { title: errors.tlsIntercepted.title, detail: '企业网络或安全软件可能替换了连接证书。尝试手机热点等其他网络，或请网络管理员处理证书拦截。' },
          { title: errors.certDate.title, detail: '请在系统设置中开启日期、时间和时区自动同步；如仍报错，请更换网络后重试。' },
          { title: errors.timeout.title, detail: '检查网络，稍后重试。已经安装的工具仍保留，但调用 AI 仍需要可用的网络连接。' },
          { title: errors.tooManyRequests.title, detail: '请暂停连续点击，稍后重试。已安装的工具和已保存的配置不会因此清除。' },
          { title: errors.sessionExpired.title, detail: '重新登录。已写入工具的密钥不会因星芒登录过期而清除；重新登录前，余额和用量不能正常更新。' },
          { title: errors.keyInvalid.title, detail: '确认当前登录的是要使用的账号，再按提示点「一键修复」，用当前账号重新写入密钥。' },
          { title: errors.noBalance.title, detail: '请前往个人中心充值，确认余额到账后重试。' },
        ],
        action: '检查当前连接',
        page: 'health',
      },
      {
        title: '命令行工具里报错',
        where: 'Claude Code、Codex CLI、Grok CLI 的终端窗口',
        detail: '找到报错里的关键词，按下面的说明处理。',
        bullets: ['如提示运行 /login 或重新登录，请勿照做：该操作针对官方账号，执行后会破坏当前账号的配置。', '请先前往个人中心查看余额和该密钥的额度，处理后返回工具重新发送。', '星芒管的是 Windows 这一侧；要用 AI 工具请在 Windows 的终端里打开，WSL 里的需要单独配置。'],
        expected: '充值或调高额度后，在工具中重新发送即可恢复，无需重新安装或重新写入密钥。',
        extra: [
          { title: '「用户额度不足」或「Insufficient account balance」', detail: '当前账号余额已用尽。Claude Code 此时会显示「Please run /login · API Error: 403 用户额度不足」，Codex 显示「unexpected status 403 Forbidden: 用户额度不足」，Grok CLI 的报错中也包含这几个字。请勿输入 /login，请前往个人中心充值，到账后重新发送。' },
          { title: '「token quota is not enough」「API key 额度已用完」或「Quota exceeded」', detail: '该密钥设置的额度上限已用尽，或剩余额度不足以完成本次请求。Claude Code 同样会提示运行 /login，请勿照做。请前往「个人中心 › 密钥管理」调高上限后重新发送：软件自动配置的工具，在「每个工具的额度上限」中修改；自行创建的密钥，在下方列表中点击「…」›「编辑」修改。' },
          { title: '「401 无效的令牌」或「Authentication required … Run /login」', detail: '密钥已失效，或该密钥的额度上限已用尽（两种情况提示相同）。Claude Code 会先自动重试约 3 分钟后才显示。请先在「个人中心 › 密钥管理」查看该密钥的剩余额度（软件自动配置的工具请查看上方「每个工具的额度上限」），已用尽请调高；如非额度问题，请在「检查」页点击「重新写入密钥」。' },
        ],
        action: '查看余额与额度',
        page: 'account',
      },
      {
        title: '首页和打开文件夹时',
        where: '星芒首页 › 工具状态或文件夹提示',
        detail: '状态提醒不一定表示需要重装，请先确认提示针对的是配置还是文件夹。',
        bullets: ['找到下面与首页一致的提示。', '自己有意改过配置时，先核对内容，再决定是否重新写入。'],
        expected: '工具使用正确的配置，文件任务在选定的项目内进行。',
        extra: [
          { title: statuses.tool.configChanged[0], detail: '配置已被其他程序或手动修改，可能不再包含当前账号的密钥。如需使用星芒配置，请点击卡片上的「重新写入密钥」；如该修改为您有意为之，请在「…」中选择「保留当前配置」。' },
          { title: statuses.tool.codexShadowed[0], detail: '原有 Codex 设置中有一项 Codex 无法识别，显示已连接，但打开时会提示密钥无效。登录或打开软件时通常会自动修复；未修复的，请点击卡片上的「立即修复」，或直接点击「打开」，软件将先备份原设置（可在「设置 › 备份迁移」中找回），再进行修复。Codex CLI 与 Codex 桌面端共用一份设置，将同时修复。' },
          { title: statuses.tool.cliHooksStale[0], detail: '软件写入工具的提醒设置（完成或出错时通知、运行时阻止电脑休眠）仍指向原位置，常见于卸载后更换文件夹重装、移动过软件或重新安装过 Node.js。工具仍可使用，但每次会多显示一行错误。软件打开时将自动修复：先备份原设置（可在「设置 › 备份迁移」中找回），再仅修改相关几行。未自动修复，或该设置并非软件为当前账号写入时，卡片上将显示「立即修复」，点击即可修复。' },
          { title: statuses.tool.otherSiteKey[0], detail: '该工具中的密钥不属于当前账号，无法在此打开。点击卡片上的「改用当前账号」即可使用，修改前将先备份原设置（可在「设置 › 备份迁移」中找回）。Codex CLI 与 Codex 桌面端共用一份设置，将同时修改。' },
          { title: statuses.tool.otherAccountKey[0], detail: '工具可以使用，但无法确认该密钥属于当前账号，用量可能计入其他账号（常见于在同一台电脑上切换账号登录）。请点击卡片上的「改用当前账号」切换为您的账号，修改前将先备份。' },
          { title: statuses.tool.ccSwitch[0], detail: '该工具曾通过 CC Switch 配置，目前仍连接 CC Switch 中选择的服务。点击卡片上的「改用当前账号」将先备份原设置（可在「设置 › 备份迁移」中找回），再切换为当前账号；如需继续使用 CC Switch，请在「…」中选择「保留当前配置」。如不再使用 CC Switch，请将其退出，以免设置被改回。' },
          { title: statuses.tool.detectionFailed[0], detail: '检测失败不代表未安装。请先查看具体原因，处理后重新检测。' },
          { title: '该文件夹范围过大', detail: '用户主目录、磁盘根目录、桌面、下载、文档等范围过大，请改选具体的项目文件夹，或直接点击提示中的「新建项目文件夹」。如仍选择本次打开，不会将该目录标记为可信，也不会自动生成项目说明。' },
        ],
        action: '回首页查看具体提示',
        page: 'home',
      },
      {
        title: '仍无法解决？',
        where: '检查 › 去处理；反馈与客服',
        detail: '先让检查页定位问题，再把失败位置和报告提供给客服。',
        bullets: ['在检查页按「去处理」完成建议操作。', '环境问题和安装失败都看「反馈与客服」的运行日志。', '预览反馈报告，核对后复制或下载，连同操作步骤和截图交给客服。'],
        expected: '客服拿到具体错误和排查结果，能够继续定位。',
        extra: [{ title: '反馈报告里有什么？', detail: '报告会带上次连接自检结果并自动脱敏。发送前仍要预览，确认截图和补充文字不含完整密钥、密码或无关项目资料。' }],
        action: '预览反馈报告',
        page: 'feedback',
      },
    ],
  },
  {
    id: 'trouble',
    title: '出问题怎么办',
    lead: '请找到与您相同的情况，按对应步骤处理。出错时无需重装所有工具。',
    category: 'trouble',
    minutes: 4,
    keywords: ['Codex', '桌面端', '安装', '未识别', '没检测到', '当前账号', '待连接', '英文', '中文', '报错', '失败', '打不开', '不回复', '检查', '诊断', '网络', '密钥', '余额', '额度', '反馈', '客服'],
    steps: [
      {
        title: '已安装但未识别：请先确认应用和系统账号',
        where: '星芒首页 › Codex 桌面端 › 重新检测',
        detail: '先确认电脑能打开 Codex 桌面端，再重新检测。装了 Codex CLI 不代表装了桌面端。',
        bullets: ['Windows 用安装 Codex 的同一个系统用户。', 'Mac 确认「应用程序」里的 ChatGPT 能打开。', '点「重新检测」，记下仍然出现的错误。'],
        expected: '已获取桌面端状态，或已取得具体检测错误。',
        extra: [{ title: '检测失败或安装失败在哪里看？', detail: '检测失败不等于未安装。安装日志在「反馈与客服」的运行日志里；记录系统、Codex 版本和错误，不必重装 Node.js 或 Python。' }],
        action: '回首页重新检测 Codex',
        page: 'home',
      },
      {
        title: '已连接但无法打开：查看启动结果',
        where: '星芒首页 › Codex 桌面端 › 打开',
        detail: '卡片左下角显示「当前账号」「官方账号」或「自己的密钥」，表示设置已保存，还需点击「打开」启动 Codex。',
        bullets: ['提示已运行时选「打开窗口」。', '刚修改过配置时，请先保存任务，再选择「重开 Codex」（Mac 上请先按 ⌘Q 退出 Codex，再点击「打开」）。', '其他错误记下原文，不要连续重复点击。'],
        expected: '看到 Codex 窗口，或取得明确启动错误。',
        extra: [{ title: '可以打开，但仍为英文界面？', detail: '中文界面仅在从星芒打开 Codex 时生效。直接点击 Codex 自身的图标（Mac 上名为 ChatGPT）打开时为英文界面：请关闭该窗口，从星芒首页点击「打开」，或点击右下角（Mac 在屏幕顶部）的星芒图标 ›「已安装的工具」›「Codex 桌面端」。如从星芒打开仍为英文，请在桌面端「配置」›「界面语言与文件夹权限」中点击「启用中文界面」。启用时可能重新打开 Codex，请先保存工作。' }],
        action: '回首页检查 Codex 打开结果',
        page: 'home',
      },
      // 桌面端的「聊天」「工作」是 ChatGPT 账号的功能（OpenAI 文档：用密钥登录时 ChatGPT Work 不可用），
      // 用密钥时只有「Codex」那一栏走得通，在那两栏里发会弹「提交消息时出错」加一句英文（2026-10-18 客户报）。
      // 落在首页，Linux 版教程按 page 过滤掉这一步。
      {
        title: '发消息报「提交消息时出错」：换到「Codex」里发',
        where: 'Codex 桌面端窗口（也叫 ChatGPT）→ 左侧栏最上面的模式 →「Codex」',
        detail: '提示下方显示「Work browser access requires an authenticated account」，表示消息发送到了「ChatGPT」的「聊天」或「工作」中。这两项需登录 ChatGPT 账号才能使用，Codex 使用当前账号或自己的密钥时无法发送，与密钥、余额和网络无关。',
        bullets: ['在左侧栏最上面把模式切到「Codex」，开始新对话。', '将未发送的内容粘贴到「Codex」中重新发送即可，无需重新安装或修改设置。'],
        expected: 'Codex 正常回复。',
        extra: [{ title: '就想用「聊天」「工作」？', detail: '如需使用您自己的 ChatGPT 账号：在首页 Codex 桌面端卡片的「…」›「配置…」中选择「ChatGPT 账号」并保存，再在 Codex 中登录 ChatGPT 账号。此时使用的是您的 ChatGPT 订阅，不扣除当前账号余额；如需切回，在同一位置选择「当前账号」。' }],
        action: '回首页打开 Codex',
        page: 'home',
      },
      {
        title: '能打开但不回复：测试当前连接',
        where: '左侧检查 › 连接自检 › 测试连接',
        detail: '测试当前配置能不能用，再按结果修正。',
        bullets: ['请先点击「重新检查」，再点击「测试连接」。', '按「去处理」修正密钥、模型、额度或网络问题。', '改配置后重开 Codex，再发一个简单问题。'],
        expected: 'Codex 能正常返回回复。',
        extra: [{ title: '官方账号、取消提示或可选环境', detail: '使用 ChatGPT 账号时，请在 Codex 内确认官方登录状态和额度。主动停止产生的取消提示不代表请求故障；暂不使用的可选环境无需立即安装。' }],
        illustration: 'health',
        action: '打开检查测试 Codex 连接',
        page: 'health',
      },
      {
        title: '预览报告后联系客服',
        where: '反馈与客服 › 预览反馈报告',
        detail: '把「点了哪里、出现什么」和报告一起提供给客服。',
        bullets: ['预览报告，核对后复制或下载。', '通过右上角「帮助与客服」发送报告、报错截图和操作步骤。'],
        expected: '客服能看清问题发生的位置和错误信息。',
        extra: [{ title: '发报告前检查什么？', detail: '报告会自动脱敏，截图和自己补充的文字仍要核对；不要发送完整密钥、账号密码或无关项目资料。' }],
        action: '打开反馈并预览报告',
        page: 'feedback',
      },
    ],
  },
];

/*
 * Linux 版教程（Linux 版拆分 ⑩）。Linux 上没有 Codex 桌面端，Mac 专属的两章
 * 也用不上；第一章换成 Codex CLI（和新手引导在 Linux 上的推荐项同一个），更新那一步换成
 * 「交给系统安装窗口」的说法，和「设置 › 版本更新」、退出确认、必须更新提示同一口径（#760）。
 * 其余章节原样沿用，只删掉几句讲 Codex 桌面端的话。Windows 和 Mac 拿到的还是上面那份。
 */
const linuxHiddenTutorialTopics: ReadonlySet<string> = new Set(['install', 'config', 'launch', macRuntimeTutorialTopic, macDesktopTutorialTopic]);

const linuxStartTutorial: TutorialTopic = {
  id: 'start',
  title: '首次使用？请按以下 4 步操作',
  lead: '星芒将为您安装并配置 Codex CLI。按步骤操作，最后在终端窗口中发送第一条消息。',
  category: 'start',
  minutes: 5,
  keywords: ['新手', '入门', '第一次', '不会用', '安装', '登录', '首页', 'Codex', 'Codex CLI', '命令行', '终端'],
  steps: [
    signInTutorialStep,
    {
      title: '安装 Codex CLI',
      where: '星芒首页 › Codex CLI',
      detail: '请找到「Codex CLI」卡片。已显示版本号的无需重复安装。',
      bullets: ['点「安装」，等进度和账号同步结束。', '缺少 Node.js 时星芒将自动准备，无需输入开机密码，也无需手动下载。'],
      expected: 'Codex CLI 显示已安装版本。',
      illustration: 'install',
      action: '去首页找 Codex CLI',
      page: 'home',
    },
    {
      title: '看到「当前账号」就继续',
      where: '星芒首页 › Codex CLI 卡片 › 左下角',
      detail: '星芒通常会自动配好。卡片左下角写着「当前账号」就看第 4 步；写着「待连接」时，才需要下面的操作。',
      bullets: ['点卡片上的「确认连接」，选择「当前账号」。', '如需准备密钥，请选择「自动准备（推荐）」；密钥是工具调用 AI 时使用的凭证。', '点击「保存并检测」，完成后点击「完成」；您在工具中的其他设置将保持不变。'],
      expected: 'Codex CLI 卡片左下角显示「当前账号」。',
      illustration: 'config',
      action: '去首页看是否已连好',
      page: 'home',
    },
    {
      title: '打开 Codex 并发送第一条消息',
      where: '星芒首页 › Codex CLI「打开」→ 终端窗口',
      detail: '点击「打开」，首次打开将自动新建项目文件夹，随后弹出终端窗口并启动 Codex。请先提一个简单问题。',
      bullets: ['想自己挑文件夹，在卡片的「…」里点「选择其他文件夹…」。', '等终端里的 Codex 启动好，输入下面这句话并回车，等它回复。'],
      example: '你好，请用中文告诉我你能帮我做什么。',
      expected: 'Codex 返回完整回复后，即可开始使用。',
      illustration: 'launch',
      action: '回首页打开 Codex',
      page: 'home',
    },
  ],
  reminders: firstUseReminders,
};

const linuxRuntimeTutorialStep: TutorialStep = {
  title: '选择命令行工具，检查运行环境是否齐全',
  where: '星芒首页 › 运行环境',
  detail: '点击工具的「安装」时，缺少的 Node.js 将自动准备并放在星芒专用文件夹中，无需输入开机密码，也无需手动下载。',
  bullets: ['运行环境卡片中 Node.js 一行显示版本号，即表示已准备就绪。'],
  expected: '所需运行环境显示版本号。',
  extra: [{ title: 'Claude Code 为什么提示 Git？', detail: `部分技能、插件中的命令以及首次添加官方插件市场需要 Git。如未安装，请打开「终端」，输入 ${gitLinuxInstallCommand} 后回车，提示输入密码时输入开机密码（屏幕上不显示，输入完成后回车）。` }],
  illustration: 'install',
  action: '去首页看运行环境',
  page: 'home',
};

const linuxSelfUpdateTutorialStep: TutorialStep = {
  title: '星芒自己更新，AI 工具在首页更新',
  where: '设置 › 版本更新；首页 › 工具卡片上的「可更新到 v…」',
  detail: '星芒的新版本将在后台下载，下载完成后提醒您点击「安装新版本」；首页工具卡片上的「可更新到 v…」针对的是对应 AI 工具。',
  bullets: ['点击「安装新版本」后，星芒将先关闭，再打开本机的安装窗口：请在其中点击「安装」并输入开机密码。', '安装完成后，请从应用菜单重新打开星芒。'],
  expected: '重新打开后，「设置 › 版本更新」显示「已是最新版本」。',
  extra: [
    { title: '不想让它在后台下载？', detail: '在「设置」›「版本更新」中关闭「自动下载更新」后，有新版本时将先提醒您，由您手动下载。如未显示此开关，表示本机仅支持手动更新。' },
    { title: '点击「安装新版本」后未看到安装窗口？', detail: '安装窗口可能被其他窗口遮挡，请在任务栏或屏幕顶部查找。' },
    { title: 'AI 工具更新后用着不对劲？', detail: '通过星芒更新过的 Claude Code、Codex CLI，可在首页对应工具卡片的「…」中选择「回退到更新前的 v…」，确认后将恢复为原版本；更新 14 天后此选项将自动消失。' },
    { title: '更新失败怎么办？', detail: '请查看提示中的原因（磁盘已满、网络中断、安装包损坏），处理后点击提示中的按钮重试。星芒的版本与 Codex 等工具的版本相互独立，请勿混淆。' },
    { title: updateDiskCleanupTitle, detail: `${linuxUpdateDiskCleanupSteps}清出空间后，「自动下载更新」开着会自己下载，关着就到「设置 › 版本更新」点「下载更新」。` },
  ],
  action: '打开版本更新',
  page: 'settings',
  section: 'version',
};

const linuxLaunchTroubleTutorialStep: TutorialStep = {
  title: '点击「打开」后未看到终端窗口',
  where: '星芒首页 › 工具的「打开」',
  detail: '命令行工具将在本机的终端窗口中启动。如未出现窗口，请先检查是否被其他窗口遮挡，再查看首页是否有错误提示。',
  bullets: ['有出错提示就按提示里的按钮处理，不要连续重复点击。', '卡片左下角显示「当前账号」「官方账号」或「自己的密钥」，仅表示设置已保存，还需点击「打开」才会启动。'],
  expected: '终端窗口中工具已启动，或已获得明确的错误提示。',
  action: '回首页打开工具',
  page: 'home',
};

// 沿用的章节里只有这几句讲 Codex 桌面端和 Claude Desktop（两个都没有 Linux 版），外加 Windows 上 WSL 那句，Linux 上删掉。
// 原文改了这里就对不上，tutorials.test.ts 会因 Linux 版里又出现「桌面端」「Claude Desktop」「WSL」而失败。整条要点删空了就不留那一行。
const linuxRemovedTutorialSentences = [
  'Codex 桌面端同理；Claude Desktop 需完全退出后重新打开。',
  'Codex CLI 与 Codex 桌面端共用一份设置，将同时修复。',
  'Codex CLI 与 Codex 桌面端共用一份设置，将同时修改。',
  'Codex CLI 与桌面端共用配置，修改会影响两者；',
  'Claude Desktop 仅更换登录方式（同样先备份），不自动测试。',
  'Claude Desktop 原来那份配置用不上时（比如换过星芒账号），会弹出「连接 Claude Desktop」，点「保存并检测」保存一次就改用当前账号。',
  'Claude Desktop 关闭窗口不等于退出：Mac 上请按 ⌘Q，Windows 上还需退出屏幕右下角托盘中的 Claude 图标。',
  'Claude Desktop：重新打开后，在它的登录页用 Claude 账号登录。用星芒时的聊天记录不会删，切回当前账号还能看到。',
  ' / Claude Desktop',
  '星芒管的是 Windows 这一侧；要用 AI 工具请在 Windows 的终端里打开，WSL 里的需要单独配置。',
] as const;

function withoutLinuxSentences(text: string): string {
  return linuxRemovedTutorialSentences.reduce((result, sentence) => result.split(sentence).join(''), text);
}

function linuxTutorialText(topic: TutorialTopic): TutorialTopic {
  return {
    ...topic,
    lead: withoutLinuxSentences(topic.lead),
    steps: topic.steps.map((step) => ({
      ...step,
      ...(step.where ? { where: withoutLinuxSentences(step.where) } : {}),
      detail: withoutLinuxSentences(step.detail),
      ...(step.bullets ? { bullets: step.bullets.map(withoutLinuxSentences).filter(Boolean) } : {}),
      ...(step.extra ? { extra: step.extra.map((entry) => ({ title: entry.title === '已有安装或正在使用 Codex 桌面端？' ? '已安装该工具？' : entry.title, detail: withoutLinuxSentences(entry.detail) })) } : {}),
    })),
  };
}

function linuxTutorialTopic(topic: TutorialTopic): TutorialTopic[] {
  if (topic.id === 'start') return [linuxStartTutorial];
  if (linuxHiddenTutorialTopics.has(topic.id)) return [];
  if (topic.id === cliTutorialTopic) {
    return [linuxTutorialText({
      ...topic,
      lead: '命令行工具是在终端窗口里和 AI 一起处理项目的方式。第一章走的是 Codex CLI，Claude Code 也是同样的装法。',
      steps: topic.steps.map((step) => step.illustration === 'install' ? linuxRuntimeTutorialStep : step),
    })];
  }
  if (topic.id === updatesTutorialTopic) {
    return [{
      ...topic,
      keywords: [...topic.keywords.filter((keyword) => !['Mac', '钥匙串', '始终允许', 'C 盘'].includes(keyword)), '安装窗口', '应用菜单'],
      steps: topic.steps.map((step) => step.page === 'settings' && step.section === 'version' ? linuxSelfUpdateTutorialStep : step),
    }];
  }
  if (topic.id === 'trouble') {
    return [{
      ...topic,
      keywords: topic.keywords.filter((keyword) => keyword !== '桌面端'),
      // 前两步讲的是 Codex 桌面端装没装上、打没打开。
      steps: [linuxLaunchTroubleTutorialStep, ...topic.steps.filter((step) => step.page !== 'home')],
    }];
  }
  return [linuxTutorialText(topic)];
}

const linuxTutorialTopics: readonly TutorialTopic[] = tutorialTopics.flatMap(linuxTutorialTopic);

/** 当前系统能看到的教程。Windows 和 Mac 是同一份（tutorialTopics 本身）。 */
export function tutorialTopicsFor(os: WindowOs): readonly TutorialTopic[] {
  return os === 'linux' ? linuxTutorialTopics : tutorialTopics;
}
