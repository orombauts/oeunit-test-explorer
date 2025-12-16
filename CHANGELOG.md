# Change Log

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

