# Command Bar
**Status:** draft · **Data:** `StorableCommandBarAdditionalRanking.json` (format TODO) · **Cloud-dependent:** partly (search suggestions, AI answers)

## What it does
A single launcher, opened with ⌘T or the new-tab button, that combines a URL bar, web search, tab switcher, history search and a command palette for every app action.

## Result types
- Open tabs in any Space ("switch to tab", including tabs inside a Split View).
- History and archived items.
- Web search suggestions from the default engine.
- **App actions**: nearly every menu command is searchable (new Space, move to Favorites, open Air Traffic Control, toggle settings, and so on).
- **Site Search**: type a site keyword, then press Tab or Space to search that site directly. Arc ships seeded defaults (`seededPopularSiteSearches`), and the user can add, change or remove entries.
- Extensions (launch an extension's action).
- Optional AI answers (an "ask" result type). Drop for v1, or make it pluggable.

## Ranking
- Results are learned from the user's own behavior. Arc stores, per Profile, which result was picked for which typed query (`queriesToSelectedArchetype`), recent tab switches (`recentlySwitchedToTabs`), and per-shortcut "type travel" usage. It then scores candidates on numeric features and normalizes the scores per result type.
- Rebuild: score with frecency (frequency + recency) plus an exact-prefix bonus from the user's own past choices for the same query.

## Edge cases
- The first-run hint teaches ⌘T for creating the first tab.
- A privacy prompt about search suggestions is shown once and can be dismissed.
