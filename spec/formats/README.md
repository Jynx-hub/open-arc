# Arc on-disk data formats

Arc (macOS) keeps its own state as JSON files in:

```
~/Library/Application Support/Arc/
```

Chromium-level data (history, cookies, passwords, extensions) lives separately under `User Data/` in the standard Chromium profile layout, which Chromium's own docs and existing open-source tools already cover.

## Conventions used across every `Storable*.json` file

| Convention | Detail |
|---|---|
| **Versioned** | Every file has a top-level integer `version`. |
| **Rotating backups** | Arc writes `StorableX.json` plus timestamped copies `StorableX.YYYY-MM-DD-HH-MM-SS-mmm.json`. The undated file is current. |
| **Timestamps** | Floats in seconds since **2001-01-01T00:00:00Z** (Apple reference date). Unix time = value + `978307200`. |
| **Keyed collections** | Dictionaries are stored as flat arrays alternating key and value: `["id-1", {…}, "id-2", {…}]`. Pair them up two at a time. |
| **Enums with payloads** | A single-key object whose key is the case name: `{"pinned": {}}`. Positional payloads use `_0`, `_1`: `{"spaceItems": {"_0": "<space-id>"}}`. Cases without payloads are encoded as `{}` (older files sometimes use `true`). |
| **IDs** | Uppercase UUID strings, plus a few fixed IDs prefixed `thebrowser.company.` for the default Space and its containers. |

## Files

| File | Holds | Doc |
|---|---|---|
| `StorableSidebar.json` | Spaces, pinned/unpinned tabs, folders, Top Apps (favorites), split views, notes, easels | [sidebar.md](sidebar.md) |
| `StorableArchiveItems.json` | Archived (closed / auto-archived) sidebar items | [archive.md](archive.md) |
| `StorableLinkRouting.json` | Air Traffic Control rules (which links open where) | [link-routing.md](link-routing.md) |
| `StorableKeyBindings.json` | User keyboard-shortcut overrides | [keybindings.md](keybindings.md) |
| `StorableWindows.json` | Open windows, sidebar width/mode, last focused Space | [windows.md](windows.md) |
| `StorableCommandBarAdditionalRanking.json` | Command Bar ranking signals (queries → chosen result, recent tab switches) | TODO |
| `StorableDownloadMetadata.json` | Download ID → `{url, date}` | TODO |
| `StorableHome.json`, `StorableLiveData.json`, `StorableDeveloperModeState.json`, `StorableSessionRestorationData.json` | Minor state | TODO |
| `StorableAuthState.json`, `StorableFirebaseEncryptionKey.json` | **Account secrets. Tools must never read, copy or upload these.** | — |

Machine-readable schemas sit next to each doc as `*.schema.json` (JSON Schema 2020-12).
