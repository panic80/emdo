import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'coverage/',
      '**/dist/',
      'apps/web/public/@powersync/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/agents/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@emdo/integrations',
                '@emdo/integrations/*',
                '**/integrations/src/**',
                '**/packages/integrations/**',
              ],
              message:
                'Integration provider facades cannot be imported by browser or agent packages.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportExpression[source.value=/^(?:@emdo\\/integrations(?:\\/|$)|(?:\\.\\.\\/)+(?:packages\\/)?integrations\\/src\\/)/]',
          message:
            'Integration provider facades cannot be loaded dynamically by browser or agent packages.',
        },
      ],
    },
  },
);
