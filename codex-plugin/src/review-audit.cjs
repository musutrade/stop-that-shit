'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { directCommandArguments } = require('./shell-analysis.cjs');
const { inputText } = require('./tool-input.cjs');

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

// Check the original spelling before resolving: normalization would conceal a
// symlink followed by '..'. This is a static check, not filesystem confinement.
function validPathSpelling(value, platform = process.platform) {
  if (!text(value) || /[\0\r\n]/.test(value)) return false;
  const parts = value.split(/[\\/]/);
  if (parts.includes('..')) return false;
  // Win32 removes trailing dots/spaces from components, including '.. '. Do
  // not let lexical containment authorize a different filesystem destination.
  return platform !== 'win32' || !parts.some(part => part !== '.' && /[. ]$/.test(part));
}

function checkedPath(value, cwd, { directory = false, newFile = false } = {}) {
  if (!validPathSpelling(value) || cwd != null && !validPathSpelling(cwd)) throw new Error('Unproven path');
  if (process.platform !== 'win32' && (/^[A-Za-z]:[\\/]|^\\/.test(value) || value.includes('\\'))) throw new Error('Foreign path');
  if (!path.isAbsolute(value) && !path.isAbsolute(cwd || '')) throw new Error('Missing absolute cwd');
  const target = path.resolve(cwd || '', value);
  const root = path.parse(target).root;
  const parts = target.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (newFile && !directory && error.code === 'ENOENT' && i === parts.length - 1) return target;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('Symlink path');
    if (i < parts.length - 1 || directory) {
      if (!stat.isDirectory()) throw new Error('Not a directory');
    } else if (!stat.isFile() || stat.nlink !== 1) throw new Error('Not a private regular file');
  }
  if (!parts.length && !directory) throw new Error('Not a file');
  return fs.realpathSync(target);
}

function workspaceRoot(cwd) {
  const current = checkedPath(cwd, null, { directory: true });
  let parent = current;
  while (true) {
    if (fs.existsSync(path.join(parent, '.git'))) return parent;
    const next = path.dirname(parent);
    if (next === parent) return current;
    parent = next;
  }
}

function auditDirectory(value, cwd) {
  if (!path.isAbsolute(value || '')) throw new Error('audit-dir must be absolute');
  const directory = checkedPath(value, null, { directory: true });
  const workspace = workspaceRoot(cwd);
  if (inside(workspace, directory) || inside(directory, workspace)) throw new Error('audit-dir must be disjoint from the workspace');
  return { directory, workspace };
}

function executablePath(program) {
  const candidates = path.isAbsolute(program) ? [program] : program === path.basename(program)
    ? (process.env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(dir =>
      process.platform === 'win32' ? [path.join(dir, program), path.join(dir, `${program}.exe`)] : [path.join(dir, program)]) : [];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch {}
  }
  throw new Error('CrewMoor executable is unavailable');
}

function bindingIdentity(binding) {
  if (!record(binding) || !text(binding.team) || !record(binding.config)) throw new Error('Invalid binding');
  const endpoints = ['worker', 'dispatcher'].map(side => {
    const endpoint = binding[side], config = binding.config[side];
    const registration = endpoint?.context?.registration;
    if (!record(endpoint) || !record(config) || !record(registration)
        || registration.team !== binding.team || !text(registration.role) || !text(registration.task)
        || !text(registration.agent) || !text(endpoint.native_session)
        || !text(endpoint.context.instance) || config.instance !== endpoint.context.instance
        || !text(endpoint.handle) || config.handle !== endpoint.handle) throw new Error('Incomplete binding identity');
    return { ...registration, session: endpoint.native_session, instance: endpoint.context.instance };
  });
  const [worker, dispatcher] = endpoints;
  if (worker.role === dispatcher.role || worker.instance === dispatcher.instance
      || worker.session === dispatcher.session || worker.task !== dispatcher.task) throw new Error('Binding endpoints must be distinct and task bound');
  return { worker, dispatcher };
}

function reportBinding(value, context, output) {
  if (!path.isAbsolute(value || '') || !output) throw new Error('report-binding requires audit-dir and an absolute binding path');
  const file = checkedPath(value);
  if (inside(output.directory, file)) throw new Error('Binding configuration must be outside audit-dir');
  const binding = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { worker } = bindingIdentity(binding);
  const family = context.hostFamily === 'claude-code' ? 'claude' : context.hostFamily;
  if (!text(context.sessionId) || worker.session !== context.sessionId || worker.agent !== family
      || checkedPath(worker.cwd, null, { directory: true }) !== checkedPath(context.cwd, null, { directory: true })) {
    throw new Error('Binding does not identify this native host/session/cwd');
  }
  return { path: file, executable: executablePath('crewmoor'), snapshot: JSON.stringify(binding) };
}

function validAuditDirectory(value) {
  return value === null || record(value) && path.isAbsolute(value.directory || '') && path.isAbsolute(value.workspace || '')
    && !inside(value.directory, value.workspace) && !inside(value.workspace, value.directory);
}

function validReportBinding(value) {
  if (value === null) return true;
  if (!record(value) || !path.isAbsolute(value.path || '') || !path.isAbsolute(value.executable || '') || !text(value.snapshot)) return false;
  try { bindingIdentity(JSON.parse(value.snapshot)); return true; } catch { return false; }
}

function narrowedDirectory(parent, child) {
  if (!parent || !child || parent.workspace !== child.workspace || !inside(parent.directory, child.directory)) return null;
  return child;
}

function sameBinding(parent, child) {
  return Boolean(parent && child && parent.path === child.path && parent.executable === child.executable && parent.snapshot === child.snapshot);
}

function fileTargets(action) {
  const { hostFamily: host, name, input } = action;
  if ((host === 'codex' || host === 'claude-code') && ['Write', 'Edit'].includes(name)) return [input?.file_path || input?.path];
  if (host === 'opencode' && ['write', 'edit'].includes(name)) return [input?.filePath || input?.path];
  if ((host === 'codex' && name === 'apply_patch') || host === 'opencode' && ['apply_patch', 'patch'].includes(name)) {
    const patch = host === 'codex' ? inputText(input)
      : typeof input === 'string' ? input : input?.patchText || input?.patch || input?.input || '';
    if (typeof patch !== 'string' || /^\*\*\* (?:Delete File:|Move to:)/m.test(patch)) return null;
    return [...patch.matchAll(/^\*\*\* (?:Add|Update) File:\s*(.+?)\s*$/gm)].map(match => match[1]);
  }
  return null;
}

function artifactPath(value, output, cwd, newFile = false) {
  if (checkedPath(output.directory, null, { directory: true }) !== output.directory
      || checkedPath(output.workspace, null, { directory: true }) !== output.workspace) throw new Error('Grant path changed');
  const file = checkedPath(value, cwd, { newFile });
  if (!inside(output.directory, file) || file === output.directory) throw new Error('Outside audit-dir');
  return file;
}

function authorizeAuditAction(contract, action) {
  if (contract.mode !== 'review' || !['guard', 'lock'].includes(contract.level) || !contract.auditOutput) return false;
  try {
    const targets = fileTargets(action);
    if (action.mutability === 'write' && targets?.length) {
      for (const target of targets) artifactPath(target, contract.auditOutput, action.cwd, true);
      return true;
    }
    const shell = action.hostFamily === 'codex' && ['Bash', 'exec_command', 'shell_command'].includes(action.name)
      || action.hostFamily === 'claude-code' && action.name === 'Bash'
      || action.hostFamily === 'opencode' && ['bash', 'shell'].includes(action.name);
    if (!shell || !contract.reportBinding) return false;
    const input = action.input;
    if (!record(input) || input.shell != null || input.env != null || input.run_in_background
        || input.command != null && input.cmd != null && input.command !== input.cmd
        || input.workdir != null && checkedPath(input.workdir, null, { directory: true }) !== checkedPath(action.cwd, null, { directory: true })) return false;
    // An argv/env wrapper can change the executed operation; only the literal
    // command field of a native shell tool is part of this exception.
    const command = typeof input === 'object' && input && (input.command ?? input.cmd);
    const args = directCommandArguments(command);
    const grant = contract.reportBinding;
    if (!args || args.length !== 5 || args[1] !== 'message' || args[2] !== 'send'
        || !/^crewmoor(?:\.exe)?$/i.test(path.basename(args[0])) || executablePath(args[0]) !== grant.executable
        || checkedPath(args[3], action.cwd) !== grant.path) return false;
    const binding = JSON.parse(fs.readFileSync(checkedPath(grant.path), 'utf8'));
    if (JSON.stringify(binding) !== grant.snapshot) return false;
    const { worker, dispatcher } = bindingIdentity(binding);
    const family = action.hostFamily === 'claude-code' ? 'claude' : action.hostFamily;
    if (worker.agent !== family || worker.session !== action.nativeSessionId || action.child) return false;
    const message = JSON.parse(fs.readFileSync(artifactPath(args[4], contract.auditOutput, action.cwd), 'utf8'));
    if (!record(message) || Object.keys(message).some(key => !['id', 'from', 'to', 'reply_to', 'content'].includes(key))
        || !text(message.id) || message.from !== worker.role || message.to !== dispatcher.role
        || message.reply_to != null && (!text(message.reply_to) || message.reply_to === message.id)
        || !text(message.content) || Buffer.byteLength(message.content) > 16384) return false;
    return true;
  } catch { return false; }
}

module.exports = { auditDirectory, reportBinding, validAuditDirectory, validReportBinding, validPathSpelling,
  narrowedDirectory, sameBinding, authorizeAuditAction };
