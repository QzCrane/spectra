/**
 * SPECTRA Build Script (esbuild)
 * goal: fast TypeScript build with pre-flight checks, tree-shaking, and bundle analysis
 * output: compressed single-line logs per step
 */

import esbuild from 'esbuild';
import { cpSync, rmSync, existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const distDir = resolve(__dirname, 'dist');
const publicDir = resolve(__dirname, 'public');

// inv: single source of truth for version
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const VERSION = pkg.version;

const isWatch = process.argv.includes('--watch');
const isDev = process.argv.includes('--dev') || isWatch;
const isAnalyze = process.argv.includes('--analyze');

function run(label, cmd, opts = {}) {
	try {
		execSync(cmd, { stdio: 'pipe', cwd: __dirname, ...opts });
		return true;
	} catch (e) {
		if (!opts.silent) console.error(`❌ ${label}: ${e.stderr?.toString().trim() || e.message}`);
		return false;
	}
}

if (!isWatch) {
	if (!run('tsc', 'bun tsc --noEmit --skipLibCheck')) process.exit(1);
	console.log('✓ TSC OK');
}

// eff: Fast clean & copy
if (existsSync(distDir)) rmSync(distDir, { recursive: true });
mkdirSync(distDir, { recursive: true });
cpSync(publicDir, distDir, { recursive: true });

// eff: sync version to all files (SSOT: package.json)
const buildMode = isDev ? 'Dev' : 'Prod';
const versionString = `v${VERSION} • ${buildMode}`;

// eff: update popup.html version display
const popupHtmlPath = resolve(distDir, 'popup.html');
if (existsSync(popupHtmlPath)) {
	let popupHtml = readFileSync(popupHtmlPath, 'utf-8');
	popupHtml = popupHtml.replace(/v\d+\.\d+\.\d+\s*•\s*(?:Build|Dev|Prod)/, versionString);
	writeFileSync(popupHtmlPath, popupHtml);
}

// eff: update manifest.json version
const manifestPath = resolve(distDir, 'manifest.json');
if (existsSync(manifestPath)) {
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
	manifest.version = VERSION;
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

console.log(`✓ Version: ${VERSION}`);

// eff: Generate content hash for cache busting
function getContentHash(filePath) {
	const content = readFileSync(filePath);
	return createHash('md5').update(content).digest('hex').slice(0, 8);
}

const cfg = {
	bundle: true,
	minify: !isDev,
	treeShaking: true,
	splitting: false, // MV3 不支持代码分割
	sourcemap: isDev ? 'inline' : false,
	define: { 'process.env.NODE_ENV': isDev ? '"development"' : '"production"' },
	loader: { '.ts': 'ts', '.tsx': 'tsx' },
	alias: {
		'@nexus/contracts': resolve(__dirname, '../../packages/contracts/dist/index.js'),
		'@nexus/kernel': resolve(__dirname, '../../packages/nexus-kernel/dist/index.js'),
		'@nexus/audio-engine': resolve(__dirname, '../../packages/features/audio-engine/dist/index.js')
	},
	// eff: 消除未使用的代码
	treeShaking: true,
	// eff: 标记副作用-free 的模块
	ignoreAnnotations: false,
};

const entries = [
	{ entry: 'src/background/index.ts', out: 'background.js' },
	{ entry: 'src/content/core/index.ts', out: 'content.js' },
	{ entry: 'src/popup/index.ts', out: 'popup.js' },
	{ entry: 'src/offscreen/index.ts', out: 'offscreen.js' },
	{ entry: 'src/offscreen-remote/index.ts', out: 'offscreen-remote.js' },
	{ entry: 'src/options/index.ts', out: 'options.js' },
	{ entry: 'src/injector/index.ts', out: 'injector.js' }
];

if (isWatch) {
	console.log('👀 Watch...');
	const ctxs = await Promise.all(entries.map(async ({ entry, out }) => {
		const c = await esbuild.context({
			...cfg, entryPoints: [entry], outfile: `dist/${out}`, logLevel: 'warning',
			plugins: [{ name: 'notify', setup: b => b.onEnd(r => !r.errors.length && console.log(`✓ ${out}`)) }]
		});
		await c.watch(); return c;
	}));
	process.on('SIGINT', async () => { await Promise.all(ctxs.map(c => c.dispose())); process.exit(0); });
} else {
	const results = [];
	const metafiles = [];

	for (const { entry, out } of entries) {
		const result = await esbuild.build({
			...cfg,
			entryPoints: [entry],
			outfile: `dist/${out}`,
			write: true,
			metafile: isAnalyze,
		});

		if (isAnalyze && result.metafile) {
			metafiles.push({ name: out, meta: result.metafile });
		}

		const size = (statSync(`dist/${out}`).size / 1024).toFixed(0);
		results.push(`${out.split('.')[0]}:${size}KB`);
	}

	// eff: 生成构建分析报告
	if (isAnalyze && metafiles.length > 0) {
		const analysis = metafiles.map(({ name, meta }) => {
			const inputs = Object.entries(meta.inputs)
				.map(([path, info]) => ({ path, bytes: info.bytes }))
				.sort((a, b) => b.bytes - a.bytes)
				.slice(0, 10);
			return { name, totalBytes: meta.outputs[`dist/${name}`].bytes, topInputs: inputs };
		});

		writeFileSync('dist/build-analysis.json', JSON.stringify(analysis, null, 2));
		console.log('✓ Build analysis: dist/build-analysis.json');
	}

	console.log(`✓ Build: ${results.join(' | ')}`);

	// eff: 生产构建校验大小
	if (!isDev) {
		const maxSize = 1024; // 1MB
		const oversized = results.filter(r => {
			const size = parseInt(r.match(/:(\d+)KB/)[1]);
			return size > maxSize;
		});
		if (oversized.length > 0) {
			console.warn(`⚠️  Oversized bundles: ${oversized.join(', ')}`);
		}
	}
}
