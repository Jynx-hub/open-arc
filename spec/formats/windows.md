# `StorableWindows.json`

```jsonc
{
  "version": 1,
  "lastFocusedSpaceID": "<spaceID>",
  "sidebarViewPreferences": { "sidebarWidth": 260, "sidebarMode": "<mode>" },
  "windows": [ "<windowID>", Window, … ]   // keyed array; empty when no windows are open
}
```

`Window` includes `itemLastActiveDates`, a keyed array of `itemID → Apple-epoch seconds` that drives auto-archive timing. The rest of the window shape is TODO.
