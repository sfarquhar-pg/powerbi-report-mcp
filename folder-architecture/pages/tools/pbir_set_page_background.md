# pbir_set_page_background

> Set the page canvas background. Hex color (`#0D1117`). Transparency 0-100.

## Inputs

| Param | Type | Required | Default | Description |
|-------|------|:--------:|:-------:|-------------|
| pageId | string | no (auto-resolved) | — | |
| color | string | no | — | Canvas background hex |
| transparency | number (0-100) | no | 0 | |
| wallpaperColor | string | no | — | Rejected: unsupported by current Fabric PBIR page schema |
| wallpaperTransparency | number (0-100) | no | 0 | Rejected when non-zero |
| clear | boolean | no | — | Remove background settings |

## Output

```jsonc
{ "success": true, "pageId": "...", "background": "#...", "wallpaper": "#..." }
```

## Behavior

- `idempotentHint: true`
- Writes PBIR `solid.color` + `transparency` literals into `page.objects.background`
- `clear:true` deletes the entry and removes the `objects` map if empty

## Gotchas

- `page.objects.wallpaper` and `background.properties.show` are rejected by the current Fabric PBIR import schema.
- Transparency is encoded as `${val}D` literal — PBIR-specific format.
