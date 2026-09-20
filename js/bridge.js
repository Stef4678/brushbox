/*!
 * BrushBox — Eagle host bridge
 * ---------------------------------------------------------------------
 * Every conversation with the Eagle host and the local filesystem lives
 * here, so the parser, renderer and UI can all be exercised without an
 * Eagle runtime.
 *
 * Nothing in this file throws on a missing capability: the plugin API has
 * grown across Eagle releases, so optional methods are feature-detected
 * and degrade to a logged warning instead of a crash.
 */
(function (global) {
	'use strict';

	/* ------------------------------------------------------------------ *
	 * Node access
	 * ------------------------------------------------------------------ */

	// Inside an Eagle plugin window `require` is supplied by the preload
	// script, so it is reachable but never a bare global.
	var nodeRequire = null;
	try {
		nodeRequire = global.require || (typeof require === 'function' ? require : null);
	} catch (err) {
		nodeRequire = null;
	}

	var fs = null;
	var path = null;
	var os = null;
	try {
		if (nodeRequire) {
			fs = nodeRequire('fs');
			path = nodeRequire('path');
			os = nodeRequire('os');
		}
	} catch (err) {
		fs = null;
		path = null;
		os = null;
	}

	var TEMP_APP_DIR = 'brushbox';
	var state = { tempDir: null };

	function eagle() {
		var api = global.eagle;
		return api && typeof api === 'object' ? api : null;
	}

	/** True when the core item API is present, i.e. we are inside Eagle. */
	function available() {
		var api = eagle();
		return !!(api && api.item && typeof api.item.getSelected === 'function');
	}

	function hasNode() {
		return !!(fs && path);
	}

	/* ------------------------------------------------------------------ *
	 * Logging
	 * ------------------------------------------------------------------ */

	function makeLogger(method, fallback) {
		return function () {
			var args = Array.prototype.slice.call(arguments);
			var api = eagle();
			if (api && api.log && typeof api.log[method] === 'function') {
				try {
					api.log[method]('[brushbox] ' + args.join(' '));
					return;
				} catch (err) { /* fall through to console */ }
			}
			fallback.apply(console, ['[brushbox]'].concat(args));
		};
	}

	var log = makeLogger('info', console.log);
	var warn = makeLogger('warn', console.warn);
	var error = makeLogger('error', console.error);

	/* ------------------------------------------------------------------ *
	 * Filesystem helpers
	 * ------------------------------------------------------------------ */

	function ensureTempDir() {
		if (state.tempDir) return state.tempDir;
		if (!hasNode()) throw new Error('Filesystem access is unavailable.');
		var api = eagle();
		var base = (api && api.os && typeof api.os.tmpdir === 'function') ? api.os.tmpdir() : os.tmpdir();
		var dir = path.join(base, TEMP_APP_DIR);
		fs.mkdirSync(dir, { recursive: true });
		state.tempDir = dir;
		return dir;
	}

	/**
	 * Matches the name of a PNG this plugin staged itself:
	 * `<milliseconds>-<random>-<brush name>.png`.
	 *
	 * The temporary folder is a shared one, so the sweep below recognises its
	 * own leftovers by name rather than deleting whatever happens to be
	 * sitting there. The cost of being wrong is a stale PNG, which is the
	 * right way round for a plugin that otherwise never removes anything.
	 */
	var STAGED_NAME = /^\d{10,}-[0-9a-z]*-[\s\S]+\.png$/;

	function isStagedName(fileName) {
		return STAGED_NAME.test(String(fileName == null ? '' : fileName));
	}

	/** Removes leftovers from a previous session — and only those. */
	function sweepTempDir() {
		if (!hasNode()) return;
		try {
			var dir = ensureTempDir();
			fs.readdirSync(dir).forEach(function (name) {
				if (!isStagedName(name)) return; // not ours: leave it where it is
				try {
					fs.rmSync(path.join(dir, name), { force: true, recursive: true });
				} catch (err) { /* best effort */ }
			});
		} catch (err) {
			warn('temp sweep failed:', err && err.message);
		}
	}

	/**
	 * Reads a file into a Uint8Array.
	 *
	 * `fs.readFileSync` returns a Buffer whose `.buffer` may be a shared,
	 * pooled allocation with a non-zero `byteOffset` — slicing the buffer
	 * naively would hand the parser the wrong bytes, so the view's own
	 * offset and length are respected.
	 */
	function readFileBytes(filePath) {
		if (!hasNode()) throw new Error('Filesystem access is unavailable.');
		var buf = fs.readFileSync(filePath);
		return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
	}

	function fileSize(filePath) {
		if (!hasNode()) return 0;
		try {
			return fs.statSync(filePath).size;
		} catch (err) {
			return 0;
		}
	}

	function baseName(filePath) {
		var raw = String(filePath || '');
		var parts = raw.split(/[\\/]/);
		return parts[parts.length - 1] || raw;
	}

	/** Strips the extension: "My Brushes.abr" -> "My Brushes". */
	function stem(fileName) {
		return String(fileName || '').replace(/\.[^.]+$/, '');
	}

	function sanitizeName(name) {
		return String(name == null ? '' : name)
			.replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
			.replace(/\s+/g, ' ')
			.replace(/^[.\s]+|[.\s]+$/g, '')
			.slice(0, 120) || 'brush';
	}

	/**
	 * A path reduced to a comparable key.
	 *
	 * The same file can arrive as `C:\a\b.abr`, `c:/a/b.abr` or with a
	 * doubled separator, and Windows and macOS filesystems are
	 * case-insensitive by default, so the key folds separators and case.
	 */
	function pathKey(filePath) {
		if (!filePath) return null;
		return String(filePath).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
	}

	/**
	 * A 64-bit content fingerprint (two independent 32-bit accumulators in
	 * one pass), as hex.
	 *
	 * Used to recognise a brush set that is already open. Going by content
	 * rather than by path means the same file is recognised however it
	 * arrived — dragged in, browsed to, or pulled from the Eagle selection —
	 * since a drag-and-drop payload does not always carry a real path.
	 */
	function fingerprint(bytes) {
		var h1 = 0x811c9dc5;
		var h2 = 0x01000193;

		for (var i = 0; i < bytes.length; i++) {
			var b = bytes[i];
			h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
			h2 = Math.imul(h2 + b + 1, 0x85ebca6b) >>> 0;
			h2 = (h2 ^ (h2 >>> 13)) >>> 0;
		}

		return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
	}

	/**
	 * Decides what to do with an incoming set, given the ones already open.
	 *
	 * Content is the primary identity, so the same file is recognised
	 * however it arrived — dragged in, browsed to, or pulled from the Eagle
	 * selection — since a drag payload does not always carry a real path.
	 * A match on path but *not* on content means the file changed on disk,
	 * and the stale copy should be replaced rather than duplicated.
	 *
	 * Kept pure and separate from the UI so the rule can be tested directly.
	 *
	 * @returns {{action: 'add'|'duplicate'|'replace', set: object|null}}
	 */
	function classifySource(sets, fingerprint, pathKey) {
		var byPath = null;
		var list = sets || [];

		for (var i = 0; i < list.length; i++) {
			var set = list[i];
			if (set.fingerprint === fingerprint) return { action: 'duplicate', set: set };
			if (pathKey && set.pathKey === pathKey) byPath = set;
		}

		return byPath ? { action: 'replace', set: byPath } : { action: 'add', set: null };
	}

	/* ------------------------------------------------------------------ *
	 * Dragged files
	 * ------------------------------------------------------------------ */

	/**
	 * Pulls real bytes out of a drag-and-drop payload.
	 *
	 * Chromium no longer exposes `File.path`, and Electron's replacement
	 * (`webUtils.getPathForFile`) is not guaranteed across versions, so the
	 * bytes are read straight out of the File object — which always works
	 * and needs no filesystem access at all.
	 */
	function filesFromDataTransfer(dataTransfer) {
		var files = [];
		if (!dataTransfer) return Promise.resolve(files);

		var list = dataTransfer.files;
		var pending = [];

		for (var i = 0; i < (list ? list.length : 0); i++) {
			pending.push(readDroppedFile(list[i]));
		}

		return Promise.all(pending).then(function (results) {
			return results.filter(Boolean);
		});
	}

	function readDroppedFile(file) {
		if (!file) return Promise.resolve(null);

		var name = file.name || 'brush.abr';
		if (!/\.abr$/i.test(name)) {
			return Promise.resolve({ name: name, bytes: null, path: null, skipped: 'Not an .abr file' });
		}

		var nativePath = null;
		try {
			nativePath = typeof file.path === 'string' && file.path ? file.path : null;
		} catch (err) {
			nativePath = null;
		}
		if (!nativePath) {
			try {
				var webUtils = nodeRequire && nodeRequire('electron') && nodeRequire('electron').webUtils;
				if (webUtils && typeof webUtils.getPathForFile === 'function') {
					nativePath = webUtils.getPathForFile(file) || null;
				}
			} catch (err) { /* optional */ }
		}

		return new Promise(function (resolve) {
			var reader = new FileReader();
			reader.onload = function () {
				try {
					resolve({ name: name, bytes: new Uint8Array(reader.result), path: nativePath });
				} catch (err) {
					resolve({ name: name, bytes: null, path: nativePath, skipped: 'Could not read file' });
				}
			};
			reader.onerror = function () {
				resolve({ name: name, bytes: null, path: nativePath, skipped: 'Could not read file' });
			};
			try {
				reader.readAsArrayBuffer(file);
			} catch (err) {
				resolve({ name: name, bytes: null, path: nativePath, skipped: 'Could not read file' });
			}
		});
	}

	/* ------------------------------------------------------------------ *
	 * Native dialogs
	 * ------------------------------------------------------------------ */

	async function chooseAbrFiles() {
		var api = eagle();
		if (!api || !api.dialog || typeof api.dialog.showOpenDialog !== 'function') {
			warn('no dialog API; falling back to the browser picker');
			return null; // caller falls back to <input type="file">
		}
		try {
			var result = await api.dialog.showOpenDialog({
				title: 'Open Photoshop brushes',
				properties: ['openFile', 'multiSelections'],
				filters: [
					{ name: 'Photoshop brushes', extensions: ['abr'] },
					{ name: 'All files', extensions: ['*'] }
				]
			});
			if (!result || result.canceled || !result.filePaths) return [];
			return result.filePaths.map(function (filePath) {
				return { path: filePath, name: baseName(filePath), size: fileSize(filePath) };
			});
		} catch (err) {
			warn('file picker failed:', err && err.message);
			return [];
		}
	}

	async function chooseDirectory() {
		var api = eagle();
		if (!api || !api.dialog || typeof api.dialog.showOpenDialog !== 'function') return null;
		try {
			var result = await api.dialog.showOpenDialog({
				title: 'Choose an export folder',
				properties: ['openDirectory', 'createDirectory']
			});
			if (!result || result.canceled || !result.filePaths || !result.filePaths.length) return null;
			return result.filePaths[0];
		} catch (err) {
			warn('directory picker failed:', err && err.message);
			return null;
		}
	}

	async function confirm(options) {
		var api = eagle();
		var opts = options || {};
		if (api && api.dialog && typeof api.dialog.showMessageBox === 'function') {
			try {
				var result = await api.dialog.showMessageBox({
					type: opts.type || 'question',
					title: opts.title || 'BrushBox',
					message: opts.message || '',
					detail: opts.detail || '',
					buttons: opts.buttons || ['Cancel', 'OK'],
					defaultId: opts.defaultId == null ? 1 : opts.defaultId,
					cancelId: opts.cancelId == null ? 0 : opts.cancelId
				});
				return !!(result && result.response === (opts.confirmId == null ? 1 : opts.confirmId));
			} catch (err) {
				warn('confirm dialog failed:', err && err.message);
			}
		}
		try {
			return global.confirm(opts.message || 'Are you sure?');
		} catch (err) {
			return false;
		}
	}

	/* ------------------------------------------------------------------ *
	 * Library access
	 * ------------------------------------------------------------------ */

	async function getFolders() {
		var api = eagle();
		if (!api || !api.folder || typeof api.folder.getAll !== 'function') return [];
		try {
			var folders = await api.folder.getAll();
			return Array.isArray(folders) ? folders : [];
		} catch (err) {
			warn('could not read folders:', err && err.message);
			return [];
		}
	}

	async function getLibraryName() {
		var api = eagle();
		if (!api || !api.library || typeof api.library.info !== 'function') return null;
		try {
			var info = await api.library.info();
			return (info && (info.name || info.libraryName)) || null;
		} catch (err) {
			return null;
		}
	}

	/**
	 * .abr files the user has selected in Eagle itself, so a brush set can
	 * be opened without leaving the app.
	 */
	async function getSelectedAbrFiles() {
		var api = eagle();
		if (!api || !api.item || typeof api.item.getSelected !== 'function') return [];
		try {
			var selected = await api.item.getSelected();
			if (!Array.isArray(selected)) return [];
			return selected
				.filter(function (item) {
					return item && /^abr$/i.test(String(item.ext || '')) && item.filePath;
				})
				.map(function (item) {
					return { path: item.filePath, name: item.name ? item.name + '.abr' : baseName(item.filePath), size: fileSize(item.filePath) };
				});
		} catch (err) {
			warn('could not read the Eagle selection:', err && err.message);
			return [];
		}
	}

	async function selectItems(ids) {
		var api = eagle();
		if (!api || !api.item || typeof api.item.select !== 'function') return false;
		if (!ids || !ids.length) return false;
		try {
			await api.item.select(ids);
			return true;
		} catch (err) {
			warn('select failed:', err && err.message);
			return false;
		}
	}

	/* ------------------------------------------------------------------ *
	 * Canvas output
	 * ------------------------------------------------------------------ */

	function canvasToBlob(canvas, type) {
		return new Promise(function (resolve, reject) {
			if (typeof canvas.toBlob === 'function') {
				canvas.toBlob(function (blob) {
					if (blob) resolve(blob);
					else reject(new Error('PNG encoding failed.'));
				}, type || 'image/png');
				return;
			}
			try {
				var dataUrl = canvas.toDataURL(type || 'image/png');
				var binary = atob(dataUrl.split(',')[1]);
				var bytes = new Uint8Array(binary.length);
				for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
				resolve(new Blob([bytes], { type: type || 'image/png' }));
			} catch (err) {
				reject(err);
			}
		});
	}

	async function canvasToPngBytes(canvas) {
		var blob = await canvasToBlob(canvas, 'image/png');
		return new Uint8Array(await blob.arrayBuffer());
	}

	/* ------------------------------------------------------------------ *
	 * Writing PNGs
	 * ------------------------------------------------------------------ */

	/**
	 * How many name variants to try before giving up.
	 *
	 * The search stops at the first free name, so this only bounds the
	 * pathological case of a folder holding a thousand identical exports.
	 */
	var MAX_NAME_ATTEMPTS = 1000;

	/** True for the errors that mean "something is already at this path". */
	function pathIsTaken(err) {
		var code = err && err.code;
		return code === 'EEXIST' || code === 'EISDIR';
	}

	/**
	 * The nth name to try for an export: the requested one first, then
	 * "brush (2).png", "brush (3).png", … The extension stays put.
	 */
	function candidateFileName(fileName, attempt) {
		if (attempt <= 1) return fileName;

		var dot = fileName.lastIndexOf('.');
		if (dot <= 0) return fileName + ' (' + attempt + ')';
		return fileName.slice(0, dot) + ' (' + attempt + ')' + fileName.slice(dot);
	}

	/**
	 * Writes bytes into `directory` under a name that is not yet taken —
	 * and never replaces a file that is already there.
	 *
	 * `writeFileSync` is called with the exclusive `wx` flag, so creating the
	 * file *fails* with EEXIST instead of truncating an existing one. That
	 * matters beyond convenience: a separate `existsSync` check followed by a
	 * plain write would leave a window in which another writer could create
	 * the file between the two calls, and the check would be worthless. Here
	 * the check and the create are a single atomic operation, so a collision
	 * is detected even if it happens mid-flight — the next candidate name is
	 * simply tried.
	 *
	 * @returns {{path: string, fileName: string, requestedFileName: string, renamed: boolean}}
	 */
	function writeFileWithoutReplacing(directory, requestedFileName, bytes) {
		if (!hasNode()) throw new Error('Filesystem access is unavailable.');

		for (var attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
			var fileName = candidateFileName(requestedFileName, attempt);
			var fullPath = path.join(directory, fileName);
			try {
				fs.writeFileSync(fullPath, bytes, { flag: 'wx' });
			} catch (err) {
				if (pathIsTaken(err)) continue;
				throw err;
			}
			return {
				path: fullPath,
				fileName: fileName,
				requestedFileName: requestedFileName,
				renamed: fileName !== requestedFileName
			};
		}

		throw new Error('Could not find an unused name for "' + requestedFileName + '" in that folder.');
	}

	/**
	 * Adds a rendered canvas to the Eagle library as a PNG.
	 *
	 * The file is staged in the temp directory and imported by path, which
	 * keeps large payloads out of the IPC channel. `addFromPath` resolves
	 * only once Eagle has taken the file, so the staged copy is removed
	 * immediately afterwards.
	 *
	 * Staging goes through the same non-replacing write as an export: the
	 * scratch copy is throwaway, but there is no reason for any write in the
	 * plugin to be destructive.
	 *
	 * @returns {Promise<{id: string|null, path: string}>}
	 */
	async function addCanvasToLibrary(canvas, options) {
		var api = eagle();
		if (!api || !api.item || typeof api.item.addFromPath !== 'function') {
			throw new Error('The Eagle item API is unavailable.');
		}
		if (!hasNode()) throw new Error('Filesystem access is unavailable.');

		var opts = options || {};
		var dir = ensureTempDir();
		var safeName = sanitizeName(opts.name);
		var stagingName = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + safeName + '.png';

		var bytes = await canvasToPngBytes(canvas);
		var filePath = writeFileWithoutReplacing(dir, stagingName, Buffer.from(bytes)).path;

		try {
			var payload = { name: safeName };
			if (opts.folders && opts.folders.length) payload.folders = opts.folders;
			if (opts.tags && opts.tags.length) payload.tags = opts.tags;
			if (opts.annotation) payload.annotation = opts.annotation;
			if (opts.website) payload.website = opts.website;

			var id = await api.item.addFromPath(filePath, payload);
			return { id: id || null, path: filePath };
		} finally {
			try {
				fs.rmSync(filePath, { force: true });
			} catch (err) { /* the start-up sweep will catch strays */ }
		}
	}

	/**
	 * Writes a canvas as a PNG into a real folder on disk.
	 *
	 * An existing file of the same name is never replaced. If the folder
	 * already holds `Soft Round.png`, this export lands beside it as
	 * `Soft Round (2).png` and the result says so, so the caller can tell the
	 * user which file it actually wrote rather than leaving them to guess.
	 *
	 * @returns {Promise<{path: string, fileName: string, requestedFileName: string, renamed: boolean}>}
	 */
	async function saveCanvasToFolder(canvas, directory, fileName) {
		if (!hasNode()) throw new Error('Filesystem access is unavailable.');
		var bytes = await canvasToPngBytes(canvas);
		return writeFileWithoutReplacing(directory, sanitizeName(fileName) + '.png', Buffer.from(bytes));
	}

	function showItemInFolder(fullPath) {
		var api = eagle();
		if (api && api.shell && typeof api.shell.showItemInFolder === 'function') {
			try {
				api.shell.showItemInFolder(fullPath);
			} catch (err) { /* ignore */ }
		}
	}

	/* ------------------------------------------------------------------ *
	 * Notifications, theme, window chrome
	 * ------------------------------------------------------------------ */

	function notify(title, body, kind) {
		var api = eagle();
		if (api && api.notification && typeof api.notification.show === 'function') {
			try {
				api.notification.show({
					title: String(title || 'BrushBox'),
					body: String(body || ''),
					duration: 2200
				});
				return;
			} catch (err) { /* fall through */ }
		}
		(kind === 'error' ? warn : log)(title + (body ? ' — ' + body : ''));
	}

	function theme() {
		var api = eagle();
		if (api && api.app && api.app.theme) {
			var name = String(api.app.theme).toUpperCase();
			if (name === 'LIGHT' || name === 'LIGHTGRAY') return 'light';
			if (name) return 'dark';
		}
		try {
			if (api && api.app && typeof api.app.isDarkColors === 'function') {
				return api.app.isDarkColors() ? 'dark' : 'light';
			}
		} catch (err) { /* ignore */ }
		try {
			return global.matchMedia && global.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
		} catch (err) {
			return 'dark';
		}
	}

	function onThemeChanged(callback) {
		var api = eagle();
		if (api && typeof api.onThemeChanged === 'function') {
			try {
				api.onThemeChanged(function () { callback(theme()); });
			} catch (err) { /* ignore */ }
		}
	}

	function onPluginRun(callback) {
		var api = eagle();
		if (api && typeof api.onPluginRun === 'function') {
			try {
				api.onPluginRun(callback);
			} catch (err) { /* ignore */ }
		}
	}

	function onPluginCreate(callback) {
		var api = eagle();
		if (api && typeof api.onPluginCreate === 'function') {
			try {
				api.onPluginCreate(callback);
			} catch (err) { /* ignore */ }
		}
	}

	function minimize() {
		var api = eagle();
		if (api && api.window && typeof api.window.minimize === 'function') api.window.minimize();
	}

	async function toggleMaximize() {
		var api = eagle();
		if (!api || !api.window) return;
		try {
			var isMax = typeof api.window.isMaximized === 'function' ? await api.window.isMaximized() : false;
			if (isMax) {
				if (typeof api.window.unmaximize === 'function') api.window.unmaximize();
			} else if (typeof api.window.maximize === 'function') {
				api.window.maximize();
			}
		} catch (err) { /* ignore */ }
	}

	function closeWindow() {
		try {
			global.close();
		} catch (err) { /* fall through */ }
		var api = eagle();
		if (api && api.window && typeof api.window.hide === 'function') {
			try {
				api.window.hide();
			} catch (err) { /* ignore */ }
		}
	}

	function manifest() {
		var api = eagle();
		return (api && api.plugin && api.plugin.manifest) || {};
	}

	global.BrushBoxBridge = {
		available: available,
		hasNode: hasNode,
		fs: fs,
		path: path,
		log: log,
		warn: warn,
		error: error,

		ensureTempDir: ensureTempDir,
		sweepTempDir: sweepTempDir,
		isStagedName: isStagedName,
		readFileBytes: readFileBytes,
		fileSize: fileSize,
		baseName: baseName,
		stem: stem,
		sanitizeName: sanitizeName,
		pathKey: pathKey,
		fingerprint: fingerprint,
		classifySource: classifySource,
		filesFromDataTransfer: filesFromDataTransfer,

		chooseAbrFiles: chooseAbrFiles,
		chooseDirectory: chooseDirectory,
		confirm: confirm,

		getFolders: getFolders,
		getLibraryName: getLibraryName,
		getSelectedAbrFiles: getSelectedAbrFiles,
		selectItems: selectItems,

		canvasToBlob: canvasToBlob,
		canvasToPngBytes: canvasToPngBytes,
		addCanvasToLibrary: addCanvasToLibrary,
		writeFileWithoutReplacing: writeFileWithoutReplacing,
		candidateFileName: candidateFileName,
		saveCanvasToFolder: saveCanvasToFolder,
		showItemInFolder: showItemInFolder,

		notify: notify,
		theme: theme,
		onThemeChanged: onThemeChanged,
		onPluginRun: onPluginRun,
		onPluginCreate: onPluginCreate,

		minimize: minimize,
		toggleMaximize: toggleMaximize,
		closeWindow: closeWindow,
		manifest: manifest
	};
})(typeof window !== 'undefined' ? window : globalThis);
