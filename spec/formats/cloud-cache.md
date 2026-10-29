# Cloud cache (Firestore offline store)

**Status:** verified on Arc 1.170.0 (2026-10-28), from samples created for this purpose.

Arc syncs some objects through a Firebase/Firestore backend instead of the `Storable*.json` files. The Firestore SDK keeps an offline copy of every document the app has read or written, so **Boosts and Easel content can be recovered locally** without Arc's servers.

## Location

```
~/Library/Application Support/firestore/Arc/<firebase-project>/main/
```

This is a LevelDB database: `*.ldb` tables (Snappy-compressed blocks), a `*.log` write-ahead log, `MANIFEST-*`, `CURRENT`, `LOCK`. The project directory observed is `bcny-arc-server`.

- **Copy the directory before reading it.** Arc holds the `LOCK` while running, and opening the live store with a LevelDB library can trigger compaction. Readers should work on a copy, ideally taken with Arc quit.
- Each value is a protobuf. Documents appear as the standard Firestore `Document` message (`name` = `projects/<p>/databases/(default)/documents/<path>`, `fields` = map of `Value`) inside the SDK's own wrapper messages (cached remote documents and pending mutation batches). The same document can appear more than once (an older table copy, a pending write, a field-mask entry). Keep the copy with the latest `lastModified`, and treat documents with no fields as deletions or masks.
- A reader that only needs this data does not have to understand the SDK's key encoding. It can scan every value for embedded `Document` messages and group them by `name`.

## Collections seen

| Path | Holds |
|---|---|
| `boosts/<boostID>` | One document per Boost (see below) |
| `easels/<easelID>` | Easel metadata |
| `easels/<easelID>/objects/<objectID>` | One document per item on the canvas |
| `easels/<easelID>/memberships/<userID>` | Who can see or edit the Easel |
| `sync/<id>/<userID>/…` | Sidebar sync records (mirrors what `StorableSidebar.json` already holds) |
| `preferences/<userID>/stringValues/…` | Synced preference values |
| `users/<userID>` | Account profile |

`users`, `memberships` and `sync` contain account identifiers and other people's names on shared Easels. Exporters should skip `users` and `sync` entirely and drop participant names unless the user asks for them.

## Boost document

| Field | Type | Notes |
|---|---|---|
| `hostPattern` | string | The site the Boost applies to, e.g. `docs.google.com`. A bare host, not a glob. |
| `isActive` | string | `"true"` / `"false"` (a string, not a bool). |
| `type` | string | `"edited"` for Boosts made with the visual editor. Other values are not yet seen. |
| `title`, `author` | string | Empty when the user never named the Boost. |
| `createdDate`, `lastModified` | string | ISO-8601 UTC, e.g. `2026-10-28T19:29:14Z`. |
| `creatorID` | string | Firebase user ID of the creator. |
| `featuresUsed` | string[] | Which editor features are in use, e.g. `["colorScheme"]`. Empty when nothing is set. |
| `data` | string | **A JSON document encoded as a string.** See below. |

`data` (decoded):

```json
{
  "colorScheme": {
    "colorWheelDriven": {
      "_0": {
        "primaryHueDegrees": 270.48,
        "primarySaturation": 1,
        "secondaryHueOffset": 45,
        "invertLightness": false,
        "baseAppearance": { "dark": {} }
      }
    }
  },
  "zaps": []
}
```

- `colorScheme` is a one-case enum in Arc's usual `{"case": {"_0": payload}}` form. `colorWheelDriven` stores the hue (degrees) and saturation (0–1) picked on the color wheel, the offset of the secondary hue, whether lightness is inverted, and the base appearance (`dark` or presumably `light`). The page is recolored from these values. The raw CSS is not stored.
- `zaps` lists elements the user removed from the page. The entry shape is not yet sampled (needs a Boost with a zapped element).
- **Custom CSS/JS:** not present in either sample. A Boost with code added was attempted but only the color settings were persisted, so where (or whether) code is stored remains open. Per [boosts](../features/boosts.md), code Boosts are not shared, so they may never be written to this collection.
- Deleted Boosts remain as documents with no fields.

## Easel documents

`easels/<easelID>`:

| Field | Type | Notes |
|---|---|---|
| `title` | string | |
| `titleObjectID` | string | ID of the canvas object that acts as the title. |
| `palette` | string | Color palette name. |
| `shareStatus` | string | Matches the sidebar item's `shareStatus` (`creatorOnly`, …). |
| `creatorID` | string | Firebase user ID. |
| `lastModified` | timestamp | Firestore timestamp. |
| `version` | int | Schema or document version. |

`easels/<easelID>/objects/<objectID>`, one per canvas item:

| Field | Type | Notes |
|---|---|---|
| `id.value` | string | Object UUID. |
| `position.rect` | `{x, y, width, height}` (doubles) | Canvas coordinates. |
| `position.zIndex` | double | Stacking order. |
| `content` | one-key enum | `text` seen: `{string, style: {fontFamily, fillStyle, paragraphStyle}}`. Image, drawing, capture and live-card cases need samples. |
| `addedInfo` | `{added: timestamp, participant: {id.value, name}}` | Who added the object. |
| `currentWorkingVersion`, `previousWorkingVersion` | string | Edit-history pointers (UUID / empty). |

`easels/<easelID>/memberships/<userID>` holds a `json` string plus `userID`.

## Local reference

Sidebar items point into this store: a sidebar `easel` payload's `easelID` is the document ID under `easels/`. See [sidebar](sidebar.md).
