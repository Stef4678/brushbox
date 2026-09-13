/*!
 * BrushBox — .eagleplugin packager
 * ---------------------------------------------------------------------
 * Builds a distributable `.eagleplugin` from the source tree.
 *
 * The format is a plain ZIP containing the runtime files at its root:
 *
 *     manifest.json  index.html  logo.png  css/  js/
 *
 * Nothing else belongs in it — no tests, tools, docs, screenshots or
 * package manager files — so the file list below is an explicit allowlist
 * rather than a "zip everything and exclude a few" rule. If a new runtime
 * asset is ever added it must be listed here, and the build fails loudly if
 * a listed file is missing.
 *
 * The archive is written by hand rather than with PowerShell's
 * `Compress-Archive`, which on Windows emits backslash entry names. The ZIP
 * specification, and every other Eagle plugin archive, uses forward
 * slashes.
 *
 *   node tools/make-package.js [version]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

/** Everything the plugin needs at runtime, in a sensible archive order. */
const RUNTIME_FILES = [
	'manifest.json',
	'index.html',
	'logo.png',
	'css/style.css',
	'js/bridge.js',
	'js/abr.js',
	'js/render.js',
	'js/app.js'
];

/* ------------------------------------------------------------------ *
 * CRC32 (the ZIP flavour — same polynomial the PNG writer uses)
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

/* ------------------------------------------------------------------ *
 * ZIP writing
 * ------------------------------------------------------------------ */

/**
 * A fixed timestamp keeps the archive byte-for-byte reproducible, so two
 * builds of the same source produce the same file. DOS time/date format:
 * bits 0-4 seconds/2, 5-10 minutes, 11-15 hours; 16-20 day, 21-25 month,
 * 26-31 year - 1980.
 */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01 00:00

function buildZip(entries) {
	const chunks = [];
	const central = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf8');
		const raw = entry.data;
		const deflated = zlib.deflateRawSync(raw, { level: 9 });

		// Store uncompressed when deflate cannot help (already-compressed PNGs).
		const useDeflate = deflated.length < raw.length;
		const body = useDeflate ? deflated : raw;
		const method = useDeflate ? 8 : 0;
		const crc = crc32(raw);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); // local file header
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0, 6); // flags
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18); // compressed size
		local.writeUInt32LE(raw.length, 22); // uncompressed size
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28); // extra length

		chunks.push(local, name, body);

		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50, 0); // central directory header
		header.writeUInt16LE(20, 4); // version made by
		header.writeUInt16LE(20, 6); // version needed
		header.writeUInt16LE(0, 8); // flags
		header.writeUInt16LE(method, 10);
		header.writeUInt16LE(DOS_TIME, 12);
		header.writeUInt16LE(DOS_DATE, 14);
		header.writeUInt32LE(crc, 16);
		header.writeUInt32LE(body.length, 20);
		header.writeUInt32LE(raw.length, 24);
		header.writeUInt16LE(name.length, 28);
		header.writeUInt16LE(0, 30); // extra
		header.writeUInt16LE(0, 32); // comment
		header.writeUInt16LE(0, 34); // disk start
		header.writeUInt16LE(0, 36); // internal attributes
		header.writeUInt32LE(0, 38); // external attributes
		header.writeUInt32LE(offset, 42); // local header offset

		central.push(header, name);
		offset += local.length + name.length + body.length;
	}

	const centralBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); // end of central directory
	end.writeUInt16LE(0, 4); // disk number
	end.writeUInt16LE(0, 6); // disk with central directory
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20); // comment length

	return Buffer.concat([...chunks, centralBuf, end]);
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

function main() {
	const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
	const version = process.argv[2] || manifest.version;

	if (version !== manifest.version) {
		console.error(`Version mismatch: manifest says ${manifest.version}, argument says ${version}.`);
		process.exit(1);
	}

	const missing = RUNTIME_FILES.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
	if (missing.length) {
		console.error('Missing runtime files: ' + missing.join(', '));
		process.exit(1);
	}

	const entries = RUNTIME_FILES.map((rel) => ({
		name: rel,
		data: fs.readFileSync(path.join(ROOT, rel))
	}));

	const zip = buildZip(entries);
	const outDir = path.join(ROOT, 'dist');
	fs.mkdirSync(outDir, { recursive: true });
	const outFile = path.join(outDir, `BrushBox-${version}.eagleplugin`);
	fs.writeFileSync(outFile, zip);

	console.log(`packed  ${path.relative(ROOT, outFile)}  (${zip.length.toLocaleString()} bytes, ${entries.length} files)`);
	for (const entry of entries) console.log(`  ${entry.name}`);
}

main();
