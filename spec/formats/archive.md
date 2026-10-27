# `StorableArchiveItems.json`

The Archive is Arc's record of sidebar items that were closed or auto-archived. Schema: [archive.schema.json](archive.schema.json).

```jsonc
{
  "version": 1,
  "items": [ "<archiveEntryID>", ArchiveEntry, … ]   // keyed array
}
```

## ArchiveEntry

| Key | Type | Meaning |
|---|---|---|
| `archivedAt` | number | Apple-epoch seconds when the item was archived. |
| `reason` | string | `manual` (user closed it), `auto` (inactivity auto-archive), `clearButton` (the sidebar "Clear" action), `clearTabGroup`. |
| `source` | enum | Where the item came from: `{"space": {"_0": "<spaceID>"}}`, `{"littleArc": {}}`, `{"standaloneSidebar": {}}`, `{"unknown": {}}`. |
| `sidebarItem` | SidebarItem | A full copy of the item as it was, in the same shape as in [sidebar.md](sidebar.md). Restoring it puts it back. |

`StorableArchive.json` is a small index file, and its rotating backups hold earlier copies. Exporters should read `StorableArchiveItems.json`.
