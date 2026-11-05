'use strict';

const { auditWritePaths } = require('../audit-output.cjs');

const { toActionEvent, toActionAfterEvent } = require('./opencode-hooks.cjs');

function legacyInput(event) {
  const args = event.input || {};
  const tool = { shell: 'bash', patch: 'apply_patch', subagent: 'task' }[event.tool] || event.tool;
  return {
    input: { ...event, tool, callID: JSON.stringify([event.messageID, event.id, event.tool]) },
    args: { ...args, filePath: args.path, task_id: event.tool === 'subagent' ? args.sessionID : undefined },
  };
}

function toV2ActionEvent(event, context) {
  const mapped = legacyInput(event);
  const result = toActionEvent(mapped.input, { args: mapped.args }, context);
  result.action.name = event.tool;
  result.action.input = event.input;
  // Authorize from the raw V2 schema, never the lossy legacy alias mapping.
  delete result.action.auditWritePaths;
  const auditPaths = auditWritePaths('opencode-v2', event.tool, event.input);
  if (auditPaths) result.action.auditWritePaths = auditPaths;
  return result;
}

function toV2ActionAfterEvent(event, context) {
  const mapped = legacyInput(event);
  const result = toActionAfterEvent(mapped.input, context);
  if (!result) return null;
  const output = event.status === 'completed' && event.result?.output;
  if (event.tool === 'subagent' && output && typeof output.sessionID === 'string'
      && ['completed', 'running'].includes(output.status) && typeof output.output === 'string') {
    result.action.agentId = output.sessionID;
    result.action.lifecycle = output.status === 'completed' ? 'joined' : 'running';
  }
  return result;
}

module.exports = { toV2ActionEvent, toV2ActionAfterEvent };
