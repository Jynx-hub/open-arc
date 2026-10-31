# UI layout & measurements
**Status:** draft (partly measured) · **Data:** [windows](../formats/windows.md) · **Cloud-dependent:** no

All sizes are in points (pt). Values were measured on Arc 1.170.0 running on a 1512 pt-wide built-in display. "Persisted" means the value is in Arc's preferences or data files, which records the user's last choice; that may differ from the factory default.

## How these were measured
The analysis machine has no macOS Accessibility or Screen Recording permission, so screenshots and accessibility frames could not be captured. Every number below comes from one of three sources: window bounds from the window server (which needs no permission), Arc's scripting interface, or persisted preferences and data files. The items under "Not yet measured" need a pass with those permissions granted.

## Main window
- The zoomed main window fills the screen's visible area below the menu bar. On the test display that was 1512 × 866 at y = 33.
- Arc saves the frame under a per-app autosave name and restores it at launch.
- Arc also owns several off-screen or non-interactive helper windows: a few full-width, 33 pt-tall windows at the top of the screen and one 500 × 500 window. Their purpose is unknown, and they don't appear to be user-facing chrome.

## Sidebar
| Property | Value | Source |
|---|---|---|
| Stored width | 228 pt in every observed snapshot (28 snapshots spanning months) | `sidebarViewPreferences.sidebarWidth`, persisted |
| Width scope | One value per install, shared by all windows (it lives at the top level of the windows file, not per window) | data file |
| Visibility modes | `anchored` (sidebar docked and visible) and `noChrome` (sidebar hidden; the page uses the full window width) | `sidebarViewPreferences.sidebarMode` enum |
| Toggle | The show/hide sidebar shortcut (⌘S) switches between the two modes, and the choice persists across launches | data file history shows both values |
| Factory default width | not measured (the format doc's 260 pt example is illustrative only) | — |
| Min / max width | not measured | — |

In `noChrome` mode the sidebar stays reachable as an overlay when the pointer moves to the window's leading edge. This is not yet measured: neither the hover trigger width nor the overlay width is known.

## Little Arc window
- A Little Arc window is a separate top-level window. It **does not appear** in Arc's scripting `windows` list, which only includes normal (and incognito) browser windows.
- Its size is persisted globally as `LittleBrowserWindow_size` (one `{w, h}` string for all Little Arc windows). On open it takes that size and centers horizontally on the screen. Observed: a 1472 × 826 window placed at x = 20, y = 53, which leaves an equal 20 pt margin on each side and sits 20 pt below the menu bar.
- The first-run default size has not been measured; the persisted value reflects the user's resizes.

## Picture in Picture
- PiP remembers its last placement in the `LastPiPPosition` preference, a JSON value that holds a screen-corner anchor (one of the corner cases, e.g. `topRight`) and a size. The observed size is 300 × 168 (about 16:9).
- On the next video it reopens at the same corner and size.

## Other windows (persisted autosave frames)
| Window | Observed size |
|---|---|
| Settings | 684 × 590 |
| Extension popup host | 300 × 601 |
| Web dialog (e.g. a site's auth prompt) | 413 × 257 |
| Developer tools (detached) | 769 × 544 |

These are the last frames the user left. The Settings window is very likely fixed-size.

## Not yet measured
These need a run with Accessibility or Screen Recording permission. Each one should be measured from AX frames on a standard display, at default settings, in a throwaway Profile.

| Item | What to capture |
|---|---|
| Sidebar default, min and max width | drag the divider to both limits in a fresh Profile |
| Sidebar collapse | animation, the leading-edge hover trigger width, overlay width |
| Favorites grid | column count vs. sidebar width, tile size, gap |
| Sidebar tab row | row height, icon size, indent per folder level |
| Space switcher bar | position (bottom of the sidebar), icon size, spacing |
| Command Bar overlay | width, top offset, max visible results, per-row height |
| Toasts | anchor position, duration before auto-dismiss |
| Peek overlay | inset from window edges, corner radius |
| Split View | divider width, minimum pane width |
