// Mistakes, not preferences: undefined names and unused variables in the
// browser modules and the tests. The copied readers (xlsx, la_read, inflate,
// tawr_pdf) are checked too — they ship to the browser like everything else.
export default [
  {
    files: ['web/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', location: 'readonly', history: 'readonly', localStorage: 'readonly',
        indexedDB: 'readonly', fetch: 'readonly', Blob: 'readonly', URL: 'readonly', Response: 'readonly',
        DecompressionStream: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly', crypto: 'readonly',
        CustomEvent: 'readonly', Node: 'readonly', navigator: 'readonly', DOMParser: 'readonly', getComputedStyle: 'readonly', requestAnimationFrame: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', console: 'readonly',
      },
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] },
  },
  {
    files: ['tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { process: 'readonly', Buffer: 'readonly', console: 'readonly', setTimeout: 'readonly', URL: 'readonly', document: 'readonly', getComputedStyle: 'readonly', fetch: 'readonly', DataTransfer: 'readonly', Event: 'readonly' },
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] },
  },
];
