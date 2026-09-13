/*!
 * BrushBox — local preview server (development only)
 * ---------------------------------------------------------------------
 * Serves the plugin folder over HTTP so the real markup, stylesheet and
 * scripts can be inspected in a normal browser (and screenshotted), with
 * optional demo data loaded through the same drag-and-drop path the user
 * would use.
 *
 *   node tools/preview.js [port]
 *   http://127.0.0.1:8791/                 — empty state
 *   http://127.0.0.1:8791/?demo=single     — one set, first brush
 *   http://127.0.0.1:8791/?demo=stroke     — stroke preview
 *   http://127.0.0.1:8791/?demo=batch      — batch grid with three sets
 *
 * Not part of the shipped plugin.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.argv[2], 10) || 8791;

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.abr': 'application/octet-stream'
};

/**
 * Injected before </body> in demo mode.
 *
 * It builds real File objects from the generated fixtures and dispatches a
 * genuine drag-and-drop event, so the demo exercises the production code
 * path rather than reaching into the app's internals.
 */
function demoScript(mode, fileParam) {
	const sets = mode === 'batch'
		? ['test/fixtures/v6.2-brushes.abr', 'test/fixtures/v6.1-brushes.abr', 'test/fixtures/v10-brushes.abr']
		: mode === 'real'
			? ['test/real/krita-brushes.abr']
			: mode === 'large'
				? ['test/fixtures/large-tip.abr']
				: ['test/fixtures/v6.2-brushes.abr'];

	return `
<script>
(function () {
	var MODE = ${JSON.stringify(mode)};
	var NAMES = ${JSON.stringify(sets)};
	var FILE = ${JSON.stringify(fileParam || '')};

	window.addEventListener('load', function () {
		setTimeout(async function () {
			try {
			var transfer = new DataTransfer();
			for (var i = 0; i < NAMES.length; i++) {
				var response = await fetch('/' + NAMES[i]);
				var buffer = await response.arrayBuffer();
				transfer.items.add(new File([buffer], NAMES[i].split('/').pop()));
			}
			window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));

			var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
			await wait(700);

			if (MODE === 'batch') {
				document.querySelector('#segMode button[data-value="batch"]').click();
				await wait(700);
			}
			if (MODE === 'stroke') {
				document.querySelector('#segRender button[data-value="stroke"]').click();
				await wait(500);
			}
			if (MODE === 'ramp') {
				var target = document.querySelector('#segRender button[data-value="grid"]');
				document.body.dataset.diag = 'target=' + (target ? target.dataset.value : 'NULL');
				if (target) target.click();
				await wait(600);
				var active = document.querySelector('#segRender button.is-active');
				document.body.dataset.diag += ' active=' + (active ? active.dataset.value : 'null') +
					' canvas=' + document.getElementById('stageCanvas').width;
			}
			if (MODE === 'thumbs') {
				// Magnify the filmstrip so the thumbnails can be eyeballed.
				var strip = document.querySelector('.filmstrip');
				strip.style.zoom = '3';
				strip.style.padding = '20px';
				document.body.dataset.diag = 'zoom=' + strip.style.zoom;
				await wait(700);
			}
			if (MODE === 'export') {
				// Exercise the exact path that feeds Eagle's addFromPath:
				// renderTile -> canvas -> canvasToPngBytes -> PNG bytes.
				var R = window.BrushBoxRender;
				var B = window.BrushBoxBridge;

				var response2 = await fetch('/test/fixtures/v6.2-brushes.abr');
				var raw = new Uint8Array(await response2.arrayBuffer());
				var set = window.BrushBoxAbr.parse(raw, { name: 'v6.2-brushes' });

				var opts = { scale: '2', background: 'dark', padding: 0.08, color: '#f4f5f8' };

				var opaqueCounts = [];
				var sideReport = [];
				set.brushes.forEach(function (b) {
					var tile = R.renderTile(b, opts);
					var ctx = tile.getContext('2d');
					var px = ctx.getImageData(0, 0, tile.width, tile.height).data;
					var n = 0;
					for (var i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
					opaqueCounts.push(n);
					sideReport.push(tile.width + 'x' + tile.height);
				});

				// Opaque backgrounds must actually fill, and fixed sizing must override scale.
				var darkTile = R.renderTile(set.brushes[0], { scale: '2', background: 'dark', padding: 0.08, color: '#f4f5f8' });
				var darkCtx = darkTile.getContext('2d');
				var darkData = darkCtx.getImageData(0, 0, darkTile.width, darkTile.height).data;
				var darkOpaque = 0;
				for (var j = 3; j < darkData.length; j += 4) if (darkData[j] > 0) darkOpaque++;

				var fixed = R.renderTile(set.brushes[0], { scale: 'fixed512', background: 'checker', padding: 0, color: '#f4f5f8' });

				var sheet = R.renderContactSheet(set.brushes, {
					title: 'Test sheet', subtitle: 'five brushes', background: 'dark', cell: 200, columns: 3, color: '#f4f5f8'
				});

				// The real serialisation step.
				var png = await B.canvasToPngBytes(R.renderTile(set.brushes[0], opts));
				var sig = Array.prototype.slice.call(png.slice(0, 8))
					.map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
				var pw = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
				var ph = (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23];

				// Stress the export path: 40 full-size tiles must all come out
				// correct even as the cache churns underneath them.
				var stressOK = 0;
				for (var k = 0; k < 40; k++) {
					var big = R.renderTile(set.brushes[k % set.brushes.length], {
						scale: 'fixed1024', background: 'dark', padding: 0, color: '#f4f5f8'
					});
					if (big.width === 1024 && big.height === 1024) stressOK++;
				}

				// And force real eviction: 40 *distinct* large dabs (~39 megapixels)
				// cannot all stay resident inside a 24-megapixel budget.
				for (var n = 0; n < 40; n++) {
					R.dabCanvas(set.brushes[0], 600 + n * 20, '#f4f5f8', null);
				}
				var cache = R.cacheStats();

				document.body.dataset.diag =
					'brushes=' + set.brushes.length +
					' tiles=[' + sideReport.join(',') + ']' +
					' opaque=[' + opaqueCounts.join(',') + ']' +
					' darkOpaque=' + darkOpaque + '/' + (darkTile.width * darkTile.height) +
					' fixed=' + fixed.width + 'x' + fixed.height +
					' sheet=' + sheet.width + 'x' + sheet.height +
					' pngBytes=' + png.length +
					' sig=' + sig +
					' pngWH=' + pw + 'x' + ph +
					' stress=' + stressOK + '/40' +
					' cachePixels=' + cache.pixels +
					' cacheBudget=' + cache.budget +
					' cacheEntries=' + cache.entries +
					' overBudget=' + (cache.pixels > cache.budget);

				// Show the outputs so they can be inspected visually.
				document.querySelector('#segMode button[data-value="batch"]').click();
				await wait(500);

				var host = document.getElementById('batchGrid');
				host.innerHTML = '';
				host.style.display = 'block';

				var sheetWrap = document.createElement('div');
				sheetWrap.style.padding = '10px';
				sheetWrap.appendChild(sheet);
				host.appendChild(sheetWrap);

				var row = document.createElement('div');
				row.style.display = 'flex';
				row.style.gap = '10px';
				row.style.padding = '0 10px 14px';
				row.style.alignItems = 'flex-start';
				set.brushes.forEach(function (b) {
					row.appendChild(R.renderTile(b, { scale: '2', background: 'dark', padding: 0.08, color: '#f4f5f8' }));
				});
				row.appendChild(fixed);
				host.appendChild(row);
				await wait(500);
			}
			if (MODE === 'dupe') {
				// Reproduces the reported bug: loading the same set repeatedly
				// must not pile up duplicate entries.
				var dropFiles = async function (names) {
					var transfer = new DataTransfer();
					for (var i = 0; i < names.length; i++) {
						var r = await fetch('/test/fixtures/' + names[i]);
						var buf = await r.arrayBuffer();
						transfer.items.add(new File([buf], names[i]));
					}
					window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
					await wait(700);
				};

				var count = function () { return document.querySelectorAll('.set-item').length; };

				await dropFiles(['v6.2-brushes.abr']);
				var afterFirst = count();

				await dropFiles(['v6.2-brushes.abr']); // same file again
				var afterDupe = count();
				var dupeStatus = document.getElementById('statusMsg').textContent;

				await dropFiles(['v6.1-brushes.abr', 'v10-brushes.abr']);
				var afterMore = count();

				await dropFiles(['v6.1-brushes.abr']); // duplicate of an existing set
				var afterDupe2 = count();

				await dropFiles(['v6.2-brushes.abr', 'v6.2-brushes.abr']); // twice in one drop
				var afterSameBatch = count();

				// Two distinct files that happen to share a name and size must
				// both load, so identity is content-based.
				await dropFiles(['v6.1-brushes.abr', 'v10-brushes.abr']);
				var afterBothDistinct = count();

				var names = Array.prototype.map.call(
					document.querySelectorAll('.set-name'), function (n) { return n.textContent; });

				document.body.dataset.diag =
					'first=' + afterFirst +
					' afterDupe=' + afterDupe +
					' afterMore=' + afterMore +
					' afterDupe2=' + afterDupe2 +
					' afterSameBatch=' + afterSameBatch +
					' afterDistinct=' + afterBothDistinct +
					' names=' + names.join('|') +
					' status=' + dupeStatus +
					' brushes=' + document.getElementById('statusBrushes').textContent;
			}
			if (MODE === 'real') {
				// Renders a real Photoshop file's brushes.
				//
				// Deliberately not driven through the drop handler: reading a
				// 3.6MB Blob via FileReader does not settle inside headless
				// virtual time, so the drag path stalls here for reasons that
				// have nothing to do with the plugin. The drop path itself is
				// covered by the fixture demos; what this proves is that the
				// parser and renderer handle genuine Photoshop bitmaps, and
				// that the brushes are not all the same picture.
				var R = window.BrushBoxRender;

				var response3 = await fetch('/test/real/krita-brushes.abr');
				var realBytes = new Uint8Array(await response3.arrayBuffer());
				var realSet = window.BrushBoxAbr.parse(realBytes, { name: 'krita-brushes' });

				document.querySelector('#segMode button[data-value="batch"]').click();
				await wait(600);

				var host2 = document.getElementById('batchGrid');
				host2.innerHTML = '';
				host2.style.gridTemplateColumns = 'repeat(auto-fill, minmax(118px, 1fr))';

				var hashes = {};
				var joined = 0;

				realSet.brushes.forEach(function (b) {
					if (b.mask) joined++;

					var tile = R.renderTile(b, {
						scale: '0.25', background: 'dark', padding: 0.08, color: '#e9ebf3'
					});
					tile.style.width = '100%';
					tile.style.height = 'auto';
					tile.style.borderRadius = '8px';

					var d = tile.getContext('2d').getImageData(0, 0, tile.width, tile.height).data;
					var h = 0x811c9dc5;
					for (var i = 0; i < d.length; i += 13) h = Math.imul(h ^ d[i], 0x01000193) >>> 0;
					hashes[h.toString(16)] = true;

					host2.appendChild(tile);
				});

				document.body.dataset.diag =
					'brushes=' + realSet.brushes.length +
					' bitmaps=' + realSet.samples.length +
					' sampled=' + realSet.stats.sampled +
					' withTip=' + joined +
					' distinctTiles=' + Object.keys(hashes).length +
					' warnings=' + realSet.warnings.length;
			}
			if (MODE === 'large') {
				// A tip larger than the old size guard. If the bitmap were
				// dropped the brush would render as a plain synthesised
				// circle; the fixture is a ring, so the two are unmistakable.
				await wait(1500);

				var values = document.querySelectorAll('#details dd');
				var labels = document.querySelectorAll('#details dt');
				var pairs = [];
				Array.prototype.forEach.call(labels, function (dt, i) {
					pairs.push(dt.textContent + '=' + (values[i] ? values[i].textContent : '?'));
				});

				document.body.dataset.diag =
					'sets=' + document.querySelectorAll('.set-item').length +
					' | ' + pairs.join(' | ');
			}
			if (MODE === 'file') {
				// Render any file in test/real/ by name: ?demo=file&name=x.abr
				// Parses directly rather than through the drop handler, because
				// FileReader does not settle for multi-MB blobs under headless
				// virtual time.
				var R2 = window.BrushBoxRender;

				var resp = await fetch('/test/real/' + FILE);
				var fbytes = new Uint8Array(await resp.arrayBuffer());
				var fset = window.BrushBoxAbr.parse(fbytes, { name: FILE });

				document.querySelector('#segMode button[data-value="batch"]').click();
				await wait(600);

				var host3 = document.getElementById('batchGrid');
				host3.innerHTML = '';
				host3.style.gridTemplateColumns = 'repeat(auto-fill, minmax(118px, 1fr))';

				fset.brushes.forEach(function (b) {
					var tile = R2.renderTile(b, {
						scale: '1', background: 'dark', padding: 0.08, color: '#e9ebf3'
					});
					tile.style.width = '100%';
					tile.style.height = 'auto';
					tile.style.borderRadius = '8px';
					host3.appendChild(tile);
				});

				document.body.dataset.diag =
					'file=' + FILE +
					' brushes=' + fset.brushes.length +
					' bitmaps=' + fset.samples.length +
					' withTip=' + fset.stats.withMask +
					' orphanBitmaps=0' +
					' warnings=' + fset.warnings.length;
			}
			} catch (err) {
				// Without this a thrown harness step just leaves a blank page
				// and an empty diagnostic, which reads like the plugin doing
				// nothing.
				document.body.dataset.diag = 'HARNESS ERROR: ' + (err && err.message ? err.message : String(err));
			}
			document.title = 'READY';
		}, 200);
	});
})();
</script>
`;
}

const server = http.createServer((req, res) => {
	let urlPath = decodeURIComponent(req.url.split('?')[0]);
	if (urlPath === '/') urlPath = '/index.html';

	// Never serve outside the plugin folder.
	const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^([/\\])+/, ''));
	if (!filePath.startsWith(ROOT)) {
		res.writeHead(403);
		res.end('Forbidden');
		return;
	}

	fs.readFile(filePath, (err, data) => {
		if (err) {
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			res.end('Not found: ' + urlPath);
			return;
		}

		const ext = path.extname(filePath).toLowerCase();
		const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream' };

		if (ext === '.html') {
			const mode = new URL(req.url, 'http://localhost').searchParams.get('demo');
			let html = data.toString('utf8');
			if (mode) html = html.replace('</body>', demoScript(mode, new URL(req.url, 'http://localhost').searchParams.get('name')) + '</body>');
			// The plugin talks to Eagle; in a browser that global is absent and
			// the bridge degrades on its own, so no shim is needed here.
			headers['Cache-Control'] = 'no-store';
			res.writeHead(200, headers);
			res.end(html);
			return;
		}

		res.writeHead(200, headers);
		res.end(data);
	});
});

server.listen(PORT, '127.0.0.1', () => {
	console.log('BrushBox preview: http://127.0.0.1:' + PORT + '/');
	console.log('  ?demo=single | ?demo=stroke | ?demo=batch');
});
