# Boosts
**Status:** draft · **Data:** `StorableBoostsData.json` (format TODO, no sample yet) · **Cloud-dependent:** sharing only

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
- **Sample needed:** create a test Boost in Arc so the on-disk format can be documented.
