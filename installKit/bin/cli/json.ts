// The version of every `--json` document. Elaia, the VS Code extension, checks it.
// Bump it only when a key is renamed, removed or changes type.
export const JSON_CONTRACT = 1;

// One JSON document, and nothing else, on stdout. Warnings belong on stderr.
export function printJson(body: Record<string, unknown>): void {
  console.log(JSON.stringify({ contract: JSON_CONTRACT, ...body }, null, 2));
}
