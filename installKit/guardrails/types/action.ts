// The one shape every tool call is turned into, so all the adapters agree.
export type Action =
  | { op: 'read'; filePath: string | null }
  | { op: 'write'; filePath: string | null; content: string }
  | { op: 'write'; filePath: string | null; oldString: string; newString: string }
  | { op: 'exec'; commandString: string }
  // `from` is optional. Only the splitter sets it, when it breaks one
  // shell line into several commands. Nothing reads it back.
  | { op: 'exec'; argv: string[]; from?: string }
  // A tool that reaches OUT. Naming it here is what makes the network
  // allow list mean something for the built-in fetch tools.
  | { op: 'fetch'; url: string | null }
  // A tool that touches nothing outside the editor. We name these, so the
  // strict levels stop refusing the coder's own notes.
  | { op: 'noop'; tool: string }
  | { op: string }; // left open for tool names we do not know

// Used when a shell line could not be split into checkable commands.
// It is kept out of Action, since only one place makes it and reads it.
export type UnreadableExecAction = { op: 'exec'; commandString: string; unreadable: string };
