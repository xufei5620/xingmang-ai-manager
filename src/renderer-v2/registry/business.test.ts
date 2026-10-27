import { describe, expect, it } from 'vitest';
import type { PlatformNotificationKind } from '../../../electron/platform/contract';
import type { UpdateFailedStep } from '../../../electron/ipc-contract';
import {
  accountSections,
  accountTabs,
  resolveAccountLanding,
  autoUpdateBubbleBody,
  autoUpdateSettingDescription,
  buildSettingsBlocks,
  notificationOptions,
  notificationSettingsItemId,
  searchSettingsItems,
  settingsGroupIcons,
  settingsGroups,
  settingsItemAvailable,
  settingsItemLabel,
  settingsItems,
  settingsSections,
  standardAccountUpdateNotice,
  standardAccountUpdateText,
  updateBubbleRepeatsUpdatesPage,
  updateBubbleTitle,
  updateCardTitle,
  updateDiskShortfallText,
  updateDownloadDetail,
  formatDownloadRemaining,
  updateFailureFallback,
  updateFailureLabel,
  updateFailureLabels,
  updateInstallNote,
  updateInstallActionLabel,
  updateNewVersion,
  updateStatusLabel,
  withdrawnVersionAdvice,
} from './business';

describe('account center tabs and landings', () => {
  // v4 把九个分页并成六个横排页签（字表批06）。
  it('lists the six v4 tabs in order', () => {
    expect(accountTabs.map((tab) => tab.label)).toEqual(['账号概览', '充值订阅', '用量账单', '密钥管理', '账号安全', '邀请返利']);
  });

  it('lands every former tab and moved entry on the tab that now holds it', () => {
    expect(resolveAccountLanding('orders')).toEqual({ tab: 'recharge', anchor: 'orders' });
    expect(resolveAccountLanding('tasks')).toEqual({ tab: 'usage', anchor: 'tasks' });
    expect(resolveAccountLanding('devices')).toEqual({ tab: 'security', anchor: 'devices' });
    expect(resolveAccountLanding('dashboard')).toEqual({ tab: 'usage' });
    expect(resolveAccountLanding('change-password')).toEqual({ tab: 'security', anchor: 'change-password' });
    expect(resolveAccountLanding('switch-account')).toEqual({ tab: 'overview', anchor: 'switch-account' });
    expect(resolveAccountLanding('edit-profile')).toEqual({ tab: 'overview', anchor: 'edit-profile' });
    expect(resolveAccountLanding('keys')).toEqual({ tab: 'keys' });
  });

  it('falls back to the overview for names it does not know, including inherited object keys', () => {
    for (const value of [undefined, '', 'wallet', 'toString', '__proto__']) {
      expect(resolveAccountLanding(value), String(value)).toEqual({ tab: 'overview' });
    }
  });

  it('keeps each landing name distinct from the tab names', () => {
    const tabValues: readonly string[] = accountTabs.map((tab) => tab.value);
    const values = accountSections.map((section) => section.value);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) expect(tabValues).not.toContain(value);
  });
});

describe('renderer-v2 notification settings registry', () => {
  // 设置页是 notificationOptions.map 渲染的，所以少一条就是「主进程会发这种通知，
  // 但用户在设置里关不掉」。这张表没有 default 分支，加第五种通知漏在这里是编译错。
  it('offers one switch per notification the main process can send', () => {
    const expected: Record<PlatformNotificationKind, true> = {
      install: true,
      balance: true,
      task: true,
      cliUpdate: true,
      announcement: true,
      spend: true,
      acceleration: true,
      cliTrouble: true,
      cliTurn: true,
    };
    expect([...notificationOptions.map(option => option.value)].sort())
      .toEqual(Object.keys(expected).sort());
  });

  it('describes the acceleration reminder without naming the relay site', () => {
    const option = notificationOptions.find(entry => entry.value === 'acceleration');
    expect(option?.label).toBe('加速提醒');
    expect(`${option?.label} ${option?.description}`).not.toMatch(/solov|new-api|relay|sub2api/i);
  });

  it('describes the CLI update reminder in the customer’s own words', () => {
    const option = notificationOptions.find(entry => entry.value === 'cliUpdate');
    // Codex 桌面端出新版也走这一项，标题说「工具」不说「命令行」，只装了桌面端的客户也认得出（第三十二批 B）。
    expect(option?.label).toBe('工具有新版本');
    // 站点名、内部代号不进面向用户的文案（双站点对用户无感）。
    expect(option?.label).not.toMatch(/solov|new-api|relay|CLI|命令行/i);
  });

  // v4 的次序和叫法（字表批08）：钱的事在前；只有余额和花费两项要说清楚什么时候提醒，而且按代码的判断写。
  it('lists the reminders in the v4 order, explaining only the two money thresholds', () => {
    expect(notificationOptions.map(option => option.label)).toEqual([
      '余额不足', '花费突然变多', '终端里的 AI 做完或在等你', '终端里没回上', '安装和更新结果', '工具有新版本', '后台任务做完', '公告与优惠', '加速提醒',
    ]);
    expect(notificationOptions.filter(option => option.description).map(option => [option.value, option.description])).toEqual([
      ['balance', '余额低于 $5 时提醒'],
      ['spend', '一小时内花费超过平时 5 倍且至少 $5 时提醒'],
    ]);
  });
});

describe('renderer-v2 settings rows registry', () => {
  // 顶部搜索按 id 翻到设置里那一行，id 和组名撞了，搜到的那一条会被当成一组打开。
  it('gives every row an id of its own that no group uses', () => {
    const ids = settingsItems.map(item => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of settingsGroups) expect(ids).not.toContain(group.value);
  });

  it('puts at least one row in every group and only uses known groups', () => {
    for (const group of settingsGroups) expect(settingsItems.some(item => item.group === group.value), group.value).toBe(true);
  });

  it('lists the rows the settings page moved or renamed under their new groups', () => {
    const groupOf = (id: string) => settingsItems.find(item => item.id === id)?.group;
    expect(groupOf('latest-cli')).toBe('tools');
    expect(groupOf('update-check')).toBe('about');
    expect(groupOf('auto-update')).toBe('about');
    expect(groupOf('backups')).toBe('backup');
    expect(groupOf('transfer')).toBe('backup');
    expect(groupOf('legal')).toBe('privacy');
    expect(settingsItemLabel('workspace')).toBe('打开工具时进入的文件夹');
    expect(settingsItemLabel('language')).toBe('界面语言');
    expect(settingsItemLabel('terminal')).toBe('终端');
    expect(settingsItemLabel('install-location')).toBe('安装位置');
    expect(settingsItemLabel('proxy')).toBe('连接方式');
    expect(settingsItemLabel('logs')).toBe('运行日志');
    expect(settingsItemLabel('usage-stats')).toBe('匿名使用统计');
    expect(settingsGroups.find(group => group.value === 'startup')?.keywords).not.toContain('自动更新');
  });

  // v4 八组，组名都是四个字；「账号」组拆走，测试通知并进桌面通知那一行（字表批08）。
  it('names the eight v4 groups and drops the account group and the test notification row', () => {
    expect(settingsGroups.map(group => group.label)).toEqual(['外观显示', '启动关闭', '工具管理', '网络加速', '消息通知', '备份迁移', '隐私数据', '版本更新']);
    for (const group of settingsGroups) expect(settingsGroupIcons[group.value], group.value).toBeTruthy();
    const ids = settingsItems.map(item => item.id);
    for (const gone of ['current-account', 'switch-account', 'remember-password', 'logout', 'test-notification']) expect(ids).not.toContain(gone);
  });

  it('puts each row under a heading of its own group', () => {
    for (const item of settingsItems) {
      if (!item.section) continue;
      expect(settingsSections.find(section => section.value === item.section)?.group, item.id).toBe(item.group);
    }
  });

  it('splits a group into one card per heading in page order', () => {
    const shape = (group: Parameters<typeof buildSettingsBlocks>[0]) => buildSettingsBlocks(group).map(block => [block.section?.label ?? null, block.items.map(item => item.id)]);
    expect(shape('appearance')).toEqual([
      [null, ['theme']],
      ['文字与缩放', ['ui-scale', 'large-text', 'language']],
      ['辅助与显示', ['high-contrast', 'reduced-motion', 'hardware-acceleration', 'restore-appearance']],
    ]);
    // 游戏加速、工具配置备份、版本卡是整张卡（v4 批09），各占一块、不和别的行挤进同一张卡。
    expect(shape('network')).toEqual([
      [null, ['acceleration']],
      ['连接线路', ['relay-route-solov', 'relay-route-solov-api', 'tool-route-restart-hints']],
      ['下载与连接', ['mirror', 'proxy', 'network-check', 'certificate']],
    ]);
    expect(shape('notifications').map(([label]) => label)).toEqual([null, '提醒哪些事']);
    expect(shape('tools')).toEqual([[null, ['workspace', 'latest-cli', 'install-location', 'terminal']], [null, ['codex-remote']]]);
    expect(shape('backup')).toEqual([
      [null, ['backups']],
      ['搬到新电脑', ['transfer', 'transfer-import']],
    ]);
    expect(shape('about')).toEqual([
      [null, ['version']],
      [null, ['update-check', 'auto-update', 'shortcuts', 'guide', 'tour', 'uninstall-app', 'uninstall']],
    ]);
  });

  it('never merges a card item into the rows around it, even without headings', () => {
    const items = settingsItems.filter(item => item.group === 'about');
    const blocks = buildSettingsBlocks('about', [items[1], items[0], items[2]]);
    expect(blocks.map(block => block.items.map(item => item.id))).toEqual([['update-check'], ['version'], ['auto-update']]);
  });

  // 原来的三个页面挪进来以后，顶部搜索按原来的说法还要找得到它们（v4 批09）。
  it('finds the moved acceleration, backup and update cards by their old words', () => {
    const ids = (query: string) => searchSettingsItems(query).map(item => item.id);
    expect(ids('网络加速')).toContain('acceleration');
    expect(ids('免费时长')).toContain('acceleration');
    expect(ids('立即备份')).toEqual(['backups']);
    expect(ids('当前版本')).toEqual(['version']);
    expect(ids('自动更新')).toEqual(['auto-update']);
    expect(ids('搬到新电脑')).toEqual(['transfer', 'transfer-import']);
  });

  // 设置页左栏的「搜索设置」：行名、常用说法、组名、小标题都算，空格隔开的词都要对上。
  it('finds rows for the in-page search by title, everyday word, group or heading', () => {
    const ids = (query: string) => searchSettingsItems(query).map(item => item.id);
    expect(ids('')).toEqual([]);
    expect(ids('   ')).toEqual([]);
    expect(ids('托盘')).toContain('close-behavior');
    expect(ids('镜像')).toEqual(['mirror']);
    expect(ids('快捷键')).toEqual(['shortcuts']);
    expect(ids('测试通知')).toEqual(['desktop-notifications']);
    expect(ids('连接线路')).toEqual(['relay-route-solov', 'relay-route-solov-api', 'tool-route-restart-hints']);
    expect(ids('外观显示 默认')).toEqual(['restore-appearance']);
    expect(ids('VPN')).toEqual(ids('vpn'));
    expect(ids('黑金')).toEqual(['theme']);
    expect(ids('晨曦金')).toEqual(['theme']);
    expect(ids('没有这种设置')).toEqual([]);
  });

  it('carries one row per notification switch, titled like the switch', () => {
    for (const option of notificationOptions) expect(settingsItemLabel(notificationSettingsItemId(option.value))).toBe(option.label);
  });

  it('refuses a row id nobody registered instead of rendering a blank title', () => {
    expect(() => settingsItemLabel('no-such-row')).toThrow();
  });

  it('only offers the rows this computer and this login have', () => {
    const context = { mac: false, autoUpdate: false, acceleration: false };
    const visible = (id: string, overrides: Partial<typeof context> = {}) => {
      const item = settingsItems.find(entry => entry.id === id);
      if (!item) throw new Error(id);
      return settingsItemAvailable(item, { ...context, ...overrides });
    };
    expect(visible('uninstall')).toBe(true);
    expect(visible('uninstall-app')).toBe(false);
    expect(visible('uninstall', { mac: true })).toBe(false);
    expect(visible('uninstall-app', { mac: true })).toBe(true);
    expect(visible('auto-update')).toBe(false);
    expect(visible('auto-update', { autoUpdate: true })).toBe(true);
    expect(visible(notificationSettingsItemId('acceleration'))).toBe(false);
    expect(visible(notificationSettingsItemId('acceleration'), { acceleration: true })).toBe(true);
    expect(visible('theme')).toBe(true);
  });

  it('never names a site or an internal term in a row title or search word', () => {
    for (const item of settingsItems) expect(`${item.label} ${item.keywords.join(' ')}`).not.toMatch(/solov|new-api|sub2api|relay/i);
  });

  // 原来更新页顶上那句页头说明拆掉了，意思挪到「自动下载更新」这一行（字表批09）。
  it('says when a downloaded update gets installed in the auto-update row', () => {
    expect(autoUpdateSettingDescription(undefined)).toBe('下好后在你关掉星芒时装上');
    expect(autoUpdateSettingDescription('system-installer')).toBe('下好后提醒你点安装');
    expect(autoUpdateSettingDescription(undefined, true)).toBe('下好后要输入管理员密码才能装');
  });
});

describe('renderer-v2 announcement notification option', () => {
  it('names the announcement reminder without the relay site', () => {
    const option = notificationOptions.find(entry => entry.value === 'announcement');
    expect(option?.label).toBe('公告与优惠');
    expect(`${option?.label} ${option?.description}`).not.toMatch(/solov|new-api|relay|sub2api/i);
  });
});

describe('renderer-v2 update failure labels', () => {
  // 更新页的提示和首页那条浮动气泡读的是同一张表；分成两份写，就会出现气泡说
  // 「检查更新失败」而页面还写着「重新下载」这种自相矛盾的组合。
  it('gives every failed step its own title and a retry that repeats that step', () => {
    const expected: Record<UpdateFailedStep, { title: string; retry: string }> = {
      check: { title: '检查更新失败', retry: '重试' },
      download: { title: '下载更新失败', retry: '重新下载' },
      install: { title: '安装更新失败', retry: '重新安装' },
    };
    for (const [step, labels] of Object.entries(expected)) {
      expect(updateFailureLabel(step as UpdateFailedStep)).toEqual(labels);
    }
    expect(Object.keys(updateFailureLabels).sort()).toEqual(Object.keys(expected).sort());
  });

  it('falls back to a step-free sentence for snapshots that predate the field', () => {
    // 旧版本升上来的快照没有 failedStep，这时候不许编一个步骤名出来。
    expect(updateFailureLabel(null)).toEqual(updateFailureFallback);
    expect(updateFailureLabel(undefined)).toEqual(updateFailureFallback);
    expect(updateFailureFallback.title).not.toContain('检查');
  });
});

describe('renderer-v2 withdrawn version and rollback wording', () => {
  const base = { currentVersion: '0.2.10', availableVersion: null, rollback: false, currentVersionWithdrawn: false } as const;

  it('does not call an older version new', () => {
    const rollback = { ...base, phase: 'available', availableVersion: '0.2.9', rollback: true, currentVersionWithdrawn: true } as const;
    expect(updateCardTitle(rollback)).toBe('建议退回稳定版本');
    expect(updateBubbleTitle(rollback)).toBe('建议退回 0.2.9');
    expect(withdrawnVersionAdvice(rollback)).toContain('建议装回 0.2.9');
    expect(updateBubbleTitle({ ...base, phase: 'available', availableVersion: '0.2.11' })).toBe('新版本 0.2.11 可以安装');
  });

  it('says the running version has a known problem when there is nothing to install yet', () => {
    const stranded = { ...base, phase: 'not-available', currentVersionWithdrawn: true } as const;
    expect(updateCardTitle(stranded)).toBe('这个版本有已知问题');
    expect(updateBubbleTitle(stranded)).toBe('这个版本有已知问题');
    expect(withdrawnVersionAdvice(stranded)).toContain('修好的版本准备好后');
    expect(withdrawnVersionAdvice({ ...stranded, phase: 'available', availableVersion: '0.2.11' })).toContain('修好的 0.2.11');
    expect(updateCardTitle({ ...base, phase: 'not-available' })).toBe('已是最新版本');
  });
});

describe('renderer-v2 updates page version rows', () => {
  it('names the new version under the current one only when there is one', () => {
    expect(updateNewVersion({ currentVersion: '0.2.10', availableVersion: '0.2.11', rollback: false })).toBe('0.2.11');
    expect(updateNewVersion({ currentVersion: '0.2.10', availableVersion: null, rollback: false })).toBeNull();
    expect(updateNewVersion(null)).toBeNull();
  });

  it('does not call the older version of a rollback new', () => {
    expect(updateNewVersion({ currentVersion: '0.2.10', availableVersion: '0.2.9', rollback: true })).toBeNull();
    expect(updateNewVersion({ currentVersion: '0.2.10', availableVersion: '0.2.10', rollback: false })).toBeNull();
  });
});

describe('renderer-v2 update bubble on the updates page', () => {
  const base = { currentVersion: '0.2.10', availableVersion: '0.2.11', rollback: false, currentVersionWithdrawn: false, error: null, failedStep: null } as const;
  const failed = (step: UpdateFailedStep) => ({ ...base, phase: 'error', error: { code: 'UPDATE_ERROR', message: '失败' }, failedStep: step } as const);

  it('leaves out the three bubbles that repeat what the page already says', () => {
    expect(updateBubbleRepeatsUpdatesPage({ ...base, phase: 'downloading' })).toBe(true);
    expect(updateBubbleRepeatsUpdatesPage(failed('download'))).toBe(true);
    expect(updateBubbleRepeatsUpdatesPage({ ...base, phase: 'available' })).toBe(true);
  });

  it('keeps the other bubbles, the known-problem one included', () => {
    expect(updateBubbleRepeatsUpdatesPage({ ...base, phase: 'not-available', availableVersion: null, currentVersionWithdrawn: true })).toBe(false);
    expect(updateBubbleRepeatsUpdatesPage({ ...base, phase: 'available', availableVersion: '0.2.9', rollback: true, currentVersionWithdrawn: true })).toBe(false);
    expect(updateBubbleRepeatsUpdatesPage({ ...base, phase: 'available', diskShortfall: { neededBytes: 2, freeBytes: 1 } })).toBe(false);
    expect(updateBubbleRepeatsUpdatesPage({ ...base, phase: 'downloaded' })).toBe(false);
    expect(updateBubbleRepeatsUpdatesPage(failed('check'))).toBe(false);
    expect(updateBubbleRepeatsUpdatesPage({ ...failed('install'), phase: 'downloaded' })).toBe(false);
  });
});

describe('renderer-v2 auto-update bubble wording', () => {
  it('tells the user what happens next when auto-update is on', () => {
    expect(autoUpdateBubbleBody('downloaded', true)).toBe('已经下好了，可以现在装，也可以关掉软件或下次打开时自动装上。');
    // 能闲时装的 Mac 多说一句；没下好、关了自动更新的都不说。
    expect(autoUpdateBubbleBody('downloaded', true, undefined, undefined, true)).toBe('已经下好了，可以现在装，也可以关掉软件或下次打开时自动装上。你不用电脑时星芒也会自己装好。');
    expect(autoUpdateBubbleBody('downloading', true, undefined, undefined, true)).not.toContain('自己装好');
    expect(autoUpdateBubbleBody('downloaded', false, undefined, undefined, true)).toBe('查看更新内容和安装状态。');
    expect(autoUpdateBubbleBody('downloading', true)).toContain('正在后台下载');
    expect(autoUpdateBubbleBody('downloaded', false)).toBe('查看更新内容和安装状态。');
  });
});

describe('renderer-v2 wording for a Windows account outside the administrators group', () => {
  it('uses the sentence yoyo approved, the same one the system notification uses', () => {
    // 2026-10-06 批的原话（句末补了句号）；主进程 desktop-notifications.ts 那一份也钉着同一句。
    // 批09 把按钮叫法统一成「重启并安装」，这句跟着换词。
    expect(standardAccountUpdateText).toBe('这台电脑的账号不是管理员，装更新时要输入管理员密码。让有管理员账号的人点一次「重启并安装」，或者找客服。');
    expect(standardAccountUpdateNotice.body).toContain(`「${updateInstallActionLabel(undefined)}」`);
  });

  it('replaces the downloaded bubble whether or not auto-update is on', () => {
    expect(autoUpdateBubbleBody('downloaded', true, undefined, true)).toBe(standardAccountUpdateText);
    expect(autoUpdateBubbleBody('downloaded', false, undefined, true)).toBe(standardAccountUpdateText);
    expect(autoUpdateBubbleBody('downloaded', true, undefined, false)).toBe(autoUpdateBubbleBody('downloaded', true));
  });

  it('stops promising an automatic install before the update is downloaded', () => {
    // 他 2026-10-06 回「改」批的原话。
    expect(autoUpdateBubbleBody('downloading', true, undefined, true)).toBe('正在后台下载；这台电脑装更新时要输入管理员密码，下好后不会自动装上。');
    expect(autoUpdateBubbleBody('available', true, undefined, true)).toBe(autoUpdateBubbleBody('downloading', true, undefined, true));
    expect(autoUpdateBubbleBody('downloading', false, undefined, true)).toBe('查看更新内容和安装状态。');
    for (const text of [autoUpdateBubbleBody('downloading', true, undefined, true), autoUpdateSettingDescription(undefined, true)]) {
      expect(text).not.toMatch(/关掉软件或下次打开时自动装上|关掉星芒时装上|UAC|管理员权限/);
    }
    // 管理员账号照旧。
    expect(autoUpdateBubbleBody('downloading', true, undefined, false)).toBe(autoUpdateBubbleBody('downloading', true));
    expect(autoUpdateSettingDescription(undefined, false)).toBe(autoUpdateSettingDescription(undefined));
  });
});

describe('renderer-v2 version card wording', () => {
  const base = { phase: 'not-available', currentVersion: '0.2.19', availableVersion: null, rollback: false, currentVersionWithdrawn: false } as const;

  it('names the new version in the status tag and says a download takes effect after a restart', () => {
    expect(updateStatusLabel({ ...base, phase: 'available', availableVersion: '0.2.20' })).toBe('有新版本 v0.2.20');
    expect(updateStatusLabel({ ...base, phase: 'downloaded', availableVersion: '0.2.20' })).toBe('已下载，重启后生效');
    expect(updateStatusLabel(base)).toBe('已是最新版本');
  });

  // Linux 要点「安装新版本」、账号不是管理员的 Windows 要输管理员密码：都不是重启就生效。
  it('does not promise a restart where installing needs another step', () => {
    expect(updateStatusLabel({ ...base, phase: 'downloaded', availableVersion: '0.2.20', installMethod: 'system-installer' })).toBe('更新已下载');
    expect(updateStatusLabel({ ...base, phase: 'downloaded', availableVersion: '0.2.20', installNeedsAdminPassword: true })).toBe('更新已下载');
  });

  it('keeps the rollback and withdrawn titles instead of calling them a new version', () => {
    expect(updateStatusLabel({ ...base, phase: 'available', availableVersion: '0.2.18', rollback: true, currentVersionWithdrawn: true })).toBe('建议退回稳定版本');
    expect(updateStatusLabel({ ...base, currentVersionWithdrawn: true })).toBe('这个版本有已知问题');
  });

  it('explains what to do before installing without internal jargon', () => {
    expect(updateInstallNote).not.toContain('关闭保护');
    expect(updateInstallNote).toContain('保存');
  });
});

describe('renderer-v2 update disk shortfall wording', () => {
  const MB = 1024 ** 2;
  const blocked = { phase: 'available', currentVersion: '0.2.10', availableVersion: '0.2.11', rollback: false, currentVersionWithdrawn: false, diskShortfall: { neededBytes: 600 * MB, freeBytes: 380 * MB } } as const;

  it('says how much is missing and whether it will download on its own', () => {
    expect(updateBubbleTitle(blocked)).toBe('新版本先不下载');
    expect(updateDiskShortfallText(blocked, true)).toBe('新版本先不下载：电脑磁盘只剩 380 MB，装更新大约要 600 MB，还要再清出 220 MB。清出来以后会自动下载，不用你再点。');
    expect(updateDiskShortfallText(blocked, false)).toContain('现在下载多半会失败');
  });

  it('stays silent when nothing is blocked or the phase moved on', () => {
    expect(updateDiskShortfallText({ ...blocked, diskShortfall: null }, true)).toBeNull();
    expect(updateDiskShortfallText({ ...blocked, phase: 'downloading' }, true)).toBeNull();
    expect(updateDiskShortfallText(null, true)).toBeNull();
  });
});

describe('update download detail', () => {
  const mb = 1024 ** 2;
  it('shows how much is done, how fast, and how long is left', () => {
    expect(updateDownloadDetail({ percent: 34, bytesPerSecond: 1, transferred: 38 * mb, total: 112 * mb, averageBytesPerSecond: 1.8 * mb, secondsRemaining: 42 }))
      .toBe('已下载 38 MB / 共 112 MB · 每秒 1.8 MB · 大约还要 50 秒');
  });
  it('only shows the amount while the speed is still unknown', () => {
    expect(updateDownloadDetail({ percent: 0, bytesPerSecond: 0, transferred: 0, total: 112 * mb, averageBytesPerSecond: null, secondsRemaining: null }))
      .toBe('已下载 0 KB / 共 112 MB');
    // 旧快照没有平均速度字段：不拿 electron-updater 那个乱跳的瞬时值顶上。
    expect(updateDownloadDetail({ percent: 50, bytesPerSecond: 3 * mb, transferred: 5.5 * mb, total: 11 * mb }))
      .toBe('已下载 5.5 MB / 共 11 MB');
  });
  it('drops the total when the feed did not say how big the package is', () => {
    expect(updateDownloadDetail({ percent: 0, bytesPerSecond: 0, transferred: 1.2 * 1024 ** 3, total: 0, averageBytesPerSecond: 512 * 1024, secondsRemaining: null }))
      .toBe('已下载 1.2 GB · 每秒 512 KB');
  });
  it('has nothing to say without progress', () => {
    expect(updateDownloadDetail(null)).toBeNull();
  });
  it('rounds the remaining time coarsely so it does not tick every second', () => {
    expect(formatDownloadRemaining(5)).toBe('马上就好');
    expect(formatDownloadRemaining(11)).toBe('大约还要 20 秒');
    expect(formatDownloadRemaining(59)).toBe('大约还要 50 秒');
    expect(formatDownloadRemaining(61)).toBe('大约还要 2 分钟');
    expect(formatDownloadRemaining(3600)).toBe('大约还要 1 小时');
    expect(formatDownloadRemaining(4800)).toBe('大约还要 1 小时 20 分钟');
  });
});

describe('renderer-v2 wording when the system installer takes over (Linux)', () => {
  it('never promises that the update installs itself or that the app restarts', () => {
    const linux = 'system-installer' as const;
    expect(autoUpdateBubbleBody('downloaded', true, linux)).toBe('已经下好了，到「设置 › 版本更新」点「安装新版本」就能装上。');
    expect(autoUpdateBubbleBody('downloaded', false, linux)).toBe('已经下好了，到「设置 › 版本更新」点「安装新版本」就能装上。');
    expect(autoUpdateBubbleBody('downloading', true, linux)).toBe('正在后台下载，下好后到「设置 › 版本更新」点「安装新版本」。');
    expect(autoUpdateSettingDescription(linux)).not.toContain('装上');
    expect(updateInstallActionLabel(linux)).toBe('安装新版本');
    expect(updateInstallActionLabel(undefined)).toBe('重启并安装');
    const rollback = { phase: 'available', currentVersion: '0.2.10', availableVersion: '0.2.9', rollback: true, currentVersionWithdrawn: true } as const;
    expect(withdrawnVersionAdvice({ ...rollback, installMethod: linux })).toContain('再点「安装新版本」');
    expect(withdrawnVersionAdvice(rollback)).toContain('再点「重启并安装」');
  });
});
