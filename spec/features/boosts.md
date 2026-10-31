# Boosts
**Status:** draft · **Data:** [cloud cache](../formats/cloud-cache.md) › `boosts` (Firestore). No `StorableBoostsData.json` is written on Arc 1.170, even after creating a Boost. · **Cloud-dependent:** stored via the cloud, with a local offline copy

## What it does
Per-site customizations the user creates in Arc: custom CSS, a font or color theme, element hiding ("zap"), and custom JavaScript. They are applied automatically every time the site loads.

## Behavior
- Boosts are created or edited from the site control center (the menu next to the URL) or from the "new Boost" menu item. A built-in editor provides simple controls (colors, fonts, zap) and code editors.
- Each Boost targets one site (domain). It can be enabled or disabled, renamed or deleted, and all Boosts are managed from a Boosts page in Arc Home.
- **Sharing:** a Boost can be shared through a link. Installing one from a link shows a warning that creator names aren't verified. When the user deletes a shared Boost, the link stops working, but anyone who already installed it keeps it.
- **Security rule:** shared Boosts carry **CSS only**. Arc rejects shared Boost data that contains JavaScript, so JS Boosts stay local.
- Boosts can't be installed from an Incognito window.

## Rebuild notes
- Inject CSS with `webContents.insertCSS` and JS with `executeJavaScript` in an isolated world on `dom-ready` for matching hosts.
- The exporter should write each Boost as a userstyle for the Stylus extension (CSS) and a userscript for Tampermonkey/Violentmonkey (JS).
- The visual editor's color setting is stored as color-wheel parameters (hue, saturation, secondary-hue offset, light/dark base), not as CSS. To reproduce it, derive a theme from those values; an exact match to Arc's recoloring isn't possible without its algorithm.
- **Still needed:** samples of a zapped element and of a Boost with custom CSS/JS (the attempted code sample did not persist).
