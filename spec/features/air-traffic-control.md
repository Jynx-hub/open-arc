# Air Traffic Control (link routing)
**Status:** draft · **Data:** [link-routing](../formats/link-routing.md) · **Cloud-dependent:** no

## What it does
Rules that decide where a link opened from **another app** (Mail, Slack, etc.) lands. A rule can send matching URLs to a particular Space or to Little Arc. Example: links to a music site always open in the Personal Space.

## Behavior
- Each rule is a URL match condition plus a destination. `contains` is the observed operator.
- Destinations: a specific Space, the most recent Space, or Little Arc.
- Rules are checked in order and the first match wins. Everything else goes to the default destination (Little Arc, out of the box).
- Arc seeds a built-in default that sends video-meeting links to the current Space, then shows a one-time toast about it.
- Rules are managed in Settings under "Air Traffic Control", which can also be opened from the Command Bar.

## Rebuild notes
On macOS, register as the default browser and handle `open-url`. Run the rules, then route the URL to a window and Space.
