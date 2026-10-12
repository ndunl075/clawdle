import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  { ignores: ['.worktrees/**', '.tools/**', 'node_modules/**', '**/dist/**', '**/target/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended, ...ts.configs.recommended,
  { files: ['**/*.{ts,tsx}'], rules: { '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
  { files: ['**/*.mjs'], languageOptions: { globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly', fetch: 'readonly', setTimeout: 'readonly' } } }
);
