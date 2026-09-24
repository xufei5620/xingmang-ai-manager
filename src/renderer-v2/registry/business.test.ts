import { describe, expect, it } from 'vitest';
import type { PlatformNotificationKind } from '../../../electron/platform/contract';
import type { UpdateFailedStep } from '../../../electron/ipc-contract';
import {
  notificationOptions,
  updateBubbleTitle,
  updateCardTitle,
  updateFailureFallback,
  updateFailureLabel,
  updateFailureLabels,
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
      acceleration: true,
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
    // 站点名、内部代号不进面向用户的文案（双站点对用户无感）。
    expect(`${option?.label} ${option?.description}`).not.toMatch(/solov|new-api|relay|CLI/i);
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
