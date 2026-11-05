# Task-scoped audit output (fork feature)

This implements the file-output portion of [Issue #1](https://github.com/musutrade/stop-that-shit/issues/1).
It does **not** implement CrewMoor delivery or claim that the complete startup-to-binding workflow has been verified.

## Minimal use

A trusted user/operator first creates a dedicated output directory, preferably
outside the reviewed repository. The Guard never creates it or changes host
permissions. Do not point it at source, configuration, plugin state, or a shared
working directory. A directory grant authorizes file contents there; the Guard
cannot decide that a file is a report merely from its name or text.

Submit this as a real user directive, on the first non-empty line:

```text
$stop-that-shit review audit-dir=/absolute/audits/task-42 -- Review the diff. Save findings and the message JSON in this directory.
```

Claude Code uses the equivalent plugin command:

```text
/stop-that-shit:stop-that-shit review audit-dir=/absolute/audits/task-42 -- Review the diff and save findings.
```

Use the native absolute path on Windows, such as `C:/audits/task-42`.
For this narrow first version the path must have no spaces, quoting, globbing,
traversal components, symlinks, UNC/device aliases, reserved names, or trailing
separators. The directory must exist. Its filesystem ancestors must not be
symlinks either; use their canonical spelling. It cannot be the tool's current
working directory or an ancestor of it. A relative Codex/OpenCode patch target
is resolved against the absolute working directory supplied by the host, never
against a process-global fallback.

Check `$stop-that-shit status`: it must show `review` and the exact `audit-dir`.
Only a successful persisted contract activates the exception. Task text,
quoted commands, files called `report.md`, and a tool claiming to be an auditor
do not establish authority. A launcher must deliver a genuine supported user
prompt event; merely injecting the same text into system context is not a
verified setup mechanism.

Supported direct file operations:

| Host | Tool and native input |
| --- | --- |
| Codex | `apply_patch`, raw patch string or an object with only `patch` |
| Claude Code | `Write` (`file_path`, `content`), `Edit` (`file_path`, `old_string`, `new_string`, optional `replace_all`) |
| OpenCode 1 | `write` / `edit` using `filePath`; `apply_patch` using `patchText` |
| OpenCode 2 | `write` / `edit` using `path`; `patch` using `patchText` |

The OpenCode edit fields are `oldString`, `newString`, and optional `replaceAll`.
Write/Edit paths must be absolute. Patch handling accepts a strict subset of
Add/Update/Delete/Move syntax and checks every source and destination. Unknown
fields, aliases, malformed patches, mixed inside/outside targets, shell writes,
MCP writes and unknown tools do not receive the exception. Use a supported
direct tool instead of shell redirection to save a long report or message file.
Other hosts retain their existing behavior without this exception.

This bypasses only the review-mode mutation rejection. Existing `files=`, hash,
dependency, delegation, recovery, and other scope restrictions still apply.
If `files=` is present it must also contain the output files. `answer` and
`monitor` do not receive an output exception. `watch` and `off` keep their
existing non-enforcing meanings; use `guard` (the default with `review`) or
`lock` for enforcement.

## Lifetime and revocation

The grant is persisted for that host session and survives ordinary continuation
prompts and restart. OpenCode's editable-host promotion does not promote an
active audit grant to `change` on an ordinary continuation. Other OpenCode
contracts keep the existing promotion behavior.

Revoke it explicitly:

```text
$stop-that-shit audit-dir=none -- Continue without writing artifacts.
```

A fresh mode directive without `audit-dir`, including bare `review`, also
clears it. Natural corrections such as `review only` clear it. Explicit child
contracts can retain the same inherited directory or revoke it, but cannot
introduce or substitute a directory. A pristine child inherits its parent.
Start a new host session or revoke the grant before moving to another task.

**OpenCode compatibility caveat:** once the audit grant is revoked, the existing
editable-host promotion rule resumes. A later ordinary root user prompt can
change a prior `review` contract to `change` when the host permits editing.
Bare `review` therefore revokes the output exception immediately, but is not a
promise of persistent read-only enforcement across all later prompts. This PR
does not change that upstream behavior. Use host-enforced read-only permissions
when persistent isolation is required, and verify status after new prompts.


## Paired cases and safety boundary

- Good: explicitly authorize `/audits/task-42`, then save a long report and
  `message.json` using known direct tools with all paths below it.
- Bad: the same write without `audit-dir`, a sibling directory, `..`, a symlink,
  an existing hardlink, a rename crossing the boundary, or a patch also editing
  source code. The entire call is denied, not partially accepted.
- Still denied: `crewmoor message send binding.json message.json`, shell output
  redirection, and arbitrary service/message writes. Writing `message.json`
  does not authorize sending it.

The preflight checks every existing filesystem component and rejects symlinks,
non-regular file targets, and existing files with more than one hard link. It
fails closed on filesystem errors. It cannot prevent filesystem races between
check and execution, bind-mount changes, unobserved tools, a compromised host,
or a host ignoring the hook result. Guard approval grants no OS permission.
Use an OS/container sandbox and a trusted, separately provisioned output
location when actual isolation is required.

CrewMoor delivery still needs a verified executable/adapter, immutable binding
identity, exact target, scheduling role and session, message schema, and
mismatch/rebinding tests. A shell-string allowlist is not enough. No global host
permissions, installed plugin settings, or MIT copyright/license notices are
changed by this feature.

## Verification

`test/audit-output.test.cjs` covers parser/state/recovery/narrowing, strict native
schemas, long payloads through Codex and Claude hook subprocesses, both OpenCode
adapters, and filesystem escape cases. These tests prove hook responses, not
that a real Codex or Claude host executed or blocked a file operation.

`test/opencode-dual-smoke.test.mjs` exercises the packed plugin using the existing
pinned native OpenCode 1 and 2 host harness and a local synthetic model. Run it
through `npm run test:hosts` with both `STS_OPENCODE_V1_BIN` and
`STS_OPENCODE_V2_BIN`. This tests host loading, actual file effects, session
restart and revocation. It does not establish model effectiveness or CrewMoor
startup/binding support. Record the exact executed versions and results in the
pull request; skipped tests are not successful native-host verification.
