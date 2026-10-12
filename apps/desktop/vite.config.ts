import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), plugins: [react()], clearScreen: false, server: { host: '127.0.0.1', port: 1420, strictPort: true }, build: { outDir: 'dist', emptyOutDir: true }, resolve: { alias: Object.fromEntries(['game','app-core','ui','platform-desktop','contracts'].map(name => [`@clawdle/${name}`, fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url))])) } });
