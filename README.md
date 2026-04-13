# OEUnit Test Explorer for VS Code

VS Code extension for running OpenEdge ABL unit tests via the OEUnit framework using a persistent test server.

## Prerequisites

- VS Code 1.85.0+
- OpenEdge ABL environment with OEUnit installed
- `openedge-project.json` in each project root
- `abl.configuration.runtimes` configured with the OpenEdge runtime

## Project Configuration

The extension reads `openedge-project.json` from your project root. Two fields are used:

- **`oeversion`** *(required)*: must match a runtime name in `abl.configuration.runtimes` — used to locate DLC.
- **`dbConnections`** *(optional)*: array of database connections. Each entry may have:
  - `connect`: connection string passed directly as ABL arguments (e.g. `-db mydb -H localhost -S 3000`)
  - `name` + `aliases`: array of logical alias names for this database

```json
{
  "oeversion": "12.8",
  "dbConnections": [
    {
      "name": "mydb",
      "connect": "-db mydb -H localhost -S 3000",
      "aliases": ["alias1", "alias2"]
    }
  ]
}
```

## PROPATH and OEUnit Library

The extension does **not** construct a PROPATH from `openedge-project.json`. The full PROPATH — including the OEUnit library — must be supplied via `oeunit.oeargs`.

The typical approach is a INI file (`-basekey ini -ininame path/to/myproject.ini`):

## Settings

All settings are scoped per workspace folder, so multi-root workspaces can configure each project independently.

| Setting | Default | Description |
|---|---|---|
| `oeunit.exec` | `_progres.exe` | OpenEdge executable name |
| `oeunit.oeargs` | *(empty)* | Startup arguments — must include PROPATH with OEUnit |
| `oeunit.testFilePattern` | `**/test/**/*.cls` | Glob pattern for test file discovery |
| `oeunit.port` | `5555` | Base port; in multi-project mode each project gets `port + index` |
| `oeunit.portEnd` | `6000` | Upper bound for auto port assignment |
| `oeunit.timeout` | `60` | Socket timeout in seconds |
| `oeunit.loglevel` | `error` | Server log verbosity: `info`, `warning`, or `error` |
| `oeunit.autostart` | `false` | Start server automatically on extension activation |
| `oeunit.projectPaths` | `[]` | Explicit list of project root paths — overrides automatic discovery when non-empty |
| `oeunit.environmentVariables` | `{}` | Extra environment variables passed to the Progress process |

## Test Discovery

The extension scans for test classes matching `oeunit.testFilePattern`. A method is treated as a test if:
- its name starts with `test` (case-insensitive), or
- it is preceded by an `@Test` annotation.

Inherited test methods are also discovered by following the `INHERITS` chain.

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P`):

| Command | Description |
|---|---|
| `OEUnit: Start Server` | Start the persistent test server |
| `OEUnit: Stop Server` | Gracefully stop the test server |
| `OEUnit: Restart Server` | Stop then start the test server |
| `OEUnit: Kill Server` | Force-kill the server process |
| `OEUnit: Ping Server` | Verify the server is responding |
| `OEUnit: Add Project Folder…` | Add a folder to `oeunit.projectPaths` via a folder picker |
| `OEUnit: Start/Stop/Restart All Servers` | Bulk operations for multi-project mode |

## Troubleshooting

**Server won't start**
- Check the **OEUnit Server** output channel for the error.
- Verify `oeunit.exec` and `oeunit.oeargs` are set.
- Confirm `openedge-project.json` contains a valid `oeversion` matching a configured runtime.

**OEUnit classes not found at runtime (PROPATH error)**
- The PROPATH is not derived from `openedge-project.json`. Pass it via ini arguments in `oeunit.oeargs`.

**Tests not appearing**
- Ensure test files match `oeunit.testFilePattern`.
- Confirm test methods start with `test` or have `@Test`.
- Use the refresh button in the Testing view.

**Port conflict**
- Increase `oeunit.port` or set an explicit per-folder port in `.code-workspace`.

## License

Provided as-is for local development use.
