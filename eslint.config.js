import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

const globals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  structuredClone: 'readonly',
};

export default [
  {
    ignores: ['node_modules/**', '.worktrees/**', '.glafka-scratch/**', '**/dist/**'],
  },
  {
    files: ['**/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.ts'],
  })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'max-lines': ['error', { max: 100, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['src/**/*.ts', 'bin/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/guardrails/*', '!**/guardrails/index.js'],
              message: 'import from guardrails/index.js — the internals are not the public surface',
            },
          ],
        },
      ],
    },
  },
  {
    // The one file that must reach past guardrails/index.js. It needs TicketGuardrailsPinSchema as a
    // VALUE, and importing index.js pulls in core.ts, which reads src/ticket/paths.js (a known,
    // accepted back-edge) — which imports this file back. The cycle throws at module
    // init, not at build time, so the tests are what caught it. A type-only import would be erased
    // and safe; a zod schema is not. Named as one file rather than exempting `types/` wholesale, so
    // the next value import from guardrails' internals still has to argue for itself.
    files: ['src/types/ticket.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // ---------------------------------------------------------------- Legacy size exceptions
  //
  // The two size rules below are ERRORS, not warnings: a new file that needs splitting should
  // fail the build, not add to a pile nobody reads. The files listed here predate that decision —
  // they were already over the limit when it was made, and rewriting 63 of them in one change is a
  // restructure with more risk than the rule is worth.
  //
  // The list is deliberately explicit, and deliberately awkward to grow. Anything NOT on it is held
  // to the limit, so every new file complies from birth and each of these can be split on its own,
  // in its own ticket, by deleting one line here.
  {
    files: [
      'installKit/bin/agent/deliverPrompt.ts',
      'installKit/bin/commands/epistle.ts',
      'installKit/bin/commands/ergon.ts',
      'installKit/bin/commands/genesis.ts',
      'installKit/bin/commands/guardrails.ts',
      'installKit/bin/commands/install.ts',
      'installKit/bin/commands/logos.ts',
      'installKit/bin/commands/odysse.ts',
      'installKit/bin/glafka.ts',
      'installKit/bin/hooks/install.ts',
      'installKit/guardrails/audit.ts',
      'installKit/guardrails/core.ts',
      'installKit/guardrails/explain.ts',
      'installKit/guardrails/hooks/hook-copilot.ts',
      'installKit/guardrails/hooks/hook-gemini.ts',
      'installKit/guardrails/hooks/hook-kimi.ts',
      'installKit/guardrails/hooks/hook.ts',
      'installKit/guardrails/layers/exec.ts',
      'installKit/guardrails/layers/execFilesystem.ts',
      'installKit/guardrails/layers/filesystem.ts',
      'installKit/guardrails/layers/hostexec.ts',
      'installKit/guardrails/layers/network.ts',
      'installKit/guardrails/layers/sandbox.ts',
      'installKit/guardrails/layers/sandbox/seatbelt.ts',
      'installKit/guardrails/layers/sandbox/wrap.ts',
      'installKit/guardrails/layers/secrets.ts',
      'installKit/guardrails/layers/shellwords.ts',
      'installKit/guardrails/resolve.ts',
      'installKit/guardrails/session.ts',
      'src/audit/read.ts',
      'src/audit/recordRun.ts',
      'src/checks.ts',
      'src/commands/epistle/epistle.ts',
      'src/commands/ergon/prompts.ts',
      'src/commands/ergon/review.ts',
      'src/commands/ergon/run.ts',
      'src/commands/ergon/status.ts',
      'src/commands/ergon/verdict.ts',
      'src/commands/genesis/genesis.ts',
      'src/commands/genesis/prompts.ts',
      'src/commands/genesis/utils.ts',
      'src/commands/install/install.ts',
      'src/commands/lysis/lysis.ts',
      'src/commands/odysse/prompts.ts',
      'src/commands/poreia/poreia.ts',
      'src/commands/poreia/utils.ts',
      'src/commands/vima/utils.ts',
      'src/commands/vima/vima.ts',
      'src/config.ts',
      'src/memory/categories.ts',
      'src/memory/docsStore.ts',
      'src/memory/ethos.ts',
      'src/memory/ethosAudit/ethosAudit.ts',
      'src/ticket/background.ts',
      'src/ticket/devServer.ts',
      'src/ticket/paths.ts',
      'src/ticket/resources/acquire.ts',
      'src/ticket/resources/isolationHooks.ts',
      'src/ticket/resources/release.ts',
      'src/ticket/ticketStore/review.ts',
      'src/ticket/ticketStore/store.ts',
      'src/util/fileOperations.ts',
      'src/util/git.ts',
    ],
    rules: { 'max-lines': 'off' },
  },
  {
    files: [
      'installKit/bin/agent/deliverPrompt.ts',
      'installKit/bin/commands/epistle.ts',
      'installKit/bin/commands/ergon.ts',
      'installKit/bin/commands/guardrails.ts',
      'installKit/bin/commands/lysis.ts',
      'installKit/bin/commands/odysse.ts',
      'installKit/bin/commands/vima.ts',
      'installKit/bin/glafka.ts',
      'installKit/guardrails/core.ts',
      'installKit/guardrails/explain.ts',
      'installKit/guardrails/layers/exec.ts',
      'installKit/guardrails/layers/sandbox.ts',
      'installKit/guardrails/layers/sandbox/seatbelt.ts',
      'installKit/guardrails/layers/sandbox/wrap.ts',
      'installKit/guardrails/layers/shellwords.ts',
      'src/checks.ts',
      'src/commands/cancel/cancel.ts',
      'src/commands/epistle/epistle.ts',
      'src/commands/ergon/prompts.ts',
      'src/commands/ergon/review.ts',
      'src/commands/ergon/status.ts',
      'src/commands/genesis/prompts.ts',
      'src/commands/genesis/utils.ts',
      'src/commands/lysis/lysis.ts',
      'src/commands/odysse/prompts.ts',
      'src/commands/poreia/poreia.ts',
      'src/commands/vima/vima.ts',
      'src/memory/docsStore.ts',
      'src/memory/ethosAudit/ethosAudit.ts',
      'src/ticket/background.ts',
      'src/ticket/resources/acquire.ts',
    ],
    rules: { 'max-lines-per-function': 'off' },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
    },
  },
  prettier,
];
