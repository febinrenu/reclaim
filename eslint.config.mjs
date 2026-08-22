import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import nextPlugin from '@next/eslint-plugin-next'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'

export default defineConfig(
  globalIgnores(['.next/**', 'node_modules/**', 'dist/**', 'coverage/**', '.data/**']),

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Node globals for everything that runs server-side or as a script. Without this,
  // `console` and `process` read as undefined and no-undef fires on correct code.
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Browser globals additionally apply to client components.
  {
    files: ['app/**/*.tsx', 'src/ui/**/*.tsx'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  {
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Money and probabilities must never be compared or coerced loosely.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },

  // ---------------------------------------------------------------------------
  // BOUNDARY RULE 1 - the domain is pure.
  //
  // src/domain holds the decision engine. It must have zero I/O so that decide()
  // is a pure function of (input, policy, scenario). That purity is what makes the
  // policy simulator, the EV explorer, and the whole unit suite possible.
  // See BUILD_PLAN.md 5.1 commitment A3, and 5.2.
  // ---------------------------------------------------------------------------
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: [
              '@/adapters/*', '@/adapters', '@/repositories/*', '@/repositories',
              '@/app/*', '@/app', '@/config/*', '@/config', '@/server/*', '@/server',
              '@/ports/*', '@/ports', '@/language/*', '@/language',
              '../adapters/*', '../repositories/*', '../config/*', '../server/*',
              '../../adapters/*', '../../repositories/*', '../../config/*',
            ],
            message:
              'src/domain must stay pure. It may import only src/domain and zod. ' +
              'If you need data here, pass it in as an argument instead.',
          },
          {
            group: [
              'pg', '@electric-sql/pglite', 'next', 'next/*', 'react', 'react-dom',
              'razorpay', 'groq-sdk', '@upstash/redis',
              'fs', 'node:fs', 'node:fs/promises',
              'net', 'node:net', 'http', 'node:http', 'https', 'node:https',
            ],
            message:
              'src/domain must stay pure: no database, no network, no filesystem, ' +
              'no framework. node:crypto is permitted, for hashing only.',
          },
        ],
      }],
      // A pure function cannot read the clock or a random source, or replay breaks.
      // Inject Clock and a seeded Rng instead. tests/unit/purity.test.ts enforces the
      // same thing at runtime by stubbing both to throw.
      'no-restricted-syntax': ['error',
        {
          selector: 'MemberExpression[object.name=\'Math\'][property.name=\'random\']',
          message: 'Use the seeded Rng from src/domain/rng.ts so batches replay identically.',
        },
        {
          selector: 'MemberExpression[object.name=\'Date\'][property.name=\'now\']',
          message: 'Inject a Clock into src/domain. See src/domain/clock.ts.',
        },
        {
          selector: 'NewExpression[callee.name=\'Date\']',
          message: 'Inject a Clock into src/domain. See src/domain/clock.ts.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // BOUNDARY RULE 2 - the language firewall.
  //
  // The spec requires that the language model can never reach a money-moving API,
  // and that this be structural rather than a comment. Four barriers enforce it.
  // This is the third. The first two are type-level, Jsonish and DataOnly<T>. The
  // fourth is tests/unit/firewall.test.ts, which walks the transitive import graph
  // so the guarantee survives a refactor that tries to lint-disable this rule.
  // See BUILD_PLAN.md 5.4.
  // ---------------------------------------------------------------------------
  {
    files: ['src/language/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'razorpay', message: 'The language layer must never reach a payments client.' },
          { name: '@/ports/payments', message: 'The language layer must never reach a payments client.' },
          { name: '@/ports/executor', message: 'The language layer must never reach an executor.' },
        ],
        patterns: [
          {
            group: [
              '@/adapters/payments/*', '@/adapters/payments',
              '@/adapters/executor/*', '@/adapters/executor',
              '@/repositories/*', '@/repositories',
              '../adapters/payments/*', '../../adapters/payments/*',
            ],
            message:
              'The language layer must never reach a payments client, an executor, or the ' +
              'database. It receives redacted plain facts and returns a string. ' +
              'See BUILD_PLAN.md 5.4.',
          },
        ],
      }],
    },
  },

  // ---------------------------------------------------------------------------
  // BOUNDARY RULE 3 - exactly one file reads the environment.
  //
  // If any adapter can read process.env directly, tests become environment
  // dependent and the capability banner stops telling the truth about what is
  // actually wired up. See BUILD_PLAN.md 5.1 commitment A5.
  // ---------------------------------------------------------------------------
  {
    files: ['src/**/*.ts', 'app/**/*.ts', 'app/**/*.tsx'],
    ignores: ['src/config/env.ts', 'src/domain/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: 'MemberExpression[object.name=\'process\'][property.name=\'env\']',
          message:
            'Read configuration through src/config/env.ts only. Direct process.env access ' +
            'makes tests environment dependent and hides which adapter is really active.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // BOUNDARY RULE 4 - adapters are wired in exactly one place.
  //
  // Routes and orchestration depend on ports, never on concrete adapters, so the
  // local and real implementations stay swappable and tests can pin either one.
  // ---------------------------------------------------------------------------
  {
    files: ['src/app/**/*.ts', 'src/repositories/**/*.ts', 'app/**/*.ts', 'app/**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['@/adapters/*', '@/adapters'],
            message:
              'Depend on a port from src/ports, not a concrete adapter. Adapters are ' +
              'selected in src/config/container.ts alone.',
          },
        ],
      }],
    },
  },

  // Scripts and tests are allowed to reach for real implementations directly.
  {
    files: ['scripts/**/*.ts', 'tests/**/*.ts', '*.config.ts', '*.config.mjs'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
