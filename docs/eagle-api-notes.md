# Eagle.cool Plugin API — Research Notes

Research notes for writing an Eagle desktop plugin from scratch.
Compiled from the official docs at <https://developer.eagle.cool/plugin-api/>
(every page has a Markdown twin at the same URL + `.md`; index at
<https://developer.eagle.cool/plugin-api/llms.txt>, full corpus at
<https://developer.eagle.cool/plugin-api/llms-full.txt>).

**Provenance convention used below**

- **[DOC]** = stated verbatim in official docs (URL cited).
- **[EX]** = observed in official example code (`eagle-app/eagle-plugin-examples`) or a real
  published plugin, where the docs are silent.
- **[INFER]** = reasonable inference / not documented. Treat with caution and verify in DevTools.

Official example repos:
- <https://github.com/eagle-app/eagle-plugin-examples> (Window, Service, Preview, Inspector,
  Multiple Windows, i18n, i18n+theme, 3rd-party)
- Icon template (Figma): <https://www.figma.com/community/file/1301113485954941759/eagle-plugins-icon-template-english-version>

---

## 1. Plugin folder structure

### 1.1 Minimal file layout

**[DOC]** <https://developer.eagle.cool/plugin-api/get-started/anatomy-of-an-extension.md>

```
Plugin
├─ manifest.json
├─ logo.png
├─ index.html
└─ js
   └─ plugin.js
```

- `manifest.json` — **required**, every plugin must have it. Defines plugin name, version,
  entry point, execution method.
- `logo.png` — the plugin icon; used in the plugin list and the plugin center.
- `index.html` — the `main.url` entry file. "When the plugin is executed, index.html will be
  loaded independently and run in a separate browser window."
- Everything else (`js/`, `css/`, `_locales/`, `node_modules/`, assets) is free-form.

Optional/type-specific folders:
- `_locales/` — i18n JSON files (`en.json`, `zh_CN.json`, `ja_JP.json`, …)
  ([DOC] <https://developer.eagle.cool/plugin-api/tutorial/i18n.md>)
- `thumbnail/`, `viewer/` — only for **format extension** (preview) plugins
  ([DOC] <https://developer.eagle.cool/plugin-api/get-started/plugin-types/preview.md>)

### 1.2 Required files per plugin type

| Type | Required manifest key | Required files |
|---|---|---|
| **Window** | `main.url` | `index.html` (+ its scripts) |
| **Background Service** | `main.serviceMode: true` + `main.url` | `index.html` (UI may be empty/absent from view) |
| **Format Extension** | `preview` (no `main` needed) | `thumbnail.path` → `.js`, `viewer.path` → `.html` |
| **Inspector** | `preview.<ext>.inspector` | HTML page |

**[DOC]** Format-extension plugins do **not** define `main` — "format extension plugins do not
need to define the `main` attribute in `manifest.json`, but need to set the `preview` attribute."
Also: "currently the format extension plugins do not support Eagle Plugin API and DevTools
debugging functionality."

### 1.3 Where plugins live on disk

**[EX]** Community-documented, matches the `eagle.app.userDataPath` value documented in
<https://developer.eagle.cool/plugin-api/api/app.md> (`C:\Users\User\AppData\Roaming\Eagle`):

- **Windows:** `C:\Users\<username>\AppData\Roaming\Eagle\plugins`
- **macOS:** `~/Library/Application Support/Eagle/Plugins` (i.e.
  `~/Library/Application Support/Eagle/Plugins`; the folder is capital-`P` `Plugins` on macOS in
  the community report, lowercase `plugins` on Windows)

Source: <https://zenn.dev/tuki0918/scraps/50f70a1604fabd> ("インストールしたプラグインの保存場所").
Programmatic equivalents:
- `eagle.app.getPath('userData')` → `...\AppData\Roaming\Eagle`
- `eagle.app.userDataPath` → `...\AppData\Roaming\Eagle` (Eagle 4.0 build12+)
- `eagle.app.getPath('temp')` / `eagle.os.tmpdir()`

> ⚠️ **Important for development:** when you "create" or "import" a plugin, Eagle works with the
> folder **in place** (it does not copy it into that directory in the dev flow) — see 1.4. For
> *installed* (`.eagleplugin`) plugins, Eagle extracts into the plugins directory above.
> **[INFER]** for the "in place" detail; **[EX]** the third-party framework
> `eagle-plugin` prints "the absolute directory to import into Eagle" and says the dev manifest
> "never contains an HTTP URL", implying the import points at a live folder.

### 1.4 Loading an unpacked plugin for testing (Developer mode)

**[DOC]** <https://developer.eagle.cool/plugin-api/get-started/creating-your-first-plugin.md>
"Your First Plugin" — the documented flow:

1. Click the **"Plugin"** button on the Eagle toolbar.
2. In the pop-up menu, choose **"Developer Options"**.
3. Click **"Create Plugin"**.
4. In the new window, select the plugin type ("Window Plugin", etc.).
5. Choose the location where you want to save the plugin, then complete creation.
6. Back in the **Plugin** panel, find the plugin you just created and click it → the window pops up.

**[EX]** Importing an existing/unpacked folder (load-unpacked equivalent) — from the official
`i18n+theme` template README:

> "clone the repository and goto **Eagle > Plugin > Import Local Project**, then select the folder
> where you cloned the repository."
> — <https://github.com/eagle-app/eagle-plugin-examples/blob/main/i18n%2Btheme/README.md>

So the two entry points are:
- **Create Plugin** — scaffolds a new plugin project in a folder you choose.
- **Import Local Project** — points Eagle at an existing folder (your working copy) so edits are
  live. This is the "load unpacked" flow.

**[EX]** Reloading during development: there is no documented "reload plugin" command. Practical
options: press **F12** in the plugin window and use the DevTools reload (Ctrl+R), close and re-open
the plugin, or toggle/re-import it. The third-party `eagle-plugin` framework explicitly states
"The framework does not call private Eagle reload APIs", which implies Eagle has non-public reload
hooks — do not rely on them.

### 1.5 Plugin panel / packaging menu names (for reference)

**[DOC]** <https://developer.eagle.cool/plugin-api/publishing/package.md>
- Open plugin panel (or press the **`P`** key) → **right-click the plugin** → **"Pack Plugin"** →
  choose save path → produces a `.eagleplugin` file.

---

## 2. `manifest.json`

### 2.1 Full documented field list

**[DOC]** <https://developer.eagle.cool/plugin-api/tutorial/manifest.md>

```json
{
    "id": "LBCZE8V6LPCKD",
    "version": "1.0.0",
    "platform": "all",
    "arch": "all",
    "name": "Windows Plugin",
    "logo": "/logo.png",
    "keywords": [],
    "devTools": false,
    "main":
    {
        "url": "index.html",
        "width": 640,
        "height": 480,
        "minWidth": 640,
        "minHeight": 480,
        "maxWidth": 640,
        "maxHeight": 480,
        "alwaysOnTop": false,
        "frame": true,
        "fullscreenable": true,
        "maximizable": true,
        "minimizable": true,
        "resizable": true,
        "backgroundColor": "#ffffff",
        "childWindow": false,
        "followCursor": false,
        "multiple": false,
        "runAfterInstall": false
    }
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | string | — | Plugin ID. **Required** (review requires a non-empty string). Free-form; real examples use 13-char uppercase alphanumerics (`LBCZE8V6LPCKD`) **or** a UUID (`6085a98e-ff49-40d2-8c0d-8cd55bfcfc1b`). |
| `version` | string | — | Semver, e.g. `"1.0.0"`. |
| `platform` | string | `all` | `all` \| `mac` \| `win`. |
| `arch` | string | `all` | `all` \| `arm` \| `x64`. |
| `name` | string | — | Plugin name. **Required**. i18n placeholder allowed: `"{{manifest.app.name}}"`. |
| `logo` | string | — | Path to logo. **Only `png`, `jpg`, `webp`.** Both `"/logo.png"` and `"./logo.png"` appear in official examples. |
| `keywords` | string[] | `[]` | Extra search terms. |
| `devTools` | boolean | `false` | **Top-level** (not inside `main`). Enables the devtools window for your plugin. **Must be `false` in a release** — review rejects `devTools: true`. |
| `main` | object | — | Window/entry configuration (window + service plugins). |
| `main.url` | string | — | Entry page, relative to plugin root (`"index.html"`, `"src/app.html"`). |
| `main.width` / `main.height` | number | — | Window size. |
| `main.minWidth` / `minHeight` / `maxWidth` / `maxHeight` | number | — | Size constraints. |
| `main.alwaysOnTop` | boolean | `false` | Window always above other windows. |
| `main.frame` | boolean | `true` | `false` ⇒ frameless window (no border/titlebar/toolbar). |
| `main.fullscreenable` | boolean | `true` | |
| `main.maximizable` | boolean | `true` | |
| `main.minimizable` | boolean | `true` | |
| `main.resizable` | boolean | `true` | |
| `main.backgroundColor` | string | `"#FFF"` | Window background; avoids flicker before HTML paints. |
| `main.childWindow` | boolean | `false` | Open attached to the main Eagle window. |
| `main.followCursor` | boolean | `false` | Position window near cursor; **requires Eagle 4.0 Build22+**. When enabled, the window does not remember its position. |
| `main.multiple` | boolean | `false` | Allow multiple simultaneous plugin windows. |
| `main.runAfterInstall` | boolean | `false` | Auto-open the plugin right after installation. |

### 2.2 Fields documented on other pages (same file)

| Field | Where | Notes |
|---|---|---|
| `main.serviceMode` | [DOC] plugin-types/service.md | `true` ⇒ **background service plugin**; runs at Eagle startup. |
| `preview` | [DOC] plugin-types/preview.md | Format-extension config, keyed by extension list: `"preview": { "icns,ico": { "thumbnail": { "path": "...", "size": 400, "allowZoom": false }, "viewer": { "path": "..." } } }` |
| `preview.<ext>.inspector` | [EX] Inspector example | `{ "path": "index.html", "height": 100, "multiSelect": false }` |
| `languages` | [DOC] tutorial/i18n.md | `["en","zh_TW","zh_CN","ja_JP"]` — supported locales. |
| `fallbackLanguage` | [DOC] tutorial/i18n.md | e.g. `"zh_CN"` or `"en"`. |
| `dependencies` | [DOC] extra-module/ffmpeg.md | e.g. `"dependencies": ["ffmpeg"]` — Eagle prompts the user to install the companion FFmpeg dependency plugin. |
| `main.vibrancy` | [EX] `i18n+theme/manifest.json` | `"vibrancy": true` appears in the official template but is **undocumented**. |

### 2.3 Complete realistic window-plugin example

This is the documented full field set, using realistic values (tailored to a 1280×860 frameless
tool window — adjust to taste):

```json
{
    "id": "brushbox",
    "version": "1.0.0",
    "platform": "all",
    "arch": "all",
    "name": "BrushBox",
    "logo": "/logo.png",
    "keywords": ["abr", "brush", "photoshop", "brush viewer"],
    "devTools": false,
    "main": {
        "url": "index.html",
        "width": 1280,
        "height": 860,
        "minWidth": 1040,
        "minHeight": 660,
        "maxWidth": 3840,
        "maxHeight": 2160,
        "alwaysOnTop": false,
        "frame": false,
        "fullscreenable": true,
        "maximizable": true,
        "minimizable": true,
        "resizable": true,
        "backgroundColor": "#0c0d12",
        "childWindow": false,
        "followCursor": false,
        "multiple": false,
        "runAfterInstall": false
    }
}
```

Minimal working window manifest (official example, verbatim
<https://github.com/eagle-app/eagle-plugin-examples/blob/main/Window/manifest.json>):

```json
{
	"id": "LARSK1QMR0DEP",
    "version": "1.0.0",
	"platform": "all",
	"arch": "all",
    "name": "Window Plugin",
    "logo": "/logo.png",
    "keywords": [],
	"devTools": false,
    "main":
    {
        "url": "index.html",
        "width": 640,
        "height": 480
    }
}
```

Background-service manifest ([DOC] service.md):

```json
{
    "id": "LBCZEHP8BBO94",
    "version": "1.0.0",
    "name": "Service Plugin",
    "logo": "/logo.png",
    "keywords": [],
    "main":
    {
        "serviceMode": true,
        "url": "index.html",
        "width": 640,
        "height": 480
    }
}
```

### 2.4 Logo constraints

**[DOC]** <https://developer.eagle.cool/plugin-api/get-started/anatomy-of-an-extension.md>:

> "Please provide an image with a resolution of **128 x 128 pixels**. The icon should generally be
> in **PNG** format, as PNG provides the best support for transparency."

**[DOC]** manifest.md: only `png`, `jpg`, `webp` formats are supported.
**[DOC]** visual-assets.md: square canvas required, leave safe padding (Plugin Center rounds/crops),
must be recognizable at small sizes; an opaque app-icon background and the official Figma icon
template are *recommended, not mandatory*.

---

## 3. The `eagle` global object

### 3.1 How it becomes available

**[EX]** **No script tag is needed.** The host injects `eagle` (and `i18next`) into the plugin page
as a preload/global before your scripts run. Every official example `index.html` contains only:

```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <script type="text/javascript" src="js/plugin.js"></script>
</head>

<body>
	<div id="message"></div>
</body>
</html>
```

…and `js/plugin.js` calls `eagle.onPluginCreate(...)` immediately with no import. There is **no
`eagle.js`** to ship and no `require('eagle')`.

Because it is a global, you can also reach it as `window.eagle`. **[INFER]**

### 3.2 Lifecycle / event callbacks on `eagle.on...`

**[DOC]** <https://developer.eagle.cool/plugin-api/api/event.md> — complete list:

| Callback | When | Callback args |
|---|---|---|
| `eagle.onPluginCreate(callback)` | Plugin window is created. Use it for initialization. | `plugin` object: `{ manifest: <full manifest.json object>, path: <string, path where the plugin is located> }` |
| `eagle.onPluginRun(callback)` | User clicks the plugin in the plugin panel. | none |
| `eagle.onPluginBeforeExit(callback)` | Before the plugin window closes. | `event` |
| `eagle.onPluginShow(callback)` | Plugin window shown. | none |
| `eagle.onPluginHide(callback)` | Plugin window hidden. | none |
| `eagle.onLibraryChanged(callback)` | User switches the Eagle library. | `libraryPath` string |
| `eagle.onThemeChanged(callback)` | Eagle's main-app theme changed. | `theme` string — `Auto` \| `LIGHT` \| `LIGHTGRAY` \| `GRAY` \| `DARK` \| `BLUE` \| `PURPLE` |

```javascript
eagle.onPluginCreate((plugin) => {
    console.log(plugin.manifest.name);
    console.log(plugin.manifest.version);
    console.log(plugin.manifest.logo);
    console.log(plugin.path);
});

eagle.onPluginRun(() => {
    console.log('eagle.onPluginRun');
});

eagle.onPluginBeforeExit(() => {
    console.log("Plugin will exit");
});

// Prevent window from closing
window.onbeforeunload = (event) => {
    return event.returnValue = false;
};
```

**[DOC]** "Tip: If the plugin can run without manifest information, you can also use
`window.onload` for development."

**[DOC]** Registering `window.onbeforeunload` (returning `false`) blocks the window from closing.

**Module map of the global `eagle`** (each has its own page):
`eagle.item`, `eagle.folder`, `eagle.smartFolder`, `eagle.tag`, `eagle.tagGroup`, `eagle.library`,
`eagle.window`, `eagle.app`, `eagle.os`, `eagle.screen`, `eagle.notification`, `eagle.contextMenu`,
`eagle.dialog`, `eagle.clipboard`, `eagle.drag`, `eagle.shell`, `eagle.log`,
`eagle.extraModule` (ffmpeg / aiSdk / aiSearch), plus `eagle.on*` events.

---

## 4. `item` API (most important)

**[DOC]** <https://developer.eagle.cool/plugin-api/api/item.md>

### 4.1 Complete method list

There is **no `eagle.item.add()`** and **no `eagle.item.addFromBuffer()`** in the Plugin API. The
only ways to add items are the four `addFrom*` methods below.

| Method | Signature | Resolves to |
|---|---|---|
| `get` | `eagle.item.get(options)` | `Promise<Item[]>` |
| `getAll` | `eagle.item.getAll()` | `Promise<Item[]>` |
| `getById` | `eagle.item.getById(itemId)` | `Promise<Item>` |
| `getByIds` | `eagle.item.getByIds(itemIds)` | `Promise<Item[]>` |
| `getSelected` | `eagle.item.getSelected()` | `Promise<Item[]>` |
| `getIdsWithModifiedAt` | `eagle.item.getIdsWithModifiedAt()` | `Promise<{id, modifiedAt}[]>` |
| `count` | `eagle.item.count(options)` | `Promise<number>` |
| `countAll` | `eagle.item.countAll()` | `Promise<number>` |
| `countSelected` | `eagle.item.countSelected()` | `Promise<number>` |
| `select` | `eagle.item.select(itemIds)` | `Promise<boolean>` (Eagle 4.0 build12+) |
| `addFromURL` | `eagle.item.addFromURL(url, options)` | `Promise<string /* itemId */>` |
| `addFromBase64` | `eagle.item.addFromBase64(base64, options)` | `Promise<string /* itemId */>` |
| `addFromPath` | `eagle.item.addFromPath(path, options)` | `Promise<string /* itemId */>` |
| `addBookmark` | `eagle.item.addBookmark(url, options)` | `Promise<string /* itemId */>` |
| `open` | `eagle.item.open(itemId, options?)` | `Promise<boolean>` |

> The names `add()`, `addFromBuffer()` and an `addFromPaths()` (plural) variant exist only in the
> **separate Local REST API** (`http://localhost:41595/api/item/addFromPaths`, docs at
> <https://api.eagle.cool/item/add-from-paths>) — **not** in the Plugin API. Do not confuse the two.

### 4.2 `get(options)` — the universal query

```javascript
eagle.item.get(options) -> Promise<Item[]>
```

`options` (all optional):

| Key | Type | Meaning |
|---|---|---|
| `id` | string | File id |
| `ids` | string[] | Array of file ids |
| `isSelected` | boolean | Currently selected files |
| `isUntagged` | boolean | Files with no tags |
| `isUnfiled` | boolean | Files not in any folder |
| `keywords` | string[] | Contains keywords |
| `tags` | string[] | Contains tags |
| `folders` | string[] | Contains folders |
| `ext` | string | Format, e.g. `"jpg"` |
| `annotation` | string | Annotation text |
| `rating` | integer | 0–5 |
| `url` | string | Source URL |
| `shape` | string | `square` \| `portrait` \| `panoramic-portrait` \| `landscape` \| `panoramic-landscape` |
| `fields` | string[] | Only return these fields (perf). e.g. `["id","name","tags","modifiedAt"]` |

```javascript
let selected = await eagle.item.get({ isSelected: true });
let jpgs = await eagle.item.get({ ext: "jpg" });

// Get only specific fields to improve performance
let itemsWithFields = await eagle.item.get({
    tags: ["Design"],
    fields: ["id", "name", "tags", "modifiedAt"]
});
```

### 4.3 `getSelected()` / `getAll()` / `getById(s)`

```javascript
let selected = await eagle.item.getSelected();   // Promise<Item[]>
let items    = await eagle.item.getAll();        // Promise<Item[]>
let item     = await eagle.item.getById('item_id');
let items    = await eagle.item.getByIds(['item_id_1', 'item_id_2']);
```

**[DOC]** Best practice: "If the resource library has a large number of files (e.g., 20W+), avoid
calling `getAll()` without restrictions."

### 4.4 `getIdsWithModifiedAt()` — incremental sync

```javascript
let fileInfo = await eagle.item.getIdsWithModifiedAt();
// [{ id: "item_id_1", modifiedAt: 1234567890 }, ...]

let lastSyncTime = getLastSyncTimestamp();
let allFiles = await eagle.item.getIdsWithModifiedAt();
let modifiedFiles = allFiles.filter(file => file.modifiedAt > lastSyncTime);
if (modifiedFiles.length > 0) {
    let fullData = await eagle.item.getByIds(modifiedFiles.map(f => f.id));
}
```

### 4.5 The four adders — exhaustive options

All four take an `options` object and resolve to the new **item id (string)**.

**`addFromURL(url, options)`** — add an image link.
`url` "supports `http`, `https`, `base64`".

| Option | Type | Meaning |
|---|---|---|
| `name` | string | File name |
| `website` | string | Source URL |
| `tags` | string[] | Tags |
| `folders` | string[] | Folder IDs to place the item in |
| `annotation` | string | Annotation |

```javascript
const imgURL = 'https://cdn.dribbble.com/userupload/3885520/file/original-ee68b80a6e10edab6f192e1e542da6ed.jpg';
const itemId = await eagle.item.addFromURL(imgURL, {
    name: 'Camping',
    website: 'https://dribbble.com/shots/19744134-Camping-2',
    tags: ["Dribbble", "Illustration"],
    folders: [],
    annotation: 'add from eagle api',
});
```

**`addFromBase64(base64, options)`** — add a base64 image. This is the key API for
programmatically-generated image data.

| Option | Type | Meaning |
|---|---|---|
| `name` | string | File name |
| `website` | string | Source URL |
| `tags` | string[] | Tags |
| `folders` | string[] | Folder IDs |
| `annotation` | string | Annotation |

```javascript
const base64 = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0i...';
const itemId = await eagle.item.addFromBase64(base64, {
    name: 'Illustation Logo',
    website: 'https://www.eagle.cool/',
    tags: ["Adobe", "Logo"],
    folders: [],
    annotation: 'ai logo form api',
});
```

Note the documented example passes a **full data URL** (`data:image/svg+xml;base64,…`), not a bare
base64 payload. **[INFER]** bare base64 probably also works, but the data-URL form is what is
documented and tested — prefer it.

**`addFromPath(path, options)`** — add a local file.

| Option | Type | Meaning |
|---|---|---|
| `name` | string | File name |
| `website` | string | Source URL |
| `tags` | string[] | Tags |
| `folders` | string[] | Folder IDs |
| `annotation` | string | Annotation |

```javascript
const filePath = 'C:\\Users\\User\\Downloads\\ai.svg';
const itemId = await eagle.item.addFromPath(filePath, {
    name: 'Illustation Logo',
    website: 'https://www.eagle.cool/',
    tags: ["Adobe", "Logo"],
    folders: [],
    annotation: 'ai logo form api',
});
```

**`addBookmark(url, options)`** — add a bookmark.

| Option | Type | Meaning |
|---|---|---|
| `name` | string | Bookmark name |
| `base64` | string | **Custom thumbnail** in base64 format |
| `tags` | string[] | Tags |
| `folders` | string[] | Folder IDs |
| `annotation` | string | Annotation |

```javascript
const itemId = await eagle.item.addBookmark('https://www.google.com/', {
    name: 'Eagle',
    base64: 'data:image/png;base64,iVBORw0KGgo...',
    tags: ["Eagle", "Site"],
    folders: [],
    annotation: 'bookmark form api',
});
```

### 4.6 Binary / Buffer / Blob support — direct answer

- **Raw binary `Buffer` → NO.** There is no `addFromBuffer`, no `addFromStream`, and no `blob`
  parameter anywhere in the Plugin API item module. **[DOC]** (absence verified against the full
  method list on the item page).
- **Base64 data URL → YES.** `eagle.item.addFromBase64(dataUrl, opts)` is documented and its
  example passes a `data:image/svg+xml;base64,…` string.
- **`Blob` → NOT directly.** Convert first. **[INFER]** for the conversion code, but the round trip
  is standard web platform behaviour:

  ```javascript
  // Blob -> data URL -> Eagle
  const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);   // "data:image/png;base64,..."
      fr.onerror = rej;
      fr.readAsDataURL(blob);
  });
  const itemId = await eagle.item.addFromBase64(dataUrl, { name: 'brush-01', folders: [folderId] });
  ```

  ```javascript
  // Canvas -> data URL -> Eagle  (the simplest path for rendered output)
  const dataUrl = canvas.toDataURL('image/png');
  const itemId = await eagle.item.addFromBase64(dataUrl, { name: 'brush-01', folders: [folderId] });
  ```

  ```javascript
  // Buffer -> Eagle: write a temp file, then addFromPath  (recommended for binary)
  const fs   = require('fs');
  const path = require('path');
  const tmp  = path.join(eagle.app.getPath('temp'), 'brush-01.png');
  fs.writeFileSync(tmp, buffer);                       // or await fs.promises.writeFile(tmp, buffer)
  const itemId = await eagle.item.addFromPath(tmp, { name: 'brush-01', folders: [folderId] });
  // optionally fs.unlinkSync(tmp) afterwards
  ```

  **[DOC]** the temp-dir APIs exist (`eagle.app.getPath('temp')`, `eagle.os.tmpdir()`); the
  "write then `addFromPath`" pattern is **[INFER]**, but it is the only supported route for raw
  bytes and `addFromPath` accepts written files. Note `addFromPath` is **singular** — for many
  files, loop and `await` each call.

- **Practical recommendation for PNG-heavy batch work:** base64 is ~33 % larger and goes through a
  JS string; for large batches, prefer `canvas.toBlob` → temp file → `addFromPath`, or
  `canvas.toDataURL()` → `addFromBase64` for small sets.

### 4.7 Class: `Item` — instance methods

| Method | Signature | Resolves to |
|---|---|---|
| `save()` | `item.save()` | `Promise<boolean>` |
| `moveToTrash()` | `item.moveToTrash()` | `Promise<boolean>` |
| `replaceFile(filePath)` | replace the original file; **auto-refreshes the thumbnail** | `Promise<boolean>` |
| `refreshThumbnail()` | refresh thumbnail + file size, color analysis, dimensions | `Promise<boolean>` |
| `setCustomThumbnail(thumbnailPath)` | set a custom thumbnail | `Promise<boolean>` |
| `addComment(commentData)` | Eagle 4.0 build22+ | `Promise<comment>` |
| `updateComment(commentId, updateData)` | Eagle 4.0 build22+ | `Promise<comment>` |
| `removeComment(commentId)` | Eagle 4.0 build22+ | `Promise<boolean>` |
| `open(options?)` | `{ window: true }` opens in a new window (build12+) | `Promise<void>` |
| `select()` | clears current selection and selects only this item (build12+) | `Promise<boolean>` |

```javascript
eagle.onPluginCreate(async (plugin) => {
    let items = await eagle.item.getSelected();
    let item = items[0];

    item.name = 'New Name';
    item.tags = ['tag1', 'tag2'];

    await item.save();
});
```

`addComment` payload:

```javascript
// image rect comment
await item.addComment({ x: 350, y: 480, width: 380, height: 400, annotation: "Face area" });
// video timestamp comment
await item.addComment({ duration: 65.5, annotation: "Important scene" });
```

**[DOC]** Best practice, repeated on the item and folder pages:

> "To ensure data security, use the `save()` method provided by the API for data access and
> modification, and avoid directly modifying the `metadata.json` or any files under the Eagle
> resource library."

### 4.8 Class: `Item` — instance properties

| Property | Type | R/W | Notes |
|---|---|---|---|
| `id` | string | read-only | File ID |
| `name` | string | read/write | File name |
| `ext` | string | read-only | Extension |
| `width` / `height` | integer | read/write | Image dimensions |
| `url` | string | read/write | Source link |
| `isDeleted` | boolean | read-only | In trash? |
| `annotation` | string | read/write | Annotation |
| `tags` | string[] | read/write | Tags |
| `folders` | string[] | read/write | Folder IDs |
| `palettes` | object[] | read-only | Color palette info |
| `comments` | object[] | read-only | Eagle 4.0 build22+; `[{ id, x, y, width, height, annotation, lastModified }]` |
| `size` | integer | read-only | File size |
| `star` | integer | read/write | Rating 0–5 |
| `importedAt` | integer | **read/write** (build18+) | Timestamp; must be a positive integer timestamp, invalid values ignored |
| `modifiedAt` | integer | read-only | Last modified |
| `noThumbnail` | boolean | read-only | |
| `noPreview` | boolean | read-only | |
| `filePath` | string | read-only | Absolute file path |
| `fileURL` | string | read-only | `file:///` URL |
| `thumbnailPath` | string | read-only | |
| `thumbnailURL` | string | read-only | **Use this to display the file in HTML.** |
| `metadataFilePath` | string | read-only | Path of the item's `metadata.json` |

```javascript
let item = await eagle.item.getById('item_id');
item.importedAt = new Date('2024-01-01').getTime();   // requires Eagle 4.0 build18+
await item.save();
```

> Note: `star` is the **rating** property (0–5). There is no `star` option on the `addFrom*`
> methods — rating must be set after creation via `item.star = n; await item.save();`. **[DOC]**
> (`star` appears only in the properties table, never in the add options).

---

## 5. `folder` API

**[DOC]** <https://developer.eagle.cool/plugin-api/api/folder.md>

| Method | Signature | Resolves to |
|---|---|---|
| `create` | `eagle.folder.create(options)` | `Promise<Folder>` |
| `createSubfolder` | `eagle.folder.createSubfolder(parentId, options)` | `Promise<Folder>` |
| `get` | `eagle.folder.get(options)` | `Promise<Folder[]>` |
| `getAll` | `eagle.folder.getAll()` | `Promise<Folder[]>` |
| `getById` | `eagle.folder.getById(folderId)` | `Promise<Folder>` |
| `getByIds` | `eagle.folder.getByIds(folderIds)` | `Promise<Folder[]>` |
| `getSelected` | `eagle.folder.getSelected()` | `Promise<Folder[]>` |
| `getRecents` | `eagle.folder.getRecents()` | `Promise<Folder[]>` |
| `open` | `eagle.folder.open(folderId)` | `Promise<void>` |

### 5.1 `create(options)`

| Option | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Folder name |
| `description` | string | no | Folder description |
| `parent` | string | no | **Parent folder ID.** "with this parameter, it is equivalent to `createSubfolder(parentId, options)`" |

```javascript
let newFolder = await eagle.folder.create({
    name: 'New Folder',
    description: 'Folder\'s description.',
});
```

### 5.2 Creating nested folders

Two documented equivalent routes:

```javascript
// Route A — parent option on create()
const root = await eagle.folder.create({ name: 'Brushes' });
const child = await eagle.folder.create({ name: 'Round', parent: root.id });
const grandchild = await eagle.folder.create({ name: 'Soft', parent: child.id });
```

```javascript
// Route B — create root, then createSubfolder(parentId, options)
let parentFolder = await eagle.folder.getById('folder_id');
let subFolder = await eagle.folder.createSubfolder(parentFolder.id, {
    name: 'Subfolder',
    description: 'Subfolder description.',
});
```

Any depth works — just keep passing the returned folder's `.id` as `parent`.
**[EX]** `folder.parent` is also writable (Eagle 4.0 build12+) so you can re-parent later:

```javascript
folder.parent = 'parent_folder_id'; await folder.save();
folder.parent = null;               await folder.save();   // move to root
```

### 5.3 `get(options)`

`options`: `id` string, `ids` string[], `isSelected` boolean, `isRecent` boolean.

### 5.4 Class: `Folder`

Instance methods: `save()` → `Promise<void>`, `open()` → `Promise<void>`.

Instance properties:

| Property | Type | R/W |
|---|---|---|
| `id` | string | read-only |
| `name` | string | read/write |
| `description` | string | read/write |
| `icon` | string | read-only |
| `iconColor` | string | read/write (Eagle 4.0 build12+) |
| `createdAt` | integer | read-only |
| `parent` | string | read/write (Eagle 4.0 build12+) |
| `children` | Folder[] | read-only |

Static: `eagle.folder.IconColor` → `{ Red, Orange, Yellow, Green, Aqua, Blue, Purple, Pink }`
(string values `'red'`, `'orange'`, …).

```javascript
folder.iconColor = eagle.folder.IconColor.Blue;
await folder.save();
```

### 5.5 `tag` / `tagGroup` (brief)

**[DOC]** <https://developer.eagle.cool/plugin-api/api/tag.md>

| Method | Signature | Resolves to | Version |
|---|---|---|---|
| `get` | `eagle.tag.get(options?)` — `{ name }` fuzzy, case-insensitive filter | `Promise<Object[]>` | `name` needs build12+ |
| `getRecentTags` | `eagle.tag.getRecentTags()` | `Promise<Object[]>` | (was mis-documented as `getRecents`) |
| `getStarredTags` | `eagle.tag.getStarredTags()` | `Promise<Object[]>` | build18+ |
| `merge` | `eagle.tag.merge({ source, target })` | `Promise<{affectedItems, sourceRemoved}>` | build18+, **irreversible** |

`Tag` instance: `save()` (build12+, rename only — updates all items using the tag),
properties `name` (r/w), `count`, `color`, `groups`, `pinyin`.

**[DOC]** <https://developer.eagle.cool/plugin-api/api/tag-group.md>
`eagle.tagGroup.get()`, `eagle.tagGroup.create({ name, color, tags, description })`;
instance `save()`, `remove()`, `addTags({ tags, removeFromSource })` (build18+),
`removeTags({ tags })` (build18+). Colors: `red, orange, yellow, green, aqua, blue, purple, pink`.

> Simplest route for tags: items take tag **names** directly in `options.tags` on the `addFrom*`
> methods and in `item.tags` — you do not need to pre-create tags.

---

## 6. `dialog` API

**[DOC]** <https://developer.eagle.cool/plugin-api/api/dialog.md>

### 6.1 `showOpenDialog(options)`

| Option | Type | Notes |
|---|---|---|
| `title` | string | Dialog window title |
| `defaultPath` | string | Default display path |
| `buttonLabel` | string | Custom confirm-button label |
| `filters` | FileFilter[] | `{ name: string, extensions: string[] }[]` |
| `properties` | string[] | `openFile`, `openDirectory`, **`multiSelections`**, `showHiddenFiles`, `createDirectory` (macOS), `promptToCreate` (Windows) |
| `message` | string | macOS only, message above the input box |

Resolves to `{ canceled: boolean, filePaths: string[] }` (empty array when canceled).

**Multi-select is supported** via the `multiSelections` property:

```javascript
let result = await eagle.dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections']
});
```

Filters look like:

```javascript
{
  filters: [
    { name: 'Images', extensions: ['jpg', 'png', 'gif'] },
    { name: 'Movies', extensions: ['mkv', 'avi', 'mp4'] },
    { name: 'Custom File Type', extensions: ['as'] },
    { name: 'All Files', extensions: ['*'] }
  ]
}
```

Both `openFile` and `openDirectory` can be combined:

```javascript
let result = await eagle.dialog.showOpenDialog({
    properties: ['openFile', 'openDirectory']
});
```

### 6.2 `showSaveDialog(options)`

Same option shape (`title`, `defaultPath`, `buttonLabel`, `filters`, `properties`, `message`),
but `properties` supports only `openDirectory`, `showHiddenFiles`, `createDirectory` (macOS).
Resolves to `{ canceled: boolean, filePath: string }` — `filePath` is `undefined` when canceled.

```javascript
let result = await eagle.dialog.showSaveDialog({
    properties: ['openDirectory']
});
```

### 6.3 `showMessageBox(options)`

| Option | Type | Notes |
|---|---|---|
| `message` | string | **Required**, main content |
| `title` | string | |
| `detail` | string | Additional information |
| `buttons` | string[] | Button labels |
| `type` | string | `none` \| `info` \| `error` \| `question` \| `warning` |

Resolves to `{ response: <index of clicked button> }`.

```javascript
let result = await eagle.dialog.showMessageBox({
    title: "Messagebox title",
    message: "Message from the Plugin process",
    detail: "Ultra message here",
    buttons: ["OK", "Cancel"],
    type: "info"
});

console.log(result);		// {response: 0}
```

### 6.4 `showErrorBox(title, content)`

```javascript
await eagle.dialog.showErrorBox("Error box title", "Error message from the Plugin process");
```

Positional args, resolves `Promise<void>`. Note the docs also mention
`eagle.dialog.showErrorBox` is analogous to Electron's `dialog.showErrorBox`.

> **Gotcha:** the docs sometimes label Electron analogues sloppily (several methods are described
> as "similar to Electron API's `dialog.showSaveDialog`" even when they are `showOpenDialog` /
> `showMessageBox` / `showErrorBox`). Trust the method names and signatures, not the analogy text.

### 6.5 There is no `openDirectory` / `saveFile` method name

The task brief mentions `openDirectory`, `saveFile`, `showMessageBox`, `showErrorBox` — the actual
documented names are `showOpenDialog` (with `properties: ['openDirectory']` for folder picking) and
`showSaveDialog`. **[DOC]**

---

## 7. Node.js access

### 7.1 Yes — full Node integration in plugin pages

**[DOC]** <https://developer.eagle.cool/plugin-api/tutorial/node-js-native-api.md>

```javascript
const fs = require('fs');

// Read file
fs.readFile('/path/to/file.txt', (err, data) => {
    if (err) throw err;
    console.log(data);
});

// Write file
fs.writeFile('/path/to/file.txt', 'Hello, world!', (err) => {
    if (err) throw err;
    console.log('The file has been saved!');
});
```

- **`require` — plain `require`, not `window.require`.** Documented literally as
  `const fs = require('fs')`. **[EX]** Real plugins use both `require('fs')` and
  `require('node:fs')` (node: prefix works too).
- **Available built-in modules** — docs name `http`, `path`, `os`, `crypto`, `zlib` explicitly, plus
  `fs` throughout; **[EX]** real plugins also use `child_process` (`require('child_process').spawn`)
  and `url`. Since it is a real Node runtime, the full built-in set is present.
- **`__dirname` — YES.** **[EX]** `eagle-ai-tagger` uses
  `` require(`${__dirname}/opencv.js`) `` and `` `${__dirname}/model` `` inside a plugin page.
  It resolves to the plugin folder (e.g. `.../Eagle/plugins/<id>`).
- **`process`** — **[INFER]** available (standard Node global); the docs never mention it. Use
  `eagle.app.*` for app/platform info instead where possible.
- **`Buffer` — YES.** **[EX]** used directly in the official Preview example
  (`buffer.toString('base64')`) and in `clipboard.writeBuffer` docs.
- **`fetch` — YES** ([DOC] <https://developer.eagle.cool/plugin-api/tutorial/network-request.md>)
  and docs note "the Eagle Plugin API is not affected by cross-domain restrictions (CORS), so it can
  access any URL."

### 7.2 Third-party npm modules

**[DOC]** <https://developer.eagle.cool/plugin-api/tutorial/3rd-modules.md> — "Using third-party
modules is similar to using native modules; you simply need to import them using the `require()`
function."

```bash
npm install is_js --save
```

```javascript
const is = require('is_js');
```

**[EX]** `eagle-ai-tagger` ships `package.json` with `csv-parser` and `onnxruntime-node` and calls
`require('onnxruntime-node')`, `require('csv-parser')` from its plugin page. So real npm packages,
**including native (`.node`) modules**, work when their `node_modules` are present inside the
plugin folder. Ship `node_modules` with the plugin (and prune it — see §11).

### 7.3 ES modules and bundlers

- **ES modules — YES.** **[EX]** The official `i18n+theme` template's `src/app.html` uses
  `<script type="module" src="app.js"></script>`, and `eagle-ai-tagger` uses a large inline
  `<script type="module">`. Both are official/real plugins.
- **Bundlers — YES but not required.** The docs never prescribe one, and all official examples are
  plain unbundled scripts (vanilla JS/CSS, per the template README: "written in Vanilla.js / CSS 3").
  A third-party framework does exist: **`eagle-plugin`** (npm, by `mktbsh`) — "Framework and
  command-line tools for Eagle plugin development", Vite + TypeScript, with
  `eagle dev` / `eagle build` / `eagle check`. Its docs state the build output "targets Eagle 4.0's
  **Electron 22 and Chromium 108** runtime and uses relative asset URLs".
  This is **community**, not official Eagle — treat as optional convenience.
- **Practical rule:** whatever the bundler emits must be **relative-path** assets loaded from inside
  the plugin folder; there is no documented HTTP dev-server mode in the core docs (the community
  framework implements one via a local bridge page).
- **`<script>` must be relative** — `main.url` is a plugin-root-relative path.

---

## 8. File access

### 8.1 Reading a file the user chose

**[DOC]** <https://developer.eagle.cool/plugin-api/tutorial/access-local-files.md> — use the native
dialog to get a path, then Node `fs`:

```javascript
let result = await eagle.dialog.showOpenDialog({
    properties: ['openFile', 'openDirectory']
});
// result.filePaths -> absolute path(s)
```

```javascript
const fs = require('fs');

// Read the file
fs.readFile('/path/to/file', (err, data) => {
  if (err) throw err;
  console.log(data);
});

// Write to the file
fs.writeFile('/path/to/file', 'hello world', (err) => {
  if (err) throw err;
  console.log('done');
});
```

Also useful: `fs.stat()`, `fs.rename()` ([DOC]).

**[DOC]** Best practice: "Avoid using synchronous methods in Node.js as much as possible, as these
methods can cause UI thread blocking… use asynchronous methods."

### 8.2 Temp / working directory

**[DOC]** <https://developer.eagle.cool/plugin-api/api/os.md>
- `eagle.os.tmpdir()` → `'C:\\Users\\User\\AppData\\Local\\Temp'` (sync, returns string)

**[DOC]** <https://developer.eagle.cool/plugin-api/api/app.md> — `await eagle.app.getPath(name)`
with `name` ∈ `home`, `appData`, `userData`, `temp`, `exe`, `desktop`, `documents`, `downloads`,
`music`, `pictures`, `videos`, `recent` (Windows only).

```javascript
await eagle.app.getPath('appData');   // 'C:\Users\User\AppData\Roaming'
await eagle.app.getPath('pictures');  // 'C:\Users\User\Pictures'
```

**[DOC]** `eagle.app.userDataPath` (build12+) → `"C:\\Users\\User\\AppData\\Roaming\\Eagle"`, and
the docs warn: "*not recommended to write large files [to `userData`], as some environments will
back up this directory to cloud storage.*" → **use `temp` for scratch files.**

Recommended working directory pattern **[INFER]**:

```javascript
const os   = require('os');
const path = require('path');
const fs   = require('fs');

const workDir = path.join(eagle.os.tmpdir(), 'brushbox');   // or await eagle.app.getPath('temp')
await fs.promises.mkdir(workDir, { recursive: true });
// ... write intermediates ...
// clean up when done
await fs.promises.rm(workDir, { recursive: true, force: true });
```

### 8.3 Does `<input type="file">` work?

**[INFER]** — **Not documented anywhere in the official plugin docs.** The plugin page is a normal
Chromium renderer with Node integration, so a file input will open the OS picker and fire `change`
with `File` objects. Two caveats:

1. To get a **filesystem path** from a `File`, older Electron exposed the non-standard `file.path`
   property. That property was removed in Electron 32; Eagle 4.0 is documented as Chromium 107 /
   Electron ~21–22 territory, where `file.path` historically existed — but **verify in DevTools
   before relying on it**.
2. The portable alternative that needs no path at all is to read the `File` with `FileReader` and
   push the data URL into `eagle.item.addFromBase64(...)` (§4.6).

**Official docs only ever use `eagle.dialog.showOpenDialog` for file selection.** Prefer that: it
returns absolute paths directly, which is what `fs` and `addFromPath` want.

### 8.4 Other local-file helpers

- `eagle.shell.openPath(path)` — open with the OS default app
- `eagle.shell.showItemInFolder(path)` — reveal in Explorer/Finder
- `eagle.shell.openExternal(url)` — open URL in default browser
- `eagle.drag.startDrag(filePaths: string[])` — native drag-out of files
- `eagle.clipboard.copyFiles(paths: string[])` — put files on the clipboard for pasting in Finder/Explorer
- `eagle.app.getFileIcon(path, { size })` and `eagle.app.createThumbnailFromPath(path, maxSize)`
  → Electron `NativeImage` (`img.toDataURL()`, `img.toPNG()`)

---

## 9. UI conventions / constraints

### 9.1 Runtime version

**[DOC]** <https://developer.eagle.cool/plugin-api/get-started/readme.md>:

> "Currently, the Eagle Plugin API is based on **Chromium 107 and Node 16**, so there is no need to
> consider webpage compatibility issues. Developers can use the latest Web technologies with
> confidence…"

**[EX]** The community `eagle-plugin` framework targets "Eagle 4.0's **Electron 22 and Chromium
108** runtime". Electron 22 bundles Node 16.17.

→ Plan for **Chromium ~107–108 / Node 16**, i.e. Electron 21–22 class. No top-level `await` in
classic scripts, no `Array.prototype.findLast` guarantees beyond Chromium 97+, etc. Optional
chaining/nullish coalescing are fine (the official `i18n+theme` `app.js` uses `??`).

### 9.2 Content-Security-Policy

**[INFER]** — **No CSP is documented for Eagle plugin pages.** Empirical evidence from official and
real plugins strongly suggests a permissive/absent CSP:

- **[EX]** `eagle-ai-tagger/index.html` loads **remote CDN scripts and stylesheets**:
  ```html
  <script src="https://unpkg.com/vue@3"></script>
  <script src="https://unpkg.com/element-plus"></script>
  <link rel="stylesheet" href="https://unpkg.com/element-plus/dist/index.css">
  ```
- The same file uses a large **inline** `<script type="module">` and an inline `<style>` block.
- **[EX]** The official `i18n+theme` `app.html` loads a local `app.css` — but the Preview plugin's
  `viewer/icns.html` uses an inline `<style>` and inline `<script>` too.

Practical conclusion: **inline scripts/styles and remote CDN resources work today.** They are not
*contractually* guaranteed by the docs, so if a future Eagle build tightens CSP your plugin breaks —
self-host critical assets inside the plugin folder and keep remote loads optional. (Note that the
plugin **review** team scrutinizes remote code loading — see §11.3.)

### 9.3 CSS / design conventions

**[DOC]** Only a little is officially prescribed:
- Base font stack — from the official `i18n+theme` template (`src/app.css`) **[EX]**:
  ```css
  * {
      -webkit-font-smoothing: antialiased;
      box-sizing: border-box;
      margin: 0;
      font-family: -apple-system, "SF Pro Text", Helvetica Neue, Helvetica, Roboto, Arial,
                   PingFang SC, PingFang TC, Hiragino Sans GB, Microsoft Yahei, Microsoft Jhenghei,
                   sans-serif;
      font-weight: 400;
  }
  ```
  Body text in the template is **14px**; headers **14px / weight 500**; a large heading uses 36px.
- **Theming** — Eagle sets a `theme` attribute on the plugin page's `<html>` element. **[EX]** From
  the official template's `app.js`:
  ```javascript
  async function updateTheme() {
      const THEME_SUPPORT = {
          AUTO: eagle.app.isDarkColors() ? 'gray' : 'light',
          LIGHT: 'light',
          LIGHTGRAY: 'lightgray',
          GRAY: 'gray',
          DARK: 'dark',
          BLUE: 'blue',
          PURPLE: 'purple',
      };
      const theme = eagle.app.theme.toUpperCase();
      const themeName = THEME_SUPPORT[theme] ?? 'dark';
      const htmlEl = document.querySelector('html');
      htmlEl.classList.add('no-transition');
      htmlEl.setAttribute('theme', themeName);
      htmlEl.setAttribute('platform', eagle.app.platform);
      htmlEl.classList.remove('no-transition');
  }
  eagle.onPluginCreate(() => updateTheme());
  eagle.onThemeChanged(() => updateTheme());
  ```
  Official theme background colors paired with that scheme **[EX]**:
  | theme | background |
  |---|---|
  | `light` | `#f4f4f4` |
  | `lightgray` | `#e3e4e6` |
  | `gray` | `#37383c` |
  | `dark` | `#18191c` |
  | `blue` | `#0d1630` |
  | `purple` | `#1c1424` |

  Text/border tokens used by the template (light group vs. dark group):
  - light + lightgray: `--border-secondary: rgba(0,0,0,.1)`, `--color-bg-hover: rgba(0,0,0,.05)`,
    `--color-text-primary: rgb(24,25,28)`, `--color-text-secondary: rgb(24,25,28,.7)`,
    `--color-text-tertiary: rgb(24,25,28,.5)`
  - dark/gray/blue/purple: same keys with `rgba(255,255,255,.1)` / `rgba(255,255,255,.05)` and
    `rgb(248,249,251)` at 1 / .7 / .5 alpha.
  - `--color-bg-hover` is used for button hover; header height 48px with a 1px bottom border.
- **Frameless windows** ([DOC] <https://developer.eagle.cool/plugin-api/tutorial/frameless-window.md>):
  `main.frame: false` ⇒ you must provide your own chrome. Dragging is opt-in via
  `-webkit-app-region: drag`, and interactive children need `-webkit-app-region: no-drag`:
  ```html
  <body style="-webkit-app-region: drag"></body>
  ```
  ```css
  button { -webkit-app-region: no-drag; }
  ```
  "Currently only rectangular shapes are supported." The official template's approach:
  ```css
  header .draggable { -webkit-app-region: drag; display: flex; align-items: center;
                      gap: 8px; flex: 1; height: 100%; }
  ```
  and a close button that just calls `window.close()`.
- **[DOC]** There are **no official Eagle "native control" classes** documented. The docs never
  ship a CSS framework, component library, or base stylesheet. The official templates are vanilla
  CSS; real plugins pull in whatever they like (Vue + Element Plus via CDN in `eagle-ai-tagger`).
- **[DOC]** `allowZoom` on format-extension thumbnails controls whether users can zoom.

### 9.4 Recommended reference implementations

- Official examples: <https://github.com/eagle-app/eagle-plugin-examples>
  - `Window` — minimal window plugin
  - `Service` — background service
  - `Multiple Windows` — `main.multiple: true`
  - `Preview` — format extension + `require` in a viewer page
  - `Inspector` — inspector plugin
  - `i18n`, `i18n+theme` — the best template for a polished window UI (theme handling, i18n,
    frameless header, external-link hijacking)
  - `3rd-party` — bundling an npm module
- A real-world reference with npm deps + native modules: <https://github.com/jtydhr88/eagle-ai-tagger>

---

## 10. Debugging

**[DOC]** <https://developer.eagle.cool/plugin-api/get-started/debugging.md>

- **Window plugins:** "After opening the plugin, press the **F12** key to open the DevTools
  debugging tool." Then use breakpoints, performance/memory panels, etc.
- **Thumbnail (format-extension thumbnail) plugins:** they run in the background and only execute
  when files are added/updated. Set `"devTools": true` in `manifest.json` **and set `debugger`
  breakpoints in the code** to debug them.
- **Preview (format extension) plugins:** add and select the file format you're developing, open the
  plugin panel, click your plugin — a separate preview window opens; press **F12** for DevTools.
- **Log system** — `eagle.log.*` writes into Eagle's own software log:
  ```javascript
  eagle.log.debug('debug message from plugin');
  eagle.log.info('info message from plugin');
  eagle.log.warn('warn message from plugin');
  eagle.log.error('error message from plugin');

  // [13:19:39.845] [debug] [plugin] "debug message from plugin"
  // [13:19:39.845] [info] [plugin] "info message from plugin"
  // [13:19:39.845] [warn] [plugin] "warn message from plugin"
  // [13:19:39.845] [error] [plugin] "error message from plugin"
  ```
  `eagle.log.<level>(obj)` accepts `Object`, `String`, `Array`, etc. **[DOC]**
  ```javascript
  try { let a = {}; a.b.c = 'test'; }
  catch (err) { eagle.log.error('error message from plugin'); eagle.log.error(err.stack || err); }
  ```
  Logs are tagged `[plugin]` and go to Eagle's app log; error-log retrieval guide:
  <https://docs-cn.eagle.cool/article/92-how-do-i-get-the-error-log>
- **[DOC] Warning:** "The preview and thumbnail plugins currently do not support the log API."
- **Reloading during development** — not documented. Close/reopen the plugin window, use
  DevTools' reload (Ctrl+R / F5) in the plugin window, or re-import. A service plugin only restarts
  with Eagle itself (or by disabling/re-enabling it).
- `console.log` goes to the plugin window's DevTools console (not to Eagle's log) — use
  `eagle.log.*` for anything you want persisted.

---

## 11. Packaging & publishing

### 11.1 Package format

**[DOC]** <https://developer.eagle.cool/plugin-api/publishing/package.md>

- Package with Eagle itself: **plugin panel (or press `P`) → right-click the plugin → "Pack Plugin"
  → choose save path → a `.eagleplugin` file is produced.**
- Submit that `.eagleplugin` on the Eagle Plugin submission page.
- **[DOC]** "Use Eagle to package the final release. **Do not upload a development directory or
  another archive format.**" and "it is the final release package, **not another archive format with
  a renamed extension**."

**[DOC]** <https://developer.eagle.cool/plugin-api/plugin-review/criteria/configuration-and-reviewability.md>
Release requirements:
- `manifest.json` exists in the **plugin root**; valid JSON object; `id` and `name` non-empty strings;
  **`devTools` is not `true`**.
- The archive must contain no duplicate paths, unsafe links, or paths that could write outside the
  plugin directory.
- Install the packaged file before submitting and verify it runs **without the original project
  directory**.

### 11.2 What to exclude

**[DOC]** <https://developer.eagle.cool/plugin-api/plugin-review/criteria/package-contents.md>

Exclude:
- VCS/editor: `.git/`, `.svn/`, `.hg/`, `.bzr/`, `.idea/`, `.vscode/`
- Python: `__pycache__/`, `.pytest_cache/`, `.venv/`, `venv/`
- Secrets: `.env*`, `.pem`, `.key`, `.p12`, `.pfx`, `credentials.json`, `secrets.json`, `.npmrc`
  with tokens
- Junk: `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.log`, `.tmp`, `.swp`, `.swo`, test output,
  draft screenshots, caches, duplicate `dist/`, old builds
- Nested archives: `.zip`, `.rar`, `.7z`, `.tar`, `.tgz`, `.gz`, `.dmg`, `.iso` (unless required —
  then explain in review notes)

"**Do not package the entire project directory unchanged.** If `node_modules/` or another dependency
directory is required at runtime, retain only what the release needs. Remove unused development
dependencies and duplicate packages from built releases."

Binaries (`.exe`, `.dll`, `.dylib`, `.so`, `.node`, …) get extra review but are not automatically
rejected — they must directly support the stated functionality, come from a trusted source, be
redistributable, have disclosed platforms/architectures, and not perform undisclosed installation
or downloads.

### 11.3 Review, listing limits, and policy

**[DOC]** <https://developer.eagle.cool/plugin-api/plugin-review/review.md> — every submission goes
through **Stage 1 initial scan**, then **human review**. New criteria apply from **July 21, 2026**.

**[DOC]** store-listing limits (<https://developer.eagle.cool/plugin-api/plugin-review/criteria/store-listing-copy.md>):
- Plugin **name**: max **30 Unicode code points**, and **≤ 6 words** in whitespace-delimited
  languages.
- **Short description**: English max **200 code points**; Simplified Chinese max **100**.
- Every submitted locale is reviewed independently; no placeholders/draft text.
- Changelog entries must be meaningful (not just "Update"/"Fix").

**[DOC]** security scrutiny (<https://developer.eagle.cool/plugin-api/plugin-review/criteria/security-and-privacy.md>):
- Dynamic code execution from strings, `child_process`, file deletion/bulk modification, remote code
  loading, and executable downloads after install are all examined.
- External connections must match the stated purpose; only minimum data; unencrypted HTTP and
  `localhost`/private-network connections need a disclosed purpose.
- "Loading web fonts as intended, for example, is generally acceptable."

**[DOC]** AI-assisted code is allowed but the developer must understand, inspect and test it:
"Submissions clearly assembled from AI-generated code without basic inspection or real testing may
not pass review."

**[DOC]** <https://developer.eagle.cool/plugin-api/publishing/prepare.md> pre-submission checklist
covers release config, store listing, security/package contents, review info (test steps /
credentials), developer policies.

### 11.4 Unpacked folder for personal use — no publishing required

**[DOC]** Publishing is entirely opt-in. Nothing in the docs gates *running* a plugin on having it
published. The documented dev flow (Create Plugin / Import Local Project, §1.4) is exactly the
"unpacked folder" path, and pressing `P` → click runs it. `devTools: true` is only forbidden **in a
release submitted for review** — it is expected during development.

So: **for personal use, an unpacked folder imported from your working copy is sufficient; no
packaging, no submission, no review.**

---

## 12. GOTCHAS

1. **`eagle.item.add()` does not exist.** Nor does `eagle.item.addFromBuffer()`, `addFromBlob()`,
   or a plural `addFromPaths()`. The Plugin API's only adders are `addFromURL`, `addFromBase64`,
   `addFromPath`, `addBookmark`. The `addFromPaths` (plural) method belongs to the *separate Local
   REST API* on `localhost:41595` (<https://api.eagle.cool/item/add-from-paths>) — different
   product, different auth, not usable as a drop-in.
2. **`devTools` placement is documented inconsistently.** `tutorial/manifest.md`, the review
   criteria, and the official examples all put `"devTools"` at the **top level** of `manifest.json`.
   The "File Structure Overview" page's snippet puts it **inside `main`**. Use **top level**
   (`"devTools": false`), matching the examples and the reviewer's check ("`devTools` is not set to
   `true`"). If in doubt, set it at top level only.
3. **No rating (`star`) parameter when adding.** `addFrom*` options are only
   `name / website / tags / folders / annotation` (plus `base64` for bookmarks). Set
   `item.star = n; await item.save();` afterwards.
4. **`folders` is an array of folder *IDs*, not names.** Typical mistake: passing `["Brushes"]`.
   Do `const f = await eagle.folder.create({name:'Brushes'}); ... folders: [f.id]`.
   `tags`, by contrast, **are names**.
5. **`addFromBase64` example passes a full data URL**, not a bare payload. Include the
   `data:image/png;base64,` prefix.
6. **`addFromPath` is singular.** Adding 500 rendered brushes means 500 awaited calls. Prefer
   batching with `Promise.all` carefully — parallel writes can hammer the library; sequential
   `await` inside a loop is safer, with a progress UI.
7. **Directly editing `metadata.json` is explicitly discouraged** on every API page: "use the
   `save()` method… avoid directly modifying the `metadata.json` or any files under the Eagle
   resource library." The Item/Folder instances are proxies — mutate the property, then `save()`.
8. **`save()` is required.** Mutating `item.tags` without `await item.save()` silently does nothing.
9. **`eagle.item.select(ids)` replaces the whole selection** and clears it when passed `[]`. The
   instance method `item.select()` selects only that item. Both need **Eagle 4.0 build12+**.
10. **Version-gated APIs** (all "Eagle 4.0 buildN+"):
    - build12+: `item.select`, `item.open({window:true})`, `folder.iconColor` writable,
      `folder.parent` writable, `tag.get({name})`, `tag.save()`, `app.userDataPath`
    - build18+: `item.importedAt` writable, `tag.getStarredTags()`, `tag.merge()`,
      `tagGroup.addTags/removeTags`, `tagGroup.description`, `app.show()`
    - build22+: `main.followCursor`, `item.comments`, `addComment`/`updateComment`/`removeComment`,
      the whole `eagle.smartFolder` module
    - FFmpeg extra module: "Eagle 4.0 **beta 7** and above"
    Guard with `eagle.app.build` before calling, or document the minimum version.
11. **`tag.getRecents()` was a documentation bug** — the real method is `eagle.tag.getRecentTags()`.
    Fixed in the changelog (Jan 6, 2026). Don't copy old snippets.
12. **Service plugins have a different lifecycle.** With `main.serviceMode: true` the page loads at
    Eagle startup and **no `index.html` click is required** — "Plugins will be created automatically,
    no need for users to execute them." Don't assume `onPluginRun` fires. Also register
    `onLibraryChanged` if you cache library-relative paths, or you'll write into the wrong library
    after a switch.
13. **`main.url` and all assets are plugin-root-relative**, and `__dirname` points at the plugin
    folder. If a bundler emits absolute paths (`/assets/x.js`), assets 404.
14. **Format-extension (preview/thumbnail) plugins are second-class citizens:** no Eagle Plugin API
    access and no DevTools debugging in the same way ("currently the format extension plugins do not
    support Eagle Plugin API and DevTools debugging functionality"), and the **log API is not
    supported** for preview/thumbnail plugins.
15. **`eagle.onPluginCreate` is the safe init point**, not `window.onload` — it delivers
    `plugin.manifest` and `plugin.path`. But the docs note you may fall back to `window.onload` "if
    the plugin can run without manifest information."
16. **Frameless windows are non-draggable by default.** Forgetting `-webkit-app-region: drag` gives
    users an unmovable window; forgetting `no-drag` on buttons makes them unclickable.
17. **`eagle.app.theme` values are UPPERCASE-ish** (`LIGHT`, `LIGHTGRAY`, `GRAY`, `DARK`, `BLUE`,
    `PURPLE`) but `onThemeChanged` may deliver `Auto`; the official template upper-cases before
    lookup and falls back to `dark`. Handle unknown values.
18. **`frame: false` + `backgroundColor`** matter — set `backgroundColor` to your dark UI color or
    you get a white flash on open.
19. **Don't confuse the three Eagle APIs:**
    - **Plugin API** — `eagle.*` inside a plugin window (`developer.eagle.cool/plugin-api`) ← this doc
    - **Local REST API** — HTTP on `http://localhost:41595/api/...` (`api.eagle.cool`) — external tools
    - **Web API** — `developer.eagle.cool/web-api`
    Method names overlap but signatures/return shapes differ (e.g. REST returns
    `{status, data}` envelopes and uses `addFromPaths`).
20. **`logo` field format is restricted** to `png`/`jpg`/`webp`, 128×128 recommended, square, with
    safe padding. A `.svg` or `.ico` logo will not work.
21. **Bundled secrets destroy a submission.** `.env`, tokens, and keys in the package block review —
    and if one leaks, deleting the file isn't enough: rotate the credential.
22. **`html[theme]` attribute is set by Eagle**, and the official template adds a `no-transition`
    class around the switch to avoid a CSS transition flash. Worth copying.
23. **`eagle.window.setReferer(url)`** exists and affects *subsequent* requests from the plugin —
    handy when scraping image CDNs that check `Referer`, and easy to forget you set it.
24. **`eagle.window.setIgnoreMouseEvents(true)`** + `setAlwaysOnTop(true)` creates a
    click-through floating overlay. Reversing it wrong can make your plugin window unclickable.
25. **`eagle.clipboard.clear()` then `readText()` returns `undefined`**, not an empty string.
26. **`fetch` is CORS-exempt** per the docs, but a bare `XMLHttpRequest`-style assumption about
    `Origin` may still bite for some servers — the `https` module is the fallback the docs recommend.

---

## 13. Quick reference — most-used signatures

```javascript
// --- lifecycle
eagle.onPluginCreate((plugin) => { /* plugin.manifest, plugin.path */ });
eagle.onPluginRun(() => {});
eagle.onPluginShow(() => {});
eagle.onPluginHide(() => {});
eagle.onPluginBeforeExit((event) => {});
eagle.onLibraryChanged((libraryPath) => {});
eagle.onThemeChanged((theme) => {});

// --- read
eagle.item.getSelected()                        -> Promise<Item[]>
eagle.item.get(options)                         -> Promise<Item[]>
eagle.item.getAll()                             -> Promise<Item[]>
eagle.item.getById(id) / getByIds(ids)          -> Promise<Item> / Promise<Item[]>
eagle.item.count(options) / countAll() / countSelected() -> Promise<number>
eagle.item.getIdsWithModifiedAt()               -> Promise<{id, modifiedAt}[]>
eagle.folder.getAll() / getSelected() / getById(id) / getByIds(ids) / get(options)
eagle.tag.get({name}) / getRecentTags() / getStarredTags()
eagle.library.info(); eagle.library.name; eagle.library.path; eagle.library.modificationTime
eagle.app.version / .build / .locale / .arch / .platform / .theme / .userDataPath / .env
eagle.app.isDarkColors(); await eagle.app.getPath('temp'|'pictures'|...); await eagle.app.show()
eagle.os.tmpdir(); eagle.os.homedir(); eagle.os.arch(); eagle.os.type()

// --- write
eagle.item.addFromURL(url,   { name, website, tags, folders, annotation }) -> Promise<itemId>
eagle.item.addFromBase64(b64,{ name, website, tags, folders, annotation }) -> Promise<itemId>
eagle.item.addFromPath(path, { name, website, tags, folders, annotation }) -> Promise<itemId>
eagle.item.addBookmark(url,  { name, base64, tags, folders, annotation })  -> Promise<itemId>
eagle.item.update(...)   // DOES NOT EXIST — mutate the Item then await item.save()
eagle.item.select(itemIds); eagle.item.open(itemId, { window: true })
item.save(); item.moveToTrash(); item.refreshThumbnail();
item.replaceFile(path); item.setCustomThumbnail(path); item.open({window:true}); item.select()

eagle.folder.create({ name, description, parent }) -> Promise<Folder>
eagle.folder.createSubfolder(parentId, { name, description }) -> Promise<Folder>
eagle.folder.open(folderId); folder.save(); folder.open()

// --- dialogs
eagle.dialog.showOpenDialog({ title, defaultPath, buttonLabel, filters, properties })
       -> { canceled, filePaths }
eagle.dialog.showSaveDialog({ ...same... }) -> { canceled, filePath }
eagle.dialog.showMessageBox({ message, title, detail, buttons, type }) -> { response }
eagle.dialog.showErrorBox(title, content) -> Promise<void>

// --- misc
eagle.notification.show({ title, body, icon, mute, duration }) -> Promise<>
eagle.window.show() / hide() / focus() / minimize() / maximize() / unmaximize()
eagle.window.setSize(w,h) / setBounds({x,y,width,height}) / setPosition(x,y)
eagle.window.setAlwaysOnTop(flag) / setIgnoreMouseEvents(flag) / setOpacity(n)
eagle.window.setFullScreen(flag) / setResizable(flag) / setAspectRatio(r) / setBackgroundColor(hex)
eagle.window.capturePage(rect?) -> NativeImage ( .toDataURL('image/jpeg'), .toPNG() )
eagle.window.setReferer(url)
eagle.shell.openExternal(url) / openPath(path) / showItemInFolder(path) / beep()
eagle.log.debug(obj) / info(obj) / warn(obj) / error(obj)
eagle.contextMenu.open([{ id, label, submenu, click }])
eagle.drag.startDrag(filePaths)
eagle.clipboard.readText() / writeText(t) / readImage() / writeImage(img) / copyFiles(paths)
eagle.extraModule.ffmpeg.isInstalled() / install() / getPaths()  // manifest "dependencies": ["ffmpeg"]
```

---

## 14. Source URLs

| Topic | URL |
|---|---|
| Docs index (Markdown) | https://developer.eagle.cool/plugin-api/llms.txt |
| Intro / runtime versions | https://developer.eagle.cool/plugin-api/get-started/readme.md |
| First plugin / dev flow | https://developer.eagle.cool/plugin-api/get-started/creating-your-first-plugin.md |
| File structure | https://developer.eagle.cool/plugin-api/get-started/anatomy-of-an-extension.md |
| Plugin types | https://developer.eagle.cool/plugin-api/get-started/plugin-types.md |
| Window plugin | https://developer.eagle.cool/plugin-api/get-started/plugin-types/window.md |
| Background service | https://developer.eagle.cool/plugin-api/get-started/plugin-types/service.md |
| Format extension | https://developer.eagle.cool/plugin-api/get-started/plugin-types/preview.md |
| manifest.json | https://developer.eagle.cool/plugin-api/tutorial/manifest.md |
| Retrieve data | https://developer.eagle.cool/plugin-api/tutorial/get-eagle-data.md |
| Modify data | https://developer.eagle.cool/plugin-api/tutorial/modify-eagle-data.md |
| Access local files | https://developer.eagle.cool/plugin-api/tutorial/access-local-files.md |
| Network requests | https://developer.eagle.cool/plugin-api/tutorial/network-request.md |
| Node.js native API | https://developer.eagle.cool/plugin-api/tutorial/node-js-native-api.md |
| Third-party modules | https://developer.eagle.cool/plugin-api/tutorial/3rd-modules.md |
| i18n | https://developer.eagle.cool/plugin-api/tutorial/i18n.md |
| Frameless window | https://developer.eagle.cool/plugin-api/tutorial/frameless-window.md |
| event | https://developer.eagle.cool/plugin-api/api/event.md |
| **item** | https://developer.eagle.cool/plugin-api/api/item.md |
| folder | https://developer.eagle.cool/plugin-api/api/folder.md |
| smartFolder | https://developer.eagle.cool/plugin-api/api/smart-folder.md |
| tag | https://developer.eagle.cool/plugin-api/api/tag.md |
| tagGroup | https://developer.eagle.cool/plugin-api/api/tag-group.md |
| library | https://developer.eagle.cool/plugin-api/api/library.md |
| window | https://developer.eagle.cool/plugin-api/api/window.md |
| app | https://developer.eagle.cool/plugin-api/api/app.md |
| os | https://developer.eagle.cool/plugin-api/api/os.md |
| screen | https://developer.eagle.cool/plugin-api/api/screen.md |
| notification | https://developer.eagle.cool/plugin-api/api/notification.md |
| contextMenu | https://developer.eagle.cool/plugin-api/api/context-menu.md |
| dialog | https://developer.eagle.cool/plugin-api/api/dialog.md |
| clipboard | https://developer.eagle.cool/plugin-api/api/clipboard.md |
| drag | https://developer.eagle.cool/plugin-api/api/drag.md |
| shell | https://developer.eagle.cool/plugin-api/api/shell.md |
| log | https://developer.eagle.cool/plugin-api/api/log.md |
| FFmpeg module | https://developer.eagle.cool/plugin-api/extra-module/ffmpeg.md |
| Debugging | https://developer.eagle.cool/plugin-api/get-started/debugging.md |
| Prepare | https://developer.eagle.cool/plugin-api/publishing/prepare.md |
| Package | https://developer.eagle.cool/plugin-api/publishing/package.md |
| Publish | https://developer.eagle.cool/plugin-api/publishing/publish.md |
| Review process | https://developer.eagle.cool/plugin-api/plugin-review/review.md |
| Review criteria | https://developer.eagle.cool/plugin-api/plugin-review/criteria.md |
| Changelog (version gates) | https://developer.eagle.cool/plugin-api/changelog.md |
| Official examples | https://github.com/eagle-app/eagle-plugin-examples |
| Plugin dirs on disk | https://zenn.dev/tuki0918/scraps/50f70a1604fabd |
| Community dev framework | https://www.npmjs.com/package/eagle-plugin |
| Local REST API (different!) | https://api.eagle.cool/master.md |
