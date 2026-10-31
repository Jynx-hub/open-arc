# `StorableSidebar.json`

The sidebar file is the core of an Arc setup: every Space, pinned tab, folder and favorite. Schema: [sidebar.schema.json](sidebar.schema.json). Conventions (timestamps, keyed arrays, enum encoding) are in [README.md](README.md).

## Top level

```jsonc
{
  "version": 1,
  "sidebar": {
    "containers": [                     // keyed array: ContainerKey → DataContainer
      { "global": {} },                 // key: the main-window sidebar
      {
        "spaces": [ "<spaceID>", Space, … ],          // keyed array
        "items":  [ "<itemID>",  SidebarItem, … ],    // keyed array, flat
        "topAppsContainerIDs": [ Profile, "<itemID>", … ]
      },
      { "littleBrowser": { "_0": "<id>" } },          // key: a Little Arc window (optional)
      { "spaces": […], "items": […], "topAppsContainerIDs": [] }
    ]
  },
  "sidebarSyncState": { … },   // CloudKit sync bookkeeping, safe to ignore
  "firebaseSyncState": { … }   // Firebase sync bookkeeping, safe to ignore
}
```

`containers` follows the keyed-array convention. Pair entries two at a time and use the data that follows the `{"global": {}}` key. Order is **not** stable across saves: `global` can come before or after `littleBrowser` entries. Key cases (complete list from the app's type metadata):

| Key | Meaning |
|---|---|
| `{"global": {}}` | The main sidebar shared by all regular windows. **This is the one exporters want.** |
| `{"littleBrowser": {"_0": "<id>"}}` | A Little Arc window open at save time, with its own temporary Space. |
| `{"standalone": {"_0": "<id>"}}` | A window with its own standalone sidebar, separate from the global one. Archive entries from it have source `standaloneSidebar`. |
| `incognito` | Private window (not persisted in samples seen so far). |

## Space

| Key | Type | Meaning |
|---|---|---|
| `id` | string | Space ID. The default Space is `thebrowser.company.defaultPersonalSpaceID`. |
| `title` | string | Name shown in the Space switcher. |
| `profile` | Profile | Browser profile the Space uses. `{"default": {}}` or `{"custom": {"_0": {"directoryBasename": "Profile 1"}}}` (custom profile shape not yet verified). |
| `containerIDs` | keyed array | `["pinned", "<itemID>", "unpinned", "<itemID>"]`, mapping the Space's two root containers to sidebar items. |
| `newContainerIDs` | keyed array | Newer form of the same mapping with enum keys, e.g. `[{"pinned": {}}, "<id>", {"unpinned": {"_0": {"shared": {}}}}, "<id>"]`. Prefer this one when present. |
| `customInfo.iconType` | object | Space icon, e.g. `{"icon": "planet"}` (an SF Symbol name) or an emoji variant. |
| `customInfo.windowTheme` | object | Space color theme: a semantic palette per light/dark appearance, with colors given as `{red, green, blue, alpha, colorSpace}` floats from 0 to 1. |

**Pinned** tabs persist. **Unpinned** ("Today") tabs are the ones Arc auto-archives after a period of inactivity.

## SidebarItem

All items live in one flat keyed array. The tree comes from `parentID` and `childrenIds`.

| Key | Type | Meaning |
|---|---|---|
| `id` | string | Item ID. |
| `parentID` | string \| null | Parent item. Root containers have none. |
| `childrenIds` | string[] | Children, **in display order**. |
| `title` | string \| null | User-set title. Overrides the tab's own title when set. |
| `createdAt` | number | Apple-epoch seconds. |
| `isUnread` | bool | Unread badge. |
| `originatingDevice` | string \| null | ID of the device that created the item (used for sync). |
| `data` | SidebarItemData | One-key enum. See below. |

## SidebarItemData cases

The full case list was recovered from the app's type metadata. ✅ = seen in real data and documented; others need a sample before they can be fully specified.

| Case | Meaning | Payload |
|---|---|---|
| `tab` ✅ | A saved tab | `savedURL`, `savedTitle`, `timeLastActiveAt`, optional `savedMuteStatus`, `referrerID`, `activeTabBeforeCreationID` |
| `itemContainer` ✅ | A root container | `containerType`: `{"spaceItems": {"_0": "<spaceID>"}}` (a Space's pinned/unpinned root) or `{"topApps": {"_0": Profile}}` (Favorites row) |
| `list` ✅ | A folder | `{}` (the folder name is the item's `title`) |
| `tabGroup` ✅ | A tab group | `{"title": string}` |
| `splitView` ✅ | Split View of 2+ tabs (the tabs are its `childrenIds`) | `layoutOrientation` (`"horizontal"` seen for a split made by dragging a tab onto the page), `itemWidthFactors`, `focusItemID` (child ID or null), `customInfo` (null unless renamed), `timeLastActiveAt` |
| `arcDocument` | A Note | Contains `arcDocumentID`, `isEditable`, `timeLastActiveAt` (unverified; Arc 1.170 no longer offers new Notes, so no sample) |
| `easel` ✅ | An Easel (canvas) | `easelID` (= the Easel's document ID in the [cloud cache](cloud-cache.md)), `title`, `shareStatus` (`creatorOnly` seen), `creatorID` (Firebase user ID), `timeLastActiveAt`. Content is not here. |
| `sharedObject` | A shared folder/split/Space from another user | TODO |
| `instantLinks` | Instant Links result | TODO |
| `archiveContent` | Archive view entry | TODO |
| `download` | Download in the sidebar | TODO |
| `arcSearch` | Browse-for-me / web-search result | Has `loading` / `error` states |
| `welcomeToArc` | Onboarding item | — |

`itemWidthFactors` is a keyed array (`[childID, fraction, …]`) like `containers`. In the one sample (two tabs at an even split) it listed only the first child, at `0.5`. Panes that aren't listed presumably share the remaining width. Uneven splits and splits of 3+ panes still need samples.

Folders can also carry `automaticLiveFolderData` (Live Folders, which fill automatically from GitHub, RSS and similar sources). Shape TODO: Arc 1.170 offered no way to create a Live Folder, so no sample.

## Reconstructing the tree

```
for each Space:
  pinnedRoot   = item whose id = containerIDs["pinned"]
  unpinnedRoot = item whose id = containerIDs["unpinned"]
  walk root.childrenIds recursively → tabs, folders (list), groups, splits
Favorites = items listed in topAppsContainerIDs → their childrenIds
```

The display title of a tab is `title ?? data.tab.savedTitle`.
