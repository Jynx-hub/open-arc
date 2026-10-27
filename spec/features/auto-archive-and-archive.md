# Auto-archive & the Archive
**Status:** draft · **Data:** [archive](../formats/archive.md), [sidebar](../formats/sidebar.md), [windows](../formats/windows.md) · **Cloud-dependent:** no

## What it does
Arc closes Today tabs the user hasn't touched in a while and keeps a searchable history of everything closed, the **Archive**. This keeps the sidebar from filling up with stale tabs.

## Settings
- **Auto-archive threshold:** one of `oneHour`, `sixHours`, `twelveHours`, `twentyFourHours` (the default), `sevenDays`, `thirtyDays`, `never`. A debug-only `twentySeconds` value also exists. The setting is **per Profile** (preference `autoArchiveTimeThresholdsPerProfile`).
- Little Arc windows have a separate "archive Little Arcs after" threshold.

## Behavior
- Only **Today (unpinned)** tabs are auto-archived. Pinned tabs and Favorites never are.
- A tab is archived once `now − lastActive > threshold`. Last-active time is tracked per window (`itemLastActiveDates`) and on the item (`timeLastActiveAt`).
- The tab currently selected in a window is never auto-archived.
- After a run, a toast reports the count ("N tabs auto-archived"). The first time, a one-off education banner explains the feature and links to the setting.
- Every archive event records a **reason**: `auto`, `manual` (the user closed it), `clearButton` (the clear control on the divider), or `clearTabGroup`. It also records a **source**: the Space, Little Arc, or a standalone sidebar.
- Archiving a folder archives the folder and its children. Deleting a folder also archives the tabs inside it.
- Other bulk actions: "archive tabs above" and "archive tabs below" the current one, and "archive other tabs".

## The Archive view
- Lives in the Library. It can be filtered by Space, by Little Arc, and by how the item was closed.
- **Restore** puts an item back in its original Space and shows a toast that offers to jump to it. Restoring a folder brings back its children too.
- **Delete** removes a single entry. **Clear Archive** wipes everything, after a confirmation dialog.

## Rebuild notes
Run a timer about once a minute. For each window, compare the last-active times of the Today items against the Profile's threshold. Move each match to the archive store with `{archivedAt, reason: 'auto', source, sidebarItem}`.
