import type { PluginInfo } from './contract';
import { TICKET_FILES, WORKTREES_DIR } from './files';
import { glafkaRules } from './rules';
import { GLAFKA_CHAT_RULES, GLAFKA_NEW_TICKET_RULES, planFileOf } from './text';

// What the glafka plugin tells Elaia about itself.
export const GLAFKA_INFO: PluginInfo = {
  id: 'glafka',
  name: 'glafka',
  watch: { dir: '.glafka', files: TICKET_FILES.source },
  worktreesDir: WORKTREES_DIR,
  docsDir: 'docs/glafka',
  // glafka's own code and state: an agent that rewrites bin/glafka.js could then run anything.
  lockedFiles: ['.glafka/**'],
  // Where glafka reads the commands it runs (coder, checks) and its guardrails.
  lockedOutsideMain: [
    '.glafka.json',
    'docs/glafka/guardrails.json',
    'docs/glafka/architecture/isolation.json',
  ],
  // glafka's skills fall back to the project's own copy when `glafka` is not on PATH.
  allowedTools: ['Bash(glafka:*)', 'Bash(node .glafka/bin/glafka.js:*)'],
  blocked: {
    planning: glafkaRules.plannerDenied,
    creating: glafkaRules.createDenied,
    shared: glafkaRules.sharedDenied,
    pushing: glafkaRules.pushOnly,
    otherTicket: glafkaRules.otherTicketsDenied(['{id}']),
  },
  chatRules: GLAFKA_CHAT_RULES,
  newTicketRules: GLAFKA_NEW_TICKET_RULES,
  planFile: planFileOf('{id}'),
};
