// The real paths behind the names the rules use.
// Built once per check, and read by every layer that looks at a path.
export interface Scopes {
  TICKET_WORKTREE: string;
  TICKET_SCRATCH: string;
}
