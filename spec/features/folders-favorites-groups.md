# Folders, Favorites & tab groups
**Status:** draft · **Data:** [sidebar](../formats/sidebar.md) · **Cloud-dependent:** no (Live Folders: yes)

## Folders
- Nested containers of tabs, Notes, Easels and other folders, shown in the sidebar (`data.list`; the name is the item's `title`).
- Create one from the "+" menu or a shortcut. With multiple items selected, the new folder is created containing them.
- Folders expand and collapse. Drag and drop moves items in and out and reorders them.
- Folders can be shared (`sharedObject`, cloud) or turned into a Space.
- Archiving or deleting a folder archives everything inside it.

## Favorites (Top Apps)
- A grid of icon-only tiles at the top of the sidebar, **shared by every Space that uses the same Profile**.
- Add one by dragging a tab into the grid or with the "move to Favorites" action. Remove with "remove from Favorites".
- They behave like pinned tabs: they keep a saved URL, and closing one unloads it rather than removing it.
- Storage: an `itemContainer` with `containerType.topApps(<profile>)`, listed in `topAppsContainerIDs`.

## Tab groups
- A lightweight titled group of tabs (`data.tabGroup.title`). The "clear tab group" action archives its members (archive reason `clearTabGroup`).

## Live Folders
- Folders that fill themselves from an integration, for example GitHub pull requests or issues, or a feed. They refresh in the background.
- Stored as a folder with `automaticLiveFolderData` (shape TODO).
- **Rebuild:** v1 can ship RSS/Atom and GitHub (using a personal token the user provides) as local fetchers.
