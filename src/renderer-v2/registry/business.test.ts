import { describe, expect, it } from 'vitest';
import type { PlatformNotificationKind } from '../../../electron/platform/contract';
import type { UpdateFailedStep } from '../../../electron/ipc-contract';
import {
  autoUpdateBubbleBody,
  autoUpdateSettingDescription,
  notificationOptions,
  notificationSettingsItemId,
  settingsGroups,
  settingsItemAvailable,
  settingsItemLabel,
  settingsItems,
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
  updatesPageLead,
  withdrawnVersionAdvice,
} from './business';

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
    expect(option?.label).toBe('工具有新版本');
    // Codex 桌面端出新版也走这一项，只装了桌面端的客户也要能认出这一项跟自己有关（第三十二批 B）。
    expect(option?.description).toBe('你装的工具出新版本时提醒一次');
    // 站点名、内部代号不进面向用户的文案（双站点对用户无感）。
    expect(`${option?.label} ${option?.description}`).not.toMatch(/solov|new-api|relay|CLI|命令行/i);
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

  it('lists the four rows the settings page moved or renamed under their new groups', () => {
    const groupOf = (id: string) => settingsItems.find(item => item.id === id)?.group;
    expect(groupOf('latest-cli')).toBe('tools');
    expect(groupOf('update-check')).toBe('about');
    expect(groupOf('auto-update')).toBe('about');
    expect(settingsItemLabel('workspace')).toBe('打开工具时进入的文件夹');
    expect(settingsItemLabel('test-notification')).toBe('测试通知');
    expect(settingsGroups.find(group => group.value === 'about')?.label).toBe('更新与关于');
    expect(settingsGroups.find(group => group.value === 'startup')?.keywords).not.toContain('自动更新');
  });

  it('carries one row per notification switch, titled like the switch', () => {
    for (const option of notificationOptions) expect(settingsItemLabel(notificationSettingsItemId(option.value))).toBe(option.label);
  });

  it('refuses a row id nobody registered instead of rendering a blank title', () => {
    expect(() => settingsItemLabel('no-such-row')).toThrow();
  });

  it('only offers the rows this computer and this login have', () => {
    const context = { mac: false, autoUpdate: false, acceleration: false, signedIn: false };
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
    expect(visible('logout')).toBe(false);
    expect(visible('logout', { signedIn: true })).toBe(true);
    expect(visible('theme')).toBe(true);
  });

  it('never names a site or an internal term in a row title or search word', () => {
    for (const item of settingsItems) expect(`${item.label} ${item.keywords.join(' ')}`).not.toMatch(/solov|new-api|sub2api|relay/i);
  });

  it('describes automatic updates the same way on the settings and update pages', () => {
    expect(autoUpdateSettingDescription('system-installer')).toContain('由你点下载');
    expect(autoUpdateSettingDescription(undefined)).toContain('由你点安装');
  });
});

describe('renderer-v2 announcement notification option', () => {
  it('names the announcement reminder without the relay site', () => {
    const option = notificationOptions.find(entry => entry.value === 'announcement');
    expect(option?.label).toBe('新公告');
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
    expect(autoUpdateBubbleBody('downloaded', true)).toContain('关掉软件或下次打开时自动装上');
    expect(autoUpdateBubbleBody('downloading', true)).toContain('正在后台下载');
    expect(autoUpdateBubbleBody('downloaded', false)).toBe('查看更新内容和安装状态。');
  });
});

describe('renderer-v2 updates page wording', () => {
  it('does not promise the user decides when auto-update is on', () => {
    expect(updatesPageLead(true)).toContain('自动装上');
    expect(updatesPageLead(true)).not.toContain('不会自己重启');
    expect(updatesPageLead(false)).toBe('新版本什么时候安装由你决定，不会自己重启。');
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
    expect(autoUpdateBubbleBody('downloaded', true, linux)).toBe('已经下好了，到更新页点「安装新版本」就能装上。');
    expect(autoUpdateBubbleBody('downloaded', false, linux)).toBe('已经下好了，到更新页点「安装新版本」就能装上。');
    expect(autoUpdateBubbleBody('downloading', true, linux)).toBe('正在后台下载，下好后到更新页点「安装新版本」。');
    expect(updatesPageLead(true, linux)).toContain('输入开机密码');
    expect(updatesPageLead(true, linux)).not.toContain('自动装上');
    expect(updatesPageLead(false, linux)).toBe(updatesPageLead(false));
    expect(updateInstallActionLabel(linux)).toBe('安装新版本');
    expect(updateInstallActionLabel(undefined)).toBe('重启安装');
    const rollback = { phase: 'available', currentVersion: '0.2.10', availableVersion: '0.2.9', rollback: true, currentVersionWithdrawn: true } as const;
    expect(withdrawnVersionAdvice({ ...rollback, installMethod: linux })).toContain('再点「安装新版本」');
    expect(withdrawnVersionAdvice(rollback)).toContain('再点「重启安装」');
  });
});
