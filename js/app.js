/*!
 * BrushBox — application controller
 * ---------------------------------------------------------------------
 * Owns all UI state and wires it to the parser, the renderer and the
 * Eagle bridge. Kept deliberately free of direct `eagle.*` calls: host
 * access always goes through BrushBoxBridge, so this file runs in a
 * plain browser too (useful for quick visual checks).
 */
(function () {
	'use strict';

	var bridge = window.BrushBoxBridge;
	var Abr = window.BrushBoxAbr;
	var Render = window.BrushBoxRender;

	/* ================================================================== *
	 * Constants
	 * ================================================================== */

	/** Neutral tint for thumbnails, derived from the active theme. */
	function thumbStyle() {
		var light = document.body.getAttribute('data-theme') === 'light';
		return light
			? { background: 'light', color: '#2b3040' }
			: { background: 'dark', color: '#e9ebf3' };
	}

	var PREVIEW_COLORS = [
		'#f4f5f8', '#12141b', '#ff9d6e', '#a78bfa',
		'#35e0c8', '#f5c542', '#f2698c', '#6ea8ff'
	];

	var BACKGROUNDS = ['dark', 'light', 'checker', 'transparent'];
	var BACKGROUND_LABELS = { dark: 'Dark', light: 'Light', checker: 'Checker', transparent: 'None' };

	/* ================================================================== *
	 * State
	 * ================================================================== */

	var state = {
		mode: 'single',
		sets: [],
		activeSetId: null,
		activeBrushIndex: 0,
		selected: Object.create(null),
		setCounter: 0,
		preview: {
			color: '#f4f5f8',
			size: 320,
			native: false,
			render: 'dab',
			spacing: 25,
			brushSpacing: true,
			angle: 0,
			background: 'dark'
		},
		output: {
			scale: '2',
			// Defaults to the same dark tile the stage shows. The default brush
			// colour is near-white, so a transparent background would export a
			// white brush that vanishes against Eagle's light library view —
			// the imported items would look blank.
			background: 'dark',
			tags: '',
			folderId: '',
			padding: 0.08
		},
		busy: false
	};

	var ui = {};
	var thumbQueue = [];
	var thumbPumpScheduled = false;
	var resizeTimer = null;
	var booted = false;

	/* ================================================================== *
	 * DOM helpers
	 * ================================================================== */

	function $(id) {
		return document.getElementById(id);
	}

	function make(tag, className, text) {
		var node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	/** Inline SVG built from path data, matching the icon set in index.html. */
	function icon(paths) {
		var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		paths.forEach(function (d) {
			var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', d);
			svg.appendChild(path);
		});
		return svg;
	}

	function clamp(v, lo, hi) {
		return v < lo ? lo : v > hi ? hi : v;
	}

	/* ================================================================== *
	 * Derived accessors
	 * ================================================================== */

	function allBrushes() {
		var out = [];
		state.sets.forEach(function (set) {
			if (set.parsed) {
				set.parsed.brushes.forEach(function (brush, index) {
					out.push({ set: set, brush: brush, index: index, key: set.id + ':' + index });
				});
			}
		});
		return out;
	}

	function activeSet() {
		for (var i = 0; i < state.sets.length; i++) {
			if (state.sets[i].id === state.activeSetId) return state.sets[i];
		}
		return null;
	}

	function activeBrush() {
		var set = activeSet();
		if (!set || !set.parsed || !set.parsed.brushes.length) return null;
		return set.parsed.brushes[clamp(state.activeBrushIndex, 0, set.parsed.brushes.length - 1)] || null;
	}

	function selectedEntries() {
		return allBrushes().filter(function (entry) {
			return state.selected[entry.key];
		});
	}

	function totalBrushes() {
		return state.sets.reduce(function (sum, set) {
			return sum + (set.parsed ? set.parsed.brushes.length : 0);
		}, 0);
	}

	/* ================================================================== *
	 * Status, toasts, busy
	 * ================================================================== */

	function setStatus(message, kind) {
		ui.statusMsg.textContent = message;
		ui.statusMsg.className = 'status-msg' + (kind ? ' is-' + kind : '');
	}

	function toast(title, body, kind) {
		var node = make('div', 'toast is-' + (kind || 'info'));
		node.appendChild(make('div', 'toast-title', title));
		if (body) node.appendChild(make('div', 'toast-body', body));
		ui.toasts.appendChild(node);

		window.setTimeout(function () {
			node.classList.add('is-leaving');
			window.setTimeout(function () {
				if (node.parentNode) node.parentNode.removeChild(node);
			}, 200);
		}, kind === 'error' ? 6000 : 3400);
	}

	function setBusy(busy, message) {
		state.busy = busy;
		document.body.classList.toggle('is-busy', busy);
		if (busy) {
			ui.progress.hidden = false;
			ui.progressBar.style.width = '0%';
			if (message) setStatus(message);
		}
	}

	function setProgress(fraction) {
		ui.progressBar.style.width = clamp(fraction, 0, 1) * 100 + '%';
	}

	function endBusy(message, kind) {
		state.busy = false;
		document.body.classList.remove('is-busy');
		ui.progress.hidden = true;
		ui.progressBar.style.width = '0%';
		if (message) setStatus(message, kind);
	}

	/** Yields to the event loop so progress can paint between items. */
	function nextFrame() {
		return new Promise(function (resolve) {
			window.setTimeout(resolve, 0);
		});
	}

	/* ================================================================== *
	 * Theme + window chrome
	 * ================================================================== */

	function applyTheme(theme) {
		var next = theme || bridge.theme();
		var changed = document.body.getAttribute('data-theme') !== next;
		document.body.setAttribute('data-theme', next);

		// Thumbnails bake their backdrop in, so a theme flip has to redraw
		// them. Guarded so this stays a no-op during start-up.
		if (changed && booted) {
			rebuildFilmstrip();
			rebuildBatchGrid();
		}
	}

	/* ================================================================== *
	 * Loading files
	 * ================================================================== */

	/** Drops a set without touching the UI, for replacing a changed file. */
	function forgetSet(id) {
		state.sets = state.sets.filter(function (set) {
			return set.id !== id;
		});
		Object.keys(state.selected).forEach(function (key) {
			if (key.indexOf(id + ':') === 0) delete state.selected[key];
		});
	}

	/**
	 * Adds one or more sources to the library view.
	 *
	 * Re-loading something already open is a no-op that focuses the
	 * existing set, so repeatedly pressing "From selection" cannot pile up
	 * duplicate copies of the same brush set.
	 *
	 * @param {Array<{name: string, bytes?: Uint8Array, path?: string, size?: number}>} sources
	 */
	async function addSources(sources) {
		var added = 0;
		var reloaded = 0;
		var duplicates = [];
		var problems = [];
		var firstNewId = null;

		for (var i = 0; i < sources.length; i++) {
			var source = sources[i];
			if (!source) continue;

			if (source.skipped) {
				problems.push(source.name + ': ' + source.skipped);
				continue;
			}

			var bytes = source.bytes;
			if (!bytes && source.path) {
				try {
					bytes = bridge.readFileBytes(source.path);
				} catch (err) {
					problems.push(source.name + ': ' + err.message);
					continue;
				}
			}
			if (!bytes || !bytes.byteLength) {
				problems.push(source.name + ': the file could not be read.');
				continue;
			}

			var fileName = source.name || (source.path ? bridge.baseName(source.path) : 'brushes.abr');
			var stem = bridge.stem(fileName);
			var contentKey = bridge.fingerprint(bytes);
			var sourcePathKey = bridge.pathKey(source.path);

			// Already open? Skip it. Same path but different bytes? The file
			// changed on disk, so drop the stale copy and re-read it.
			var verdict = bridge.classifySource(state.sets, contentKey, sourcePathKey);
			if (verdict.action === 'duplicate') {
				duplicates.push(verdict.set);
				continue;
			}
			if (verdict.action === 'replace') {
				forgetSet(verdict.set.id);
				reloaded++;
			}

			var parsed;
			try {
				parsed = Abr.parse(bytes, { name: stem });
			} catch (err) {
				parsed = null;
				problems.push(fileName + ': ' + err.message);
			}

			if (!parsed) continue;

			var record = {
				id: 'set-' + ++state.setCounter,
				name: stem,
				fileName: fileName,
				filePath: source.path || null,
				size: source.size || bytes.byteLength,
				fingerprint: contentKey,
				pathKey: sourcePathKey,
				parsed: parsed,
				error: parsed.ok ? null : (parsed.error || 'No brushes found.')
			};

			state.sets.push(record);

			if (parsed.ok) {
				parsed.brushes.forEach(function (brush, index) {
					state.selected[record.id + ':' + index] = true;
				});
				added++;
				if (!firstNewId) firstNewId = record.id;

				if (parsed.warnings.length) {
					parsed.warnings.slice(0, 2).forEach(function (warning) {
						console.warn('[brushbox] ' + fileName + ': ' + warning);
					});
				}
			} else {
				problems.push(fileName + ': ' + record.error);
			}
		}

		rebuildSetList();
		rebuildOutputTargets();

		// Focus something useful: the set just loaded, or — when everything
		// was already open — the one the user asked for again.
		var focusId = firstNewId || (duplicates.length ? duplicates[0].id : null);
		if (focusId) {
			selectSet(focusId);
		} else {
			refreshAll();
		}

		reportLoad(added, reloaded, duplicates, problems);
	}

	function reportLoad(added, reloaded, duplicates, problems) {
		var parts = [];
		if (added) parts.push('Loaded ' + added + ' brush set' + (added === 1 ? '' : 's'));
		if (reloaded) parts.push('reloaded ' + reloaded + ' changed');
		if (!added && !reloaded && duplicates.length) parts.push('Already open');

		if (parts.length) {
			var suffix = duplicates.length && (added || reloaded)
				? '  ·  ' + duplicates.length + ' already open'
				: '';
			setStatus(parts.join(', ') + suffix, added || reloaded ? 'ok' : undefined);
		}

		if (duplicates.length && !added && !reloaded) {
			toast(
				duplicates.length === 1 ? 'Already open' : duplicates.length + ' sets already open',
				duplicates.length === 1
					? duplicates[0].fileName + ' is already loaded — switch to it above, or remove it first to reload.'
					: 'They are already in the list; nothing was added.',
				'info'
			);
		}

		if (problems.length) {
			toast(problems.length === 1 ? 'One file could not be opened' : problems.length + ' files could not be opened',
				problems.slice(0, 3).join(' · '), 'error');
			if (!added && !reloaded) setStatus(problems[0], 'error');
		}
	}

	async function openViaDialog() {
		var files = await bridge.chooseAbrFiles();

		// No native dialog (e.g. running outside Eagle): use the browser picker.
		if (files === null) {
			ui.fileInput.click();
			return;
		}
		if (!files.length) return;

		await addSources(files.map(function (file) {
			return { name: file.name, path: file.path, size: file.size };
		}));
	}

	async function openFromEagleSelection() {
		var files = await bridge.getSelectedAbrFiles();
		if (!files.length) {
			toast('Nothing to open', 'Select one or more .abr files in Eagle first, then try again.', 'info');
			return;
		}
		await addSources(files.map(function (file) {
			return { name: file.name, path: file.path, size: file.size };
		}));
	}

	function readInputFiles(fileList) {
		var pending = [];
		for (var i = 0; i < fileList.length; i++) {
			pending.push(readOneFile(fileList[i]));
		}
		return Promise.all(pending);
	}

	function readOneFile(file) {
		return new Promise(function (resolve) {
			var reader = new FileReader();
			reader.onload = function () {
				resolve({ name: file.name, bytes: new Uint8Array(reader.result) });
			};
			reader.onerror = function () {
				resolve({ name: file.name, skipped: 'the file could not be read' });
			};
			reader.readAsArrayBuffer(file);
		});
	}

	/* ================================================================== *
	 * Set list
	 * ================================================================== */

	function rebuildSetList() {
		ui.setList.innerHTML = '';

		if (!state.sets.length) {
			ui.setEmpty.hidden = false;
			ui.setEmpty.textContent = 'Loaded sets appear here.';
			ui.setCount.textContent = 'none';
			return;
		}

		ui.setEmpty.hidden = true;
		ui.setCount.textContent = state.sets.length + (state.sets.length === 1 ? ' set' : ' sets');

		state.sets.forEach(function (set) {
			var item = make('li', 'set-item' + (set.id === state.activeSetId ? ' is-active' : '') +
				(!set.parsed || !set.parsed.ok ? ' is-error' : ''));

			item.appendChild(make('span', 'set-dot'));

			var body = make('div', 'set-body');
			body.appendChild(make('span', 'set-name', set.name));

			var meta;
			if (set.parsed && set.parsed.ok) {
				meta = set.parsed.brushes.length + ' brush' + (set.parsed.brushes.length === 1 ? '' : 'es') +
					'  ·  v' + set.parsed.version;
			} else {
				meta = set.error || 'Unreadable';
			}
			body.appendChild(make('span', 'set-meta' + (set.parsed && set.parsed.ok ? '' : ' is-error'), meta));
			item.appendChild(body);

			var remove = make('button', 'set-remove');
			remove.type = 'button';
			remove.title = 'Remove this set';
			remove.setAttribute('aria-label', 'Remove ' + set.name);
			remove.appendChild(icon(['M4 4l16 16', 'M20 4L4 20']));
			remove.addEventListener('click', function (event) {
				event.stopPropagation();
				removeSet(set.id);
			});
			item.appendChild(remove);

			item.addEventListener('click', function () {
				selectSet(set.id);
			});

			ui.setList.appendChild(item);
		});
	}

	function removeSet(id) {
		forgetSet(id);

		if (state.activeSetId === id) {
			var next = state.sets.filter(function (set) {
				return set.parsed && set.parsed.ok;
			})[0];
			state.activeSetId = next ? next.id : null;
			state.activeBrushIndex = 0;
		}

		rebuildSetList();
		refreshAll();
	}

	function clearAll() {
		state.sets = [];
		state.selected = Object.create(null);
		state.activeSetId = null;
		state.activeBrushIndex = 0;
		Render.clearCache();
		rebuildSetList();
		refreshAll();
		setStatus('Cleared');
	}

	/* ================================================================== *
	 * Selection
	 * ================================================================== */

	function selectSet(id) {
		state.activeSetId = id;
		state.activeBrushIndex = 0;
		rebuildSetList();
		refreshAll();
	}

	function selectBrush(index) {
		var set = activeSet();
		if (!set || !set.parsed || !set.parsed.brushes.length) return;

		var count = set.parsed.brushes.length;
		state.activeBrushIndex = ((index % count) + count) % count;

		var brush = activeBrush();
		if (brush) {
			state.preview.angle = Math.round(brush.angle || 0);
			ui.rangeAngle.value = String(state.preview.angle);
			ui.outAngle.textContent = state.preview.angle + '°';

			if (state.preview.brushSpacing && brush.spacing) {
				state.preview.spacing = Math.round(clamp(brush.spacing, 0.01, 2) * 100);
				ui.rangeSpacing.value = String(state.preview.spacing);
				ui.outSpacing.textContent = state.preview.spacing + '%';
			}

			if (state.preview.native) {
				state.preview.size = clamp(Math.round(Render.naturalSize(brush)), 16, 900);
			}
		}

		refreshStage();
		refreshFilmstripSelection();
		refreshInspector();
		ui.stageIndex.textContent = (state.activeBrushIndex + 1) + ' / ' + count;
	}

	/* ================================================================== *
	 * Refresh orchestration
	 * ================================================================== */

	function refreshAll() {
		rebuildFilmstrip();
		rebuildBatchGrid();
		refreshStage();
		refreshInspector();
		refreshBatchSummary();
		refreshStatus();
		flushPendingThumbs();
	}

	function refreshStatus() {
		ui.statusSets.textContent = state.sets.length + (state.sets.length === 1 ? ' set' : ' sets');
		ui.statusBrushes.textContent = totalBrushes() + ' brushes';
	}

	/* ================================================================== *
	 * Stage
	 * ================================================================== */

	function refreshStage() {
		var brush = activeBrush();

		if (!brush) {
			ui.stageEmpty.hidden = false;
			ui.stageCanvas.hidden = true;
			ui.stageBrushName.textContent = state.sets.length ? 'No brushes in this set' : 'No brush loaded';
			ui.stageBrushSrc.textContent = state.sets.length && activeSet() ? activeSet().fileName : '';
			ui.filmstripHint.textContent = '—';
			ui.stageIndex.textContent = '–';
			return;
		}

		ui.stageEmpty.hidden = true;
		ui.stageCanvas.hidden = false;

		var set = activeSet();
		ui.stageBrushName.textContent = brush.name;
		ui.stageBrushSrc.textContent = set.fileName + '  ·  ' + brushLabel(brush) +
			'  ·  ' + Render.naturalSize(brush) + ' px';
		ui.filmstripHint.textContent = (state.activeBrushIndex + 1) + ' of ' + set.parsed.brushes.length;
		ui.stageIndex.textContent = (state.activeBrushIndex + 1) + ' / ' + set.parsed.brushes.length;

		layoutStage();
	}

	function layoutStage() {
		if (state.mode !== 'single') return;
		var brush = activeBrush();
		if (!brush) return;

		var box = ui.stage.getBoundingClientRect();
		var availableW = Math.max(120, box.width - 44);
		var availableH = Math.max(120, box.height - 44);

		var mode = state.preview.render;
		// Aspect is width ÷ height: a stroke and a size ramp need a wide
		// canvas, a single dab is square.
		var aspect = mode === 'dab' ? 1 : (mode === 'stroke' ? 2.1 : 2.5);

		var cssW;
		var cssH;
		if (availableW / availableH > aspect) {
			cssH = availableH;
			cssW = availableH * aspect;
		} else {
			cssW = availableW;
			cssH = availableW / aspect;
		}

		// A stroke must fit inside the (much shorter) stroke canvas, and a
		// dab filling half the height would overlap into a blob instead of
		// reading as a stroke.
		var size = state.preview.size;
		if (mode === 'stroke') size = Math.min(size, cssH * 0.5);
		// 'grid' sizes its own dabs from the canvas, so no clamp is needed here.

		Render.renderStage(ui.stageCanvas, brush, {
			cssWidth: cssW,
			cssHeight: cssH,
			dpr: window.devicePixelRatio || 1,
			mode: mode,
			size: size,
			color: state.preview.color,
			background: state.preview.background,
			spacing: state.preview.spacing / 100,
			brushSpacing: state.preview.brushSpacing,
			angle: state.preview.angle
		});
	}

	/**
	 * Short label for the stage subtitle.
	 *
	 * A sampled brush whose bitmap failed to attach is called out explicitly:
	 * otherwise the label falls through to a bare "sampled", which reads like
	 * a working brush when it is the one thing you need to notice.
	 */
	function brushLabel(brush) {
		if (brush.mask) return 'sampled tip';
		if (brush.kind === 'sampled') return 'sampled tip MISSING';
		if (brush.kind === 'computed') return 'computed tip';
		if (brush.kind === 'dynamic') return 'bristle tip';
		if (brush.kind === 'tips') return 'erodible tip';
		return brush.kind;
	}

	/** Inspector wording for the same distinction. */
	function brushKindLabel(brush) {
		if (brush.mask) return 'Sampled bitmap';
		if (brush.kind === 'sampled') return 'Sampled — no bitmap found';
		if (brush.kind === 'computed') return 'Computed shape';
		if (brush.kind === 'dynamic') return 'Bristle tip';
		if (brush.kind === 'tips') return 'Erodible tip';
		return brush.kind;
	}

	/* ================================================================== *
	 * Lazy thumbnails
	 * ================================================================== */

	var THUMBS_PER_SLICE = 12;

	/**
	 * Drops queued thumbnails belonging to one container.
	 *
	 * Deliberately scoped: rebuilding the batch grid must not discard the
	 * filmstrip's pending work (and vice versa), which is what a blunt
	 * "clear the queue" would do — the two are rebuilt back to back.
	 */
	function resetThumbQueue(group) {
		if (!group) {
			thumbQueue = [];
			return;
		}
		thumbQueue = thumbQueue.filter(function (entry) {
			return entry.group !== group;
		});
	}

	/**
	 * Queues a thumbnail to be painted off the critical path.
	 *
	 * A set can hold hundreds of brushes, so painting them all up front
	 * would stall the window. Work is drained in small slices on idle
	 * instead, which — unlike an IntersectionObserver — needs no layout
	 * box, so a grid built while its view is hidden still fills in once
	 * the view is revealed.
	 */
	function lazyThumb(node, paint, group) {
		thumbQueue.push({ node: node, paint: paint, group: group });
		scheduleThumbPump();
	}

	function scheduleThumbPump() {
		if (thumbPumpScheduled) return;
		thumbPumpScheduled = true;

		var run = function () {
			thumbPumpScheduled = false;
			pumpThumbs();
		};

		if (typeof window.requestIdleCallback === 'function') {
			window.requestIdleCallback(run, { timeout: 200 });
		} else {
			window.setTimeout(run, 16);
		}
	}

	function pumpThumbs() {
		var deferred = [];
		var painted = 0;
		var budget = THUMBS_PER_SLICE;

		while (thumbQueue.length && painted < budget) {
			var entry = thumbQueue.shift();
			if (!entry.node.isConnected) continue;

			// No layout box means the view is hidden; painting now would
			// bake a wrongly-sized bitmap, so it waits for the next flush.
			if (!entry.node.clientWidth || !entry.node.clientHeight) {
				deferred.push(entry);
				continue;
			}

			entry.paint();
			painted++;
		}

		thumbQueue = deferred.concat(thumbQueue);

		// Only keep pumping while progress is being made; a fully deferred
		// queue is woken by flushPendingThumbs() when the view appears.
		if (painted > 0 && thumbQueue.length) scheduleThumbPump();
	}

	/** Resumes painting for thumbnails whose view was hidden when queued. */
	function flushPendingThumbs() {
		if (thumbQueue.length) scheduleThumbPump();
	}

	/* ================================================================== *
	 * Filmstrip
	 * ================================================================== */

	function rebuildFilmstrip() {
		resetThumbQueue('filmstrip');
		ui.filmstrip.innerHTML = '';

		var set = activeSet();
		if (!set || !set.parsed || !set.parsed.brushes.length) return;

		var fragment = document.createDocumentFragment();

		set.parsed.brushes.forEach(function (brush, index) {
			var item = make('button', 'strip-item');
			item.type = 'button';
			item.title = brush.name + ' — ' + Render.naturalSize(brush) + ' px';

			var canvas = make('canvas', 'strip-thumb');
			item.appendChild(canvas);
			item.appendChild(make('span', 'strip-label', brush.name));

			lazyThumb(canvas, function () {
				var style = thumbStyle();
				Render.renderThumb(canvas, brush, {
					dpr: 2, color: style.color, background: style.background, fill: 0.8
				});
			}, 'filmstrip');

			item.addEventListener('click', function () {
				selectBrush(index);
			});

			fragment.appendChild(item);
		});

		ui.filmstrip.appendChild(fragment);
		refreshFilmstripSelection();
	}

	function refreshFilmstripSelection() {
		var items = ui.filmstrip.children;
		for (var i = 0; i < items.length; i++) {
			items[i].classList.toggle('is-active', i === state.activeBrushIndex);
		}
	}

	/* ================================================================== *
	 * Batch grid
	 * ================================================================== */

	function rebuildBatchGrid() {
		resetThumbQueue('batch');
		ui.batchGrid.innerHTML = '';

		var entries = allBrushes();
		ui.batchEmpty.hidden = entries.length > 0;

		if (!entries.length) {
			refreshBatchCount();
			return;
		}

		var fragment = document.createDocumentFragment();

		entries.forEach(function (entry) {
			var card = make('div', 'batch-card');
			card.dataset.key = entry.key;
			card.classList.toggle('is-selected', !!state.selected[entry.key]);

			var check = make('span', 'batch-check');
			check.appendChild(icon(['M5 12.5l4.5 4.5L19 7.5']));
			card.appendChild(check);

			card.appendChild(make('span', 'batch-badge', entry.brush.mask ? 'Tip' : 'Computed'));

			var canvas = make('canvas', 'batch-thumb');
			card.appendChild(canvas);

			var meta = make('div', 'batch-meta');
			meta.appendChild(make('div', 'batch-name', entry.brush.name));
			meta.appendChild(make('div', 'batch-sub',
				Render.naturalSize(entry.brush) + ' px  ·  ' + Math.round((entry.brush.spacing || 0) * 100) + '%'));
			card.appendChild(meta);

			lazyThumb(canvas, function () {
				var style = thumbStyle();
				Render.renderThumb(canvas, entry.brush, {
					dpr: 2, color: style.color, background: style.background, fill: 0.8
				});
			}, 'batch');

			card.addEventListener('click', function (event) {
				if (event.detail > 1) return;
				toggleSelected(entry.key);
				card.classList.toggle('is-selected', !!state.selected[entry.key]);
			});

			card.addEventListener('dblclick', function () {
				state.mode = 'single';
				syncMode();
				selectSet(entry.set.id);
				selectBrush(entry.index);
			});

			fragment.appendChild(card);
		});

		ui.batchGrid.appendChild(fragment);
		refreshBatchCount();
	}

	function toggleSelected(key) {
		if (state.selected[key]) delete state.selected[key];
		else state.selected[key] = true;
		refreshBatchCount();
		refreshBatchSummary();
	}

	function setAllSelected(value) {
		allBrushes().forEach(function (entry) {
			if (value) state.selected[entry.key] = true;
			else delete state.selected[entry.key];
		});
		syncBatchSelection();
	}

	function invertSelection() {
		allBrushes().forEach(function (entry) {
			if (state.selected[entry.key]) delete state.selected[entry.key];
			else state.selected[entry.key] = true;
		});
		syncBatchSelection();
	}

	function syncBatchSelection() {
		var cards = ui.batchGrid.children;
		for (var i = 0; i < cards.length; i++) {
			cards[i].classList.toggle('is-selected', !!state.selected[cards[i].dataset.key]);
		}
		refreshBatchCount();
		refreshBatchSummary();
	}

	function refreshBatchCount() {
		var count = selectedEntries().length;
		var total = totalBrushes();
		ui.batchCount.textContent = count + ' of ' + total + ' selected';
		ui.btnImportSelected.disabled = count === 0;
		ui.btnContactSheet.disabled = count === 0;
	}

	function refreshBatchSummary() {
		ui.batchSets.textContent = state.sets.length + (state.sets.length === 1 ? ' set' : ' sets');
		ui.batchSummary.innerHTML = '';

		var entries = selectedEntries();
		var sampled = entries.filter(function (e) { return !!e.brush.mask; }).length;

		addDetail(ui.batchSummary, 'Selected', String(entries.length));
		addDetail(ui.batchSummary, 'With tip bitmap', String(sampled));
		addDetail(ui.batchSummary, 'Tile size', tileSizeLabel(state.output.scale));

		var folder = currentFolderName();
		addDetail(ui.batchSummary, 'Eagle folder', folder || '—', true);

		var tags = parsedTags();
		addDetail(ui.batchSummary, 'Tags', tags.length ? tags.join(', ') : '—', true);
	}

	function tileSizeLabel(scale) {
		if (scale === 'fixed512') return '512 px fixed';
		if (scale === 'fixed1024') return '1024 px fixed';
		return scale + '× native';
	}

	/* ================================================================== *
	 * Inspector
	 * ================================================================== */

	function refreshInspector() {
		var brush = activeBrush();
		ui.details.innerHTML = '';

		if (!brush) {
			ui.detailsEmpty.hidden = false;
			ui.detailKind.textContent = '—';
			return;
		}

		ui.detailsEmpty.hidden = true;
		ui.detailKind.textContent = brushLabel(brush);

		addDetail(ui.details, 'Name', brush.name, true);
		addDetail(ui.details, 'Kind', brushKindLabel(brush), true);
		addDetail(ui.details, 'Native size', Render.naturalSize(brush) + ' px');
		addDetail(ui.details, 'Stored diameter', Math.round(brush.diameter) + ' px');
		addDetail(ui.details, 'Spacing', Math.round((brush.spacing || 0) * 100) + '%' + (brush.spacingOn ? '' : ' (off)'));
		addDetail(ui.details, 'Angle', Math.round(brush.angle || 0) + '°');
		addDetail(ui.details, 'Roundness', Math.round((brush.roundness == null ? 1 : brush.roundness) * 100) + '%');

		if (brush.hardness != null) {
			addDetail(ui.details, 'Hardness', Math.round(brush.hardness * 100) + '%');
			addBar(ui.details, brush.hardness);
		}

		if (brush.mask) {
			// Report the tip's real size, not the downscaled stored bitmap.
			var tipW = brush.mask.sourceWidth || brush.mask.width;
			var tipH = brush.mask.sourceHeight || brush.mask.height;
			addDetail(ui.details, 'Bitmap', tipW + ' × ' + tipH);
		}

		var flips = [];
		if (brush.flipX) flips.push('X');
		if (brush.flipY) flips.push('Y');
		if (flips.length) addDetail(ui.details, 'Flipped', flips.join(' + '));

		if (brush.shapeDynamics) {
			var dyn = brush.shapeDynamics;
			var parts = [];
			if (dyn.sizeDynamics && dyn.sizeDynamics.control !== 'off') parts.push('size ' + dyn.sizeDynamics.control);
			if (dyn.angleDynamics && dyn.angleDynamics.control !== 'off') parts.push('angle ' + dyn.angleDynamics.control);
			if (dyn.roundnessDynamics && dyn.roundnessDynamics.control !== 'off') parts.push('round ' + dyn.roundnessDynamics.control);
			if (parts.length) addDetail(ui.details, 'Dynamics', parts.join(', '), true);
		}

		if (brush.scatter) addDetail(ui.details, 'Scatter', brush.scatter.count + ' tips', true);
		if (brush.texture) addDetail(ui.details, 'Texture', brush.texture.name || 'yes', true);
		if (brush.dualBrush) addDetail(ui.details, 'Dual brush', brush.dualBrush.shape.type || 'yes', true);

		var extras = [];
		if (brush.wetEdges) extras.push('wet edges');
		if (brush.noise) extras.push('noise');
		if (extras.length) addDetail(ui.details, 'Options', extras.join(', '), true);

		var set = activeSet();
		if (set) addDetail(ui.details, 'Set', set.fileName, true);

		var warnings = (set && set.parsed ? set.parsed.warnings : []).concat(brush.warnings || []);
		if (warnings.length) addDetail(ui.details, 'Notes', warnings[0], true);
	}

	function addDetail(list, label, value, isText) {
		list.appendChild(make('dt', null, label));
		list.appendChild(make('dd', isText ? 'is-text' : null, value));
	}

	function addBar(list, fraction) {
		var bar = make('div', 'detail-bar');
		var fill = make('span');
		fill.style.width = clamp(fraction, 0, 1) * 100 + '%';
		bar.appendChild(fill);
		list.appendChild(bar);
	}

	/* ================================================================== *
	 * Output targets
	 * ================================================================== */

	var folderMap = Object.create(null);

	function currentFolderName() {
		return state.output.folderId ? (folderMap[state.output.folderId] || state.output.folderId) : '';
	}

	function parsedTags() {
		return state.output.tags
			.split(',')
			.map(function (tag) { return tag.trim(); })
			.filter(Boolean);
	}

	function flattenFolders(folders, depth, out) {
		folders.forEach(function (folder) {
			if (!folder || !folder.id) return;
			var label = (depth ? '　'.repeat(depth) + '└ ' : '') + (folder.name || folder.id);
			folderMap[folder.id] = folder.name || folder.id;
			out.push({ id: folder.id, label: label });
			if (Array.isArray(folder.children) && folder.children.length) {
				flattenFolders(folder.children, depth + 1, out);
			}
		});
		return out;
	}

	async function rebuildOutputTargets() {
		var select = ui.selectFolder;
		var previous = state.output.folderId;
		select.innerHTML = '';

		var none = document.createElement('option');
		none.value = '';
		none.textContent = '— none —';
		select.appendChild(none);

		var folders = await bridge.getFolders();
		var flat = flattenFolders(folders || [], 0, []);

		flat.forEach(function (entry) {
			var option = document.createElement('option');
			option.value = entry.id;
			option.textContent = entry.label;
			select.appendChild(option);
		});

		if (previous && folderMap[previous]) select.value = previous;
		else state.output.folderId = '';
	}

	/* ================================================================== *
	 * Export + import
	 * ================================================================== */

	function buildAnnotation(entry) {
		var brush = entry.brush;
		var bits = [entry.set.fileName];
		bits.push(Render.naturalSize(brush) + ' px');
		if (brush.spacing) bits.push('spacing ' + Math.round(brush.spacing * 100) + '%');
		if (brush.hardness != null) bits.push('hardness ' + Math.round(brush.hardness * 100) + '%');
		if (brush.mask) bits.push('sampled tip');
		return bits.join(' · ');
	}

	/** Imports every selected brush into the Eagle library as its own PNG. */
	async function importSelected() {
		if (state.busy) return;

		var entries = selectedEntries();
		if (!entries.length) {
			toast('Nothing selected', 'Tick at least one brush first.', 'info');
			return;
		}

		if (!bridge.available()) {
			toast('Eagle is not available', 'This build is running outside Eagle, so items cannot be added.', 'error');
			return;
		}
		if (!bridge.hasNode()) {
			toast('Filesystem unavailable', 'The plugin could not reach the filesystem to stage PNGs.', 'error');
			return;
		}

		// Importing several hundred items is slow and hard to undo by hand,
		// so confirm before committing to it.
		if (entries.length > 100) {
			var proceed = await bridge.confirm({
				title: 'Import ' + entries.length + ' brushes?',
				message: 'This adds ' + entries.length + ' PNG items to your Eagle library.',
				detail: 'Every brush becomes its own item. You can remove them afterwards from Eagle.',
				buttons: ['Cancel', 'Import'],
				defaultId: 1,
				cancelId: 0
			});
			if (!proceed) {
				setStatus('Import cancelled');
				return;
			}
		}

		setBusy(true, 'Rendering ' + entries.length + ' brushes…');

		var folderIds = state.output.folderId ? [state.output.folderId] : [];
		var tags = parsedTags();
		var ids = [];
		var failures = [];

		for (var i = 0; i < entries.length; i++) {
			var entry = entries[i];
			try {
				var canvas = Render.renderTile(entry.brush, {
					scale: state.output.scale,
					background: state.output.background,
					padding: state.output.padding,
					color: state.preview.color
				});

				var result = await bridge.addCanvasToLibrary(canvas, {
					name: entry.brush.name,
					folders: folderIds,
					tags: tags,
					annotation: buildAnnotation(entry)
				});
				if (result && result.id) ids.push(result.id);
			} catch (err) {
				failures.push(entry.brush.name + ': ' + err.message);
			}

			setProgress((i + 1) / entries.length);
			if (i % 4 === 0) await nextFrame();
		}

		endBusy();

		if (ids.length) {
			await bridge.selectItems(ids);
			toast('Imported ' + ids.length + ' brush' + (ids.length === 1 ? '' : 'es'),
				folderIds.length ? 'Added to ' + currentFolderName() + '.' : 'Added to the Eagle library.', 'ok');
			setStatus('Imported ' + ids.length + ' brush' + (ids.length === 1 ? '' : 'es') + ' into Eagle', 'ok');
		}

		if (failures.length) {
			toast(failures.length + ' brush' + (failures.length === 1 ? '' : 'es') + ' failed',
				failures.slice(0, 2).join(' · '), 'error');
			if (!ids.length) setStatus(failures[0], 'error');
		}
	}

	/** Saves the current preview as a PNG via the native save dialog. */
	async function exportCurrentPng() {
		var brush = activeBrush();
		if (!brush) {
			toast('No brush selected', 'Open a set and pick a brush first.', 'info');
			return;
		}
		if (!bridge.hasNode()) {
			toast('Filesystem unavailable', 'The plugin could not reach the filesystem.', 'error');
			return;
		}

		var directory = await bridge.chooseDirectory();
		if (!directory) return;

		try {
			var canvas = Render.renderTile(brush, {
				scale: state.output.scale,
				background: state.output.background,
				padding: state.output.padding,
				color: state.preview.color
			});
			var fullPath = await bridge.saveCanvasToFolder(canvas, directory, brush.name);
			toast('Saved', fullPath, 'ok');
			setStatus('Saved ' + brush.name + '.png', 'ok');
			bridge.showItemInFolder(fullPath);
		} catch (err) {
			toast('Could not save the PNG', err.message, 'error');
		}
	}

	/** Saves a single overview image containing every brush in the set. */
	async function exportContactSheet() {
		var entries = selectedEntries();
		if (!entries.length) {
			toast('Nothing selected', 'Tick at least one brush first.', 'info');
			return;
		}
		if (!bridge.hasNode()) {
			toast('Filesystem unavailable', 'The plugin could not reach the filesystem.', 'error');
			return;
		}

		var directory = await bridge.chooseDirectory();
		if (!directory) return;

		setBusy(true, 'Laying out the contact sheet…');
		await nextFrame();

		try {
			var setNames = {};
			entries.forEach(function (entry) { setNames[entry.set.name] = true; });
			var names = Object.keys(setNames);

			var canvas = Render.renderContactSheet(entries.map(function (entry) { return entry.brush; }), {
				title: names.length === 1 ? names[0] : 'BrushBox contact sheet',
				subtitle: entries.length + ' brushes from ' + names.length + ' set' + (names.length === 1 ? '' : 's'),
				background: state.output.background === 'transparent' ? 'dark' : state.output.background,
				color: state.preview.color,
				// The renderer picks the column count, so a large selection
				// stays inside its size ceiling instead of being cropped.
				cell: 200
			});

			var fullPath = await bridge.saveCanvasToFolder(canvas, directory,
				(names.length === 1 ? names[0] : 'brushbox') + '-contact-sheet');

			endBusy('Saved the contact sheet', 'ok');

			var sheet = canvas.sheetInfo;
			if (sheet && sheet.drawn < sheet.total) {
				toast('Contact sheet saved',
					'It fits ' + sheet.drawn + ' of ' + sheet.total + ' brushes at a readable size. ' +
					'Split the selection for the rest.', 'info');
			} else {
				toast('Contact sheet saved', fullPath, 'ok');
			}
			bridge.showItemInFolder(fullPath);
		} catch (err) {
			endBusy();
			toast('Could not build the contact sheet', err.message, 'error');
		}
	}

	/* ================================================================== *
	 * Mode handling
	 * ================================================================== */

	function syncMode() {
		document.body.setAttribute('data-mode', state.mode);
		ui.singleView.hidden = state.mode !== 'single';
		ui.batchView.hidden = state.mode !== 'batch';
		ui.panelBatch.hidden = state.mode !== 'batch';
		ui.panelPreview.hidden = state.mode !== 'single';

		Array.prototype.forEach.call(ui.segMode.children, function (button) {
			var active = button.dataset.value === state.mode;
			button.classList.toggle('is-active', active);
			button.setAttribute('aria-checked', active ? 'true' : 'false');
		});

		if (state.mode === 'single') {
			window.requestAnimationFrame(function () {
				layoutStage();
				flushPendingThumbs();
			});
		} else {
			window.requestAnimationFrame(flushPendingThumbs);
		}
	}

	/* ================================================================== *
	 * Preview controls
	 * ================================================================== */

	function buildSwatches() {
		ui.swatches.innerHTML = '';
		PREVIEW_COLORS.forEach(function (color) {
			var swatch = make('button', 'swatch');
			swatch.type = 'button';
			swatch.style.background = color;
			swatch.title = color;
			swatch.setAttribute('aria-label', 'Brush colour ' + color);
			swatch.classList.toggle('is-active', color.toLowerCase() === state.preview.color.toLowerCase());
			swatch.addEventListener('click', function () {
				setPreviewColor(color);
			});
			ui.swatches.appendChild(swatch);
		});
	}

	function setPreviewColor(color) {
		state.preview.color = color;
		ui.inputColor.value = color;
		ui.colorHex.textContent = color.toUpperCase();
		Array.prototype.forEach.call(ui.swatches.children, function (node) {
			node.classList.toggle('is-active', node.title.toLowerCase() === color.toLowerCase());
		});
		layoutStage();
	}

	function cycleBackground() {
		var index = BACKGROUNDS.indexOf(state.preview.background);
		state.preview.background = BACKGROUNDS[(index + 1) % BACKGROUNDS.length];
		ui.stageBgLabel.textContent = BACKGROUND_LABELS[state.preview.background];
		layoutStage();
	}

	/* ================================================================== *
	 * Wiring
	 * ================================================================== */

	function cacheElements() {
		[
			'segMode', 'chipLibrary', 'libraryName', 'btnMinimize', 'btnMaximize', 'btnClose',
			'dropZone', 'fileInput', 'btnOpenFiles', 'btnEagleSelection', 'setCount', 'setList', 'setEmpty',
			'rangePad', 'outPad', 'selectScale', 'selectBg', 'inputTags', 'selectFolder',
			'stageArea', 'singleView', 'stageBrushName', 'stageBrushSrc', 'btnPrevBrush', 'stageIndex',
			'btnNextBrush', 'btnFit', 'btnCycleBg', 'stageBgLabel', 'stage', 'stageEmpty', 'stageCanvas',
			'filmstripHint', 'filmstrip',
			'batchView', 'btnSelectAll', 'btnSelectNone', 'btnSelectInvert', 'batchCount',
			'btnContactSheet', 'btnImportSelected', 'batchGrid', 'batchEmpty',
			'inspector', 'panelPreview', 'swatches', 'inputColor', 'colorHex', 'rangeSize', 'outSize',
			'checkNative', 'segRender', 'fieldSpacing', 'rangeSpacing', 'outSpacing', 'checkBrushSpacing',
			'rangeAngle', 'outAngle',
			'panelDetails', 'detailKind', 'details', 'detailsEmpty', 'panelBatch', 'batchSets', 'batchSummary',
			'statusSets', 'statusBrushes', 'statusMsg', 'progress', 'progressBar',
			'toasts', 'dropOverlay'
		].forEach(function (id) {
			ui[id] = $(id);
		});
	}

	function wire() {
		wireWindowChrome();
		wireSources();
		wireSegments();
		wirePreview();
		wireOutput();
		wireBatch();
		wireKeyboard();
		wireDragAndDrop();
		wireResize();
	}

	function wireWindowChrome() {
		ui.btnMinimize.addEventListener('click', bridge.minimize);
		ui.btnMaximize.addEventListener('click', bridge.toggleMaximize);
		ui.btnClose.addEventListener('click', bridge.closeWindow);
	}

	function wireSources() {
		ui.dropZone.addEventListener('click', openViaDialog);
		ui.dropZone.addEventListener('keydown', function (event) {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				openViaDialog();
			}
		});

		ui.btnOpenFiles.addEventListener('click', openViaDialog);
		ui.btnEagleSelection.addEventListener('click', openFromEagleSelection);

		ui.fileInput.addEventListener('change', async function () {
			var files = ui.fileInput.files;
			if (!files || !files.length) return;
			await addSources(await readInputFiles(files));
			ui.fileInput.value = '';
		});
	}

	function wireSegments() {
		ui.segMode.addEventListener('click', function (event) {
			var button = event.target.closest('button[data-value]');
			if (!button) return;
			state.mode = button.dataset.value;
			syncMode();
		});

		ui.segRender.addEventListener('click', function (event) {
			var button = event.target.closest('button[data-value]');
			if (!button) return;
			state.preview.render = button.dataset.value;
			Array.prototype.forEach.call(ui.segRender.children, function (node) {
				var active = node.dataset.value === state.preview.render;
				node.classList.toggle('is-active', active);
				node.setAttribute('aria-checked', active ? 'true' : 'false');
			});
			ui.fieldSpacing.hidden = state.preview.render !== 'stroke';
			layoutStage();
		});
	}

	function wirePreview() {
		buildSwatches();
		ui.inputColor.value = state.preview.color;
		ui.colorHex.textContent = state.preview.color.toUpperCase();
		ui.stageBgLabel.textContent = BACKGROUND_LABELS[state.preview.background];
		ui.fieldSpacing.hidden = true;

		ui.inputColor.addEventListener('input', function () {
			setPreviewColor(ui.inputColor.value);
		});

		ui.rangeSize.addEventListener('input', function () {
			state.preview.size = Number(ui.rangeSize.value);
			ui.outSize.textContent = state.preview.size + ' px';
			layoutStage();
		});

		ui.checkNative.addEventListener('change', function () {
			state.preview.native = ui.checkNative.checked;
			ui.rangeSize.disabled = state.preview.native;

			if (state.preview.native) {
				var brush = activeBrush();
				if (brush) {
					state.preview.size = clamp(Math.round(Render.naturalSize(brush)), 16, 900);
					ui.rangeSize.value = String(state.preview.size);
					ui.outSize.textContent = state.preview.size + ' px';
				}
			}
			layoutStage();
		});

		ui.rangeSpacing.addEventListener('input', function () {
			state.preview.spacing = Number(ui.rangeSpacing.value);
			ui.outSpacing.textContent = state.preview.spacing + '%';
			if (state.preview.brushSpacing) {
				state.preview.brushSpacing = false;
				ui.checkBrushSpacing.checked = false;
			}
			layoutStage();
		});

		ui.checkBrushSpacing.addEventListener('change', function () {
			state.preview.brushSpacing = ui.checkBrushSpacing.checked;
			var brush = activeBrush();
			if (state.preview.brushSpacing && brush && brush.spacing) {
				state.preview.spacing = Math.round(clamp(brush.spacing, 0.01, 2) * 100);
				ui.rangeSpacing.value = String(state.preview.spacing);
				ui.outSpacing.textContent = state.preview.spacing + '%';
			}
			layoutStage();
		});

		ui.rangeAngle.addEventListener('input', function () {
			state.preview.angle = Number(ui.rangeAngle.value);
			ui.outAngle.textContent = state.preview.angle + '°';
			layoutStage();
		});

		ui.btnCycleBg.addEventListener('click', cycleBackground);
		ui.btnFit.addEventListener('click', function () {
			if (state.preview.native) {
				state.preview.native = false;
				ui.checkNative.checked = false;
				ui.rangeSize.disabled = false;
			}
			var box = ui.stage.getBoundingClientRect();
			state.preview.size = clamp(Math.round(Math.min(box.width, box.height) * 0.7), 16, 900);
			ui.rangeSize.value = String(state.preview.size);
			ui.outSize.textContent = state.preview.size + ' px';
			layoutStage();
		});

		ui.btnPrevBrush.addEventListener('click', function () {
			selectBrush(state.activeBrushIndex - 1);
		});
		ui.btnNextBrush.addEventListener('click', function () {
			selectBrush(state.activeBrushIndex + 1);
		});
	}

	function wireOutput() {
		ui.rangePad.addEventListener('input', function () {
			var percent = Number(ui.rangePad.value);
			state.output.padding = percent / 100;
			ui.outPad.textContent = percent + '%';
		});

		ui.selectScale.addEventListener('change', function () {
			state.output.scale = ui.selectScale.value;
			refreshBatchSummary();
		});

		ui.selectBg.addEventListener('change', function () {
			state.output.background = ui.selectBg.value;
		});

		ui.inputTags.addEventListener('input', function () {
			state.output.tags = ui.inputTags.value;
			refreshBatchSummary();
		});

		ui.selectFolder.addEventListener('change', function () {
			state.output.folderId = ui.selectFolder.value;
			refreshBatchSummary();
		});
	}

	function wireBatch() {
		ui.btnSelectAll.addEventListener('click', function () { setAllSelected(true); });
		ui.btnSelectNone.addEventListener('click', function () { setAllSelected(false); });
		ui.btnSelectInvert.addEventListener('click', invertSelection);
		ui.btnImportSelected.addEventListener('click', importSelected);
		ui.btnContactSheet.addEventListener('click', exportContactSheet);

		// In single mode the primary action exports the shown brush.
		document.addEventListener('keydown', function (event) {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
				event.preventDefault();
				exportCurrentPng();
			}
		});
	}

	function wireKeyboard() {
		window.addEventListener('keydown', function (event) {
			var tag = (event.target && event.target.tagName) || '';
			if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;

			// Step through brushes only in the single view. Arrow keys would
			// otherwise move a selection the user cannot see, so the brush
			// shown when they return is not the one they left on.
			if (state.mode === 'single' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
				event.preventDefault();
				selectBrush(state.activeBrushIndex + (event.key === 'ArrowRight' ? 1 : -1));
			} else if (event.key === 'Escape') {
				ui.dropOverlay.hidden = true;
			} else if (state.mode === 'single' && event.key.toLowerCase() === 'b') {
				cycleBackground();
			}
		});
	}

	function wireDragAndDrop() {
		var depth = 0;

		function hasFiles(event) {
			var types = event.dataTransfer && event.dataTransfer.types;
			if (!types) return false;
			for (var i = 0; i < types.length; i++) {
				if (types[i] === 'Files') return true;
			}
			return false;
		}

		window.addEventListener('dragenter', function (event) {
			if (!hasFiles(event)) return;
			event.preventDefault();
			depth++;
			ui.dropOverlay.hidden = false;
			ui.dropZone.classList.add('is-over');
		});

		window.addEventListener('dragover', function (event) {
			if (!hasFiles(event)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = 'copy';
		});

		window.addEventListener('dragleave', function (event) {
			if (!hasFiles(event)) return;
			depth = Math.max(0, depth - 1);
			if (depth === 0) {
				ui.dropOverlay.hidden = true;
				ui.dropZone.classList.remove('is-over');
			}
		});

		window.addEventListener('drop', async function (event) {
			if (!hasFiles(event)) return;
			event.preventDefault();
			depth = 0;
			ui.dropOverlay.hidden = true;
			ui.dropZone.classList.remove('is-over');

			var sources = await bridge.filesFromDataTransfer(event.dataTransfer);
			if (!sources.length) {
				toast('Nothing to open', 'Drop one or more .abr files.', 'info');
				return;
			}
			await addSources(sources);
		});
	}

	function wireResize() {
		window.addEventListener('resize', function () {
			window.clearTimeout(resizeTimer);
			resizeTimer = window.setTimeout(layoutStage, 110);
		});
	}

	/* ================================================================== *
	 * Boot
	 * ================================================================== */

	async function init() {
		cacheElements();
		wire();
		applyTheme();
		syncMode();

		bridge.onThemeChanged(applyTheme);

		// Reclaim anything a previous session left behind.
		bridge.sweepTempDir();

		bridge.getLibraryName().then(function (name) {
			ui.libraryName.textContent = name || 'Eagle';
			ui.chipLibrary.title = name ? 'Eagle library: ' + name : 'Eagle library';
		});

		rebuildOutputTargets();
		refreshAll();
		booted = true;

		if (!bridge.available()) {
			setStatus('Running outside Eagle — previews work, importing does not.', 'error');
		} else {
			setStatus('Ready');
		}

		bridge.onPluginRun(function () {
			// Eagle re-runs an already-open plugin window; nudge the layout
			// in case the window was resized while hidden.
			window.requestAnimationFrame(layoutStage);
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
