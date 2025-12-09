# OEUnit Test Explorer for VS Code

A Visual Studio Code extension for running and exploring OpenEdge ABL unit tests using OEUnit with a persistent test server.

## Features

- **Persistent Test Server**: Long-running OpenEdge process for faster test execution
- **Test Explorer Integration**: Browse all test files and methods in VS Code's native Testing view
- **Run Tests**: Execute individual test files, test methods, or all tests
- **Test Discovery**: Automatically discovers test files matching the configured pattern
- **Real-time Results**: View test results with detailed output and XML parsing
- **Server Management**: Commands to start, stop, restart, and ping the test server
- **Status Bar**: Visual indicator showing current server status
- **Auto-restart on Config Changes**: Server automatically restarts when settings change
- **Database Support**: Automatic database connection and alias configuration

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
  "oeunit.home": "C:\\Workspace\\OEUnit",
  "oeunit.runner": "Automation\\Pct\\RunTests.p",
  "oeunit.exec": "_progres.exe",
  "oeunit.oeargs": "-cpinternal utf-8 -cpstream utf-8 -cpcoll Basic -cpcase Basic",
  "oeunit.outputDirectory": "${workspaceFolder}\\OEResults\\xml",
  "oeunit.testFilePattern": "**/test/**/*.cls",
  "oeunit.port": 5555,
  "oeunit.loglevel": "error"
}
```

### Required Settings

- **oeunit.home**: Path to your OEUnit installation directory
- **oeunit.runner**: Path to OEUnit runner procedure (relative to oeunit.home)
- **oeunit.exec**: OpenEdge executable name (default: `_progres.exe`)
- **oeunit.oeargs**: OpenEdge startup arguments

### Optional Settings

- **oeunit.outputDirectory**: Directory where test results XML files will be saved (default: `${workspaceFolder}\\OEResults\\xml`)
- **oeunit.testFilePattern**: Glob pattern to match test files (default: `**/test/**/*.cls`)
- **oeunit.port**: Port number for the persistent test server (default: `5555`)
- **oeunit.loglevel**: Server log level - `info`, `warning`, or `error` (default: `error`)

### Project Configuration

The extension also requires an `openedge-project.json` file in your workspace root with:
- `oeversion`: OpenEdge version name (must match a runtime configured in `abl.configuration.runtimes`)
- `buildPath`: Array of PROPATH entries
- `dbConnections`: Array of database connection configurations with optional aliases

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
- **OEUnit: Stop Server** - Stop the persistent test server
- **OEUnit: Restart Server** - Restart the persistent test server
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
5. **Running a test** sends request to server via TCP socket
6. **Server executes** test and writes XML results
7. **Extension parses** XML and updates test results in UI

## Troubleshooting

### Server Won't Start

Check the **Developer Tools Console** (Help > Toggle Developer Tools) for detailed logs:
- Verify all required settings are configured (`oeunit.home`, `oeunit.runner`, `oeunit.exec`, `oeunit.oeargs`)
- Ensure `openedge-project.json` exists with valid `oeversion`
- Check that the OpenEdge runtime is configured in `abl.configuration.runtimes`
- Review the **OEUnit Server** output channel for startup errors

### Tests Not Appearing

- Check that your test files match the configured `oeunit.testFilePattern`
- Verify the files contain test methods (methods starting with "test" or with `@Test` annotation)
- Click the refresh button (🔄) in the Testing view

### Tests Fail with "Server is not running"

- Check the status bar - server should show "Running" status
- Use **OEUnit: Start Server** command to start the server
- Use **OEUnit: Ping Server** command to verify server is responding
- Review the **OEUnit Server** output channel for errors

### Configuration Issues

- Use absolute paths for `oeunit.home`
- Ensure `oeunit.runner` path is relative to `oeunit.home`
- Check that database connection strings in `openedge-project.json` are valid
- Verify the output directory is writable

### Port Conflicts

If port 5555 is already in use, change `oeunit.port` to a different value and restart the server.

## Development

### Building from Source

```powershell
cd C:\Workspace\VSCode\ADM_2_0\oeunit-test-explorer
npm install
npm run compile
```

### Watch Mode

For development with automatic recompilation:
```powershell
npm run watch
```

Press `F5` to launch the Extension Development Host.

## License

This extension is provided as-is for local development use.

## Support

For issues or questions, please contact your development team.
