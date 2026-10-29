// Default keymap. Action ids are ours; `arcId` links to Arc's identifiers in
// spec/formats/keybindings.md so imported overrides land on the right action.
// Accelerators use Electron syntax. Defaults follow spec/formats/keybindings.md › Defaults (provisional there).

export interface KeyAction {
  id: string;
  label: string;
  accelerator: string | null;
  arcId?: string;
  menu: 'File' | 'Edit' | 'View' | 'Spaces' | 'Tabs' | 'Window';
}

export const KEY_ACTIONS: KeyAction[] = [
  { id: 'commandBar', label: 'New Tab…', accelerator: 'CmdOrCtrl+T', arcId: 'newTab', menu: 'File' },
  { id: 'newWindow', label: 'New Window', accelerator: 'CmdOrCtrl+N', arcId: 'newWindow', menu: 'File' },
  { id: 'newBlankWindow', label: 'New Blank Window', accelerator: 'Ctrl+CmdOrCtrl+N', arcId: 'newBlankWindow', menu: 'File' },
  { id: 'littleArc', label: 'New Mini Window', accelerator: 'CmdOrCtrl+Alt+N', arcId: 'showLittleArc', menu: 'File' },
  { id: 'closeTab', label: 'Close Tab', accelerator: 'CmdOrCtrl+W', menu: 'File' },
  { id: 'reopenClosed', label: 'Reopen Last Closed', accelerator: 'CmdOrCtrl+Shift+T', menu: 'File' },
  { id: 'focusURL', label: 'Edit Address…', accelerator: 'CmdOrCtrl+L', arcId: 'addressBar', menu: 'File' },
  { id: 'copyURL', label: 'Copy Address', accelerator: 'CmdOrCtrl+Shift+C', arcId: 'copyCurrentURL', menu: 'Edit' },
  { id: 'copyMarkdownLink', label: 'Copy as Markdown Link', accelerator: 'CmdOrCtrl+Shift+Alt+C', menu: 'Edit' },
  { id: 'find', label: 'Find in Page…', accelerator: 'CmdOrCtrl+F', arcId: 'find', menu: 'Edit' },
  { id: 'toggleSidebar', label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+S', arcId: 'showSidebar', menu: 'View' },
  { id: 'reload', label: 'Reload', accelerator: 'CmdOrCtrl+R', arcId: 'reloadPage', menu: 'View' },
  { id: 'back', label: 'Back', accelerator: 'CmdOrCtrl+[', arcId: 'goBack', menu: 'View' },
  { id: 'forward', label: 'Forward', accelerator: 'CmdOrCtrl+]', arcId: 'goForward', menu: 'View' },
  { id: 'zoomIn', label: 'Zoom In', accelerator: 'CmdOrCtrl+=', arcId: 'zoomIn', menu: 'View' },
  { id: 'zoomOut', label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', arcId: 'zoomOut', menu: 'View' },
  { id: 'zoomReset', label: 'Actual Size', accelerator: 'CmdOrCtrl+0', arcId: 'resetZoom', menu: 'View' },
  { id: 'devTools', label: 'Developer Tools', accelerator: 'CmdOrCtrl+Alt+I', arcId: 'developerTools', menu: 'View' },
  { id: 'history', label: 'History', accelerator: 'CmdOrCtrl+Y', arcId: 'viewHistory', menu: 'View' },
  { id: 'library', label: 'Library', accelerator: null, arcId: 'viewLibrary', menu: 'View' },
  { id: 'nextSpace', label: 'Next Space', accelerator: 'CmdOrCtrl+Alt+Right', arcId: 'focusNextSpace', menu: 'Spaces' },
  { id: 'prevSpace', label: 'Previous Space', accelerator: 'CmdOrCtrl+Alt+Left', menu: 'Spaces' },
  { id: 'newSpace', label: 'New Space…', accelerator: null, arcId: 'newSpace', menu: 'Spaces' },
  { id: 'spaceManager', label: 'Manage Spaces…', accelerator: null, menu: 'Spaces' },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `space${i + 1}`, label: `Space ${i + 1}`, accelerator: `Ctrl+${i + 1}`, menu: 'Spaces' as const })),
  { id: 'togglePin', label: 'Pin / Unpin Tab', accelerator: 'CmdOrCtrl+D', arcId: 'pinTab', menu: 'Tabs' },
  { id: 'duplicate', label: 'Duplicate Tab', accelerator: null, arcId: 'duplicate', menu: 'Tabs' },
  { id: 'newFolder', label: 'New Folder', accelerator: null, arcId: 'newFolder', menu: 'Tabs' },
  { id: 'clearToday', label: 'Clear Today Tabs', accelerator: 'CmdOrCtrl+Shift+K', menu: 'Tabs' },
  { id: 'resetPinned', label: 'Go to Home URL', accelerator: null, arcId: 'resetTab', menu: 'Tabs' },
  { id: 'recentTab', label: 'Switch to Last Tab', accelerator: 'Ctrl+Tab', menu: 'Tabs' },
  { id: 'nextTab', label: 'Next Tab', accelerator: 'CmdOrCtrl+Alt+Down', arcId: 'nextTab', menu: 'Tabs' },
  { id: 'prevTab', label: 'Previous Tab', accelerator: 'CmdOrCtrl+Alt+Up', arcId: 'previousTab', menu: 'Tabs' },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `tab${i + 1}`, label: `Tab ${i + 1}`, accelerator: `CmdOrCtrl+${i + 1}`, menu: 'Tabs' as const })),
  { id: 'splitAdd', label: 'Add Split Pane', accelerator: 'Ctrl+Shift+=', arcId: 'addSplitView', menu: 'Tabs' },
  { id: 'splitClosePane', label: 'Close Split Pane', accelerator: 'Ctrl+Shift+-', arcId: 'removeSplitView', menu: 'Tabs' },
  ...Array.from({ length: 4 }, (_, i) => ({ id: `pane${i + 1}`, label: `Split Pane ${i + 1}`, accelerator: `Ctrl+Shift+${i + 1}`, menu: 'Tabs' as const })),
  { id: 'splitFlip', label: 'Flip Split Layout', accelerator: null, menu: 'Tabs' },
  { id: 'splitSeparate', label: 'Separate Split', accelerator: null, menu: 'Tabs' },
  { id: 'newNote', label: 'New Note', accelerator: 'Ctrl+Shift+N', arcId: 'newNote', menu: 'Tabs' },
  { id: 'newEasel', label: 'New Easel', accelerator: null, arcId: 'newEasel', menu: 'Tabs' },
  { id: 'capture', label: 'Capture Area', accelerator: null, arcId: 'capturePage', menu: 'Tabs' },
  { id: 'boost', label: 'Boost This Site…', accelerator: null, menu: 'Tabs' },
  { id: 'linkRules', label: 'Link Rules…', accelerator: null, menu: 'Window' },
  { id: 'settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', arcId: 'viewPreferences', menu: 'Window' },
];

/** Accelerator for an action after user overrides (`null` override = unset). */
export function acceleratorFor(id: string, overrides: Record<string, string | null>): string | null {
  if (id in overrides) return overrides[id] ?? null;
  return KEY_ACTIONS.find((a) => a.id === id)?.accelerator ?? null;
}

const FLAG_BITS: [number, string][] = [
  [262144, 'Ctrl'],
  [524288, 'Alt'],
  [131072, 'Shift'],
  [1048576, 'Cmd'],
];

/** Arc's override entry (`keyEquivalent` + NSEvent modifier bitmask) → Electron accelerator. */
export function arcChordToAccelerator(keyEquivalent: string, flags: number): string {
  const mods = FLAG_BITS.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name);
  return [...mods, keyEquivalent.length === 1 ? keyEquivalent.toUpperCase() : keyEquivalent].join('+');
}
