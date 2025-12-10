import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { OEUnitResultParser } from './resultParser';
import { OEUnitServerManager } from './serverManager';

export class OEUnitTestRunner {
    private outputChannel: vscode.OutputChannel;
    private resultParser: OEUnitResultParser;
    private serverManager: OEUnitServerManager | null = null;
    private extensionVersion: string = 'unknown';

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('OEUnit Test Runner');
        this.resultParser = new OEUnitResultParser();
    }

    setExtensionVersion(version: string) {
        this.extensionVersion = version;
    }

    setServerManager(serverManager: OEUnitServerManager | null) {
        this.serverManager = serverManager;
    }

    async runTestFile(filePath: string, run: vscode.TestRun, testItem: vscode.TestItem): Promise<void> {
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`\nRunning tests in: ${path.basename(filePath)} (Extension v${this.extensionVersion})`);
        this.outputChannel.appendLine('-'.repeat(80));

        // Check if server is running
        const serverRunning = this.serverManager && this.serverManager.isServerRunning();
        this.outputChannel.appendLine(`[TestRunner] Server manager exists: ${!!this.serverManager}, Server running: ${serverRunning}`);
        
        if (!serverRunning) {
            // Server not running - fail the test
            this.outputChannel.appendLine('[TestRunner] ERROR: Server is not running. Tests cannot be executed.');
            const errorMessage = new vscode.TestMessage('OEUnit server is not running. Please start the server using "OEUnit: Start Server" command.');
            
            // Mark test as failed
            if (testItem.children.size > 0) {
                // If test item has children (test methods), fail all of them
                testItem.children.forEach(child => {
                    run.failed(child, errorMessage);
                });
            }
            run.failed(testItem, errorMessage);
            return;
        }

        // Use persistent server
        return this.runTestViaServer(filePath, run, testItem);
    }

    private async runTestViaServer(filePath: string, run: vscode.TestRun, testItem: vscode.TestItem): Promise<void> {
        this.outputChannel.appendLine('[Using persistent server]');

        const config = vscode.workspace.getConfiguration('oeunit');
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';

        const outputDir = config.get<string>('outputDirectory');
        const resolvedOutputDir = this.resolveOutputDirectory(outputDir || '${workspaceFolder}\\OEResults\\xml');

        if (!fs.existsSync(resolvedOutputDir)) {
            fs.mkdirSync(resolvedOutputDir, { recursive: true });
        }

        const outputFileName = this.getOutputFileName(filePath);
        const outputFilePath = path.join(resolvedOutputDir, outputFileName);

        // Get runner path from configuration
        const oeunitHome = config.get<string>('home');
        const oeunitRunner = config.get<string>('runner');
        this.outputChannel.appendLine(`[TestRunner] Config home: '${oeunitHome}'`);
        this.outputChannel.appendLine(`[TestRunner] Config runner: '${oeunitRunner}'`);
        const runnerPath = path.join(oeunitHome || '', oeunitRunner || '');
        this.outputChannel.appendLine(`[TestRunner] Full runner path: ${runnerPath}`);
        
        this.outputChannel.appendLine(`[TestRunner] oeunit.home: ${oeunitHome}`);
        this.outputChannel.appendLine(`[TestRunner] oeunit.runner: ${oeunitRunner}`);
        this.outputChannel.appendLine(`[TestRunner] Full runner path: ${runnerPath}`);

        try {
            const response = await this.serverManager!.runTest(runnerPath, resolvedOutputDir, filePath, 'debug');            
            if (response.startsWith('OK:')) {
                this.outputChannel.appendLine('\n[OK] Tests completed successfully');
                await this.parseResults(outputFilePath, run, testItem);
                run.passed(testItem);
            } else if (response.startsWith('ERROR:')) {
                const errorMsg = response.substring(6);
                this.outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
                run.failed(testItem, new vscode.TestMessage(errorMsg));
            }
        } catch (error) {
            this.outputChannel.appendLine(`\n[ERROR] ${error}`);
            run.failed(testItem, new vscode.TestMessage(String(error)));
        }
    }

    private async runTestDirect(filePath: string, run: vscode.TestRun, testItem: vscode.TestItem): Promise<void> {
        this.outputChannel.appendLine('[Using direct execution - server not running]');

        this.outputChannel.appendLine(`Starting test run...`);
        
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
        this.outputChannel.appendLine(`Workspace folder: ${workspaceFolder}`);
        
        // Get configuration from workspace scope
        const config = vscode.workspace.getConfiguration('oeunit', vscode.workspace.workspaceFolders?.[0].uri);
        this.outputChannel.appendLine(`Got configuration object`);

        // Get configuration - require all settings, no defaults
        const oeunitHome = config.get<string>('home');
        const oeunitRunner = config.get<string>('runner');
        const execName = config.get<string>('exec');
        const oeArgs = config.get<string>('oeargs');
        const outputDir = config.get<string>('outputDirectory');
        const debug = config.get<string>('debug') || '0';

        this.outputChannel.appendLine(`Config values: home='${oeunitHome}', runner='${oeunitRunner}', exec='${execName}'`);
        this.outputChannel.appendLine(`oeargs='${oeArgs}'`);

        // Validate required settings
        if (!oeunitHome) {
            const errorMsg = 'oeunit.home not configured in settings.json';
            this.outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
            run.failed(testItem, new vscode.TestMessage(errorMsg));
            return;
        }
        if (!oeunitRunner) {
            const errorMsg = 'oeunit.runner not configured in settings.json';
            this.outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
            run.failed(testItem, new vscode.TestMessage(errorMsg));
            return;
        }
        if (!execName) {
            const errorMsg = 'oeunit.exec not configured in settings.json';
            this.outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
            run.failed(testItem, new vscode.TestMessage(errorMsg));
            return;
        }
        if (!oeArgs) {
            const errorMsg = 'oeunit.oeargs not configured in settings.json';
            this.outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
            run.failed(testItem, new vscode.TestMessage(errorMsg));
            return;
        }

        const resolvedOutputDir = this.resolveOutputDirectory(outputDir || '${workspaceFolder}\\OEResults\\xml');
        if (!fs.existsSync(resolvedOutputDir)) {
            fs.mkdirSync(resolvedOutputDir, { recursive: true });
        }

        // Get DLC path
        const dlcPath = await this.getDlcPath(workspaceFolder);
        if (!dlcPath) {
            const errorMsg = 'Could not determine DLC path. Check openedge-project.json and abl.configuration.runtimes settings.';
            this.outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
            run.failed(testItem, new vscode.TestMessage(errorMsg));
            return;
        }

        this.outputChannel.appendLine(`DLC Path: ${dlcPath}`);
        this.outputChannel.appendLine(`OEUnit Home: ${oeunitHome}`);
        this.outputChannel.appendLine(`OEUnit Runner: ${oeunitRunner}`);

        // Build executable path: $DLC\bin\$exec
        const progresPath = path.join(dlcPath, 'bin', execName);
        
        if (!fs.existsSync(progresPath)) {
            const errorMsg = `OpenEdge executable not found at: ${progresPath}`;
            this.outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
            run.failed(testItem, new vscode.TestMessage(errorMsg));
            return;
        }

        // Get extension path for OEUnitServer.p
        const extensionPath = path.join(__dirname, '..');
        const oeunitServerPath = path.join(extensionPath, 'abl', 'OEUnitServer.p');
        
        if (!fs.existsSync(oeunitServerPath)) {
            const errorMsg = `OEUnitServer.p not found at: ${oeunitServerPath}`;
            this.outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
            run.failed(testItem, new vscode.TestMessage(errorMsg));
            return;
        }

        // Build runner path: $oeunit-home\$oeunit-runner
        const runnerPath = path.join(oeunitHome, oeunitRunner);
        this.outputChannel.appendLine(`OEUnit Runner Path: ${runnerPath}`);

        // Get PROPATH - include extension abl folder
        const propath = await this.getPropath(workspaceFolder, oeunitHome, path.join(extensionPath, 'abl'));
        this.outputChannel.appendLine(`PROPATH: ${propath}`);

        // Get database connections
        const { dbArgs, dbAliasEnv } = await this.getDatabaseConnections(workspaceFolder);
        if (dbArgs.length > 0) {
            this.outputChannel.appendLine(`Database connections: ${dbArgs.length} databases`);
        }

        // Build param value: all arguments within one quoted string
        const paramValue = `${resolvedOutputDir},${filePath},debug`;
        
        // Expected output file path - OEUnit names it based on package path from 'test' folder
        const outputFileName = this.getOutputFileName(filePath);
        const outputFilePath = path.join(resolvedOutputDir, outputFileName);
        this.outputChannel.appendLine(`Expected output file: ${outputFileName}`);

        // Parse oeargs
        const oeArgsArray = oeArgs.split(' ').filter(arg => arg.trim() !== '');

        // Build command: $DLC\bin\$exec -b $oeargs [dbArgs...] -p OEUnitServer.p -param "outputDir,file,debug"
        const args = [
            '-b',
            ...oeArgsArray,
            ...dbArgs,
            '-p', oeunitServerPath,
            '-param', paramValue
        ];

        return new Promise((resolve, reject) => {
            this.outputChannel.appendLine(`\nCommand: "${progresPath}" ${args.join(' ')}`);
            this.outputChannel.appendLine('');
            
            const childProcess = cp.spawn(progresPath, args, {
                cwd: workspaceFolder,
                env: {
                    ...process.env,
                    DLC: dlcPath,
                    PROPATH: propath,
                    OEUNIT_RUNNER: runnerPath,
                    OEUNIT_DEBUG: debug,
                    ...dbAliasEnv
                }
            });

            let stdout = '';
            let stderr = '';

            childProcess.stdout?.on('data', (data) => {
                const text = data.toString();
                stdout += text;
                this.outputChannel.append(text);
            });

            childProcess.stderr?.on('data', (data) => {
                const text = data.toString();
                stderr += text;
                this.outputChannel.append(text);
            });

            childProcess.on('close', async (code) => {
                if (code === 0) {
                    this.outputChannel.appendLine(`\n[OK] Tests completed successfully`);
                    await this.parseResults(outputFilePath, run, testItem);
                    run.passed(testItem);
                    resolve();
                } else {
                    this.outputChannel.appendLine(`\n[ERROR] Tests failed with exit code: ${code}`);
                    if (stderr) {
                        this.outputChannel.appendLine(`Error: ${stderr}`);
                    }
                    await this.parseResults(outputFilePath, run, testItem);
                    run.failed(testItem, new vscode.TestMessage(`Test execution failed with code ${code}`));
                    resolve();
                }
            });

            childProcess.on('error', (error) => {
                this.outputChannel.appendLine(`\nError running tests: ${error.message}`);
                run.errored(testItem, new vscode.TestMessage(error.message));
                reject(error);
            });
        });
    }

    private async getDlcPath(workspaceFolder: string): Promise<string | null> {
        try {
            const projectJsonPath = path.join(workspaceFolder, 'openedge-project.json');
            if (!fs.existsSync(projectJsonPath)) {
                this.outputChannel.appendLine('[WARNING] openedge-project.json not found');
                return null;
            }

            const projectJson = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
            const oeVersion = projectJson.oeversion;
            
            if (!oeVersion) {
                this.outputChannel.appendLine('[WARNING] oeversion not found in openedge-project.json');
                return null;
            }

            this.outputChannel.appendLine(`OpenEdge Version: ${oeVersion}`);

            const ablConfig = vscode.workspace.getConfiguration('abl');
            const runtimes = ablConfig.get<any[]>('configuration.runtimes', []);
            const runtime = runtimes.find((rt: any) => rt.name === oeVersion);
            
            if (!runtime || !runtime.path) {
                this.outputChannel.appendLine(`[WARNING] No runtime found for version ${oeVersion} in abl.configuration.runtimes`);
                return null;
            }

            return runtime.path;

        } catch (error) {
            this.outputChannel.appendLine(`[ERROR] Failed to get DLC path: ${error}`);
            return null;
        }
    }

    private async getPropath(workspaceFolder: string, oeunitHome: string, extensionAblFolder?: string): Promise<string> {
        try {
            const projectJsonPath = path.join(workspaceFolder, 'openedge-project.json');
            const projectJson = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
            
            const propathEntries: string[] = [
                oeunitHome,
                workspaceFolder
            ];
            
            // Add extension abl folder if provided
            if (extensionAblFolder) {
                propathEntries.push(extensionAblFolder);
            }

            if (projectJson.buildPath && Array.isArray(projectJson.buildPath)) {
                for (const entry of projectJson.buildPath) {
                    const entryPath = entry.path || entry;
                    const fullPath = path.isAbsolute(entryPath) 
                        ? entryPath 
                        : path.join(workspaceFolder, entryPath);
                    propathEntries.push(fullPath);
                }
            }

            return propathEntries.join(path.delimiter);

        } catch (error) {
            this.outputChannel.appendLine(`[WARNING] Failed to build PROPATH: ${error}`);
            return `${oeunitHome}${path.delimiter}${workspaceFolder}`;
        }
    }

    private resolveOutputDirectory(outputDir: string): string {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
        return outputDir.replace('${workspaceFolder}', workspaceFolder);
    }

    private async parseResults(outputFilePath: string, run: vscode.TestRun, testItem: vscode.TestItem): Promise<void> {
        try {
            if (fs.existsSync(outputFilePath)) {
                const results = await this.resultParser.parseResultFile(outputFilePath, this.outputChannel);
                
                // Update individual test method statuses
                for (const result of results) {
                    // Find the test method in the test item's children
                    testItem.children.forEach(child => {
                        if (child.label === result.name) {
                            if (result.status === 'passed') {
                                run.passed(child, result.time * 1000); // Convert to milliseconds
                            } else if (result.status === 'failed') {
                                run.failed(child, new vscode.TestMessage(result.message || 'Test failed'), result.time * 1000);
                            } else if (result.status === 'error') {
                                run.errored(child, new vscode.TestMessage(result.message || 'Test error'), result.time * 1000);
                            }
                        }
                    });
                }
            } else {
                this.outputChannel.appendLine(`[WARNING] Output file not found: ${outputFilePath}`);
            }
        } catch (error) {
            this.outputChannel.appendLine(`Error parsing results: ${error}`);
        }
    }

    private getOutputFileName(filePath: string): string {
        // Find 'test' folder in the path
        const pathParts = filePath.split(path.sep);
        const testIndex = pathParts.findIndex(part => part.toLowerCase() === 'test');
        
        if (testIndex >= 0) {
            // Get all parts from 'test' onwards, remove .cls extension, join with dots
            const packageParts = pathParts.slice(testIndex);
            const lastPart = packageParts[packageParts.length - 1].replace('.cls', '');
            packageParts[packageParts.length - 1] = lastPart;
            return packageParts.join('.') + '.xml';
        }
        
        // Fallback to just the class name
        return path.basename(filePath, '.cls') + '.xml';
    }

    private async getDatabaseConnections(workspaceFolder: string): Promise<{ dbArgs: string[], dbAliasEnv: Record<string, string> }> {
        const dbArgs: string[] = [];
        const dbAliasEnv: Record<string, string> = {};

        try {
            const projectJsonPath = path.join(workspaceFolder, 'openedge-project.json');
            if (!fs.existsSync(projectJsonPath)) {
                return { dbArgs, dbAliasEnv };
            }

            const projectJson = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
            
            if (!projectJson.dbConnections || !Array.isArray(projectJson.dbConnections)) {
                return { dbArgs, dbAliasEnv };
            }

            for (const dbConn of projectJson.dbConnections) {
                // Add database connection string
                if (dbConn.connect) {
                    const connectArgs = dbConn.connect.split(' ').filter((arg: string) => arg.trim() !== '');
                    dbArgs.push(...connectArgs);
                    
                    this.outputChannel.appendLine(`Database: ${dbConn.name}`);
                }

                // Set alias environment variable for OEUnitServer.p
                if (dbConn.name && dbConn.aliases && Array.isArray(dbConn.aliases) && dbConn.aliases.length > 0) {
                    const envVarName = `OEUNIT_ALIAS_${dbConn.name.toUpperCase()}`;
                    const aliasesValue = dbConn.aliases.join(',');
                    dbAliasEnv[envVarName] = aliasesValue;
                    
                    this.outputChannel.appendLine(`  Aliases: ${aliasesValue}`);
                }
            }

        } catch (error) {
            this.outputChannel.appendLine(`[WARNING] Failed to read database connections: ${error}`);
        }

        return { dbArgs, dbAliasEnv };
    }
}
