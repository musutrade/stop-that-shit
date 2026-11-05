'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A deliberately narrow, native-path grammar. No globbing, expansion, traversal,
// quoting, Windows device/ADS aliases, or foreign-platform path interpretation.
function safePath(value, absolute = false) {
  if (typeof value !== 'string' || !value || /[\x00-\x20\x7f*?\[\]{}|,'"`$<>]/.test(value)) return false;
  if (absolute && (!path.isAbsolute(value)
      || process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(value))) return false;
  if (process.platform !== 'win32' && /[\\:]/.test(value)) return false;
  if (process.platform === 'win32' && (/^[\\/]{2}/.test(value) || /^[A-Za-z]:(?![\\/])/.test(value))) return false;
  const rest = value.slice(path.parse(value).root.length);
  return rest.split(/[\\/]/).every(part => part && part !== '.' && part !== '..'
    && !/[. ]$/.test(part) && !part.includes(':')
    && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
}

function validAuditDirectory(value) {
  return typeof value === 'string' && safePath(value, true)
    && path.resolve(value) !== path.parse(path.resolve(value)).root;
}

function inside(directory, target) {
  const relative = path.relative(directory, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value, keys) {
  return Object.keys(value).every(key => keys.includes(key));
}

// This subset is intentionally smaller than the host's patch grammar. Reject
// malformed/extended patches instead of extracting a reassuring partial list.
function patchPaths(input) {
  const patch = typeof input === 'string' ? input
    : record(input) && onlyKeys(input, ['patch']) ? input.patch : null;
  if (typeof patch !== 'string') return null;
  const lines = patch.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') return null;
  const paths = [];
  let operation = null;
  let moveAllowed = false;
  for (const line of lines) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      if (!safePath(header[2])) return null;
      paths.push(header[2]);
      operation = header[1];
      moveAllowed = operation === 'Update';
    } else if (line.startsWith('*** Move to: ') && moveAllowed) {
      const destination = line.slice('*** Move to: '.length);
      if (!safePath(destination)) return null;
      paths.push(destination);
      moveAllowed = false;
    } else {
      moveAllowed = false;
      if (operation === 'Add' && line.startsWith('+')) continue;
      if (operation === 'Update' && (/^[ +\-]/.test(line) || /^@@(?: .*)?$/.test(line) || line === '*** End of File')) continue;
      return null;
    }
  }
  return paths.length ? paths : null;
}

function auditWritePaths(host, name, input) {
  if (host === 'codex' && name === 'apply_patch') return patchPaths(input);
  if (host === 'opencode' || host === 'opencode-v2') {
    const patchName = host === 'opencode' ? 'apply_patch' : 'patch';
    if (!record(input)) return null;
    if (name === patchName) return onlyKeys(input, ['patchText']) ? patchPaths(input.patchText) : null;
    if (!['write', 'edit'].includes(name)) return null;
    const field = host === 'opencode' ? 'filePath' : 'path';
    const keys = name === 'write' ? [field, 'content'] : [field, 'oldString', 'newString', 'replaceAll'];
    if (!onlyKeys(input, keys) || !safePath(input[field], true)) return null;
    if (name === 'write' ? typeof input.content !== 'string'
      : typeof input.oldString !== 'string' || typeof input.newString !== 'string'
        || input.replaceAll !== undefined && typeof input.replaceAll !== 'boolean') return null;
    return [input[field]];
  }
  if (host !== 'claude-code' || !['Write', 'Edit'].includes(name) || !record(input)) return null;
  const keys = name === 'Write' ? ['file_path', 'content'] : ['file_path', 'old_string', 'new_string', 'replace_all'];
  if (!onlyKeys(input, keys) || !safePath(input.file_path, true)) return null;
  if (name === 'Write' ? typeof input.content !== 'string'
    : typeof input.old_string !== 'string' || typeof input.new_string !== 'string'
      || input.replace_all !== undefined && typeof input.replace_all !== 'boolean') return null;
  return [input.file_path];
}

// Check every existing component, including the root's ancestors. A missing
// descendant is fine for a host that creates parents; any other I/O error denies.
function inspectPath(target, requireDirectory = false) {
  const root = path.parse(target).root;
  const parts = target.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { return error.code === 'ENOENT' && !requireDirectory; }
    if (stat.isSymbolicLink()) return false;
    const directory = requireDirectory || index < parts.length - 1;
    if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) return false;
  }
  return true;
}

function allowsAuditWrite(contract, action) {
  if (contract.mode !== 'review' || !validAuditDirectory(contract.auditDirectory)
      || action.mutability !== 'write' || !Array.isArray(action.auditWritePaths)
      || action.auditWritePaths.length === 0) return false;
  // cwd is a host location, not a directive token. Spaces and trailing
  // separators are valid here; require a fully qualified native path only.
  if (typeof action.cwd !== 'string' || action.cwd.includes('\0') || !path.isAbsolute(action.cwd)
      || process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(action.cwd)) return false;
  try {
    if (!inspectPath(path.resolve(contract.auditDirectory), true)) return false;
    // Compare filesystem identities, not cwd spelling: a symlink/short-name
    // alias for the worktree must not turn the whole worktree writable.
    const directory = fs.realpathSync.native(contract.auditDirectory);
    const cwd = fs.realpathSync.native(action.cwd);
    if (!fs.statSync(cwd).isDirectory() || path.relative(directory, cwd) === '' || inside(directory, cwd)) return false;
    return action.auditWritePaths.every(raw => safePath(raw)
      && inside(directory, path.resolve(cwd, raw)) && inspectPath(path.resolve(cwd, raw)));
  } catch { return false; }
}

module.exports = { allowsAuditWrite, auditWritePaths, validAuditDirectory };
