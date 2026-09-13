/*!
 * BrushBox — parser test suite
 * ---------------------------------------------------------------------
 * There are no .abr fixtures to hand that cover every layout, so this
 * suite *writes* ABR files byte by byte (an inverse of the parser: an
 * 8BIM/descriptor serialiser plus a PackBits encoder) and reads them
 * back. A pass therefore means the parser agrees with an independent
 * encoding of the format, not merely with itself.
 *
 * Generated files are also written to test/fixtures/ so they can be
 * opened in Eagle to eyeball the end result.
 *
 *   node test/run-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ABR = require('../js/abr.js');
// The renderer only touches the DOM inside createCanvas(), which nothing here
// calls, so its pure geometry helpers are usable under Node.
require('../js/render.js');
const Render = globalThis.BrushBoxRender;

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

/* ==================================================================== *
 * Tiny assertion harness
 * ==================================================================== */

let passed = 0;
let failed = 0;
const failures = [];

function ok(condition, label) {
	if (condition) {
		passed++;
	} else {
		failed++;
		failures.push(label);
		console.log('  ✗ ' + label);
	}
}

function eq(actual, expected, label) {
	const same = actual === expected;
	ok(same, label + (same ? '' : ` — expected ${brief(expected)}, got ${brief(actual)}`));
}

/** Keeps failure messages readable when a whole bitmap is the actual value. */
function brief(value) {
	if (value && value.data && typeof value.width === 'number') {
		return `[bitmap ${value.width}×${value.height}]`;
	}
	const text = JSON.stringify(value);
	if (text == null) return String(value);
	return text.length > 120 ? text.slice(0, 117) + '…' : text;
}

function near(actual, expected, tolerance, label) {
	const same = Math.abs(actual - expected) <= tolerance;
	ok(same, label + (same ? '' : ` — expected ~${expected}, got ${actual}`));
}

function section(title) {
	console.log('\n' + title);
}

/* ==================================================================== *
 * Byte writer
 * ==================================================================== */

function Writer() {
	this.buf = Buffer.alloc(4096);
	this.len = 0;
}

Writer.prototype.ensure = function (n) {
	if (this.len + n > this.buf.length) {
		const next = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n));
		this.buf.copy(next);
		this.buf = next;
	}
};

Writer.prototype.u8 = function (v) { this.ensure(1); this.buf.writeUInt8(v & 0xff, this.len); this.len += 1; return this; };
Writer.prototype.u16 = function (v) { this.ensure(2); this.buf.writeUInt16BE(v & 0xffff, this.len); this.len += 2; return this; };
Writer.prototype.i16 = function (v) { this.ensure(2); this.buf.writeInt16BE(v | 0, this.len); this.len += 2; return this; };
Writer.prototype.u32 = function (v) { this.ensure(4); this.buf.writeUInt32BE(v >>> 0, this.len); this.len += 4; return this; };
Writer.prototype.i32 = function (v) { this.ensure(4); this.buf.writeInt32BE(v | 0, this.len); this.len += 4; return this; };
Writer.prototype.f64 = function (v) { this.ensure(8); this.buf.writeDoubleBE(v, this.len); this.len += 8; return this; };

Writer.prototype.ascii = function (s) {
	this.ensure(s.length);
	for (let i = 0; i < s.length; i++) this.buf.writeUInt8(s.charCodeAt(i) & 0xff, this.len + i);
	this.len += s.length;
	return this;
};

Writer.prototype.signature = function (s) {
	const padded = (s + '    ').slice(0, 4);
	return this.ascii(padded);
};

Writer.prototype.bytes = function (data) {
	this.ensure(data.length);
	Buffer.from(data.buffer || data, data.byteOffset || 0, data.length).copy(this.buf, this.len);
	this.len += data.length;
	return this;
};

Writer.prototype.zeroes = function (n) {
	this.ensure(n);
	this.buf.fill(0, this.len, this.len + n);
	this.len += n;
	return this;
};

/**
 * A UTF-16BE string with a 4-byte code-unit count.
 *
 * NUL-terminated with the terminator included in the count, which is what
 * Photoshop writes — it is why the format spec reports `sampledData` as
 * TEXT 37 for a 36-character UUID. Fixtures reproduce that so the parser's
 * handling of the terminator is actually covered; getting this wrong is
 * invisible until you open a real brush file, where it breaks the
 * bitmap-to-preset join and every brush renders as the same blob.
 */
Writer.prototype.unicodeString = function (s) {
	const value = String(s == null ? '' : s);
	this.u32(value.length + 1);
	for (let i = 0; i < value.length; i++) this.u16(value.charCodeAt(i));
	this.u16(0);
	return this;
};

/** Either a 4-character class id (length 0) or a length-prefixed string. */
Writer.prototype.asciiStringOrClassId = function (s) {
	const value = String(s == null ? '' : s);
	if (value.length === 4) {
		this.i32(0);
		return this.ascii(value);
	}
	this.i32(value.length);
	return this.ascii(value);
};

Writer.prototype.toBuffer = function () {
	return Buffer.from(this.buf.subarray(0, this.len));
};

/* ==================================================================== *
 * Descriptor value helpers
 * ==================================================================== */

const P = (v) => ({ t: 'UntF', u: '#Prc', v });
const PX = (v) => ({ t: 'UntF', u: '#Pxl', v });
const ANG = (v) => ({ t: 'UntF', u: '#Ang', v });
const DOUB = (v) => ({ t: 'doub', v });
const LONG = (v) => ({ t: 'long', v });
const BOOL = (v) => ({ t: 'bool', v });
const TEXT = (v) => ({ t: 'TEXT', v });
const OBJC = (v) => ({ t: 'Objc', v });
const VLLS = (v) => ({ t: 'VlLs', v });

/** Writes a descriptor structure; `version` adds the 4-byte prologue. */
function writeDescriptor(w, descriptor, withVersion) {
	if (withVersion) w.u32(16);
	w.unicodeString(descriptor._name || '');
	w.asciiStringOrClassId(descriptor._classID || '');

	const keys = Object.keys(descriptor).filter((k) => k !== '_name' && k !== '_classID');
	w.u32(keys.length);

	for (const key of keys) {
		const value = descriptor[key];
		w.asciiStringOrClassId(key);
		w.signature(value.t);
		writeValue(w, value);
	}
}

function writeValue(w, value) {
	switch (value.t) {
		case 'Objc':
			writeDescriptor(w, value.v, false);
			break;
		case 'VlLs':
			w.i32(value.v.length);
			for (const item of value.v) {
				w.signature(item.t);
				writeValue(w, item);
			}
			break;
		case 'UntF':
			w.signature(value.u);
			w.f64(value.v);
			break;
		case 'doub':
			w.f64(value.v);
			break;
		case 'long':
			w.i32(value.v);
			break;
		case 'bool':
			w.u8(value.v ? 1 : 0);
			break;
		case 'TEXT':
			w.unicodeString(value.v);
			break;
		default:
			throw new Error('Unhandled descriptor value type ' + value.t);
	}
}

/* ==================================================================== *
 * PackBits encoder (inverse of the parser's decoder)
 * ==================================================================== */

function packBits(row) {
	const out = [];
	let i = 0;

	while (i < row.length) {
		// Measure a run of identical bytes.
		let runLength = 1;
		while (i + runLength < row.length && row[i + runLength] === row[i] && runLength < 128) runLength++;

		if (runLength >= 3) {
			out.push(257 - runLength, row[i]);
			i += runLength;
			continue;
		}

		// Otherwise accumulate literals, stopping before a run worth encoding.
		let j = i;
		while (j < row.length && j - i < 128) {
			if (j + 2 < row.length && row[j] === row[j + 1] && row[j + 1] === row[j + 2]) break;
			j++;
		}
		const count = j - i;
		out.push(count - 1);
		for (let k = i; k < j; k++) out.push(row[k]);
		i = j;
	}

	return out;
}

/* ==================================================================== *
 * Mask synthesis
 * ==================================================================== */

function makeMask(width, height) {
	const data = new Uint8Array(width * height);
	const cx = (width - 1) / 2;
	const cy = (height - 1) / 2;
	const radius = Math.min(width, height) / 2;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const d = Math.hypot(x - cx, y - cy) / radius;
			data[y * width + x] = Math.max(0, Math.min(255, Math.round(255 * (1 - d * d))));
		}
	}
	return data;
}

/**
 * A thick ring. Deliberately not a soft blob: a brush that fails to load its
 * bitmap falls back to a synthesised circle, so the shape has to be
 * unmistakable when eyeballing an export.
 */
function makeRingMask(size) {
	const data = new Uint8Array(size * size);
	const centre = (size - 1) / 2;
	const outer = size * 0.46;
	const inner = outer * 0.62;

	for (let y = 0; y < size; y++) {
		const dy = y - centre;
		const row = y * size;
		for (let x = 0; x < size; x++) {
			const dx = x - centre;
			const r = Math.sqrt(dx * dx + dy * dy);
			data[row + x] = (r >= inner && r <= outer) ? 255 : 0;
		}
	}
	return data;
}

/** A hollow rectangle: opaque border, empty middle. */
function makeFrameMask(width, height) {
	const data = new Uint8Array(width * height);
	const band = Math.max(2, Math.round(Math.min(width, height) * 0.15));

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const onBorder = x < band || y < band || x >= width - band || y >= height - band;
			data[y * width + x] = onBorder ? 255 : 0;
		}
	}
	return data;
}

function invert(mask) {
	const out = new Uint8Array(mask.length);
	for (let i = 0; i < mask.length; i++) out[i] = 255 - mask[i];
	return out;
}

/* ==================================================================== *
 * ABR file assembly
 * ==================================================================== */

/** The pixel bytes for a sample, honouring its depth and compression. */
function encodePayload(sample) {
	const out = new Writer();

	if (sample.compression === 0) {
		if (sample.depth === 8) {
			out.bytes(sample.data);
		} else {
			for (let i = 0; i < sample.data.length; i++) out.u16(sample.data[i] << 8);
		}
	} else {
		const rows = [];
		for (let y = 0; y < sample.height; y++) {
			const row = Array.from(sample.data.subarray(y * sample.width, (y + 1) * sample.width));
			rows.push(packBits(row));
		}
		for (const row of rows) out.u16(row.length);
		for (const row of rows) out.bytes(Uint8Array.from(row));
	}

	return out.toBuffer();
}

/**
 * Writes the body between the Pascal id and the pixel data.
 *
 *   minor 1               — ten opaque bytes.
 *   minor 2, no `vmal`    — 264 zero bytes (the flat layout the parser must
 *                           still accept as a fallback).
 *   minor 2, with `vmal`  — a real virtual memory array list, so the parser's
 *                           structured walk is exercised. `vmal.index` may be
 *                           anything, including layouts where the historical
 *                           flat 264-byte offset would land in the wrong place.
 */
function encodeSampleHeader(body, sample, minor) {
	if (minor === 1) {
		body.zeroes(10);
		return;
	}

	if (!sample.vmal) {
		body.zeroes(264);
		return;
	}

	const channels = sample.vmal.channels;
	const index = sample.vmal.index;
	const payload = encodePayload(sample);
	const recordCount = channels + 2;

	body.u16(1);
	body.u16(0);
	body.u32(3); // VMAL version
	body.u32(32 + recordCount * 4 + payload.length);
	body.u32(0); // bounds: top
	body.u32(0); // left
	body.u32(sample.height);
	body.u32(sample.width);
	body.u32(channels);

	for (let i = 0; i < recordCount; i++) {
		if (i !== index) {
			body.u32(0); // channel absent
			continue;
		}
		body.u32(1); // channel present
		body.u32(23 + payload.length);
		body.u32(sample.depth);
		body.i32(0);
		body.i32(0);
		body.i32(sample.height);
		body.i32(sample.width);
		body.u16(sample.depth);
		body.u8(sample.compression);
		body.bytes(payload);
	}
}

/**
 * @param {object} options
 *   minor      — 1 or 2
 *   samples    — [{ id, width, height, depth, compression, data, vmal? }]
 *   presets    — descriptor objects for the `desc` block
 *   order      — ['samp','desc'] (default) or ['desc','samp']
 *   truncate   — byte count to cut the finished file to
 */
function buildAbr(options) {
	const major = options.major || 6;
	const minor = options.minor || 2;
	const blocks = [];

	const build = {
		samp() {
			const w = new Writer();
			for (const sample of options.samples || []) {
				const body = new Writer();
				body.u8(sample.id.length);
				body.ascii(sample.id);

				encodeSampleHeader(body, sample, minor);

				body.i32(0); // top
				body.i32(0); // left
				body.i32(sample.height); // bottom
				body.i32(sample.width); // right
				body.i16(sample.depth);
				body.u8(sample.compression);
				body.bytes(encodePayload(sample));

				const bodyBuffer = body.toBuffer();
				let paddedLength = bodyBuffer.length;
				while (paddedLength & 3) paddedLength++;

				const item = new Writer();
				item.u32(paddedLength);
				item.bytes(bodyBuffer);
				item.zeroes(paddedLength - bodyBuffer.length);
				w.bytes(item.toBuffer());
			}
			return w.toBuffer();
		},

		desc() {
			const w = new Writer();
			writeDescriptor(w, {
				_classID: 'brushPreset',
				Brsh: VLLS((options.presets || []).map((p) => OBJC(p)))
			}, true);
			return w.toBuffer();
		}
	};

	for (const name of options.order || ['samp', 'desc']) {
		const payload = build[name]();
		const block = new Writer();
		block.signature('8BIM');
		block.signature(name);
		block.u32(payload.length);
		block.bytes(payload);
		block.zeroes((4 - (payload.length % 4)) % 4);
		blocks.push(block.toBuffer());
	}

	const header = new Writer();
	header.i16(major);
	header.i16(minor);

	let file = Buffer.concat([header.toBuffer(), ...blocks]);
	if (options.truncate) file = file.subarray(0, options.truncate);
	return file;
}

/* ==================================================================== *
 * Preset builders
 * ==================================================================== */

/** Adds the shape-dynamics sub-descriptors a real preset carries. */
function withDynamics(preset) {
	preset.useTipDynamics = BOOL(true);
	preset.minimumDiameter = P(0);
	preset.minimumRoundness = P(25);
	preset.tiltScale = P(200);
	preset.flipX = BOOL(false);
	preset.flipY = BOOL(false);
	preset.brushProjection = BOOL(false);
	preset.szVr = OBJC({ _classID: 'brVr', bVTy: LONG(2), fStp: LONG(25), jitter: P(0), 'Mnm ': P(0) });
	preset.angleDynamics = OBJC({ _classID: 'brVr', bVTy: LONG(0), fStp: LONG(25), jitter: P(0), 'Mnm ': P(0) });
	preset.roundnessDynamics = OBJC({ _classID: 'brVr', bVTy: LONG(0), fStp: LONG(25), jitter: P(23), 'Mnm ': P(0) });
	return preset;
}

function computedPreset(name, opts) {
	const o = opts || {};
	const preset = {
		_name: '',
		_classID: 'brushPreset',
		'Nm  ': TEXT(name),
		Brsh: OBJC({
			_classID: 'computedBrush',
			Dmtr: PX(o.diameter == null ? 40 : o.diameter),
			Hrdn: P(o.hardness == null ? 50 : o.hardness),
			Angl: ANG(o.angle == null ? 0 : o.angle),
			Rndn: P(o.roundness == null ? 100 : o.roundness),
			Spcn: P(o.spacing == null ? 25 : o.spacing),
			Intr: BOOL(true),
			flipX: BOOL(!!o.flipX),
			flipY: BOOL(!!o.flipY)
		}),
		Spcn: P(o.spacing == null ? 25 : o.spacing),
		Wtdg: BOOL(false),
		Nose: BOOL(!!o.noise),
		useBrushSize: BOOL(true),
		useTipDynamics: BOOL(false)
	};

	return o.dynamics ? withDynamics(preset) : preset;
}

function sampledPreset(name, opts) {
	const o = opts || {};
	const preset = {
		_name: '',
		_classID: 'brushPreset',
		'Nm  ': TEXT(name),
		Brsh: OBJC({
			_classID: 'sampledBrush',
			Dmtr: PX(o.diameter == null ? 64 : o.diameter),
			Angl: ANG(o.angle == null ? 0 : o.angle),
			Rndn: P(o.roundness == null ? 100 : o.roundness),
			'Nm  ': TEXT(name),
			Spcn: P(o.spacing == null ? 10 : o.spacing),
			Intr: BOOL(true),
			flipX: BOOL(!!o.flipX),
			flipY: BOOL(!!o.flipY),
			sampledData: TEXT(o.sampleId)
		}),
		Spcn: P(o.spacing == null ? 10 : o.spacing),
		Wtdg: BOOL(!!o.wetEdges),
		Nose: BOOL(false),
		useBrushSize: BOOL(true),
		useTipDynamics: BOOL(false)
	};

	if (o.dynamics) withDynamics(preset);

	return preset;
}

/* ==================================================================== *
 * Tests
 * ==================================================================== */

const blob32 = makeMask(32, 32);
const blob24x16 = makeMask(24, 16);
const blob16bit = makeMask(20, 20);

const GUID_A = '1fb12fc5-a3a7-11d5-b5d0-b1bcfb770f3f';
const GUID_B = '2ab23fd6-b4b8-22e6-c6e1-c2cdfc881040';
const GUID_C = '3bc34fe7-c5c9-33f7-d7f2-d3defd992151';

// Photoshop writes a virtual memory array list holding 56 channels, with the
// brush bitmap in the last one. Fixtures use that shape by default so the
// parser's structured walk is what normally gets exercised.
const VMAL_STANDARD = { channels: 56, index: 55 };

const samples = [
	{ id: GUID_A, width: 32, height: 32, depth: 8, compression: 0, data: blob32, vmal: VMAL_STANDARD },
	{ id: GUID_B, width: 24, height: 16, depth: 8, compression: 1, data: blob24x16, vmal: VMAL_STANDARD },
	{ id: GUID_C, width: 20, height: 20, depth: 16, compression: 0, data: blob16bit, vmal: VMAL_STANDARD }
];

// The same bitmaps written with the flat 264-byte body that older tools emit,
// used to prove the fallback still works.
const flatSamples = samples.map((sample) => {
	const copy = { ...sample };
	delete copy.vmal;
	return copy;
});

const presets = [
	computedPreset('Round Soft', { diameter: 40, hardness: 50, spacing: 25, dynamics: true }),
	computedPreset('Flat Hard', { diameter: 12, hardness: 100, roundness: 20, angle: 45, spacing: 5 }),
	sampledPreset('Splat Raw', { sampleId: GUID_A, diameter: 64, spacing: 10 }),
	sampledPreset('Streak RLE', { sampleId: GUID_B, diameter: 48, spacing: 12 }),
	sampledPreset('Deep 16-bit', { sampleId: GUID_C, diameter: 20, spacing: 10 })
];

section('v6.2 file — samp then desc');
{
	const file = buildAbr({ major: 6, minor: 2, samples, presets, order: ['samp', 'desc'] });
	fs.writeFileSync(path.join(FIXTURE_DIR, 'v6.2-brushes.abr'), file);

	const set = ABR.parse(new Uint8Array(file), { name: 'v6.2-brushes' });

	eq(set.ok, true, 'parses successfully');
	eq(set.version, '6.2', 'reports version 6.2');
	eq(set.error, undefined, 'no fatal error');
	eq(set.brushes.length, 5, 'finds all five presets');
	eq(set.stats.computed, 2, 'counts two computed brushes');
	eq(set.stats.sampled, 3, 'counts three sampled brushes');
	eq(set.stats.withMask, 3, 'attaches three bitmaps');

	const [round, flat, splat, streak, deep] = set.brushes;

	eq(round.name, 'Round Soft', 'reads the first brush name');
	eq(round.kind, 'computed', 'classifies a computed brush');
	eq(round.diameter, 40, 'reads the diameter');
	near(round.hardness, 0.5, 1e-9, 'converts hardness percent to a ratio');
	near(round.spacing, 0.25, 1e-9, 'converts spacing percent to a ratio');
	eq(round.mask, null, 'a computed brush has no bitmap');
	ok(round.shapeDynamics !== null, 'reads shape dynamics');
	eq(round.shapeDynamics.sizeDynamics.control, 'pen pressure', 'decodes the dynamics control enum');
	eq(round.shapeDynamics.minimumRoundness, 0.25, 'reads minimum roundness');

	eq(flat.roundness.toFixed(2), '0.20', 'converts roundness percent to a ratio');
	eq(flat.angle, 45, 'reads the brush angle');

	eq(splat.kind, 'sampled', 'classifies a sampled brush');
	ok(splat.mask !== null, 'attaches the raw bitmap');
	eq(splat.mask.width, 32, 'bitmap width is preserved');
	eq(splat.mask.height, 32, 'bitmap height is preserved');
	eq(splat.mask.data.length, 32 * 32, 'bitmap has width × height samples');
	eq(splat.mask.data[16 * 32 + 16], blob32[16 * 32 + 16], 'raw bitmap pixels survive the round trip');
	eq(splat.sampleId, GUID_A, 'keeps the sampled-data GUID');

	eq(streak.mask.width, 24, 'RLE bitmap width is preserved');
	eq(streak.mask.height, 16, 'RLE bitmap height is preserved');
	ok(splat.mask.inverted === undefined, 'a white-on-black mask is not inverted');
	let rleMatches = true;
	for (let i = 0; i < blob24x16.length; i++) {
		if (streak.mask.data[i] !== blob24x16[i]) { rleMatches = false; break; }
	}
	ok(rleMatches, 'RLE (PackBits) bitmap decodes byte for byte');

	eq(deep.mask.width, 20, '16-bit bitmap width is preserved');
	let depthMatches = true;
	for (let i = 0; i < blob16bit.length; i++) {
		if (deep.mask.data[i] !== blob16bit[i]) { depthMatches = false; break; }
	}
	ok(depthMatches, '16-bit bitmap downconverts to 8-bit exactly');

	// Fixtures use the real virtual memory array layout, so a well-formed
	// file should parse with nothing to report.
	eq(set.warnings.length, 0, 'reports no warnings for a well-formed file — got: ' + set.warnings.join(' | '));
}

section('v6.2 file — desc before samp');
{
	const file = buildAbr({ major: 6, minor: 2, samples, presets, order: ['desc', 'samp'] });
	const set = ABR.parse(new Uint8Array(file), { name: 'reordered' });

	eq(set.brushes.length, 5, 'still finds every brush');
	eq(set.stats.withMask, 3, 'still joins bitmaps to presets when blocks are reordered');
}

section('v6.1 file (minor version 1)');
{
	const file = buildAbr({ major: 6, minor: 1, samples, presets });
	fs.writeFileSync(path.join(FIXTURE_DIR, 'v6.1-brushes.abr'), file);

	const set = ABR.parse(new Uint8Array(file), { name: 'v6.1-brushes' });
	eq(set.ok, true, 'parses a minor-1 file');
	eq(set.version, '6.1', 'reports version 6.1');
	eq(set.brushes.length, 5, 'finds every brush');
	eq(set.stats.withMask, 3, 'reads minor-1 bitmaps with the compact header');
	eq(set.brushes[2].mask.data[16 * 32 + 16], blob32[16 * 32 + 16], 'minor-1 bitmap pixels are correct');
}

section('v10 file (Photoshop CC)');
{
	const file = buildAbr({ major: 10, minor: 1, samples, presets });
	fs.writeFileSync(path.join(FIXTURE_DIR, 'v10-brushes.abr'), file);

	const set = ABR.parse(new Uint8Array(file), { name: 'v10-brushes' });
	eq(set.ok, true, 'parses a version 10 file');
	eq(set.version, '10.1', 'reports version 10.1');
	eq(set.brushes.length, 5, 'finds every brush');
	eq(set.stats.withMask, 3, 'reads version 10 bitmaps');
}

section('minor-2 virtual memory array walking');
{
	// The layout Photoshop actually writes: 56 channels with the bitmap in
	// channel 55. Here the historical flat 264-byte offset happens to land
	// correctly, so both code paths agree.
	const standardVmal = [{
		...samples[0],
		vmal: { channels: 56, index: 55 }
	}];
	const standard = ABR.parse(new Uint8Array(buildAbr({
		major: 6, minor: 2, samples: standardVmal,
		presets: [sampledPreset('Standard VMAL', { sampleId: GUID_A })]
	})), { name: 'vmal-standard' });

	eq(standard.brushes[0].mask.width, 32, 'walks a standard 56-channel array');
	eq(standard.brushes[0].mask.data[16 * 32 + 16], blob32[16 * 32 + 16], 'reads the right pixels');
	ok(standard.warnings.length === 0, 'needs no fallback — got: ' + standard.warnings.join(' | '));

	// A different channel count, with the bitmap at index 25. The flat
	// 264-byte offset would land in the middle of the payload here, so this
	// only passes if the records are genuinely walked.
	const shifted = ABR.parse(new Uint8Array(buildAbr({
		major: 6, minor: 2,
		samples: [{ ...samples[0], vmal: { channels: 24, index: 25 } }],
		presets: [sampledPreset('Shifted VMAL', { sampleId: GUID_A })]
	})), { name: 'vmal-shifted' });

	eq(shifted.brushes[0].mask.width, 32, 'walks a 24-channel array whose bitmap sits at index 25');
	eq(shifted.brushes[0].mask.height, 32, 'recovers the right bounds');
	let shiftedMatches = true;
	for (let i = 0; i < blob32.length; i++) {
		if (shifted.brushes[0].mask.data[i] !== blob32[i]) { shiftedMatches = false; break; }
	}
	ok(shiftedMatches, 'recovers the right pixels from a non-standard channel index');

	// Same for an RLE-compressed payload, which validates through the row
	// length table rather than a simple length equality.
	const rleShifted = ABR.parse(new Uint8Array(buildAbr({
		major: 6, minor: 2,
		samples: [{ ...samples[1], vmal: { channels: 24, index: 25 } }],
		presets: [sampledPreset('Shifted RLE', { sampleId: GUID_B })]
	})), { name: 'vmal-rle' });

	eq(rleShifted.brushes[0].mask.width, 24, 'walks an RLE bitmap in a shifted channel');
	let rleShiftedMatches = true;
	for (let i = 0; i < blob24x16.length; i++) {
		if (rleShifted.brushes[0].mask.data[i] !== blob24x16[i]) { rleShiftedMatches = false; break; }
	}
	ok(rleShiftedMatches, 'decodes RLE pixels found through the record walk');
}

section('minor-2 flat-offset fallback');
{
	// The fixtures built without a `vmal` descriptor use the flat 264-byte
	// body, which the structured walk cannot interpret. The parser must
	// notice and fall back rather than losing the bitmap.
	const file = buildAbr({ major: 6, minor: 2, samples: flatSamples, presets, order: ['samp', 'desc'] });
	const set = ABR.parse(new Uint8Array(file), { name: 'flat-fallback' });

	eq(set.brushes.length, 5, 'still parses the whole set');
	eq(set.stats.withMask, 3, 'still attaches every bitmap');
	eq(set.brushes[2].mask.data[16 * 32 + 16], blob32[16 * 32 + 16], 'flat-offset pixels are correct');
	ok(set.warnings.some((w) => /fell back to the fixed 6\.2 offset/.test(w)),
		'reports that it used the fallback');
}

section('mask bytes are passed through untouched');
{
	// The parser must not reinterpret mask polarity. An earlier version
	// flipped masks whose corners were opaque and centre empty, on the theory
	// that this meant a black-on-white tip — but a hollow rectangle stamp has
	// exactly those statistics and is correct as stored, so the rule inverted
	// brushes that were perfectly fine. Whatever the file says is what gets
	// drawn.

	const frame = makeFrameMask(32, 32);
	const frameFile = buildAbr({
		major: 6, minor: 2,
		samples: [{ id: GUID_A, width: 32, height: 32, depth: 8, compression: 0, data: frame }],
		presets: [sampledPreset('Hollow frame', { sampleId: GUID_A })]
	});
	const frameMask = ABR.parse(new Uint8Array(frameFile), { name: 'frame' }).brushes[0].mask;

	let frameIdentical = true;
	for (let i = 0; i < frame.length; i++) {
		if (frameMask.data[i] !== frame[i]) { frameIdentical = false; break; }
	}
	ok(frameIdentical, 'a hollow-frame mask survives byte for byte');
	eq(frameMask.data[0], 255, 'its opaque corner stays opaque');
	eq(frameMask.data[16 * 32 + 16], 0, 'its hollow centre stays hollow');

	// A mask that merely *looks* inverted is equally untouchable.
	const flipped = invert(blob32);
	const flippedFile = buildAbr({
		major: 6, minor: 2,
		samples: [{ id: GUID_A, width: 32, height: 32, depth: 8, compression: 0, data: flipped }],
		presets: [sampledPreset('Inside out', { sampleId: GUID_A })]
	});
	const flippedMask = ABR.parse(new Uint8Array(flippedFile), { name: 'polarity' }).brushes[0].mask;

	let flippedIdentical = true;
	for (let i = 0; i < flipped.length; i++) {
		if (flippedMask.data[i] !== flipped[i]) { flippedIdentical = false; break; }
	}
	ok(flippedIdentical, 'an inside-out-looking mask is also passed through unchanged');

	// And the same holds through the RLE decoder and the downscaler.
	const bigFrame = makeFrameMask(4100, 4100);
	const bigFile = buildAbr({
		major: 6, minor: 2,
		samples: [{ id: GUID_A, width: 4100, height: 4100, depth: 8, compression: 1, data: bigFrame, vmal: VMAL_STANDARD }],
		presets: [sampledPreset('Big frame', { sampleId: GUID_A })]
	});
	const bigMask = ABR.parse(new Uint8Array(bigFile), { name: 'bigframe' }).brushes[0].mask;
	eq(bigMask.width, 2048, 'the oversized frame is downscaled for storage');
	ok(bigMask.data[0] > 200, 'its opaque border survives the downscale as opaque');
	eq(bigMask.data[(1024 * 2048) + 1024], 0, 'its hollow middle survives as hollow');
}

section('bitmaps with no descriptor block');
{
	const file = buildAbr({ major: 6, minor: 2, samples, presets: [], order: ['samp'] });
	const set = ABR.parse(new Uint8Array(file), { name: 'orphans' });
	eq(set.brushes.length, 3, 'synthesises presets from bare bitmaps');
	eq(set.brushes[0].kind, 'sampled', 'synthesised presets are sampled');
	eq(set.brushes[1].mask.width, 24, 'synthesised presets keep their bitmaps');
}

section('truncated file');
{
	const full = buildAbr({ major: 6, minor: 2, samples, presets });
	const cut = full.subarray(0, Math.floor(full.length * 0.55));
	const set = ABR.parse(new Uint8Array(cut), { name: 'truncated' });

	ok(set.warnings.length > 0, 'reports a warning instead of throwing');
	ok(Array.isArray(set.brushes), 'still returns a brush list');
}

section('old format (version 1)');
{
	const w = new Writer();
	w.i16(1);
	w.i16(0);
	w.u16(3);
	const set = ABR.parse(new Uint8Array(w.toBuffer()), { name: 'ancient' });

	eq(set.ok, false, 'rejects a version 1 file');
	ok(/predates|version 1/i.test(set.error), 'explains why: ' + set.error);
	eq(set.brushes.length, 0, 'returns no brushes');
}

section('empty and junk input');
{
	eq(ABR.parse(new Uint8Array(0), { name: 'empty' }).ok, false, 'rejects an empty buffer');
	eq(ABR.parse(new Uint8Array([0, 6, 0, 2]), { name: 'head' }).ok, false, 'rejects a header-only file');
	eq(ABR.looksLikeAbr(new Uint8Array([0, 6, 0, 2])), true, 'sniffs a version 6 header');
	eq(ABR.looksLikeAbr(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), false, 'rejects a PNG header');
	eq(ABR.looksLikeAbr(new Uint8Array([0, 9, 0, 1])), true, 'sniffs a version 9 header');
}

section('malformed block sizes are survivable');
{
	// A sample item whose declared length overruns the block.
	const w = new Writer();
	w.i16(6);
	w.i16(2);
	w.signature('8BIM');
	w.signature('samp');
	w.u32(8);
	w.u32(999999);
	w.zeroes(4);
	const set = ABR.parse(new Uint8Array(w.toBuffer()), { name: 'bad-length' });
	ok(set.warnings.length > 0, 'warns about the overrunning item');
	ok(Array.isArray(set.brushes), 'does not throw');
}

section('file identity (bridge helpers)');
{
	// bridge.js only reaches for `require` and only assigns a global, so it
	// loads safely under Node and its pure helpers can be unit-tested here.
	require('../js/bridge.js');
	const bridge = globalThis.BrushBoxBridge;

	ok(bridge && typeof bridge.fingerprint === 'function', 'bridge exposes fingerprint()');
	ok(bridge && typeof bridge.pathKey === 'function', 'bridge exposes pathKey()');

	if (bridge) {
		// The same bytes must always produce the same key, whatever route
		// they arrived by — this is what stops repeated loads duplicating.
		const a = bridge.fingerprint(new Uint8Array([1, 2, 3, 4, 5]));
		const b = bridge.fingerprint(new Uint8Array([1, 2, 3, 4, 5]));
		eq(a, b, 'fingerprint is deterministic');
		eq(a.length, 16, 'fingerprint is 64 bits of hex');

		ok(bridge.fingerprint(new Uint8Array([1, 2, 3, 4, 6])) !== a, 'a one-byte change alters the fingerprint');
		ok(bridge.fingerprint(new Uint8Array([1, 2, 3, 4])) !== a, 'a length change alters the fingerprint');
		ok(bridge.fingerprint(new Uint8Array([5, 4, 3, 2, 1])) !== a, 'a reordering alters the fingerprint');
		ok(bridge.fingerprint(new Uint8Array(0)).length === 16, 'handles an empty buffer');

		// No collisions across every generated fixture.
		const seen = new Map();
		let collisions = 0;
		for (const name of ['v6.2-brushes.abr', 'v6.1-brushes.abr', 'v10-brushes.abr']) {
			const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, name)));
			const key = bridge.fingerprint(bytes);
			if (seen.has(key)) collisions++;
			seen.set(key, name);
		}
		eq(collisions, 0, 'distinct fixtures get distinct fingerprints');
		eq(seen.size, 3, 'all three fixtures fingerprinted');

		// Paths must fold the ways the same file can be spelled.
		eq(bridge.pathKey('C:\\Brushes\\Set.abr'), bridge.pathKey('c:/brushes/set.abr'),
			'pathKey folds separators and case');
		eq(bridge.pathKey('/Users/x/Set.abr/'), bridge.pathKey('/Users/x/Set.abr'),
			'pathKey ignores a trailing separator');
		ok(bridge.pathKey('C:\\a\\one.abr') !== bridge.pathKey('C:\\a\\two.abr'),
			'pathKey keeps different files apart');
		eq(bridge.pathKey(null), null, 'pathKey of no path is null');

		// --- the load/duplicate/replace rule -----------------------------
		ok(typeof bridge.classifySource === 'function', 'bridge exposes classifySource()');

		if (typeof bridge.classifySource === 'function') {
			const open = { id: 'set-1', fingerprint: 'aaaa', pathKey: 'c:/a/one.abr' };
			const sets = [open];

			eq(bridge.classifySource([], 'aaaa', null).action, 'add',
				'an empty library accepts anything');
			eq(bridge.classifySource(sets, 'aaaa', 'c:/a/one.abr').action, 'duplicate',
				'same content is a duplicate');
			eq(bridge.classifySource([], 'aaaa', null).set, null, 'a fresh add has no matched set');

			// Same bytes reached by a different route (e.g. dragged in rather
			// than browsed to) is still recognised as the same set.
			eq(bridge.classifySource(sets, 'aaaa', null).action, 'duplicate',
				'content alone identifies a set with no path');
			eq(bridge.classifySource(sets, 'aaaa', null).set, open, 'the duplicate reports the open set');

			// Path match with different bytes means the file was edited.
			const changed = bridge.classifySource(sets, 'bbbb', 'c:/a/one.abr');
			eq(changed.action, 'replace', 'same path, new content is a replace');
			eq(changed.set, open, 'the replace reports which set to drop');

			eq(bridge.classifySource(sets, 'bbbb', 'c:/a/two.abr').action, 'add',
				'a genuinely different file is added');
			eq(bridge.classifySource(sets, 'bbbb', null).action, 'add',
				'no match on content or path is an add');

			// Path comparison must tolerate how the same path gets spelled.
			eq(bridge.classifySource(sets, 'bbbb', bridge.pathKey('C:\\A\\One.abr')).action, 'replace',
				'replace is found through a differently-spelled path');
		}
	}
}

section('descriptor strings are NUL-terminated');
{
	// Photoshop writes descriptor Unicode strings NUL-terminated, counting
	// the terminator in the length. Fixtures do the same, so this is the
	// test that would have caught the join bug.
	const file = buildAbr({
		major: 6, minor: 2,
		samples: [{ ...samples[0], vmal: VMAL_STANDARD }],
		presets: [sampledPreset('Nulled', { sampleId: GUID_A })]
	});
	const set = ABR.parse(new Uint8Array(file), { name: 'nul' });
	const brush = set.brushes[0];

	eq(brush.name, 'Nulled', 'a NUL-terminated name parses without the terminator');
	eq(brush.sampleId, GUID_A, 'a NUL-terminated sampledData parses without the terminator');
	eq(brush.sampleId.length, 36, 'the GUID is exactly 36 characters');
	ok(!/\u0000/.test(brush.name), 'no NUL survives in the name');
	ok(!/\u0000/.test(brush.sampleId), 'no NUL survives in the sampledData');
	ok(brush.mask !== null, 'the NUL-terminated GUID still joins to its bitmap');
}

section('brush identity is unique per parse');
{
	// The renderer caches rendered dabs by `brush.id`. If two files sharing a
	// filename produced the same ids, the second set's brushes would reuse the
	// first set's cached bitmaps and display the wrong art — the same filename
	// in two folders is all it takes.
	const fileA = buildAbr({ major: 6, minor: 2, samples, presets, order: ['samp', 'desc'] });
	const fileB = buildAbr({
		major: 6, minor: 2, samples: [],
		presets: [computedPreset('Other Brush', { diameter: 99 })]
	});

	const a = ABR.parse(new Uint8Array(fileA), { name: 'Brushes' });
	const b = ABR.parse(new Uint8Array(fileB), { name: 'Brushes' });

	const idsA = new Set(a.brushes.map((x) => x.id));
	eq(b.brushes.filter((x) => idsA.has(x.id)).length, 0,
		'two sets sharing a filename do not share brush ids');
	eq(b.brushes[0].source, 'Brushes', 'the display name is still the file stem');

	const all = new Set();
	let duplicates = 0;
	a.brushes.concat(b.brushes).forEach((brush) => {
		if (all.has(brush.id)) duplicates++;
		all.add(brush.id);
	});
	eq(duplicates, 0, 'ids are unique across every parsed brush');

	const again = ABR.parse(new Uint8Array(fileA), { name: 'Brushes' });
	ok(!idsA.has(again.brushes[0].id), 're-parsing the same file yields fresh ids');
}

section('large brush tips (above the old size cap)');
{
	// Photoshop's maximum brush diameter is 5000px, so a tip over 4096px on
	// a side is legitimate — and 4100x4100 is 16.8 megapixels, which the
	// earlier 16-megapixel guard rejected outright. That silently dropped the
	// mask, and the brush fell back to a synthesised blob.
	const bigW = 4100;
	const bigH = 4100;
	const bigMask = makeRingMask(bigW);
	const bigId = 'aaaa1111-bbbb-2222-cccc-333344445555';

	const file = buildAbr({
		major: 6, minor: 2,
		samples: [{ id: bigId, width: bigW, height: bigH, depth: 8, compression: 1, data: bigMask, vmal: VMAL_STANDARD }],
		presets: [sampledPreset('Huge Ring', { sampleId: bigId })]
	});

	// Kept on disk so the same case can be opened in the browser.
	fs.writeFileSync(path.join(FIXTURE_DIR, 'large-tip.abr'), file);

	const set = ABR.parse(new Uint8Array(file), { name: 'large-tip' });
	const brush = set.brushes[0];

	ok(brush.mask !== null, 'a 4100x4100 tip is not rejected as implausibly large');
	eq(set.stats.withMask, 1, 'its bitmap joins to the preset');

	if (brush.mask) {
		// Stored downscaled to the renderer's ceiling, so memory stays sane.
		eq(Math.max(brush.mask.width, brush.mask.height), 2048, 'the stored bitmap is capped at 2048 on its long edge');
		eq(brush.mask.sourceWidth, bigW, 'the original width is recorded');
		eq(brush.mask.sourceHeight, bigH, 'the original height is recorded');
		eq(brush.mask.data.length, brush.mask.width * brush.mask.height, 'the stored bitmap is exactly its stated size');

		// The tip must still report its real size, or "Native size" and every
		// export scale would be computed from the shrunken bitmap. The figure
		// comes from the tight content box — the ring spans 2x its outer
		// radius, i.e. 92% of the mask — and must be mapped back to the
		// original coordinate space, not the 2048px stored one.
		const reported = Render.naturalSize(brush);
		near(reported, Math.round(bigW * 0.92), 6, 'the tip reports its original-size extent, not the stored one');
		ok(reported > 2048, 'the reported size is well above the 2048 storage cap (' + reported + ')');
	}

	// A genuinely absurd claim must still be refused rather than allocated.
	const bogus = buildAbr({
		major: 6, minor: 2,
		samples: [{ id: bigId, width: 60000, height: 60000, depth: 8, compression: 0, data: new Uint8Array(16), vmal: VMAL_STANDARD }],
		presets: [sampledPreset('Bogus', { sampleId: bigId })]
	});
	const bogusSet = ABR.parse(new Uint8Array(bogus), { name: 'bogus' });
	ok(bogusSet.brushes[0].mask === null, 'a 60000x60000 claim is still refused');
}

section('corrupted input never throws or hangs');
{
	// Deterministic generator, so any failure is reproducible.
	let seed = 0x2f6e2b1;
	const rand = () => {
		seed ^= seed << 13; seed >>>= 0;
		seed ^= seed >>> 17;
		seed ^= seed << 5; seed >>>= 0;
		return seed / 0x100000000;
	};

	const base = buildAbr({ major: 6, minor: 2, samples, presets, order: ['samp', 'desc'] });

	// Bit flips anywhere in a valid file.
	let flipError = null;
	let usable = 0;
	const FLIPS = 300;

	for (let i = 0; i < FLIPS && !flipError; i++) {
		const bytes = new Uint8Array(base);
		const mutations = 1 + Math.floor(rand() * 12);
		for (let m = 0; m < mutations; m++) {
			bytes[Math.floor(rand() * bytes.length)] = Math.floor(rand() * 256);
		}
		try {
			const set = ABR.parse(bytes, { name: 'fuzz' });
			if (set && Array.isArray(set.brushes) && Array.isArray(set.warnings)) usable++;
			else flipError = 'mutation ' + i + ' returned a malformed result';
		} catch (err) {
			flipError = 'mutation ' + i + ': ' + err.message;
		}
	}
	ok(flipError === null, 'random bit flips never throw — ' + (flipError || 'all ' + FLIPS + ' survived'));
	eq(usable, FLIPS, 'every mutated file still returned a usable result');

	// Truncation at every offset.
	let truncError = null;
	for (let len = 0; len <= base.length; len += 7) {
		try {
			ABR.parse(new Uint8Array(base.subarray(0, len)), { name: 'trunc' });
		} catch (err) {
			truncError = 'at ' + len + ' bytes: ' + err.message;
			break;
		}
	}
	ok(truncError === null, 'truncation at any length is survivable — ' + (truncError || 'ok'));

	// Pure noise, half of it with a plausible header so it gets past the
	// version gate and into the block loop.
	let noiseError = null;
	for (let i = 0; i < 60; i++) {
		const bytes = new Uint8Array(64 + Math.floor(rand() * 8192));
		for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(rand() * 256);
		if (i % 2 === 0) { bytes[0] = 0; bytes[1] = 6; bytes[2] = 0; bytes[3] = 2; }
		try {
			ABR.parse(bytes, { name: 'noise' });
		} catch (err) {
			noiseError = err.message;
			break;
		}
	}
	ok(noiseError === null, 'random noise never throws — ' + (noiseError || 'ok'));

	// A file whose header claims a version we support but whose blocks are
	// nonsense must still fail softly rather than hang.
	const stall = new Uint8Array(4096);
	stall[0] = 0; stall[1] = 6; stall[2] = 0; stall[3] = 2;
	for (let i = 4; i < stall.length; i += 12) {
		stall[i] = 0x38; stall[i + 1] = 0x42; stall[i + 2] = 0x49; stall[i + 3] = 0x4d; // 8BIM
		stall[i + 4] = 0x73; stall[i + 5] = 0x61; stall[i + 6] = 0x6d; stall[i + 7] = 0x70; // samp
		// a zero length, so the walk has to make progress on its own
	}
	const stalled = ABR.parse(stall, { name: 'stall' });
	ok(Array.isArray(stalled.brushes), 'zero-length blocks do not stall the walk');
}

section('real-world files (optional)');
{
	// Drop any real .abr into test/real/ and it is checked here. Synthetic
	// fixtures only prove self-consistency; a real file is what proves the
	// parser agrees with Photoshop.
	const realDir = path.join(__dirname, 'real');
	const files = fs.existsSync(realDir)
		? fs.readdirSync(realDir).filter((f) => /\.abr$/i.test(f))
		: [];

	if (!files.length) {
		console.log('  (skipped — put real .abr files in test/real/ to enable)');
	} else {
		for (const name of files) {
			const bytes = new Uint8Array(fs.readFileSync(path.join(realDir, name)));
			const set = ABR.parse(bytes, { name });

			ok(set.brushes.length > 0, name + ': parses — ' + set.brushes.length + ' brushes, ' +
				set.samples.length + ' bitmaps');

			const sampled = set.brushes.filter((b) => b.kind === 'sampled');
			if (sampled.length) {
				const joined = sampled.filter((b) => b.mask).length;
				ok(joined === sampled.length,
					name + ': every sampled brush joins to its bitmap — ' + joined + '/' + sampled.length);
			}

			// A uniform set is perfectly legal — plenty of real files hold a
			// single brush — so only treat collapse as suspicious when the
			// file also left bitmaps unreferenced, which is the signature of a
			// broken join: every sampled brush falls back to the same blob.
			// Dual-brush tips count as referenced; omitting them makes almost
			// every real set look like it is shedding bitmaps.
			const usedIds = new Set();
			set.brushes.forEach((b) => {
				if (b.sampleId) usedIds.add(b.sampleId);
				const dual = b.dualBrush && b.dualBrush.shape && b.dualBrush.shape.sampledData;
				if (dual) usedIds.add(dual);
			});
			const unusedBitmaps = set.samples.filter((s) => !usedIds.has(s.id)).length;

			if (set.brushes.length > 1 && unusedBitmaps > 0) {
				const shapes = new Set(set.brushes.map((b) => [
					b.kind,
					b.mask ? b.mask.width + 'x' + b.mask.height : '-',
					Math.round(b.diameter),
					Math.round((b.roundness == null ? 1 : b.roundness) * 100)
				].join('/')));
				ok(shapes.size > 1, name + ': ' + set.brushes.length + ' brushes with ' + unusedBitmaps +
					' unreferenced bitmaps still render distinctly — ' + shapes.size + ' shapes');
			}

			const nul = set.brushes.filter((b) => /\u0000/.test(b.name) || /\u0000/.test(b.sampleId || ''));
			eq(nul.length, 0, name + ': no NUL characters survive in any name or id');
		}
	}
}

/* ==================================================================== *
 * Summary
 * ==================================================================== */

console.log('\n' + '─'.repeat(58));
if (failed) {
	console.log(`${failed} failed, ${passed} passed`);
	console.log('\nFailures:');
	for (const f of failures) console.log('  · ' + f);
	process.exit(1);
} else {
	console.log(`All ${passed} assertions passed.`);
	console.log('Fixtures written to test/fixtures/');
}
