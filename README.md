# OEUnit Test Explorer for VS Code

A Visual Studio Code extension for running and exploring OpenEdge ABL unit tests using OEUnit with a persistent test server.

## Features

- **Persistent Test Server**: Long-running OpenEdge process for faster test execution — one server per project in multi-project workspaces
- **Test Explorer Integration**: Browse all test files and methods in VS Code's native Testing view
- **Run Tests**: Execute individual test files, test methods, or all tests in a folder
- **Test Results View**: Per-method pass/fail/skip status with timing, summary footer, and scoped output — populated for all run paths
- **Copilot Chat Integration**: Run tests and retrieve results directly from GitHub Copilot Chat using `#oeunit_runTest`, `#oeunit_runFolder`, and `#oeunit_getLastResults` tools
- **Export Test Results**: Save results as JUnit XML (CI-compatible) or JSON via the `OEUnit: Export Test Results…` command
- **Test Discovery**: Automatically discovers test files matching the configured pattern, including inherited `@Test` methods via `INHERITS`
- **Multi-project Support**: One isolated OEUnit server per workspace folder with automatic port assignment
- **Server Management**: Commands to start, stop, restart, kill, and ping the test server — per-project or for all projects at once
- **Status Bar**: Visual indicator showing current server status
- **Auto-restart on Config Changes**: Server automatically restarts when settings change
- **Database Support**: Automatic database connection and alias configuration
- **JSONC Support**: `openedge-project.json` may contain `//` and `/* */` comments

## Installation

### Prerequisites

- Visual Studio Code 1.85.0 or higher
- Node.js and npm installed
- OpenEdge ABL development environment
- OEUnit testing framework installed

## Configuration

Configure the extension in your workspace `.vscode/settings.json`:

```json
{
  "oeunit.exec": "_progres.exe",
  "oeunit.oeargs": "-cpinternal utf-8 -cpstream utf-8 -cpcoll Basic -cpcase Basic",
  "oeunit.testFilePattern": "**/test/**/*.cls",
  "oeunit.port": 5555,
  "oeunit.portEnd": 6000,
  "oeunit.timeout": 60,
  "oeunit.loglevel": "error",
  "oeunit.autostart": true
}
```

### Required Settings

- **oeunit.exec**: OpenEdge executable name (default: `_progres.exe`)
- **oeunit.oeargs**: OpenEdge startup arguments (can include INI file with PROPATH definition)

### Optional Settings

- **oeunit.testFilePattern**: Glob pattern to match test files (default: `**/test/**/*.cls`)
- **oeunit.port**: Starting port for the OEUnit server(s). In multi-project workspaces each project is assigned `port + index`. A per-folder workspace setting overrides auto-assignment for that specific project. (default: `5555`)
- **oeunit.portEnd**: Upper bound for the auto-assigned port range (default: `6000`)
- **oeunit.timeout**: Socket timeout in seconds (default: `60`)
- **oeunit.loglevel**: Server log level — `info`, `warning`, or `error` (default: `error`)
- **oeunit.autostart**: Automatically start the OEUnit server on activation (default: `true`)
- **oeunit.environmentVariables**: Custom environment variables when starting the Progress executable (default: `{}`). Example: `{"WRKDIR": "C:\\temp"}`
- **oeunit.projectPaths**: Explicit list of project root folder paths. When non-empty, overrides automatic discovery — only these folders are used. Use the **OEUnit: Add Project Folder…** command to populate this list.
- **oeunit.workspaceFolder**: *(Deprecated)* No longer used. Project discovery now happens automatically.

All settings support per-folder overrides in a multi-root workspace via the VS Code Settings UI.

### Project Configuration

The extension requires an `openedge-project.json` file in your workspace root with:
- `oeversion`: OpenEdge version name (must match a runtime configured in `abl.configuration.runtimes`)
- `buildPath`: Array of PROPATH entries for your project
- `dbConnections`: Array of database connection configurations with optional aliases

**JSONC**: `openedge-project.json` may contain `//` line comments and `/* */` block comments — the extension strips them before parsing, matching the ABL Language Server's behaviour.

**IMPORTANT**: The OEUnit library must be available in the PROPATH. You can achieve this either by:
1. Adding the OEUnit path to the `buildPath` in `openedge-project.json`, or
2. Specifying an INI file in `oeunit.oeargs` that defines the PROPATH (e.g., `-ini C:\path\to\startup.ini`)

## Usage

### Running Tests

1. Open the **Test Explorer** view in VS Code's activity bar (beaker icon)
2. The extension will automatically discover test files matching your pattern
3. Click the refresh icon (🔄) to manually refresh the test list
4. Click the play icon (▶️) next to a test file or method to run it
5. Click "Run All Tests" in the view title to run all discovered tests

On the first test run the server will start automatically if it has not been started yet — no prompt is shown.

### Test Methods

The extension discovers test methods by looking for:
- Methods with the `@Test` annotation
- Methods whose names start with "test" (case-insensitive)
- Inherited methods from parent classes via `INHERITS`

Example test class:
```openedge
CLASS TestExample:

    @Test.
    METHOD PUBLIC VOID testSomething():
        Assert:Equals(1, 1).
    END METHOD.

    METHOD PUBLIC VOID testAnotherThing():
        Assert:IsTrue(TRUE).
    END METHOD.

END CLASS.
```

### Viewing Results

After a test run, results appear in two places:

- **Test Results panel** (`View > Test Results`): per-method pass/fail/skip lines with timing, a summary footer (`Total / Passed / Failed / Skipped`), and detailed failure messages. Click a method in the Test Explorer to see only its output.
- **OEUnit Test Runner output channel**: full execution log.

### Copilot Chat Integration

Three tools are available as Copilot Chat references (add them via **Configure Tools** in the chat input):

| Tool | Description |
|------|-------------|
| `#oeunit_runTest` | Run a `.cls` test file or a single method. Returns JSON with Status, Summary, and TestCases. |
| `#oeunit_runFolder` | Discover and run all test files under a folder. Returns per-file and aggregate results. |
| `#oeunit_getLastResults` | Retrieve cached results from the most recent run without re-running. Works for Test Explorer runs too. |

Example chat prompt:
> Run the tests in `C:\project\test\TestFilling.cls` and summarise the failures.

### Exporting Results

Use **`OEUnit: Export Test Results…`** from the Command Palette to save the most recent cached results as:
- **JUnit XML** — accepted by Jenkins, Azure DevOps, GitHub Actions, and most CI tools
- **JSON** — easy to share with Copilot Chat for analysis (`#oeunit_getLastResults` also provides this directly)

## Server Management

The extension runs a persistent OpenEdge process to execute tests faster. In multi-project workspaces, one server process is started per project folder.

### Status Bar Indicator

- **$(loading~spin) OEUnit: Starting...** — Server is starting up
- **$(check) OEUnit: Running** — Server is ready and accepting test requests
- **$(circle-slash) OEUnit: Stopped** — Server is not running (yellow background)
- **$(error) OEUnit: Error** — Server encountered an error (red background)

Click the status bar item to quickly restart the server.

## Commands

Accessible via the Command Palette (`Ctrl+Shift+P`):

### Server Commands
- **OEUnit: Start Server** — Start the server (prompts for project in multi-project workspaces)
- **OEUnit: Stop Server** — Gracefully stop the server
- **OEUnit: Restart Server** — Restart the server
- **OEUnit: Kill Server** — Force-kill the server process immediately
- **OEUnit: Ping Server** — Verify the server is responding
- **OEUnit: Start All Servers** *(multi-project)* — Start all project servers
- **OEUnit: Stop All Servers** *(multi-project)* — Stop all project servers
- **OEUnit: Restart All Servers** *(multi-project)* — Restart all project servers

### Project Commands
- **OEUnit: Add Project Folder…** — Open a folder picker to add a path to `oeunit.projectPaths`

### Test & Export Commands
- **OEUnit: Export Test Results…** — Save the most recent test results as JUnit XML or JSON
- **OEUnit: Run Test (from Chat)** — Headless test execution for agents and automation scripts

## How It Works

1. **Extension activates** when workspace contains `.cls` or `.p` files
2. **Project discovery** finds all workspace folders with `openedge-project.json`
3. **Server starts automatically** (one per project) using the configured OpenEdge runtime
4. **Tests discovered** by scanning for files matching the test file pattern
5. **Running a test** sends a JSON request to the server via TCP socket
6. **Server executes** the test and returns results as JSON
7. **Extension** updates the Test Explorer tree, the Test Results panel, and the results cache

## Troubleshooting

### Server Won't Start

- Verify all required settings are configured (`oeunit.exec`, `oeunit.oeargs`)
- Ensure `openedge-project.json` exists with valid `oeversion` and OEUnit in the `buildPath`
- Check that the OpenEdge runtime is configured in `abl.configuration.runtimes`
- Verify OEUnit library is in PROPATH (either via `buildPath` or INI file)
- If `openedge-project.json` contains comments, ensure they use `//` or `/* */` style (JSONC)
- Review the **OEUnit Server** output channel for detailed errors

### Tests Not Appearing

- Check that your test files match the configured `oeunit.testFilePattern`
- Verify the files contain test methods (`@Test` annotation or names starting with `test`)
- Click the refresh button (🔄) in the Testing view

### Tests Fail with "Server is not running"

- The server starts automatically on the first run — wait for it to be ready
- If it was previously running and has since stopped, use **OEUnit: Start Server**
- Use **OEUnit: Ping Server** to verify the server is responding
- If the server appears stuck, use **OEUnit: Kill Server**, then start it again

### Port Conflicts

If port 5555 is in use, change `oeunit.port` to a free port and restart the server. In multi-project workspaces the extension auto-assigns ports in the range `[oeunit.port … oeunit.portEnd]`; the first available port is used per project.

### Watch Mode

```powershell
npm run watch
```

Press `F5` to launch the Extension Development Host.

## License

This extension is provided as-is for local development use.

## Support

For issues or questions, please contact your development team.


```json
{
  "oeunit.exec": "_progres.exe",
  "oeunit.oeargs": "-cpinternal utf-8 -cpstream utf-8 -cpcoll Basic -cpcase Basic",
  "oeunit.testFilePattern": "**/test/**/*.cls",
  "oeunit.port": 5555,
  "oeunit.timeout": 60,
  "oeunit.loglevel": "error",
  "oeunit.autostart": true
}
```

### Required Settings

- **oeunit.exec**: OpenEdge executable name (default: `_progres.exe`)
- **oeunit.oeargs**: OpenEdge startup arguments (can include INI file with PROPATH definition)

### Optional Settings

- **oeunit.testFilePattern**: Glob pattern to match test files (default: `**/test/**/*.cls`)
- **oeunit.port**: Port number for the persistent test server (default: `5555`)
- **oeunit.timeout**: Socket timeout in seconds for client connections and server reads (default: `60`)
- **oeunit.loglevel**: Server log level - `info`, `warning`, or `error` (default: `error`)
- **oeunit.workspaceFolder**: Workspace folder path to use for OEUnit server. If not specified, defaults to the first workspace folder. Useful in multi-root workspace scenarios
- **oeunit.autostart**: Automatically start the OEUnit server when the extension activates (default: `true`)
- **oeunit.environmentVariables**: Object containing custom environment variables to set when starting the Progress executable (default: `{}`). These variables can override DLC and PROPATH if needed. Example: `{"WRKDIR": "C:\\temp", "HTTPS_PROXY": "http://proxy:8080"}`

### Project Configuration

The extension requires an `openedge-project.json` file in your workspace root with:
- `oeversion`: OpenEdge version name (must match a runtime configured in `abl.configuration.runtimes`)
- `buildPath`: Array of PROPATH entries for your project
- `dbConnections`: Array of database connection configurations with optional aliases

**IMPORTANT**: The OEUnit library must be available in the PROPATH. You can achieve this either by:
1. Adding the OEUnit path to the `buildPath` in `openedge-project.json`, or
2. Specifying an INI file in `oeunit.oeargs` that defines the PROPATH (e.g., `-ini C:\path\to\startup.ini`)

## Usage

### Running Tests

1. Open the **Test Explorer** view in VS Code's activity bar
2. The extension will automatically discover test files matching your pattern
3. Click the refresh icon (🔄) to manually refresh the test list
4. Click the play icon (▶️) next to a test file to run that file's tests
5. Click "Run All Tests" (▶️▶️) in the view title to run all discovered tests

### Test Methods

The extension discovers test methods by looking for:
- Methods with the `@Test` annotation
- Methods whose names start with "test" (case-insensitive)

Example test class:
```openedge
CLASS TestExample:

    @Test.
    METHOD PUBLIC VOID testSomething():
        Assert:Equals(1, 1).
    END METHOD.

    METHOD PUBLIC VOID testAnotherThing():
        Assert:IsTrue(TRUE).
    END METHOD.

END CLASS.
```

### Viewing Results

- Test execution output appears in the **OEUnit Test Runner** output channel
- Test status icons update after each run:
  - ○ Pending (not run)
  - ✓ Passed (green)
  - ✗ Failed/Error (red)

## Server Management

The extension runs a persistent OpenEdge process to execute tests faster. The status bar shows the current server state.

### Status Bar Indicator

- **$(loading~spin) OEUnit: Starting...** - Server is starting up
- **$(check) OEUnit: Running** - Server is ready and accepting test requests
- **$(circle-slash) OEUnit: Stopped** - Server is not running (yellow background)
- **$(error) OEUnit: Error** - Server encountered an error (red background)

Click the status bar item to quickly restart the server.

## Commands

The extension provides the following commands (accessible via Command Palette: `Ctrl+Shift+P`):

### Server Commands
- **OEUnit: Start Server** - Start the persistent test server
- **OEUnit: Stop Server** - Gracefully stop the persistent test server
- **OEUnit: Restart Server** - Restart the persistent test server
- **OEUnit: Kill Server** - Force-kill the server process immediately (use when Stop Server hangs)
- **OEUnit: Ping Server** - Send PING to server to verify it's responding

### Test Commands
- Tests are run through the native VS Code Testing view (beaker icon in the Activity Bar)
- Click the play button next to any test file or method to run it
- Use the "Run All Tests" button in the Testing view toolbar

## How It Works

1. **Extension activates** when workspace contains `.cls` or `.p` files
2. **Server starts automatically** using configured OpenEdge runtime
3. **Server listens** on configured port for test requests
4. **Tests discovered** by scanning for files matching the pattern
5. **Running a test** sends request to server via TCP socket with JSON message
6. **Server executes** test and returns results via JSON response
7. **Extension parses** JSON and updates test results in UI

## Troubleshooting

### Server Won't Start

Check the **Developer Tools Console** (Help > Toggle Developer Tools) for detailed logs:
- Verify all required settings are configured (`oeunit.exec`, `oeunit.oeargs`)
- Ensure `openedge-project.json` exists with valid `oeversion` and OEUnit in the `buildPath`
- Check that the OpenEdge runtime is configured in `abl.configuration.runtimes`
- Verify OEUnit library is in PROPATH (either via `buildPath` or INI file)
- Review the **OEUnit Server** output channel for startup errors

### Tests Not Appearing

- Check that your test files match the configured `oeunit.testFilePattern`
- Verify the files contain test methods (methods starting with "test" or with `@Test` annotation)
- Click the refresh button (🔄) in the Testing view

### Tests Fail with "Server is not running"

- On the **first test run**, the server will start automatically if it has never been started in the current session
- If the server was previously running but has since stopped, use **OEUnit: Start Server** to restart it
- Check the status bar - server should show "Running" status
- Use **OEUnit: Ping Server** command to verify server is responding
- If the server appears stuck, use **OEUnit: Kill Server** to force-kill it, then start it again
- Review the **OEUnit Server** output channel for errors

### Configuration Issues

- Ensure OEUnit library is in PROPATH (via `buildPath` in `openedge-project.json` or INI file)
- Check that database connection strings in `openedge-project.json` are valid
- Verify `oeunit.oeargs` are properly formatted

### Port Conflicts

If port 5555 is already in use, change `oeunit.port` to a different value and restart the server.

### Watch Mode

For development with automatic recompilation:
```powershell
npm run watch
```

Press `F5` to launch the Extension Development Host.

## Limitations

None currently known. Individual test methods can now be run independently.

## License

This extension is provided as-is for local development use.

## Support

For issues or questions, please contact your development team.
