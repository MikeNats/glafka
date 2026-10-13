import { z } from 'zod';

// These two files come from outside, so we check their shape.
// The error messages are written by hand, to match the older ones.

const nonEmptyString = (message: string) => z.string({ error: message }).min(1, message);

const labeledString = (field: string) => z.string({ error: `"${field}" must be a string` });

const labeledStringArray = (field: string) => {
  const message = `"${field}" must be an array of non-empty strings`;
  return z.array(nonEmptyString(message), { error: message });
};

// One service, as listed in the profile.
// The shape is the same in both places, so the labels are shared.
const ServiceSchema = z.object({
  name: nonEmptyString('needs a non-empty string "name"'),
  envVars: z
    .array(nonEmptyString('needs a non-empty array of non-empty string "envVars"'), {
      error: 'needs a non-empty array of non-empty string "envVars"',
    })
    .min(1, 'needs a non-empty array of non-empty string "envVars"'),
});
export type Service = z.infer<typeof ServiceSchema>;

const serviceList = (field: string) =>
  z.array(ServiceSchema, { error: `"${field}" must be an array` }).optional();

// What a new worktree needs to become a working checkout.
// The proposal file uses the same shape, just not approved yet.
export const WorkspaceSchema = z.object({
  baseRef: labeledString('workspace.baseRef').optional(),
  bootstrapCmd: labeledString('workspace.bootstrapCmd').optional(),
  // Saved here, so we do not look for it again on every ticket.
  checksCmd: labeledString('workspace.checksCmd').optional(),
  e2eCmd: labeledString('workspace.e2eCmd').optional(),
  seedFiles: labeledStringArray('workspace.seedFiles').optional(),
  submodules: z
    .object({
      paths: labeledStringArray('workspace.submodules.paths').optional(),
      branchPerTicket: z
        .boolean({ error: '"workspace.submodules.branchPerTicket" must be a boolean' })
        .optional(),
    })
    .optional(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const IsolationProfileSchema = z.object({
  services: serviceList('services'),
  setupCmd: labeledString('setupCmd').optional(),
  // Fills the ticket's own database once setupCmd has made it. Separate from
  // workspace.seedFiles, which copies gitignored files in — different jobs.
  seedCmd: labeledString('seedCmd').optional(),
  // Brings this ticket's services back if they have stopped. Runs before every coder run, so it
  // must be safe when nothing is wrong — `docker start <name>` on a running container, not `run`.
  wakeCmd: labeledString('wakeCmd').optional(),
  teardownCmd: labeledString('teardownCmd').optional(),
  // How the whole app is started, and how to tell it is ready.
  // Both optional: a project with nothing to run leaves them out.
  devCmd: labeledString('devCmd').optional(),
  healthCmd: labeledString('healthCmd').optional(),
  workspace: WorkspaceSchema.optional(),
  e2e: z
    .object({
      services: serviceList('e2e.services'),
      setupCmd: labeledString('e2e.setupCmd').optional(),
      teardownCmd: labeledString('e2e.teardownCmd').optional(),
    })
    .optional(),
});
export type IsolationProfile = z.infer<typeof IsolationProfileSchema>;
