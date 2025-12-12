import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { OEUnitTestRunner } from './testRunner';
import { OEUnitServerManager } from './serverManager';

let serverManager: OEUnitServerManager | null = null;
let testRunner: OEUnitTestRunner;
let statusBarItem: vscode.StatusBarItem;
let serverOutputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
    console.log('OEUnit Test Explorer extension is now active');

    // Diagnostic: Check if settings can be read at all
    const testConfig = vscode.workspace.getConfiguration();
    console.log('[OEUnit] All workspace settings:', JSON.stringify(testConfig, null, 2));
    console.log('[OEUnit] oeunit section:', testConfig.get('oeunit'));

    const controller = vscode.tests.createTestController('oeunitTests', 'OEUnit Tests');
    context.subscriptions.push(controller);

    testRunner = new OEUnitTestRunner();
    testRunner.setExtensionVersion(context.extension.packageJSON.version);
    
    // Create output channel once and reuse it
    serverOutputChannel = vscode.window.createOutputChannel('OEUnit Server');
    context.subscriptions.push(serverOutputChannel);
    
    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'oeunit.restartServer';
    statusBarItem.tooltip = 'Click to restart OEUnit server';
    context.subscriptions.push(statusBarItem);
    updateStatusBar('starting');
    statusBarItem.show();
    
    // Initialize and start the persistent test server
    startPersistentServer(testRunner, context);
    
    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.restartServer', async () => {
            await restartServer(testRunner, context);
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.stopServer', async () => {
            await stopServer();
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.startServer', async () => {
            await startServer(testRunner, context);
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.pingServer', async () => {
            await pingServer();
        })
    );
    
    // Watch for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('oeunit')) {
                console.log('[OEUnit] Configuration changed, restarting server...');
                vscode.window.showInformationMessage('OEUnit configuration changed, restarting server...');
                await restartServer(testRunner, context);
            }
        })
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.cls');
    context.subscriptions.push(watcher);
    
    watcher.onDidChange(uri => {
        if (uri.path.includes('/test/')) {
            discoverTests(controller);
        }
    });
    
    watcher.onDidCreate(uri => {
        if (uri.path.includes('/test/')) {
            discoverTests(controller);
        }
    });
    
    watcher.onDidDelete(uri => {
        if (uri.path.includes('/test/')) {
            discoverTests(controller);
        }
    });

    controller.refreshHandler = async () => {
        await discoverTests(controller);
    };

    controller.createRunProfile(
        'Run Tests',
        vscode.TestRunProfileKind.Run,
        async (request, token) => {
            console.log('[OEUnit] Run handler triggered');
            const run = controller.createTestRun(request);
            const queue: vscode.TestItem[] = [];

            if (request.include) {
                console.log('[OEUnit] request.include has', request.include.length, 'items');
                request.include.forEach(test => {
                    console.log('[OEUnit] Test item:', test.id, 'hasURI:', !!test.uri, 'children:', test.children.size);
                    queue.push(test);
                });
            } else {
                controller.items.forEach(test => collectTests(test, queue));
            }
            
            console.log('[OEUnit] Queue has', queue.length, 'tests');

            for (const test of queue) {
                console.log('[OEUnit] Processing test:', test.id);
                
                if (token.isCancellationRequested) {
                    run.skipped(test);
                    continue;
                }

                // Handle folders - collect all child tests
                if (!test.uri) {
                    console.log('[OEUnit] Folder detected - collecting children');
                    const childQueue: vscode.TestItem[] = [];
                    collectTests(test, childQueue);
                    // Sort by file path to ensure consistent order
                    childQueue.sort((a, b) => (a.uri?.fsPath || '').localeCompare(b.uri?.fsPath || ''));
                    for (const childTest of childQueue) {
                        if (childTest.uri && childTest.uri.fsPath.endsWith('.cls')) {
                            console.log('[OEUnit] Running child test file:', childTest.uri.fsPath);
                            run.started(childTest);
                            try {
                                await testRunner.runTestFile(childTest.uri.fsPath, run, childTest);
                            } catch (error) {
                                console.error('[OEUnit] Error running test:', error);
                                run.failed(childTest, new vscode.TestMessage(`Error: ${error}`));
                            }
                        }
                    }
                    continue;
                }

                // For test methods (children with no children of their own), run the parent file
                if (test.children.size === 0 && test.parent && test.parent.uri) {
                    console.log('[OEUnit] Running test method, parent file:', test.parent.uri.fsPath);
                    run.started(test);
                    try {
                        await testRunner.runTestFile(test.parent.uri.fsPath, run, test.parent);
                    } catch (error) {
                        console.error('[OEUnit] Error running test:', error);
                        run.failed(test, new vscode.TestMessage(`Error: ${error}`));
                    }
                    continue;
                }

                // For test files (items with children)
                if (test.uri.fsPath.endsWith('.cls')) {
                    console.log('[OEUnit] Running test file:', test.uri.fsPath);
                    run.started(test);
                    try {
                        await testRunner.runTestFile(test.uri.fsPath, run, test);
                    } catch (error) {
                        console.error('[OEUnit] Error running test:', error);
                        run.failed(test, new vscode.TestMessage(`Error: ${error}`));
                    }
                } else {
                    console.log('[OEUnit] Skipping - not a .cls file');
                }
            }

            run.end();
        },
        true
    );

    discoverTests(controller);
}

function collectTests(item: vscode.TestItem, queue: vscode.TestItem[]): void {
    if (item.uri && item.uri.fsPath.endsWith('.cls')) {
        queue.push(item);
        // Don't recurse into children if this is a test file - we already have it
        return;
    }
    // Recursively collect from children (folders first, then files within)
    item.children.forEach(child => collectTests(child, queue));
}

async function discoverTests(controller: vscode.TestController) {
    const config = vscode.workspace.getConfiguration('oeunit');
    const testPattern = config.get<string>('testFilePattern', '**/test/**/*.cls');

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return;
    }

    controller.items.replace([]);

    for (const folder of workspaceFolders) {
        const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, testPattern),
            '**/node_modules/**'
        );

        for (const file of files) {
            await addTestFile(controller, file, folder.uri.fsPath);
        }
    }
}

async function addTestFile(controller: vscode.TestController, fileUri: vscode.Uri, workspaceRoot: string) {
    const filePath = fileUri.fsPath;
    
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const testMethods = extractTestMethods(content);

        if (testMethods.length === 0) {
            return;
        }

        const relativePath = path.relative(workspaceRoot, filePath);
        const pathParts = relativePath.split(path.sep);
        
        let currentItems = controller.items;
        let currentPath = workspaceRoot;
        
        for (let i = 0; i < pathParts.length - 1; i++) {
            const folderName = pathParts[i];
            currentPath = path.join(currentPath, folderName);
            const folderId = currentPath;
            
            let folderItem = currentItems.get(folderId);
            
            if (!folderItem) {
                folderItem = controller.createTestItem(folderId, folderName);
                folderItem.canResolveChildren = false;
                currentItems.add(folderItem);
            }
            
            currentItems = folderItem.children;
        }

        const fileName = pathParts[pathParts.length - 1];
        const fileItem = controller.createTestItem(filePath, fileName, fileUri);
        currentItems.add(fileItem);

        for (const method of testMethods) {
            const methodId = `${filePath}::${method.name}`;
            const methodItem = controller.createTestItem(methodId, method.name, fileUri);
            
            methodItem.range = new vscode.Range(
                new vscode.Position(method.line, 0),
                new vscode.Position(method.line, 0)
            );
            
            fileItem.children.add(methodItem);
        }

    } catch (error) {
        console.error(`Error parsing test file ${filePath}:`, error);
    }
}

interface TestMethod {
    name: string;
    line: number;
}

function extractTestMethods(content: string): TestMethod[] {
    const methods: TestMethod[] = [];
    const lines = content.split('\n');
    
    let isTestAnnotated = false;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        if (line.toLowerCase().includes('@test')) {
            isTestAnnotated = true;
            continue;
        }
        
        const methodMatch = line.match(/METHOD\s+(?:PUBLIC|PRIVATE|PROTECTED)?\s+(?:VOID|[\w]+)\s+(test\w+)\s*\(/i);
        
        if (methodMatch) {
            methods.push({
                name: methodMatch[1],
                line: i
            });
            isTestAnnotated = false;
        } else if (isTestAnnotated) {
            const altMethodMatch = line.match(/METHOD\s+(?:PUBLIC|PRIVATE|PROTECTED)?\s+(?:VOID|[\w]+)\s+([\w]+)\s*\(/i);
            if (altMethodMatch) {
                methods.push({
                    name: altMethodMatch[1],
                    line: i
                });
                isTestAnnotated = false;
            }
        }
    }
    
    return methods;
}

async function startPersistentServer(testRunner: OEUnitTestRunner, context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('oeunit');
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

    // Get all required configuration
    const oeunitHome = config.get<string>('home');
    const oeunitRunner = config.get<string>('runner');
    const execName = config.get<string>('exec');
    const oeArgs = config.get<string>('oeargs');
    const port = config.get<number>('port') || 5555;
    const loglevel = config.get<string>('loglevel') || 'error';

    console.log('[OEUnit] Configuration values:');
    console.log('  - oeunit.home:', oeunitHome || '(empty)');
    console.log('  - oeunit.runner:', oeunitRunner || '(empty)');
    console.log('  - oeunit.exec:', execName || '(empty)');
    console.log('  - oeunit.oeargs:', oeArgs ? `${oeArgs.substring(0, 50)}...` : '(empty)');
    console.log('  - oeunit.port:', port);
    console.log('  - oeunit.loglevel:', loglevel);

    if (!oeunitHome || !oeunitRunner || !execName || !oeArgs) {
        const missing = [];
        if (!oeunitHome) missing.push('oeunit.home');
        if (!oeunitRunner) missing.push('oeunit.runner');
        if (!execName) missing.push('oeunit.exec');
        if (!oeArgs) missing.push('oeunit.oeargs');
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
        // Get DLC path
        const projectJsonPath = path.join(workspaceFolder, 'openedge-project.json');
        if (!fs.existsSync(projectJsonPath)) {
            const errorMsg = `OEUnit server cannot start. File not found: ${projectJsonPath}`;
            console.log('[OEUnit] openedge-project.json not found, skipping server startup');
            serverOutputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
            serverOutputChannel.show(true);
            updateStatusBar('error');
            vscode.window.showErrorMessage(errorMsg);
            return;
        }

        const projectJson = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
        const oeVersion = projectJson.oeversion;
        
        const ablConfig = vscode.workspace.getConfiguration('abl');
        const runtimes = ablConfig.get<any[]>('configuration.runtimes', []);
        const runtime = runtimes.find((rt: any) => rt.name === oeVersion);
        
        if (!runtime || !runtime.path) {
            const errorMsg = `OEUnit server cannot start. DLC path not found for runtime '${oeVersion}'. Check abl.configuration.runtimes in settings.`;
            console.log('[OEUnit] DLC path not found, skipping server startup');
            serverOutputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
            serverOutputChannel.show(true);
            updateStatusBar('error');
            vscode.window.showErrorMessage(errorMsg, 'Open Settings').then(selection => {
                if (selection === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'abl.configuration.runtimes');
                }
            });
            return;
        }

        const dlcPath = runtime.path;

        // Build PROPATH
        const extensionPath = context.extensionPath;
        const propathEntries: string[] = [
            oeunitHome,
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

        // Get database connections
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
                    const aliasesValue = dbConn.aliases.join(',');
                    dbAliasEnv[envVarName] = aliasesValue;
                }
            }
        }

        // Create and start server (reuse existing output channel)
        const extensionVersion = context.extension.packageJSON.version;
        serverOutputChannel.appendLine('\n' + '='.repeat(80));
        serverOutputChannel.appendLine(`Starting OEUnit Server (Extension v${extensionVersion})...`);
        serverOutputChannel.appendLine('='.repeat(80));
        serverOutputChannel.show();
        serverManager = new OEUnitServerManager(serverOutputChannel, port);

        const started = await serverManager.startServer(
            dlcPath,
            execName,
            oeArgs,
            oeunitHome,
            oeunitRunner,
            workspaceFolder,
            propath,
            dbArgs,
            dbAliasEnv,
            loglevel
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
                if (selection === 'Show Output') {
                    serverOutputChannel.show(true);
                }
            });
        }

    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[OEUnit] Error starting server:', error);
        serverOutputChannel.appendLine(`\n[ERROR] Server startup failed: ${errorMsg}`);
        serverOutputChannel.show(true);
        updateStatusBar('error');
        vscode.window.showErrorMessage(`OEUnit server startup error: ${errorMsg}`, 'Show Output').then(selection => {
            if (selection === 'Show Output') {
                serverOutputChannel.show(true);
            }
        });
    }
}

async function startServer(runner: OEUnitTestRunner, context: vscode.ExtensionContext): Promise<void> {
    if (serverManager && serverManager.isServerRunning()) {
        vscode.window.showInformationMessage('OEUnit server is already running');
        return;
    }
    
    updateStatusBar('starting');
    await startPersistentServer(runner, context);
}

async function stopServer(): Promise<void> {
    if (!serverManager || !serverManager.isServerRunning()) {
        vscode.window.showInformationMessage('OEUnit server is not running');
        updateStatusBar('stopped');
        return;
    }
    
    updateStatusBar('stopping');
    await serverManager.stopServer();
    testRunner.setServerManager(null);
    updateStatusBar('stopped');
    vscode.window.showInformationMessage('OEUnit server stopped');
    console.log('[OEUnit] Server stopped');
}

async function restartServer(runner: OEUnitTestRunner, context: vscode.ExtensionContext): Promise<void> {
    console.log('[OEUnit] Restarting server...');
    
    if (serverManager && serverManager.isServerRunning()) {
        await stopServer();
        // Wait a moment before restarting
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    await startServer(runner, context);
}

async function pingServer(): Promise<void> {
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
        const response = await serverManager.sendRequest('PING');
        
        if (response === 'PONG') {
            vscode.window.showInformationMessage('OEUnit server responded: PONG ✓');
            console.log('[OEUnit] Server ping successful: PONG');
        } else {
            vscode.window.showWarningMessage(`OEUnit server unexpected response: ${response}`);
            console.log('[OEUnit] Server ping unexpected response:', response);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`OEUnit server ping failed: ${error.message}`);
        console.error('[OEUnit] Server ping error:', error);
    }
}

function updateStatusBar(state: 'starting' | 'running' | 'stopping' | 'stopped' | 'error'): void {
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

export async function deactivate() {
    if (serverManager) {
        await serverManager.stopServer();
        serverManager = null;
    }
}
