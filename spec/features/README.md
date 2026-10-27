# Feature specs

There is one file per feature, written from observed behavior: what the user does, what happens, edge cases, and what gets stored (linking to [`../formats/`](../formats/)).

Each spec uses this template:

```markdown
# <Feature>
**Status:** draft | verified · **Data:** <format doc links> · **Cloud-dependent:** yes/no

## What it does
## How the user triggers it (UI, shortcuts)
## Behavior & state transitions
## Edge cases
## Storage
## Rebuild notes (local-only replacement if it needed Arc's cloud)
```

## Inventory

All specs below are **drafts**: derived from on-disk data, preferences, and binary type/string metadata, then written in our own words. Each still needs a runtime check against live Arc before it can be marked `verified`.

| Spec | Covers | Cloud? |
|---|---|---|
| [spaces-and-profiles](spaces-and-profiles.md) | Spaces, themes, icons, Profiles, Space Manager | no |
| [pinned-and-today-tabs](pinned-and-today-tabs.md) | Pinned vs. Today, saved URLs, rename, reset | no |
| [auto-archive-and-archive](auto-archive-and-archive.md) | Thresholds, auto-archive rules, Archive view, restore | no |
| [folders-favorites-groups](folders-favorites-groups.md) | Folders, Favorites, tab groups, Live Folders | Live Folders only |
| [split-view](split-view.md) | Split View layouts and actions | no |
| [little-arc-and-peek](little-arc-and-peek.md) | Little Arc, Peek, hover cards | no |
| [air-traffic-control](air-traffic-control.md) | External link routing rules | no |
| [command-bar](command-bar.md) | Launcher, Site Search, learned ranking | partly |
| [boosts](boosts.md) | Per-site CSS/JS, sharing rules | sharing only |
| [notes-easels-library](notes-easels-library.md) | Notes, Easels, Captures, Library | **yes, export before shutdown** |
| [small-features](small-features.md) | Copy URL, PiP, Tidy*, Instant Links, sync, telemetry, shortcuts | mixed |
