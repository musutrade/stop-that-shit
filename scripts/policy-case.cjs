'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decide } = require('../src/decision.cjs');

// Filesystem grants require existing directories. Materialize the Issue #1
// paired fixture per invocation so cases remain portable and independent.
function evaluatePolicyCase(testCase) {
  if (testCase.fixture !== 'external-audit') return decide(testCase.input);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sts-policy-case-')));
  try {
    const replacements = {
      '$AUDIT_WORKSPACE': path.join(root, 'workspace'),
      '$AUDIT_DIRECTORY': path.join(root, 'output'),
      '$AUDIT_REPORT': path.join(root, 'output', 'report.md')
    };
    fs.mkdirSync(replacements.$AUDIT_WORKSPACE);
    fs.mkdirSync(replacements.$AUDIT_DIRECTORY);
    function expand(value) {
      if (typeof value === 'string') return replacements[value] || value;
      if (Array.isArray(value)) return value.map(expand);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)]));
      return value;
    }
    return decide(expand(testCase.input));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

module.exports = { evaluatePolicyCase };
