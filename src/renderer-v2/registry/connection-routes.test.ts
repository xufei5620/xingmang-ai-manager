import { describe, expect, it } from 'vitest';
import { buildConnectionRoutePatch, connectionRouteNeedsRestart, connectionRouteOptions } from './connection-routes';

describe('controlled connection route settings', () => {
  it('offers registered routes separately for each account site', () => {
    expect(connectionRouteOptions('solov').map((option) => option.value)).toEqual(['primary', 'direct']);
    expect(connectionRouteOptions('solov-api').map((option) => option.value)).toEqual(['primary']);
  });

  it('preserves other sites and refuses arbitrary or cross-site endpoints', () => {
    const settings = { relayEndpointIds: { solov: 'primary' as const, 'solov-api': 'primary' as const } };
    expect(buildConnectionRoutePatch(settings, 'solov', 'direct')).toEqual({ relayEndpointIds: { solov: 'direct', 'solov-api': 'primary' } });
    expect(settings.relayEndpointIds.solov).toBe('primary');
    expect(buildConnectionRoutePatch(settings, 'solov-api', 'direct')).toBeNull();
    expect(buildConnectionRoutePatch(settings, 'unknown', 'direct')).toBeNull();
    expect(buildConnectionRoutePatch(settings, 'solov', 'https://attacker.invalid')).toBeNull();
  });

  it('requires a restart only when saved routes differ from the startup snapshot', () => {
    expect(connectionRouteNeedsRestart({})).toBe(false);
    expect(connectionRouteNeedsRestart({ relayEndpointIds: { solov: 'direct' } })).toBe(true);
    expect(connectionRouteNeedsRestart({ relayEndpointIds: { solov: 'direct' }, activeRelayEndpointIds: { solov: 'direct' } })).toBe(false);
    expect(connectionRouteNeedsRestart({ relayEndpointIds: { solov: 'primary' }, activeRelayEndpointIds: { solov: 'direct' } })).toBe(true);
  });
});
