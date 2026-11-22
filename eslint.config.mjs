import tsParser from '@typescript-eslint/parser'

export default [
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  {
    files: ['packages/*/src/**/*.{ts,tsx,cts,mts}'],
    languageOptions: { parser: tsParser },
    rules: {
      'no-constant-binary-expression': 'error',
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-sparse-arrays': 'error',
      'no-unreachable': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
    },
  },
]
