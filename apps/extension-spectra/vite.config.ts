import { defineConfig } from 'vite';

// Simplified config: only copy public directory to dist
// All original JS files remain unchanged
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // No JS building, only copy public directory
    rollupOptions: {
      input: {},
      output: {
        format: 'es'
      }
    }
  },
  publicDir: 'public'
});
