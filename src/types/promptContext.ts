// A box for rules, like SECURITY. One entry in the categories file.
export interface Category {
  name: string;
  hint: string;
}

// Everything a prompt can say about the project, in one fixed order.
// The last two fields are optional, because callers add them later.
export interface PromptContext {
  architectureIndex: string | null;
  // How stale the map is. Null when there is no map to date.
  architectureFreshness: string | null;
  ethosContent: string | null;
  proorismos: string | null;
  categories: readonly Category[];
  personaContent?: string | null;
  // The code graph project the agent can ask live. Null when it has no graph tools.
  codeGraph?: string | null;
  projectMemory?: string | null;
  // Reviewer-only. Loaded by the review path, never by the coder's — see
  // memory/standards.ts for why the two are kept apart.
  standards?: string | null;
  reviewDoc?: string | null;
}
