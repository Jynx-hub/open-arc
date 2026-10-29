// The page right-click menu, as data. Which entries appear depends only on what was clicked, so the
// rules are testable without Electron; main/browser.ts turns entries into a native menu.

/** The parts of Electron's `ContextMenuParams` the menu looks at. */
export interface PageMenuParams {
  linkURL: string;
  srcURL: string;
  mediaType: string;
  selectionText: string;
  isEditable: boolean;
  misspelledWord: string;
  dictionarySuggestions: string[];
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

export interface PageMenuCaps {
  canGoBack: boolean;
  canGoForward: boolean;
  /** Split View needs a sidebar tab to split with; Peek and mini windows don't have one. */
  canSplit: boolean;
  /** A private window's pages open links only as private tabs (no mini window, which would use a normal Profile). */
  isPrivate?: boolean;
}

export type PageMenuId =
  | 'openLinkNewTab' | 'openLinkSplit' | 'openLinkLittle' | 'copyLink' | 'saveLinkAs'
  | 'openImageNewTab' | 'copyImage' | 'copyImageAddress' | 'saveImageAs'
  | 'cut' | 'copy' | 'paste' | 'selectAll' | 'searchSelection' | 'addToDictionary'
  | 'back' | 'forward' | 'reload' | 'inspect';

export type PageMenuEntry =
  | { id: PageMenuId; label: string; enabled?: boolean }
  | { id: 'replaceMisspelling'; label: string; word: string }
  | { id: 'separator' };

const SEARCH_LABEL_MAX = 24;

export function contextMenuTemplate(p: PageMenuParams, caps: PageMenuCaps): PageMenuEntry[] {
  const groups: PageMenuEntry[][] = [];
  const selection = p.selectionText.trim();

  if (p.isEditable && p.misspelledWord) {
    groups.push([
      ...p.dictionarySuggestions.slice(0, 5).map((word): PageMenuEntry => ({ id: 'replaceMisspelling', label: word, word })),
      ...(p.dictionarySuggestions.length ? [] : [{ id: 'replaceMisspelling', label: 'No suggestions', word: '' } as PageMenuEntry]),
      { id: 'addToDictionary', label: 'Learn Spelling' },
    ]);
  }
  if (p.linkURL) {
    groups.push([
      { id: 'openLinkNewTab', label: 'Open Link in New Tab' },
      ...(caps.canSplit ? [{ id: 'openLinkSplit', label: 'Open Link Side by Side' } as PageMenuEntry] : []),
      ...(caps.isPrivate ? [] : [{ id: 'openLinkLittle', label: 'Open Link in Mini Window' } as PageMenuEntry]),
      { id: 'copyLink', label: 'Copy Link' },
      { id: 'saveLinkAs', label: 'Download Link As…' },
    ]);
  }
  if (p.mediaType === 'image' && p.srcURL) {
    groups.push([
      { id: 'openImageNewTab', label: 'Open Image in New Tab' },
      { id: 'copyImage', label: 'Copy Image' },
      { id: 'copyImageAddress', label: 'Copy Image Address' },
      { id: 'saveImageAs', label: 'Save Image As…' },
    ]);
  }
  if (p.isEditable) {
    groups.push([
      { id: 'cut', label: 'Cut', enabled: p.editFlags.canCut },
      { id: 'copy', label: 'Copy', enabled: p.editFlags.canCopy },
      { id: 'paste', label: 'Paste', enabled: p.editFlags.canPaste },
      { id: 'selectAll', label: 'Select All', enabled: p.editFlags.canSelectAll },
    ]);
  } else if (selection) {
    groups.push([{ id: 'copy', label: 'Copy' }]);
  }
  if (selection) groups.push([{ id: 'searchSelection', label: `Search the Web for “${truncate(selection, SEARCH_LABEL_MAX)}”` }]);
  // Navigation only when nothing more specific was clicked, so link and text menus stay short.
  if (!p.linkURL && !p.isEditable && !selection && p.mediaType !== 'image') {
    groups.push([
      { id: 'back', label: 'Back', enabled: caps.canGoBack },
      { id: 'forward', label: 'Forward', enabled: caps.canGoForward },
      { id: 'reload', label: 'Reload' },
    ]);
  }
  groups.push([{ id: 'inspect', label: 'Inspect Element' }]);

  return groups.flatMap((g, i) => (i ? [{ id: 'separator' } as PageMenuEntry, ...g] : g));
}

/** The default search engine's URL for a query. */
export function searchURL(template: string, query: string): string {
  return template.replace('%s', encodeURIComponent(query.trim()));
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
