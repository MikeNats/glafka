import { z } from 'zod';

// One rule in the command allow list.
// It matches the level files exactly.
const ExecRuleSchema = z.object({
  cmd: z.string(),
  anyArgs: z.boolean().optional(),
  subcommands: z.array(z.string()).optional(),
  denyArgs: z.array(z.string()).optional(),
});
export type ExecRule = z.infer<typeof ExecRuleSchema>;

// What a project is ALLOWED to change at this level.
// The change itself is a different type, further down.
const OverrideRulesSchema = z.object({
  mayNarrow: z.array(z.string()),
  mayWiden: z.array(z.string()),
  neverOverridable: z.array(z.string()),
});
export type OverrideRules = z.infer<typeof OverrideRulesSchema>;

// Each group gets its own name, so the override type below can make
// each one optional on its own.
const AuditConfigSchema = z.object({
  enabled: z.boolean(),
  path: z.string(),
  redactFields: z.array(z.string()),
  redactEnvMatching: z.array(z.string()),
  // Optional, so an older project file still loads.
  // Without a limit, one ticket's log can grow to many megabytes.
  maxBytes: z.number().optional(),
});

const FilesystemConfigSchema = z.object({
  enabled: z.boolean(),
  allowRoots: z.array(z.string()),
  denyWithin: z.array(z.string()),
  followSymlinks: z.boolean(),
});

const ExecConfigSchema = z.object({
  enabled: z.boolean(),
  allowShellStrings: z.boolean(),
  allow: z.array(ExecRuleSchema),
  never: z.array(z.string()),
});

const NetworkConfigSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['open', 'allowlist', 'none']),
  allowHosts: z.array(z.string()),
});

const SecretsConfigSchema = z.object({
  enabled: z.boolean(),
  keepEnv: z.array(z.string()),
});

const SandboxConfigSchema = z.object({
  enabled: z.boolean(),
  backend: z.enum(['auto', 'docker', 'seatbelt', 'none']),
  image: z.string().nullable(),
  network: z.boolean(),
  extraMounts: z.array(z.string()),
});

// What the `hostexec` layer reads. This used to be called `approval`, beside an `enabled` flag and
// a `needsHumanYes` list that named seven gated actions. Nothing in the tree ever built an
// `approval` action, so that layer could never run and those two keys changed nothing while
// `--explain` printed them as enforcement. The layer and both keys are gone; these
// two stayed, because `hostexec` really does read them.
const HostExecConfigSchema = z.object({
  flagHostExecutingChanges: z.boolean(),
  hostExecutingPatterns: z.array(z.string()),
});

// One whole guardrails level. These files ship with glafka, so we trust
// them and only type the JSON, we do not check its shape.
//
// Exported because it is this file's top schema and nothing else references it, which otherwise
// reads to the linter as a value assigned and never used. It is the source of truth for `Policy`
// below — deliberately never called to parse, unlike PolicyOverrideSchema, which reads a file a
// person edits.
export const PolicySchema = z.object({
  level: z.number(),
  name: z.string(),
  note: z.string(),
  failClosed: z.boolean(),
  onUnknownAction: z.enum(['allow', 'deny']),
  audit: AuditConfigSchema,
  filesystem: FilesystemConfigSchema,
  exec: ExecConfigSchema,
  network: NetworkConfigSchema,
  secrets: SecretsConfigSchema,
  sandbox: SandboxConfigSchema,
  hostexec: HostExecConfigSchema,
  override: OverrideRulesSchema,
});
export type Policy = z.infer<typeof PolicySchema>;

// The project's own file, written by hand, so we check it carefully.
// A bad shape stops us, the same way bad JSON already does.
export const PolicyOverrideSchema = z.object({
  level: z.number().optional(),
  note: z.string().optional(),
  failClosed: z.boolean().optional(),
  onUnknownAction: z.enum(['allow', 'deny']).optional(),
  audit: AuditConfigSchema.partial().optional(),
  filesystem: FilesystemConfigSchema.partial().optional(),
  exec: ExecConfigSchema.partial().optional(),
  network: NetworkConfigSchema.partial().optional(),
  secrets: SecretsConfigSchema.partial().optional(),
  sandbox: SandboxConfigSchema.partial().optional(),
  hostexec: HostExecConfigSchema.partial().optional(),
  override: OverrideRulesSchema.partial().optional(),
});
export type PolicyOverride = z.infer<typeof PolicyOverrideSchema>;
