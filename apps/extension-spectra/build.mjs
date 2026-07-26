/**
 * SPECTRA esbuild pipeline.
 * Default output is a minified production extension; development modes are explicit.
 */

import esbuild from 'esbuild';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { minify } from 'terser';
import { checkProductionArtifacts } from './scripts/check-production-artifacts.mjs';
import { writeI18nAssets } from './scripts/i18n-assets.ts';
import { productionMangleOptions } from './scripts/minification-policy.mjs';

const projectDir = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(projectDir, 'dist');
const publicDir = resolve(projectDir, 'public');
const contentContractsRuntime = resolve(
	projectDir,
	'../../packages/contracts/src/spectra.content-runtime.ts',
);
const contentAudioEngineRuntime = resolve(
	projectDir,
	'../../packages/features/audio-engine/src/content-runtime.ts',
);
const contentKernelRuntime = resolve(
	projectDir,
	'../../packages/nexus-kernel/src/content-runtime.ts',
);
const contractsIndexPath = resolve(projectDir, '../../packages/contracts/src/index.ts');
const packageJson = JSON.parse(readFileSync(resolve(projectDir, 'package.json'), 'utf8'));
const version = packageJson.version;

const isWatch = process.argv.includes('--watch');
const isDev = process.argv.includes('--dev') || isWatch;
const isAnalyze = process.argv.includes('--analyze');
const emitSourceMap = process.argv.includes('--sourcemap');

const entries = [
	{
		entry: 'src/background/index.ts',
		out: 'background.js',
		format: 'esm',
		sharingDomain: 'background-service-worker',
	},
	{
		entry: 'src/content/core/bootstrap.ts',
		out: 'content-bootstrap.js',
		sharingDomain: 'isolated-bootstrap',
	},
	{
		entry: 'src/content/injector/fullscreen-bridge.ts',
		out: 'content-fullscreen-bridge.js',
		sharingDomain: 'main-fullscreen-bridge',
	},
	{
		entry: 'src/content/injector/page-media-bridge.ts',
		out: 'content-page-media-bridge.js',
		sharingDomain: 'main-page-media-bridge',
	},
	{
		entry: 'src/content/core/index.ts',
		out: 'content-runtime.js',
		sharingDomain: 'isolated-runtime',
	},
	{
		entry: 'src/content/video/video-effects-controller.ts',
		out: 'content-video-effects.js',
		format: 'esm',
		sharingDomain: 'isolated-video-module',
	},
	{ entry: 'src/popup/index.ts', out: 'popup.js' },
	{ entry: 'src/offscreen/index.ts', out: 'offscreen.js' },
	{ entry: 'src/options/index.ts', out: 'options.js' },
];

const vendorEntries = [
	{
		entry: 'src/offscreen-remote/peerjs-vendor.ts',
		out: 'peerjs-vendor.js',
		format: 'iife',
		sharingDomain: 'offscreen-vendor',
	},
];

const allEntries = [...vendorEntries, ...entries];

const isolatedEntries = entries.filter(({ out }) => out.startsWith('content-'));
const backgroundEntries = entries.filter(
	({ sharingDomain }) => sharingDomain === 'background-service-worker',
);
const moduleEntries = entries.filter(
	({ out, sharingDomain }) => (
		!out.startsWith('content-')
		&& sharingDomain !== 'background-service-worker'
	),
);
const moduleEntryGroups = [
	{
		name: 'extension',
		entries: moduleEntries,
		sharingDomain: 'extension-pages',
	},
];

function namedContractExports() {
	const valueExports = new Map();
	const typeExports = new Set();
	const source = readFileSync(contractsIndexPath, 'utf8');
	for (const match of source.matchAll(
		/\bexport\s+(type\s+)?\{([^}]*)\}\s*from\s*['"](\.\/[^'"]+)['"]\s*;/gu,
	)) {
		const modulePath = resolve(dirname(contractsIndexPath), match[3]);
		for (const rawSpecifier of match[2].split(',')) {
			const specifier = rawSpecifier
				.replace(/\/\*[\s\S]*?\*\//gu, '')
				.replace(/\/\/.*$/gu, '')
				.trim();
			if (!specifier) continue;
			const isType = Boolean(match[1]) || specifier.startsWith('type ');
			const normalized = specifier.replace(/^type\s+/u, '');
			const [localName, exportedName = localName] = normalized.split(/\s+as\s+/u);
			if (isType) {
				typeExports.add(exportedName.trim());
				continue;
			}
			valueExports.set(exportedName.trim(), {
				localName: localName.trim(),
				modulePath,
			});
		}
	}
	return { typeExports, valueExports };
}

const { typeExports: contractTypeExports, valueExports: contractValueExports } = namedContractExports();

function runtimeContractNames(importer) {
	const names = new Set();
	const source = readFileSync(importer, 'utf8');
	for (const match of source.matchAll(
		/\b(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]@nexus\/contracts['"]\s*;?/gu,
	)) {
		if (match[1]) continue;
		for (const rawSpecifier of match[2].split(',')) {
			const specifier = rawSpecifier
				.replace(/\/\*[\s\S]*?\*\//gu, '')
				.replace(/\/\/.*$/gu, '')
				.trim();
			if (!specifier || specifier.startsWith('type ')) continue;
			names.add(specifier.split(/\s+as\s+/u)[0].trim());
		}
	}
	return names;
}

function contractRuntimeFacade(importer) {
	const byModule = new Map();
	for (const exportedName of runtimeContractNames(importer)) {
		const binding = contractValueExports.get(exportedName);
		if (!binding) {
			// TypeScript permits type-only symbols in a normal import declaration.
			// esbuild erases those specifiers, so the runtime facade must not pull in
			// their source modules or report them as missing value exports.
			if (contractTypeExports.has(exportedName)) continue;
			throw new Error(`${importer}: unknown @nexus/contracts runtime export ${exportedName}`);
		}
		const bindings = byModule.get(binding.modulePath) ?? [];
		bindings.push(binding.localName === exportedName
			? exportedName
			: `${binding.localName} as ${exportedName}`);
		byModule.set(binding.modulePath, bindings);
	}
	return [...byModule.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([modulePath, bindings]) => (
			`export { ${bindings.sort().join(', ')} } from ${JSON.stringify(modulePath.replaceAll('\\', '/'))};`
		))
		.join('\n');
}

function contractRuntimeFacadePlugin() {
	const namespace = 'spectra-contract-runtime';
	return {
		name: 'spectra-contract-runtime-facade',
		setup(build) {
			build.onResolve({ filter: /^@nexus\/contracts$/ }, (args) => {
				if (!args.importer) return null;
				return { path: resolve(args.importer), namespace };
			});
			build.onLoad({ filter: /.*/, namespace }, (args) => ({
				contents: contractRuntimeFacade(args.path),
				loader: 'ts',
				resolveDir: dirname(args.path),
			}));
		},
	};
}

function runTypecheck() {
	try {
		execFileSync(process.execPath, ['tsc', '--noEmit', '--skipLibCheck'], { cwd: projectDir, stdio: 'pipe' });
	} catch (error) {
		const detail = [error.stdout, error.stderr]
			.map((stream) => stream?.toString().trim())
			.filter(Boolean)
			.join('\n') || error.message;
		throw new Error(`TypeScript check failed:\n${detail}`);
	}
}

function prepareDist() {
	rmSync(distDir, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 100,
	});
	mkdirSync(distDir, { recursive: true });
	cpSync(publicDir, distDir, { recursive: true });

	const manifestPath = resolve(distDir, 'manifest.json');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	manifest.version = version;
	writeFileSync(
		manifestPath,
		isDev ? `${JSON.stringify(manifest, null, 2)}\n` : JSON.stringify(manifest),
	);

	const popupPath = resolve(distDir, 'popup.html');
	if (existsSync(popupPath)) {
		const mode = isDev ? 'Dev' : 'Prod';
		const popup = readFileSync(popupPath, 'utf8')
			.replace(/v\d+\.\d+\.\d+\s*•\s*(?:Build|Dev|Prod)/, `v${version} • ${mode}`);
		writeFileSync(popupPath, popup);
	}
}

// Production markup is shipped as-is by Chrome. Collapse formatting whitespace
// without touching quoted attribute values, so source HTML can stay readable.
function minifyHtml(source) {
	const withoutComments = source.replace(/<!--[\s\S]*?-->/gu, '');
	let output = '';
	let inTag = false;
	let quote = '';
	let pendingWhitespace = false;
	for (const character of withoutComments) {
		if (quote) {
			output += character;
			if (character === quote) quote = '';
			continue;
		}
		if (inTag && (character === '"' || character === "'")) {
			if (pendingWhitespace && output.at(-1) !== '<') output += ' ';
			pendingWhitespace = false;
			quote = character;
			output += character;
			continue;
		}
		if (/\s/u.test(character)) {
			pendingWhitespace = true;
			continue;
		}
		if (pendingWhitespace) {
			const previous = output.at(-1);
			if (previous
				&& previous !== '<'
				&& character !== '>'
				&& !(previous === '>' && character === '<')) output += ' ';
			pendingWhitespace = false;
		}
		output += character;
		if (character === '<') inTag = true;
		else if (character === '>') inTag = false;
	}
	return output.trim();
}

function minifyProductionAssets() {
	if (isDev) return;
	for (const name of ['popup.html', 'options.html', 'offscreen.html']) {
		const path = resolve(distDir, name);
		if (existsSync(path)) writeFileSync(path, minifyHtml(readFileSync(path, 'utf8')));
	}

	const localesDir = resolve(distDir, '_locales');
	if (!existsSync(localesDir)) return;
	for (const locale of readdirSync(localesDir, { withFileTypes: true })) {
		if (!locale.isDirectory()) continue;
		const path = resolve(localesDir, locale.name, 'messages.json');
		if (!existsSync(path)) continue;
		writeFileSync(path, JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))));
	}
}

async function minifyProductionStyles() {
	if (isDev) return;
	for (const name of ['popup.css', 'options.css']) {
		const path = resolve(distDir, name);
		if (!existsSync(path)) continue;
		const result = await esbuild.transform(readFileSync(path, 'utf8'), {
			loader: 'css',
			minify: true,
			legalComments: 'none',
		});
		writeFileSync(path, result.code);
	}
}

async function optimizeProductionIcons() {
	if (isDev) return;
	const iconsDir = resolve(distDir, 'icons');
	if (!existsSync(iconsDir)) return;
	for (const name of readdirSync(iconsDir).filter((entry) => entry.endsWith('.png')).sort()) {
		const path = resolve(iconsDir, name);
		const source = readFileSync(path);
		const optimized = await sharp(source, { failOn: 'error' })
			.png({ palette: true, colours: 256, compressionLevel: 9, effort: 10, dither: 0 })
			.toBuffer();
		if (optimized.length < source.length) writeFileSync(path, optimized);
	}
}

async function minifyProductionJavaScript() {
	if (isDev || emitSourceMap) return;
	const paths = walkFiles(distDir).filter((path) => path.endsWith('.js')).sort();
	for (const path of paths) {
		const opaqueVendor = path.endsWith('peerjs-vendor.js');
		if (!opaqueVendor) continue;
		const source = readFileSync(path, 'utf8');
		const result = await minify(source, {
			ecma: 2022,
			module: /^\s*(?:import|export)\b/mu.test(source),
			compress: {
				passes: 4,
			},
			mangle: productionMangleOptions(true),
			format: { comments: false },
		});
		if (typeof result.code !== 'string') throw new Error(`Terser emitted no code for ${path}`);
		writeFileSync(path, result.code);
	}
}

function assertProductionJavaScript() {
	if (isDev) return;
	const diagnosticCalls = [];
	for (const path of walkFiles(distDir).filter((candidate) => candidate.endsWith('.js'))) {
		if (/\bconsole\.(?:debug|info|log)\s*\(/u.test(readFileSync(path, 'utf8'))) {
			diagnosticCalls.push(path.slice(distDir.length + 1).replaceAll('\\', '/'));
		}
	}
	if (diagnosticCalls.length > 0) {
		throw new Error(`Production bundles contain diagnostic console calls: ${diagnosticCalls.join(', ')}`);
	}
}

function walkFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? walkFiles(path) : [path];
	});
}

const common = {
	absWorkingDir: projectDir,
	bundle: true,
	treeShaking: true,
	splitting: false,
	platform: 'browser',
	target: ['chrome120'],
	charset: 'utf8',
	legalComments: 'none',
	minify: !isDev,
	sourcemap: emitSourceMap ? 'external' : false,
	sourcesContent: false,
	define: { 'process.env.NODE_ENV': isDev ? '"development"' : '"production"' },
	// Production keeps actionable warnings/errors but removes diagnostic chatter,
	// including logger.info implementations bundled from the shared kernel.
	pure: isDev ? [] : ['console.debug', 'console.info', 'console.log'],
	drop: isDev ? [] : ['debugger'],
	loader: { '.ts': 'ts', '.tsx': 'tsx' },
	alias: {
		// Bundle the current workspace sources. Release still builds the package
		// outputs for tests and declarations, but extension code must never pick up
		// a stale dist/ tree left by an earlier local build.
		'@nexus/contracts/bootstrap': resolve(projectDir, '../../packages/contracts/src/spectra.bootstrap.ts'),
		'@nexus/contracts/ui-runtime': resolve(projectDir, '../../packages/contracts/src/spectra.ui-runtime.ts'),
		'@nexus/contracts/ui-settings-runtime': resolve(projectDir, '../../packages/contracts/src/spectra.ui-settings-runtime.ts'),
		'@nexus/contracts': resolve(projectDir, '../../packages/contracts/src/index.ts'),
		'@nexus/kernel': resolve(projectDir, '../../packages/nexus-kernel/src/index.ts'),
		'@nexus/audio-engine': resolve(projectDir, '../../packages/features/audio-engine/src/index.ts'),
		// PeerJS pulls every Firefox/Safari/legacy-Chrome compatibility shim from
		// webrtc-adapter. SPECTRA is compiled for Chrome 120+, whose native WebRTC
		// surface needs only the browserDetails object PeerJS reads at runtime.
		'webrtc-adapter': resolve(projectDir, 'scripts/chrome120-webrtc-adapter.mjs'),
	},
	logLevel: 'warning',
};

runTypecheck();
prepareDist();
await minifyProductionStyles();
await optimizeProductionIcons();
writeI18nAssets(distDir);
minifyProductionAssets();
console.log(`✓ SPECTRA ${version} ${isDev ? 'development' : 'production'} build`);

if (isWatch) {
	const contexts = await Promise.all(allEntries.map(async ({ entry, out, format }) => {
		const context = await esbuild.context({
			...common,
			entryPoints: [entry],
			outfile: resolve(distDir, out),
			format,
			plugins: [{
				name: 'build-notifier',
				setup(build) {
					build.onEnd((result) => {
						if (result.errors.length === 0) console.log(`✓ ${out}`);
					});
				},
			}],
		});
		await context.watch();
		return context;
	}));
	process.on('SIGINT', async () => {
		await Promise.all(contexts.map((context) => context.dispose()));
		process.exit(0);
	});
	console.log('Watching SPECTRA entrypoints…');
} else {
	const metafiles = [];
	const summary = [];
	const buildOne = async ({ entry, out, format, sharingDomain }) => {
		const result = await esbuild.build({
			...common,
			alias: out.startsWith('content-')
				? {
					...common.alias,
					'@nexus/contracts': contentContractsRuntime,
					'@nexus/audio-engine': contentAudioEngineRuntime,
					'@nexus/kernel': contentKernelRuntime,
				}
				: common.alias,
			entryPoints: [entry],
			outfile: resolve(distDir, out),
			format,
			metafile: true,
		});
		metafiles.push({
			name: out,
			sharingDomain: sharingDomain ?? `standalone:${out}`,
			metafile: result.metafile,
		});
		summary.push(out);
	};

	if (isDev) {
		// Standalone files keep source-level Chrome diagnostics readable. Content
		// scripts must also stay standalone in production because executeScript()
		// injects classic files rather than extension-page ESM entrypoints.
		for (const entry of allEntries) await buildOne(entry);
	} else {
		for (const entry of vendorEntries) await buildOne(entry);
		for (const entry of isolatedEntries) await buildOne(entry);
		// The MV3 worker owns durable control recovery and contains a deliberate
		// runtime-loader/control-coordinator cycle. Keep it one self-contained
		// module so worker startup never depends on a separately initialized
		// shared chunk. Extension pages may still share deterministic chunks.
		for (const entry of backgroundEntries) await buildOne(entry);
		for (const group of moduleEntryGroups) {
			const moduleEntryPoints = Object.fromEntries(group.entries.map(({ entry, out }) => [
				out.slice(0, -'.js'.length),
				entry,
			]));
			const result = await esbuild.build({
				...common,
				alias: common.alias,
				entryPoints: moduleEntryPoints,
				outdir: distDir,
				entryNames: '[name]',
				chunkNames: `chunks/${group.name}/[name]-[hash]`,
				format: 'esm',
				splitting: true,
				plugins: [contractRuntimeFacadePlugin()],
				metafile: true,
			});
			metafiles.push({
				name: group.name,
				sharingDomain: group.sharingDomain,
				metafile: result.metafile,
			});
			for (const { out } of group.entries) summary.push(out);
		}
	}

	await minifyProductionJavaScript();
	assertProductionJavaScript();
	if (!isDev) checkProductionArtifacts({ distDir, metafiles });
	if (isAnalyze) {
		const report = metafiles.map(({ name, sharingDomain, metafile }) => ({
			name,
			sharingDomain,
			outputs: Object.fromEntries(Object.entries(metafile.outputs)
				.map(([output, detail]) => [
					output.replaceAll('\\', '/'),
					{ bytes: detail.bytes, inputs: detail.inputs },
				])
				.sort(([left], [right]) => left.localeCompare(right))),
		}));
		writeFileSync(resolve(distDir, 'build-analysis.json'), `${JSON.stringify(report, null, 2)}\n`);
	}

	console.log(`✓ ${summary.map((out) => (
		`${out}:${Math.ceil(statSync(resolve(distDir, out)).size / 1024)}KiB`
	)).join(' | ')}`);
}
