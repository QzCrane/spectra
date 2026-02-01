/**
 * SPECTRA Build Script (esbuild)
 * goal: fast TypeScript build with pre-flight checks
 * output: compressed single-line logs per step
 */

import esbuild from 'esbuild';
import { cpSync, rmSync, existsSync, mkdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const distDir = resolve(__dirname, 'dist');
const publicDir = resolve(__dirname, 'public');

const isWatch = process.argv.includes('--watch');
const isDev = process.argv.includes('--dev') || isWatch;

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

const cfg = {
	bundle: true, minify: !isDev, sourcemap: isDev ? 'inline' : false,
	define: { 'process.env.NODE_ENV': isDev ? '"development"' : '"production"' },
	loader: { '.ts': 'ts', '.tsx': 'tsx' },
	alias: {
		'@nexus/contracts': resolve(__dirname, '../../packages/contracts/dist/index.js'),
		'@nexus/kernel': resolve(__dirname, '../../packages/nexus-kernel/dist/index.js'),
		'@nexus/audio-engine': resolve(__dirname, '../../packages/features/audio-engine/dist/index.js')
	}
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
	const res = await Promise.all(entries.map(async ({ entry, out }) => {
		await esbuild.build({ ...cfg, entryPoints: [entry], outfile: `dist/${out}`, write: true });
		return `${out.split('.')[0]}:${(statSync(`dist/${out}`).size / 1024).toFixed(0)}KB`;
	}));
	console.log(`✓ Build: ${res.join(' | ')}`);
}
