// What an agent is told about its live code graph tools. `project` is the name every call needs.
export function codeGraphSection(project: string): string {
  return (
    `## Code graph\n` +
    `This checkout is indexed in a code graph, and you have its tools ` +
    `(mcp__code-graph__…). Ask it before you grep or read whole files:\n` +
    `- search_graph: find a function, class or file by name or words\n` +
    `- get_code_snippet: read one symbol's code\n` +
    `- get_file_outline: a file's symbols with their lines\n` +
    `- trace_path: who calls a function, and what it calls\n\n` +
    `Pass project: "${project}" every time. The graph shows the code as it was when this run ` +
    `started: read a file directly once you have changed it.`
  );
}
