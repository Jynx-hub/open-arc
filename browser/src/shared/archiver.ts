// Which Today tabs are due for auto-archive (spec/features/auto-archive-and-archive.md).
import { ARCHIVE_THRESHOLDS, type State } from './model';
import { subtree } from './tree';

/**
 * Today items (top level of each Space's Today root) idle longer than the Space's Profile threshold.
 * A container is archived only when every tab inside it is idle. Selected items are never archived.
 */
export function dueForArchive(state: State, now: number, selectedIds: Set<string>): string[] {
  const due: string[] = [];
  for (const space of state.spaces) {
    const threshold = ARCHIVE_THRESHOLDS[state.settings.autoArchive[space.profileId] ?? 'twentyFourHours'];
    if (!Number.isFinite(threshold)) continue;
    for (const id of state.items[space.todayRootId]?.children ?? []) {
      const items = subtree(state, id);
      if (items.some((i) => selectedIds.has(i.id))) continue;
      // Notes and Easels track their own activity; empty folders fall back to their creation time.
      const times = items.map((i) => i.tab?.lastActiveAt ?? i.lastActiveAt).filter((t): t is number => t !== undefined);
      const lastActive = times.length ? Math.max(...times) : items[0]!.createdAt;
      if (now - lastActive > threshold) due.push(id);
    }
  }
  return due;
}
