import { describe, expect, it } from 'vitest';
import { buildConnectionRoutePatch, connectionRouteNeedsRestart, connectionRouteOptions, connectionRouteSelection, connectionRouteSettings } from './connection-routes';

describe('controlled connection route settings', () => {
  it('offers auto first, then direct only and default only, for each account site', () => {
    for (const siteId of ['solov', 'solov-api']) {
      expect(connectionRouteOptions(siteId)).toEqual([
        { value: 'auto', label: '自动（推荐）' },
        { value: 'direct', label: '只用直连' },
        { value: 'primary', label: '只用默认线路' },
      ]);
    }
    expect(connectionRouteOptions('unknown')).toEqual([]);
  });

  it('words the two settings exactly as approved', () => {
    expect(connectionRouteSettings.map((route) => [route.label, route.description])).toEqual([
      ['星芒账号线路', '自动会先走直连，直连连不上时改走默认线路。保存后重启星芒生效，不会切换账号。'],
      ['历史账号线路', '历史账号单独设置，用法和上面一样。保存后重启星芒生效，不会切换账号。'],
    ]);
  });

  it('reads nothing stored as auto and keeps a single line saved before auto existed', () => {
    expect(connectionRouteSelection({}, 'solov')).toBe('auto');
    expect(connectionRouteSelection({ relayEndpointIds: { 'solov-api': 'primary' } }, 'solov')).toBe('auto');
    expect(connectionRouteSelection({ relayEndpointIds: { solov: 'primary' } }, 'solov')).toBe('primary');
    expect(connectionRouteSelection({ relayEndpointIds: { solov: 'direct' } }, 'solov')).toBe('direct');
  });

  it('preserves other sites and refuses arbitrary or cross-site endpoints', () => {
    const settings = { relayEndpointIds: { solov: 'primary' as const, 'solov-api': 'primary' as const } };
    expect(buildConnectionRoutePatch(settings, 'solov', 'direct')).toEqual({ relayEndpointIds: { solov: 'direct', 'solov-api': 'primary' } });
    expect(buildConnectionRoutePatch(settings, 'solov-api', 'auto')).toEqual({ relayEndpointIds: { solov: 'primary', 'solov-api': 'auto' } });
    expect(buildConnectionRoutePatch(settings, 'solov-api', 'direct')).toEqual({ relayEndpointIds: { solov: 'primary', 'solov-api': 'direct' } });
    expect(settings.relayEndpointIds.solov).toBe('primary');
    expect(buildConnectionRoutePatch(settings, 'unknown', 'direct')).toBeNull();
    expect(buildConnectionRoutePatch(settings, 'solov', 'Auto')).toBeNull();
    expect(buildConnectionRoutePatch(settings, 'solov', 'backup')).toBeNull();
    expect(buildConnectionRoutePatch(settings, 'solov', 'https://attacker.invalid')).toBeNull();
  });

  it('requires a restart only when saved routes differ from the startup snapshot', () => {
    expect(connectionRouteNeedsRestart({})).toBe(false);
    expect(connectionRouteNeedsRestart({ relayEndpointIds: { solov: 'auto' }, activeRelayEndpointIds: { solov: 'auto', 'solov-api': 'auto' } })).toBe(false);
    expect(connectionRouteNeedsRestart({ relayEndpointIds: { solov: 'direct' } })).toBe(true);
    expect(connectionRouteNeedsRestart({ relayEndpointIds: { solov: 'direct' }, activeRelayEndpointIds: { solov: 'direct' } })).toBe(false);
    expect(connectionRouteNeedsRestart({ relayEndpointIds: { solov: 'primary' }, activeRelayEndpointIds: { solov: 'direct' } })).toBe(true);
    expect(connectionRouteNeedsRestart({ relayEndpointIds: { solov: 'primary', 'solov-api': 'auto' }, activeRelayEndpointIds: { solov: 'primary', 'solov-api': 'primary' } })).toBe(true);
  });
});
