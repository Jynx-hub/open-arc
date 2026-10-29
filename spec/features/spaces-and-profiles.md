# Spaces & Profiles
**Status:** draft (data + binary metadata; runtime check pending) · **Data:** [sidebar](../formats/sidebar.md) · **Cloud-dependent:** no

## What it does
A **Space** is a separate sidebar with its own name, icon, color theme, pinned tabs and Today tabs. Users keep Spaces for different contexts, such as work, personal or a side project, and switch between them instantly.

A **Profile** is a separate browser data store: cookies, logins, history, extensions and Favorites. Every Space is assigned exactly one Profile, and several Spaces can share one. The Default Profile always exists and can't be deleted.

## Triggers
- Switch Spaces with a two-finger horizontal swipe on the sidebar, by clicking the Space icons at the bottom of the sidebar, with next/previous shortcuts, or with a numbered shortcut for the Nth Space.
- Create a Space from the "+" in the Space bar. Choose a name, icon and theme, then pick an existing Profile or create a new one.
- The Space context menu offers rename, change icon, edit theme, edit Profile, new folder, share, and delete.
- The Space Manager is a full-screen view for reordering Spaces and moving folders and tabs between them.
- A folder can be turned into a new Space, and a Space can be turned into a folder.

## Behavior
- Each window shows one Space at a time. Different windows can show different Spaces.
- Favorites belong to the **Profile**, not the Space. Every Space that shares a Profile shows the same Favorites row.
- Switching to a Space that uses a different Profile changes the browser data in use. Arc warns that the user may be logged out of sites or see different Favorites and extensions.
- Some settings are per Profile, auto-archive interval included. When the user changes one, Arc asks whether to apply it to all Profiles or only this one.
- Unused Profiles (assigned to no Space) can be deleted in bulk. Doing so permanently removes their cookies, history and logins.
- An optional Space header at the top of the sidebar shows the Space name.

## Edge cases
- A Space whose Profile is missing on this machine shows a "missing profile" recovery state.
- Deleting a Space archives its tabs (archive source = that Space).

## Runtime observations (2026-10-27, Arc 1.170.0, via the scripting interface)
- The scripting `focus` command on a Space switches the window to it at once, and the window's `active space` updates right away. Focusing the original Space switches back. Focusing a Space never creates or removes tabs.
- The default Space's ID is a fixed, non-UUID string (`thebrowser.company.defaultPersonalSpaceID`). Spaces created later use UUIDs. Implementers importing data must accept both forms.
- The scripting dictionary lists a window's Spaces in sidebar order. It exposes each Space's `id` and `title` only (no icon or theme).

## Storage
Spaces are in `StorableSidebar.json`. Profile assignment is `Space.profile`. Icon and theme are in `Space.customInfo`. Space order is in `sidebarSyncState.container.value.orderedSpaceIDs`. Profile browser data lives in Chromium's `User Data/<Profile>` directories.

## Rebuild notes
Map each Profile to an Electron `session.fromPartition('persist:<profile>')`. A Space is pure app state: `{id, title, icon, theme, profileId, pinnedRootId, todayRootId}`.
