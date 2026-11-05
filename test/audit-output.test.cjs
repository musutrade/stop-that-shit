'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { auditWritePaths, validAuditDirectory } = require('../src/audit-output.cjs');
const { defaultContract, parseContractPrompt, narrowContract } = require('../src/contracts.cjs');
const { decodeState, freshState } = require('../src/state-schema.cjs');
const { decide } = require('../src/decision.cjs');
const { handleCodexHook, toControlEvent: codexEvent } = require('../src/adapters/codex-hooks.cjs');
const { handleClaudeHook, toControlEvent: claudeEvent } = require('../src/adapters/claude-hooks.cjs');
const { toActionEvent: openCodeEvent, handleOpenCodeMessage, handleOpenCodeTool } = require('../src/adapters/opencode-hooks.cjs');
const { toV2ActionEvent } = require('../src/adapters/opencode-v2-hooks.cjs');
const { handleControlEvent } = require('../src/controller.cjs');
const { readState } = require('../src/state.cjs');

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sts-audit-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'repo');
  const directory = path.join(base, 'audit', 'task-42');
  const dataDir = path.join(base, 'state');
  fs.mkdirSync(cwd);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'report.md');
  const outside = path.join(cwd, 'source.js');
  fs.writeFileSync(outside, 'untouched');
  const contract = parseContractPrompt(`$stop-that-shit review audit-dir=${directory} -- inspect`).contract;
  return { base, cwd, directory, dataDir, file, outside, contract };
}

const patch = (...operations) => `*** Begin Patch\n${operations.join('\n')}\n*** End Patch`;
const add = file => `*** Add File: ${file}\n+report`;
function action(f, host, name, input) {
  if (host === 'opencode') return openCodeEvent({ tool: name, sessionID: 'test', callID: 'write-1' },
    { args: input }, { directory: f.cwd }).action;
  if (host === 'opencode-v2') return toV2ActionEvent({ tool: name, sessionID: 'test', id: 'write-1',
    messageID: 'assistant-1', input }, { directory: f.cwd }).action;
  const toEvent = host === 'codex' ? codexEvent : claudeEvent;
  return toEvent({ hook_event_name: 'PreToolUse', session_id: 'test', tool_use_id: 'write-1',
    tool_name: name, tool_input: input, cwd: f.cwd }).action;
}
function verdict(f, host, name, input, contract = f.contract) {
  return decide({ contract, action: action(f, host, name, input) });
}

test('audit directory is explicit, review-only, exact, and revocable', t => {
  const f = fixture(t);
  assert.equal(defaultContract().auditDirectory, null);
  assert.equal(f.contract.auditDirectory, f.directory);
  assert.equal(parseContractPrompt('continue reviewing', f.contract).contract.auditDirectory, f.directory);
  for (const text of ['$stop-that-shit review -- next task', 'review only', '只看不改', '$stop-that-shit change -- fix']) {
    assert.equal(parseContractPrompt(text, f.contract).contract.auditDirectory, null, text);
  }
  assert.equal(parseContractPrompt('$stop-that-shit audit-dir=none -- revoke', f.contract).contract.auditDirectory, null);
  for (const mode of ['answer', 'monitor', 'change', 'open']) {
    assert.equal(parseContractPrompt(`$stop-that-shit ${mode} audit-dir=${f.directory}`).error.code, 'AUDIT_REQUIRES_REVIEW');
  }
  const doubleDash = `${f.directory}--exact`;
  assert.equal(parseContractPrompt(`$stop-that-shit review audit-dir=${doubleDash} -- inspect`).contract.auditDirectory, doubleDash);
  for (const text of [`> $stop-that-shit review audit-dir=${f.directory}`, `Example: $stop-that-shit review audit-dir=${f.directory}`]) {
    assert.equal(parseContractPrompt(text).contract.auditDirectory, null);
  }
  assert.equal(parseContractPrompt(`$stop-that-shit review audit-dir=${f.directory} audit-dir=none`).error.code, 'CONFLICTING_DIRECTIVE');
});

test('audit directory grammar rejects expansion, traversal, aliases and broad roots', t => {
  const f = fixture(t);
  for (const value of ['', 'relative', '.', '..', path.parse(f.directory).root,
    `${f.directory}/../other`, `${f.directory}/**`, `${f.directory}/`, `${f.directory}/a b`,
    `${f.directory}/x:y`, `${f.directory}/NUL.md`, `${f.directory}/trailing.`, `${f.directory}/\nfile`,
    '//server/share', '\\\\?\\C:\\audit']) {
    assert.equal(validAuditDirectory(value), false, value);
  }
});

test('old stored states remain compatible and malformed new authority fails closed', t => {
  const f = fixture(t);
  const old = freshState();
  delete old.contract.auditDirectory;
  assert.equal(decodeState(old).contract.auditDirectory, null);
  for (const value of [true, [], {}, 'relative', `${f.directory}/../outside`]) {
    assert.throws(() => decodeState({ ...freshState(), contract: { ...f.contract, auditDirectory: value } }), SyntaxError);
  }
  assert.equal(decodeState({ ...freshState(), contract: f.contract }).contract.auditDirectory, f.directory);
});

test('child contracts never widen or resurrect audit authority', t => {
  const f = fixture(t);
  assert.equal(narrowContract(f.contract, defaultContract()).auditDirectory, f.directory);
  assert.equal(narrowContract(f.contract, f.contract).auditDirectory, f.directory);
  for (const child of [parseContractPrompt('$stop-that-shit review').contract,
    { ...f.contract, mode: 'answer' }, { ...f.contract, mode: 'monitor' },
    { ...f.contract, auditDirectory: path.join(f.base, 'other') }]) {
    assert.equal(narrowContract(f.contract, child).auditDirectory, null);
  }
  assert.equal(narrowContract(parseContractPrompt('$stop-that-shit review').contract, f.contract).auditDirectory, null);
});

test('paired case: default review denies, explicit audit output allows known file writes', t => {
  const f = fixture(t);
  const requests = [
    ['codex', 'apply_patch', patch(add(f.file))],
    ['codex', 'apply_patch', { patch: patch(add(f.file), add(path.join(f.directory, 'message.json'))) }],
    ['claude-code', 'Write', { file_path: f.file, content: '# Findings\n'.repeat(30000) }],
    ['claude-code', 'Edit', { file_path: f.file, old_string: 'old', new_string: 'new', replace_all: false }]
  ];
  for (const [host, name, input] of requests) {
    assert.equal(verdict(f, host, name, input, { ...f.contract, auditDirectory: null }).reasonCode, 'MODE_FORBIDS_MUTATION');
    assert.equal(verdict(f, host, name, input).outcome, 'allow', name);
  }
  // A cwd-relative patch is allowed only with the host's absolute cwd.
  const nested = { ...f, cwd: f.base };
  assert.equal(verdict(nested, 'codex', 'apply_patch', patch(add('audit/task-42/nested/report.md'))).outcome, 'allow');
  assert.equal(verdict({ ...f, cwd: '' }, 'codex', 'apply_patch', patch(add(f.file))).reasonCode, 'MODE_FORBIDS_MUTATION');
});

test('outside, mixed, rename and unproven tool writes remain denied', t => {
  const f = fixture(t);
  const denied = [
    ['codex', 'apply_patch', patch(add(f.outside))],
    ['codex', 'apply_patch', patch(add(f.file), add(f.outside))],
    ['codex', 'apply_patch', patch(`*** Update File: ${f.file}\n*** Move to: ${f.outside}\n@@\n-old\n+new`)],
    ['codex', 'apply_patch', patch(`*** Update File: ${f.outside}\n*** Move to: ${f.file}\n@@\n-old\n+new`)],
    ['codex', 'apply_patch', patch(add(`${f.directory}-other/report.md`))],
    ['codex', 'apply_patch', patch(add(`${f.directory}/../escape.md`))],
    ['codex', 'apply_patch', { patch: patch(add(f.file)), command: patch(add(f.outside)) }],
    ['codex', 'apply_patch', `*** Begin Patch\n${add(f.file)}\n*** Unknown: ${f.outside}\n*** End Patch`],
    ['codex', 'exec_command', { command: `echo report > ${f.file}` }],
    ['codex', 'mcp__fs__write_file', { path: f.file, content: 'report' }],
    ['claude-code', 'Bash', { command: `crewmoor message send binding.json ${path.join(f.directory, 'message.json')}` }],
    ['claude-code', 'Write', { file_path: f.file, path: f.outside, content: 'report' }],
    ['claude-code', 'Write', { file_path: `"${f.file}"`, content: 'report' }],
    ['claude-code', 'Write', { file_path: f.file, content: {} }],
    ['claude-code', 'Edit', { file_path: f.file, old_string: 'old', new_string: 'new', extra: f.outside }],
    ['claude-code', 'NotebookEdit', { notebook_path: f.file, new_source: 'report' }]
  ];
  for (const [host, name, input] of denied) {
    assert.notEqual(verdict(f, host, name, input).outcome, 'allow', `${host} ${name} ${JSON.stringify(input)}`);
  }
  assert.equal(auditWritePaths('unsupported-host', 'Write', { file_path: f.file, content: 'report' }), null);
  assert.notEqual(decide({ contract: f.contract, action: { mutability: 'unknown', auditWritePaths: [f.file], cwd: f.cwd } }).outcome, 'allow');
  assert.equal(fs.readFileSync(f.outside, 'utf8'), 'untouched');
});

test('audit writes still obey files, hash, dependency and recovery restrictions', t => {
  const f = fixture(t);
  const write = action(f, 'claude-code', 'Write', { file_path: f.file, content: 'report' });
  assert.equal(decide({ contract: { ...f.contract, allowedPaths: [] }, action: write }).reasonCode, 'PATH_OUTSIDE_CONTRACT');
  assert.equal(decide({ contract: f.contract, action: { ...write, hashIntent: true } }).reasonCode, 'HASH_NOT_AUTHORIZED');
  assert.equal(decide({ contract: f.contract, action: { ...write, dependencyIntent: true } }).reasonCode, 'DEPENDENCY_NOT_AUTHORIZED');
  assert.equal(decide({ contract: f.contract, action: write, state: { storageError: { code: 'STATE_DAMAGED', message: 'damaged' } } }).reasonCode, 'STATE_DAMAGED');
  assert.equal(decide({ contract: { ...f.contract, mode: 'monitor' }, action: write }).reasonCode, 'MODE_FORBIDS_MUTATION');
});

test('missing roots, worktree roots, directories and hardlinks cannot become audit output', t => {
  const f = fixture(t);
  const write = target => action(f, 'claude-code', 'Write', { file_path: target, content: 'report' });
  const decideAt = (directory, target) => decide({ contract: { ...f.contract, auditDirectory: directory }, action: write(target) });
  assert.equal(decideAt(path.join(f.base, 'missing'), path.join(f.base, 'missing/report.md')).reasonCode, 'MODE_FORBIDS_MUTATION');
  assert.equal(decideAt(f.cwd, f.outside).reasonCode, 'MODE_FORBIDS_MUTATION');
  assert.equal(decideAt(f.base, f.outside).reasonCode, 'MODE_FORBIDS_MUTATION');
  assert.equal(decideAt(f.directory, f.directory).reasonCode, 'MODE_FORBIDS_MUTATION');
  const dirTarget = path.join(f.directory, 'nested'); fs.mkdirSync(dirTarget);
  assert.equal(decideAt(f.directory, dirTarget).reasonCode, 'MODE_FORBIDS_MUTATION');
  fs.linkSync(f.outside, f.file);
  assert.equal(decideAt(f.directory, f.file).reasonCode, 'MODE_FORBIDS_MUTATION');
});

test('symlinked ancestors, audit roots, descendants and file targets fail closed', t => {
  const f = fixture(t);
  const linkedRoot = path.join(f.base, 'linked-root');
  const linkedFile = path.join(f.directory, 'link.md');
  const linkedDir = path.join(f.directory, 'linked-dir');
  try {
    fs.symlinkSync(f.directory, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(f.cwd, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(f.outside, linkedFile, 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows user cannot create file symlinks'); return; }
    throw error;
  }
  for (const [directory, target] of [[linkedRoot, path.join(linkedRoot, 'report.md')],
    [f.directory, linkedFile], [f.directory, path.join(linkedDir, 'report.md')]]) {
    assert.equal(verdict(f, 'claude-code', 'Write', { file_path: target, content: 'report' },
      { ...f.contract, auditDirectory: directory }).reasonCode, 'MODE_FORBIDS_MUTATION');
  }
  const ancestor = path.join(f.base, 'linked-ancestor');
  fs.symlinkSync(path.dirname(f.directory), ancestor, process.platform === 'win32' ? 'junction' : 'dir');
  const directory = path.join(ancestor, path.basename(f.directory));
  assert.equal(verdict(f, 'claude-code', 'Write', { file_path: path.join(directory, 'report.md'), content: 'report' },
    { ...f.contract, auditDirectory: directory }).reasonCode, 'MODE_FORBIDS_MUTATION');
});

for (const [host, hook, prefix, toolName, makeInput] of [
  ['codex', handleCodexHook, '$stop-that-shit', 'apply_patch', file => patch(add(file))],
  ['claude-code', handleClaudeHook, '/stop-that-shit:stop-that-shit', 'Write', file => ({ file_path: file, content: 'report' })]
]) {
  test(`${host} hook persists exact audit scope, resumes, and revokes it`, t => {
    const f = fixture(t);
    const options = { dataDir: f.dataDir };
    const prompt = text => hook({ hook_event_name: 'UserPromptSubmit', session_id: 'audit-hook', prompt: text, cwd: f.cwd }, options);
    const pre = file => hook({ hook_event_name: 'PreToolUse', session_id: 'audit-hook', tool_use_id: 'write-1',
      tool_name: toolName, tool_input: makeInput(file), cwd: f.cwd }, options);
    const active = prompt(`${prefix} review audit-dir=${f.directory} -- inspect`);
    assert.match(active.hookSpecificOutput.additionalContext, /audit-dir=/);
    assert.equal(readState('audit-hook', f.dataDir).contract.auditDirectory, f.directory);
    assert.equal(pre(f.file), null);
    assert.equal(pre(f.outside).hookSpecificOutput.permissionDecision, 'deny');
    prompt('continue');
    assert.equal(pre(f.file), null);
    prompt(`${prefix} review -- new task`);
    assert.equal(pre(f.file).hookSpecificOutput.permissionDecision, 'deny');
  });
}

test('packaged Codex and Claude hook entrypoints accept long reports without changing repo files', t => {
  const f = fixture(t);
  const root = path.join(__dirname, '..');
  for (const [name, script, tool, input] of [
    ['codex', 'codex-plugin/hooks/stop-that-shit.cjs', 'apply_patch', patch(`*** Add File: ${f.file}\n${'+findings\n'.repeat(20000).trimEnd()}`)],
    ['claude', 'hooks/stop-that-shit-claude.cjs', 'Write', { file_path: f.file, content: 'findings\n'.repeat(20000) }]
  ]) {
    const env = { ...process.env, PLUGIN_DATA: path.join(f.dataDir, name), CLAUDE_PLUGIN_DATA: path.join(f.dataDir, name) };
    const run = event => spawnSync(process.execPath, [path.join(root, script)], { cwd: f.cwd, encoding: 'utf8', env,
      input: JSON.stringify({ session_id: name, cwd: f.cwd, ...event }), maxBuffer: 2 * 1024 * 1024 });
    const setup = run({ hook_event_name: 'UserPromptSubmit', prompt: `$stop-that-shit review audit-dir=${f.directory} -- inspect` });
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stdout, /audit-dir=/);
    const allowed = run({ hook_event_name: 'PreToolUse', tool_use_id: 'long-report', tool_name: tool, tool_input: input });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stderr, '');
    assert.equal(allowed.stdout, '');
    const denied = run({ hook_event_name: 'PreToolUse', tool_use_id: 'outside', tool_name: tool,
      tool_input: name === 'codex' ? patch(add(f.outside)) : { file_path: f.outside, content: 'bad' } });
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
  assert.equal(fs.readFileSync(f.outside, 'utf8'), 'untouched');
});

for (const host of ['opencode', 'opencode-v2']) {
  test(`${host} supports strict native file schemas and rejects mixed or ambiguous calls`, t => {
    const f = fixture(t);
    const field = host === 'opencode' ? 'filePath' : 'path';
    const patchTool = host === 'opencode' ? 'apply_patch' : 'patch';
    for (const [tool, input] of [
      ['write', { [field]: f.file, content: 'long report\n'.repeat(20000) }],
      ['edit', { [field]: f.file, oldString: 'old', newString: 'new', replaceAll: false }],
      [patchTool, { patchText: patch(add(f.file)) }]
    ]) {
      assert.equal(verdict(f, host, tool, input).outcome, 'allow', tool);
      assert.equal(verdict(f, host, tool, input, { ...f.contract, auditDirectory: null }).reasonCode, 'MODE_FORBIDS_MUTATION');
    }
    for (const [tool, input] of [
      ['write', { [field]: f.outside, content: 'outside' }],
      ['write', { [field]: f.file, file_path: f.outside, content: 'ambiguous' }],
      ['write', { [field]: f.file, content: 'extra path', extra: f.outside }],
      [patchTool, { patchText: patch(add(f.file), add(f.outside)) }],
      [patchTool, { patchText: patch(add(f.file)), command: 'evil' }],
      [host === 'opencode' ? 'bash' : 'shell', { command: `echo report > ${f.file}` }],
      ['unknown_write', { [field]: f.file, content: 'report' }]
    ]) assert.notEqual(verdict(f, host, tool, input).outcome, 'allow', tool);
  });
  test(`${host} persists review audit scope and revokes it through the controller`, t => {
    const f = fixture(t);
    const options = { dataDir: f.dataDir };
    const prompt = text => handleOpenCodeMessage({ sessionID: 'test' }, { parts: [{ type: 'text', text }] },
      { directory: f.cwd }, options);
    const run = file => {
      const field = host === 'opencode' ? 'filePath' : 'path';
      const input = { [field]: file, content: 'report' };
      return host === 'opencode'
        ? handleOpenCodeTool({ tool: 'write', sessionID: 'test', callID: 'write-1' }, { args: input }, { directory: f.cwd }, options)
        : handleControlEvent(toV2ActionEvent({ tool: 'write', sessionID: 'test', messageID: 'assistant-1', id: 'write-1', input }, { directory: f.cwd }), options);
    };
    prompt(`$stop-that-shit review audit-dir=${f.directory}`);
    assert.equal(run(f.file).kind, 'none');
    assert.equal(run(f.outside).kind, 'deny');
    prompt('continue');
    assert.equal(run(f.file).kind, 'none');
    assert.equal(readState('test', f.dataDir).contract.auditDirectory, f.directory);
    prompt('$stop-that-shit review -- new task');
    assert.equal(run(f.file).kind, 'deny');
  });
}

test('OpenCode editable-host promotion cannot widen an active audit contract', async t => {
  const f = fixture(t);
  const { allowsHostPromotion } = await import('../opencode/runtime.mjs');
  assert.equal(allowsHostPromotion('continue', f.contract), false);
  assert.equal(allowsHostPromotion('hello', { ...f.contract, auditDirectory: null }), true);
});


test('Windows authority is drive-qualified and worktree equality is case-insensitive', () => {
  const vm = require('node:vm');
  const sandbox = { module: { exports: {} }, process: { platform: 'win32' }, require: name => {
    if (name === 'node:path') return path.win32;
    if (name === 'node:fs') return { realpathSync: { native: value => path.win32.resolve(value) },
      statSync: () => ({ isDirectory: () => true }), lstatSync: target => ({ isSymbolicLink: () => false,
      isDirectory: () => !target.endsWith('.md'), isFile: () => target.endsWith('.md'), nlink: 1 }) };
    throw new Error(`Unexpected import ${name}`);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/audit-output.cjs'), 'utf8'), sandbox);
  const api = sandbox.module.exports;
  for (const directory of ['/audit', '\\audit', 'C:audit', 'C:/audit/COM¹.txt', 'C:/audit/LPT²', '//host/share/audit', '\\\\?\\C:\\audit']) {
    assert.equal(api.validAuditDirectory(directory), false, directory);
  }
  assert.equal(api.validAuditDirectory('C:/audits/task-42'), true);
  const contract = { mode: 'review', auditDirectory: 'C:/Repo' };
  const action = { mutability: 'write', auditWritePaths: ['C:/Repo/report.md'], cwd: 'c:/repo' };
  assert.equal(api.allowsAuditWrite(contract, action), false);
  assert.equal(api.allowsAuditWrite({ ...contract, auditDirectory: 'C:/audits/task-42' },
    { ...action, auditWritePaths: ['C:/audits/task-42/report.md'] }), true);
});


test('an aliased cwd cannot authorize the whole reviewed directory', t => {
  const f = fixture(t);
  const alias = path.join(f.base, 'repo-alias');
  try { fs.symlinkSync(f.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows user cannot create junctions'); return; }
    throw error;
  }
  assert.equal(verdict({ ...f, cwd: alias }, 'claude-code', 'Write', { file_path: f.outside, content: 'bad' },
    { ...f.contract, auditDirectory: f.cwd }).reasonCode, 'MODE_FORBIDS_MUTATION');
  assert.equal(verdict({ ...f, cwd: alias }, 'claude-code', 'Write', { file_path: f.file, content: 'report' }).outcome, 'allow');
});


test('trusted absolute cwd permits spaces and trailing separators without widening output', t => {
  const f = fixture(t);
  const spaced = path.join(f.base, 'my repo'); fs.mkdirSync(spaced);
  for (const cwd of [spaced, `${f.cwd}${path.sep}`]) {
    assert.equal(verdict({ ...f, cwd }, 'claude-code', 'Write', { file_path: f.file, content: 'report' }).outcome, 'allow');
    assert.equal(verdict({ ...f, cwd }, 'claude-code', 'Write', { file_path: f.outside, content: 'bad' }).reasonCode, 'MODE_FORBIDS_MUTATION');
  }
});
