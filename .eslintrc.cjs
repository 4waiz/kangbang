/**
 * ESLint configuration.
 *
 * Deliberately type-unaware (no `parserOptions.project`): `tsc --noEmit` already
 * runs over all three packages in `npm run typecheck`, so making ESLint do a
 * second full type-check would double CI time for no extra signal. What is left
 * here is the class of mistake the compiler does *not* catch - unused code,
 * accidental `any`, floating comparisons, `var`.
 */

/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  env: {
    es2023: true,
    node: true,
    browser: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist', 'node_modules', '*.d.ts', 'packages/client/public'],
  rules: {
    // The wire codec and the renderer both legitimately use bitwise maths.
    'no-bitwise': 'off',

    // Unused code is a real smell, but leading-underscore names are the agreed
    // way to say "required by the signature, intentionally ignored".
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
    ],

    // `any` is a warning rather than an error: it is banned in game code but
    // unavoidable at a few third-party boundaries (WebGPU probing, `pg` rows).
    '@typescript-eslint/no-explicit-any': 'warn',

    // Empty catch blocks are used on purpose where a failure is not actionable
    // (e.g. AudioContext resume on a browser that blocks it).
    'no-empty': ['error', { allowEmptyCatch: true }],

    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'no-var': 'error',
    'prefer-const': ['error', { destructuring: 'all' }],
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-console': 'off',
  },
  overrides: [
    {
      // Tests reach into internals and build deliberately malformed input.
      files: ['**/__tests__/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
  ],
};
