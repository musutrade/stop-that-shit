'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { defaultContract, narrowContract, parseContractPrompt } = require('../src/contracts.cjs');
const { decide } = require('../src/decision.cjs');
const { handleControlEvent } = require('../src/controller.cjs');
const { freshState, readState, statePath, writeState } = require('../src/state.cjs');
const codex = require('../src/adapters/codex-hooks.cjs');
const claude = require('../src/adapters/claude-hooks.cjs');
const opencode = require('../src/adapters/opencode-hooks.cjs');
const v2 = require('../src/adapters/opencode-v2-hooks.cjs');

function fixture(t, family = 'codex') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sts-audit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace'), output = path.join(root, 'audit output'), bin = path.join(root, 'bin');
  for (const dir of [cwd, output, bin]) fs.mkdirSync(dir);
  fs.mkdirSync(path.join(cwd, '.git'));
  const executable = path.join(bin, process.platform === 'win32' ? 'crewmoor.exe' : 'crewmoor');
  fs.writeFileSync(executable, 'owned test executable', { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + oldPath;
  t.after(() => { process.env.PATH = oldPath; });
  const sessionId = 'native-owned-worker';
  const endpoint = (role, agent, session) => ({ handle: role + ':pane', native_session: session,
    context: { instance: role + '-instance', registration: { team: 'owned', role, task: 'issue-1', agent, cwd } } });
  const binding = { team: 'owned', worker: endpoint('audit', family === 'claude-code' ? 'claude' : family, sessionId), dispatcher: endpoint('dispatcher', 'codex', 'native-dispatcher'),
    config: { worker: { instance: 'audit-instance', handle: 'audit:pane' }, dispatcher: { instance: 'dispatcher-instance', handle: 'dispatcher:pane' } } };
  const bindingPath = path.join(root, 'binding.json');
  fs.writeFileSync(bindingPath, JSON.stringify(binding));
  const messagePath = path.join(output, 'message.json');
  const message = { id: 'report-1', from: 'audit', to: 'dispatcher', reply_to: null, content: 'Audit complete.' };
  fs.writeFileSync(messagePath, JSON.stringify(message));
  const context = { cwd, sessionId, hostFamily: family };
  const prompt = `$stop-that-shit review audit-dir="${output}" report-binding="${bindingPath}" -- Review Issue #1`;
  const parsed = parseContractPrompt(prompt, defaultContract(), context);
  assert.equal(parsed.error, null);
  const action = { hostFamily: family, nativeSessionId: sessionId, cwd, mutability: 'write', name: family === 'opencode' ? 'write' : 'Write',
    input: family === 'opencode' ? { filePath: path.join(output, 'report.md'), content: 'finding' } : { file_path: path.join(output, 'report.md'), content: 'finding' },
    affectedPaths: [path.join(output, 'report.md')] };
  const command = `"${executable}" message send "${bindingPath}" "${messagePath}"`;
  const send = { hostFamily: family, nativeSessionId: sessionId, cwd, mutability: 'unknown', name: family === 'codex' ? 'exec_command' : family === 'opencode' ? 'bash' : 'Bash', input: { command } };
  return { root, cwd, output, context, prompt, contract: parsed.contract, bindingPath, binding, messagePath, message, action, send, command };
}

const allowed = (contract, action, state) => decide({ contract, action, state }).outcome === 'allow';

test('Issue #1 paired Bad/Good: only the explicit audit grant reverses a review write', t => {
  const f = fixture(t);
  assert.equal(allowed(parseContractPrompt('$stop-that-shit review -- inspect').contract, f.action), false, 'Bad: implicit report intent is not authority');
  assert.equal(allowed(f.contract, f.action), true, 'Good: explicit task-scoped external output');
  assert.equal(allowed(f.contract, f.send), true);
  assert.equal(allowed(defaultContract(), f.action), true, 'unconfirmed behavior unchanged');
});

test('grant parsing is explicit, atomic and restricted to enforcing review', t => {
  const f = fixture(t);
  for (const prompt of [JSON.stringify({ team: 'owned', message: { content: f.prompt } }), `Please save reports.\n${f.prompt}`, `> ${f.prompt}`]) {
    assert.deepEqual(parseContractPrompt(prompt).contract, defaultContract());
  }
  for (const head of ['change', 'answer', 'monitor', 'open', 'review off', 'review watch']) {
    const result = parseContractPrompt(`$stop-that-shit ${head} audit-dir="${f.output}" -- task`, f.contract, f.context);
    assert.equal(result.error.code, 'INVALID_AUDIT_GRANT');
    assert.deepEqual(result.contract, f.contract);
  }
  assert.ok(parseContractPrompt(f.prompt.replace(' -- Review', "' -- Review"), f.contract, f.context).error);
  for (const directory of ['relative', '', f.cwd, path.dirname(f.cwd), path.join(f.cwd, 'nonexistent'), path.join(f.root, 'missing')]) {
    const result = parseContractPrompt(`$stop-that-shit review audit-dir="${directory}" -- task`, f.contract, f.context);
    assert.ok(result.error, directory);
    assert.deepEqual(result.contract, f.contract);
  }
  for (const context of [{ ...f.context, sessionId: 'wrong' }, { ...f.context, hostFamily: 'opencode' }, { ...f.context, cwd: f.output }]) {
    assert.ok(parseContractPrompt(f.prompt, f.contract, context).error);
  }
});

test('new modes and corrections revoke; ordinary prompts and saved recovery retain only valid grants', t => {
  const f = fixture(t);
  assert.deepEqual(parseContractPrompt('Continue the audit', f.contract).contract, f.contract);
  for (const prompt of ['$stop-that-shit review -- next task', '$stop-that-shit change -- fix', '$stop-that-shit off', 'review only', 'stop',
    '$stop-that-shit audit-dir=none report-binding=none -- revoke']) {
    const result = parseContractPrompt(prompt, f.contract, f.context);
    assert.equal(result.error, null, prompt);
    assert.equal(result.contract.auditOutput, null, prompt);
    assert.equal(result.contract.reportBinding, null, prompt);
  }
  const state = freshState(); state.contract = f.contract;
  writeState(f.context.sessionId, state, f.root);
  assert.deepEqual(readState(f.context.sessionId, f.root).contract, f.contract);
  delete state.contract.auditOutput; delete state.contract.reportBinding;
  writeState('legacy', state, f.root);
  assert.equal(readState('legacy', f.root).contract.auditOutput, null);
  fs.writeFileSync(statePath('legacy', f.root), '{bad json');
  const damaged = readState('legacy', f.root);
  assert.equal(damaged.contract.auditOutput, null);
  assert.equal(allowed(f.contract, f.action, damaged), false);
  const malformed = freshState(); malformed.contract.auditOutput = { directory: 'relative', workspace: f.cwd };
  writeState('malformed', malformed, f.root);
  assert.ok(readState('malformed', f.root).storageError);
});

test('absolute and relative artifact paths work; boundary, traversal, unknown and mixed writes deny', t => {
  const f = fixture(t);
  const write = target => ({ ...f.action, input: { file_path: target }, affectedPaths: [target] });
  assert.equal(allowed(f.contract, { ...write('report.md'), cwd: f.output }), true);
  const sub = path.join(f.output, 'sub'); fs.mkdirSync(sub);
  assert.equal(allowed(f.contract, write(path.join(sub, 'new.md'))), true);
  for (const target of [path.join(f.cwd, 'code.js'), path.join(f.cwd, '.config'), f.output, f.output + '-evil/report.md',
    path.join(f.output, 'missing', 'file.md'), f.output + '/sub/../escape.md', '', undefined]) {
    assert.equal(allowed(f.contract, write(target)), false, String(target));
  }
  const mixed = { ...f.action, name: 'apply_patch', input: `*** Begin Patch\n*** Add File: ${f.output}/good.md\n+ok\n*** Add File: ${f.cwd}/code.js\n+no\n*** End Patch` };
  assert.equal(allowed(f.contract, mixed), false);
  mixed.input = `*** Begin Patch\n*** Add File: ${f.output}/good.md\n+ok\n*** End Patch`;
  assert.equal(allowed(f.contract, mixed), true);
  for (const action of [{ ...f.action, name: 'unknown_write' }, { ...f.send, input: { command: `echo report > "${f.output}/report.md"` }, mutability: 'write' },
    { ...f.action, name: 'apply_patch', input: `*** Begin Patch\n*** Delete File: ${f.messagePath}\n*** End Patch` }]) {
    assert.equal(allowed(f.contract, action), false);
  }
});

test('symlink output, target, parent and binding escapes deny, including replacement after grant', t => {
  const f = fixture(t);
  const link = path.join(f.output, 'escape');
  fs.symlinkSync(f.cwd, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(allowed(f.contract, { ...f.action, input: { file_path: path.join(link, 'code.js') } }), false);
  const result = parseContractPrompt(`$stop-that-shit review audit-dir="${link}" -- task`, f.contract, f.context);
  assert.ok(result.error);
  const moved = f.output + '-saved'; fs.renameSync(f.output, moved);
  fs.symlinkSync(f.cwd, f.output, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(allowed(f.contract, f.action), false);
  assert.equal(allowed(f.contract, f.send), false);
  fs.unlinkSync(f.output); fs.renameSync(moved, f.output);
  const savedBinding = f.bindingPath + '.saved'; fs.renameSync(f.bindingPath, savedBinding);
  fs.symlinkSync(savedBinding, f.bindingPath);
  assert.equal(allowed(f.contract, f.send), false);
});

test('report requires exact operation, native session, binding identity, tool and flat message target', t => {
  const f = fixture(t);
  for (const command of [f.command + ';', f.command + ' && cat report', f.command + ' | cat', f.command + ' > log', 'env ' + f.command,
    `bash -c '${f.command}'`, f.command.replace('message send', 'message bind'), f.command.replace('message send', 'feedback show'),
    f.command + ' extra', f.command.replace('message send', 'message $OP'), f.command.replace('crewmoor', 'unknown')]) {
    assert.equal(allowed(f.contract, { ...f.send, input: { command } }), false, command);
  }
  for (const patch of [{ nativeSessionId: 'foreign-session' }, { hostFamily: 'opencode' }, { child: true }, { name: 'mcp__crewmoor__send' },
    { input: { command: f.command, env: { X: 'Y' } } }, { input: { command: f.command, shell: '/tmp/custom-shell' } }]) {
    assert.equal(allowed(f.contract, { ...f.send, ...patch }), false);
  }
  for (const patch of [{ from: 'dev' }, { to: 'foreign' }, { content: '' }, { reply_to: f.message.id }, { extra: 'unknown' }]) {
    fs.writeFileSync(f.messagePath, JSON.stringify({ ...f.message, ...patch }));
    assert.equal(allowed(f.contract, f.send), false, JSON.stringify(patch));
  }
  fs.writeFileSync(f.messagePath, JSON.stringify(f.message));
  for (const endpoint of ['worker', 'dispatcher']) {
    for (const key of ['native_session', 'handle']) {
      const changed = structuredClone(f.binding); changed[endpoint][key] = 'foreign';
      fs.writeFileSync(f.bindingPath, JSON.stringify(changed));
      assert.equal(allowed(f.contract, f.send), false);
    }
  }
  fs.unlinkSync(f.bindingPath);
  assert.equal(allowed(f.contract, f.send), false);
});

test('audit exception preserves hash, dependencies, file lock, delegation and child narrowing', t => {
  const f = fixture(t);
  assert.equal(allowed(f.contract, { ...f.action, hashIntent: true }), false);
  assert.equal(allowed(f.contract, { ...f.action, dependencyIntent: true }), false);
  assert.equal(allowed({ ...f.contract, allowedPaths: ['src/**'] }, f.action), false);
  assert.equal(allowed({ ...f.contract, agentBudget: 0 }, { ...f.action, name: 'spawn_agent', mutability: 'delegate' }), false);
  assert.equal(narrowContract({ ...f.contract, auditOutput: null, reportBinding: null }, f.contract).auditOutput, null);
  assert.equal(narrowContract(f.contract, defaultContract()).auditOutput.directory, f.output);
  const child = structuredClone(f.contract); child.auditOutput.directory = path.join(f.output, 'sub');
  assert.equal(narrowContract(f.contract, child).auditOutput.directory, child.auditOutput.directory);
  child.auditOutput.directory = f.root;
  assert.equal(narrowContract(f.contract, child).auditOutput, null);
  const state = freshState(); state.contract = f.contract;
  writeState('child-boundary', state, f.root);
  const event = { protocolVersion: 2, lifecycleVersion: 2, kind: 'prompt.submit', sessionId: 'child-boundary',
    agent: { agentId: 'child-a' }, host: { family: 'codex' }, cwd: f.cwd,
    prompt: `$stop-that-shit review audit-dir="${path.join(f.root, 'elsewhere')}" -- widen` };
  fs.mkdirSync(path.join(f.root, 'elsewhere'));
  assert.equal(handleControlEvent(event, { dataDir: f.root }).error.code, 'AUDIT_BOUNDARY_WIDEN');
});

for (const family of ['codex', 'claude-code', 'opencode']) {
  test(`${family} adapter: explicit root grant, permitted artifact/report, resume and revoke`, t => {
    const f = fixture(t, family);
    const options = { dataDir: path.join(f.root, 'data') };
    const native = { hook_event_name: 'UserPromptSubmit', session_id: f.context.sessionId, cwd: f.cwd, prompt: f.prompt };
    const promptEvent = family === 'codex' ? codex.toControlEvent(native) : family === 'claude-code' ? claude.toControlEvent(native)
      : opencode.toPromptEvent({ sessionID: f.context.sessionId }, { parts: [{ type: 'text', text: f.prompt }] }, { directory: f.cwd });
    assert.equal(handleControlEvent(promptEvent, options).kind, 'context');
    const actionEvent = input => family === 'codex' ? codex.toControlEvent({ ...native, hook_event_name: 'PreToolUse', tool_name: input.name, tool_input: input.input })
      : family === 'claude-code' ? claude.toControlEvent({ ...native, hook_event_name: 'PreToolUse', tool_name: input.name, tool_input: input.input })
        : opencode.toActionEvent({ sessionID: f.context.sessionId, tool: input.name }, { args: input.input }, { directory: f.cwd });
    assert.equal(handleControlEvent(actionEvent(f.action), options).kind, 'none');
    assert.equal(handleControlEvent(actionEvent(f.send), options).kind, 'none');
    const resumed = { ...promptEvent, prompt: 'Continue the same audit' };
    handleControlEvent(resumed, options);
    assert.equal(handleControlEvent(actionEvent(f.action), options).kind, 'none');
    if (family === 'opencode') {
      const event = v2.toV2ActionEvent({ tool: 'write', sessionID: f.context.sessionId, input: { path: path.join(f.output, 'v2.md'), content: 'audit' } }, { directory: f.cwd });
      assert.equal(handleControlEvent(event, options).kind, 'none');
      event.sourceSessionId = 'foreign-child';
      event.action = v2.toV2ActionEvent({ tool: 'shell', sessionID: 'foreign-child', input: { command: f.command } }, { directory: f.cwd }).action;
      assert.equal(handleControlEvent(event, options).kind, 'deny');
    }
    handleControlEvent({ ...promptEvent, prompt: '$stop-that-shit review -- next task' }, options);
    assert.equal(handleControlEvent(actionEvent(f.action), options).kind, 'deny');
  });
}
