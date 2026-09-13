/*!
 * BrushBox — logo generator
 * ---------------------------------------------------------------------
 * Draws `logo.png` with no third-party dependencies: the mark is
 * composed analytically (so every edge is antialiased) and encoded with
 * a minimal PNG writer built on Node's own `zlib`.
 *
 * Geometry is authored in a 256-unit space and scaled to the requested
 * output size, so a 128px icon is redrawn rather than downsampled.
 *
 *   node tools/make-logo.js [size] [outfile]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = Math.max(32, parseInt(process.argv[2], 10) || 128);
const OUT = path.join(__dirname, '..', process.argv[3] || 'logo.png');

/** Units are authored at 256; everything is multiplied by this. */
const K = SIZE / 256;

/* ------------------------------------------------------------------ *
 * PNG encoding
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buf) {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const typeBuf = Buffer.from(type, 'ascii');
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(rgba, width, height) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: RGBA
	ihdr[10] = 0; // deflate
	ihdr[11] = 0; // adaptive filtering
	ihdr[12] = 0; // no interlace

	// One filter byte (0 = None) per scanline.
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/* ------------------------------------------------------------------ *
 * Painting helpers
 * ------------------------------------------------------------------ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function smoothstep(edge0, edge1, x) {
	const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
	return t * t * (3 - 2 * t);
}

function mix(a, b, t) {
	return [
		a[0] + (b[0] - a[0]) * t,
		a[1] + (b[1] - a[1]) * t,
		a[2] + (b[2] - a[2]) * t
	];
}

/** Signed distance to a rounded rectangle, negative inside. */
function roundedRectSdf(px, py, cx, cy, halfW, halfH, radius) {
	const qx = Math.abs(px - cx) - (halfW - radius);
	const qy = Math.abs(py - cy) - (halfH - radius);
	return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Brush dab: solid core out to `hardness` of the radius, then a tapered falloff. */
function dabAlpha(dist, radius, hardness) {
	if (dist >= radius) return 0;
	const core = clamp01(hardness) * 0.92;
	const t = clamp01(dist / radius);
	if (t <= core) return 1;
	return smoothstep(1, core, t);
}

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

const TILE_TOP = [26, 21, 37];
const TILE_BOTTOM = [11, 12, 17];
const LIFT = [186, 148, 255];
const EMBER = [255, 150, 104];

const SPINE_STEPS = 320;

/**
 * The mark: one tapered, slightly curved paint stroke sweeping from the
 * lower left to the upper right, with longitudinal bristle streaks. The
 * stroke is traced by sampling its spine and keeping the closest sample
 * per pixel, which also gives the arc-length `t` used for shading.
 */
const spine = (() => {
	const points = [];
	for (let i = 0; i <= SPINE_STEPS; i++) {
		const t = i / SPINE_STEPS;
		const bend = Math.sin(t * Math.PI);
		const cos = Math.cos(t * Math.PI);
		// Analytic tangent, normalised, so we can measure lateral offset.
		const tx0 = 158 + 13 * Math.PI * cos;
		const ty0 = -122 - 21 * Math.PI * cos;
		const len = Math.hypot(tx0, ty0) || 1;
		points.push({
			t,
			x: 46 + t * 158 + bend * 13,
			y: 194 - t * 122 - bend * 21,
			// Thin at the tail, swelling into a broad body.
			w: 4.5 + 31 * Math.pow(t, 0.78),
			a: 0.55 + 0.45 * smoothstep(0, 0.22, t),
			tx: tx0 / len,
			ty: ty0 / len
		});
	}
	return points;
})();

function paint() {
	const px = new Uint8ClampedArray(SIZE * SIZE * 4);
	const centre = 128;

	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) {
			const i = (y * SIZE + x) * 4;

			// Work in the 256-unit authoring space.
			const ux = (x + 0.5) / K;
			const uy = (y + 0.5) / K;

			// --- tile silhouette -------------------------------------
			const tile = roundedRectSdf(ux, uy, centre, centre, centre - 3, centre - 3, 58);
			const cover = smoothstep(0.75, -0.75, tile);
			if (cover <= 0) continue;

			// --- base gradient ---------------------------------------
			let rgb = mix(TILE_TOP, TILE_BOTTOM, smoothstep(0, 1, (uy / 256) * 1.15));

			// --- ambient glow, upper left ----------------------------
			rgb = mix(rgb, [139, 92, 246], smoothstep(1, 0, Math.hypot(ux - 74, uy - 58) / 172) * 0.34);

			// --- faint warm wash, lower right ------------------------
			rgb = mix(rgb, [255, 138, 92], smoothstep(1, 0, Math.hypot(ux - 208, uy - 214) / 150) * 0.12);

			// --- hairline inner border -------------------------------
			rgb = mix(rgb, [255, 255, 255], smoothstep(1.1, 0.2, Math.abs(tile + 1.1)) * 0.09);

			// --- nearest point on the stroke spine -------------------
			let bestT = 0;
			let bestW = 0;
			let bestA = 0;
			let bestTx = 1;
			let bestTy = 0;
			let bestDist = Infinity;
			let offX = 0;
			let offY = 0;

			for (let s = 0; s < spine.length; s++) {
				const p = spine[s];
				const dx = ux - p.x;
				const dy = uy - p.y;
				const d2 = dx * dx + dy * dy;
				if (d2 < bestDist) {
					bestDist = d2;
					bestT = p.t;
					bestW = p.w;
					bestA = p.a;
					bestTx = p.tx;
					bestTy = p.ty;
					offX = dx;
					offY = dy;
				}
			}
			bestDist = Math.sqrt(bestDist);

			let acc = rgb;
			let strokeAlpha = 0;

			if (bestDist < bestW + 1.5) {
				// Solid until 82% of the half-width, then a soft shoulder.
				let a = dabAlpha(bestDist, bestW, 0.82) * bestA;

				// Bristle streaks run *along* the stroke, so modulate by
				// the signed perpendicular offset (cross of tangent × offset).
				// Keep the frequency low: fine hatching turns to moire in a
				// 24px titlebar rendering.
				const lateral = bestTx * offY - bestTy * offX;
				a *= 0.84 + 0.16 * (0.5 + 0.5 * Math.sin(lateral * 0.5 + 1.1));

				// Fade the very tip of the tail out.
				a *= smoothstep(0, 0.06, bestT);

				if (a > 0) {
					strokeAlpha = a;
					const shade = mix(LIFT, EMBER, smoothstep(0.05, 0.95, bestT));
					const highlight = smoothstep(bestW, 0, bestDist) * 0.22;
					acc = mix(acc, mix(shade, [255, 244, 236], highlight), a);
				}
			}

			// --- specular hot spot inside the loaded head ------------
			// Clipped to the stroke so it reads as a sheen, not a ball.
			if (strokeAlpha > 0.35) {
				const spec = smoothstep(30, 0, Math.hypot(ux - 194, uy - 82)) * 0.34;
				if (spec > 0) acc = mix(acc, [255, 252, 250], spec * strokeAlpha);
			}

			px[i] = Math.round(acc[0]);
			px[i + 1] = Math.round(acc[1]);
			px[i + 2] = Math.round(acc[2]);
			px[i + 3] = Math.round(cover * 255);
		}
	}

	return px;
}

fs.writeFileSync(OUT, encodePng(paint(), SIZE, SIZE));
console.log('wrote ' + OUT + ' (' + SIZE + '×' + SIZE + ', ' + fs.statSync(OUT).size + ' bytes)');
