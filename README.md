# Theme Forge — theme packs for Hermes Desktop

A desktop plugin for [Hermes Desktop](https://github.com/NousResearch/hermes-agent) (tested against **0.17.0**)
that accepts **theme packs**: JSON files (plus assets) that carry the app's native theme schema —
colors, **background image + blur**, frosted-glass surfaces, fonts and terminal palettes.

Packs are contributed through Hermes Desktop's own plugin entry registry (`themes` area), so they appear
in the **native theme picker** (command palette → theme) and **Settings → Appearance** with zero app
modifications. Everything is user-owned: no `app.asar` repacking, and the packs **survive app updates**.

```
┌─────────────────────────────────────────────────────────────┐
│ Hermes Desktop (unmodified)                                 │
│   theme engine  ←── themes-area entries ──┐                 │
│   theme picker  ──────────────────────────┤                 │
└───────────────────────────────────────────┼─────────────────┘
                                            │
┌───────────────────────────────────────────┴─────────────────┐
│ theme-forge plugin                                          │
│  1. scans pack sources → validates → resolves images        │
│  2. register({area:'themes', id, data: theme})  per pack    │
│  3. manager pane + /theme-forge route (import/edit/apply)   │
│  4. boot self-heal re-applies a persisted pack theme        │
└─────────────────────────────────────────────────────────────┘
```

## Install

Copy (or `git clone`) this folder into the desktop plugins root and restart Hermes Desktop:

```
~/.hermes/desktop-plugins/theme-forge/            # default profile
~/.hermes/profiles/<profile>/desktop-plugins/theme-forge/   # e.g. profile "carlotta"
```

The folder must contain `plugin.js` at its root (it does). Then:

1. Restart Hermes Desktop.
2. **Settings → Plugins** → *Theme Forge* should be listed and enabled.
3. The **Theme Forge** pane docks next to your workspace; the full manager also lives at
   **`/theme-forge`** (the pane's *Open full page* button navigates there).

To distribute updates, push the folder to a git repo and install via
**Settings → Plugins → install from git URL** — the built-in installer accepts any repo
with `plugin.js` at its root (or under `desktop/`).

## Theme pack format

A pack is either

- a **folder** containing `theme.json` (plus assets), or
- a single **`.json` file**.

```jsonc
{
  // required
  "name": "packet-noir",            // unique id: letters, digits, '-', '_'
  "label": "Packet Noir",           // shown in the picker
  "description": "Noir NOC wallpaper, electric-blue accents, soft blurred glass",
  "colors":  { "background": "#020814", "foreground": "#dceeff", "primary": "#91d2ff", "…" : "…25 keys…" },

  // recommended — one palette per color mode
  "darkColors": { "…same shape…" },

  // optional — background image + blur (the point of this plugin)
  "wallpaper": {
    "image": "background.webp",     // relative path | ~/path | https:// | data: | CSS gradient
    "position": "center center",    // any CSS background-position
    "size": "cover",                // cover | contain | auto | custom
    "opacity": 1,
    "scale": 1.025,
    "filter": "blur(3px) saturate(1.12) brightness(0.96)",  // background blur
    "frontFilter": "blur(3px) saturate(1.04)",              // blur applied to content glass
    "overlay": "linear-gradient(90deg, rgba(1,6,16,.72) 0%, …), radial-gradient(…)",
    // frosted-glass surface tints over the wallpaper (rgba):
    "backgroundSurface": "rgba(2, 8, 20, 0.15)",
    "chatSurface":      "rgba(2, 8, 20, 0.20)",
    "editorSurface":    "rgba(2, 8, 20, 0.12)",
    "sidebarSurface":   "rgba(1, 6, 16, 0.30)",
    "cardSurface":      "rgba(6, 18, 36, 0.44)",
    "popoverSurface":   "rgba(5, 16, 32, 0.62)",
    "bubbleSurface":    "rgba(7, 28, 52, 0.58)"
  },

  // optional fonts (fontUrl may be a Google Fonts stylesheet etc.)
  "typography": { "fontSans": "…", "fontMono": "…", "fontUrl": "https://fonts.googleapis.com/css2?…" },

  // optional terminal palettes (16 ANSI + foreground/cursor/selectionBackground)
  "terminal":      { "foreground": "…", "cursor": "…", "black": "…", "…" : "…" },
  "darkTerminal":  { "…" : "…" }
}
```

Minimum requirement: `name`, `label`, and `colors.background|foreground|primary` — exactly the
app's own validator. Everything else is optional and passes through untouched.

### Where packs are loaded from (in order)

1. **Bundled** — `<plugin folder>/packs/<name>/theme.json` (this repo ships `_template`, a reference pack)
2. **Drop-in** — `<desktop-plugins root>/theme-packs/` (subfolders with `theme.json`, or loose `*.json`)
3. **Remembered folders** — added via *Add folder…* in the manager (persisted in plugin storage)
4. **In-app packs** — imported JSONs and *Save as copy* (persisted in plugin storage)

Folders/files starting with `.` or `_` are ignored (`_template/` is a reference pack).

## The manager

- **Pack list** with wallpaper thumbnails, swatches, warning/error badges, "applied" marker.
- **Import JSON…** / **Add folder…** / **Open packs folder** (creates + reveals `theme-packs/`).
- **New from template** — instant editable pack.
- **Editor** tabs:
  - *Colors* — all 26 palette keys, light/dark, color picker + hex/rgba text.
  - *Wallpaper* — image picker, **blur / saturate / brightness / opacity / scale sliders**,
    front glass blur, overlay composer, alpha sliders for the 7 glass surfaces.
  - *Type* / *Terminal* — fonts and 16-color terminal palettes per mode.
  - *JSON* — raw editing with validation.
- **Preview draft** renders unsaved edits through the app's own transient preview
  (never persisted, so it can't strand a stale theme name).
- **Apply** saves (if dirty) then applies through the app pipeline (`requestTheme`) — title-bar
  tint, boot background and glass translucency all stay consistent.
- **Save as copy / Export… / Reveal / Delete** for pack management.

## How it works (app internals, 0.17.0)

- Themes resolve in priority: built-ins → **plugin `themes`-area entries** → VS Code marketplace
  → localStorage user themes. This plugin contributes via the `themes` area
  (`src/themes/*` → `getArea('themes')` in the renderer bundle).
- The wallpaper section is applied by the theme engine via `--dt-wallpaper-*` CSS variables on
  `<html>` (`data-hermes-wallpaper`), with per-surface glass vars for
  background/chat/editor/sidebar/card/popover/bubble.
- `requestTheme(name)` resolves through the same registry the app uses, so anything the plugin
  publishes is first-class.
- A boot self-heal re-requests a persisted pack theme if the async plugin load finished after the
  theme provider's first resolve (prevents a fallback-to-default race).
- Plugins may only import `@hermes/plugin-sdk` and `react`; this file does exactly that and stays
  a single, build-free ES module.

## Notes & limits

- Wallpaper images resolve to data URLs at load (cached per path); edits to image files need a
  **Reload** or app restart.
- Renderer file caps: `readFileText` 512 KiB, `readFileDataUrl` 16 MB, `writeTextFile` 1 MB —
  keep `theme.json` lean and reference images by path instead of embedding base64.
- Pack names that collide with built-ins (`nous`, `github`, `catppuccin`, `everforest`,
  `solarized`, `nous-alt`, `senti-100-packet-noir`, `midnight`, `ember`, `mono`, `cyberpunk`,
  `slate`) are ignored by the app — the manager warns and you should rename.
- One `wallpaper` per theme: for different light/dark backgrounds, ship two packs
  (`noir`, `noir-light`).

## Files

```
plugin.js                    the whole plugin (loader + manager UI, no build step)
packs/_template/theme.json   reference pack — full key surface with sensible defaults
```

## License

MIT — see [LICENSE](LICENSE).
