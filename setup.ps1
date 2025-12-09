# OEUnit Test Explorer - Setup Script
# Run this script to install dependencies and compile the extension

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "OEUnit Test Explorer Extension - Setup" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host ""

# Check if npm is available
$npmPath = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmPath) {
    Write-Host "ERROR: npm is not found in PATH" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Node.js from: https://nodejs.org/" -ForegroundColor Yellow
    Write-Host "After installation, restart PowerShell and run this script again." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

Write-Host "[OK] npm found: $($npmPath.Source)" -ForegroundColor Green
Write-Host ""

# Navigate to extension directory
$extensionPath = "C:\Workspace\VSCode\ADM_2_0\oeunit-test-explorer"
Set-Location $extensionPath

# Install dependencies
Write-Host "Installing dependencies..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to install dependencies" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Dependencies installed" -ForegroundColor Green
Write-Host ""

# Compile TypeScript
Write-Host "Compiling TypeScript..." -ForegroundColor Cyan
npm run compile
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to compile extension" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Extension compiled successfully" -ForegroundColor Green
Write-Host ""

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "Setup completed successfully!" -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Open the extension folder in VS Code:" -ForegroundColor White
Write-Host "   code $extensionPath" -ForegroundColor Gray
Write-Host ""
Write-Host "2. Press F5 to launch the Extension Development Host" -ForegroundColor White
Write-Host ""
Write-Host "3. In the Extension Development Host, open your ABL workspace" -ForegroundColor White
Write-Host ""
Write-Host "4. Look for OEUnit Tests in the Test Explorer view" -ForegroundColor White
Write-Host ""
