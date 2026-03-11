# Multi-Project Mode — Implementation Notes

This document records the architectural decisions made, bugs discovered and fixed, and
deviations from the original plan during the implementation of multi-project workspace
support (branch `feature/DavudKB/multi-project-mode`, rebased onto `origin/main` at
v0.1.6).

<!-- Portions of this document created with the assistance of AI -->

---

## 1. Scope

The implementation adds an **opt-in** `oeunit.multiProjectMode` flag (default `false`).
When disabled the extension behaves identically to v0.1.6.  When enabled:

- One `ProjectContext` is created per VS Code workspace folder whose root contains an
  `openedge-project.json`.
- A dedicated `OEUnitServerManager` is started per project on an auto-assigned port
  (`portBase + index × portStep`, overridable per project).
- The VS Code test tree gains a top-level project node per context so folders with
  identical names across different projects remain distinguishable.
- Single-server commands (`start`, `stop`, `restart`, `ping`) show a quick-pick when
  more than one context is present.  Three new bulk commands (`startAllServers`,
  `stopAllServers`, `restartAllServers`) operate across all contexts at once.

---

## 2. Key Architectural Decisions

### 2.1 Project discovery — workspace folders, not `findFiles`

**Plan:** Use `vscode.workspace.findFiles('**/openedge-project.json')` to discover
projects recursively.

**Decision:** Changed to iterate `vscode.workspace.workspaceFolders` and check each
folder's root directly.

**Reason:** `findFiles` produced duplicate and unwanted contexts in a multi-root
workspace where a "Root" folder physically contains the named sub-folders.  For example:

```
.code-workspace
├── . (Root — C:\workspace128)
├── glims_dev_pro  (C:\workspace128\glims_dev_pro)
└── Glims_2023_2_pro (C:\workspace128\Glims_2023_2_pro)
```

`findFiles` found `openedge-project.json` in both named folders *and* again via the Root
scope, generating three or more contexts instead of two.  Iterating workspace folders
directly gives exactly one context per folder entry in `.code-workspace`.

### 2.2 `ProjectContext.id` = `rootUri.fsPath`

The context identifier is the absolute filesystem path of the project folder (e.g.
`C:\workspace128\glims_dev_pro`).  This is stable, human-readable, and directly usable
as the key for `oeunit.projects` per-project overrides in workspace settings.

### 2.3 Riverside ABL extension — not integrated

**Plan (Section 5.1):** Prefer the `RiversideSoftware.openedge-abl-lsp` API
(`getProjectInfo`, `getFileInfo`) to avoid re-parsing `openedge-project.json`.

**Decision:** Declared as `extensionOptionalDependencies` only; API integration deferred.

**Reason:** The Riverside extension API is not public/documented.  The fallback path
(local JSON parsing) is already robust and serves all current needs.  Integration remains
a future improvement once the API surface is confirmed stable.

### 2.4 Single output channel for all servers

**Plan:** Unique or clearly tagged output channels per project.

**Decision:** Retained one shared `OEUnit Server` output channel; each server startup
block is separated by a divider line and labelled.

**Reason:** Multiple output channels would clutter VS Code's panel.  The shared channel
with clear delimiters provides sufficient traceability.  Revisit if concurrent server
output becomes confusing in practice.

### 2.5 `testItemProjects` Map for project ↔ TestItem routing

Each `TestItem` id (project node, folder, file, or method) is registered in a module-level
`Map<string, string>` (`testItemProjects`) pointing to the owning `ProjectContext.id`.
`resolveProjectIdForTestItem` walks up the parent chain until it finds a registered entry.

This avoids encoding project data into item IDs (which would make the IDs fragile) and
does not require `WeakMap` bookkeeping across re-discoveries.

### 2.6 `serverStarting` guard Set

`onDidChangeContexts` fires multiple times in quick succession during VS Code workspace
indexing.  Without a guard, each event would start a new server process for the same
project before the first had finished.  A `Set<string>` (`serverStarting`) blocks
re-entrant calls; a `try/finally` block ensures the flag is always cleared regardless of
how `startPersistentServer` exits.

---

## 3. Bugs Found and Fixed During Implementation

### BUG-1: Root workspace folder started as a project

**Symptom:** `[ERROR] OEUnit server cannot start. File not found: c:\workspace128\openedge-project.json`

**Root cause:** `findFiles` fallback path added ALL workspace folders (including Root
`C:\workspace128`) as project contexts.  Root had no `openedge-project.json`.

**Fix:** Removed the fallback entirely; switched to workspace-folder-root iteration
(see §2.1).

---

### BUG-2: Duplicate contexts from overlapping workspace scopes

**Symptom:** Same project folder listed twice in the test tree.

**Root cause:** With `findFiles`, the Root folder and a named sub-folder both enumerated
the same `openedge-project.json`.

**Fix:** Removed by the workspace-folder-root iteration approach (each folder produces
exactly one context).

---

### BUG-3: Case-sensitive path mismatch on Windows

**Symptom:** `oeunit.projects` overrides not applied even when key appeared correct.

**Root cause:** `ProjectContext.id` is the path as returned by the Node.js filesystem
(e.g. `c:\workspace128\glims_dev_pro`), while the user typed `C:\workspace128\glims_Dev_pro`
in settings.  Strict equality failed despite being the same path on Windows.

**Fix:** Case-insensitive key lookup in both `extension.ts` and `testRunner.ts`:
```typescript
const overrideKey = Object.keys(overrides).find(
    k => k.toLowerCase() === projectContext.id.toLowerCase()
);
```

---

### BUG-4: 17 repeated error messages on startup

**Symptom:** The OEUnit Server output channel showed the same `[ERROR]` line 17 times.

**Root cause:** `onDidChangeContexts` fired 17 times during workspace indexing.
`isServerRunning()` returned `false` while the server was still starting, so each event
fired another `startPersistentServer` call for the same project.

**Fix:** `serverStarting` guard Set (§2.6).

---

### BUG-5: JSON validation regression

**Symptom:** UTF-16 and UTF-8 BOM errors no longer shown; malformed JSON silently ignored.

**Root cause:** During the rewrite of `startPersistentServer`, the upstream's
`parseOpenEdgeProjectJson` helper (which performed byte-level encoding checks) was
replaced with a plain `JSON.parse(fs.readFileSync(..., 'utf-8'))` call.

**Fix:** Restored all upstream checks: UTF-16 BOM detection (byte-level), UTF-8 BOM
detection (codepoint 0xFEFF), JSON parse error with "Open File" button, and missing
`oeversion` field validation.

---

### BUG-6: `projectWatcher` caused double test discovery

**Symptom:** Every `openedge-project.json` change triggered two full test tree rebuilds.

**Root cause:** `projectWatcher` handlers called both `projectDiscovery.refresh()` and
`discoverTests()` explicitly.  `refresh()` already fires `onDidChangeContexts` which
calls `discoverTests()` internally.

**Fix:** Simplified each handler to `() => projectDiscovery.refresh()` only.

---

## 4. Deviations from the Original Plan

| Plan Item (§5 / §6) | Status | Notes |
|---------------------|--------|-------|
| Riverside ABL API integration | ⏸ Deferred | Optional dep declared; local parsing used |
| `OEUnitServerRegistry` class | ✅ Equivalent | `serverManagers` Map + helpers in `extension.ts` |
| Unique output channel per project | ⏸ Deferred | Single shared channel with dividers |
| Port conflict detection | ⏸ Deferred | Ports assigned deterministically; conflict not validated |
| `openedge-project.json` nested project roots | ✅ Resolved | Only workspace folder roots are scanned |
| WeakMap for TestItem ↔ project | ✅ Alternative | `testItemProjects` Map with parent-chain lookup |
| Telemetry / structured logging | ⏸ Deferred | Console logging only |
| Unit / integration tests | ⏸ Deferred | Manual QA performed |

---

## 5. Configuration Reference

All new settings have sensible defaults and are backwards-compatible.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `oeunit.multiProjectMode` | `boolean` | `false` | Enable multi-project support |
| `oeunit.portBase` | `number` | `5555` | Base port for auto-assigned server ports |
| `oeunit.portStep` | `number` | `10` | Port increment between projects |
| `oeunit.projects` | `object` | `{}` | Per-project overrides (see below) |

### `oeunit.projects` override keys

The key is the absolute path of the project folder (case-insensitive on Windows).

```jsonc
"oeunit.projects": {
    "C:\\workspace128\\glims_dev_pro": {
        "port": 5557,          // Override auto-assigned port
        "loglevel": "info",    // "info" | "warning" | "error"
        "autostart": true,     // Override global oeunit.autostart
        "timeout": 120,        // Server startup timeout (seconds)
        "exec": "C:\\path\\to\\_progres.exe",  // Override global exec
        "oeargs": "-param ...", // Override global oeargs
        "environmentVariables": { "MY_VAR": "value" }
    },
    "C:\\workspace128\\Glims_2023_2_pro": {
        "port": 5567,
        "autostart": false     // Do not start server automatically
    }
}
```

---

## 6. Backwards Compatibility Guarantee

With `oeunit.multiProjectMode: false` (the default):

- `ProjectDiscovery.refresh()` resolves the single folder exactly as before.
- `startPersistentServer` is called without a `projectContextOverride`, falling back to
  `projectDiscovery.getDefaultContext()` which returns the first (and only) context.
- Commands skip the quick-pick and act directly on the single context.
- Test tree has no project-level root node; files and folders appear at tree root.
- `deactivate` stops all entries in `serverManagers` (one entry in single-project mode).
- No existing setting is renamed or removed.

---

## 7. Open Items (from §7 of the original plan)

- **Port conflict detection:** Validate port availability before server start; show
  actionable error with suggested next available port.
- **Riverside API integration:** Consume `getProjectInfo`/`getFileInfo` when available
  to avoid double-parsing `openedge-project.json`.
- **Status bar per-project:** Consider per-project status items if running >3 projects.
- **Default project setting:** Allow users to declare an explicit default for commands
  triggered without an active test item (keyboard shortcuts).

---

*Created March 2026. Branch: `feature/DavudKB/multi-project-mode`.*
*Last updated: 2026-03-12.*
