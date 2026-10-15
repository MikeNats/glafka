import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGitRepo } from '../helpers/gitFixture.js';
import { odysse, odysseUpdate, odysseFollowUp } from '../../src/commands/odysse/odysse.js';
import { ethosPath, writeDoc, workspaceProposalPath } from '../../src/memory/docsStore.js';

test(
  "odysse builds a full-scan prompt from the real repo's file tree",
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();

    const result = odysse({ repoRoot });
    assert.equal(result.cbmIndexed, false);

    assert.match(result.prompt, /README\.md/);
    assert.match(result.prompt, /docs\/glafka\/architecture/);
  },
);

test(
  'odysseUpdate builds an incremental prompt scoped to the given changed paths',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();

    const { prompt } = odysseUpdate({ repoRoot, changedPaths: ['src/commands/ergon.js'] });

    assert.match(prompt, /src\/commands\/ergon\.js/);
    assert.match(prompt, /Don't re-scan the rest/);
  },
);

// If no agent ran, the result must be empty, not old leftover data.
test(
  'odysseFollowUp reads nothing back when no agent actually ran, even if something is pending from before',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();
    writeDoc(
      ethosPath(repoRoot, 'ETHOS_CODE'),
      '## Authored\n\n## Proposed\n- an old, unrelated finding\n\n## Learned\n',
    );

    const result = odysseFollowUp({ repoRoot, ranAgent: false });

    assert.deepEqual(result.proposals, []);
    assert.deepEqual(result.workspace, []);
    assert.equal(result.ranAgent, false);
  },
);

// deliverPrompt waits for the agent to finish, so its output is ready.
test(
  'odysseFollowUp reads the real proposals and workspace atoms once a real agent has actually run',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();
    writeDoc(
      ethosPath(repoRoot, 'ETHOS_CODE'),
      '## Authored\n\n## Proposed\n- errors are wrapped at the boundary\n\n## Learned\n',
    );
    writeDoc(workspaceProposalPath(repoRoot), JSON.stringify({ baseRef: 'main' }));

    const result = odysseFollowUp({ repoRoot, ranAgent: true });

    assert.equal(result.proposals.length, 1);
    assert.match(result.proposals[0].text, /errors are wrapped at the boundary/);
    assert.deepEqual(result.workspace, ['base branch: main']);
  },
);

test(
  'odysseUpdate walks treeRoot for content but points docs at repoRoot when they differ',
  { concurrency: true },
  () => {
    const repoRoot = makeGitRepo();
    const worktreeRoot = makeGitRepo(); // this acts like a ticket's worktree

    const { prompt } = odysseUpdate({
      repoRoot,
      treeRoot: worktreeRoot,
      changedPaths: ['README.md'],
    });

    assert.ok(prompt.includes(`${repoRoot}/docs/glafka/architecture`));
  },
);
