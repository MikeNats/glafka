// Every layer exports one of these.
// It is used for the --explain output and for error messages.
export interface LayerMeta {
  name: string;
  kind: string;
  rung: number;
  what: string;
  beatenBy: string;
}
