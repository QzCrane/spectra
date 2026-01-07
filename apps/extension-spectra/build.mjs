/**
 * SPECTRA Build Script
 * 
 * Builds background, content, popup separately as IIFE format
 */

import { build } from 'vite';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { cpSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const distDir = resolve(__dirname, 'dist');
const publicDir = resolve(__dirname, 'public');

// Clean dist directory
if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true });
}

// 1. Copy public directory (contains manifest/icon and other static files)
cpSync(publicDir, distDir, { recursive: true });
// Verify build directory exists
if (!existsSync(distDir)) {
  console.error("Dist directory not created!");
}

// Common build configuration
const commonResolve = {
  alias: {
    '@nexus/contracts': resolve(__dirname, '../../packages/contracts/dist/index.js'),
    '@nexus/kernel': resolve(__dirname, '../../packages/nexus-kernel/dist/index.js'),
    '@nexus/audio-engine': resolve(__dirname, '../../packages/features/audio-engine/dist/index.js')
  }
};

// detect dev mode
const isDev = process.argv.includes('--dev') || process.argv.includes('--watch');

// ...

// Build function - uses Rollup output
async function buildEntry(entry, outputName, globalName) {
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      write: false, // don't auto-write, manual control
      lib: {
        entry: resolve(__dirname, entry),
        name: globalName,
        formats: ['iife']
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
          entryFileNames: `${outputName}.js`
        }
      },
      minify: !isDev,
      sourcemap: isDev ? 'inline' : false
    },
    resolve: commonResolve
  });

  // result may be array (multi-entry) or single object
  const outputs = Array.isArray(result) ? result : [result];
  
  for (const bundle of outputs) {
    if (bundle && bundle.output) {
      for (const chunk of bundle.output) {
        if (chunk.type === 'chunk' && chunk.isEntry) {
          const outputPath = resolve(distDir, `${outputName}.js`);
          writeFileSync(outputPath, chunk.code);
          console.log(`✓ Built ${outputName}.js (${(chunk.code.length / 1024).toFixed(2)} KB)`);
          return;
        }
      }
    }
  }
  console.error(`✗ Failed to build ${outputName}.js - no entry chunk found`);
}

// 2. Build background.js
await buildEntry('src/background/index.ts', 'background', 'SpectraBackground');

// 3. Build content.js
await buildEntry('src/content/core/index.ts', 'content', 'SpectraContent');

// 4. Build popup.js
await buildEntry('src/popup/index.ts', 'popup', 'SpectraPopup');

// 5. Build offscreen.js
await buildEntry('src/offscreen/index.ts', 'offscreen', 'SpectraOffscreen');

// 6. Build offscreen-remote.js (PeerJS WebRTC)
await buildEntry('src/offscreen-remote/index.ts', 'offscreen-remote', 'SpectraOffscreenRemote');

// 7. Build options.js (settings page)
await buildEntry('src/options/index.ts', 'options', 'SpectraOptions');

// 8. Build injector.js (Logic for hijacking native APIs)
await buildEntry('src/injector/index.ts', 'injector', 'SpectraInjector');

console.log('\n🎉 Build complete! Output: apps/extension-spectra/dist');

