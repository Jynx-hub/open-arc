# arc-export

Get your Arc setup out before Arc goes away: Spaces, pinned tabs, folders, Favorites, Split Views, the Archive, and Air Traffic Control routes.

```bash
npx arc-export            # writes ./arc-export-YYYY-MM-DD/
npx arc-export --summary  # just print what it found
```

Requires Node 18.3+. No dependencies.

## What you get

| File | Use it for |
|---|---|
| `arc-bookmarks.html` | **Import into any browser** (Chrome, Firefox, Safari, Zen, Brave, Edge…). Layout: `Arc / <Space> / Pinned`, `Today`, plus `Arc / Favorites`. |
| `arc-spaces.md` | A readable outline of every Space and its tabs, plus your link-routing rules. |
| `arc-export.json` | Everything in one structured file, for other tools and the Open Arc browser's importer. |
| `arc-archive.csv` | Your full Archive (closed tabs): when, why (`auto` / `manual` / …), and which Space. |

### Importing the bookmarks
- **Chrome / Brave / Edge:** Bookmarks → Bookmark manager → ⋮ → *Import bookmarks*.
- **Firefox / Zen:** Bookmarks → *Manage bookmarks* → Import and Backup → *Import Bookmarks from HTML*.
- **Safari:** File → Import From → *Bookmarks HTML File*.

## Options

```
--arc-dir <dir>    Arc data folder (default: ~/Library/Application Support/Arc)
--out <dir>        Output folder
--format <list>    bookmarks,markdown,json,archive (default: all)
--no-today         Leave Today (unpinned) tabs out of the bookmarks file
--summary          Print counts only
```

## Safety
- **Read-only.** arc-export never writes to Arc's folder.
- **Reads only three files:** `StorableSidebar.json`, `StorableArchiveItems.json`, `StorableLinkRouting.json`. Your Arc account tokens and encryption keys are never opened.
- **Offline.** No network calls, no telemetry.

## Not exported (yet)
- **Note and Easel content.** Arc stores it on its servers, not your Mac, so arc-export can only list their titles. Export Notes from inside Arc while it still works.
- **Boosts.** Planned (Stylus userstyles and userscripts) once the on-disk format is documented.
- **History, passwords, cookies.** These live in Arc's Chromium profile. Use your new browser's "import from Chrome/Arc" option.

Built from the clean-room spec in [`../spec`](../spec). Not affiliated with The Browser Company.
