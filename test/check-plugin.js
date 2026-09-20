/*!
 * BrushBox — plugin integrity check
 * ---------------------------------------------------------------------
 * Static checks that catch the failures a browser would only surface at
 * runtime: element ids the controller expects but the markup lacks,
 * assets the markup points at but that do not exist, a manifest that
 * would fail Eagle's review, or Eagle API calls leaking outside the
 * bridge layer.
 *
 *   node test/check-plugin.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function ok(condition, label) {
	if (condition) {
		passed++;
	} else {
		failed++;
		console.log('  ✗ ' + label);
	}
}

function section(title) {
	console.log('\n' + title);
}

function read(relative) {
	return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function exists(relative) {
	return fs.existsSync(path.join(ROOT, relative));
}

/* ==================================================================== *
 * JavaScript syntax
 * ==================================================================== */

section('JavaScript compiles');
{
	const files = ['js/abr.js', 'js/render.js', 'js/bridge.js', 'js/app.js', 'tools/make-logo.js', 'test/run-tests.js'];
	for (const file of files) {
		let message = null;
		try {
			new vm.Script(read(file), { filename: file });
		} catch (err) {
			message = err.message;
		}
		ok(message === null, file + ' parses' + (message ? ' — ' + message : ''));
	}
}

/* ==================================================================== *
 * Manifest
 * ==================================================================== */

section('manifest.json');
{
	let manifest = null;
	let parseError = null;
	try {
		manifest = JSON.parse(read('manifest.json'));
	} catch (err) {
		parseError = err.message;
	}

	ok(parseError === null, 'is valid JSON' + (parseError ? ' — ' + parseError : ''));

	if (manifest) {
		ok(typeof manifest.id === 'string' && manifest.id.length > 0, 'has a non-empty id');

		// The Plugin Center rejects anything that is not a canonical UUID, and
		// the installed folder is named after the id. Eagle's own bundled
		// plugins use short slugs, which is why a slug looks plausible until
		// submission fails.
		const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		ok(UUID.test(manifest.id || ''), 'id is a canonical UUID: ' + manifest.id);
		ok(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.version || ''),
			'version is semver: ' + manifest.version);
		ok(manifest.name === 'BrushBox', 'name is BrushBox');
		ok((manifest.name || '').length <= 30, 'name is within Eagle\'s 30-character limit');
		ok((manifest.name || '').trim().split(/\s+/).length <= 6, 'name is at most six words');
		ok(['all', 'mac', 'win'].includes(manifest.platform), 'platform is valid: ' + manifest.platform);
		ok(['all', 'arm', 'x64'].includes(manifest.arch), 'arch is valid: ' + manifest.arch);
		ok(manifest.devTools === false, 'devTools is false (required for review)');
		ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0, 'has keywords for search');

		const description = manifest.description || '';
		ok(description.length > 0, 'has a description');
		ok(description.length <= 200, 'description is within 200 characters (' + description.length + ')');

		const main = manifest.main || {};
		ok(main.url === 'index.html', 'main.url points at index.html');
		ok(typeof main.width === 'number' && typeof main.height === 'number', 'declares a window size');
		ok(main.minWidth > 0 && main.minHeight > 0, 'declares minimum window dimensions');
		ok(main.frame === false, 'uses a frameless window (custom title bar)');
		ok(/^#[0-9a-f]{3,8}$/i.test(main.backgroundColor || ''), 'declares a background colour: ' + main.backgroundColor);
		ok(!('devTools' in main), 'devTools is not duplicated inside main');

		// The three-pane layout needs room for rail + stage + inspector.
		const minTotal = main.minWidth;
		ok(minTotal >= 1040, 'minWidth leaves room for all three panes (' + minTotal + ')');
	}
}

/* ==================================================================== *
 * Assets
 * ==================================================================== */

section('Assets');
{
	ok(exists('logo.png'), 'logo.png exists');

	if (exists('logo.png')) {
		const png = fs.readFileSync(path.join(ROOT, 'logo.png'));
		const isPng = png.length > 24 &&
			png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
		ok(isPng, 'logo.png is a real PNG');

		if (isPng) {
			const width = png.readUInt32BE(16);
			const height = png.readUInt32BE(20);
			ok(width === height, 'logo is square (' + width + '×' + height + ')');
			ok(width === 128, 'logo is 128×128 as Eagle documents (' + width + ')');
		}
	}
}

/* ==================================================================== *
 * Markup <-> controller contract
 * ==================================================================== */

section('Markup and controller agree');
{
	const html = read('index.html');
	const app = read('js/app.js');

	const htmlIds = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
	ok(htmlIds.size > 40, 'index.html declares ' + htmlIds.size + ' element ids');

	// The cacheElements() array is the controller's contract with the markup.
	const cacheMatch = app.match(/cacheElements\(\)\s*\{[\s\S]*?\[([\s\S]*?)\]\.forEach/);
	ok(cacheMatch !== null, 'found the cacheElements() id list in app.js');

	if (cacheMatch) {
		const expected = Array.from(cacheMatch[1].matchAll(/'([^']+)'/g), (m) => m[1]);
		const missing = expected.filter((id) => !htmlIds.has(id));
		ok(missing.length === 0, 'every cached id exists in index.html' +
			(missing.length ? ' — missing: ' + missing.join(', ') : ''));

		// Every id the markup declares should be reachable, or at least the
		// controller should not reference ids that do not exist (above).
		ok(expected.length >= 60, 'controller caches ' + expected.length + ' elements');
	}

	// Any other direct getElementById lookups must also resolve.
	const direct = Array.from(app.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g), (m) => m[1]);
	const directMissing = direct.filter((id) => !htmlIds.has(id));
	ok(directMissing.length === 0, 'no stray getElementById targets' +
		(directMissing.length ? ' — missing: ' + directMissing.join(', ') : ''));

	// Duplicate ids would make getElementById return the wrong node.
	const allIds = Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]);
	const duplicates = allIds.filter((id, index) => allIds.indexOf(id) !== index);
	ok(duplicates.length === 0, 'no duplicate ids in index.html' +
		(duplicates.length ? ' — ' + duplicates.join(', ') : ''));
}

/* ==================================================================== *
 * Asset references
 * ==================================================================== */

section('Referenced files exist');
{
	const html = read('index.html');
	const refs = [
		...Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g), (m) => m[1]),
		...Array.from(html.matchAll(/<link[^>]+href="([^"]+)"/g), (m) => m[1]),
		...Array.from(html.matchAll(/<img[^>]+src="([^"]+)"/g), (m) => m[1])
	];

	ok(refs.length >= 6, 'index.html references ' + refs.length + ' files');

	const missing = refs.filter((ref) => !/^https?:/i.test(ref) && !exists(ref.replace(/^\//, '')));
	ok(missing.length === 0, 'every referenced file exists' + (missing.length ? ' — missing: ' + missing.join(', ') : ''));

	// Load order matters: app.js depends on the other three.
	const order = Array.from(html.matchAll(/<script[^>]+src="js\/([^"]+)"/g), (m) => m[1]);
	const expectedOrder = ['bridge.js', 'abr.js', 'render.js', 'app.js'];
	ok(JSON.stringify(order) === JSON.stringify(expectedOrder),
		'scripts load in dependency order — got ' + order.join(', '));
}

/* ==================================================================== *
 * README images
 * ==================================================================== */

section('README images');
{
	// A broken image link is invisible until someone views the repo, and the
	// README has already been re-pointed at new files once.
	const readme = read('README.md');
	const images = Array.from(readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g), (m) => m[1]);

	ok(images.length > 0, 'README embeds ' + images.length + ' images');

	const broken = images.filter((src) => !/^https?:/i.test(src) && !exists(decodeURI(src)));
	ok(broken.length === 0, 'every README image resolves' +
		(broken.length ? ' — missing: ' + broken.join(', ') : ''));

	// Catch a stale pointer at a directory that no longer exists.
	const stale = Array.from(readme.matchAll(/\]\((docs\/screenshots\/[^)]+)\)/g), (m) => m[1]);
	ok(stale.length === 0, 'no README references to the retired docs/screenshots/ directory' +
		(stale.length ? ' — ' + stale.join(', ') : ''));
}

/* ==================================================================== *
 * Layering
 * ==================================================================== */

section('Layering');
{
	// Strip comments first: prose that *names* the API is not a call to it.
	const stripComments = (source) =>
		source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

	// The bridge is the only place allowed to touch the Eagle host; that is
	// what keeps the rest of the plugin testable outside Eagle.
	const offenders = [];
	for (const file of ['js/abr.js', 'js/render.js', 'js/app.js']) {
		const code = stripComments(read(file));
		code.split('\n').forEach((line, index) => {
			if (/\beagle\s*\./.test(line)) offenders.push(file + ':' + (index + 1));
		});
	}
	ok(offenders.length === 0, 'no direct eagle.* calls outside bridge.js' +
		(offenders.length ? ' — ' + offenders.join(', ') : ''));

	// The parser must stay free of DOM and host dependencies so the Node
	// test suite can exercise it.
	const abr = stripComments(read('js/abr.js'));
	ok(!/\bdocument\b/.test(abr), 'abr.js does not touch the DOM');
	ok(!/\bwindow\./.test(abr), 'abr.js does not touch window');
	ok(/module\.exports/.test(abr), 'abr.js is require()-able from Node');

	// The renderer must not reach for the host either.
	ok(!/\beagle\b/.test(stripComments(read('js/render.js'))), 'render.js does not reference Eagle');
}

/* ==================================================================== *
 * Renderer/parser interface
 * ==================================================================== */

section('Module interfaces');
{
	const abr = read('js/abr.js');
	const render = read('js/render.js');
	const bridge = read('js/bridge.js');

	for (const name of ['parse', 'looksLikeAbr']) {
		ok(new RegExp('\\b' + name + '\\s*:').test(abr), 'abr.js exports ' + name + '()');
	}
	for (const name of ['renderStage', 'renderThumb', 'renderTile', 'renderContactSheet', 'naturalSize', 'clearCache', 'cacheStats']) {
		ok(new RegExp('\\b' + name + '\\s*:').test(render), 'render.js exports ' + name + '()');
	}
	for (const name of ['addCanvasToLibrary', 'chooseAbrFiles', 'getFolders', 'readFileBytes', 'notify', 'available', 'fingerprint', 'pathKey', 'classifySource']) {
		ok(new RegExp('\\b' + name + '\\s*:').test(bridge), 'bridge.js exports ' + name + '()');
	}

	// Re-loading an already-open set must be filtered before it reaches the
	// set list, or repeated loads pile up duplicates.
	const app = read('js/app.js');
	ok(/classifySource\(/.test(app), 'the controller asks classifySource() before adding a set');
	ok(/action === 'duplicate'/.test(app), 'duplicates are skipped');
	ok(/action === 'replace'/.test(app), 'a changed file replaces its stale copy');

	// `addFromPath` is the only Eagle adder that accepts a filesystem path,
	// and the plugin stages PNGs in temp precisely so it can use it.
	ok(/addFromPath/.test(bridge), 'bridge uses eagle.item.addFromPath');
	ok(!/item\.add\s*\(/.test(bridge), 'bridge does not call the non-existent eagle.item.add()');
	ok(!/addFromBuffer/.test(bridge), 'bridge does not call the non-existent addFromBuffer()');
}

/* ==================================================================== *
 * Export defaults
 * ==================================================================== */

section('Export defaults');
{
	const html = read('index.html');
	const app = read('js/app.js');

	// The default brush colour is near-white, so a transparent default
	// background would bake a white brush onto an invisible backdrop and the
	// imported Eagle items would look blank. Guard the pairing.
	const selectedBg = /<select[^>]+id="selectBg"[\s\S]*?<option value="([^"]+)"\s+selected/.exec(html);
	ok(selectedBg !== null, 'selectBg declares a selected option');
	if (selectedBg) {
		ok(selectedBg[1] === 'dark', 'output background defaults to dark (got "' + selectedBg[1] + '")');
	}

	const appBg = /background:\s*'([a-z]+)',\s*\n\s*tags:/.exec(app);
	ok(appBg !== null, 'app.js declares an output background default');
	if (appBg) {
		ok(appBg[1] === 'dark', 'output.background defaults to dark (got "' + appBg[1] + '")');
	}

	// A light default brush colour is what makes Dark the right backdrop.
	const colour = /preview:\s*\{[\s\S]*?color:\s*'(#[0-9a-f]{6})'/i.exec(app);
	ok(colour !== null, 'app.js declares a preview colour default');
	if (colour) {
		const rgb = colour[1].slice(1).match(/../g).map((h) => parseInt(h, 16));
		const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
		ok(luminance > 0.7, 'default brush colour is light (' + colour[1] + ', luminance ' + luminance.toFixed(2) + ')');
	}

	// Both selects must offer the same four backdrops.
	const bgOptions = Array.from(html.matchAll(/<select[^>]+id="selectBg"[\s\S]*?<\/select>/g))
		.flatMap((m) => Array.from(m[0].matchAll(/value="([a-z]+)"/g), (o) => o[1]));
	ok(JSON.stringify(bgOptions) === JSON.stringify(['dark', 'transparent', 'light', 'checker']),
		'background options are dark/transparent/light/checker — got ' + bgOptions.join(', '));
}

/* ==================================================================== *
 * File safety
 * ==================================================================== */

section('Exports never replace a file');
{
	// Comments come out first: bridge.js names these calls in prose.
	const bridge = read('js/bridge.js')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');

	// Every filesystem write in the plugin lives in the bridge, and every one
	// of them must create exclusively — `wx` makes the write fail with EEXIST
	// when the name is taken rather than truncating what is already there.
	// A plain write here would silently reintroduce the collision the review
	// rejected, so it is worth a standing check.
	const writes = Array.from(bridge.matchAll(/writeFileSync\([\s\S]*?\);/g), (m) => m[0]);
	ok(writes.length > 0, 'bridge.js writes files (' + writes.length + ' call site' +
		(writes.length === 1 ? '' : 's') + ')');

	const exclusive = writes.filter((call) => /flag:\s*'wx'/.test(call));
	ok(exclusive.length === writes.length,
		'every writeFileSync creates exclusively (' + exclusive.length + '/' + writes.length + ' use wx)');

	ok(/requestedFileName/.test(bridge) && /renamed:/.test(bridge),
		'bridge.js reports the name it wrote and whether it had to change');

	const app = read('js/app.js');
	ok(/saveCanvasToFolder\(/.test(app), 'app.js exports through saveCanvasToFolder()');
	ok(/saved\.renamed/.test(app), 'app.js discloses a rename instead of hiding it');

	// The three flows the review named — current-brush PNG, Ctrl/Cmd+S and the
	// contact sheet — all run through that one helper.
	const helper = (app.match(/saveCanvasToFolder\(/g) || []).length;
	ok(helper >= 2, 'both the brush export and the contact sheet call it (' + helper + ' call sites)');
	ok(/key\.toLowerCase\(\) === 's'[\s\S]{0,120}exportCurrentPng\(\)/.test(app),
		'the Ctrl/Cmd+S shortcut reuses the same export flow');
}

/* ==================================================================== *
 * Summary
 * ==================================================================== */

console.log('\n' + '─'.repeat(58));
if (failed) {
	console.log(failed + ' failed, ' + passed + ' passed');
	process.exit(1);
} else {
	console.log('All ' + passed + ' checks passed.');
}
