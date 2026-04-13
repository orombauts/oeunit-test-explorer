# Change Log

## [0.4.0] - 2026-04-09

### Added
- **Copilot Chat integration — `#oeunit_runTest` tool**: run a single `.cls` test file
  or a specific test method directly from Copilot Chat. Returns structured JSON
  (Status, Summary, TestCases) visible in the chat response.
- **Copilot Chat integration — `#oeunit_runFolder` tool**: discover and run all OEUnit
  test files under a given folder from Copilot Chat. Returns per-file and aggregate results.
- **Copilot Chat integration — `#oeunit_getLastResults` tool**: retrieve cached results
  from the most recent run (Test Explorer *or* chat-triggered) without re-running tests.
  Useful for analysis, summarisation, and export workflows.
- **Test Results view support**: all test runs — whether triggered from the Test Explorer
  or from Copilot Chat tools — now populate the VS Code **Test Results** panel with
  per-method pass/fail/skip status and timing, a summary footer, and failure details
  (scoped so clicking a specific method shows only its output).
- **`OEUnit: Export Test Results…` command**: saves the most recent cached results to
  either **JUnit XML** (accepted by Jenkins, Azure DevOps, GitHub Actions) or **JSON**
  (Copilot-friendly). Accessible via the Command Palette.
- **`OEUnit: Run Test (from Chat)` command**: headless test execution for agents and
  script-based automation; accepts `{ testFile, testMethod?, folder? }` or a plain string
  (`"path/to/Test.cls"`, `"path/to/Test.cls::Method"`, `"path/to/folder"`).
- **`oeunit.startServerForProject` internal command**: starts the server for an already-
  known project without showing the project picker QuickPick. Used internally so the
  first Test Explorer run auto-starts the correct server silently.
- **JSONC support for `openedge-project.json`**: `//` line comments and `/* */` block
  comments in `openedge-project.json` are now stripped before parsing. The ABL Language
  Server already supports JSONC for this file; the extension now matches that behaviour.
  A `stripJsonComments()` helper was added to `utils.ts` and is applied at all parse sites
  (`extension.ts` startup path and `projectDiscovery.ts`).

### Fixed
- First Test Explorer run no longer shows the project picker QuickPick when the server
  has not yet started; the correct project is resolved automatically from the test file
  path and the server is started silently.

### Changed
- Tool registration entries (`toolReferenceName`, `userDescription`, `modelDescription`)
  added to `package.json` so all three LM tools appear in the VS Code
  **Configure Tools** picker and can be used as `#tool` references in chat.

## [0.3.0] - 2026-03-20

> All changes are fully backwards-compatible with existing single-project setups.

### Added
- **Multi-project mode** (`oeunit.multiProjectMode`): one OEUnit server per VS Code
  workspace folder, each isolated on its own port with its own PROPATH and DB connections.
- **Project tree grouping**: in multi-project mode the Test Explorer tree gains a
  top-level node per project so folders with identical names across different OpenEdge
  versions remain distinguishable.
- **Per-project port auto-assignment**: ports are allocated as `portBase + index × portStep`
  (new settings `oeunit.portBase` / `oeunit.portStep`).
- **Per-project overrides** via `oeunit.projects` object in workspace settings:
  port, loglevel, autostart, timeout, exec, oeargs, environmentVariables — all
  per project, case-insensitive key matching on Windows.
- **Explicit project list** (`oeunit.projectPaths`): add absolute folder paths via the
  VS Code Settings UI (Add/Remove list) or the new **OEUnit: Add Project Folder…** command
  which opens a native folder-picker dialog. When non-empty, these paths take priority over
  automatic workspace-folder detection.
- **Three-tier project discovery** (multi-project mode):
  1. `oeunit.projectPaths` if configured → use those paths exclusively
  2. Multi-root workspace (`.code-workspace`) → auto-detect workspace folders with `openedge-project.json`
  3. Single folder opened directly → detect `openedge-project.json` at the root (same as legacy mode)
- **Bulk server commands**: `OEUnit: Start All Servers`, `Stop All Servers`,
  `Restart All Servers` (experimental, multi-project only).
- **Project quick-pick for single-server commands**: `start/stop/restart/ping`
  show a project selector (with running/stopped icon) when multiple contexts exist;
  single-project users are never prompted.
- Declared `RiversideSoftware.openedge-abl-lsp` as an optional extension dependency.

### Fixed
- Server startup guard (`serverStarting` Set) prevents duplicate server processes when
  `onDidChangeContexts` fires rapidly during workspace indexing.
- `projectWatcher` no longer triggers a second test-discovery pass (was redundant with
  `onDidChangeContexts`).
- Case-insensitive path comparison for `oeunit.projects` override keys (Windows).
- Restored full JSON validation for `openedge-project.json` (UTF-16 BOM, UTF-8 BOM,
  parse error with "Open File" button, missing `oeversion` field) that was inadvertently
  dropped during the rewrite.
- `OEUnitTestRunner`: auto-start re-check after `oeunit.startServer` used a stale
  `this.serverManager` reference (pre-multi-project field); corrected to
  `this.serverManagers.get(projectId)` so the right server instance is picked up.

### Changed
- `activate` is now `async` to allow sequential server startup in multi-project mode.
- `deactivate` stops all server managers in parallel (`Promise.allSettled`).
- All `oeunit.*` configuration properties now declare `"scope": "resource"`, making every
  setting configurable per folder in a multi-root workspace via the VS Code Settings UI.
- All `vscode.workspace.getConfiguration('oeunit')` reads pass the folder's resource URI
  so folder-level overrides are honoured at runtime across `extension.ts`,
  `serverLifecycle.ts`, `testDiscovery.ts`, and `testRunner.ts`.

## [0.2.0] - 2026-03-12

### Added
- New `OEUnit: Kill Server` command to force-kill the server process immediately (without graceful shutdown)
- Auto-start on first test run: if the server has never been started in the current session, running a test will start it automatically
- Test methods inherited from parent classes via `INHERITS` are now discovered and listed as runnable test cases in the test explorer

### Improved
- Modifying a test class file no longer triggers a full rebuild of the test view; only the changed file is re-parsed and updated in place
- Non-test class file changes (e.g. editing a parent class) still trigger a full re-discovery to keep the inheritance chain accurate

## [0.1.6] - 2026-03-04

### Added
- Support for custom environment variables via `oeunit.environmentVariables` configuration
- Environment variables can be set when spawning the Progress executable
- Custom environment variables can override DLC and PROPATH if needed

## [0.1.5] - 2026-01-16

### Fixed
- Running individual test cases did not report failure. This has been corrected.

## [0.1.4] - 2026-01-14
- Corrected this file

## [0.1.3] - 2026-01-14

### Changed
- Configuration change debouncing: Server now waits 5 seconds after last config change before restarting (prevents restart on every keystroke when typing port numbers or other settings)
- Autostart default changed to `false` (server won't start automatically on extension activation)
- Increased initial server startup delay from 2 to 5 seconds before health check pings

### Improved
- Added timestamps to all ServerManager and TestRunner log messages (format: MM/DD/YYYY HH:MM:SS.mmm±HH:MM)
- Centralized logging utilities in utils.ts for consistent timestamp formatting across modules
- Better launch.json configuration with workspace path input prompt
- Setup.ps1 now uses `$PSScriptRoot` instead of hardcoded path for better portability

### Fixed
- Removed hardcoded workspace path from setup.ps1

## [0.1.2] - 2026-01-06

### Improved
- Added validation for JSON encoding compliance in openedge-project.json
- Clear error messages when UTF-8 BOM or UTF-16 encoding is detected
- Enforces RFC 8259 JSON specification compliance for encoding

## [0.1.1] - 2026-01-06

### Fixed
- Fixed server shutdown timeout error by implementing fire-and-forget shutdown request
- Server shutdown no longer waits for response, preventing ETIMEDOUT errors

### Improved
- Isolated `openedge-project.json` parsing into dedicated function with specific error handling
- Better error messages when `openedge-project.json` has issues (JSON syntax errors, missing fields, etc.)
- Context-specific error dialogs with actionable buttons (Open File, Open Settings)
- Clearer distinction between configuration parsing errors and server startup errors

## [0.1.0] - 2025-12-16

### Added
- Support for running individual test methods (no longer runs entire test class)
- Abstract test classes are now correctly skipped during test discovery

### Changed
- **BREAKING**: Refactored server communication to use JSON message protocol
- **BREAKING**: Configuration properties removed: `oeunit.home`, `oeunit.runner`, `oeunit.outputDirectory`
- Test results are now received directly via JSON communication instead of reading XML files
- **IMPORTANT**: OEUnit library must now be available in the PROPATH (either via `openedge-project.json` buildPath or via PROPATH definition in the INI file specified in `oeunit.oeargs`)
- Improved server status messages

## [0.0.7] - 2025-12-10

### Added
Support for test methods annotated with Ignore.
Update readme file with limitation section:
- Running a individual test method currently runs the whole unit test class.

### Fixed
Corrections in how unit tests are being lauched from a selected folder

## [0.0.5] - 2025-12-10

### Fixed
OEUnitServer won't start - Typo in variable name

## [0.0.4] - 2025-12-10

### Added
- Introduction of default oeunit workspace folder
- Log extension version in outputs

### Changed
- Improved logging, especially upon starting server
- OEUnitServer.p - do not rely on the output parameter, only on the xml output

### Fixed
- Consider missing xml output as a failed unit test

## [0.0.3] - 2025-12-09
 - Initial version

