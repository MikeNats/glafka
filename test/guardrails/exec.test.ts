import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../../installKit/guardrails/layers/exec.js';
import { check as netCheck } from '../../installKit/guardrails/layers/network.js';
import { resolvePolicy } from '../../installKit/guardrails/resolve.js';

// Uses the real policy, not a fake one.
function levelPolicy(level: number) {
  return resolvePolicy({ repoRoot: '/does/not/matter', levelOverride: level }).policy;
}

test('git push is denied, unchanged from before this fix', () => {
  const result = check(levelPolicy(2), { op: 'exec', argv: ['git', 'push', 'origin', 'main'] });
  assert.equal(result.allow, false);
});

// Old bug: a flag placed before "push" hid it from the deny check.
test('git --no-pager push is ALSO denied — a flag before the subcommand no longer hides it', () => {
  const result = check(levelPolicy(2), {
    op: 'exec',
    argv: ['git', '--no-pager', 'push', 'origin', 'main'],
  });
  assert.equal(result.allow, false);
});

test('a flag AFTER the subcommand was already denied, and still is', () => {
  const result = check(levelPolicy(2), {
    op: 'exec',
    argv: ['git', 'push', '--force', 'origin', 'main'],
  });
  assert.equal(result.allow, false);
});

test('git status (not on the never-list) is still allowed, flags before it or not', () => {
  const policy = levelPolicy(3);
  assert.equal(check(policy, { op: 'exec', argv: ['git', 'status'] }).allow, true);
  assert.equal(check(policy, { op: 'exec', argv: ['git', '--no-pager', 'status'] }).allow, true);
});

// A one-word deny rule (like "kubectl") blocks it no matter what args follow.
test('a single-word never-entry (kubectl) still matches with any arguments', () => {
  const result = check(levelPolicy(2), { op: 'exec', argv: ['kubectl', 'get', 'pods'] });
  assert.equal(result.allow, false);
});

test('a wrapper command executing git for real is now recognized', () => {
  const result = check(levelPolicy(3), {
    op: 'exec',
    argv: ['uv', 'run', 'git', 'push', 'origin', 'main'],
  });
  assert.equal(result.allow, false);
});

test('other wrapper shapes (npx, xargs) are also caught', () => {
  assert.equal(
    check(levelPolicy(3), { op: 'exec', argv: ['npx', 'git', 'push', 'origin', 'main'] }).allow,
    false,
  );
  assert.equal(
    check(levelPolicy(3), { op: 'exec', argv: ['xargs', '-I{}', 'git', 'push', 'origin', 'main'] })
      .allow,
    false,
  );
});

test('a single-word never-entry (curl) is caught even behind a wrapper', () => {
  const result = check(levelPolicy(3), {
    op: 'exec',
    argv: ['uv', 'run', 'curl', 'https://evil.example'],
  });
  assert.equal(result.allow, false);
});

test('a wrapper handing the whole command off as one string argument is caught', () => {
  const result = check(levelPolicy(3), {
    op: 'exec',
    argv: ['sh', '-c', 'git push origin main'],
  });
  assert.equal(result.allow, false);
});

test('git status is still allowed even when reached through a wrapper', () => {
  const result = check(levelPolicy(3), { op: 'exec', argv: ['uv', 'run', 'git', 'status'] });
  assert.equal(result.allow, true);
});

// Old bug: level 3 was missing these five commands from its allow
// list, so they got denied by mistake.
test("pnpm, yarn, npx, cp, mv are allowed at level 3, matching the note's promise", () => {
  const policy = levelPolicy(3);
  for (const cmd of ['pnpm', 'yarn', 'npx', 'cp', 'mv']) {
    assert.equal(check(policy, { op: 'exec', argv: [cmd, 'install'] }).allow, true, cmd);
  }
});

// --------------------------------------------------------------------------- Regressions

// A stuck coder must be able to report the problem with `glafka aporia`.
// If we block this command, a stuck coder looks the same as a finished one.
for (const level of [2, 3, 4]) {
  test(`level ${level}: the coder can report an impasse with glafka aporia`, () => {
    const result = check(levelPolicy(level), {
      op: 'exec',
      argv: [
        'glafka',
        'aporia',
        '2026-08-07-a-live-ticket',
        '--reason',
        'the table does not exist',
      ],
    });
    assert.equal(result.allow, true);
  });

  test(`level ${level}: the reviewer can record a verdict with glafka krisis`, () => {
    const result = check(levelPolicy(level), {
      op: 'exec',
      argv: ['glafka', 'krisis', '2026-08-07-a-live-ticket', '--verdict', 'clean'],
    });
    assert.equal(result.allow, true);
  });
}

// Narrow on purpose: the coder must not be able to push its own work. Level 2 had no
// "glafka" allow-list entry at all, so an unrecognized subcommand fell through onUnknownAction: "allow" and `glafka epistle <id> --unreviewed` ran. Levels 3/4 already denied this.
for (const level of [2, 3, 4]) {
  test(`level ${level}: glafka epistle stays blocked`, () => {
    const result = check(levelPolicy(level), {
      op: 'exec',
      argv: ['glafka', 'epistle', '2026-08-07-a-live-ticket'],
    });
    assert.equal(result.allow, false);
  });

  test(`level ${level}: glafka lysis stays blocked too`, () => {
    const result = check(levelPolicy(level), {
      op: 'exec',
      argv: ['glafka', 'lysis', '2026-08-07-a-live-ticket', '--sweep'],
    });
    assert.equal(result.allow, false);
  });
}

// The deny list only named long flags like `--force`. But `-f` means
// the same thing in git, so it must be blocked too.
test('level 3: git checkout -f is denied, the same as --force', () => {
  const policy = levelPolicy(3);
  assert.equal(
    check(policy, { op: 'exec', argv: ['git', 'checkout', '--force', '.'] }).allow,
    false,
  );
  assert.equal(check(policy, { op: 'exec', argv: ['git', 'checkout', '-f', '.'] }).allow, false);
});

test('level 3: git reset --hard and its short-form siblings are denied', () => {
  const policy = levelPolicy(3);
  for (const argv of [
    ['git', 'reset', '--hard', 'HEAD'],
    ['git', 'clean', '-fd'],
  ]) {
    assert.equal(check(policy, { op: 'exec', argv }).allow, false, argv.join(' '));
  }
});

// Options like `--git-dir=...` start with "-", so old code skipped past
// them and let git run on a different repo by mistake.
for (const level of [3, 4]) {
  test(`level ${level}: git cannot be pointed at another repository`, () => {
    const policy = levelPolicy(level);
    for (const argv of [
      ['git', '--git-dir=/tmp/other/.git', '--work-tree=/tmp/other', 'add', '-A'],
      ['git', '--git-dir=/tmp/other/.git', 'log', '-p'],
      ['git', '--work-tree=/tmp/other', 'status'],
      ['git', '--exec-path=/tmp/evil', 'status'],
    ]) {
      assert.equal(check(policy, { op: 'exec', argv }).allow, false, argv.join(' '));
    }
  });

  test(`level ${level}: ordinary git still works`, () => {
    const policy = levelPolicy(level);
    assert.equal(check(policy, { op: 'exec', argv: ['git', 'status'] }).allow, true);
    assert.equal(check(policy, { op: 'exec', argv: ['git', '--no-pager', 'log'] }).allow, true);
  });
}

// `-C` is the SHORT way to point git elsewhere, and only the long ones were
// listed. At level 2 git has anyArgs, so nothing else stopped it.
for (const level of [2, 3, 4]) {
  test(`level ${level}: git -C cannot be pointed at another repository`, () => {
    const policy = levelPolicy(level);
    for (const argv of [
      ['git', '-C', '/tmp/other', 'reset', '--hard', 'HEAD~50'],
      ['git', '-C', '/tmp/other', 'clean', '-fdx'],
      ['git', '-C', '/tmp/other', 'checkout', '.'],
      // The attached form is the same flag, written without the space.
      ['git', '-C/tmp/other', 'status'],
    ]) {
      assert.equal(check(policy, { op: 'exec', argv }).allow, false, argv.join(' '));
    }
  });
}

// The fix must not catch the ordinary flags a coder really uses.
test('level 2: git without -C is untouched', () => {
  const policy = levelPolicy(2);
  for (const argv of [
    ['git', 'status'],
    ['git', 'add', '-A'],
    ['git', 'commit', '-m', 'msg'],
    ['git', 'diff', '--cached'],
    ['git', 'checkout', '-b', 'feature'],
  ]) {
    assert.equal(check(policy, { op: 'exec', argv }).allow, true, argv.join(' '));
  }
});

// The subcommand scan only ever looks at the first non-flag argument.
// `-x`/`--exec` on `git rebase` runs an arbitrary shell command; `-c`/`--config`/`--config-env` set arbitrary git config (which can do the same, via core.fsmonitor / core.pager). None of these start with a recognized subcommand name, so they were invisible to the check.
for (const level of [2, 3, 4]) {
  test(`level ${level}: git may not be given a flag that runs a command or sets config`, () => {
    const policy = levelPolicy(level);
    for (const argv of [
      ['git', 'rebase', '-x', 'curl http://evil', 'HEAD~1'],
      ['git', 'rebase', '--exec=curl http://evil', 'HEAD~1'],
      ['git', '-c', 'core.fsmonitor=curl http://evil', 'status'],
      ['git', '--config-env=core.fsmonitor=P', 'status'],
      ['git', '--config=core.fsmonitor=curl http://evil', 'status'],
    ]) {
      assert.equal(check(policy, { op: 'exec', argv }).allow, false, argv.join(' '));
    }
  });
}

// execFilesystem closed path-shaped args on cp/mv/cat/etc, but it
// did NOT close node -e, python3 -c and make — those run an interpreter, not a path argument. node and python3 are cheap to close directly: denyArgs on the exact flags that run arbitrary code applies before anyArgs, so `node -e "..."` / `python3 -c "..."` / a joined `-pe` cluster are refused while ordinary `node file.js` stays allowed. npx --yes/-y (skips the install confirmation, so it can silently fetch and run an arbitrary package) gets the same treatment. `make` is deliberately NOT addressed here — there is no equivalent "one bad flag" for an arbitrary Makefile target, so it stays the documented sandbox-only gap.
for (const level of [2, 3, 4]) {
  test(`level ${level}: node may not be called with an eval/print flag`, () => {
    const policy = levelPolicy(level);
    for (const argv of [
      ['node', '-e', "require('fs').writeFileSync('/tmp/pwned','x')"],
      ['node', '--eval', 'x'],
      ['node', '-p', 'x'],
      ['node', '--print', 'x'],
      ['node', '-pe', 'x'], // joined short flags
      // Follow-up: matchesDenyArg did an exact match on long flags, so `--eval=<code>` (which node really
      // executes, same as `--eval <code>`) was not recognized as the `--eval` deny entry at all.
      ['node', "--eval=require('fs').writeFileSync('/tmp/pwned','x')"],
      ['node', '--print=1'],
    ]) {
      assert.equal(check(policy, { op: 'exec', argv }).allow, false, argv.join(' '));
    }
    // Ordinary use is unaffected.
    assert.equal(check(policy, { op: 'exec', argv: ['node', 'server.js'] }).allow, true);
  });

  test(`level ${level}: python3 may not be called with -c or -m`, () => {
    const policy = levelPolicy(level);
    for (const argv of [
      ['python3', '-c', "import os; os.system('id')"],
      ['python3', '-m', 'http.server'],
    ]) {
      assert.equal(check(policy, { op: 'exec', argv }).allow, false, argv.join(' '));
    }
    assert.equal(check(policy, { op: 'exec', argv: ['python3', 'script.py'] }).allow, true);
  });
}

for (const level of [2, 3]) {
  // npx is not on level 4's allow list at all, so it's already refused there.
  test(`level ${level}: npx may not skip the install confirmation`, () => {
    const policy = levelPolicy(level);
    for (const argv of [
      ['npx', '--yes', 'evil-pkg'],
      ['npx', '-y', 'evil-pkg'],
      ['npx', '--yes=true', 'evil-pkg'],
    ]) {
      assert.equal(check(policy, { op: 'exec', argv }).allow, false, argv.join(' '));
    }
    assert.equal(check(policy, { op: 'exec', argv: ['npx', 'some-tool'] }).allow, true);
  });
}

// Old code treated any argument with a space as a raw command, even a
// commit message. That blocked normal commits by mistake.
test('a commit message may mention a never-listed command', () => {
  for (const level of [2, 3]) {
    const policy = levelPolicy(level);
    for (const message of [
      'fix the git push retry handler',
      'document how to git remote add upstream',
    ]) {
      const result = check(policy, { op: 'exec', argv: ['git', 'commit', '-m', message] });
      assert.equal(result.allow, true, `level ${level}: ${message}`);
    }
  }
});

test('the coder can grep its own codebase for those strings', () => {
  const result = check(levelPolicy(2), { op: 'exec', argv: ['rg', 'git push', 'docs/'] });
  assert.equal(result.allow, true);
});

// This extra check must still work for a real command string,
// like one passed to a shell to run.
test('an unsplit shell string handed to sh -c is still refused', () => {
  const policy = levelPolicy(2);
  for (const argv of [
    ['sh', '-c', 'git push origin main'],
    ['bash', '-c', 'git push origin main'],
    ['xargs', 'git push'],
  ]) {
    assert.equal(check(policy, { op: 'exec', argv }).allow, false, argv.join(' '));
  }
});

test('a real git push is still refused, argv-position walk unchanged', () => {
  assert.equal(
    check(levelPolicy(2), { op: 'exec', argv: ['git', 'push', 'origin', 'main'] }).allow,
    false,
  );
});

// Checks that normal, everyday commands are allowed. If a level blocks
// too much, people just turn it off, and all the other rules stop helping.
test('level 3 allows the ordinary git verbs a coder needs', () => {
  const policy = levelPolicy(3);
  for (const argv of [
    ['git', 'rm', 'old.ts'],
    ['git', 'mv', 'a.ts', 'b.ts'],
    ['git', 'rebase', '--continue'],
  ]) {
    assert.equal(check(policy, { op: 'exec', argv }).allow, true, argv.join(' '));
  }
});

// Without `git rebase --continue` allowed, the coder could not fix
// a broken rebase by itself.
test('level 4 allows a coder to lay out and fix up files', () => {
  const policy = levelPolicy(4);
  for (const argv of [
    ['mkdir', '-p', 'src/new'],
    ['touch', 'src/new/index.ts'],
    ['echo', 'hello'],
    ['git', 'rebase', '--continue'],
    ['git', 'rm', 'old.ts'],
    ['git', 'restore', 'src/a.ts'],
    ['git', 'stash', 'list'],
  ]) {
    assert.equal(check(policy, { op: 'exec', argv }).allow, true, argv.join(' '));
  }
});

test('the never-list and denyArgs still win over the widened allow list', () => {
  for (const level of [3, 4]) {
    const policy = levelPolicy(level);
    for (const argv of [
      ['git', 'push', 'origin', 'main'],
      ['git', 'config', '--global', 'core.hooksPath', '/tmp/evil'],
      ['git', 'checkout', '-f', '.'],
      ['git', 'reset', '--hard', 'HEAD'],
    ]) {
      assert.equal(
        check(policy, { op: 'exec', argv }).allow,
        false,
        `level ${level}: ${argv.join(' ')}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------

// A command like `p=config git $p ...` hides the word "push" in a
// variable. This test checks that hidden words still get blocked.
test('an unreadable string is refused when it holds every word of a never-entry', () => {
  const policy = levelPolicy(2);
  for (const commandString of [
    'p=config git $p --global core.hooksPath /tmp/evil',
    'p=config; git $p --global core.hooksPath /tmp/evil',
    'X=push; git $X origin main',
    'r=remote; git $r add evil http://example.com',
    'x=publish; npm $x',
  ]) {
    const result = check(policy, { op: 'exec', commandString });
    assert.equal(result.allow, false, commandString);
    assert.match(result.reason, /cannot be read/);
  }
});

// Normal commands that use a variable should still be allowed. Only
// commands that hide a blocked word should be refused.
test('an unreadable string with no never-entry in it is still allowed at level 2', () => {
  const policy = levelPolicy(2);
  for (const commandString of [
    'PORT=$GLAFKA_PORT npm start',
    'npm run build --prefix $HOME',
    'node $FILE',
  ]) {
    assert.equal(check(policy, { op: 'exec', commandString }).allow, true, commandString);
  }
});

test('levels 3 and 4 still refuse an unreadable string outright', () => {
  for (const level of [3, 4]) {
    const result = check(levelPolicy(level), {
      op: 'exec',
      commandString: 'git $VERB origin main',
    });
    assert.equal(result.allow, false, `level ${level}`);
  }
});

// Every glafka command a PROMPT tells a caged agent to run. `psyche` was missing from the allow list,
// so at level 2 and above a coder that followed the ethos instructions had its rule refused — ethos capture was silently dead in exactly the projects that turned guardrails on. It went unnoticed because the skills files use `node .glafka/bin/glafka.js <cmd>`, which passes as plain `node`, while the ethos block uses the bare `glafka` form. Keep this list in step with the prompt builders: aporia, psyche  → src/commands/ergon/prompts.ts, src/memory/ethos.ts krisis          → src/commands/ergon/prompts.ts (the reviewer's report-back)
// epalitheusis → src/commands/epalitheusis/prompts.ts (the QA tester records each result)
// apofasi      → src/commands/ergon/prompts.ts (the coder records a decision)
const AGENT_SUBCOMMANDS = ['aporia', 'krisis', 'psyche', 'epalitheusis', 'apofasi'];

for (const level of [2, 3, 4]) {
  test(`level ${level}: every glafka command an agent is told to run is allowed`, () => {
    const policy = levelPolicy(level);
    for (const sub of AGENT_SUBCOMMANDS) {
      const result = check(policy, {
        op: 'exec',
        argv: ['glafka', sub, '2026-08-02-cage-the-coder'],
      });
      assert.equal(result.allow, true, `glafka ${sub}: ${'reason' in result ? result.reason : ''}`);
    }
  });
}

// The list is an allow list, not a door left open. A command nobody is told to
// run stays refused.
test('a glafka subcommand no prompt mentions is still refused', () => {
  const result = check(levelPolicy(3), {
    op: 'exec',
    argv: ['glafka', 'lysis', '2026-08-02-cage-the-coder'],
  });
  assert.equal(result.allow, false);
});

// A Windows-shaped path used to walk straight past the network layer: it split on "/" alone, so
// `curl.exe` and `C:\...\curl.exe` were not read as curl at all — and `curl.exe` IS the normal name on Windows, so the layer did nothing there. Nothing caught it because CI only ever ran on ubuntu.
test('a command is recognised by name whatever path shape it arrives in', () => {
  const policy = levelPolicy(3);
  const denied = (argv: string[]) => netCheck(policy, { op: 'exec', argv }).allow === false;

  assert.equal(denied(['curl', 'https://x.example.com']), true);
  assert.equal(denied(['/usr/bin/curl', 'https://x.example.com']), true);
  assert.equal(denied(['curl.exe', 'https://x.example.com']), true);
  assert.equal(denied(['C:\\Windows\\System32\\curl.exe', 'https://x.example.com']), true);
  // Case-insensitive, because Windows filenames are.
  assert.equal(denied(['WGET.EXE', 'https://x.example.com']), true);

  // And a command that is not a network tool stays allowed, however it is
  // spelled — the fix must not turn into a blanket deny.
  assert.equal(denied(['C:\\tools\\npm.exe', 'test']), false);
});

// The exec allow list reads the same name, so a Windows-shaped path still
// resolves to the tool it is.
test('the exec layer resolves a Windows-shaped path to the tool it is', () => {
  const policy = levelPolicy(3);
  const allowed = (argv: string[]) => check(policy, { op: 'exec', argv }).allow;

  assert.equal(allowed(['C:\\Program Files\\nodejs\\node.exe', 'x.js']), true);
  // Still denied through a full path — the never-list is not path-dependent.
  assert.equal(allowed(['C:\\tools\\git.exe', 'push']), false);
});

// The word boundary in front of a never-listed command used to exclude `/`, so writing
// the command with a directory in front of it stepped around the whole list on the paths that scan the raw string.
test('a directory in front of the command name does not hide the never-list', () => {
  const policy = levelPolicy(2);
  for (const argv of [
    ['sh', '-c', '/usr/bin/git push origin main'],
    ['sh', '-c', '/usr/bin/ssh evil.com'],
    ['bash', '-c', '/usr/local/bin/git push origin main'],
  ]) {
    assert.equal(check(policy, { op: 'exec', argv }).allow, false, argv.join(' '));
  }
});

test('a word character in front still blocks the match, so mygit is not git', () => {
  const policy = levelPolicy(2);
  assert.equal(
    check(policy, { op: 'exec', argv: ['sh', '-c', 'mygit push origin main'] }).allow,
    true,
  );
});

// `gh` was off level 2's allow list, which at that level is not a denial —
// onUnknownAction: "allow" waved every subcommand through, including the one that can perform every never-listed action.
test('gh is denied at every level, not merely unlisted', () => {
  for (const level of [2, 3, 4]) {
    const policy = levelPolicy(level);
    for (const argv of [
      ['gh', 'api', '--method', 'PUT', '/repos/o/r/pulls/1/merge'],
      ['gh', 'api', '-X', 'POST', '/repos/o/r/releases'],
      ['gh', 'pr', 'review', '--approve', '1'],
      ['gh', 'auth', 'token'],
    ]) {
      assert.equal(
        check(policy, { op: 'exec', argv }).allow,
        false,
        `L${level}: ${argv.join(' ')}`,
      );
    }
  }
});

// The host regex demanded a dotted TLD, so a raw IP, an IPv6 literal and `host:port`
// all matched nothing — `hosts` came out empty, the "unknown" filter had nothing to reject, and the layer answered "host allowed".
test('a target the allow list cannot parse is refused, not waved through', () => {
  const policy = levelPolicy(3);
  const allowed = policy.network.allowHosts;
  assert.ok(policy.network.enabled && policy.network.mode === 'allowlist');

  for (const argv of [
    ['curl', 'http://93.184.216.34/x'],
    ['curl', '93.184.216.34'],
    ['curl', 'http://[2606:2800:220:1:248:1893:25c8:1946]/x'],
    ['wget', 'localhost:8080/x'],
    ['curl'],
  ]) {
    assert.equal(netCheck(policy, { op: 'exec', argv }).allow, false, argv.join(' '));
  }

  // A host that IS on the list still works, and a non-network command is
  // untouched.
  if (allowed.length > 0) {
    assert.equal(
      netCheck(policy, { op: 'exec', argv: ['curl', `https://${allowed[0]}/x`] }).allow,
      true,
    );
  }
  assert.equal(netCheck(policy, { op: 'exec', argv: ['ls', '-la'] }).allow, true);
});
