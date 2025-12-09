# Quick Start Guide - OEUnit Test Explorer

## Installation Steps

### 1. Prerequisites

Ensure you have Node.js installed:
- Download from: https://nodejs.org/ (LTS version recommended)
- Verify installation: Open PowerShell and run `node --version`

### 2. Install the Extension

Run the setup script:

```powershell
cd C:\Workspace\VSCode\ADM_2_0\oeunit-test-explorer
.\setup.ps1
```

Or manually:

```powershell
cd C:\Workspace\VSCode\ADM_2_0\oeunit-test-explorer
npm install
npm run compile
```

### 3. Launch the Extension

**Option A: Development Mode**
1. Open the extension folder in VS Code:
   ```powershell
   code C:\Workspace\VSCode\ADM_2_0\oeunit-test-explorer
   ```
2. Press `F5` to launch the Extension Development Host
3. In the new window, open your ABL workspace

**Option B: Install as VSIX**
1. Package the extension:
   ```powershell
   npm install -g @vscode/vsce
   vsce package
   ```
2. Install the `.vsix` file:
   - In VS Code: Extensions → ... → Install from VSIX
   - Select the generated `.vsix` file

## Configuration

After installation, configure the extension in your workspace settings:

1. Open Settings (Ctrl+,)
2. Search for "oeunit"
3. Configure paths:

```json
{
  "oeunit.oeunitHome": "C:\\Workspace\\VSCode\\ADM_2_0\\adm-OEUnit",
  "oeunit.toolsHome": "C:\\Workspace\\VSCode\\OE_IDE_ADM_Tools",
  "oeunit.outputDirectory": "${workspaceFolder}\\OEResults\\xml",
  "oeunit.testFilePattern": "**/test/**/*.cls"
}
```

## Usage

### Finding Tests

1. Open the **Test Explorer** view (Testing icon in Activity Bar)
2. Look for **OEUnit Tests** section
3. Tests are automatically discovered based on your pattern

### Running Tests

- **Run All Tests**: Click ▶️▶️ button in the view title
- **Run Test File**: Click ▶️ next to a test file
- **View Results**: Check the "OEUnit Test Runner" output channel

### Test Discovery

The extension finds test methods by looking for:
- Methods with `@Test` annotation
- Methods starting with "test" (case-insensitive)

Example:
```openedge
CLASS TestMyFeature:
    
    @Test.
    METHOD PUBLIC VOID testAddition():
        Assert:Equals(2, 1 + 1).
    END METHOD.
    
    METHOD PUBLIC VOID testSubtraction():
        Assert:Equals(0, 1 - 1).
    END METHOD.
    
END CLASS.
```

## Troubleshooting

### Extension Not Loading
- Ensure Node.js and npm are installed
- Run `npm install` in the extension directory
- Check for compilation errors: `npm run compile`

### Tests Not Found
- Verify `testFilePattern` setting matches your test file locations
- Check that test files contain valid test methods
- Click the refresh button in Test Explorer

### Tests Not Running
- Verify `oeunitHome` path is correct
- Verify `toolsHome` path contains `Run-OEUnitTest.ps1`
- Check the Output panel for error messages
- Ensure OEResults directory is writable

### Common Issues

**Issue**: "npm is not recognized"
- **Solution**: Install Node.js from nodejs.org and restart PowerShell

**Issue**: Test files appear but methods don't
- **Solution**: Ensure methods follow naming convention (start with "test" or have @Test)

**Issue**: Tests run but no results shown
- **Solution**: Check that output directory exists and XML files are being created

## Additional Resources

- Full documentation: See README.md in the extension folder
- OEUnit documentation: Check your OEUnit installation
- VS Code Extension API: https://code.visualstudio.com/api
