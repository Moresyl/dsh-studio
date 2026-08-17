import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier/flat'

/**
 * Lint rules for the shell UI.
 *
 * Type-aware rules are deliberately off: `tsc --noEmit` already runs in `pnpm
 * build` under a strict config, so asking ESLint to type-check again would only
 * make it slower and give the same answers twice.
 */
export default [
  // `.workflow` is the gitignored scratch directory: throwaway reproductions
  // written to be run once and deleted, which is not something to hold to the
  // standard the shipped source is held to.
  { ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', '.workflow/**'] },

  ...tsPlugin.configs['flat/recommended'],

  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // `configs.flat` namespace: the top-level entry of the same name is still
    // eslintrc-shaped and flat config rejects it.
    ...reactHooks.configs.flat['recommended-latest'],
  },

  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // Two shapes here say "deliberately unused" rather than "forgotten": a
      // rest sibling, which is how a field gets dropped from an object, and a
      // leading underscore, which is the convention for a binding kept only to
      // satisfy a position. Naming them as exceptions is what lets the rule stay
      // an error everywhere else instead of being silenced case by case.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Last, so formatting opinions never fight Prettier.
  prettier,
]
