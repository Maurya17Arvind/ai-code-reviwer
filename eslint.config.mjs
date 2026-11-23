import nx from '@nx/eslint-plugin';

/**
 * Module boundaries — see docs/ARCHITECTURE.md §4.1.
 *
 * scope:shared    browser-safe code (dashboard + server + cli)
 * scope:node      Node-only utilities usable by server apps and the CLI
 * scope:server    server infrastructure (database, queue) — never in the CLI or browser
 * scope:dashboard Angular application
 * scope:cli       local CLI
 *
 * type:util < type:port < type:domain < type:adapter < type:app
 */
export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: [
      '**/dist',
      '**/out-tsc',
      '**/coverage',
      '**/vitest.config.*.timestamp*',
      '**/vitest.integration.config.*.timestamp*',
      'libs/database/src/generated/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\.base)?\.config\.[cm]?[jt]s$'],
          depConstraints: [
            { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
            { sourceTag: 'scope:dashboard', onlyDependOnLibsWithTags: ['scope:shared'] },
            { sourceTag: 'scope:node', onlyDependOnLibsWithTags: ['scope:shared', 'scope:node'] },
            { sourceTag: 'scope:cli', onlyDependOnLibsWithTags: ['scope:shared', 'scope:node', 'scope:cli'] },
            { sourceTag: 'scope:server', onlyDependOnLibsWithTags: ['scope:shared', 'scope:node', 'scope:server'] },
            { sourceTag: 'type:util', onlyDependOnLibsWithTags: ['type:util'] },
            { sourceTag: 'type:port', onlyDependOnLibsWithTags: ['type:util', 'type:port'] },
            { sourceTag: 'type:domain', onlyDependOnLibsWithTags: ['type:util', 'type:port', 'type:domain'] },
            {
              sourceTag: 'type:adapter',
              onlyDependOnLibsWithTags: ['type:util', 'type:port', 'type:domain', 'type:adapter'],
            },
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: ['type:util', 'type:port', 'type:domain', 'type:adapter'],
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
];
