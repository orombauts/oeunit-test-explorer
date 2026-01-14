# Change Log

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

