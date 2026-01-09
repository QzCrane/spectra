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

// Helper: run command with compressed output
function run(label, cmd, opts = {}) {
	try {
		execSync(cmd, { stdio: 'pipe', cwd: __dirname, ...opts });
		return true;
	} catch (e) {
		if (opts.silent) return false;
		console.error(`❌ ${label}: ${e.stderr?.toString().trim() || e.message}`);
		return false;
	}
}

// Pre-flight checks (skip in watch mode)
if (!isWatch) {
	const verifyPath = resolve(__dirname, '../../scripts/verify-architecture.js');
	if (existsSync(verifyPath)) {
		run('verify', 'node ../../scripts/verify-architecture.js', { silent: true });
	}
	
	if (!run('tsc', 'npx tsc --noEmit --skipLibCheck')) {
		process.exit(1);
	}
	console.log('✓ Pre-flight: tsc OK');
}

// Prepare dist
if (existsSync(distDir)) rmSync(distDir, { recursive: true });
mkdirSync(distDir, { recursive: true });
cpSync(publicDir, distDir, { recursive: true });

const commonConfig = {
	bundle: true,
	minify: !isDev,
	sourcemap: isDev ? 'inline' : false,
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
	console.log('👀 Watch mode...');
	const contexts = await Promise.all(entries.map(async ({ entry, out }) => {
		const ctx = await esbuild.context({
			...commonConfig,
			entryPoints: [entry],
			outfile: `dist/${out}`,
			logLevel: 'warning',
			plugins: [{
				name: 'rebuild-notify',
				setup(build) {
					build.onEnd(r => r.errors.length === 0 && console.log(`✓ ${out}`));
				}
			}]
		});
		await ctx.watch();
		return ctx;
	}));
	
	process.on('SIGINT', async () => {
		await Promise.all(contexts.map(ctx => ctx.dispose()));
		process.exit(0);
	});
	
} else {
	// Build all entries in parallel, collect results
	const results = await Promise.all(entries.map(async ({ entry, out }) => {
		try {
			await esbuild.build({ ...commonConfig, entryPoints: [entry], outfile: `dist/${out}`, write: true });
			const kb = (statSync(`dist/${out}`).size / 1024).toFixed(0);
			return `${out.replace('.js', '')}:${kb}KB`;
		} catch (e) {
			console.error(`❌ ${out}: ${e.message}`);
			process.exit(1);
		}
	}));
	
	// Single line output: all bundles with sizes
	console.log(`✓ Build: ${results.join(' | ')}`);
	console.log(`🎉 Done → dist/`);
}
