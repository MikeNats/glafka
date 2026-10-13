import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toArgvSegments } from '../../installKit/guardrails/layers/shellwords.js';

// Old bug: a backslash before a letter broke word matching.
// A real shell treats it as a normal letter.
test('a backslash before a letter is treated as an escape, same as a real shell', () => {
  const result = toArgvSegments('g\\it push origin main');
  assert.deepEqual(result.segments, [['git', 'push', 'origin', 'main']]);
});

test('backslash-escape works mid-word, not just at the start', () => {
  const result = toArgvSegments('gi\\t push');
  assert.deepEqual(result.segments, [['git', 'push']]);
});

test('a trailing lone backslash does not crash the tokenizer', () => {
  const result = toArgvSegments('echo hi\\');
  assert.deepEqual(result.segments, [['echo', 'hi']]);
});

test('quoting still works exactly as before — unaffected by the backslash fix', () => {
  const result = toArgvSegments("'g'it push");
  assert.deepEqual(result.segments, [['git', 'push']]);
});

test('plain commands with no backslash are unaffected', () => {
  const result = toArgvSegments('npm run build');
  assert.deepEqual(result.segments, [['npm', 'run', 'build']]);
});

// A real shell treats backslash-newline as a line continuation and removes BOTH
// characters. The old code kept the newline as a literal character instead, so `gi\<newline>t` tokenized as the word "gi\nt" — never matching "git" in the never-list, at level 2 where an unrecognized name just falls through onUnknownAction: "allow".
test('backslash-newline is a line continuation, removed like a real shell removes it', () => {
  const result = toArgvSegments('gi\\\nt push origin main');
  assert.deepEqual(result.segments, [['git', 'push', 'origin', 'main']]);
});

test('the same escape works for other never-listed commands too', () => {
  assert.deepEqual(toArgvSegments('s\\\nsh user@host').segments, [['ssh', 'user@host']]);
  assert.deepEqual(toArgvSegments('np\\\nm publish').segments, [['npm', 'publish']]);
  assert.deepEqual(toArgvSegments('rsyn\\\nc a b').segments, [['rsync', 'a', 'b']]);
});

test('backslash-newline works mid-word and across multiple splits', () => {
  assert.deepEqual(toArgvSegments('gi\\\nt pu\\\nsh origin main').segments, [
    ['git', 'push', 'origin', 'main'],
  ]);
});

// Old bug: text inside quotes was split as if it were real code.
// A ; or && inside quotes should stay as plain text.
test('a semicolon inside a quoted argument is not a command separator', () => {
  const result = toArgvSegments("git commit -m 'fix a; then b'");
  assert.deepEqual(result.segments, [['git', 'commit', '-m', 'fix a; then b']]);
});

test('&& inside a quoted argument is not a command separator', () => {
  const result = toArgvSegments("git commit -m 'fix a && b'");
  assert.deepEqual(result.segments, [['git', 'commit', '-m', 'fix a && b']]);
});

test('an unquoted separator still splits into two commands', () => {
  const result = toArgvSegments('ls && pwd');
  assert.deepEqual(result.segments, [['ls'], ['pwd']]);
});

test('a plain quoted commit message is unaffected', () => {
  const result = toArgvSegments("git commit -m 'plain message'");
  assert.deepEqual(result.segments, [['git', 'commit', '-m', 'plain message']]);
});

// --------------------------------------------------------------------------- Tests for past bug
// fixes. ---------------------------------------------------------------------------

// Old bug: a command using a shell variable was not checked properly.
// This could let unsafe commands run.
test('a bare shell variable makes the command unreadable, not readable-but-wrong', () => {
  for (const command of [
    'p=config git $p --global core.hooksPath /tmp/evil',
    'p=push git $p origin main',
    'x=publish npm $x',
  ]) {
    const result = toArgvSegments(command);
    assert.equal(result.segments, undefined, command);
    assert.match(result.unreadable!, /variable/);
  }
});

// The ${VAR} form was already blocked, and still is.
test('the braced form is still refused too', () => {
  assert.equal(toArgvSegments('git ${VERB} origin main').segments, undefined);
});

// Old bug: a > or < inside quotes looked like a redirect.
// Text inside quotes should not be treated as a command.
test('a redirection character inside quotes is not a redirection', () => {
  for (const command of [
    'git commit -m "handle a > b correctly"',
    "rg 'a -> b' src/",
    'node -e "if (1 < 2) console.log(1)"',
  ]) {
    const result = toArgvSegments(command);
    assert.notEqual(result.segments, undefined, command);
  }
});

test('a real redirection outside quotes is still refused', () => {
  for (const command of ['npm test > out.txt', 'cat < secrets.txt', 'npm run build 2>/dev/null']) {
    const result = toArgvSegments(command);
    assert.equal(result.segments, undefined, command);
    assert.match(result.unreadable!, /redirection/);
  }
});

// 2>&1 does not point to a file, so it should be allowed.
// Only real file redirects should be blocked.
test('a file-descriptor duplication is not a redirection to a file', () => {
  for (const command of ['npm test 2>&1', 'pytest -q 2>&1', 'make build >&2', 'node x.js 2>&-']) {
    const result = toArgvSegments(command);
    assert.notEqual(result.segments, undefined, command);
  }
});

// `>&word` is a real redirection to a FILE whenever `word` is not purely digits/`-`.
// The old regex stripped the `>&1` prefix off of `>&1/../../../ESCAPED.txt` too, so this looked like two clean, harmless commands (`mkdir -p 1` and `echo ESCAPED /../../../ESCAPED.txt`) instead of a write outside the worktree. It must stay unreadable, so the exec layer either refuses it (levels 3/4) or scans it as a raw string instead of trusting it as parsed argv (level 2).
test('a redirect-to-file disguised as an fd-duplication stays unreadable', () => {
  const result = toArgvSegments('mkdir -p 1 && echo ESCAPED >&1/../../../ESCAPED.txt');
  assert.notEqual(result.unreadable, undefined);
  assert.equal(result.segments, undefined);
});

// The fix above still ran the FD_DUP regex against a truncated
// `chars.slice(i, i + FD_DUP_MAX_LEN)` window before checking the boundary. A digit run long enough to fill that 12-char window exactly (e.g. a 10-digit fd, `>&1234567890`) made the trailing `(?=\s|$)` lookahead match the WINDOW's own end, not the real command's — so the same disguised-redirect trick worked again, just with more digits. The boundary must be checked against the full string, not the window.
test('a digit run that exactly fills the fd-dup scan window still stays unreadable', () => {
  const result = toArgvSegments(
    'mkdir -p 1234567890 && echo x >&1234567890/../../../STILL-ESCAPED.txt',
  );
  assert.notEqual(result.unreadable, undefined);
  assert.equal(result.segments, undefined);
});

// Same trick, digit run one shorter — makes sure the boundary check isn't
// accidentally keyed to one specific length.
test('shorter digit runs disguising a redirect are caught too', () => {
  for (const digits of ['1', '12', '123456789', '1234567890', '123456789012']) {
    const result = toArgvSegments(`echo x >&${digits}/evil.txt`);
    assert.notEqual(result.unreadable, undefined, digits);
  }
});

// Third round on the same regex. `[-\d]+` accepted a MIX of digits and hyphens, but a real
// duplication is either all digits (`2>&1`) or the single closing `-` (`2>&-`) — never both. bash reads `>&2-4` as a filename and really does create a file called `2-4`, so stripping it hid the redirect and `echo x >&2-4` came out as a harmless two-word `echo`.
test('a mixed digit/hyphen word after >& is a filename, not an fd-duplication', () => {
  for (const command of ['echo x >&2-4', 'echo x >&3-9', 'echo x >&1-2']) {
    const result = toArgvSegments(command);
    assert.notEqual(result.unreadable, undefined, command);
    assert.equal(result.segments, undefined, command);
  }
});

// ANSI-C quoting. bash turns the escapes inside $'...' into characters BEFORE it decides what the
// command is, so `$'\x67it' push` really runs `git push` while the tokenizer only ever sees the literal word `$\x67it` — and the never-list never matches it. It has to be caught on the RAW string: EXPANDS is tested against withoutQuoted(), which strips the very quote character that makes this form what it is.
test("ANSI-C quoting $'...' is unreadable, so a hidden command name cannot slip past", () => {
  for (const command of [
    String.raw`$'\x67it' push origin main`,
    String.raw`$'\x63url' http://example.com`,
    String.raw`echo hi; $'\x73sh' user@host`,
  ]) {
    const result = toArgvSegments(command);
    assert.notEqual(result.unreadable, undefined, command);
  }
});

// 2>&1 should not get split into two separate commands.
test('a stripped fd-duplication leaves no phantom command behind', () => {
  assert.deepEqual(toArgvSegments('npm test 2>&1').segments, [['npm', 'test']]);
  assert.deepEqual(toArgvSegments('npm test 2>&1 && echo done').segments, [
    ['npm', 'test'],
    ['echo', 'done'],
  ]);
});

test('an fd-duplication inside quotes is data, not syntax', () => {
  assert.deepEqual(toArgvSegments('git commit -m "redirect 2>&1 please"').segments, [
    ['git', 'commit', '-m', 'redirect 2>&1 please'],
  ]);
});

// The same rule applies to other patterns: quoted text is just data.
test('command substitution inside quotes is still refused — it really does expand', () => {
  // Double quotes let $(...) run. Blocking both quote types is the safe choice.
  assert.equal(toArgvSegments('git commit -m "$(whoami)"').segments, undefined);
});

// `(` and `)` are shell metacharacters: unquoted they end a word, so `(git push)` runs
// git. They used to be glued onto the word, which made the command name `(git` and skipped the never-list entirely.
test('a subshell paren does not become part of the command name', () => {
  assert.deepEqual(toArgvSegments('(git push origin main)').segments, [
    ['git', 'push', 'origin', 'main'],
  ]);
  assert.deepEqual(toArgvSegments('(ssh evil.com)').segments, [['ssh', 'evil.com']]);
  // The form that already worked, because the space made `{` its own token.
  assert.deepEqual(toArgvSegments('{ git push origin main; }').segments?.[0], [
    '{',
    'git',
    'push',
    'origin',
    'main',
  ]);
});

test('braces are left alone, so brace expansion is not split', () => {
  // `{` is a reserved word, not a metacharacter, so it must NOT separate.
  assert.deepEqual(toArgvSegments('cp file{1,2}.txt dest/').segments, [
    ['cp', 'file{1,2}.txt', 'dest/'],
  ]);
});

test('an ordinary subshell still reads as its real commands', () => {
  assert.deepEqual(toArgvSegments('(cd src && make)').segments, [['cd', 'src'], ['make']]);
});

// The assignments used to be dropped and never seen again,
// which deleted the half of the line that decides what the command does.
test('an environment prefix that can redirect the command is refused', () => {
  for (const command of [
    'GIT_DIR=/victim/.git git checkout main',
    'GIT_SSH_COMMAND=./x git rebase origin/main',
    'GIT_PAGER=./x git log',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager git log',
    'PATH=/tmp/scratch git status',
    'NODE_OPTIONS=--require=/tmp/x.js node x.js',
    'LD_PRELOAD=/tmp/x.so ls',
  ]) {
    assert.notEqual(toArgvSegments(command).unreadable, undefined, command);
  }
});

test('a harmless environment prefix still runs, and is still stripped', () => {
  assert.deepEqual(toArgvSegments('NODE_ENV=test npm test').segments, [['npm', 'test']]);
  assert.deepEqual(toArgvSegments('CI=1 npm run build').segments, [['npm', 'run', 'build']]);
});
