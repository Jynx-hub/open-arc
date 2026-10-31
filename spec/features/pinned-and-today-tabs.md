# Pinned tabs & Today tabs
**Status:** draft · **Data:** [sidebar](../formats/sidebar.md) · **Cloud-dependent:** no

## What it does
A Space's sidebar has two sections separated by a divider:
- **Pinned** (top) works like a bookmarks bar that is also a set of tabs. Pinned items persist indefinitely.
- **Today** (below the divider, the "unpinned" container) holds ordinary tabs. These are temporary and are archived automatically after inactivity (see [auto-archive](auto-archive-and-archive.md)).

## Triggers
- Drag a tab across the divider, use the context menu ("move to Pinned" / "move to Today"), or use the pin/unpin toggle shortcut.
- A "clear" control on the divider archives every Today tab in the Space. A variant clears every *unselected* Today tab.
- The pinned section can be collapsed and expanded.

## Behavior
- **A pinned tab remembers its home URL.** After browsing away, the tab shows a "back to pinned URL" affordance. The user can reset it to the saved URL or replace the saved URL with the current page.
- When a pinned tab is closed, it stays in the sidebar but unloads ("close and keep pinned"). Clicking it reloads the saved URL.
- When a Today tab is closed, it is removed from the sidebar and goes to the Archive.
- Pinned tabs can be renamed. The custom title is stored on the item and overrides the page title (controlled by the `renamePinnedTabsEnabled` preference).
- Pinning or unpinning shows a confirmation toast.
- A "reset all pinned tabs" action returns every pinned tab in the Space to its saved URL.

## Runtime observations (2026-10-27, Arc 1.170.0, via the scripting interface)
- A tab created in a window (scripting `make new tab` with a URL) lands in **Today** (`unpinned`) and becomes the selected tab.
- Closing the selected Today tab removes it from the sidebar, selects another tab in the same Space, and an Archive entry for the tab shows up in the archive file shortly afterwards.
- Arc's scripting `location` property reports `topApp` (Favorites), `pinned` or `unpinned` for every tab in a window, across all Spaces. Setting it fails: pin and unpin cannot be scripted. The pin/unpin toggle itself was not exercised (it needs keyboard or UI access).

## Storage
- The pinned container is `Space.containerIDs["pinned"]` and Today is `["unpinned"]`.
- A tab's saved URL is `data.tab.savedURL`, and `title` is the user's rename.
- `timeLastActiveAt` drives auto-archive.

## Rebuild notes
Keep `savedURL` (home) separate from the live webContents URL. Unloading a pinned tab destroys its webContents but keeps the sidebar item.
