import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config({ ignores: ['**/dist/**', '**/node_modules/**'] }, eslint.configs.recommended, ...tseslint.configs.recommended, { files: ['**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', URL:'readonly', AbortSignal:'readonly', Buffer:'readonly', setTimeout:'readonly', clearTimeout:'readonly' } } }, { files: ['**/*.ts'], rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } });
