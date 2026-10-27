# `StorableLinkRouting.json` (Air Traffic Control)

This file holds the rules that decide where a link opened from *outside* Arc lands: a given Space, or Little Arc. Schema: [link-routing.schema.json](link-routing.schema.json).

```jsonc
{
  "version": 1,
  "defaultDestination": { "littleArc": { "_0": { "mostRecent": {} } } },
  "rules": [
    {
      "id": "<uuid>",
      "destination": { "space": { "_0": { "mostRecent": {} } } },   // or a specific Space (shape TODO)
      "sourceComponents": [
        { "id": "<uuid>",
          "componentType": { "urlMatch": { "_0": { "contains": {} }, "_1": "example.com" } } }
      ]
    }
  ]
}
```

- `urlMatch._0` is the match operator. `contains` has been observed; other operators are TODO. `_1` is the pattern.
- Rules are checked in order and the first match wins. If nothing matches, `defaultDestination` applies.
