/*!
 * BrushBox — brush renderer
 * ---------------------------------------------------------------------
 * Turns a parsed brush into pixels.
 *
 * Two brush kinds reach this module:
 *
 *   computed — only shape parameters survive in the file (diameter,
 *              hardness, angle, roundness), so the dab is synthesised
 *              from a radial falloff curve.
 *   sampled  — the file carries a real bitmap mask, which is scaled,
 *              rotated and tinted here.
 *
 * Both kinds go through the same transform pipeline (rotation, roundness
 * squash, X/Y flip), so a sampled tip behaves like a Photoshop tip rather
 * than a bitmap pasted into a box.
 *
 * Everything is canvas 2D; there are no dependencies, and no pixel work
 * that is not proportional to the output size.
 */
(function (global) {
	'use strict';

	/** Hard ceiling on any generated bitmap, to keep memory bounded. */
	var MAX_DIM = 2048;

	/** Separate, larger ceiling for the contact sheet, which is a whole grid. */
	var SHEET_MAX = 8192;

	var FONT = '"Segoe UI", system-ui, -apple-system, Arial, sans-serif';

	/* ------------------------------------------------------------------ *
	 * Small helpers
	 * ------------------------------------------------------------------ */

	function clamp(v, lo, hi) {
		return v < lo ? lo : v > hi ? hi : v;
	}

	function clamp01(v) {
		return clamp(v, 0, 1);
	}

	function smoothstep(u) {
		return u * u * (3 - 2 * u);
	}

	function createCanvas(width, height) {
		var canvas = global.document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(width));
		canvas.height = Math.max(1, Math.round(height));
		return canvas;
	}

	function parseColor(hex) {
		var value = String(hex || '#ffffff').trim();
		var short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
		if (short) {
			return {
				r: parseInt(short[1] + short[1], 16),
				g: parseInt(short[2] + short[2], 16),
				b: parseInt(short[3] + short[3], 16)
			};
		}
		var full = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
		if (full) {
			return {
				r: parseInt(full[1], 16),
				g: parseInt(full[2], 16),
				b: parseInt(full[3], 16)
			};
		}
		return { r: 255, g: 255, b: 255 };
	}

	/* ------------------------------------------------------------------ *
	 * Brush geometry
	 * ------------------------------------------------------------------ */

	/**
	 * Tight bounding box of everything with meaningful coverage. Caching
	 * matters here: it is consulted for every thumbnail, and a mask is
	 * usually mostly untouched padding.
	 */
	function contentBounds(mask) {
		if (!mask || !mask.data || !mask.width || !mask.height) return null;
		if (mask._bounds !== undefined) return mask._bounds;

		var data = mask.data;
		var w = mask.width;
		var h = mask.height;
		var threshold = 2;
		var minY = h;
		var maxY = -1;

		// Rows first, then only the columns that can possibly matter.
		for (var y = 0; y < h; y++) {
			var base = y * w;
			for (var x = 0; x < w; x++) {
				if (data[base + x] > threshold) {
					if (y < minY) minY = y;
					maxY = y;
					break;
				}
			}
		}

		if (maxY < 0) {
			mask._bounds = null;
			return null;
		}

		var minX = w;
		var maxX = -1;
		for (var cx = 0; cx < w; cx++) {
			for (var cy = minY; cy <= maxY; cy++) {
				if (data[cy * w + cx] > threshold) {
					if (cx < minX) minX = cx;
					if (cx > maxX) maxX = cx;
					break;
				}
			}
		}

		var bounds = {
			left: minX,
			top: minY,
			right: maxX,
			bottom: maxY,
			width: maxX - minX + 1,
			height: maxY - minY + 1
		};
		mask._bounds = bounds;
		return bounds;
	}

	/** The brush's nominal size in pixels — its longest dimension. */
	function naturalSize(brush) {
		if (!brush) return 64;

		if (brush.mask && brush.mask.width && brush.mask.height) {
			var mask = brush.mask;
			// Oversized masks are stored downscaled, so map the stored
			// bounds back to the tip's real size.
			var scaleX = (mask.sourceWidth || mask.width) / mask.width;
			var scaleY = (mask.sourceHeight || mask.height) / mask.height;
			var bounds = contentBounds(mask);

			if (bounds) {
				return Math.max(1, Math.round(Math.max(bounds.width * scaleX, bounds.height * scaleY)));
			}
			return Math.max(1, Math.round(Math.max(mask.width * scaleX, mask.height * scaleY)));
		}

		return Math.max(1, Math.round(brush.diameter || 64));
	}

	/** Resolves the transform for a brush, allowing per-render overrides. */
	function brushTransform(brush, overrides) {
		var o = overrides || {};
		return {
			angle: o.angle == null ? (brush.angle || 0) : o.angle,
			roundness: o.roundness == null ? (brush.roundness == null ? 1 : brush.roundness) : o.roundness,
			flipX: o.flipX == null ? !!brush.flipX : !!o.flipX,
			flipY: o.flipY == null ? !!brush.flipY : !!o.flipY
		};
	}

	/* ------------------------------------------------------------------ *
	 * Mask construction
	 * ------------------------------------------------------------------ */

	/**
	 * Radial falloff matching Photoshop's hardness control: solid out to
	 * `hardness` of the radius, then an S-curve down to nothing.
	 */
	function falloff(t, hardness) {
		if (t >= 1) return 0;
		if (t <= 0) return 1;
		var h = clamp01(hardness);
		if (t <= h) return 1;
		return 1 - smoothstep((t - h) / (1 - h));
	}

	/**
	 * A white mask bitmap of the brush filling a `size` box, with the
	 * brush's rotation, roundness and flips applied.
	 */
	function buildMaskCanvas(brush, size, transform) {
		var t = transform || brushTransform(brush);
		var canvas = createCanvas(size, size);
		var ctx = canvas.getContext('2d');
		ctx.clearRect(0, 0, size, size);

		var radians = ((t.angle || 0) * Math.PI) / 180;
		var roundness = clamp(t.roundness == null ? 1 : t.roundness, 0.02, 1);
		var scaleX = t.flipX ? -1 : 1;
		var scaleY = (t.flipY ? -1 : 1) * roundness;

		ctx.save();
		ctx.translate(size / 2, size / 2);
		if (radians) ctx.rotate(radians);
		if (scaleX !== 1 || scaleY !== 1) ctx.scale(scaleX, scaleY);
		ctx.translate(-size / 2, -size / 2);

		if (brush.mask && brush.mask.data && brush.mask.width) {
			// A rotated square overflows its frame, so shrink just enough
			// to keep the whole tip visible.
			var fit = 1;
			if (radians) {
				fit = 1 / (Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians)));
			}
			drawSampledMask(ctx, brush, size, fit);
		} else {
			drawComputedMask(ctx, brush, size);
		}

		ctx.restore();
		return canvas;
	}

	function drawSampledMask(ctx, brush, size, fit) {
		var mask = brush.mask;
		var bounds = contentBounds(mask) || { left: 0, top: 0, width: mask.width, height: mask.height };

		// Materialise the mask once (grey -> white + alpha), then let
		// drawImage scale it; that beats a JS resample by a wide margin.
		if (!mask._canvas) {
			var src = createCanvas(mask.width, mask.height);
			var srcCtx = src.getContext('2d');
			var image = srcCtx.createImageData(mask.width, mask.height);
			var out = image.data;
			var data = mask.data;
			for (var i = 0, p = 0; i < data.length; i++, p += 4) {
				out[p] = 255;
				out[p + 1] = 255;
				out[p + 2] = 255;
				out[p + 3] = data[i];
			}
			srcCtx.putImageData(image, 0, 0);
			mask._canvas = src;
		}

		var scale = (size / Math.max(bounds.width, bounds.height)) * (fit == null ? 1 : fit);
		var dw = bounds.width * scale;
		var dh = bounds.height * scale;

		ctx.imageSmoothingEnabled = true;
		if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(
			mask._canvas,
			bounds.left, bounds.top, bounds.width, bounds.height,
			(size - dw) / 2, (size - dh) / 2, dw, dh
		);
	}

	function drawComputedMask(ctx, brush, size) {
		var radius = size / 2;
		var hardness = brush.hardness == null ? 0.75 : clamp01(brush.hardness);

		var gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, radius);
		// 24 stops is plenty for a smooth ramp and keeps the object cheap.
		var steps = 24;
		for (var s = 0; s <= steps; s++) {
			var t = s / steps;
			gradient.addColorStop(t, 'rgba(255,255,255,' + falloff(t, hardness).toFixed(4) + ')');
		}

		ctx.fillStyle = gradient;
		ctx.beginPath();
		ctx.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
		ctx.fill();
	}

	/* ------------------------------------------------------------------ *
	 * Cached, colourised dabs
	 * ------------------------------------------------------------------ */

	var dabCache = new Map();
	var dabCachePixels = 0;

	/**
	 * Cache budget in pixels, not entries.
	 *
	 * A count-based limit is unsafe here: dabs range from a 16px thumbnail to
	 * a 1024px export tile, so "256 entries" could mean 4MB or 1GB of RGBA.
	 * Budgeting by area keeps memory flat whatever the tile size, which
	 * matters when a batch import renders hundreds of brushes in a row.
	 * 24 megapixels is roughly 96MB.
	 */
	var DAB_CACHE_PIXEL_BUDGET = 24 * 1024 * 1024;

	function rememberDab(key, canvas) {
		var pixels = canvas.width * canvas.height;
		dabCache.set(key, { canvas: canvas, pixels: pixels });
		dabCachePixels += pixels;

		// Oldest-first eviction, but never empty the cache entirely — a single
		// oversized dab should still be reusable by the next stamp.
		while (dabCachePixels > DAB_CACHE_PIXEL_BUDGET && dabCache.size > 1) {
			var oldestKey = dabCache.keys().next().value;
			var oldest = dabCache.get(oldestKey);
			dabCache.delete(oldestKey);
			dabCachePixels -= oldest.pixels;
		}
	}

	/**
	 * A coloured stamp of the brush at `size` pixels.
	 *
	 * Strokes and size ramps stamp this many times per frame, so results are
	 * cached behind a pixel-bounded LRU.
	 */
	function dabCanvas(brush, size, color, transform) {
		var px = Math.max(2, Math.min(MAX_DIM, Math.round(size)));
		var t = transform || brushTransform(brush);
		var key = [
			brush.id, px, color,
			Math.round((t.angle || 0) * 100) / 100,
			Math.round((t.roundness == null ? 1 : t.roundness) * 1000) / 1000,
			t.flipX ? 'x' : '', t.flipY ? 'y' : '',
			brush.hardness, brush.mask ? 'm' : 'c'
		].join('|');

		var cached = dabCache.get(key);
		if (cached) return cached.canvas;

		var mask = buildMaskCanvas(brush, px, t);
		var out = createCanvas(px, px);
		var ctx = out.getContext('2d');
		ctx.drawImage(mask, 0, 0);
		ctx.globalCompositeOperation = 'source-in';
		ctx.fillStyle = color || '#ffffff';
		ctx.fillRect(0, 0, px, px);
		ctx.globalCompositeOperation = 'source-over';

		rememberDab(key, out);
		return out;
	}

	function clearCache() {
		dabCache.clear();
		dabCachePixels = 0;
	}

	/** Current dab-cache footprint, for reasoning about memory during batches. */
	function cacheStats() {
		return { entries: dabCache.size, pixels: dabCachePixels, budget: DAB_CACHE_PIXEL_BUDGET };
	}

	/* ------------------------------------------------------------------ *
	 * Backgrounds
	 * ------------------------------------------------------------------ */

	function paintBackground(ctx, width, height, mode) {
		ctx.clearRect(0, 0, width, height);

		if (mode === 'dark') {
			var grad = ctx.createLinearGradient(0, 0, 0, height);
			grad.addColorStop(0, '#191c25');
			grad.addColorStop(1, '#0d0e13');
			ctx.fillStyle = grad;
			ctx.fillRect(0, 0, width, height);
			return;
		}

		if (mode === 'light') {
			var lg = ctx.createLinearGradient(0, 0, 0, height);
			lg.addColorStop(0, '#ffffff');
			lg.addColorStop(1, '#eceef4');
			ctx.fillStyle = lg;
			ctx.fillRect(0, 0, width, height);
			return;
		}

		if (mode === 'checker') {
			var cell = Math.max(8, Math.round(Math.min(width, height) / 16));
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, width, height);
			ctx.fillStyle = '#e2e5ee';
			for (var y = 0; y < height; y += cell) {
				for (var x = 0; x < width; x += cell) {
					if ((x / cell + y / cell) % 2 === 0) ctx.fillRect(x, y, cell, cell);
				}
			}
		}
		// 'transparent' leaves the canvas cleared.
	}

	/* ------------------------------------------------------------------ *
	 * Stage rendering
	 * ------------------------------------------------------------------ */

	/**
	 * Draws the main preview into `canvas`.
	 *
	 * `cssWidth`/`cssHeight` describe the CSS box to occupy; the backing
	 * store is scaled by `dpr` so the result is crisp on HiDPI displays.
	 */
	function renderStage(canvas, brush, options) {
		var opts = options || {};
		var cssW = Math.max(40, Math.round(opts.cssWidth || 520));
		var cssH = Math.max(40, Math.round(opts.cssHeight || 380));
		var dpr = clamp(opts.dpr || 1, 1, 3);

		canvas.width = Math.round(cssW * dpr);
		canvas.height = Math.round(cssH * dpr);
		canvas.style.width = cssW + 'px';
		canvas.style.height = cssH + 'px';

		var ctx = canvas.getContext('2d');
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cssW, cssH);
		paintBackground(ctx, cssW, cssH, opts.background || 'transparent');

		if (!brush) return;

		var color = opts.color || '#f4f5f8';
		var mode = opts.mode || 'dab';
		var transform = brushTransform(brush, opts);

		// The preview normalises to the box so every brush is comparable
		// regardless of its native diameter.
		var maxSize = Math.min(cssW, cssH) * 0.78;
		var size = clamp(opts.size || maxSize, 6, Math.min(cssW, cssH) * 1.4);

		if (mode === 'stroke') {
			renderStroke(ctx, brush, {
				width: cssW, height: cssH, size: size, color: color,
				transform: transform, spacing: opts.spacing, brushSpacing: opts.brushSpacing
			});
		} else if (mode === 'grid') {
			renderRamp(ctx, brush, {
				width: cssW, height: cssH,
				maxSize: Math.min(cssH * 0.72, cssW / 7.5),
				color: color, transform: transform
			});
		} else {
			var dab = dabCanvas(brush, size, color, transform);
			ctx.drawImage(dab, (cssW - size) / 2, (cssH - size) / 2, size, size);
		}
	}

	function renderStroke(ctx, brush, o) {
		var spacing = o.brushSpacing && brush.spacing ? brush.spacing : (o.spacing == null ? 0.25 : o.spacing);
		spacing = clamp(spacing, 0.01, 2);
		var step = Math.max(1, o.size * spacing);

		// A gentle S-curve reads as a real stroke and shows how the dabs
		// overlap far better than a straight line would.
		var marginX = o.size * 0.5;
		var left = marginX;
		var right = o.width - marginX;
		var length = right - left;
		var midY = o.height / 2;
		var amplitude = Math.min(o.height * 0.2, o.size * 0.8);

		var dab = dabCanvas(brush, o.size, o.color, o.transform);
		var count = Math.max(2, Math.ceil(length / step));

		for (var i = 0; i <= count; i++) {
			var t = i / count;
			var x = left + length * t;
			var y = midY + Math.sin(t * Math.PI * 1.35 - 0.5) * amplitude;
			// Taper both ends so the stroke does not begin as a blunt blob.
			var taper = Math.min(1, Math.sin(Math.PI * clamp(t, 0, 1)) * 2.6);
			if (taper <= 0.02) continue;

			var s = o.size * (0.55 + 0.45 * taper);
			ctx.globalAlpha = clamp01(taper);
			ctx.drawImage(dab, x - s / 2, y - s / 2, s, s);
		}
		ctx.globalAlpha = 1;
	}

	function renderRamp(ctx, brush, o) {
		var steps = 6;
		var maxSize = o.maxSize || 180;
		var gap = o.width / (steps + 1);

		for (var i = 0; i < steps; i++) {
			var size = maxSize * (0.22 + 0.78 * (i / (steps - 1)));
			var dab = dabCanvas(brush, size, o.color, o.transform);
			var x = gap * (i + 1);
			ctx.drawImage(dab, x - size / 2, o.height / 2 - size / 2, size, size);
		}
	}

	/* ------------------------------------------------------------------ *
	 * Export tiles
	 * ------------------------------------------------------------------ */

	function tileSizeFor(brush, options) {
		var opts = options || {};
		var mode = opts.scale || '2';
		if (mode === 'fixed512') return 512;
		if (mode === 'fixed1024') return 1024;
		var factor = parseFloat(mode) || 2;
		var natural = naturalSize(brush);
		return clamp(Math.round(natural * factor), 16, MAX_DIM);
	}

	/** One brush rendered into its own square, PNG-ready canvas. */
	function renderTile(brush, options) {
		var opts = options || {};
		var pad = clamp(opts.padding == null ? 0.08 : opts.padding, 0, 0.5);

		// Size the tile first, then derive the brush from it. Doing it the
		// other way round means that once the tile hits the ceiling the
		// clamped canvas silently swallows the padding and the brush ends up
		// jammed against the edges.
		var desired = tileSizeFor(brush, opts);
		var side = clamp(Math.round(desired * (1 + pad * 2)), 16, MAX_DIM);
		var inner = clamp(Math.round(side / (1 + pad * 2)), 4, MAX_DIM);

		var canvas = createCanvas(side, side);
		var ctx = canvas.getContext('2d');
		paintBackground(ctx, side, side, opts.background || 'transparent');

		var dab = dabCanvas(brush, inner, opts.color || '#f4f5f8', brushTransform(brush, opts));
		ctx.drawImage(dab, (side - inner) / 2, (side - inner) / 2, inner, inner);
		return canvas;
	}

	/** Small square preview used by the filmstrip and the batch grid. */
	function renderThumb(canvas, brush, options) {
		var opts = options || {};

		// CSS owns the layout of a thumbnail, so measure it rather than
		// writing an inline size — a mismatch here would either letterbox
		// the bitmap or overflow the card.
		var cssW = Math.max(8, Math.round(canvas.clientWidth || opts.cssWidth || 64));
		var cssH = Math.max(8, Math.round(canvas.clientHeight || opts.cssHeight || cssW));
		var dpr = clamp(opts.dpr || 1, 1, 2);

		canvas.width = Math.round(cssW * dpr);
		canvas.height = Math.round(cssH * dpr);

		var ctx = canvas.getContext('2d');
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cssW, cssH);
		paintBackground(ctx, cssW, cssH, opts.background || 'transparent');
		if (!brush) return;

		var size = Math.min(cssW, cssH) * (opts.fill || 0.84);
		var dab = dabCanvas(brush, Math.max(4, Math.round(size)), opts.color || '#f4f5f8', brushTransform(brush, opts));
		ctx.drawImage(dab, (cssW - size) / 2, (cssH - size) / 2, size, size);
	}

	/* ------------------------------------------------------------------ *
	 * Contact sheet
	 * ------------------------------------------------------------------ */

	/** A single overview image: every brush on a labelled grid. */
	function renderContactSheet(brushes, options) {
		var opts = options || {};
		var list = Array.isArray(brushes) ? brushes : [];

		var cell = clamp(opts.cell || 220, 96, 512);
		var labelH = 38;
		var headerH = opts.title ? 78 : 0;

		// A square-ish grid, but allow more columns for big selections so the
		// sheet can stay inside the size ceiling.
		var columns = clamp(opts.columns || Math.ceil(Math.sqrt(list.length || 1)), 1, 32);

		// Work out how many rows actually fit. Clamping the height alone would
		// silently crop whichever brushes fell off the bottom — and since the
		// batch grid starts with everything selected, that is easy to hit.
		var rowsThatFit = Math.max(1, Math.floor((SHEET_MAX - headerH) / (cell + labelH)));
		var capacity = Math.max(1, columns * rowsThatFit);
		var drawn = list.length > capacity ? list.slice(0, capacity) : list;

		var rows = Math.max(1, Math.ceil(drawn.length / columns));
		var width = clamp(columns * cell, 64, SHEET_MAX);
		var height = clamp(headerH + rows * (cell + labelH), 64, SHEET_MAX);

		var canvas = createCanvas(width, height);
		var ctx = canvas.getContext('2d');

		// A transparent sheet would be dark text on nothing.
		var background = (opts.background && opts.background !== 'transparent') ? opts.background : 'dark';
		paintBackground(ctx, width, height, background);

		var onLight = background === 'light' || background === 'checker';
		var textColor = onLight ? '#20242f' : '#e9ebf3';
		var dimColor = onLight ? '#666d80' : '#9aa1b6';

		// Say so on the image itself when the selection did not all fit.
		var subtitle = String(opts.subtitle || '');
		if (drawn.length < list.length) {
			subtitle += (subtitle ? '   ·   ' : '') + 'showing ' + drawn.length + ' of ' + list.length + ' brushes';
		}

		if (headerH) {
			ctx.fillStyle = textColor;
			ctx.font = '600 24px ' + FONT;
			ctx.textBaseline = 'middle';
			ctx.textAlign = 'left';
			ctx.fillText(String(opts.title).slice(0, 90), 28, 32);
			if (subtitle) {
				ctx.fillStyle = dimColor;
				ctx.font = '400 13px ' + FONT;
				ctx.fillText(subtitle.slice(0, 200), 28, 58);
			}
		}

		drawn.forEach(function (brush, index) {
			var col = index % columns;
			var row = Math.floor(index / columns);
			var x = col * cell;
			var y = headerH + row * (cell + labelH);

			var inner = Math.round(cell * 0.76);
			var dab = dabCanvas(brush, inner, opts.color || '#f4f5f8', brushTransform(brush));
			ctx.drawImage(dab, x + (cell - inner) / 2, y + (cell - inner) / 2, inner, inner);

			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillStyle = textColor;
			ctx.font = '500 12px ' + FONT;
			ctx.fillText(ellipsize(ctx, brush.name || 'Brush', cell - 22), x + cell / 2, y + cell + 13);

			ctx.fillStyle = dimColor;
			ctx.font = '400 10px ' + FONT;
			var meta = naturalSize(brush) + ' px';
			if (brush.spacing) meta += '  ·  ' + Math.round(brush.spacing * 100) + '%';
			ctx.fillText(meta, x + cell / 2, y + cell + 28);

			ctx.textAlign = 'left';
		});

		// Lets the caller report an incomplete sheet in its own message.
		canvas.sheetInfo = { drawn: drawn.length, total: list.length };

		return canvas;
	}

	function ellipsize(ctx, text, maxWidth) {
		var value = String(text);
		if (ctx.measureText(value).width <= maxWidth) return value;
		while (value.length > 1 && ctx.measureText(value + '…').width > maxWidth) {
			value = value.slice(0, -1);
		}
		return value + '…';
	}

	global.BrushBoxRender = {
		naturalSize: naturalSize,
		contentBounds: contentBounds,
		brushTransform: brushTransform,
		dabCanvas: dabCanvas,
		buildMaskCanvas: buildMaskCanvas,
		paintBackground: paintBackground,
		renderStage: renderStage,
		renderThumb: renderThumb,
		renderTile: renderTile,
		renderContactSheet: renderContactSheet,
		tileSizeFor: tileSizeFor,
		clearCache: clearCache,
		cacheStats: cacheStats,
		parseColor: parseColor,
		createCanvas: createCanvas
	};
})(typeof window !== 'undefined' ? window : globalThis);
