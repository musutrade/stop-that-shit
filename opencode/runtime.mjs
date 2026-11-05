import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseContractPrompt } = require('../src/contracts.cjs');

export function resolveDataDir(options) {
  if (typeof options.dataDir === 'string' && options.dataDir) return options.dataDir;
  const root = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(root, 'opencode', 'stop-that-shit');
}

// The parser, rather than a mention inside a quote, owns contract changes.
export function mentionsDirective(text) {
  return /\$stop-that-shit\b/i.test(String(text || ''));
}

export function allowsHostPromotion(text, contract) {
  // CrewMoor peers arrive as root transport messages, not direct user edit
  // authority. Inspect only the envelope shape; never parse its content as a
  // directive or apply this rule to unrelated JSON user prompts.
  try {
    const envelope = JSON.parse(String(text));
    if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)
        && Object.hasOwn(envelope, 'team') && Object.hasOwn(envelope, 'message')) return false;
  } catch {}
  return !mentionsDirective(text) && !parseContractPrompt(text, contract).correction;
}

export function directiveErrorText(error) {
  return `Stop That Shit directive rejected (${error.code}): ${error.message} `
    + 'The previous contract is unchanged. Tools are paused until you submit a corrected instruction.';
}
