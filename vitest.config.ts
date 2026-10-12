import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const packages = ['game', 'app-core', 'ui', 'platform-web', 'platform-desktop', 'contracts'];
export default defineConfig({
  resolve: { alias: Object.fromEntries(packages.map(name => [`@clawdle/${name}`, fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))])) },
  test: { include: ['packages/**/*.test.ts', 'packages/**/*.test.tsx'], environment: 'node' }
});
