/*!
 * BrushBox — Photoshop .abr parser
 * ---------------------------------------------------------------------
 * A from-scratch reader for Adobe Photoshop brush files, covering the
 * "new" format (versions 6, 7, 9 and 10, minor 1 and 2). Version 1 and 2
 * files use a completely different, pre-CS layout; they are detected and
 * reported clearly rather than mis-parsed.
 *
 * An .abr file is a series of 8BIM tagged blocks:
 *
 *   samp — the actual brush bitmaps (an "alpha" coverage mask per brush)
 *   desc — a Photoshop descriptor holding every brush preset's settings
 *   patt — texture patterns (not needed for previews; skipped)
 *   phry — brush hierarchy metadata (not needed; skipped)
 *
 * Sampled brushes are joined to their bitmap through a GUID: the preset
 * stores `sampledData` and the matching `samp` item carries the same GUID
 * as its Pascal-string id. Both blocks are therefore collected first and
 * joined at the end, which also tolerates a non-standard block order.
 *
 * Everything is big-endian, and every read is bounds-checked: a truncated
 * or malformed file degrades into warnings on the returned set instead of
 * throwing away the brushes that did parse.
 *
 * Format references:
 *   - ag-psd (MIT) src/abr.ts + src/descriptor.ts — the de-facto spec
 *   - archiveteam "Photoshop brush" + Prokoudine's reverse-engineered
 *     ABR specification (descriptor key semantics)
 *   - Adobe Photoshop File Formats Specification (descriptor structures)
 */
(function (root, factory) {
	var api = factory();
	if (typeof module === 'object' && module.exports) module.exports = api;
	if (root) root.BrushBoxAbr = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	/* ================================================================== *
	 * Errors
	 * ================================================================== */

	function AbrError(message, offset) {
		var error = new Error(message + (offset == null ? '' : ' (at 0x' + offset.toString(16) + ')'));
		error.name = 'AbrError';
		error.offset = offset;
		return error;
	}

	/* ================================================================== *
	 * Byte reader
	 * ================================================================== */

	function Reader(bytes, offset) {
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.offset = offset || 0;
		this.length = bytes.byteLength;
	}

	Reader.prototype.remaining = function () {
		return this.length - this.offset;
	};

	Reader.prototype.require = function (n) {
		if (this.offset + n > this.length) {
			throw AbrError('Unexpected end of file (needed ' + n + ' bytes)', this.offset);
		}
	};

	Reader.prototype.seek = function (offset) {
		this.offset = Math.max(0, Math.min(this.length, offset));
	};

	Reader.prototype.skip = function (n) {
		this.require(n);
		this.offset += n;
	};

	Reader.prototype.u8 = function () {
		this.require(1);
		return this.bytes[this.offset++];
	};

	Reader.prototype.i8 = function () {
		this.require(1);
		return this.view.getInt8(this.offset++);
	};

	Reader.prototype.u16 = function () {
		this.require(2);
		var v = this.view.getUint16(this.offset, false);
		this.offset += 2;
		return v;
	};

	Reader.prototype.i16 = function () {
		this.require(2);
		var v = this.view.getInt16(this.offset, false);
		this.offset += 2;
		return v;
	};

	Reader.prototype.u32 = function () {
		this.require(4);
		var v = this.view.getUint32(this.offset, false);
		this.offset += 4;
		return v;
	};

	Reader.prototype.i32 = function () {
		this.require(4);
		var v = this.view.getInt32(this.offset, false);
		this.offset += 4;
		return v;
	};

	Reader.prototype.f32 = function () {
		this.require(4);
		var v = this.view.getFloat32(this.offset, false);
		this.offset += 4;
		return v;
	};

	Reader.prototype.f64 = function () {
		this.require(8);
		var v = this.view.getFloat64(this.offset, false);
		this.offset += 8;
		return v;
	};

	/** Four-character OSType / signature. */
	Reader.prototype.signature = function () {
		this.require(4);
		var out = '';
		for (var i = 0; i < 4; i++) out += String.fromCharCode(this.bytes[this.offset + i]);
		this.offset += 4;
		return out;
	};

	Reader.prototype.ascii = function (n) {
		this.require(n);
		var out = '';
		for (var i = 0; i < n; i++) out += String.fromCharCode(this.bytes[this.offset + i]);
		this.offset += n;
		return out;
	};

	/**
	 * A Pascal string: a length byte then that many bytes.
	 *
	 * `padding` is the alignment the string is padded out to — ABR uses 1
	 * (no padding) for sample ids, while Photoshop's descriptor names use 4.
	 */
	Reader.prototype.pascalString = function (padding) {
		var length = this.u8();
		var value = '';
		if (length > 0) {
			this.require(length);
			for (var i = 0; i < length; i++) {
				value += String.fromCharCode(this.bytes[this.offset + i]);
			}
			this.offset += length;
		}
		if (padding > 1) {
			var pad = (padding - (length % padding)) % padding;
			this.skip(pad);
		}
		return value;
	};

	/** A UTF-16BE string prefixed with a 4-byte character count. */
	Reader.prototype.unicodeString = function () {
		var count = this.u32();
		if (count > 0x100000) throw AbrError('Implausible string length ' + count, this.offset - 4);
		var out = '';
		this.require(count * 2);
		for (var i = 0; i < count; i++) {
			out += String.fromCharCode(this.view.getUint16(this.offset, false));
			this.offset += 2;
		}

		// Photoshop counts a trailing NUL in the length — which is why the
		// spec reports `sampledData` as TEXT 37 for a 36-character UUID.
		// Left in place that byte silently breaks every GUID comparison, so
		// no preset joins to its bitmap and every sampled brush falls back
		// to a synthesised tip: the "every brush looks identical" symptom.
		// Writers that omit the terminator are common too, so strip one only
		// when it is actually there.
		if (out.length && out.charCodeAt(out.length - 1) === 0) {
			out = out.slice(0, -1);
		}

		return out;
	};

	/**
	 * Photoshop writes either a 4-character class id (length field 0) or a
	 * length-prefixed ASCII string.
	 */
	Reader.prototype.asciiStringOrClassId = function () {
		var length = this.i32();
		if (length < 0 || length > 0x100000) throw AbrError('Implausible string length ' + length, this.offset - 4);
		return this.ascii(length || 4);
	};

	/* ================================================================== *
	 * Descriptor structures
	 * ================================================================== */

	var UNITS = {
		'#Ang': 'Angle',
		'#Rsl': 'Density',
		'#Rlt': 'Distance',
		'#Nne': 'None',
		'#Prc': 'Percent',
		'#Pxl': 'Pixels',
		'#Mlm': 'Millimeters',
		'#Pnt': 'Points',
		'RrPi': 'Picas',
		'RrIn': 'Inches',
		'RrCm': 'Centimeters'
	};

	function readClassStructure(r) {
		return { name: r.unicodeString(), classID: r.asciiStringOrClassId() };
	}

	function readReferenceStructure(r) {
		var count = r.u32();
		var items = [];
		for (var i = 0; i < count; i++) {
			var type = r.signature();
			switch (type) {
				case 'prop': {
					var cls = readClassStructure(r);
					items.push({ type: type, name: cls.name, classID: cls.classID, keyID: r.asciiStringOrClassId() });
					break;
				}
				case 'Clss': {
					var c = readClassStructure(r);
					items.push({ type: type, name: c.name, classID: c.classID });
					break;
				}
				case 'Enmr': {
					var e = readClassStructure(r);
					items.push({
						type: type,
						name: e.name,
						classID: e.classID,
						typeID: r.asciiStringOrClassId(),
						enumValue: r.asciiStringOrClassId()
					});
					break;
				}
				case 'rele': {
					var rel = readClassStructure(r);
					items.push({ type: type, name: rel.name, classID: rel.classID, value: r.u32() });
					break;
				}
				case 'Idnt':
					items.push({ type: type, value: r.u32() });
					break;
				case 'indx':
					items.push({ type: type, value: r.u32() });
					break;
				case 'name':
					items.push({ type: type, value: r.unicodeString() });
					break;
				default:
					throw AbrError('Unknown reference type "' + type + '"', r.offset - 4);
			}
		}
		return items;
	}

	function readOSType(r, type, includeClass) {
		switch (type) {
			case 'obj ':
				return readReferenceStructure(r);

			case 'Objc':
			case 'GlbO':
				return readDescriptorStructure(r, includeClass);

			case 'VlLs': {
				var count = r.i32();
				if (count < 0 || count > 0x100000) throw AbrError('Implausible list length ' + count, r.offset - 4);
				var items = [];
				for (var i = 0; i < count; i++) {
					items.push(readOSType(r, r.signature(), includeClass));
				}
				return items;
			}

			case 'doub':
				return r.f64();

			case 'UntF': {
				var unit = r.signature();
				var value = r.f64();
				return { units: UNITS[unit] || unit, value: value };
			}

			case 'UnFl': {
				var ufUnit = r.signature();
				var ufValue = r.f32();
				return { units: UNITS[ufUnit] || ufUnit, value: ufValue };
			}

			case 'TEXT':
				return r.unicodeString();

			case 'enum':
				return r.asciiStringOrClassId() + '.' + r.asciiStringOrClassId();

			case 'long':
				return r.i32();

			case 'comp':
				return { low: r.u32(), high: r.u32() };

			case 'bool':
				return !!r.u8();

			case 'type':
			case 'GlbC':
				return readClassStructure(r);

			case 'alis': {
				var aliasLength = r.i32();
				return r.ascii(aliasLength);
			}

			case 'tdta': {
				var dataLength = r.i32();
				if (dataLength < 0 || dataLength > r.remaining()) {
					throw AbrError('Implausible raw data length ' + dataLength, r.offset - 4);
				}
				var slice = r.bytes.subarray(r.offset, r.offset + dataLength);
				r.skip(dataLength);
				return slice;
			}

			case 'ObAr': {
				r.i32(); // version, always 16
				r.unicodeString(); // name
				r.asciiStringOrClassId(); // "rationalPoint"
				var obCount = r.i32();
				var obItems = [];
				for (var k = 0; k < obCount; k++) {
					var axis = r.asciiStringOrClassId();
					r.signature(); // UnFl
					r.signature(); // unit
					var valuesCount = r.i32();
					var values = [];
					for (var j = 0; j < valuesCount; j++) values.push(r.f64());
					obItems.push({ type: axis, values: values });
				}
				return obItems;
			}

			case 'Pth ': {
				r.i32(); // total size
				var sig = r.signature();
				r.i32(); // path size (little-endian in the spec, but unused here)
				var chars = r.i32();
				var path = '';
				for (var p = 0; p < chars; p++) path += String.fromCharCode(r.view.getUint16(r.offset + p * 2, true));
				r.skip(chars * 2);
				return { sig: sig, path: path };
			}

			default:
				throw AbrError('Unsupported descriptor value type "' + type + '"', r.offset - 4);
		}
	}

	function readDescriptorStructure(r, includeClass) {
		var struct = readClassStructure(r);
		var object = includeClass ? { _name: struct.name, _classID: struct.classID } : {};
		var count = r.u32();
		if (count > 0x100000) throw AbrError('Implausible descriptor item count ' + count, r.offset - 4);

		for (var i = 0; i < count; i++) {
			var key = r.asciiStringOrClassId();
			var type = r.signature();
			object[key] = readOSType(r, type, includeClass);
		}
		return object;
	}

	/** A descriptor prefixed with its 4-byte version (always 16). */
	function readVersionAndDescriptor(r, includeClass) {
		var version = r.u32();
		if (version !== 16) throw AbrError('Invalid descriptor version ' + version, r.offset - 4);
		return readDescriptorStructure(r, includeClass);
	}

	/* ================================================================== *
	 * Descriptor value coercion
	 * ================================================================== */

	function asUnits(value) {
		return value && typeof value === 'object' && typeof value.value === 'number' ? value : null;
	}

	/** Percent values are stored 0–100; the model uses 0–1 ratios. */
	function percent(value, fallback) {
		var u = asUnits(value);
		if (!u) return fallback == null ? 1 : fallback;
		if (u.units === 'Percent') return u.value / 100;
		// Some writers emit the raw ratio under an unexpected unit.
		return u.value > 2 ? u.value / 100 : u.value;
	}

	function angle(value, fallback) {
		var u = asUnits(value);
		if (!u) return fallback == null ? 0 : fallback;
		if (u.units === 'Angle') return u.value;
		return u.value;
	}

	function pixels(value, fallback) {
		var u = asUnits(value);
		if (!u) return fallback == null ? 0 : fallback;
		return u.value;
	}

	function num(value, fallback) {
		return typeof value === 'number' ? value : (fallback == null ? 0 : fallback);
	}

	function bool(value) {
		return value === true;
	}

	function text(value) {
		return typeof value === 'string' ? value : '';
	}

	/* ================================================================== *
	 * Brush shape descriptors
	 * ================================================================== */

	var DYNAMICS_CONTROLS = [
		'off', 'fade', 'pen pressure', 'pen tilt', 'stylus wheel',
		'initial direction', 'direction', 'initial rotation', 'rotation'
	];

	var DYNAMIC_SHAPES = [
		'round point', 'round blunt', 'round curve', 'round angle', 'round fan',
		'flat point', 'flat blunt', 'flat curve', 'flat angle', 'flat fan'
	];

	var TIPS_SHAPES = [
		'erodible point', 'erodible flat', 'erodible round',
		'erodible square', 'erodible triangle', 'custom'
	];

	function parseDynamics(desc, warnings) {
		if (!desc || typeof desc !== 'object') return null;
		var index = num(desc.bVTy, 0);
		return {
			control: DYNAMICS_CONTROLS[index] || 'off',
			steps: num(desc.fStp, 0),
			jitter: percent(desc.jitter, 0),
			minimum: percent(desc['Mnm '], 0)
		};
	}

	/**
	 * Reads the `Brsh` shape descriptor, which decides whether this brush is
	 * parametric or bitmap-backed.
	 */
	function parseBrushShape(desc) {
		if (!desc || typeof desc !== 'object') return { type: 'unknown' };

		var classId = desc._classID;

		switch (classId) {
			case 'computedBrush':
				return {
					type: 'computed',
					size: pixels(desc.Dmtr, 1),
					angle: angle(desc.Angl, 0),
					roundness: percent(desc.Rndn, 1),
					hardness: percent(desc.Hrdn, 1),
					spacingOn: bool(desc.Intr),
					spacing: percent(desc.Spcn, 0.25),
					flipX: bool(desc.flipX),
					flipY: bool(desc.flipY)
				};

			case 'sampledBrush':
				return {
					type: 'sampled',
					size: pixels(desc.Dmtr, 1),
					angle: angle(desc.Angl, 0),
					roundness: percent(desc.Rndn, 1),
					hardness: null,
					spacingOn: bool(desc.Intr),
					spacing: percent(desc.Spcn, 0.25),
					flipX: bool(desc.flipX),
					flipY: bool(desc.flipY),
					tipName: text(desc['Nm  ']),
					sampledData: text(desc.sampledData)
				};

			case 'dBrush':
				return {
					type: 'dynamic',
					size: pixels(desc.Dmtr, 1),
					angle: angle(desc.Angl, 0),
					roundness: 1,
					hardness: null,
					spacingOn: bool(desc.Intr),
					spacing: percent(desc.Spcn, 0.25),
					flipX: bool(desc.flipX),
					flipY: bool(desc.flipY),
					shape: DYNAMIC_SHAPES[num(desc['Shp '], 0)] || 'round point',
					density: percent(desc.Dnst, 1),
					length: percent(desc.Lngt, 1),
					clumping: percent(desc.clumping, 1),
					thickness: percent(desc.thickness, 1),
					stiffness: percent(desc.stiffness, 1),
					physics: bool(desc.physics)
				};

			case 'dTips':
				return {
					type: 'tips',
					size: pixels(desc.Dmtr, 1),
					angle: angle(desc.Angl, 0),
					roundness: 1,
					hardness: percent(desc.dtipsHardness, 0.8),
					spacingOn: bool(desc.Intr),
					spacing: percent(desc.Spcn, 0.25),
					flipX: bool(desc.flipX),
					flipY: bool(desc.flipY),
					tipsType: TIPS_SHAPES[num(desc.dtipsType, 0)] || 'erodible round',
					shape: DYNAMIC_SHAPES[num(desc['Shp '], 0)] || 'round point',
					tipsLengthRatio: percent(desc.dtipsLengthRatio, 1),
					physics: bool(desc.physics)
				};

			default:
				return { type: 'unknown', classId: classId || '(none)' };
		}
	}

	/* ================================================================== *
	 * PackBits (RLE) decoding
	 * ================================================================== */

	/**
	 * Decodes one PackBits row into `out` starting at `outOffset`.
	 *
	 * `sampleStep` is 1 for 8-bit data and 2 for 16-bit (only the high byte
	 * is kept), so the same walker serves both depths.
	 *
	 * `byteLength` is the number of compressed bytes for this row; the row
	 * is padded out to exactly `width` samples, and the reader is forced to
	 * the end of the row afterwards so a malformed stream cannot desync the
	 * whole image.
	 */
	function decodePackBitsRow(r, out, outOffset, width, byteLength, sampleStep) {
		var rowStart = r.offset;
		var rowEnd = rowStart + byteLength;
		var x = 0;
		var p = outOffset;

		while (r.offset < rowEnd && x < width) {
			var header = r.u8();
			if (header > 128) {
				// Run: 257 - header copies of the next byte.
				var value = r.u8();
				var run = 257 - header;
				while (run-- > 0 && x < width) {
					out[p] = value;
					p += sampleStep;
					x++;
				}
			} else if (header < 128) {
				// Literal: header + 1 raw bytes.
				var literal = header + 1;
				while (literal-- > 0 && x < width) {
					out[p] = r.u8();
					p += sampleStep;
					x++;
				}
			}
			// header === 128 is a no-op by definition.
		}

		r.seek(rowEnd);
	}

	/* ================================================================== *
	 * 'samp' block
	 * ================================================================== */

	/**
	 * Hard ceiling on a bitmap we will even attempt to decode.
	 *
	 * Photoshop's maximum brush diameter is 5000 px, so a legitimate tip can
	 * be ~25 megapixels; this leaves headroom above that while still
	 * refusing an absurd size claimed by a corrupt file (the transient
	 * allocation is one mask, so 64 megapixels is ~64MB).
	 */
	var MAX_MASK_PIXELS = 64 * 1024 * 1024;
	var MAX_MASK_EDGE = 8192;

	/**
	 * Longest edge kept in memory for a decoded mask.
	 *
	 * Matches the renderer's own output ceiling, so nothing that could ever
	 * be drawn is lost — but a 4274 px tip is stored as 2048 px rather than
	 * 18MB of pixels that only ever get scaled down. That matters for sets
	 * of large brushes, where full-resolution masks would add up to
	 * hundreds of megabytes.
	 */
	var MAX_STORE_EDGE = 2048;

	/**
	 * Box-filters an oversized mask down to `maxEdge` on its long side,
	 * recording the original size so the UI can still report it.
	 */
	function downscaleMask(mask, maxEdge) {
		var w = mask.width;
		var h = mask.height;
		var longest = Math.max(w, h);
		if (longest <= maxEdge) return mask;

		var factor = longest / maxEdge;
		var tw = Math.max(1, Math.round(w / factor));
		var th = Math.max(1, Math.round(h / factor));
		var src = mask.data;
		var out = new Uint8Array(tw * th);

		for (var y = 0; y < th; y++) {
			var y0 = Math.floor((y * h) / th);
			var y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / th));

			for (var x = 0; x < tw; x++) {
				var x0 = Math.floor((x * w) / tw);
				var x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / tw));
				var sum = 0;
				var count = 0;

				for (var sy = y0; sy < y1; sy++) {
					var rowBase = sy * w;
					for (var sx = x0; sx < x1; sx++) {
						sum += src[rowBase + sx];
						count++;
					}
				}

				out[y * tw + x] = count ? Math.round(sum / count) : 0;
			}
		}

		return {
			id: mask.id,
			width: tw,
			height: th,
			data: out,
			sourceWidth: w,
			sourceHeight: h,
		};
	}

	/** The offset ag-psd and friends hard-code for the 6.2 bitmap body. */
	var FLAT_MINOR2_OFFSET = 264;

	function warnOnce(warnings, message) {
		if (warnings.indexOf(message) === -1) warnings.push(message);
	}

	function readSampleBlock(r, size, minorVersion, warnings) {
		var end = r.offset + size;
		var samples = [];

		while (r.offset < end) {
			var brushLength = r.u32();
			// Item lengths are padded up to a 4-byte boundary.
			while (brushLength & 3) brushLength++;

			var brushEnd = r.offset + brushLength;
			if (brushEnd > end + 4) {
				warnings.push('A brush bitmap claims more data than the block holds; stopping.');
				break;
			}

			var id = r.pascalString(1);

			var bitmap = null;
			try {
				bitmap = minorVersion === 1
					? readBitmapMinor1(r, warnings)
					: readBitmapMinor2(r, warnings);
			} catch (err) {
				warnings.push('A brush bitmap could not be decoded: ' + err.message);
			}

			if (bitmap && bitmap.width > 0 && bitmap.height > 0) {
				bitmap = downscaleMask(bitmap, MAX_STORE_EDGE);
				bitmap.id = id;
				samples.push(bitmap);
			}

			r.seek(brushEnd);
		}

		r.seek(end);
		return samples;
	}

	/**
	 * Minor version 1 layout: eight opaque bytes and a 16-bit depth field,
	 * then the same bounds/depth/compression prologue as minor 2.
	 */
	function readBitmapMinor1(r, warnings) {
		r.skip(10);
		return readBoundedBitmap(r, warnings);
	}

	/**
	 * Minor version 2 layout: the bitmap lives inside a virtual memory
	 * array list (the same container PSD uses for channel data).
	 *
	 * The widely-copied shortcut is to skip a flat 264 bytes and read the
	 * bounds that follow. That constant is derived, not documented: it only
	 * holds when the array declares 56 channels *and* the bitmap sits in
	 * channel 55, because 264 = 32-byte VMAL header + 55 four-byte
	 * "absent channel" markers + the 12-byte prologue of channel 55.
	 *
	 * So the records are walked properly here, and the flat offset is kept
	 * purely as a fallback for files that do not walk cleanly.
	 */
	function readBitmapMinor2(r, warnings) {
		var start = r.offset;

		var record = readVirtualMemoryBitmap(r, warnings);
		if (record) {
			r.seek(record.dataOffset);
			var bitmap = decodeBitmapData(r, record.width, record.height, record.depth, record.compression, warnings);
			if (bitmap) return bitmap;
		}

		warnOnce(warnings,
			'Walked the bitmap channel list for at least one brush without a clean match; ' +
			'fell back to the fixed 6.2 offset.');
		r.seek(start + FLAT_MINOR2_OFFSET);
		return readBoundedBitmap(r, warnings);
	}

	/**
	 * Walks the virtual memory array list and returns the record that
	 * actually carries a bitmap, or null if the structure does not walk
	 * cleanly.
	 *
	 * A candidate is only accepted when its declared payload length exactly
	 * matches the size implied by its bounds, depth and compression — a
	 * strong check that catches a misaligned walk rather than silently
	 * returning a garbage bitmap.
	 */
	function readVirtualMemoryBitmap(r, warnings) {
		var position = r.offset;

		try {
			r.skip(4); // two unknown 16-bit fields (observed as 00 01 / 00 00)
			if (r.u32() !== 3) return null; // VMAL version
			var vmalLength = r.u32();
			if (vmalLength <= 0 || vmalLength > r.length) return null;

			r.skip(16); // bounds rectangle
			var channelCount = r.u32();
			if (channelCount === 0 || channelCount > 512) return null;

			var chosen = null;

			for (var i = 0; i < channelCount + 2; i++) {
				var present = r.u32();
				if (!present) continue;

				var recordLength = r.u32(); // 23 bytes of prologue + payload
				var depth = r.u32();
				var top = r.i32();
				var left = r.i32();
				var bottom = r.i32();
				var right = r.i32();
				r.u16(); // duplicated pixel depth
				var compression = r.u8();

				var payload = recordLength - 23;
				if (payload < 0 || payload > r.remaining()) return null;

				var candidate = {
					index: i,
					width: right - left,
					height: bottom - top,
					depth: depth,
					compression: compression,
					dataOffset: r.offset,
					dataLength: payload
				};

				// The alpha channel is written last, so a later match wins.
				if (payloadMatchesBounds(r, candidate)) chosen = candidate;

				r.skip(payload);
			}

			return chosen;
		} catch (err) {
			return null;
		} finally {
			r.seek(position);
		}
	}

	/** True when a channel record's payload is exactly the size its header implies. */
	function payloadMatchesBounds(r, record) {
		var w = record.width;
		var h = record.height;

		if (w <= 0 || h <= 0) return false;
		if (w > MAX_MASK_EDGE || h > MAX_MASK_EDGE || w * h > MAX_MASK_PIXELS) return false;

		if (record.compression === 0) {
			return record.dataLength === w * h * (record.depth === 16 ? 2 : 1);
		}

		if (record.compression === 1) {
			if (record.dataLength < h * 2) return false;
			// RLE rows are prefixed by one 16-bit byte count each.
			var total = h * 2;
			for (var y = 0; y < h; y++) {
				total += r.view.getUint16(record.dataOffset + y * 2, false);
				if (total > record.dataLength) return false;
			}
			return total === record.dataLength;
		}

		return false;
	}

	/** Reads a bounds/depth/compression prologue followed by pixel data. */
	function readBoundedBitmap(r, warnings) {
		var top = r.i32();
		var left = r.i32();
		var bottom = r.i32();
		var right = r.i32();
		var height = bottom - top;
		var width = right - left;

		if (width <= 0 || height <= 0) {
			warnings.push('Skipped a brush bitmap with invalid bounds (' + width + '×' + height + ').');
			return null;
		}
		if (width > MAX_MASK_EDGE || height > MAX_MASK_EDGE || width * height > MAX_MASK_PIXELS) {
			warnings.push('Skipped an implausibly large brush bitmap (' + width + '×' + height + ').');
			return null;
		}

		var depth = r.i16();
		var compression = r.u8();
		return decodeBitmapData(r, width, height, depth, compression, warnings);
	}

	function decodeBitmapData(r, width, height, depth, compression, warnings) {
		if (width <= 0 || height <= 0) return null;
		if (width > MAX_MASK_EDGE || height > MAX_MASK_EDGE || width * height > MAX_MASK_PIXELS) return null;

		var alpha = new Uint8Array(width * height);

		if (depth === 8) {
			if (compression === 0) {
				r.require(width * height);
				alpha.set(r.bytes.subarray(r.offset, r.offset + width * height));
				r.skip(width * height);
			} else if (compression === 1) {
				var rows8 = new Uint16Array(height);
				for (var y8 = 0; y8 < height; y8++) rows8[y8] = r.u16();
				for (var row8 = 0; row8 < height; row8++) {
					decodePackBitsRow(r, alpha, row8 * width, width, rows8[row8], 1);
				}
			} else {
				warnings.push('Skipped a bitmap with unknown compression ' + compression + '.');
				return null;
			}
		} else if (depth === 16) {
			if (compression === 0) {
				for (var i16 = 0; i16 < alpha.length; i16++) alpha[i16] = r.u16() >> 8;
			} else if (compression === 1) {
				var rows16 = new Uint16Array(height);
				for (var y16 = 0; y16 < height; y16++) rows16[y16] = r.u16();
				var scratch = new Uint8Array(width * 2);
				for (var row16 = 0; row16 < height; row16++) {
					scratch.fill(0);
					decodePackBitsRow(r, scratch, 0, width, rows16[row16], 2);
					var dst = row16 * width;
					for (var c = 0; c < width; c++) alpha[dst + c] = scratch[c * 2];
				}
			} else {
				warnings.push('Skipped a bitmap with unknown compression ' + compression + '.');
				return null;
			}
		} else {
			warnings.push('Skipped a bitmap with unsupported depth ' + depth + '.');
			return null;
		}

		return { width: width, height: height, data: alpha };
	}

	/**
	 * Mask polarity is never second-guessed.
	 *
	 * An earlier version flipped masks whose corners were opaque and whose
	 * centre was empty, on the theory that this meant a black-on-white tip.
	 * Real files disproved it: a hollow rectangle stamp has exactly those
	 * statistics and is perfectly correct as stored, so the rule inverted
	 * legitimately-rendered brushes. Mask bytes are now handed to the
	 * renderer exactly as they appear in the file.
	 */

	/* ================================================================== *
	 * 'desc' block
	 * ================================================================== */

	function readDescBlock(r, size, warnings) {
		var end = r.offset + size;
		var brushes = [];

		try {
			var root = readVersionAndDescriptor(r, true);
			var list = root && root.Brsh;

			if (!Array.isArray(list)) {
				warnings.push('The brush description block had no brush list.');
				r.seek(end);
				return brushes;
			}

			for (var i = 0; i < list.length; i++) {
				var preset = list[i];
				if (!preset || typeof preset !== 'object') continue;
				brushes.push(parsePreset(preset, i));
			}
		} catch (err) {
			warnings.push('The brush description block could not be fully read: ' + err.message);
		}

		r.seek(end);
		return brushes;
	}

	function parsePreset(preset, index) {
		var shape = parseBrushShape(preset.Brsh);

		// A name that is only whitespace collapses to nothing when normalised,
		// so the fallback has to be applied *after* trimming.
		var name = (text(preset['Nm  ']) || text(shape.tipName)).replace(/\s+/g, ' ').trim() ||
			'Brush ' + (index + 1);

		var brush = {
			index: index,
			name: name,
			kind: shape.type,
			diameter: Math.max(1, shape.size || 1),
			spacing: preset.Spcn != null ? percent(preset.Spcn, 0.25) : (shape.spacing == null ? 0.25 : shape.spacing),
			spacingOn: shape.spacingOn !== false,
			hardness: shape.hardness == null ? null : clamp01(shape.hardness),
			angle: shape.angle || 0,
			roundness: shape.roundness == null ? 1 : clamp01(shape.roundness),
			flipX: !!shape.flipX,
			flipY: !!shape.flipY,
			wetEdges: bool(preset.Wtdg),
			noise: bool(preset.Nose),
			sampleId: shape.sampledData || null,
			mask: null,
			shape: shape,
			shapeDynamics: null,
			scatter: null,
			texture: null,
			dualBrush: null,
			colorDynamics: null,
			transfer: null,
			toolOptions: null,
			warnings: [],
			raw: preset
		};

		if (bool(preset.useTipDynamics)) {
			brush.shapeDynamics = {
				sizeDynamics: parseDynamics(preset.szVr, brush.warnings),
				angleDynamics: parseDynamics(preset.angleDynamics, brush.warnings),
				roundnessDynamics: parseDynamics(preset.roundnessDynamics, brush.warnings),
				minimumDiameter: percent(preset.minimumDiameter, 0),
				minimumRoundness: percent(preset.minimumRoundness, 0),
				tiltScale: percent(preset.tiltScale, 1),
				flipX: bool(preset.flipX),
				flipY: bool(preset.flipY),
				brushProjection: bool(preset.brushProjection)
			};
		}

		if (bool(preset.useScatter)) {
			brush.scatter = {
				count: num(preset['Cnt '], 1),
				bothAxes: bool(preset.bothAxes),
				countDynamics: parseDynamics(preset.countDynamics, brush.warnings),
				scatterDynamics: parseDynamics(preset.scatterDynamics, brush.warnings)
			};
		}

		if (bool(preset.useTexture) && preset.Txtr) {
			brush.texture = {
				id: text(preset.Txtr.Idnt),
				name: text(preset.Txtr['Nm  ']),
				invert: bool(preset.InvT),
				scale: percent(preset.textureScale, 1),
				brightness: num(preset.textureBrightness, 0),
				contrast: num(preset.textureContrast, 0),
				depth: percent(preset.textureDepth, 1),
				depthMinimum: percent(preset.minimumDepth, 0),
				eachTip: bool(preset.TxtC),
				blendMode: text(preset.textureBlendMode)
			};
		}

		var dual = preset.dualBrush;
		if (dual && bool(dual.useDualBrush)) {
			brush.dualBrush = {
				flip: bool(dual.Flip),
				shape: parseBrushShape(dual.Brsh),
				blendMode: text(dual.BlnM),
				spacing: percent(dual.Spcn, 0.25),
				count: num(dual['Cnt '], 1),
				bothAxes: bool(dual.bothAxes)
			};
		}

		if (bool(preset.usePaintDynamics)) {
			brush.transfer = {
				flowDynamics: parseDynamics(preset.prVr, brush.warnings),
				opacityDynamics: parseDynamics(preset.opVr, brush.warnings)
			};
		}

		if (bool(preset.useColorDynamics)) {
			brush.colorDynamics = {
				foregroundBackground: parseDynamics(preset.clVr, brush.warnings),
				hue: percent(preset['H   '], 0),
				saturation: percent(preset.Strt, 0),
				brightness: percent(preset.Brgh, 0),
				purity: percent(preset.purity, 0)
			};
		}

		var tool = preset.toolOptions;
		if (tool && typeof tool === 'object') {
			brush.toolOptions = {
				type: tool._classID === 'MixB' ? 'mixer brush' : tool._classID === 'SmTl' ? 'smudge brush' : 'brush',
				opacity: num(tool.Opct, 100),
				flow: num(tool.flow, 100),
				mode: text(tool['Md  ']) || 'BlnM.Nrml'
			};
		}

		return brush;
	}

	function clamp01(v) {
		return v < 0 ? 0 : v > 1 ? 1 : v;
	}

	/* ================================================================== *
	 * Entry point
	 * ================================================================== */

	var SUPPORTED_MAJOR = [6, 7, 9, 10];

	/** Makes brush ids unique across every parse, not just within one file. */
	var parseSerial = 0;

	/**
	 * Parses an .abr file.
	 *
	 * @param {Uint8Array} bytes
	 * @param {{name?: string}} [options]
	 * @returns {object} a brush set: { name, version, brushes, warnings, stats }
	 */
	function parse(bytes, options) {
		var opts = options || {};
		var name = opts.name || 'Brushes';

		if (!bytes || !bytes.byteLength) {
			return failedSet(name, 'The file is empty.');
		}
		if (bytes.byteLength < 4) {
			return failedSet(name, 'The file is too small to be an .abr file.');
		}

		var r = new Reader(bytes, 0);
		var warnings = [];

		var major = r.i16();
		var minor = r.i16();

		if (major === 1 || major === 2) {
			return failedSet(
				name,
				'This is a Photoshop ' + (major === 1 ? '1' : '2') + ' era brush file (version ' + major + '.' +
				minor + '), which predates the block format BrushBox reads. Re-save it from a modern Photoshop to convert it.'
			);
		}

		if (SUPPORTED_MAJOR.indexOf(major) === -1) {
			return failedSet(name, 'Unsupported .abr version ' + major + '.' + minor + '.');
		}

		if (minor !== 1 && minor !== 2) {
			warnings.push('Unusual minor version ' + minor + '; reading on a best-effort basis.');
		}

		var samples = [];
		var brushes = [];

		while (r.offset + 12 <= r.length) {
			var blockStart = r.offset;

			var signature = r.signature();
			if (signature !== '8BIM') {
				warnings.push('Lost block alignment at 0x' + blockStart.toString(16) + '; stopping.');
				break;
			}

			var type = r.signature();
			var size = r.u32();
			var end = r.offset + size;

			if (size < 0 || end > r.length) {
				warnings.push('The "' + type + '" block is truncated; stopping.');
				break;
			}

			try {
				if (type === 'samp') {
					samples = samples.concat(readSampleBlock(r, size, minor, warnings));
				} else if (type === 'desc') {
					brushes = brushes.concat(readDescBlock(r, size, warnings));
				} else {
					// 'patt' and 'phry' carry textures and hierarchy metadata
					// that previews do not need.
					r.seek(end);
				}
			} catch (err) {
				warnings.push('The "' + type + '" block failed to parse: ' + err.message);
			}

			// Blocks are padded to a 4-byte boundary.
			r.seek(end + ((4 - (size % 4)) % 4));

			if (r.offset <= blockStart) {
				warnings.push('Parser made no progress; stopping.');
				break;
			}
		}

		// Join sampler bitmaps to presets by GUID.
		var byId = {};
		for (var s = 0; s < samples.length; s++) {
			if (!byId[samples[s].id]) byId[samples[s].id] = samples[s];
		}

		// Count distinct bitmaps, not presets: several presets may legitimately
		// share one tip, and decrementing per preset would under-report how
		// many bitmaps went unused (or drive the count negative).
		var referenced = {};

		for (var b = 0; b < brushes.length; b++) {
			var brush = brushes[b];
			if (brush.sampleId && byId[brush.sampleId]) {
				brush.mask = byId[brush.sampleId];
				referenced[brush.sampleId] = true;
			} else if (brush.kind === 'sampled') {
				brush.warnings.push('The bitmap for this brush is missing from the file; showing a synthesised tip instead.');
			}

			// A dual brush carries a *second* sampled tip. It is not drawn on
			// its own, but the file genuinely references it — and on most real
			// sets it is the only thing pointing at those bitmaps. Counting
			// just the main tip reports them as garbage and warns about
			// bitmaps that are in fact perfectly well used.
			var dualId = brush.dualBrush && brush.dualBrush.shape && brush.dualBrush.shape.sampledData;
			if (dualId && byId[dualId]) {
				brush.dualTip = byId[dualId];
				referenced[dualId] = true;
			}
		}

		// Files that carry bitmaps but no descriptor list still deserve to be
		// browsable, so synthesise presets from the samples.
		if (!brushes.length && samples.length) {
			warnings.push('No brush settings block was found; showing the raw bitmaps.');
			for (var k = 0; k < samples.length; k++) {
				brushes.push({
					index: k,
					name: 'Brush ' + (k + 1),
					kind: 'sampled',
					diameter: Math.max(samples[k].width, samples[k].height),
					spacing: 0.25,
					spacingOn: true,
					hardness: null,
					angle: 0,
					roundness: 1,
					flipX: false,
					flipY: false,
					wetEdges: false,
					noise: false,
					sampleId: samples[k].id,
					mask: samples[k],
					shape: { type: 'sampled' },
					warnings: [],
					shapeDynamics: null, scatter: null, texture: null,
					dualBrush: null, colorDynamics: null, transfer: null, toolOptions: null
				});
			}
		}

		// Give every brush an identity for caching. It must be unique across
		// *all* parsed sets, not derived from the file name: two files that
		// happen to share a name (the same set kept in two folders, say) would
		// otherwise produce identical ids, and the renderer's dab cache —
		// which is keyed on this id — would hand the second set the first
		// set's bitmaps.
		var setToken = 'abr' + (++parseSerial);
		for (var n = 0; n < brushes.length; n++) {
			brushes[n].id = setToken + '#' + n;
			brushes[n].source = name;
		}

		var stats = {
			total: brushes.length,
			computed: 0,
			sampled: 0,
			withMask: 0,
			other: 0
		};
		for (var t = 0; t < brushes.length; t++) {
			var kind = brushes[t].kind;
			if (kind === 'computed') stats.computed++;
			else if (kind === 'sampled') stats.sampled++;
			else stats.other++;
			if (brushes[t].mask) stats.withMask++;
		}

		// Distinct bitmaps that no preset pointed at. Comparing distinct sets
		// rather than list lengths keeps this honest when presets share a tip
		// or when a file repeats an id.
		var unusedSamples = Object.keys(byId).length - Object.keys(referenced).length;

		if (unusedSamples > 0) {
			warnings.push(unusedSamples + ' bitmap' + (unusedSamples === 1 ? '' : 's') + ' in the file are not referenced by any brush.');
		}
		return {
			name: name,
			version: major + '.' + minor,
			majorVersion: major,
			minorVersion: minor,
			bytes: bytes.byteLength,
			brushes: brushes,
			samples: samples,
			warnings: warnings,
			stats: stats,
			ok: brushes.length > 0
		};
	}

	function failedSet(name, message) {
		return {
			name: name,
			version: null,
			majorVersion: null,
			minorVersion: null,
			bytes: 0,
			brushes: [],
			samples: [],
			warnings: [message],
			stats: { total: 0, computed: 0, sampled: 0, withMask: 0, other: 0 },
			error: message,
			ok: false
		};
	}

	/** Cheap sniff used to validate a file before parsing it. */
	function looksLikeAbr(bytes) {
		if (!bytes || bytes.byteLength < 4) return false;
		var major = (bytes[0] << 8) | bytes[1];
		return SUPPORTED_MAJOR.indexOf(major) !== -1 || major === 1 || major === 2;
	}

	return {
		parse: parse,
		looksLikeAbr: looksLikeAbr,
		Reader: Reader,
		readVersionAndDescriptor: readVersionAndDescriptor,
		supportedVersions: SUPPORTED_MAJOR
	};
});
