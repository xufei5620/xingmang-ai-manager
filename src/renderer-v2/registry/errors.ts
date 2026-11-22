import { toolCertificateMessages } from '../../../electron/network-failure';

// 标题不能是主进程原话里的一段：原话里已经有标题时，presentOperationError 当后台已经说过，
// 错误框的标题和按钮整个省掉。界面文案正式化第 3 批踩到过：「磁盘空间不足」正是装前查盘那句原话的一段，
// 所以磁盘那两类叫「磁盘可用空间不足」；主进程改字时同样别把这里的标题原样写进报错。
export const errors = {
  sessionExpired: { title: '登录已过期', body: '工具中已写入的密钥仍可使用，余额和用量暂停更新', actions: ['重新登录'] },
  keyInvalid: { title: '密钥失效', body: '工具无法发起对话，需要更换密钥', actions: ['一键修复'] },
  noBalance: { title: '余额已用尽', body: '所有请求将被拒绝，充值到账后立即恢复', actions: ['立即充值'] },
  tooManyRequests: { title: '请求次数过多', body: '请稍候几秒后重试', actions: ['重试'] },
  server: { title: '星芒服务器暂时异常', body: '已安装的工具可正常使用', actions: ['重试', '查看状态'] },
  serviceUnavailable: { title: '服务暂时不可用', body: '服务正在维护或线路繁忙，无需进行任何操作，请稍后重试。', actions: ['重试'] },
  timeout: { title: '网络连接失败', body: '已安装的工具不受影响。请检查网络后点击「重试」。', actions: ['重试', '检查网络'] },
  toolRunning: { title: '工具正在运行', body: '文件被占用。请关闭正在使用该工具的窗口后重试。', actions: ['重试', '查看日志'] },
  installBlocked: { title: '安装被杀毒软件拦截', body: '请打开杀毒软件，在「隔离区」或「恢复区」中恢复星芒后点击「重试」；如需协助，请点击「联系客服」。', actions: ['重试', '复制路径', '联系客服'] },
  downloadTimeout: { title: '下载超时', body: '下载未完成，已安装的工具不受影响。', actions: ['重试', '检查网络'] },
  downloadUnreachable: { title: '无法连接下载源', body: '本机暂时无法连接下载服务器，已安装的工具不受影响。请检查网络或切换网络（如手机热点）后点击「重试」。', actions: ['重试', '检查网络'] },
  downloadSourceError: { title: '下载源暂时异常', body: '下载服务器出现异常，与本机无关，已安装的工具不受影响。请几分钟后点击「重试」。', actions: ['重试', '查看日志'] },
  officialRegistryUnreachable: { title: '无法连接工具的官方下载站', body: '此步骤只能从官方下载站获取，国内下载站无法替代。已安装的工具不受影响。请按下方提示操作后点击「重试」。', actions: ['重试', '检查网络'] },
  diskFull: { title: '磁盘可用空间不足', body: '安装时文件会先下载到系统盘的临时文件夹，再安装到安装目录，两处所在磁盘均需留出空间，请清理后重试。', actions: ['复制路径', '重试', '查看日志'] },
  configDiskFull: { title: '磁盘可用空间不足', body: '配置文件所在磁盘（通常为系统盘）空间不足，原设置未作修改。请清理部分空间后点击「重试」。', actions: ['重试', '查看日志'] },
  // 导出检查报告、反馈报告、聊天记录、单段对话时存不进客户在保存框里选的位置（D16，yoyo 2026-11-10 批）。
  // 那儿不是安装目录，以前借「无法写入安装目录」「安装时先下到系统盘的临时文件夹」说，方向全错。
  // 红条上标题和正文用「，」连成一句，连起来就是批的那句话，拆的时候别改字。
  exportPermission: { title: '该位置不允许保存文件', body: '请选择其他文件夹（如「下载」）后重新导出。', actions: ['重试'] },
  exportDiskFull: { title: '该磁盘空间已满', body: '请清理部分空间或选择其他磁盘后重新导出。', actions: ['重试'] },
  certDate: { title: '证书日期校验失败', body: '通常是本机系统时间不准确，证书是否过期以本机时钟为准。请将系统时间设为自动同步并确认时区后重试；如时间无误，请切换网络。', actions: ['重试', '查看日志'] },
  tlsIntercepted: { title: '连接被网络拦截', body: '连接途中有网络设备替换了证书（运营商、公司或学校网络较常见）。请稍候一两分钟后重试；如仍失败，请切换网络（如手机热点），公司或学校网络请联系网络管理员。', actions: ['重试', '查看日志'] },
  toolCertOutdatedNode: { title: 'Node.js 版本过旧，无法识别本机证书', body: toolCertificateMessages.outdatedNode, actions: ['更新 Node.js', '重试', '查看日志'] },
  toolCertElevated: { title: '以管理员身份运行时，工具无法识别本机证书', body: toolCertificateMessages.elevated, actions: ['重试', '查看日志'] },
  // 打开工具时工具自己都读不了它的配置文件（features/tools/broken-config-launch.ts）。下面那句原话说是哪个工具、打开会怎样。
  configBroken: { title: '配置文件已损坏', body: '点击「立即修复」将先备份原文件，修复后自动打开。', actions: ['立即修复', '联系客服'] },
  configLink: { title: '配置文件为链接', body: '为保证安全，星芒不写入链接，原设置未作修改。请按下方提示将其改为普通文件后点击「重试」；如需协助，请点击「联系客服」。', actions: ['重试', '联系客服'] },
  folderRelocated: { title: '文件夹已被移动', body: '为保证安全，软件不写入已移动的文件夹。可在「检查」页查看具体文件夹，将其移回原位置即可恢复。', actions: ['打开检查页', '联系客服'] },
  elevationDeclined: { title: '未获得管理员授权', body: '本次未安装，本机未作任何修改。请按下方提示操作后点击「重试」；如仍失败，请点击「联系客服」。', actions: ['重试', '联系客服'] },
  permission: { title: '无法写入安装目录', body: '该文件夹不允许星芒写入，通常是被杀毒软件拦截。请点击「复制路径」查看具体文件夹，将其加入杀毒软件信任列表后点击「重试」；如仍失败，请点击「联系客服」。', actions: ['重试', '复制路径', '联系客服'] },
  configPermission: { title: '无法写入配置文件', body: '通常是被安全软件拦截，或该文件正被其他程序占用。请关闭正在使用该工具的窗口后点击「重试」；如仍失败，请点击「联系客服」。', actions: ['重试', '查看日志', '联系客服'] },
  // 主进程查得出是哪一种没权限时（electron/config-write-blocker.ts）各换一句，按钮照上一条不加。yoyo 2026-11-10 批的字（决定单 D15）。
  configAdminOwned: { title: '无法写入配置文件', body: '该工具的设置文件夹归管理员所有，通常是之前以管理员身份运行过该工具，星芒无法修改。请点击「复制给客服」，客服将指导您恢复。', actions: ['重试', '查看日志', '联系客服'] },
  configReadOnly: { title: '无法写入配置文件', body: '该文件已设为只读，星芒未作修改。如需写入，请先取消只读属性。', actions: ['重试', '查看日志', '联系客服'] },
  updateIntegrity: { title: '更新安装失败', body: '当前版本不受影响。', actions: ['重新下载', '查看日志'] },
  paymentClosed: { title: '支付窗口已手动关闭', body: '订单未取消。', actions: ['查看订单'] },
  paymentTimeout: { title: '订单已超时', body: '查询订单状态后可重新支付。', actions: ['重新支付'] },
  backupIntegrity: { title: '备份文件校验失败', body: '未做任何改动。', actions: ['选择其他备份', '联系客服'] },
  unsafeStorage: { title: '本机无法安全保存密码', body: '仅保留本次登录。', actions: ['知道了'] },
  noTray: { title: '关闭窗口会直接退出', body: '', actions: ['安装系统托盘扩展'] },
  toolNotEnabled: { title: '当前账号尚未开通该工具', body: '原设置未作修改。请联系客服开通后重试。', actions: ['联系客服'] },
  codexDesktopTooOld: { title: '本机无法安装 Codex 桌面端', body: '可先使用 Codex CLI；将 Windows 更新至最新版本后，再回到星芒安装桌面端。', actions: ['查看日志', '联系客服'] },
  // 主进程 codex-desktop-install-failure.ts 的 firewallOff 那一句（Windows 防火墙服务停着，0x800706D9）。yoyo 2026-11-08 批的字（「防火墙改」）。
  codexDesktopFirewallOff: { title: '需先开启 Windows 防火墙服务', body: '开启后才能安装 Codex 桌面端，该服务通常是被系统优化软件关闭的。请点击「联系客服」并将下方提示发送给客服，客服将指导您开启。', actions: ['查看日志', '联系客服'] },
  codexDesktopInstallNoStore: { title: 'Codex 桌面端安装未成功', body: '本机没有微软商店，星芒已尝试 OpenAI 官网离线安装包和国内线路。请先点击「重试」；如仍失败，请点击「联系客服」并将下方提示发送给客服。', actions: ['重试', '查看日志', '联系客服'] },
  codexDesktopInstallFailed: { title: 'Codex 桌面端安装未成功', body: '请先点击「重试」；如仍失败，请点击「前往微软商店安装」，在商店中点击「获取」完成安装后，回到星芒点击「重新检测」。', actions: ['重试', '前往微软商店安装', '查看日志', '联系客服'] },
  claudeDesktopInstallFailed: { title: 'Claude Desktop 安装未成功', body: '请先点击「重试」；如仍失败，请点击「下载离线安装包」，安装完成后回到星芒点击「重新检测」。', actions: ['重试', '下载离线安装包', '前往 Claude 官网', '查看日志', '联系客服'] },
  macDesktopTooOld: { title: '此 Mac 无法安装该桌面端', body: '请将 macOS 更新至下方提示中的版本后，再回到星芒点击「安装」。', actions: ['查看日志', '联系客服'] },
  macDesktopInstallFailed: { title: '桌面端安装未成功', body: '请先按下方提示操作；如仍失败，请点击「查看安装指南」，按教程从官网下载安装。', actions: ['重试', '查看安装指南', '查看日志', '联系客服'] },
  codexDesktopKnownIssue: { title: 'Codex 当前版本无法打开', body: '这是 Codex 当前版本自身的问题，与星芒无关，微软商店发布新版后将自动恢复。如需立即使用，请点击「改用 Codex 命令行版」。', actions: ['重试', '改用 Codex 命令行版', '联系客服'] },
  // 主进程 codex-desktop-known-issues.ts 的 codexDesktopActivationBrokenMarker：Windows 激活接口说没装、包却装着。
  // 重装、重置都救不了，重启才好，所以「立即重启」排第一、不给「重置 Codex」。yoyo 2026-11-21 批的字（「重启框改」）。
  codexDesktopActivationBroken: { title: 'Codex 未能启动', body: 'Codex 桌面端已安装，但 Windows 未能启动它。请保存当前工作后点击「立即重启」，重启后返回星芒重新打开；重新安装或重置通常无法解决此问题。如重启后仍无法打开，请点击「联系客服」并将下方提示发送给客服。', actions: ['立即重启', '重试', '联系客服'] },
  // 认不出原因的那一类：重启放在重置后面，不抢第一位。yoyo 2026-11-21 批的字（「加重启」）。
  codexDesktopNotStarted: { title: 'Codex 打开失败', body: '请先点击「重试」；如仍失败，请点击「重置 Codex」，重置后将自动重新打开；如仍无法打开，请点击「立即重启」，重启电脑后再试；如问题依旧，请点击「联系客服」并将下方提示发送给客服。', actions: ['重试', '重置 Codex', '立即重启', '联系客服'] },
  pluginCatalogStuck: { title: '插件目录暂时无法修改', body: '请重启电脑后重试；如仍失败，请联系客服。', actions: ['重试', '联系客服'] },
  // yoyo 2026-10-28 批的字（「停用改」）。
  featureSuspended: { title: '该功能已暂时停用', body: '我们已获知此问题，修复后将自动恢复，无需重新安装软件。', actions: ['联系客服'] },
  switchUndoFailed: { title: '未能自动恢复原设置', body: '请前往「设置 › 备份迁移」，恢复切换前的备份。', actions: ['前往备份迁移', '联系客服'] },
  gitMissing: { title: '本机尚未安装 Git', body: '安装插件需要 Git。请在首页「运行环境」中点击「安装 Git」，安装完成后返回点击「重试」。', actions: ['重试', '联系客服'] },
  githubUnreachable: { title: '无法连接 GitHub', body: '插件需从 GitHub 下载，本机当前无法连接，已安装的插件不受影响。请切换网络（如手机热点）后点击「重试」。', actions: ['重试', '联系客服'] },
  nameTaken: { title: '名称已存在', body: '该工具中已有同名项。请更换名称，或先移除原有项后再添加。', actions: ['联系客服'] },
  unknown: { title: '操作未完成', body: '', actions: ['重试', '查看日志', '联系客服'] },
} as const;
