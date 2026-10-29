# Open Arc browser (working name)

A local-first browser with a sidebar workflow: Spaces, pinned and Today tabs, auto-archive, a Command Bar, Split View, Peek, mini windows, link rules, Boosts, Notes and Easels. It is built **only** from [`../spec`](../spec) and public Electron/Chromium documentation. See [CLEANROOM.md](../CLEANROOM.md).

No accounts, no sync service, no telemetry. Everything is stored in one JSON file in the app's data folder.

## Run

```bash
npm install
npm run build && npm start   # build, then launch Electron
npm test                     # unit tests (Vitest): reducer, import, search, routing, archiving, keymap, Live Folders
npm run test:e2e             # end-to-end (Playwright driving Electron) against a throwaway profile folder
```

On first launch it offers to import from Arc. Only the three files `arc-export` reads are opened (`StorableSidebar.json`, `StorableArchiveItems.json`, `StorableLinkRouting.json`), and they are never modified.

## Layout

| Path | What |
|---|---|
| `src/shared/` | Pure logic: the state model, the reducer (every state change), tree helpers, Command Bar ranking, link routing, auto-archive selection, keymap, Arc import mapping |
| `src/main/` | Electron main process: state store (atomic JSON saves), one `WebContentsView` per loaded tab, windows and layout, Profiles as session partitions, Boost injection, Live Folder fetchers |
| `src/renderer/` | React UI: sidebar, Command Bar, Library/Archive, Settings, Space editor and manager, Boost editor, Note and Easel editors |
| `e2e/` | Playwright flows; `realdata.private.spec.ts` runs only when `OPEN_ARC_REAL_DATA` points at a private copy of Arc data |

## Spec coverage

| Spec | Status here |
|---|---|
| spaces-and-profiles | Spaces (create/edit/reorder/delete → Archive, folder ↔ Space), Profiles as separate sessions, Favorites per Profile, swipe/⌃N switching |
| pinned-and-today-tabs | Home URL kept for pinned tabs, "back to home", set-home, unload-on-close, rename, clear Today (+ undo), collapse |
| auto-archive-and-archive | Per-Profile thresholds, never the selected tab, reasons and sources, first-run explainer, Archive filters/restore/delete/clear |
| folders-favorites-groups | Nested folders, drag and drop, Favorites grid, tab groups, Live Folders (RSS/Atom, GitHub PRs) |
| command-bar | Tabs in every Space, history, Archive, commands, Site Search with Tab, frecency + learned per-query picks |
| split-view | N panes, row/column flip, drag to resize, close pane, separate, auto-dissolve below two panes |
| little-arc-and-peek | Mini windows with "open in Space" (archived with source `littleArc` on close), Peek for cross-site links from pinned tabs |
| air-traffic-control | Ordered `contains` rules, first match wins, default destination, `open-url` handling, set as default browser |
| boosts | Per-site CSS, hidden elements, font, background, isolated-world JS; share exports CSS only as a userstyle |
| notes-easels-library | Local Markdown Notes, a local canvas for Easels (strokes, text, pasted images), area Captures, Library |
| keybindings | Defaults from `spec/formats/keybindings.md` (provisional there), user overrides with conflict handling |

Not reproduced, per spec: telemetry, cloud sync, AI features, and sharing that depended on Arc's servers.
