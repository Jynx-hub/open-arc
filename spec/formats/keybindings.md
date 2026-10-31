# `StorableKeyBindings.json`

This file stores only the user's **overrides** of the default shortcuts.

```jsonc
{
  "version": 1,
  "userOverrides": [
    {
      "action": { "identifier": "duplicate", "name": "Duplicate" },
      "state": { "valid": { "_0": { "keyEquivalent": "d", "deviceIndependentModifierFlags": 1048576 } } },
      "source": "userDefined",
      "priority": "low"
    }
  ]
}
```

- `deviceIndependentModifierFlags` is the standard macOS `NSEvent.ModifierFlags` bitmask: ⇧ `131072`, ⌃ `262144`, ⌥ `524288`, ⌘ `1048576`. Add them together for combinations.
- `state` may also be `{"unset": {}}` (the user removed the shortcut).
- The default shortcut table is below. Overrides are layered on top of it.

## Defaults

**Status:** provisional. This table could not be read from Arc's Settings → Shortcuts screen: the analysis machine has no macOS Accessibility or Screen Recording permission, so neither REA native-UI capture nor System Events scripting could see the window. The chords come from public sources: Arc's own help-center articles and release notes, plus third-party cheat sheets for Arc 1.96 and later that agree with each other. Re-check every row against the Settings screen once those permissions are granted.

About the **Identifier** column: these are the case names of Arc's keybindable-action type, which are interoperability identifiers. Two of them, `pinTab` and `duplicate`, have been seen as the exact `action.identifier` value in a real override file. For the rest, that the case name equals the stored identifier is likely but not proven. "—" means no matching case was found; the action may not be rebindable, or its identifier is unknown.

| Action (our description) | Identifier | Default chord |
|---|---|---|
| Open the Command Bar for a new tab | `newTab` | ⌘T |
| Edit the current tab's URL in the Command Bar | `addressBar` (likely) | ⌘L |
| New window | `newWindow` | ⌘N |
| New blank window (no tabs carried over) | `newBlankWindow` | ⌃⌘N |
| New incognito window | — | ⇧⌘N |
| Close the current tab, or the window if it has no tabs | — (`archiveTab`/`closeWindow` exist; mapping unconfirmed) | ⌘W |
| Reopen the last closed tab | — | ⇧⌘T |
| Open Little Arc | `showLittleArc` | ⌥⌘N |
| Move Little Arc tabs into Spaces (keyboard organizer) | — | ⇧⌘O |
| Pin or unpin the current tab | `pinTab` ✓ | ⌘D |
| Copy the current URL | `copyCurrentURL` | ⇧⌘C |
| Copy the current URL as a Markdown link | — | ⌥⇧⌘C |
| Show or hide the sidebar | `showSidebar` | ⌘S |
| Archive every Today tab in the Space (divider "clear") | — (`resetSpace` is a candidate; unconfirmed) | ⇧⌘K |
| Go to the Nth tab in the sidebar | — | ⌘1 … ⌘9 |
| Jump between the two most recently used tabs (hold ⌃ to keep cycling; ⌃W while held closes the highlighted tab) | — (`cycleTabForward` is a candidate) | ⌃⇥ |
| Previous tab in the sidebar | `previousTab` | ⌥⌘↑ |
| Next tab in the sidebar | `nextTab` | ⌥⌘↓ |
| Previous Space | — | ⌥⌘← |
| Next Space | `focusNextSpace` (likely) | ⌥⌘→ |
| Go to the Nth Space | — | ⌃1 … ⌃9 |
| Add a pane to Split View | `addSplitView` | ⌃⇧= (shown as ⌃⇧+) |
| Close the focused Split View pane | `removeSplitView` | ⌃⇧- |
| Focus the Nth Split View pane | — | ⌃⇧1 … ⌃⇧9 |
| New Note | `newNote` | ⌃⇧N |
| Toggle developer mode for the current site | — | ⌃D |
| Back in tab history | `goBack` | ⌘[ (sources also list ⌘←) |
| Forward in tab history | `goForward` | ⌘] (sources also list ⌘→) |
| Reload | `reloadPage` | ⌘R |
| Find on page | `find` | ⌘F |
| History | `viewHistory` | ⌘Y |
| Zoom in / out / reset | `zoomIn` / `zoomOut` / `resetZoom` | ⌘+ / ⌘- / ⌘0 |
| Settings | `viewPreferences` | ⌘, |

Other identifiers in the same action type that have no sourced default chord yet: `archiveTab`, `capturePage`, `captureFullPage`, `cast`, `clearArchive`, `clearCookies`, `closeWindow`, `cycleNextTab`, `developerTools`, `inspectElements`, `viewSource`, `viewDownloads`, `fullscreen`, `exit`, `readerMode`, `findNext`, `findPrevious`, `findAndReplace`, `focusSidebar`, `forceReloadPage`, `hideArc`, `hideOthers`, `joinLiveMeeting`, `jumpToSelection`, `viewLibrary`, `minimize`, `newEasel`, `newFolder`, `newSpace`, `peekEmail`, `printPage`, `quitArc`, `resetSpace`, `resetTab`, `savePageAs`, `selectNextTab`, `viewArchive`, `toggleToolbar`, `stopLoading`, `duplicate` ✓, `rename`, `share`, `typeTravel`, `clearExplore`, `gptMessage`. Most of them presumably keep the standard macOS chord (⌘Q quit, ⌘M minimize, ⌘H hide, ⌥⌘H hide others, ⌘P print, ⌘G / ⇧⌘G find next/previous, ⌥⌘I developer tools, ⌃⌘F full screen), but none of that has been observed.

Known conflicts and edge cases:
- **⌘D:** an override file that binds ⌘D to `duplicate` also sets `pinTab` to `unset`. That fits ⌘D being `pinTab`'s default. Arc tracks a conflict state for each binding (the `ActionState` type has `valid`, `unset` and `conflict` cases), so an implementer should detect two actions on one chord and either refuse the new binding or mark it as a conflict.
- **Back/forward:** public sources disagree. Some list ⌘[ / ⌘], others ⌘← / ⌘→. Arc probably accepts both, as Safari does, but this hasn't been verified.
- **New Note:** an older release moved New Note from ⌃N to ⌃⇧N.
