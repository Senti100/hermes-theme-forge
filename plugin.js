/*!
 * theme-forge — a Hermes Desktop plugin that accepts theme packs.
 *
 * A "theme pack" is a folder (or a single .json file) carrying Hermes Desktop's
 * native theme schema: colors / darkColors, an optional `wallpaper` section
 * (background image, blur, overlays, frosted-glass surfaces), typography and
 * terminal colors. Packs are contributed through the app's plugin entry
 * registry (`themes` area), so they show up in the native theme picker and
 * Settings → Appearance with zero app modifications.
 *
 * Manager UI is registered as a dockable pane plus a full-page route at
 * /theme-forge (import, edit colors/blur live, preview, apply, export).
 *
 * Compatible with Hermes Desktop 0.17.x desktop plugin runtime:
 *  - default export: { id, name?, description?, defaultEnabled?, register(ctx) }
 *  - imports are restricted to `@hermes/plugin-sdk` and `react`
 */

/*
 * SDK compatibility: Hermes Desktop 0.17 builds differ. Later builds export
 * `useTheme` / `requestTheme`; earlier ones (e.g. the 2026-08 0.17.0 desktop
 * build) do not. A namespace import + feature detection keeps this plugin
 * loadable on both — importing a missing *named* export would throw at link
 * time and kill the whole plugin.
 */
import * as sdk from '@hermes/plugin-sdk';
import React, { useState, useCallback, useMemo, useEffect } from 'react';

const atom = sdk.atom;
const useValue = sdk.useValue;
const cn = sdk.cn;
const hasRequestTheme = typeof sdk.requestTheme === 'function';
const useThemeCompat = typeof sdk.useTheme === 'function' ? sdk.useTheme : () => null;

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const PLUGIN_ID = 'theme-forge';
const AREA_THEMES = 'themes';
const AREA_ROUTES = 'routes';
const AREA_SIDEBAR_NAV = 'sidebar.nav';
const ROUTE_PATH = '/theme-forge';

const LS_PROFILE_THEMES = 'hermes-desktop-profile-themes-v1';
const LS_ACTIVE_PROFILE = 'hermes-desktop-active-profile-v1';
const LS_THEME_V2 = 'hermes-desktop-theme-v2';

const BUILTIN_THEME_NAMES = [
  'nous', 'github', 'catppuccin', 'everforest', 'solarized', 'nous-alt',
  'senti-100-packet-noir', 'midnight', 'ember', 'mono', 'cyberpunk', 'slate',
];

const THEME_DEFAULT = {
  nous: { name: 'nous', label: 'Nous' },
};

/** Canonical UI palette keys (light map = `colors`, dark map = `darkColors`). */
const COLOR_KEYS = [
  'background', 'foreground', 'card', 'cardForeground',
  'muted', 'mutedForeground', 'popover', 'popoverForeground',
  'primary', 'primaryForeground', 'secondary', 'secondaryForeground',
  'accent', 'accentForeground', 'border', 'input', 'ring',
  'midground', 'midgroundForeground', 'composerRing',
  'destructive', 'destructiveForeground',
  'sidebarBackground', 'sidebarBorder',
  'userBubble', 'userBubbleBorder',
];

/** Terminal palette keys (`terminal` / `darkTerminal`). */
const TERMINAL_KEYS = [
  'foreground', 'cursor', 'selectionBackground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

/** Wallpaper keys that are simple pass-through strings/numbers. */
const SURFACE_KEYS = [
  'backgroundSurface', 'chatSurface', 'editorSurface', 'sidebarSurface',
  'cardSurface', 'popoverSurface', 'bubbleSurface',
];

const PACK_ENTRY_NAMES = ['theme.json', 'pack.json'];

/* ------------------------------------------------------------------ */
/* Tiny helpers                                                        */
/* ------------------------------------------------------------------ */

/** React.createElement shorthand (no JSX so the plugin stays build-free). */
const h = (tag, props, ...kids) =>
  React.createElement(tag, props ?? null, ...kids.flatMap((k) => (Array.isArray(k) ? k : [k])).map((k) => (k == null ? null : k)));

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const deepCopy = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const titleize = (key) => key.replace(/([A-Z]+)/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();

function humanError(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

const desktop = () => (typeof window !== 'undefined' ? window.hermesDesktop : undefined);

/* ------------------------------------------------------------------ */
/* Color / CSS helpers                                                 */
/* ------------------------------------------------------------------ */

function parseColorToRgb(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (fn) {
    const parts = fn[1].split(',').map((x) => Number.parseFloat(x));
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return parts.slice(0, 3).map((n) => Math.round(clamp(n, 0, 255)));
    }
  }
  return null;
}

function withAlpha(value, alpha) {
  const rgb = parseColorToRgb(value);
  if (!rgb) return null;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${round(clamp(alpha, 0, 1), 3)})`;
}

function alphaOf(value) {
  const m = /^rgba?\(([^)]+)\)$/i.exec(String(value ?? '').trim());
  if (m) {
    const parts = m[1].split(',');
    if (parts.length >= 4) {
      const a = Number.parseFloat(parts[3]);
      if (Number.isFinite(a)) return clamp(a, 0, 1);
    }
  }
  return 1;
}

const isHexColor = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim());

function composeFilter({ blur = 0, saturate = 1, brightness = 1 }) {
  const parts = [];
  if (blur > 0) parts.push(`blur(${round(blur)}px)`);
  if (saturate !== 1) parts.push(`saturate(${round(saturate)})`);
  if (brightness !== 1) parts.push(`brightness(${round(brightness)})`);
  return parts.length ? parts.join(' ') : 'none';
}

function parseFilter(str) {
  const out = { blur: 0, saturate: 1, brightness: 1 };
  if (typeof str !== 'string') return out;
  const b = /blur\(([\d.]+)px\)/.exec(str);
  if (b) out.blur = Number.parseFloat(b[1]) || 0;
  const s = /saturate\(([\d.]+)\)/.exec(str);
  if (s) out.saturate = Number.parseFloat(s[1]) || 1;
  const br = /brightness\(([\d.]+)\)/.exec(str);
  if (br) out.brightness = Number.parseFloat(br[1]) || 1;
  return out;
}

/** Values the app passes through untouched inside url("...") / as-is. */
function isPassthroughImageRef(value) {
  return /^(data:|https?:|url\(|linear-gradient\(|radial-gradient\(|conic-gradient\()/i.test(String(value ?? '').trim());
}

/* ------------------------------------------------------------------ */
/* Plugin state                                                        */
/* ------------------------------------------------------------------ */

/** Pack records for the UI: { theme, raw, source, warnings, error, imageUrl } */
const packsAtom = atom([]);
const statusAtom = atom({ phase: 'idle', message: '' });

let ctxRef = null;        // plugin context (register/os/storage/…)
let entryDisposers = [];  // our registered entry disposers
let draftDisposers = [];  // transient preview entries
let selfDirCache = null;  // resolved folder of this plugin
let loadSeq = 0;          // guards async reloads

/* ------------------------------------------------------------------ */
/* Storage helpers (ctx.storage is namespaced localStorage)            */
/* ------------------------------------------------------------------ */

function storageGet(key, fallback) {
  try {
    const v = ctxRef?.storage?.get?.(key, fallback);
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function storageSet(key, value) {
  try {
    ctxRef?.storage?.set?.(key, value);
  } catch {
    /* ignore */
  }
}

function readExtraDirs() {
  const v = storageGet('extraDirs', []);
  return Array.isArray(v) ? v.filter((d) => typeof d === 'string' && d.trim()) : [];
}

function readInlinePacks() {
  const v = storageGet('inlinePacks', {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/* ------------------------------------------------------------------ */
/* Theme validation — mirrors the app's own validator (`Dt`)           */
/* ------------------------------------------------------------------ */

function validateTheme(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Pack root must be a JSON object.' };
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    return { error: 'Pack is missing a "name" string.' };
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(raw.name.trim())) {
    return { error: `Pack name "${raw.name}" may only contain letters, digits, "-" and "_".` };
  }
  if (typeof raw.label !== 'string') {
    return { error: 'Pack is missing a "label" string.' };
  }
  const colors = raw.colors;
  if (!colors || typeof colors !== 'object') {
    return { error: 'Pack is missing a "colors" object.' };
  }
  for (const key of ['background', 'foreground', 'primary']) {
    if (typeof colors[key] !== 'string') {
      return { error: `colors.${key} is required (string).` };
    }
  }
  return { theme: raw };
}

/** Normalize a pack: default description, copy name/label trims, collect warnings. */
function normalizePack(raw, source) {
  const record = { raw: deepCopy(raw), source, theme: null, warnings: [], error: null, imageUrl: null };
  const check = validateTheme(record.raw);
  if (check.error) {
    record.error = check.error;
    return record;
  }
  const theme = deepCopy(record.raw);
  theme.name = theme.name.trim();
  if (typeof theme.description !== 'string') {
    theme.description = '';
    record.warnings.push('description missing — added empty string');
  }
  if (BUILTIN_THEME_NAMES.includes(theme.name)) {
    record.warnings.push(`"${theme.name}" collides with a built-in theme — the app will ignore this entry. Rename the pack.`);
  }
  if (!theme.colors.midground && theme.colors.ring) {
    record.warnings.push('colors.midground missing — falls back to ring');
  }
  record.theme = theme;
  return record;
}

/* ------------------------------------------------------------------ */
/* File bridge (guarded window.hermesDesktop access)                    */
/* ------------------------------------------------------------------ */

async function fsReadDir(dir) {
  const d = desktop();
  if (!d?.readDir) return { entries: [], error: 'unavailable' };
  try {
    return await d.readDir(dir);
  } catch (error) {
    return { entries: [], error: humanError(error) };
  }
}

async function fsReadJsonFile(path) {
  const d = desktop();
  if (!d?.readFileText) throw new Error('readFileText unavailable');
  const res = await d.readFileText(path);
  if (res.binary) throw new Error(`${path} looks binary`);
  if (res.truncated) throw new Error(`${path} exceeds the ${Math.floor((res.byteSize ?? 0) / 1024)} KiB read cap`);
  return JSON.parse(res.text);
}

async function fsWriteJsonFile(path, value) {
  const d = desktop();
  if (!d?.writeTextFile) throw new Error('writeTextFile unavailable');
  await d.writeTextFile(path, JSON.stringify(value, null, 2));
}

/* Relative image refs resolve against the pack dir; data:/http(s)/gradients pass through. */
const imageCache = new Map();

async function resolveImageRef(ref, baseDir) {
  const s = String(ref ?? '').trim();
  if (!s) return null;
  if (isPassthroughImageRef(s)) return s;
  let path = s;
  if (!/^[~/]|[A-Za-z]:[\\/]/.test(path)) {
    if (!baseDir) return null;
    path = `${baseDir.replace(/\/+$/, '')}/${path}`;
  }
  if (imageCache.has(path)) return imageCache.get(path);
  const d = desktop();
  if (!d?.readFileDataUrl) return null;
  try {
    const url = await d.readFileDataUrl(path);
    imageCache.set(path, url);
    return url;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Pack discovery                                                      */
/* ------------------------------------------------------------------ */

/** Resolve this plugin's own folder by scanning the desktop plugins root. */
async function resolveSelfDir() {
  if (selfDirCache) return selfDirCache;
  const cached = storageGet('selfDir', null);
  if (typeof cached === 'string' && cached) {
    selfDirCache = cached;
    return cached;
  }
  const d = desktop();
  const root = await d?.desktopPluginsRoot?.().catch?.(() => null);
  if (!root) return null;
  const { entries } = await fsReadDir(root);
  for (const entry of entries ?? []) {
    if (!entry.isDirectory) continue;
    try {
      const res = await d.readFileText(`${entry.path}/plugin.js`);
      if (!res.binary && new RegExp(`["']${PLUGIN_ID}["']`).test(res.text)) {
        selfDirCache = entry.path;
        storageSet('selfDir', entry.path);
        return entry.path;
      }
    } catch {
      /* not our folder */
    }
  }
  return null;
}

/** Scan one directory: subdirs with theme.json + loose *.json packs. */
async function scanPacksInDir(dir, kind) {
  const records = [];
  const { entries, error } = await fsReadDir(dir);
  if (error === 'unavailable' || !entries) return records;
  for (const entry of entries) {
    try {
      if (entry.isDirectory) {
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
        for (const name of PACK_ENTRY_NAMES) {
          const candidate = `${entry.path}/${name}`;
          try {
            const json = await fsReadJsonFile(candidate);
            records.push(normalizePack(json, { kind, dir: entry.path, file: candidate, label: entry.name }));
            break;
          } catch {
            /* try next candidate */
          }
        }
      } else if (entry.name.endsWith('.json')) {
        const json = await fsReadJsonFile(entry.path);
        records.push(normalizePack(json, { kind, dir, file: entry.path, label: entry.name }));
      }
    } catch (error) {
      records.push({
        theme: null, raw: null, error: humanError(error),
        warnings: [], imageUrl: null,
        source: { kind, dir: entry.isDirectory ? entry.path : dir, file: entry.path, label: entry.name },
      });
    }
  }
  return records;
}

/** Load every pack from all sources and resolve wallpaper images. */
async function loadAllPacks() {
  const seq = ++loadSeq;
  statusAtom.set({ phase: 'loading', message: 'Scanning theme packs…' });
  const d = desktop();
  const records = [];

  // 1. Bundled packs inside this plugin's folder.
  const selfDir = await resolveSelfDir();
  if (selfDir) records.push(...(await scanPacksInDir(`${selfDir}/packs`, 'bundled')));

  // 2. Drop-in folder next to the installed plugins.
  const root = await d?.desktopPluginsRoot?.().catch?.(() => null);
  if (root) records.push(...(await scanPacksInDir(`${root}/theme-packs`, 'dropin')));

  // 3. Remembered folders.
  for (const dir of readExtraDirs()) {
    records.push(...(await scanPacksInDir(dir, 'dir')));
  }

  // 4. Inline packs kept in plugin storage.
  const inline = readInlinePacks();
  for (const [name, raw] of Object.entries(inline)) {
    records.push(normalizePack(raw, { kind: 'inline', key: name, label: name }));
  }

  // Resolve wallpaper images (data URLs / pass-through).
  for (const record of records) {
    const wall = record.theme?.wallpaper;
    if (!wall || typeof wall !== 'object') continue;
    if ('image' in wall && wall.image) {
      const url = await resolveImageRef(wall.image, record.source?.dir);
      if (url) {
        record.imageUrl = url;
        record.theme = { ...record.theme, wallpaper: { ...wall, image: url } };
      } else {
        record.warnings.push(`wallpaper.image "${wall.image}" could not be loaded — publishing without it`);
        record.theme = { ...record.theme, wallpaper: { ...wall, image: 'none' } };
      }
    }
    if (seq !== loadSeq) return; // superseded by a newer reload
  }

  // Surface duplicate names.
  const seen = new Map();
  for (const record of records) {
    if (!record.theme) continue;
    const first = seen.get(record.theme.name);
    if (first) {
      record.warnings.push(`duplicate pack name "${record.theme.name}" (also defined by ${describeSource(first.source)}) — first wins`);
    } else {
      seen.set(record.theme.name, record);
    }
  }

  if (seq === loadSeq) {
    packsAtom.set(records);
    const ok = records.filter((r) => r.theme).length;
    const bad = records.length - ok;
    statusAtom.set({
      phase: 'ready',
      message: `${ok} pack${ok === 1 ? '' : 's'} loaded${bad ? `, ${bad} with errors` : ''}`,
    });
  }
  return records;
}

function describeSource(source) {
  if (!source) return 'unknown';
  if (source.kind === 'bundled') return `bundled pack (${source.label ?? 'packs/'})`;
  if (source.kind === 'dropin') return `theme-packs/${source.label ?? ''}`;
  if (source.kind === 'dir') return source.dir ?? 'folder';
  if (source.kind === 'inline') return 'imported / in-app';
  return source.label ?? source.kind;
}

/* ------------------------------------------------------------------ */
/* Publishing (themes area) + transient draft entries                  */
/* ------------------------------------------------------------------ */

function disposeEntries() {
  for (const dispose of entryDisposers) {
    try {
      dispose();
    } catch {
      /* ignore */
    }
  }
  entryDisposers = [];
}

function disposeDrafts() {
  for (const dispose of draftDisposers) {
    try {
      dispose();
    } catch {
      /* ignore */
    }
  }
  draftDisposers = [];
}

function publishPacks(records) {
  disposeEntries();
  if (!ctxRef) return;
  for (const record of records) {
    if (!record.theme) continue;
    try {
      const dispose = ctxRef.register({
        id: record.theme.name,
        area: AREA_THEMES,
        data: record.theme,
        order: 60,
      });
      entryDisposers.push(dispose);
    } catch {
      /* registry rejects duplicates — harmless, first entry stays */
    }
  }
}

/** Register a throwaway theme so drafts can be previewed before saving. */
function publishDraft(draft) {
  disposeDrafts();
  if (!ctxRef || !draft?.name) return null;
  const name = `${draft.name} (draft)`;
  const theme = deepCopy(draft);
  theme.name = name;
  theme.label = `${theme.label ?? draft.name} (draft)`;
  try {
    const dispose = ctxRef.register({ id: 'draft', area: AREA_THEMES, data: theme, order: 200 });
    draftDisposers.push(dispose);
    return name;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Boot self-heal                                                      */
/* ------------------------------------------------------------------ */

/** Read the persisted theme for the active desktop profile. */
function getPersistedThemeName() {
  let profile = 'default';
  try {
    const raw = localStorage.getItem(LS_ACTIVE_PROFILE);
    if (raw != null) {
      const v = JSON.parse(raw);
      if (typeof v === 'string' && v.trim()) profile = v.trim();
    }
  } catch {
    /* keep default */
  }
  try {
    const map = JSON.parse(localStorage.getItem(LS_PROFILE_THEMES) || '{}');
    if (map && typeof map === 'object' && typeof map[profile] === 'string') return map[profile];
  } catch {
    /* fall through */
  }
  // Global theme (hermes-desktop-theme-v2) is stored as a raw string.
  const global = localStorage.getItem(LS_THEME_V2);
  if (global) {
    try {
      const v = JSON.parse(global);
      if (typeof v === 'string') return v;
    } catch {
      return global;
    }
  }
  return null;
}

/**
 * The theme provider resolves the persisted name at mount, which can race
 * async plugin loading. If the persisted theme is one of ours but the applied
 * one isn't, re-request it once.
 */
function scheduleSelfHeal(packNames, delayMs = 900) {
  setTimeout(() => {
    try {
      const persisted = getPersistedThemeName();
      if (!persisted || !packNames.includes(persisted)) return;
      const applied = document.documentElement?.dataset?.hermesTheme ?? '';
      if (!applied) return;
      const matches = applied === persisted || applied.startsWith(`${persisted}-`);
      if (!matches) applyThemeName(persisted);
    } catch {
      /* never break the host */
    }
  }, delayMs);
}

/* ------------------------------------------------------------------ */
/* Pack mutations (save / import / delete / export)                    */
/* ------------------------------------------------------------------ */

async function persistPack(record, draft) {
  const source = record.source ?? {};
  if (source.kind === 'inline') {
    const inline = readInlinePacks();
    inline[source.key ?? draft.name] = deepCopy(draft);
    storageSet('inlinePacks', inline);
  } else if (source.dir) {
    await fsWriteJsonFile(`${source.dir.replace(/\/+$/, '')}/theme.json`, deepCopy(draft));
  } else {
    throw new Error('This pack has no writable location — use "Save as copy".');
  }
  await loadAllPacks();
}

async function savePackAsCopy(draft, label) {
  const inline = readInlinePacks();
  let key = draft.name || 'pack';
  let n = 2;
  while (inline[key]) key = `${draft.name || 'pack'}-${n++}`;
  inline[key] = { ...deepCopy(draft), name: key, label: label || draft.label || key };
  storageSet('inlinePacks', inline);
  await loadAllPacks();
  return key;
}

async function deletePack(record) {
  const source = record.source ?? {};
  if (source.kind === 'inline') {
    const inline = readInlinePacks();
    delete inline[source.key];
    storageSet('inlinePacks', inline);
  } else if (source.file) {
    const d = desktop();
    if (d?.trashPath) {
      await d.trashPath(source.file);
    } else {
      throw new Error('Trash unavailable in this shell.');
    }
    if (source.kind === 'dir') {
      storageSet('extraDirs', readExtraDirs().filter((dir) => dir !== source.dir));
    }
  }
  await loadAllPacks();
}

async function importPackFromFile() {
  const picked = await pickOpenPath({
    title: 'Import theme pack (.json)',
    multiple: false,
  });
  if (!picked) return { ok: false, reason: 'cancelled' };
  const json = await fsReadJsonFile(picked);
  const check = validateTheme(json);
  if (check.error) throw new Error(check.error);
  const record = normalizePack(json, { kind: 'inline', key: json.name, label: picked });
  if (record.error) throw new Error(record.error);
  const inline = readInlinePacks();
  inline[json.name] = json;
  storageSet('inlinePacks', inline);
  await loadAllPacks();
  return { ok: true, name: json.name };
}

async function importPackFromFolder() {
  const picked = await pickOpenPath({
    title: 'Import theme pack folder',
    multiple: false,
    directories: true,
  });
  if (!picked) return { ok: false, reason: 'cancelled' };
  const dirs = readExtraDirs();
  if (!dirs.includes(picked)) {
    dirs.push(picked);
    storageSet('extraDirs', dirs);
  }
  await loadAllPacks();
  return { ok: true, dir: picked };
}

async function exportPack(record) {
  const theme = record.theme ?? record.raw;
  if (!theme) throw new Error('Nothing to export.');
  let target = await pickSavePath({
    title: 'Export theme pack',
    defaultPath: `${theme.name}.json`,
  });
  if (!target) {
    const fallbackDir = record.source?.dir ?? (await resolveSelfDir());
    if (!fallbackDir) throw new Error('No export location available.');
    target = `${fallbackDir.replace(/\/+$/, '')}/${theme.name}.export.json`;
  }
  await fsWriteJsonFile(target, theme);
  return target;
}

function openPacksFolder() {
  const d = desktop();
  return (async () => {
    const root = await d?.desktopPluginsRoot?.().catch?.(() => null);
    if (!root) throw new Error('Desktop plugins root unavailable.');
    const target = `${root.replace(/\/+$/, '')}/theme-packs`;
    if (d?.openDir) await d.openDir(target);
    else if (d?.revealPath) d.revealPath(root);
    return target;
  })();
}

/* ------------------------------------------------------------------ */
/* Theme apply + persisted-name compat (works across 0.17 builds)      */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getActiveProfile() {
  try {
    const raw = localStorage.getItem(LS_ACTIVE_PROFILE);
    if (raw != null) {
      const v = JSON.parse(raw);
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch {
    /* keep default */
  }
  return 'default';
}

/** Mirror the app's own theme persistence (profile map + global fallback). */
function writePersistedTheme(name) {
  try {
    const profile = getActiveProfile();
    if (profile === 'default') {
      localStorage.setItem(LS_THEME_V2, name);
    } else {
      const map = JSON.parse(localStorage.getItem(LS_PROFILE_THEMES) || '{}');
      map[profile] = name;
      localStorage.setItem(LS_PROFILE_THEMES, JSON.stringify(map));
    }
  } catch {
    /* ignore */
  }
}

/** The theme provider re-resolves on storage events for its tracked keys. */
function dispatchThemeStorageEvent() {
  try {
    window.dispatchEvent(new StorageEvent('storage', { key: LS_PROFILE_THEMES }));
  } catch {
    /* ignore */
  }
}

/** Applied theme name from the attribute the app's applier maintains. */
function readAppliedTheme() {
  try {
    return document.documentElement?.dataset?.hermesTheme ?? '';
  } catch {
    return '';
  }
}

/**
 * Apply a registered theme through the app's own pipeline.
 * - Newer builds: `requestTheme` (persists + applies).
 * - Older builds: persist the choice, then poke the provider's storage
 *   listener so it re-resolves live (no reload needed).
 */
async function applyThemeName(name) {
  if (hasRequestTheme) {
    return { ok: Boolean(sdk.requestTheme(name)), reloaded: false };
  }
  writePersistedTheme(name);
  dispatchThemeStorageEvent();
  await sleep(120); // let the provider's effect re-apply the theme
  const applied = readAppliedTheme();
  const ok = applied === name || applied.startsWith(`${name}-`) || applied === '';
  return { ok, reloaded: false };
}

/* ------------------------------------------------------------------ */
/* File pickers — ctx.os when available, direct preload bridge as fallback */
/* ------------------------------------------------------------------ */

async function pickOpenPath(options = {}) {
  try {
    const viaCtx = await ctxRef?.os?.pickOpenPath?.(options);
    if (viaCtx) return viaCtx;
  } catch {
    /* fall through */
  }
  const d = desktop();
  if (!d?.selectPaths) return null;
  try {
    const results = await d.selectPaths({ ...options, multiple: false });
    return results?.[0] ?? null;
  } catch {
    return null;
  }
}

async function pickSavePath(options = {}) {
  try {
    const viaCtx = await ctxRef?.os?.pickSavePath?.(options);
    if (viaCtx) return viaCtx;
  } catch {
    /* fall through */
  }
  const d = desktop();
  if (!d?.selectSavePath) return null;
  try {
    return await d.selectSavePath(options);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Exported engine (used by UI + tests)                                */
/* ------------------------------------------------------------------ */

export const __engine = {
  packsAtom,
  statusAtom,
  loadAllPacks,
  persistPack,
  savePackAsCopy,
  deletePack,
  importPackFromFile,
  importPackFromFolder,
  exportPack,
  openPacksFolder,
  publishDraft,
  disposeDrafts,
  validateTheme,
  normalizePack,
  getPersistedThemeName,
  applyThemeName,
  readAppliedTheme,
  pickOpenPath,
  pickSavePath,
  describeSource,
  resolveImageRef,
  composeFilter,
  parseFilter,
  withAlpha,
  alphaOf,
  COLOR_KEYS,
  TERMINAL_KEYS,
  SURFACE_KEYS,
  BUILTIN_THEME_NAMES,
  get selfDir() {
    return selfDirCache;
  },
};

/* ================================================================== */
/* UI                                                                  */
/* ================================================================== */

/* Local style hooks — the app's global Tailwind stylesheet + CSS variables
   (--dt-*, --ui-*) apply to any DOM rendered inside the shell, so we reuse
   them instead of shipping a stylesheet. */

const CARD = 'rounded-lg border border-border bg-card/60 backdrop-blur-sm';
const BTN = 'inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-(--chrome-action-hover) disabled:cursor-not-allowed disabled:opacity-50';
const BTN_PRIMARY = 'inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const INPUT = 'w-full rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-(--dt-ring,--theme-primary)';
const LABEL = 'text-[0.6875rem] font-medium text-muted-foreground';
const TAB = 'rounded-md px-2.5 py-1 text-xs font-medium transition-colors';

/* ------------------------------------------------------------------ */
/* Small presentational helpers                                        */
/* ------------------------------------------------------------------ */

function SwatchStrip({ theme, size = 14 }) {
  const keys = ['background', 'primary', 'foreground', 'muted', 'accent'];
  return h(
    'span',
    { className: 'inline-flex overflow-hidden rounded-full border border-border', style: { height: size } },
    keys.map((key) =>
      h('span', {
        key,
        title: key,
        style: { width: size, height: size, background: theme?.colors?.[key] ?? 'transparent' },
      }),
    ),
  );
}

function PackThumb({ record }) {
  const url = record.imageUrl;
  return h(
    'div',
    {
      className: 'relative h-14 w-24 shrink-0 overflow-hidden rounded-md border border-border',
      style: { background: record.theme?.colors?.background ?? '#141416' },
    },
    url
      ? h('img', {
          src: url,
          alt: '',
          'aria-hidden': true,
          className: 'absolute inset-0 h-full w-full object-cover',
          style: record.theme?.wallpaper?.filter
            ? { filter: String(record.theme.wallpaper.filter) }
            : undefined,
        })
      : h('div', {
          className: 'absolute inset-0',
          style: {
            background: `linear-gradient(135deg, ${record.theme?.colors?.primary ?? '#666'}33, transparent 60%)`,
          },
        }),
  );
}

function StatusDot({ tone }) {
  const color = tone === 'error' ? 'var(--dt-destructive, #e0675f)' : tone === 'warn' ? '#d9a13d' : '#4fae72';
  return h('span', { className: 'inline-block size-1.5 rounded-full', style: { background: color } });
}

function Row({ label, hint, children }) {
  return h(
    'div',
    { className: 'grid grid-cols-[9.5rem_1fr] items-center gap-2 py-1' },
    h('span', { className: LABEL, title: hint }, label),
    children,
  );
}

function TextInput({ value, onChange, placeholder, mono }) {
  return h('input', {
    className: cn(INPUT, mono && 'font-mono'),
    value: value ?? '',
    placeholder,
    onChange: (event) => onChange(event.target.value),
    spellCheck: false,
  });
}

function ColorInput({ value, onChange }) {
  const hex = isHexColor(value) ? value.trim() : '#000000';
  return h('span', { className: 'relative inline-block size-6 shrink-0 rounded border border-border align-middle', style: { background: hex } },
    h('input', {
      type: 'color',
      value: hex,
      'aria-label': 'Pick color',
      className: 'absolute inset-0 h-full w-full cursor-pointer opacity-0',
      onChange: (event) => onChange(event.target.value),
    }),
  );
}

function ColorRow({ label, value, onChange }) {
  return h(
    Row,
    { label },
    h('div', { className: 'flex items-center gap-2' },
      h(ColorInput, { value, onChange }),
      h(TextInput, { value, onChange, mono: true, placeholder: '#rrggbb or rgba()' }),
    ),
  );
}

function SliderRow({ label, value, min, max, step = 0.01, onChange, format }) {
  return h(
    Row,
    { label },
    h('div', { className: 'flex items-center gap-2' },
      h('input', {
        type: 'range',
        min,
        max,
        step,
        value,
        className: 'h-1 flex-1 accent-(--theme-primary)',
        onChange: (event) => onChange(Number.parseFloat(event.target.value)),
      }),
      h('span', { className: 'w-16 shrink-0 text-right font-mono text-[0.6875rem] text-muted-foreground' }, format ? format(value) : String(value)),
    ),
  );
}

function SectionTitle({ children }) {
  return h('div', { className: 'pb-1 pt-3 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground/80 first:pt-0' }, children);
}

/* ------------------------------------------------------------------ */
/* Editors                                                             */
/* ------------------------------------------------------------------ */

function ensureMap(obj, key) {
  if (!obj[key] || typeof obj[key] !== 'object' || Array.isArray(obj[key])) obj[key] = {};
  return obj[key];
}

function ensureWallpaper(draft) {
  return ensureMap(draft, 'wallpaper');
}

function ColorsEditor({ draft, update }) {
  const [mode, setMode] = useState('dark');
  const mapKey = mode === 'dark' ? 'darkColors' : 'colors';
  const current = ensureMap(draft, mapKey);
  const extraKeys = Object.keys(current).filter((key) => !COLOR_KEYS.includes(key));
  const setValue = (key, value) => update((next) => {
    ensureMap(next, mapKey)[key] = value;
  });
  return h('div', {},
    h('div', { className: 'flex gap-1 pb-2' },
      ['light', 'dark'].map((m) =>
        h('button', {
          key: m,
          type: 'button',
          className: cn(TAB, mode === m ? 'bg-(--theme-primary) text-white' : 'text-muted-foreground hover:bg-(--chrome-action-hover)'),
          onClick: () => setMode(m),
        }, m === 'light' ? 'Light palette' : 'Dark palette'),
      ),
    ),
    COLOR_KEYS.map((key) => h(ColorRow, {
      key,
      label: titleize(key),
      value: current[key] ?? '',
      onChange: (value) => setValue(key, value),
    })),
    extraKeys.map((key) => h(ColorRow, {
      key: `x-${key}`,
      label: titleize(key),
      value: current[key] ?? '',
      onChange: (value) => setValue(key, value),
    })),
  );
}

function WallpaperEditor({ draft, update, busy, busyLabel, onPickImage }) {
  const wall = ensureWallpaper(draft);
  const parsed = parseFilter(wall.filter);
  const front = parseFilter(wall.frontFilter);
  const setImage = (value) => update((next) => {
    const w = ensureWallpaper(next);
    if (value) w.image = value;
    else delete w.image;
  });
  return h('div', {},
    h(SectionTitle, {}, 'Background image'),
    h(Row, { label: 'Image', hint: 'File path, https:// URL, data: URI or CSS gradient' },
      h('div', { className: 'flex items-center gap-2' },
        h(TextInput, { value: wall.image ?? '', onChange: setImage, placeholder: 'background.webp · https://… · linear-gradient(…)' }),
        h('button', { type: 'button', className: BTN, disabled: busy, onClick: onPickImage }, busyLabel ?? 'Pick…'),
      ),
    ),
    h(Row, { label: 'Position' },
      h('div', { className: 'flex items-center gap-2' },
        h('select', {
          className: INPUT,
          value: ['center center', 'center top', 'center bottom', 'left top', 'left bottom', 'right top', 'right bottom'].includes(wall.position) ? wall.position : '__custom',
          onChange: (event) => update((next) => {
            const w = ensureWallpaper(next);
            if (event.target.value === '__custom') w.position = wall.position && !['center center'].includes(wall.position) ? wall.position : '50% 50%';
            else w.position = event.target.value;
          }),
        },
          ['center center', 'center top', 'center bottom', 'left top', 'left bottom', 'right top', 'right bottom', '__custom'].map((option) =>
            h('option', { key: option, value: option }, option === '__custom' ? 'custom…' : option),
          ),
        ),
        h(TextInput, { value: wall.position ?? '', onChange: (value) => update((next) => { ensureWallpaper(next).position = value; }) }),
      ),
    ),
    h(Row, { label: 'Size' },
      h('select', {
        className: INPUT,
        value: ['cover', 'contain', 'auto'].includes(wall.size) ? wall.size : '__custom',
        onChange: (event) => update((next) => {
          ensureWallpaper(next).size = event.target.value === '__custom' ? (wall.size ?? 'cover') : event.target.value;
        }),
      },
        ['cover', 'contain', 'auto', '__custom'].map((option) => h('option', { key: option, value: option }, option === '__custom' ? 'custom…' : option)),
      ),
    ),
    h(SectionTitle, {}, 'Background blur & light'),
    h(SliderRow, { label: 'Blur (px)', min: 0, max: 30, step: 0.5, value: parsed.blur, onChange: (v) => update((next) => { ensureWallpaper(next).filter = composeFilter({ ...parseFilter(ensureWallpaper(next).filter), blur: v }); }) }),
    h(SliderRow, { label: 'Saturate', min: 0, max: 2, step: 0.01, value: parsed.saturate, onChange: (v) => update((next) => { ensureWallpaper(next).filter = composeFilter({ ...parseFilter(ensureWallpaper(next).filter), saturate: v }); }), format: (v) => `×${round(v)}` }),
    h(SliderRow, { label: 'Brightness', min: 0.2, max: 1.8, step: 0.01, value: parsed.brightness, onChange: (v) => update((next) => { ensureWallpaper(next).filter = composeFilter({ ...parseFilter(ensureWallpaper(next).filter), brightness: v }); }), format: (v) => `×${round(v)}` }),
    h(SliderRow, { label: 'Opacity', min: 0, max: 1, step: 0.01, value: typeof wall.opacity === 'number' ? wall.opacity : 1, onChange: (v) => update((next) => { ensureWallpaper(next).opacity = v; }), format: (v) => `${Math.round(v * 100)}%` }),
    h(SliderRow, { label: 'Scale', min: 1, max: 1.6, step: 0.005, value: typeof wall.scale === 'number' ? wall.scale : 1, onChange: (v) => update((next) => { ensureWallpaper(next).scale = v; }), format: (v) => `×${round(v, 3)}` }),
    h(SectionTitle, {}, 'Content glass'),
    h(SliderRow, { label: 'Front blur (px)', min: 0, max: 30, step: 0.5, value: front.blur, onChange: (v) => update((next) => { const f = parseFilter(ensureWallpaper(next).frontFilter); f.blur = v; ensureWallpaper(next).frontFilter = composeFilter({ ...f, saturate: 1, brightness: 1 }); }) }),
    h(Row, { label: 'Overlay', hint: 'CSS background layers drawn over the wallpaper, under the UI' },
      h('textarea', {
        className: cn(INPUT, 'min-h-16 font-mono'),
        value: wall.overlay ?? '',
        spellCheck: false,
        onChange: (event) => update((next) => {
          const w = ensureWallpaper(next);
          if (event.target.value) w.overlay = event.target.value;
          else delete w.overlay;
        }),
      }),
    ),
    h(SectionTitle, {}, 'Glass surfaces (alpha over wallpaper)'),
    SURFACE_KEYS.map((key) => {
      const value = wall[key] ?? '';
      return h('div', { key, className: 'grid grid-cols-[9.5rem_1fr_auto] items-center gap-2 py-1' },
        h('span', { className: LABEL }, titleize(key)),
        h(TextInput, { value, onChange: (v) => update((next) => { const w = ensureWallpaper(next); if (v) w[key] = v; else delete w[key]; }) }),
        h('input', {
          type: 'range',
          min: 0,
          max: 1,
          step: 0.01,
          value: alphaOf(value),
          className: 'h-1 w-24 accent-(--theme-primary)',
          onChange: (event) => update((next) => {
            const w = ensureWallpaper(next);
            const alpha = Number.parseFloat(event.target.value);
            const base = w[key] || (next.colors ? next.colors.background : '#202020');
            const nextValue = withAlpha(base, alpha);
            if (nextValue) w[key] = nextValue;
          }),
        }),
      );
    }),
  );
}

function TypographyEditor({ draft, update }) {
  const typo = ensureMap(draft, 'typography');
  const set = (key, value) => update((next) => {
    const map = ensureMap(next, 'typography');
    if (value) map[key] = value;
    else delete map[key];
  });
  return h('div', {},
    h(SectionTitle, {}, 'Fonts'),
    ['fontSans', 'fontMono'].map((key) =>
      h(Row, { key, label: titleize(key) }, h(TextInput, { value: typo[key] ?? '', onChange: (v) => set(key, v) })),
    ),
    h(Row, { label: 'Font URL', hint: 'Optional stylesheet (e.g. Google Fonts) loaded with the theme' },
      h(TextInput, { value: typo.fontUrl ?? '', onChange: (v) => set('fontUrl', v) }),
    ),
  );
}

function TerminalEditor({ draft, update }) {
  const [mode, setMode] = useState('dark');
  const mapKey = mode === 'dark' ? 'darkTerminal' : 'terminal';
  const current = ensureMap(draft, mapKey);
  const setValue = (key, value) => update((next) => {
    ensureMap(next, mapKey)[key] = value;
  });
  return h('div', {},
    h('div', { className: 'flex gap-1 pb-2' },
      ['light', 'dark'].map((m) =>
        h('button', {
          key: m,
          type: 'button',
          className: cn(TAB, mode === m ? 'bg-(--theme-primary) text-white' : 'text-muted-foreground hover:bg-(--chrome-action-hover)'),
          onClick: () => setMode(m),
        }, m === 'light' ? 'Light terminal' : 'Dark terminal'),
      ),
    ),
    TERMINAL_KEYS.map((key) => h(ColorRow, {
      key,
      label: titleize(key),
      value: current[key] ?? '',
      onChange: (value) => setValue(key, value),
    })),
  );
}

function JsonEditor({ draft, onApply }) {
  const [text, setText] = useState(() => JSON.stringify(draft, null, 2));
  const [error, setError] = useState(null);
  useEffect(() => {
    setText(JSON.stringify(draft, null, 2));
    setError(null);
  }, [draft]);
  return h('div', { className: 'flex flex-col gap-2' },
    h('textarea', {
      className: cn(INPUT, 'min-h-72 font-mono'),
      value: text,
      spellCheck: false,
      onChange: (event) => setText(event.target.value),
    }),
    h('div', { className: 'flex items-center gap-2' },
      h('button', {
        type: 'button',
        className: BTN,
        onClick: () => {
          try {
            const parsed = JSON.parse(text);
            const check = validateTheme(parsed);
            if (check.error) throw new Error(check.error);
            setError(null);
            onApply(parsed);
          } catch (err) {
            setError(humanError(err));
          }
        },
      }, 'Validate & apply to editor'),
      error ? h('span', { className: 'text-[0.6875rem] text-(--dt-destructive)' }, error) : null,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Editor (single pack)                                                */
/* ------------------------------------------------------------------ */

const EDITOR_TABS = ['Colors', 'Wallpaper', 'Type', 'Terminal', 'JSON'];

function recordKey(record) {
  const s = record.source ?? {};
  return `${s.kind ?? '?'}:${s.file ?? s.dir ?? s.key ?? record.theme?.name ?? Math.random()}`;
}

function Editor({ record, appliedName, onNotify }) {
  const initial = useMemo(() => deepCopy(record.raw ?? record.theme ?? {}), [record]);
  const [draft, setDraft] = useState(initial);
  const [tab, setTab] = useState('Colors');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const themeCtx = useThemeCompat();

  const update = useCallback((fn) => {
    setDraft((prev) => {
      const next = deepCopy(prev);
      fn(next);
      return next;
    });
  }, []);

  const themeName = draft.name || record.theme?.name || '';

  const run = useCallback(async (label, fn) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);

  const save = () => run('save', async () => {
    const check = validateTheme(draft);
    if (check.error) throw new Error(check.error);
    const wasApplied = appliedName === (record.theme?.name ?? '');
    await persistPack(record, draft);
    if (wasApplied) await applyThemeName(draft.name);
    onNotify?.({ kind: 'success', title: 'Theme Forge', body: `Saved "${draft.label || draft.name}"${wasApplied ? ' and re-applied' : ''}.` });
  });

  const saveCopy = () => run('copy', async () => {
    const key = await savePackAsCopy(draft, `${draft.label || draft.name} copy`);
    onNotify?.({ kind: 'success', title: 'Theme Forge', body: `Saved copy "${key}" to in-app packs.` });
  });

  const apply = () => run('apply', async () => {
    if (isDirty) await persistPack(record, draft);
    const { ok } = await applyThemeName(themeName);
    if (!ok) throw new Error(`"${themeName}" is not registered (check for errors or name collisions).`);
    onNotify?.({ kind: 'success', title: 'Theme Forge', body: `Applied "${draft.label || themeName}".` });
  });

  // Draft preview uses the app's own preview mechanism (transient, never
  // persisted) so closing the app mid-preview can't strand a stale theme name.
  const preview = () => run('preview', async () => {
    const check = validateTheme(draft);
    if (check.error) throw new Error(check.error);
    const name = publishDraft(draft);
    if (!name) throw new Error('Could not register the draft preview.');
    if (themeCtx?.previewTheme) {
      themeCtx.previewTheme(name, themeCtx?.resolvedMode ?? 'dark');
    } else {
      // Older shells: no preview API — fall back to a real (persisted) apply.
      await applyThemeName(name);
    }
    setPreviewing(true);
  });

  const stopPreview = () => run('preview', async () => {
    disposeDrafts();
    setPreviewing(false);
    if (themeCtx?.clearThemePreview) themeCtx.clearThemePreview();
  });

  const doExport = () => run('export', async () => {
    const target = await exportPack({ theme: draft, source: record.source });
    onNotify?.({ kind: 'success', title: 'Theme Forge', body: `Exported to ${target}` });
  });

  const doDelete = () => run('delete', async () => {
    await deletePack(record);
    onNotify?.({ kind: 'success', title: 'Theme Forge', body: `Deleted "${record.theme?.name ?? record.source?.label}"` });
  });

  const pickImage = () => run('pick', async () => {
    const picked = await pickOpenPath({
      title: 'Choose wallpaper image',
      multiple: false,
      filters: [{ name: 'Images', extensions: ['webp', 'png', 'jpg', 'jpeg', 'gif', 'avif', 'svg'] }],
    });
    if (!picked) return;
    update((next) => {
      ensureWallpaper(next).image = picked;
    });
  });

  const reveal = () => {
    const target = record.source?.dir ?? record.source?.file;
    if (target) desktop()?.revealPath?.(target);
  };

  const theme = draft;
  const appliedNow = appliedName === themeName || (appliedName ?? '').startsWith(`${themeName}-`);

  return h('div', { className: 'flex min-h-0 flex-1 flex-col gap-3' },
    h('div', { className: 'flex flex-wrap items-center gap-2' },
      h(PackThumb, { record: { ...record, theme, imageUrl: record.imageUrl } }),
      h('div', { className: 'min-w-0 flex-1' },
        h('input', {
          className: cn(INPUT, 'font-medium'),
          value: draft.label ?? '',
          onChange: (event) => update((next) => { next.label = event.target.value; }),
        }),
        h('div', { className: 'mt-1 flex items-center gap-2 text-[0.6875rem] text-muted-foreground' },
          h('code', null, themeName || '—'),
          appliedNow ? h('span', { className: 'rounded bg-(--theme-primary)/15 px-1.5 py-0.5 font-medium text-(--theme-primary)' }, 'applied') : null,
          h('span', null, describeSource(record.source)),
        ),
      ),
    ),
    h('div', { className: 'flex flex-wrap items-center gap-1.5' },
      h('button', { type: 'button', className: BTN_PRIMARY, style: { background: 'var(--theme-primary, #4a84fe)' }, disabled: !!busy, onClick: apply }, busy === 'apply' ? 'Applying…' : 'Apply'),
      isDirty
        ? h('button', { type: 'button', className: BTN, disabled: !!busy, onClick: preview }, busy === 'preview' ? '…' : previewing ? 'Update preview' : 'Preview draft')
        : null,
      previewing
        ? h('button', { type: 'button', className: BTN, onClick: stopPreview }, 'Stop preview')
        : null,
      h('button', { type: 'button', className: BTN, disabled: !!busy, onClick: save }, busy === 'save' ? 'Saving…' : 'Save'),
      h('button', { type: 'button', className: BTN, disabled: !!busy, onClick: saveCopy }, 'Save as copy'),
      h('button', { type: 'button', className: BTN, disabled: !!busy, onClick: doExport }, 'Export…'),
      record.source?.dir || record.source?.file
        ? h('button', { type: 'button', className: BTN, onClick: reveal }, 'Reveal')
        : null,
      confirmDelete
        ? h('button', { type: 'button', className: BTN, style: { borderColor: 'var(--dt-destructive, #e0675f)', color: 'var(--dt-destructive, #e0675f)' }, disabled: !!busy, onClick: doDelete }, busy === 'delete' ? 'Deleting…' : 'Confirm delete')
        : h('button', { type: 'button', className: BTN, onClick: () => setConfirmDelete(true), disabled: !!busy }, 'Delete'),
    ),
    isDirty
      ? h('div', { className: 'rounded-md border border-dashed border-border px-2 py-1 text-[0.6875rem] text-muted-foreground' }, 'Unsaved changes — Save to keep, Preview draft to try, or revert by re-selecting the pack.')
      : null,
    error
      ? h('div', { className: 'rounded-md border px-2 py-1 text-[0.6875rem]', style: { borderColor: 'var(--dt-destructive, #e0675f)', color: 'var(--dt-destructive, #e0675f)' } }, error)
      : null,
    h('div', { className: 'flex gap-1 border-b border-border pb-2' },
      EDITOR_TABS.map((name) =>
        h('button', {
          key: name,
          type: 'button',
          className: cn(TAB, tab === name ? 'bg-(--chrome-action-hover,--ui-bg-tertiary) text-foreground' : 'text-muted-foreground hover:bg-(--chrome-action-hover)'),
          onClick: () => setTab(name),
        }, name),
      ),
    ),
    h('div', { className: 'min-h-0 flex-1 overflow-y-auto pr-1' },
      tab === 'Colors' ? h(ColorsEditor, { draft, update }) : null,
      tab === 'Wallpaper' ? h(WallpaperEditor, { draft, update, busy: busy === 'pick', busyLabel: 'Picking…', onPickImage: pickImage }) : null,
      tab === 'Type' ? h(TypographyEditor, { draft, update }) : null,
      tab === 'Terminal' ? h(TerminalEditor, { draft, update }) : null,
      tab === 'JSON' ? h(JsonEditor, { draft, onApply: (parsed) => setDraft(deepCopy(parsed)) }) : null,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Manager (route page + route tile)                                   */
/* ------------------------------------------------------------------ */

/** Track container width so the manager stays usable in narrow route tiles. */
function useCompactLayout(boundary = 640) {
  const ref = React.useRef(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width ?? 0;
      setCompact(width > 0 && width < boundary);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [boundary]);
  return [ref, compact];
}

const TEMPLATE_PACK = {
  name: 'my-theme',  label: 'My Theme',
  description: 'A Theme Forge pack — edit name/label, then colors, wallpaper and blur.',
  colors: Object.fromEntries(COLOR_KEYS.map((key, index) => [
    key,
    ['#101014', '#e8e8ee', '#16161c', '#e8e8ee', '#1c1c24', '#8f8fa3', '#181820', '#e8e8ee', '#7aa2f7', '#0c0e15', '#1f2433', '#c9d2f0', '#1c2233', '#dbe2f5', '#2a2f3e', '#232838', '#7aa2f7', '#7aa2f7', '#0c0e15', '#9ec1ff', '#e0675f', '#fff5f4', '#0c0c10', '#232838', '#182035', '#2a3a52'][index] ?? '#202020',
  ])),
  darkColors: null,
  wallpaper: {
    position: 'center center',
    size: 'cover',
    opacity: 1,
    scale: 1.02,
    filter: 'blur(6px) saturate(1.1) brightness(0.9)',
    frontFilter: 'blur(4px)',
    overlay: 'linear-gradient(180deg, rgba(8, 10, 18, 0.55) 0%, rgba(10, 12, 20, 0.35) 100%)',
    backgroundSurface: 'rgba(12, 14, 22, 0.20)',
    chatSurface: 'rgba(12, 14, 22, 0.24)',
    editorSurface: 'rgba(12, 14, 22, 0.16)',
    sidebarSurface: 'rgba(8, 10, 16, 0.32)',
    cardSurface: 'rgba(20, 24, 38, 0.46)',
    popoverSurface: 'rgba(18, 22, 34, 0.64)',
    bubbleSurface: 'rgba(22, 28, 46, 0.58)',
  },
};
TEMPLATE_PACK.darkColors = deepCopy(TEMPLATE_PACK.colors);

function Manager() {
  const packs = useValue(packsAtom);
  const status = useValue(statusAtom);
  const themeCtx = useThemeCompat();
  const [rootRef, compact] = useCompactLayout();
  const [selectedKey, setSelectedKey] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);

  // Applied theme name: reactive via useTheme when the shell provides it,
  // otherwise poll the attribute the app's theme applier maintains.
  const [polledName, setPolledName] = useState(() => readAppliedTheme());
  useEffect(() => {
    if (themeCtx?.themeName != null) return undefined;
    const timer = setInterval(() => {
      const applied = readAppliedTheme();
      setPolledName((prev) => (prev === applied ? prev : applied));
    }, 1000);
    return () => clearInterval(timer);
  }, [themeCtx]);
  const appliedName = themeCtx?.themeName ?? polledName;

  useEffect(() => {
    if (packs.length && selectedKey == null) {
      const firstValid = packs.find((p) => p.theme);
      if (firstValid) setSelectedKey(recordKey(firstValid));
    }
  }, [packs, selectedKey]);

  // If the selected pack disappeared (deleted externally), fall back to the first valid one.
  useEffect(() => {
    if (!packs.length) return;
    if (selectedKey != null && !packs.some((p) => recordKey(p) === selectedKey)) {
      const firstValid = packs.find((p) => p.theme);
      setSelectedKey(firstValid ? recordKey(firstValid) : null);
    }
  }, [packs, selectedKey]);

  const notify = useCallback((payload) => {
    setNotice(payload);
    try {
      ctxRef?.os?.notify?.(payload);
    } catch {
      /* best effort */
    }
    setTimeout(() => setNotice(null), 5000);
  }, []);

  const run = useCallback(async (label, fn) => {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      notify({ kind: 'error', title: 'Theme Forge', body: humanError(err) });
    } finally {
      setBusy(null);
    }
  }, [notify]);

  const selected = packs.find((p) => recordKey(p) === selectedKey) ?? packs.find((p) => p.theme) ?? null;

  const reload = () => run('reload', async () => {
    const records = await loadAllPacks();
    publishPacks(records);
  });

  const importJson = () => run('import', async () => {
    const result = await importPackFromFile();
    if (result?.ok) notify({ kind: 'success', title: 'Theme Forge', body: `Imported "${result.name}".` });
  });

  const importFolder = () => run('import', async () => {
    const result = await importPackFromFolder();
    if (result?.ok) notify({ kind: 'success', title: 'Theme Forge', body: 'Folder added to pack sources.' });
  });

  const newFromTemplate = () => run('new', async () => {
    let name = 'my-theme';
    const inline = readInlinePacks();
    let n = 2;
    while (inline[name]) name = `my-theme-${n++}`;
    const pack = deepCopy(TEMPLATE_PACK);
    pack.name = name;
    inline[name] = pack;
    storageSet('inlinePacks', inline);
    await loadAllPacks();
    setSelectedKey(`inline:${name}`);
  });

  const openFolder = () => run('folder', async () => {
    await openPacksFolder();
  });

  return h('div', { ref: rootRef, className: 'flex min-h-0 flex-1 flex-col gap-3 p-3' },
    h('div', { className: 'flex flex-wrap items-center gap-2' },
      h('div', { className: 'mr-auto flex min-w-0 flex-col' },
        h('div', { className: 'flex items-center gap-2' },
          h('span', { className: 'text-sm font-semibold' }, 'Theme Forge'),
          h(SwatchStrip, { theme: packs.find((p) => recordKey(p) === selectedKey)?.theme, size: 12 }),
        ),
        h('span', { className: 'flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground' },
          h(StatusDot, { tone: status.phase === 'error' ? 'error' : packs.some((p) => p.error) ? 'warn' : 'ok' }),
          status.message || 'Idle',
        ),
      ),
      h('button', { type: 'button', className: BTN, disabled: !!busy, onClick: importJson }, busy === 'import' ? 'Importing…' : 'Import JSON…'),
      h('button', { type: 'button', className: BTN, disabled: !!busy, onClick: importFolder }, 'Add folder…'),
      h('button', { type: 'button', className: BTN, disabled: !!busy, onClick: newFromTemplate }, 'New from template'),
      h('button', { type: 'button', className: BTN, disabled: !!busy, onClick: openFolder }, 'Open packs folder'),
      h('button', { type: 'button', className: BTN, disabled: !!busy, onClick: reload }, busy === 'reload' ? 'Reloading…' : 'Reload'),
    ),
    notice
      ? h('div', {
          className: 'rounded-md border px-2 py-1 text-[0.6875rem]',
          style: notice.kind === 'error'
            ? { borderColor: 'var(--dt-destructive, #e0675f)', color: 'var(--dt-destructive, #e0675f)' }
            : { borderColor: 'var(--dt-ring, var(--theme-primary))', color: 'var(--theme-primary)' },
        }, notice.body ?? notice.title ?? '')
      : null,
    h('div', { className: cn('grid min-h-0 flex-1 gap-3', compact ? 'grid-cols-1' : 'grid-cols-[minmax(0,15rem)_1fr]') },
      h('div', { className: 'flex min-h-0 flex-col gap-2 overflow-y-auto pr-1' },
        packs.length === 0 && status.phase !== 'loading'
          ? h('div', { className: 'rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground' },
              'No theme packs found.',
              h('div', { className: 'mt-1 text-[0.6875rem]' }, 'Use "Import JSON…", "Add folder…" or drop packs into the desktop-plugins/theme-packs folder.'),
            )
          : null,
        packs.map((record) => {
          const key = recordKey(record);
          const active = key === selectedKey;
          return h('button', {
            key,
            type: 'button',
            className: cn(CARD, 'flex w-full items-center gap-2 p-2 text-left transition-colors', active ? 'border-(--theme-primary)' : 'hover:border-(--theme-primary)/50'),
            onClick: () => setSelectedKey(key),
          },
            h(PackThumb, { record }),
            h('div', { className: 'min-w-0 flex-1' },
              h('div', { className: 'flex items-center gap-1.5' },
                h('span', { className: 'truncate text-xs font-medium' }, record.theme?.label ?? record.source?.label ?? 'invalid pack'),
                record.error ? h(StatusDot, { tone: 'error' }) : record.warnings.length ? h(StatusDot, { tone: 'warn' }) : null,
                record.theme?.name && (appliedName === record.theme.name || (appliedName ?? '').startsWith(`${record.theme.name}-`))
                  ? h('span', { className: 'rounded bg-(--theme-primary)/15 px-1 py-0.5 text-[0.625rem] font-medium text-(--theme-primary)' }, 'applied')
                  : null,
              ),
              h('div', { className: 'truncate text-[0.6875rem] text-muted-foreground' },
                record.error ?? record.warnings[0] ?? describeSource(record.source),
              ),
            ),
          );
        }),
      ),
      selected
        ? h('div', { className: CARD, key: `editor-${recordKey(selected)}-${selected.theme?.name}` },
            h(Editor, {
              record: selected,
              appliedName,
              onNotify: notify,
            }),
          )
        : h('div', { className: cn(CARD, 'grid place-items-center p-8 text-xs text-muted-foreground') }, 'Select a pack to edit it.'),
    ),
  );
}

function ManagerRoute() {
  return h(Manager);
}

/* ------------------------------------------------------------------ */
/* Plugin entry                                                        */
/* ------------------------------------------------------------------ */

export default {
  id: PLUGIN_ID,
  name: 'Theme Forge',
  description: 'Theme packs for Hermes Desktop: colors, background image and blur — with a live manager.',
  defaultEnabled: true,

  register(context) {
    ctxRef = context;
    entryDisposers = [];
    draftDisposers = [];

    context.onDispose(() => {
      disposeEntries();
      disposeDrafts();
      ctxRef = null;
    });

    // NOTE: deliberately NO docked pane. In current Hermes Desktop builds,
    // closing a plugin-sourced pane disables the entire plugin (the pane
    // close handler treats "plugin pane closed" as "user wants it gone").
    // The sidebar entry + route below are the supported surfaces: route
    // tiles get their own close handlers and never touch plugin state.

    // Persistent "Theme Forge" row in the sidebar (paintbrush icon).
    // Clicking navigates to the manager; the row's split button opens it
    // as a closable tile pane.
    try {
      context.register({
        id: 'manager-nav',
        area: AREA_SIDEBAR_NAV,
        data: {
          path: ROUTE_PATH,
          label: 'Theme Forge',
          codicon: 'paintbrush',
        },
      });
    } catch {
      /* ignore */
    }

    // Full-page manager at /theme-forge (also the tile renderer).
    try {
      context.register({
        id: 'manager',
        area: AREA_ROUTES,
        title: 'Theme Forge',
        data: { path: ROUTE_PATH },
        render: () => h(ManagerRoute),
      });
    } catch {
      /* ignore */
    }

    // Load packs and publish themes (async, error-surfaced via statusAtom).
    (async () => {
      const records = await loadAllPacks();
      publishPacks(records);
      scheduleSelfHeal(records.filter((r) => r.theme).map((r) => r.theme.name));
    })().catch((error) => {
      statusAtom.set({ phase: 'error', message: humanError(error) });
    });
  },
};
