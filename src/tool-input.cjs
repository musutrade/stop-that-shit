'use strict';

// Keep the native Codex text wrappers identical for path classification and
// review authorization. Unknown shapes yield no provable patch targets.
function inputText(toolInput) {
  if (typeof toolInput === 'string') return toolInput;
  if (!toolInput || typeof toolInput !== 'object') return '';
  return String(toolInput.command || toolInput.patch || toolInput.content || toolInput.new_string || '');
}

module.exports = { inputText };
