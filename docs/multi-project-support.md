# Multi-Project Workspace Support

This document captures the plan to evolve the OEUnit Test Explorer extension from a single-project assumption to first-class multi-project support. It lists the functional goals, architectural changes, and an end-to-end implementation checklist.

---

## 1. Objectives
- Allow a single VS Code workspace to host multiple OpenEdge projects, each with its own `openedge-project.json`, PROPATH, runtime, and database connections.
- Ensure test discovery, execution, and server lifecycle operate with the correct project context for every test file.
- Preserve backwards compatibility so existing single-project users require no configuration changes.

## 2. Definitions
- **Project Root**: Folder containing an `openedge-project.json` file. All child paths inherit the same OpenEdge configuration unless another nested project root overrides it.
- **Project Context**: Runtime metadata derived from `openedge-project.json`, associated PROPATH entries, DB aliases, resolved DLC path, and server port configuration required to run tests for a specific project root.

## 3. Current Limitations
1. `startPersistentServer` assumes a single `workspaceFolder` and refuses to run without `<selected folder>/openedge-project.json`.
2. A single `OEUnitServerManager` instance services all tests, so PROPATH/runtime/db aliases cannot differ between test files.
3. Test discovery scans the entire workspace but stores no per-item project metadata, forcing all runs through the same context.
4. Commands (`start/stop/restart/ping`) and the status bar target the singleton server manager.

## 4. Target Experience
- The extension detects every `openedge-project.json` within the workspace (including multi-root and nested structures).
- Tests discovered under each project are scoped to that project’s context; running a test picks the right persistent server automatically.
- Each project can start, stop, or restart its own OEUnit server. An aggregated command allows operating on all projects at once.
- Status bar feedback reflects either the last interacted project or a rolled-up summary.
- Configuration supports per-project overrides while keeping global defaults for port offsets, autostart behavior, etc.
- When the Riverside ABL extension is present, OEUnit reuses its project metadata; otherwise it falls back to local parsing without user-visible regressions.

## 5. Architectural Updates
1. **Project Discovery Layer**
   - Prefer consuming the Riverside `openedge-abl-lsp` extension API (`getProjectInfo`, `getFileInfo`) to avoid duplicating parsing logic; guard calls behind an optional dependency and fall back to manual JSON parsing when the extension is absent.
   - Build a scanner that locates `openedge-project.json` files via `vscode.workspace.findFiles('**/openedge-project.json')` when a fallback is required.
   - For each file create a `ProjectContext` object that holds:
    - `id` (stable string, e.g., normalized project root path)
    - `rootUri`
    - parsed `openedge-project.json` (or API result payload)
    - resolved PROPATH entries (`workspaceRoot`, `buildPath`, extension `abl` folder, API-provided `${DLC}` replacements, etc.)
    - runtime metadata (sourced from the API when possible, otherwise resolved via `abl.configuration.runtimes`)
     - database connect arguments + alias env map
     - assigned port (see Section 7)
   - Cache contexts and expose lookup: `findProjectForUri(uri: vscode.Uri)` returns the nearest ancestor project.

2. **Server Manager Multiplexing**
   - Replace global `serverManager` with `Map<string, OEUnitServerManager>` keyed by project ID.
   - Provide helper functions: `getOrCreateServer(projectId)`, `stopServer(projectId)`, `stopAllServers()`.
   - Extend `OEUnitServerManager.startServer` signature if needed to accept project-specific log context names (e.g., include project id in output).

3. **Test Item Annotation**
   - During `addTestFile`, determine owning project via `getFileInfo` export when available; otherwise fall back to `findProjectForUri(fileUri)` heuristics.
   - Encode project ID in the `TestItem` metadata, either by:
     - storing in `testItem.tags`/`testItem.busy` metadata (use `WeakMap<TestItem, ProjectContext>`), or
     - embedding in `testItem.id` (`${projectId}::${filePath}`) and storing a reverse map.
   - Ensure child test items inherit the same project context.

4. **Run Pipeline Changes**
   - Update `OEUnitTestRunner.runTestFile` to fetch the project ID from the test item before running.
   - Start/attach to the corresponding server manager and use its port/logging/runtime.
   - Fail fast with a descriptive error if a test lacks a project mapping (e.g., is outside of any project root).

5. **Command UX**
   - Introduce quick-pick UI listing available projects with statuses for `start/stop/restart/ping` commands.
   - Provide "All Projects" option and maintain compatibility with command palette shortcuts.
   - Expose new commands if helpful (e.g., `oeunit.startServerForProject`).

6. **Status Bar Strategy**
   - Options:
     1. Cycle through active projects on tickers.
     2. Show aggregate state (e.g., `OEUnit: 2/3 running`).
     3. Provide a separate status item per project (ensure limited clutter).
   - Decide implementation during UI spike; document chosen approach.

7. **Port Allocation**
   - Add new setting `oeunit.portBase` (default 5555) and `oeunit.portStep` (default 10).
   - Assign each project `portBase + index * portStep`. Allow overrides via optional field inside `openedge-project.json` or workspace settings (`oeunit.projects[projectId].port`).
   - Validate that ports are free before starting the server; surface conflicts with actionable messages.

8. **Configuration Surface**
   - Retain existing flat settings for backwards compatibility.
   - Introduce optional `oeunit.projects` configuration section for per-project overrides (e.g., `autostart`, `loglevel`, `workspaceFolderOverride`).
   - Add a feature toggle (e.g., `oeunit.multiProjectMode`) defaulting to `false`; when disabled the extension keeps legacy single-project behavior.
   - Document precedence order: explicit project override → workspace folder setting → global default.
   - Declare optional dependency on `RiversideSoftware.openedge-abl-lsp` in `package.json` and explain fallback behavior when the extension is missing.

9. **Persistence & Cleanup**
   - On extension shutdown (`deactivate`), stop all running servers.
   - Handle configuration change events by diffing project contexts: stop removed projects, update changed ones, start new ones if autostart is enabled.

## 6. Implementation Checklist

### 6.1 Foundational Work
- [ ] Create `ProjectDiscovery` service with caching, configuration change listeners, and helper methods.
- [ ] Define `ProjectContext` interface and ensure it contains resolved paths and runtime handles.
- [ ] Integrate discovery into `activate`, running prior to test discovery / server autostart.
- [ ] Detect and activate the Riverside ABL extension (`RiversideSoftware.openedge-abl-lsp`), reusing `getProjectInfo`/`getFileInfo` when present and falling back gracefully otherwise.

### 6.2 Server Lifecycle
- [ ] Refactor `startPersistentServer` to accept a `ProjectContext` and return the created manager.
- [ ] Replace global globals (`serverManager`, `statusBarItem`) with per-project structures.
- [ ] Introduce `OEUnitServerRegistry` (or similar) responsible for managing the map of managers.
- [ ] Update `restart`, `stop`, `start`, and `ping` commands to target a selected project or all.
- [ ] Ensure server output channels are unique or clearly tagged per project (append project name/path).

### 6.3 Test Discovery & Execution
- [ ] Update `discoverTests` to request project contexts and skip files lacking a project root.
- [ ] Store project association on each `TestItem` (using `WeakMap` or encoded IDs).
- [ ] Modify `collectTests` and run loop to carry project metadata to execution.
- [ ] Adjust `OEUnitTestRunner.runTestFile` to resolve server via project association and to lazily autostart if necessary.
- [ ] Handle errors gracefully when project context is missing or server start fails.

### 6.4 Configuration Handling
- [ ] Extend settings schema (`package.json`) for new keys (`portBase`, `portStep`, `projects`).
- [ ] Add `extensionDependencies` or `extensionOptionalDependencies` entry for `RiversideSoftware.openedge-abl-lsp` and document the requirement for advanced multi-project features.
- [ ] Introduce `oeunit.multiProjectMode` (default `false`) to guard new functionality and ensure legacy behavior remains untouched when the toggle is off.
- [ ] Update README and changelog to describe new configuration.
- [ ] Ensure configuration change listener compares old/new contexts and restarts impacted servers only.

### 6.5 Status Bar & UI
- [ ] Decide on status bar UX; implement multi-project-friendly display.
- [ ] Provide quick navigation command if multiple status items are created.
- [ ] Verify commands remain discoverable in Command Palette with sensible names/descriptions.

### 6.6 Telemetry / Logging
- [ ] Enhance logging to include project identifiers for easier debugging.
- [ ] Verify output channels do not interleave confusingly when multiple servers run concurrently.
- [ ] Tag logs with the current project ID so shared output channels remain readable.

### 6.7 Testing & Validation
- [ ] Unit-test new utilities (project discovery, context resolution, port assignment).
- [ ] Ensure integration tests pass whether or not the Riverside extension is installed (mock API exports when absent).
- [ ] Add integration tests (fake workspace) covering:
   - multiple projects with different runtimes
   - nested project roots overriding parents
   - missing `openedge-project.json` handling
   - port conflict detection
- [ ] Manual QA scenarios:
   - Start/stop individual servers
   - Run tests from different projects sequentially and concurrently
   - Change `openedge-project.json` contents and verify restart logic
   - Validate autostart behavior with >1 project
   - Disable `oeunit.multiProjectMode` and confirm the legacy single-server flow still operates correctly

### 6.8 Documentation & Migration

## 7. Open Questions / Decisions Needed
- Should project contexts inherit from parents or treat nested `openedge-project.json` files as separate projects?
- Preferred status bar UX when more than three projects exist?
- Do we need an explicit "default project" setting for commands triggered without context (e.g., via keyboard shortcut while no test item is focused)?
- Should port overrides live inside `openedge-project.json` or extension settings?
- Should Riverside integration remain an optional dependency or become mandatory once multi-project support ships?

## 8. Risks & Mitigations
- **Port collisions**: Mitigate with validation and user-facing errors; optionally allow dynamic port scanning.
- **Performance**: Discovering projects and contexts on large workspaces—cache results and debounce file watchers.
- **Complex configuration**: Provide sensible defaults and detailed documentation to avoid overwhelming users.
- **Backward compatibility**: Keep default behavior identical when only one project is detected.

## 9. Next Steps
1. Prototype `ProjectDiscovery` service and project-to-test-item linkage.
2. Refactor server management into registry and validate manual project switching with commands.
3. Layer on status bar improvements and configuration surface.
4. Finalize documentation, update tests, and prepare release notes.

---

Created December 2025.
