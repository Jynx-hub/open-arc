# Notes, Easels, Library & Captures
**Status:** draft · **Data:** sidebar (`arcDocument`, `easel`), cloud · **Cloud-dependent:** **yes**

> ⚠️ **Preservation priority.** Note and Easel *content* lives in Arc's cloud backend (Firebase). The sidebar file holds only references. **Easel content is also kept in the local Firestore offline cache** (see [cloud cache](../formats/cloud-cache.md)): text, positions and z-order for each canvas object, for Easels the app has opened (it can include Easels no longer in the sidebar). Deleted Easels leave empty entries. Coverage depends on what Arc has synced locally: one sample machine referenced 13 Easel IDs, but only 2 still held data. An exporter can therefore recover cached Easels after Arc's servers shut down, as long as the cache is still on disk. Notes: Arc 1.170 no longer creates new Notes, and whether old Note content is cached locally is unverified. Arc had already deprecated Notes and offered an export.

## Notes
- Rich-text documents that sit in the sidebar next to tabs, created from the "+" menu or opened beside the current page.
- They can be shared as a public link that any browser can view.
- Local reference: a sidebar item with `data.arcDocument` containing an `arcDocumentID`.

## Easels
- Freeform canvases mixing text, drawings, images, captured page regions, and **live web cards** (a captured region that keeps updating from the page).
- Shared Easels can be viewed in any browser but edited only in Arc. The creator's name is visible to anyone with the link.
- Local reference: `data.easel` containing an `easelID`.

## Captures & Library
- **Capture:** select a region of a page, then save it as an image or video, copy it, or add it to an Easel.
- **Library:** a full-screen view collecting Archive, Downloads, Captures, Easels and Notes, and optionally media from the user's Desktop, Documents and Downloads folders. Media stays on the computer.

## Rebuild notes
- v1: Notes become local Markdown files shown in the sidebar.
- Easels: defer, or embed an open-source canvas such as tldraw or Excalidraw.
- Captures: `webContents.capturePage(rect)`.
