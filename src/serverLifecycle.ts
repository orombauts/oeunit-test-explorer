/**
 * OEUnit server process lifecycle management.
 * Handles starting, stopping, restarting, and health-checking the persistent
 * OEUnit server process, as well as parsing openedge-project.json and
 * updating the status-bar item.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { OEUnitServerManager } from './serverManager';
import { OEUnitTestRunner } from './testRunner';

export interface ProjectConfig {
    oeVersion: string;
    dlcPath: string;
    propath: string;
    dbArgs: string[];
    dbAliasEnv: Record<string, string>;
}

let serverManager: OEUnitServerManager | null = null;
let statusBarItem: vscode.StatusBarItem;
let serverOutputChannel: vscode.OutputChannel;
let configChangeTimeout: NodeJS.Timeout | undefined;

// Must be called once from activate() after the status bar item and output channel
// have been created and registered with context.subscriptions.
export function initServerLifecycle(item: vscode.StatusBarItem, outputChannel: vscode.OutputChannel): void {
    statusBarItem = item;
    serverOutputChannel = outputChannel;
}

export function getServerManager(): OEUnitServerManager | null {
    return serverManager;
}

// Debounced handler for oeunit configuration changes.
export function handleConfigurationChange(testRunner: OEUnitTestRunner, context: vscode.ExtensionContext): void {
    if (configChangeTimeout) {
        clearTimeout(configChangeTimeout);
    }
    configChangeTimeout = setTimeout(async () => {
        console.log('[OEUnit] Configuration changed, restarting server...');
        vscode.window.showInformationMessage('OEUnit configuration changed, restarting server...');
        await restartServer(testRunner, context);
        configChangeTimeout = undefined;
    }, 5000);
}

export async function parseOpenEdgeProjectJson(workspaceFolder: string, extensionPath: string): Promise<ProjectConfig> {
    const projectJsonPath = path.join(workspaceFolder, 'openedge-project.json');

    if (!fs.existsSync(projectJsonPath)) {
        throw new Error(`openedge-project.json not found at: ${projectJsonPath}`);
    }

    try {
        const rawBytes = fs.readFileSync(projectJsonPath);

        // Check for UTF-16 BOM (not allowed - JSON must be UTF-8)
        if (rawBytes.length >= 2) {
            if ((rawBytes[0] === 0xFF && rawBytes[1] === 0xFE) ||
                (rawBytes[0] === 0xFE && rawBytes[1] === 0xFF)) {
                throw new Error('openedge-project.json is encoded as UTF-16. JSON files must be UTF-8 encoded per RFC 8259. Please save the file with UTF-8 encoding.');
            }
        }

        const fileContent = rawBytes.toString('utf-8');

        // Check for UTF-8 BOM (U+FEFF) which is not allowed in JSON per RFC 8259
        if (fileContent.charCodeAt(0) === 0xFEFF) {
            throw new Error('openedge-project.json contains a UTF-8 BOM (Byte Order Mark) which is not allowed in JSON files per RFC 8259. Please save the file without BOM encoding.');
        }

        let projectJson: any;
        try {
            projectJson = JSON.parse(fileContent);
        } catch (parseError) {
            throw new Error(`Invalid JSON in openedge-project.json: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
        }

        const oeVersion = projectJson.oeversion;
        if (!oeVersion) {
            throw new Error('openedge-project.json is missing required field: "oeversion"');
        }

        const ablConfig = vscode.workspace.getConfiguration('abl');
        const runtimes = ablConfig.get<any[]>('configuration.runtimes', []);
        const runtime = runtimes.find((rt: any) => rt.name === oeVersion);

        if (!runtime || !runtime.path) {
            throw new Error(`DLC path not found for runtime '${oeVersion}'. Check abl.configuration.runtimes in settings.`);
        }

        const dlcPath = runtime.path;

        const propathEntries: string[] = [
            workspaceFolder,
            path.join(extensionPath, 'abl')
        ];

        if (projectJson.buildPath && Array.isArray(projectJson.buildPath)) {
            for (const entry of projectJson.buildPath) {
                const entryPath = entry.path || entry;
                const fullPath = path.isAbsolute(entryPath)
                    ? entryPath
                    : path.join(workspaceFolder, entryPath);
                propathEntries.push(fullPath);
            }
        }

        const propath = propathEntries.join(path.delimiter);

        const dbArgs: string[] = [];
        const dbAliasEnv: Record<string, string> = {};

        if (projectJson.dbConnections && Array.isArray(projectJson.dbConnections)) {
            for (const dbConn of projectJson.dbConnections) {
                if (dbConn.connect) {
                    const connectArgs = dbConn.connect.split(' ').filter((arg: string) => arg.trim() !== '');
                    dbArgs.push(...connectArgs);
                }
                if (dbConn.name && dbConn.aliases && Array.isArray(dbConn.aliases) && dbConn.aliases.length > 0) {
                    const envVarName = `OEUNIT_ALIAS_${dbConn.name.toUpperCase()}`;
                    dbAliasEnv[envVarName] = dbConn.aliases.join(',');
                }
            }
        }

        return { oeVersion, dlcPath, propath, dbArgs, dbAliasEnv };

    } catch (error) {
        if (error instanceof Error) { throw error; }
        throw new Error(`Error parsing openedge-project.json: ${String(error)}`);
    }
}

export async function startPersistentServer(
    testRunner: OEUnitTestRunner,
    context: vscode.ExtensionContext,
    isManual: boolean = false
): Promise<void> {
    const config = vscode.workspace.getConfiguration('oeunit');
    const autostart = config.get<boolean>('autostart', true);

    if (!autostart && !isManual) {
        console.log('[OEUnit] Autostart disabled, skipping automatic server startup');
        updateStatusBar('stopped');
        return;
    }

    const configuredWorkspace = config.get<string>('workspaceFolder');
    let workspaceFolder: string | undefined;
    if (configuredWorkspace) {
        workspaceFolder = configuredWorkspace;
        console.log('[OEUnit] Using configured workspace folder:', workspaceFolder);
    } else {
        workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        console.log('[OEUnit] Using first workspace folder:', workspaceFolder);
    }

    console.log('[OEUnit] Starting server initialization...');

    if (!workspaceFolder) {
        console.log('[OEUnit] No workspace folder, skipping server startup');
        return;
    }

    const execName = config.get<string>('exec');
    const oeArgs = config.get<string>('oeargs');
    const port = config.get<number>('port') || 5555;
    const timeout = config.get<number>('timeout') || 60;
    const loglevel = config.get<string>('loglevel') || 'error';
    const customEnvVars = config.get<Record<string, string>>('environmentVariables', {});

    console.log('[OEUnit] Configuration values:');
    console.log('  - oeunit.exec:', execName || '(empty)');
    console.log('  - oeunit.oeargs:', oeArgs ? `${oeArgs.substring(0, 50)}...` : '(empty)');
    console.log('  - oeunit.port:', port);
    console.log('  - oeunit.timeout:', timeout);
    console.log('  - oeunit.loglevel:', loglevel);

    let projectConfig: ProjectConfig;
    try {
        projectConfig = await parseOpenEdgeProjectJson(workspaceFolder, context.extensionPath);
        console.log('[OEUnit] Successfully parsed openedge-project.json');
        console.log('  - OE Version:', projectConfig.oeVersion);
        console.log('  - DLC Path:', projectConfig.dlcPath);
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[OEUnit] Error parsing openedge-project.json:', errorMsg);
        serverOutputChannel.appendLine(`\n[ERROR] Failed to parse openedge-project.json: ${errorMsg}`);
        serverOutputChannel.show(true);
        updateStatusBar('error');

        if (errorMsg.includes('not found')) {
            vscode.window.showErrorMessage(`OEUnit server cannot start. ${errorMsg}`);
        } else if (errorMsg.includes('DLC path not found')) {
            vscode.window.showErrorMessage(`OEUnit server cannot start. ${errorMsg}`, 'Open Settings').then(selection => {
                if (selection === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'abl.configuration.runtimes');
                }
            });
        } else if (errorMsg.includes('Invalid JSON')) {
            vscode.window.showErrorMessage(`OEUnit server cannot start. ${errorMsg}`, 'Open File').then(selection => {
                if (selection === 'Open File') {
                    const projectJsonPath = path.join(workspaceFolder!, 'openedge-project.json');
                    vscode.workspace.openTextDocument(projectJsonPath).then(doc => {
                        vscode.window.showTextDocument(doc);
                    });
                }
            });
        } else {
            vscode.window.showErrorMessage(`OEUnit server cannot start. ${errorMsg}`);
        }
        return;
    }

    if (!execName || !oeArgs) {
        const missing = [];
        if (!execName) { missing.push('oeunit.exec'); }
        if (!oeArgs) { missing.push('oeunit.oeargs'); }
        const errorMsg = `OEUnit server cannot start. Missing configuration: ${missing.join(', ')}`;
        console.log('[OEUnit] Missing required configuration:', missing.join(', '));
        serverOutputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
        serverOutputChannel.show(true);
        updateStatusBar('error');
        vscode.window.showErrorMessage(errorMsg, 'Open Settings').then(selection => {
            if (selection === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'oeunit');
            }
        });
        return;
    }

    try {
        const extensionVersion = context.extension.packageJSON.version;
        serverOutputChannel.appendLine('\n' + '='.repeat(80));
        serverOutputChannel.appendLine(`Starting OEUnit Server (Extension v${extensionVersion})...`);
        serverOutputChannel.appendLine('='.repeat(80));
        serverOutputChannel.show();
        serverManager = new OEUnitServerManager(serverOutputChannel, port, timeout);

        const started = await serverManager.startServer(
            projectConfig.dlcPath,
            execName,
            oeArgs,
            workspaceFolder,
            projectConfig.propath,
            projectConfig.dbArgs,
            projectConfig.dbAliasEnv,
            loglevel,
            customEnvVars
        );

        if (started) {
            testRunner.setServerManager(serverManager);
            updateStatusBar('running');
            vscode.window.showInformationMessage('OEUnit persistent server started successfully');
            console.log('[OEUnit] Persistent server started successfully');
        } else {
            updateStatusBar('error');
            serverOutputChannel.appendLine('\n[ERROR] Server failed to start. Check the output above for details.');
            serverOutputChannel.show(true);
            vscode.window.showErrorMessage('OEUnit server failed to start. Check OEUnit Server output for details.', 'Show Output').then(selection => {
                if (selection === 'Show Output') { serverOutputChannel.show(true); }
            });
        }
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[OEUnit] Error starting server:', error);
        serverOutputChannel.appendLine(`\n[ERROR] Server startup failed: ${errorMsg}`);
        serverOutputChannel.show(true);
        updateStatusBar('error');
        vscode.window.showErrorMessage(`OEUnit server startup error: ${errorMsg}`, 'Show Output').then(selection => {
            if (selection === 'Show Output') { serverOutputChannel.show(true); }
        });
    }
}

export async function startServer(runner: OEUnitTestRunner, context: vscode.ExtensionContext): Promise<void> {
    if (serverManager && serverManager.isServerRunning()) {
        vscode.window.showInformationMessage('OEUnit server is already running');
        return;
    }
    updateStatusBar('starting');
    await startPersistentServer(runner, context, true);
}

export async function stopServer(runner: OEUnitTestRunner): Promise<void> {
    if (!serverManager || !serverManager.isServerRunning()) {
        vscode.window.showInformationMessage('OEUnit server is not running');
        updateStatusBar('stopped');
        return;
    }
    updateStatusBar('stopping');
    await serverManager.stopServer();
    runner.setServerManager(null);
    serverManager = null;
    updateStatusBar('stopped');
    vscode.window.showInformationMessage('OEUnit server stopped');
    console.log('[OEUnit] Server stopped');
}

export async function restartServer(runner: OEUnitTestRunner, context: vscode.ExtensionContext): Promise<void> {
    console.log('[OEUnit] Restarting server...');
    if (serverManager && serverManager.isServerRunning()) {
        await stopServer(runner);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    await startPersistentServer(runner, context, true);
}

export async function pingServer(): Promise<void> {
    if (!serverManager) {
        vscode.window.showWarningMessage('OEUnit server manager not initialized');
        return;
    }
    if (!serverManager.isServerRunning()) {
        vscode.window.showWarningMessage('OEUnit server is not running');
        return;
    }
    try {
        console.log('[OEUnit] Pinging server...');
        const isHealthy = await serverManager.checkServerHealth();
        if (isHealthy) {
            vscode.window.showInformationMessage('OEUnit server responded: PONG ✓');
            console.log('[OEUnit] Server ping successful: PONG');
        } else {
            vscode.window.showWarningMessage('OEUnit server did not respond to PING');
            console.log('[OEUnit] Server ping failed');
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`OEUnit server ping failed: ${error.message}`);
        console.error('[OEUnit] Server ping error:', error);
    }
}

export function updateStatusBar(state: 'starting' | 'running' | 'stopping' | 'stopped' | 'error'): void {
    switch (state) {
        case 'starting':
            statusBarItem.text = '$(loading~spin) OEUnit: Starting...';
            statusBarItem.backgroundColor = undefined;
            break;
        case 'running':
            statusBarItem.text = '$(check) OEUnit: Running';
            statusBarItem.backgroundColor = undefined;
            break;
        case 'stopping':
            statusBarItem.text = '$(loading~spin) OEUnit: Stopping...';
            statusBarItem.backgroundColor = undefined;
            break;
        case 'stopped':
            statusBarItem.text = '$(circle-slash) OEUnit: Stopped';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            break;
        case 'error':
            statusBarItem.text = '$(error) OEUnit: Error';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            break;
    }
}
