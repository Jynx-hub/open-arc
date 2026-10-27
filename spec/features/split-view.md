# Split View
**Status:** draft · **Data:** [sidebar](../formats/sidebar.md) (`splitView` payload TODO) · **Cloud-dependent:** no

## What it does
Shows two or more tabs side by side, or stacked, in one window. Arc saves the split as a single sidebar item that contains the tabs.

## Triggers
- Drag a sidebar tab into the middle of the page area.
- Use "open in Split View" on a tab, link or Command Bar result.
- Add a pane to the left, right, top or bottom from the Split View menu or with shortcuts.
- Select multiple tabs, then choose "create Split View".

## Behavior
- Panes can be laid out **vertically** (side by side) or **horizontally** (stacked), and the layout can be flipped. Panes are resized by dragging the divider between them.
- The split appears in the sidebar as one item with child tabs. It can be renamed (the title field has placeholder text).
- Pane actions: close the pane, separate it into its own tab, copy a URL into the split, and "separate all", which dissolves the split.
- Shortcuts jump to the first through fourth Split View in the current window, or to the next or previous one.
- When a split is left with no children, it is cleaned up automatically. The app logs these as "zombie" splits.
- A Split View can be shared (cloud).

## Rebuild notes
Use one `BrowserWindow` with N `WebContentsView`s laid out in a flex row or column. Store `{orientation, children[], sizes[]}` on the sidebar item.
