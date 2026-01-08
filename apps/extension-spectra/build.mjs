/**
 * SPECTRA Build Script (esbuild)
 * Unified with Halo build system
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

// Parse args
const isWatch = process.argv.includes('--watch');
const isDev = process.argv.includes('--dev') || isWatch;

// Run verify-architecture first (skip in watch mode for speed)
if (!isWatch) {
	try {
		console.log('🔍 Running verify-architecture...');
		execSync('node ../../scripts/verify-architecture.js', { stdio: 'inherit', cwd: __dirname });
	} catch {
		console.error('⚠️ verify-architecture failed, continuing build...');
	}
}

// Clean dist directory
if (existsSync(distDir)) {
	rmSync(distDir, { recursive: true });
}
mkdirSync(distDir, { recursive: true });

// Copy public directory
cpSync(publicDir, distDir, { recursive: true });
console.log('✓ Copied public files');

const commonConfig = {
	bundle: true,
	minify: !isDev,
	sourcemap: isDev ? 'inline' : false,
	define: {
		'process.env.NODE_ENV': isDev ? '"development"' : '"production"'
	},
	loader: { '.ts': 'ts', '.tsx': 'tsx' },
	alias: {
		'@nexus/contracts': resolve(__dirname, '../../packages/contracts/dist/index.js'),
		'@nexus/kernel': resolve(__dirname, '../../packages/nexus-kernel/dist/index.js'),
		'@nexus/audio-engine': resolve(__dirname, '../../packages/features/audio-engine/dist/index.js')
	}
};

// Build entries
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
	// Watch mode - use esbuild context for incremental builds
	console.log('👀 Watch mode enabled - waiting for changes...\n');
	
	const contexts = await Promise.all(entries.map(async ({ entry, out }) => {
		const ctx = await esbuild.context({
			...commonConfig,
			entryPoints: [entry],
			outfile: `dist/${out}`,
			logLevel: 'info',
			plugins: [{
				name: 'rebuild-notify',
				setup(build) {
					build.onEnd(result => {
						if (result.errors.length === 0) {
							console.log(`✓ Rebuilt ${out}`);
						}
					});
				}
			}]
		});
		await ctx.watch();
		return ctx;
	}));
	
	// Keep process alive
	process.on('SIGINT', async () => {
		console.log('\n🛑 Stopping watch...');
		await Promise.all(contexts.map(ctx => ctx.dispose()));
		process.exit(0);
	});
	
} else {
	// Normal build
	await Promise.all(entries.map(async ({ entry, out }) => {
		try {
			await esbuild.build({
				...commonConfig,
				entryPoints: [entry],
				outfile: `dist/${out}`,
				write: true
			});
			const stats = statSync(`dist/${out}`);
			console.log(`✓ Built ${out} (${(stats.size / 1024).toFixed(2)} KB)`);
		} catch (e) {
			console.error(`✗ Failed to build ${out}:`, e.message);
			process.exit(1);
		}
	}));
	
	console.log('\n🎉 Build complete! Output: apps/extension-spectra/dist');
}
