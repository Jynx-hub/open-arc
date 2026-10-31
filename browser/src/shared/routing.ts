// Air Traffic Control (spec/features/air-traffic-control.md): ordered `contains` rules, first match wins.
import type { LinkRule, State } from './model';

export type Destination = { kind: 'space'; spaceId: string } | { kind: 'recentSpace' } | { kind: 'littleArc' };

export function routeExternalUrl(state: State, url: string): Destination {
  const lower = url.toLowerCase();
  for (const rule of state.linkRules) {
    if (!rule.pattern || !lower.includes(rule.pattern.toLowerCase())) continue;
    if (rule.destination.kind === 'space' && !state.spaces.some((s) => s.id === (rule.destination as { spaceId: string }).spaceId)) continue;
    return rule.destination;
  }
  return state.settings.defaultLinkDestination;
}

export function describeDestination(state: State, d: LinkRule['destination']): string {
  if (d.kind === 'littleArc') return 'Mini window';
  if (d.kind === 'recentSpace') return 'Most recent Space';
  return state.spaces.find((s) => s.id === d.spaceId)?.title ?? 'Missing Space';
}
