import { relaySiteEndpointChoices } from '../../../electron/relay-sites';
import type { RelayEndpointSelections } from '../../../electron/relay-sites';

export const connectionRouteSettings = [
  { siteId: 'solov', id: 'relay-route-solov', label: '星芒账号线路', description: '连接不稳定时可切换；保存后重启星芒生效，不会切换账号。' },
  { siteId: 'solov-api', id: 'relay-route-solov-api', label: '历史账号线路', description: '历史账号目前只有默认线路，调整上方线路不影响这里。' },
] as const;

export interface ConnectionRoutePreferences {
  relayEndpointIds?: RelayEndpointSelections;
  activeRelayEndpointIds?: RelayEndpointSelections;
}

export function connectionRouteOptions(siteId: string): Array<{ value: string; label: string }> {
  return relaySiteEndpointChoices(siteId).map((choice) => ({ value: choice.id, label: choice.label }));
}

export function connectionRouteSelection(settings: ConnectionRoutePreferences, siteId: (typeof connectionRouteSettings)[number]['siteId']): string {
  return settings.relayEndpointIds?.[siteId] ?? 'primary';
}

export function connectionRouteNeedsRestart(settings: ConnectionRoutePreferences): boolean {
  return connectionRouteSettings.some(({ siteId }) => connectionRouteSelection(settings, siteId) !== (settings.activeRelayEndpointIds?.[siteId] ?? 'primary'));
}

/** Keep each site's choice separate; a future site's settings must survive changing this one. */
export function buildConnectionRoutePatch(settings: ConnectionRoutePreferences, siteId: string, value: string): { relayEndpointIds: RelayEndpointSelections } | null {
  if (!connectionRouteSettings.some((route) => route.siteId === siteId)) return null;
  const choice = relaySiteEndpointChoices(siteId).find((entry) => entry.id === value);
  if (!choice) return null;
  return { relayEndpointIds: { ...settings.relayEndpointIds, [siteId]: choice.id } };
}
