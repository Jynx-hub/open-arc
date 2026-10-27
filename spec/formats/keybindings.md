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
- The full default shortcut table is TODO, to be documented from Arc's Settings → Shortcuts screen.
