# Little Arc & Peek
**Status:** draft · **Data:** [sidebar](../formats/sidebar.md) (`littleBrowser` containers), [link-routing](../formats/link-routing.md) · **Cloud-dependent:** no

## Little Arc
- A small, minimal window with no sidebar, for quick lookups and for links opened from other apps.
- Opened with a global shortcut ("quick search" mode) or when an external link is routed to Little Arc (the default for external links).
- The toolbar has an "open in…" control that moves the tab into a chosen Space, which promotes it to a full tab. It also has a Profile switcher and an extensions button.
- Little Arc tabs auto-archive on their own threshold, and archive entries record source `littleArc`.
- Bulk actions: show all Little Arc windows, or close all of them.
- Each open Little Arc window has its own small sidebar container (`littleBrowser(<id>)`) with a temporary Space.

## Peek
- A floating preview of a link, shown over the current page without creating a tab.
- Triggered by clicking a link to a *different site* from a pinned tab or Favorite, or by shift-clicking a link (each is a separate setting).
- Peek can be expanded into a full tab or dismissed with Escape. A closed Peek can be reopened via undo.
- Hover cards (`hoverCardsEnabled`) are a separate, related feature: a preview that appears on hover.

## Rebuild notes
- Little Arc is a second `BrowserWindow` type with no sidebar.
- Peek is a modal `WebContentsView` over the page. Intercept navigation with `will-navigate` / `setWindowOpenHandler`.
