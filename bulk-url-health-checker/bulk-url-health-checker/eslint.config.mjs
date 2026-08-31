// Root ESLint flat config for the whole monorepo (ESLint 9 flat config format).
//
// One config file covers apps/web, apps/api, apps/worker, and packages/shared
// rather than four independent setups, because the rule intent (strict TS,
// no unused vars/`any` abuse, consistent style) is the same everywhere; only
// the environment (browser+React vs. Node) and the Next.js-specific rules
// differ, and those are scoped below by glob.
//
// eslint-config-next only ships a legacy eslintrc-shaped config (no flat
// export yet as of 15.5.x), so it's bridged in via FlatCompat rather than
// hand-rolling the Next.js rule set.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { FlatCompat } from '@eslint/eslintrc';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      '**/*.d.ts',
      'package-lock.json',
    ],
  },

  // Base JS + TypeScript recommended rules for every workspace.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Node-environment workspaces: api, worker, shared.
  {
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts', 'packages/shared/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'off', // requires type-aware parserOptions.project; see README
      'no-console': ['warn', { allow: ['error'] }], // the apps use pino for logging; console is a smell here
    },
  },

  // Next.js app: bring in eslint-config-next's rules (React, hooks, a11y,
  // core-web-vitals) through the legacy-config compatibility bridge.
  ...compat.extends('next/core-web-vitals', 'next/typescript').map((cfg) => ({
    ...cfg,
    files: ['apps/web/**/*.{ts,tsx}'],
  })),
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    // eslint-plugin-next's rules (e.g. no-html-link-for-pages) resolve the
    // app's root relative to where ESLint itself runs. In this monorepo
    // that's the repo root, not apps/web, so without this setting the
    // plugin can't find apps/web's app/ directory and silently skips those
    // rules -- `next build`'s own bundled lint pass does find it (it runs
    // from inside apps/web), which is why a violation could slip past
    // `npm run lint` yet still fail `next build`. Pointing rootDir at
    // apps/web keeps the two in agreement.
    settings: {
      next: { rootDir: 'apps/web' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // The migration runner is a standalone CLI script invoked directly with
  // tsx (npm run migrate), not part of the api app's pino-logged runtime —
  // console output here is the intended UX, not a logging smell.
  {
    files: ['apps/api/src/db/migrate.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // Test files: relax a couple of rules that fight normal test-writing
  // idioms without weakening application code.
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.test.tsx'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Config/build scripts (root-level and per-app, e.g. next.config.js,
  // postcss.config.js) run under plain Node, outside each app's own
  // tsconfig — give them a Node global set too.
  {
    files: ['*.mjs', '*.cjs', '*.js', 'apps/*/*.mjs', 'apps/*/*.cjs', 'apps/*/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },

  // Must be last: turns off any stylistic ESLint rules that would conflict
  // with Prettier, so the two tools never fight over formatting.
  eslintConfigPrettier,
);
