# Smaller features
**Status:** draft · **Cloud-dependent:** noted per item

| Feature | Behavior | Preference |
|---|---|---|
| **Copy URL** | A shortcut copies the current URL, with a toast. A variant copies it as a Markdown link `[title](url)`, with plural forms when several tabs are selected. | — |
| **Media controls / PiP** | Playing media shows controls in the sidebar. Leaving a video tab can open Picture in Picture automatically. A mini player can be closed. | auto-PiP toggle |
| **Tidy Tabs / Tidy Titles** *(AI, cloud)* | Uses an LLM to group Today tabs into folders and to shorten tab titles. Drop for v1, or support a pluggable local model. | `tidyTabsEnabled` |
| **Tidy Downloads** *(AI, cloud)* | Renames downloaded files to readable names. Can be undone. | `renameDownloadsEnabled` |
| **Instant Links** *(AI, cloud)* | Opens the top search result directly, or a set of results. | `instantLinksEnabled` |
| **Export Spaces as Markdown** | A built-in button exports Spaces and their tabs as Markdown. Our exporter should match it. | — |
| **Developer mode** | Per-host dev features (`enabledHosts`, `disabledDefaultHosts`). | `StorableDeveloperModeState.json` |
| **App icons** | The user can pick from several alternate app icons. | `currentAppIconName` |
| **Sync** | Sidebar sync over CloudKit and Firebase, optionally encrypted. Replace with optional sync through a local folder. | `cloudKitSyncEnabled`, `firebaseSyncEnabled` |
| **Analytics** | Arc sends telemetry and feature flags to Datadog, Sentry and LaunchDarkly. **Not reproduced**: Open Arc sends no telemetry. | — |

## Keyboard shortcuts
Action identifiers and the override format are in [keybindings](../formats/keybindings.md). The **default shortcut table** is still TODO. Fill it in from Arc's Settings → Shortcuts screen; don't take it from the binary.
