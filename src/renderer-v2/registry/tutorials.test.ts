import { describe, expect, it } from 'vitest';
import { gitLinuxInstallCommand } from '../../../electron/git-runtime';
import { accountTabs, macDesktopTutorialTopic, macRuntimeTutorialTopic, settingsGroups, updateFailureLabels, updateLabels, updatesTutorialTopic } from './business';
import { linuxUpdateDiskCleanupSteps, macKeychainTutorialTitle, tutorialTopics, tutorialTopicsFor, updateDiskCleanupDetail, updateDiskCleanupSteps, updateDiskCleanupStepsFor, updateDiskCleanupTitle, type TutorialStep } from './tutorials';

function step(topicId: string, action: string): TutorialStep {
  const found = tutorialTopics.find((topic) => topic.id === topicId)?.steps.find((entry) => entry.action === action);
  if (!found) throw new Error(`missing tutorial step ${topicId} / ${action}`);
  return found;
}

// 「在哪里」写的是用户要去的分页；按钮若只跳页，就会停在默认分页或上次看的那页。
const sectionsByPage = {
  account: accountTabs.filter((tab) => tab.value !== 'overview'),
  settings: settingsGroups.filter((group) => group.value !== 'appearance'),
} as const;

function sectionNamedIn(entry: TutorialStep): string | undefined {
  if (entry.page !== 'account' && entry.page !== 'settings') return undefined;
  const where = entry.where ?? '';
  const named = sectionsByPage[entry.page]
    .map((section) => ({ value: section.value, position: where.indexOf(section.label) }))
    .filter((section) => section.position >= 0)
    .sort((left, right) => left.position - right.position);
  return named[0]?.value;
}

describe('tutorial step targets', () => {
  it('lands the account chapter actions on the tab each step describes (Q48)', () => {
    expect(step('account', '打开个人中心').section).toBeUndefined();
    expect(step('account', '查看账号与密钥').section).toBe('keys');
    expect(step('account', '打开个人中心办理充值').section).toBe('recharge');
    expect(step('account', '查看用量与调用明细').section).toBe('usage');
  });

  it('lands the privacy step on the privacy settings group', () => {
    expect(step('safety', '查看隐私与数据设置')).toMatchObject({ page: 'settings', section: 'privacy' });
  });

  it('only names sections that exist on the target page', () => {
    for (const topic of tutorialTopics) for (const entry of topic.steps) {
      if (entry.section === undefined) continue;
      const known: readonly string[] = entry.page === 'account' ? accountTabs.map((tab) => tab.value)
        : entry.page === 'settings' ? settingsGroups.map((group) => group.value) : [];
      expect(known, `${topic.id} / ${entry.action}`).toContain(entry.section);
    }
  });

  it('declares a section whenever the step location names a non-default tab of its page', () => {
    for (const topic of tutorialTopics) for (const entry of topic.steps) {
      expect(entry.section, `${topic.id} / ${entry.action}`).toBe(sectionNamedIn(entry));
    }
  });
});

describe('mac keychain prompt help', () => {
  it('explains the keychain password prompt next to the toolbox update step', () => {
    const extra = step('safety', '打开工具箱更新').extra ?? [];
    const entry = extra.find((item) => item.title === macKeychainTutorialTitle);
    expect(entry?.detail).toContain('xingmang-ai-manager Safe Storage');
    expect(entry?.detail).toContain('始终允许');
    expect(tutorialTopics.find((topic) => topic.id === 'safety')?.keywords).toContain('钥匙串');
  });

  it('tells a full-disk user where to clean up next to the toolbox update step', () => {
    const extra = step(updatesTutorialTopic, '打开工具箱更新').extra ?? [];
    const entry = extra.find((item) => item.title === updateDiskCleanupTitle);
    expect(entry?.detail).toBe(updateDiskCleanupDetail);
    expect(updateDiskCleanupDetail).toContain('系统设置 → 通用 → 储存空间');
    expect(updateDiskCleanupDetail).toContain('设置 → 系统 → 存储');
  });
});

// 第二十一批 6：教程曾经还在教手动四步更新、一个永远按不动的加速模式开关。
// 这里把教程里的按钮名钉在界面真正用的那份文案上，改了界面忘改教程会红。
describe('tutorial wording that follows the current app', () => {
  it('describes automatic updates with the labels the settings and update page use', () => {
    const update = step('safety', '打开工具箱更新');
    const text = JSON.stringify(update);
    expect(update.detail).toContain('自动装上');
    expect(text).toContain(`「${settingsGroups.find((group) => group.value === 'about')?.label}」`);
    expect(text).toContain('「自动更新」');
    expect(text).toContain(`「${updateFailureLabels.install.retry}」`);
    expect(update.expected).toContain(`「${updateLabels['not-available']}」`);
    expect(text).toContain('「退回更新前的版本」');
    expect(text).not.toContain('区分两种更新入口');
  });

  it('never teaches the acceleration mode switch that is not open to customers', () => {
    expect(JSON.stringify(tutorialTopics)).not.toMatch(/TUN/i);
  });

  it('keeps npm and the bare word CLI out of what customers read', () => {
    // keywords only feed the search box, so customers who type「npm」or「CLI」still land on the right chapter.
    const visible = JSON.stringify(tutorialTopics.map(({ keywords: _keywords, ...topic }) => topic));
    expect(visible).not.toMatch(/npm|PATH|TOML/i);
    expect(visible.replace(/(Codex|Gemini|Grok) CLI/g, '')).not.toMatch(/CLI/);
  });

  it('tells Mac users where to find Terminal before asking them to paste a command', () => {
    const homebrew = tutorialTopics.find((topic) => topic.id === macRuntimeTutorialTopic)?.steps.find((entry) => entry.where === 'Mac 终端 → 安装命令');
    expect(homebrew?.bullets?.[0]).toContain('Command + 空格');
  });
});

describe('linux tutorials', () => {
  const linux = tutorialTopicsFor('linux');
  const visible = JSON.stringify(linux.map(({ keywords: _keywords, ...topic }) => topic));

  it('gives Windows and macOS exactly the tutorials they had', () => {
    expect(tutorialTopicsFor('win')).toBe(tutorialTopics);
    expect(tutorialTopicsFor('mac')).toBe(tutorialTopics);
    expect(updateDiskCleanupStepsFor('win')).toBe(updateDiskCleanupSteps);
    expect(updateDiskCleanupStepsFor('mac')).toBe(updateDiskCleanupSteps);
  });

  it('drops the Codex desktop, acceleration and Mac-only chapters and keeps everything else in order', () => {
    const ids = linux.map((topic) => topic.id);
    const hidden = ['install', 'config', 'launch', 'acceleration', macRuntimeTutorialTopic, macDesktopTutorialTopic];
    expect(ids).toEqual(tutorialTopics.map((topic) => topic.id).filter((id) => !hidden.includes(id)));
    expect(ids[0]).toBe('start');
    expect(linux.flatMap((topic) => topic.steps).some((entry) => entry.page === 'acceleration')).toBe(false);
  });

  it('never points a Linux reader at Windows, a Mac, the desktop app or game acceleration', () => {
    expect(visible).not.toMatch(/Windows|Mac|桌面端|Homebrew|访达|PowerShell|开始菜单|废纸篓|游戏加速|C 盘|钥匙串/);
    expect(visible).not.toMatch(/npm|PATH|TOML/i);
    expect(visible.replace(/(Codex|Gemini|Grok) CLI/g, '')).not.toMatch(/CLI/);
  });

  it('walks a Linux beginner through Codex CLI in the same four steps', () => {
    const start = linux[0];
    expect(start.title).toBe(tutorialTopics[0].title);
    expect(start.steps.map((entry) => entry.title)).toEqual(['登录星芒账号', '装好 Codex CLI', '看到「已配好」就继续', '打开 Codex，发出第一条消息']);
    expect(start.steps[0]).toBe(tutorialTopics[0].steps[0]);
    expect(start.reminders).toEqual(tutorialTopics[0].reminders);
    expect(JSON.stringify(start)).toContain('不用输开机密码');
  });

  it('describes the Linux self-update the way the update page and quit prompt do', () => {
    const updates = linux.find((topic) => topic.id === updatesTutorialTopic);
    const self = updates?.steps.find((entry) => entry.page === 'updates');
    const text = JSON.stringify(self);
    expect(text).toContain('「安装新版本」');
    expect(text).toContain('输入开机密码');
    expect(text).toContain('从应用菜单重新打开');
    expect(text).toContain(linuxUpdateDiskCleanupSteps);
    expect(text).toContain('「退回更新前的版本」');
    expect(updates?.steps.length).toBe(tutorialTopics.find((topic) => topic.id === updatesTutorialTopic)?.steps.length);
    expect(updateDiskCleanupStepsFor('linux')).toBe(linuxUpdateDiskCleanupSteps);
  });

  it('gives the Git command instead of the Windows button in the command-line chapter', () => {
    const cli = JSON.stringify(linux.find((topic) => topic.id === 'cli'));
    expect(cli).toContain(gitLinuxInstallCommand);
    expect(cli).toContain('已经装过这个工具？');
  });
});

