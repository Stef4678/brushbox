/*!
 * BrushBox — .abr inspector (development tool)
 * ---------------------------------------------------------------------
 * Prints what the parser actually made of a file: block layout, bitmaps
 * found, presets read, and — most usefully — whether the `sampledData`
 * GUIDs in the `desc` block join to the ids in the `samp` block.
 *
 * A join failure is the classic "every brush looks the same" symptom: each
 * sampled brush falls back to a synthesised tip, so they all render as the
 * same soft blob.
 *
 *   node tools/inspect-abr.js <file.abr> [--ids]
 *
 * Not part of the shipped plugin.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ABR = require('../js/abr.js');

const file = process.argv[2];
const showIds = process.argv.includes('--ids');
const showCodes = process.argv.includes('--codes');
const showMasks = process.argv.includes('--masks');

if (!file) {
	console.error('usage: node tools/inspect-abr.js <file.abr> [--ids] [--codes] [--masks]');
	process.exit(2);
}

const bytes = new Uint8Array(fs.readFileSync(file));
const name = path.basename(file, path.extname(file));

console.log('file        ' + path.resolve(file));
console.log('size        ' + bytes.byteLength.toLocaleString() + ' bytes');

// --- raw block walk, independent of the parser ------------------------
console.log('\nblocks');
{
	const r = new ABR.Reader(bytes, 0);
	const major = r.i16();
	const minor = r.i16();
	console.log('  header    version ' + major + '.' + minor);

	while (r.offset + 12 <= r.length) {
		const at = r.offset;
		const signature = r.signature();
		if (signature !== '8BIM') {
			console.log('  ! lost alignment at 0x' + at.toString(16) + ' (read "' + signature + '")');
			break;
		}
		const type = r.signature();
		const size = r.u32();
		console.log('  ' + type + '        at 0x' + at.toString(16) + '  ' + size.toLocaleString() + ' bytes');
		r.seek(r.offset + size + ((4 - (size % 4)) % 4));
	}
}

// --- parsed result -----------------------------------------------------
const set = ABR.parse(bytes, { name });

console.log('\nparsed');
console.log('  version   ' + set.version);
console.log('  brushes   ' + set.brushes.length);
console.log('  bitmaps   ' + set.samples.length);
console.log('  with tip  ' + set.stats.withMask);
console.log('  computed  ' + set.stats.computed + ', sampled ' + set.stats.sampled + ', other ' + set.stats.other);

if (set.error) console.log('  error     ' + set.error);
if (set.warnings.length) {
	console.log('  warnings');
	set.warnings.forEach((w) => console.log('    - ' + w));
}

// --- the join ----------------------------------------------------------
const sampleIds = new Set(set.samples.map((s) => s.id));
const referenced = new Set();
const dualReferenced = new Set();

console.log('\njoin (preset.Brsh.sampledData  ->  samp item id)');
{
	let missing = 0;
	set.brushes.forEach((b) => {
		if (!b.sampleId) {
			if (b.kind === 'sampled') missing++;
		} else {
			referenced.add(b.sampleId);
			if (!sampleIds.has(b.sampleId)) missing++;
		}

		// Dual brushes point at a second tip. Leaving these out is what makes
		// the orphan count look alarming on files that are perfectly fine.
		const dual = b.dualBrush && b.dualBrush.shape && b.dualBrush.shape.sampledData;
		if (dual) dualReferenced.add(dual);
	});

	const allUsed = new Set([...referenced, ...dualReferenced]);
	const orphans = [...sampleIds].filter((id) => !allUsed.has(id));

	// Every brush that ends up with pixels, however it got them.
	const withTip = set.brushes.filter((b) => b.mask || b.dualTip).length;

	console.log('  presets             ' + set.brushes.length +
		'  (sampled ' + set.stats.sampled + ', computed ' + set.stats.computed + ', other ' + set.stats.other + ')');
	console.log('  main tips joined    ' + set.stats.withMask + ' / ' + referenced.size + ' referenced');
	console.log('  dual tips joined    ' + set.brushes.filter((b) => b.dualTip).length + ' / ' + dualReferenced.size + ' referenced');
	console.log('  brushes with pixels ' + withTip);
	console.log('  unresolved          ' + missing);
	console.log('  orphan bitmaps      ' + orphans.length +
		(orphans.length ? '  (' + orphans.slice(0, 3).join(', ') + ')' : ''));
}

if (showIds) {
	console.log('\nbitmap ids');
	set.samples.slice(0, 40).forEach((s, i) => {
		const used = referenced.has(s.id) ? 'referenced'
			: dualReferenced.has(s.id) ? 'dual tip'
				: 'ORPHAN';
		console.log('  [' + String(i).padStart(3) + '] ' + s.id + '  ' + s.width + 'x' + s.height + '  ' + used);
	});

	console.log('\npreset sample ids');
	set.brushes.slice(0, 40).forEach((b, i) => {
		const id = b.sampleId || '(none)';
		const ok = b.mask ? 'joined' : 'NO MASK';
		console.log('  [' + String(i).padStart(3) + '] ' + b.kind.padEnd(9) + ' ' + ok.padEnd(8) + ' ' + id + '  ' + b.name);
	});
}

if (showCodes) {
	// Photoshop writes descriptor Unicode strings NUL-terminated with the
	// terminator included in the length. Showing raw escapes makes that
	// visible, since a trailing \u0000 is invisible in plain output.
	console.log('\nraw string codes (first 5 presets)');
	set.brushes.slice(0, 5).forEach((b, i) => {
		console.log('  [' + i + '] name       ' + JSON.stringify(b.name) + '  len ' + b.name.length);
		console.log('      sampleId   ' + JSON.stringify(b.sampleId) + '  len ' + (b.sampleId || '').length);
	});
}

// --- shape sanity ------------------------------------------------------
const distinct = new Set();
set.brushes.forEach((b) => {
	distinct.add([b.kind, b.mask ? b.mask.width + 'x' + b.mask.height : '-', b.diameter, b.roundness, b.hardness].join('/'));
});
console.log('\nrendering');
console.log('  distinct brush shapes ' + distinct.size + ' of ' + set.brushes.length);
if (set.brushes.length > 1 && distinct.size === 1) {
	console.log('  ! every brush is identical — they will all render the same');
}

const downscaled = set.samples.filter((s) => s.sourceWidth);
console.log('  downscaled on load      ' + downscaled.length);
downscaled.slice(0, 5).forEach((s) =>
	console.log('    - ' + s.sourceWidth + 'x' + s.sourceHeight + ' -> ' + s.width + 'x' + s.height));

if (showMasks) {
	// Corner/centre/mean coverage. Useful for spotting a mask whose shape is
	// not what you expected — note that opaque corners with an empty centre
	// is a hollow stamp as often as it is anything else, so it is evidence,
	// not a verdict.
	console.log('\nmask coverage (corner / centre / mean)');
	set.samples.slice(0, 20).forEach((s, i) => {
		const d = s.data;
		const w = s.width;
		const h = s.height;
		const corners = [d[1 * w + 1], d[1 * w + (w - 2)], d[(h - 2) * w + 1], d[(h - 2) * w + (w - 2)]];
		const centre = d[(h >> 1) * w + (w >> 1)];
		let sum = 0;
		for (let k = 0; k < d.length; k++) sum += d[k];
		const mean = sum / d.length;

		console.log('  [' + String(i).padStart(3) + '] ' + (w + 'x' + h).padEnd(11) +
			' corners ' + corners.join(',').padEnd(18) +
			' centre ' + String(centre).padStart(3) +
			' mean ' + mean.toFixed(1).padStart(6));
	});
}
