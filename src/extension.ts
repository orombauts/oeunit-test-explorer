import * as vscode from 'vscode';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, delimiter, extname, isAbsolute, join, normalize, relative, sep } from 'path';
import { createServer } from 'net';
import { OEUnitTestRunner } from './testRunner';
import { OEUnitServerManager } from './serverManager';
import { ProjectDiscovery, ProjectContext } from './projectDiscovery';
import { isAbstractClass, extractAllTestMethods } from './classParser';
import { stripJsonComments } from './utils';

// --- Multi-project state ---
// serverManagers holds one OEUnitServerManager per project, keyed by ProjectContext.id
// (the absolute filesystem path of the project folder).  A single manager per
// project keeps each ABL server process isolated so projects can run concurrently
// on different ports.
const serverManagers = new Map<string, OEUnitServerManager>();

// serverStarting is a guard set that prevents a second startup attempt from
// beginning while one is already in progress for the same project (e.g. when
// onDidChangeContexts fires multiple times in quick succession at startup).
const serverStarting = new Set<string>();

let testRunner: OEUnitTestRunner;
let statusBarItem: vscode.StatusBarItem;
let serverOutputChannel: vscode.OutputChannel;
let projectDiscovery: ProjectDiscovery;

// testItemProjects maps every VS Code TestItem id (folder, file, or method)
// back to the ProjectContext.id it belongs to.  This lets the run handler
// look up the correct server manager for any item the user selects, including
// items that don't carry a URI (project- and folder-level nodes).
const testItemProjects = new Map<string, string>();

let configChangeTimeout: NodeJS.Timeout | undefined;

// Cache of the most recent test run result per file path (absolute).
// Populated by both LM-tool invocations and Test Explorer runs so that
// oeunit_getLastResults and oeunit.exportResults work regardless of how
// the tests were triggered.
const lastRunResults = new Map<string, any>();

/**
 * Returns true when the given TCP port is not bound on 127.0.0.1.
 * Uses a brief listen attempt so the check works regardless of OS firewall rules.
 */
function isPortFree(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const server = createServer();
        server.unref();
        server.on('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => {
            server.close(() => resolve(true));
        });
    });
}

/**
 * Scans ports starting at `fromPort` up to `portEnd` (inclusive) and returns
 * the first port that is (a) not already claimed by a running serverManager
 * and (b) not bound on the loopback interface.  Returns undefined when the
 * entire range is exhausted.
 */
async function findAvailablePort(
    fromPort: number,
    portEnd: number,
    claimedPorts: Set<number>
): Promise<number | undefined> {
    for (let p = fromPort; p <= portEnd; p++) {
        if (claimedPorts.has(p)) { continue; }
        if (await isPortFree(p)) { return p; }
    }
    return undefined;
}

/**
 * Core test-run logic shared by the command handler and the LM tools.
 * Resolves the project from the file path, checks the server, and calls runTest.
 */
async function execRunTest(
    testFile: string,
    testMethod?: string,
    projectId?: string
): Promise<any> {
    const normalizedFile = testFile.toLowerCase();
    let resolvedProjectId: string | undefined = projectId;
    if (!resolvedProjectId) {
        const contexts = projectDiscovery ? projectDiscovery.getContexts() : [];
        for (const ctx of contexts) {
            if (normalizedFile.startsWith(ctx.rootUri.fsPath.toLowerCase())) {
                resolvedProjectId = ctx.id;
                break;
            }
        }
    }
    if (!resolvedProjectId) {
        return { Status: 'ERROR', Reply: `Could not determine project for file: ${testFile}` };
    }
    const manager = serverManagers.get(resolvedProjectId);
    if (!manager || !manager.isServerRunning()) {
        return { Status: 'ERROR', Reply: `OEUnit server is not running for project ${basename(resolvedProjectId)}. Start it first with "OEUnit: Start Server".` };
    }
    const config = vscode.workspace.getConfiguration('oeunit', vscode.Uri.file(resolvedProjectId));
    const logLevel = config.get<string>('loglevel') ?? 'error';
    try {
        const result = await manager.runTest(testFile, testMethod, logLevel);
        if (result.Status === 'COMPLETED') {
            lastRunResults.set(testFile, result);
        }
        return result;
    } catch (error: any) {
        return { Status: 'ERROR', Reply: `Test execution failed: ${error.message || String(error)}` };
    }
}

/**
 * Discovers all OEUnit test files (.cls with @Test methods) under the given
 * folder and runs each sequentially, returning aggregated results.
 */
async function execRunFolder(folder: string): Promise<any> {
    const folderUri = vscode.Uri.file(folder);
    const contexts = projectDiscovery ? projectDiscovery.getContexts() : [];
    const projectCtx = contexts.find(ctx =>
        folder.toLowerCase().startsWith(ctx.rootUri.fsPath.toLowerCase())
    );
    if (!projectCtx) {
        return { Status: 'ERROR', Reply: `Could not determine project for folder: ${folder}` };
    }
    const manager = serverManagers.get(projectCtx.id);
    if (!manager || !manager.isServerRunning()) {
        return { Status: 'ERROR', Reply: `OEUnit server is not running for project ${basename(projectCtx.id)}. Start it first with "OEUnit: Start Server".` };
    }

    // Build a per-project classFileMap for INHERITS resolution (same as discoverTests)
    const projectClassFileMap = new Map<string, string>();
    const allCls = await vscode.workspace.findFiles(
        new vscode.RelativePattern(projectCtx.rootUri, '**/*.cls'),
        '**/node_modules/**'
    );
    for (const f of allCls) {
        projectClassFileMap.set(f.fsPath.replace(/\\/g, '/').toLowerCase(), f.fsPath);
    }

    // Find .cls files strictly under the given folder
    const clsFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folderUri, '**/*.cls'),
        '**/node_modules/**'
    );

    // Filter to files that actually contain test methods
    const testFiles: vscode.Uri[] = [];
    for (const file of clsFiles) {
        try {
            const content = readFileSync(file.fsPath, 'utf-8');
            if (!isAbstractClass(content) && extractAllTestMethods(content, file, projectClassFileMap).length > 0) {
                testFiles.push(file);
            }
        } catch { /* skip unreadable files */ }
    }

    if (testFiles.length === 0) {
        return { Status: 'COMPLETED', Summary: { Total: 0, Failures: 0, Errors: 0, Skipped: 0, DurationMs: 0 }, Files: [] };
    }

    const fileResults: any[] = [];
    let totTotal = 0, totFailures = 0, totErrors = 0, totSkipped = 0, totDuration = 0;

    for (const file of testFiles) {
        const response = await execRunTest(file.fsPath, undefined, projectCtx.id);
        if (response.Status === 'COMPLETED' && response.Summary) {
            totTotal    += response.Summary.Total    ?? 0;
            totFailures += response.Summary.Failures ?? 0;
            totErrors   += response.Summary.Errors   ?? 0;
            totSkipped  += response.Summary.Skipped  ?? 0;
            totDuration += response.Summary.DurationMs ?? 0;
        }
        fileResults.push({ File: basename(file.fsPath), FilePath: file.fsPath, ...response });
    }

    return {
        Status: 'COMPLETED',
        Summary: { Total: totTotal, Failures: totFailures, Errors: totErrors, Skipped: totSkipped, DurationMs: totDuration },
        Files: fileResults
    };
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('OEUnit Test Explorer extension is now active');

    const controller = vscode.tests.createTestController('oeunitTests', 'OEUnit Tests');
    context.subscriptions.push(controller);

    // ProjectDiscovery is responsible for building the list of project contexts
    // (one per workspace folder that contains an openedge-project.json).  It
    // fires onDidChangeContexts whenever the list changes — that single event is
    // the central trigger for both test discovery and server startup.
    projectDiscovery = new ProjectDiscovery();
    await projectDiscovery.refresh();

    const contextsSubscription = projectDiscovery.onDidChangeContexts(async () => {
        console.log('[OEUnit] Project contexts changed, triggering test rediscovery');
        discoverTests(controller);
        for (const projectContext of projectDiscovery.getContexts()) {
            const alreadyRunning = serverManagers.get(projectContext.id)?.isServerRunning();
            const alreadyStarting = serverStarting.has(projectContext.id);
            if (!alreadyRunning && !alreadyStarting) {
                await startPersistentServer(testRunner, context, false, projectContext);
            }
        }
    });
    context.subscriptions.push(contextsSubscription);

    testRunner = new OEUnitTestRunner();
    testRunner.setExtensionVersion(context.extension.packageJSON.version);
    testRunner.setOnRunComplete((filePath, result) => lastRunResults.set(filePath, result));
    
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
    
    // Start the persistent ABL server(s) on activation.
    // In multi-project mode one server is started per discovered project context;
    // in single-project mode a single server is started for the configured
    // (or first) workspace folder.  The isManual flag is false so that the
    // oeunit.autostart setting is respected.
    for (const projectContext of projectDiscovery.getContexts()) {
        await startPersistentServer(testRunner, context, false, projectContext);
    }
    
    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.restartServer', async () => {
            const ctx = await pickProjectContext('Restart Server');
            if (ctx) {
                await restartServer(testRunner, context, ctx);
            }
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.stopServer', async () => {
            const ctx = await pickProjectContext('Stop Server');
            if (ctx) {
                await stopServer(ctx);
            }
        })
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.startServer', async () => {
            const ctx = await pickProjectContext('Start Server');
            if (ctx) {
                await startServer(testRunner, context, ctx);
            }
        })
    );

    // Internal command: starts the server for the project identified by `projectId`
    // without showing a project picker. Used by testRunner.ts when the server
    // is not yet running and the project is already known from the test file path.
    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.startServerForProject', async (projectId: string) => {
            const ctx = projectDiscovery?.getContexts().find(c => c.id === projectId);
            if (ctx) {
                await startServer(testRunner, context, ctx);
            } else {
                vscode.window.showWarningMessage(`OEUnit: No project found for id "${basename(projectId)}".`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.pingServer', async () => {
            const ctx = await pickProjectContext('Ping Server');
            if (ctx) {
                await pingServer(ctx);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.killServer', async () => {
            const ctx = await pickProjectContext('Kill Server');
            if (!ctx) { return; }
            const manager = serverManagers.get(ctx.id);
            if (!manager) {
                vscode.window.showWarningMessage(`OEUnit: No server running for project ${basename(ctx.id)}`);
                return;
            }
            manager.killServer();
            testRunner.setServerManager(ctx.id, null);
            serverManagers.delete(ctx.id);
            updateStatusBar('stopped');
            vscode.window.showInformationMessage(`OEUnit: Server force-killed for ${basename(ctx.id)}`);
        })
    );

    // Bulk server commands — multi-project mode only.
    // Each iterates over all known project contexts and delegates to the same
    // start/stop/restart helpers used by the single-project commands, so error
    // handling and status bar updates are consistent.
    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.startAllServers', async () => {
            const contexts = projectDiscovery.getContexts();
            if (contexts.length === 0) {
                vscode.window.showWarningMessage('No OEUnit project contexts found.');
                return;
            }
            for (const ctx of contexts) {
                await startServer(testRunner, context, ctx);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.stopAllServers', async () => {
            const contexts = projectDiscovery.getContexts();
            if (contexts.length === 0) {
                vscode.window.showWarningMessage('No OEUnit project contexts found.');
                return;
            }
            for (const ctx of contexts) {
                await stopServer(ctx);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.restartAllServers', async () => {
            const contexts = projectDiscovery.getContexts();
            if (contexts.length === 0) {
                vscode.window.showWarningMessage('No OEUnit project contexts found.');
                return;
            }
            for (const ctx of contexts) {
                await restartServer(testRunner, context, ctx);
            }
        })
    );

    // Open a native folder-picker and append the selected path(s) to
    // oeunit.projectPaths so the user never has to type absolute paths manually.
    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.addProjectPath', async () => {
            const uris = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: true,
                openLabel: 'Add as OEUnit Project',
                title: 'Select Project Folder(s) — must contain openedge-project.json',
            });
            if (!uris || uris.length === 0) { return; }

            const cfg = vscode.workspace.getConfiguration('oeunit');
            const current = cfg.get<string[]>('projectPaths', []);
            const toAdd = uris
                .map(u => u.fsPath)
                .filter(p => !current.some(c =>
                    normalize(c).toLowerCase() === normalize(p).toLowerCase()
                ));

            if (toAdd.length === 0) {
                vscode.window.showInformationMessage('OEUnit: Selected folder(s) are already in the project list.');
                return;
            }

            await cfg.update('projectPaths', [...current, ...toAdd], vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage(`OEUnit: Added ${toAdd.length} project folder(s). Refreshing…`);
            await projectDiscovery.refresh();
        })
    );

    // oeunit.runTestFromChat — headless test execution for Copilot Chat / agents.
    // Accepts { testFile, testMethod?, projectId?, folder? } OR a plain string:
    //   - "path/to/Test.cls"             → run whole file
    //   - "path/to/Test.cls::MethodName" → run single method
    //   - "path/to/folder"               → run all test files in folder
    // Returns the raw TestResponse JSON so the caller can inspect results
    // programmatically without a VS Code TestRun UI.
    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.runTestFromChat', async (args?: { testFile?: string; testMethod?: string; projectId?: string; folder?: string } | string) => {
            // Normalise plain-string argument
            if (typeof args === 'string') {
                const sepIdx = args.indexOf('::');
                if (sepIdx !== -1) {
                    args = { testFile: args.slice(0, sepIdx), testMethod: args.slice(sepIdx + 2) };
                } else if (!args.toLowerCase().endsWith('.cls')) {
                    args = { folder: args };
                } else {
                    args = { testFile: args };
                }
            }
            if (!args) {
                return { Status: 'ERROR', Reply: 'Missing argument' };
            }
            if ('folder' in args && args.folder) {
                return await execRunFolder(normalize(args.folder));
            }
            if (!args.testFile) {
                return { Status: 'ERROR', Reply: 'Missing required argument: testFile or folder' };
            }
            return await execRunTest(normalize(args.testFile), args.testMethod, args.projectId);
        })
    );

    // Register language model tools so Copilot Chat can invoke them directly
    // without requiring the run_vscode_command indirection.
    context.subscriptions.push(
        vscode.lm.registerTool('oeunit_runTest', {
            async invoke(options: vscode.LanguageModelToolInvocationOptions<{ testFile: string; testMethod?: string }>, _token: vscode.CancellationToken) {
                const { testFile, testMethod } = options.input;
                const result = await execRunTest(normalize(testFile), testMethod);
                // Report results to the VS Code Test Results view.
                const testItem = findTestItemByFilePath(controller.items, normalize(testFile));
                if (testItem) {
                    reportRunResultToTestRun(controller, result, testItem, testMethod);
                }
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
                ]);
            }
        })
    );

    context.subscriptions.push(
        vscode.lm.registerTool('oeunit_getLastResults', {
            async invoke(options: vscode.LanguageModelToolInvocationOptions<{ file?: string }>, _token: vscode.CancellationToken) {
                const { file } = options.input ?? {};
                let data: any;
                if (file) {
                    const normalized = normalize(file);
                    data = lastRunResults.get(normalized)
                        ?? lastRunResults.get(normalized.toLowerCase())
                        ?? null;
                    if (!data) {
                        data = { Status: 'ERROR', Reply: `No cached results for file: ${file}` };
                    }
                } else {
                    if (lastRunResults.size === 0) {
                        data = { Status: 'ERROR', Reply: 'No test results cached yet. Run tests first.' };
                    } else {
                        const entries: Record<string, any> = {};
                        lastRunResults.forEach((result, filePath) => {
                            entries[filePath] = result;
                        });
                        data = entries;
                    }
                }
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify(data, null, 2))
                ]);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.exportResults', async () => {
            if (lastRunResults.size === 0) {
                vscode.window.showWarningMessage('OEUnit: No test results to export. Run tests first.');
                return;
            }
            const formatPick = await vscode.window.showQuickPick(
                [
                    { label: 'JUnit XML', description: 'Standard XML format — compatible with CI tools (Jenkins, Azure DevOps, GitHub Actions)', value: 'junit' as const },
                    { label: 'JSON', description: 'Raw result JSON — Copilot-friendly, easy to process programmatically', value: 'json' as const }
                ],
                { title: 'OEUnit: Export Results — choose format', placeHolder: 'Select export format' }
            );
            if (!formatPick) { return; }

            const defaultName = `oeunit-results.${formatPick.value === 'junit' ? 'xml' : 'json'}`;
            const defaultUri = vscode.workspace.workspaceFolders?.[0]
                ? vscode.Uri.file(join(vscode.workspace.workspaceFolders[0].uri.fsPath, defaultName))
                : undefined;

            const saveUri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: formatPick.value === 'junit'
                    ? { 'JUnit XML': ['xml'] }
                    : { 'JSON': ['json'] },
                saveLabel: 'Export'
            });
            if (!saveUri) { return; }

            const entries = Array.from(lastRunResults.entries()).map(([filePath, result]) => ({ filePath, result }));
            const content = formatPick.value === 'junit'
                ? buildJUnitXml(entries)
                : JSON.stringify(Object.fromEntries(lastRunResults), null, 2);

            try {
                writeFileSync(saveUri.fsPath, content, 'utf-8');
                vscode.window.showInformationMessage(`OEUnit: Results exported to ${saveUri.fsPath}`, 'Open File')
                    .then(sel => { if (sel === 'Open File') { vscode.commands.executeCommand('vscode.open', saveUri); } });
            } catch (err: any) {
                vscode.window.showErrorMessage(`OEUnit: Export failed — ${err.message || String(err)}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.lm.registerTool('oeunit_runFolder', {
            async invoke(options: vscode.LanguageModelToolInvocationOptions<{ folder: string }>, _token: vscode.CancellationToken) {
                const { folder } = options.input;
                const result = await execRunFolder(normalize(folder));
                // Report per-file results to the VS Code Test Results view.
                if (result.Files && Array.isArray(result.Files)) {
                    for (const fileResult of result.Files) {
                        if (fileResult.FilePath) {
                            const testItem = findTestItemByFilePath(controller.items, fileResult.FilePath);
                            if (testItem) {
                                reportRunResultToTestRun(controller, fileResult, testItem);
                            }
                        }
                    }
                }
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
                ]);
            }
        })
    );

    // Watch for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('oeunit')) {
                // projectPaths change: refresh discovery and start any newly added
                // project servers immediately (1 s debounce).
                if (e.affectsConfiguration('oeunit.projectPaths')) {
                    if (configChangeTimeout) { clearTimeout(configChangeTimeout); }
                    configChangeTimeout = setTimeout(async () => {
                        await projectDiscovery.refresh();
                        for (const ctx of projectDiscovery.getContexts()) {
                            const alreadyRunning = serverManagers.get(ctx.id)?.isServerRunning();
                            const alreadyStarting = serverStarting.has(ctx.id);
                            if (!alreadyRunning && !alreadyStarting) {
                                await startPersistentServer(testRunner, context, false, ctx);
                            }
                        }
                        configChangeTimeout = undefined;
                    }, 1000);
                    return;
                }
                // All other oeunit.* setting changes: debounce and restart all servers.
                if (configChangeTimeout) {
                    clearTimeout(configChangeTimeout);
                }
                configChangeTimeout = setTimeout(async () => {
                    console.log('[OEUnit] Configuration changed, restarting server...');
                    vscode.window.showInformationMessage('OEUnit configuration changed, restarting server...');
                    await projectDiscovery.refresh();
                    for (const ctx of projectDiscovery.getContexts()) {
                        await restartServer(testRunner, context, ctx);
                    }
                    configChangeTimeout = undefined;
                }, 5000);
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

    const projectWatcher = vscode.workspace.createFileSystemWatcher('**/openedge-project.json');
    context.subscriptions.push(projectWatcher);

    // Each handler only needs to call refresh(). The onDidChangeContexts event
    // fired by refresh() already triggers discoverTests(), so a second explicit
    // call here would cause a duplicate discovery pass.
    projectWatcher.onDidCreate(() => projectDiscovery.refresh());
    projectWatcher.onDidChange(() => projectDiscovery.refresh());
    projectWatcher.onDidDelete(() => projectDiscovery.refresh());

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
                        const projectId = resolveProjectIdForTestItem(childTest);
                        if (!projectId) {
                            console.warn('[OEUnit] Unable to resolve project for test item', childTest.id);
                            run.skipped(childTest);
                            continue;
                        }
                        if (childTest.uri && childTest.uri.fsPath.endsWith('.cls')) {
                            console.log('[OEUnit] Running child test file:', childTest.uri.fsPath);
                            run.started(childTest);
                            try {
                                await testRunner.runTestFile(childTest.uri.fsPath, run, childTest, projectId);
                            } catch (error) {
                                console.error('[OEUnit] Error running test:', error);
                                run.failed(childTest, new vscode.TestMessage(`Error: ${error}`));
                            }
                        }
                    }
                    continue;
                }

                // For test methods (children with no children of their own), run the parent file with method name
                if (test.children.size === 0 && test.parent && test.parent.uri) {
                    console.log('[OEUnit] Running test method:', test.label, 'parent file:', test.parent.uri.fsPath);
                    // Extract method name from test ID (format: "filePath::methodName")
                    const methodName = test.id.includes('::') ? test.id.split('::')[1] : test.label;
                    const projectId = resolveProjectIdForTestItem(test);
                    if (!projectId) {
                        console.warn('[OEUnit] Unable to resolve project for test method', test.id);
                        run.skipped(test);
                        continue;
                    }
                    run.started(test);
                    try {
                        await testRunner.runTestFile(test.parent.uri.fsPath, run, test, projectId, methodName);
                    } catch (error) {
                        console.error('[OEUnit] Error running test:', error);
                        run.failed(test, new vscode.TestMessage(`Error: ${error}`));
                    }
                    continue;
                }

                // For test files (items with children)
                if (test.uri.fsPath.endsWith('.cls')) {
                    console.log('[OEUnit] Running test file:', test.uri.fsPath);
                    const projectId = resolveProjectIdForTestItem(test);
                    if (!projectId) {
                        console.warn('[OEUnit] Unable to resolve project for test file', test.id);
                        run.skipped(test);
                        continue;
                    }
                    run.started(test);
                    try {
                        await testRunner.runTestFile(test.uri.fsPath, run, test, projectId);
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

/**
 * Recursively searches controller.items for a TestItem whose URI matches filePath.
 */
function findTestItemByFilePath(items: vscode.TestItemCollection, filePath: string): vscode.TestItem | undefined {
    const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
    let found: vscode.TestItem | undefined;
    items.forEach(item => {
        if (found) { return; }
        if (item.uri && item.uri.fsPath.replace(/\\/g, '/').toLowerCase() === normalizedPath) {
            found = item;
            return;
        }
        if (item.children.size > 0) {
            found = findTestItemByFilePath(item.children, filePath);
        }
    });
    return found;
}

/**
 * Builds a JUnit-compatible XML string from an array of {filePath, result} entries.
 * The output is accepted by Jenkins, Azure DevOps, GitHub Actions, and most CI tools.
 */
function buildJUnitXml(entries: Array<{ filePath: string; result: any }>): string {
    const esc = (s: string) => s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    let totalTests = 0, totalFailures = 0, totalErrors = 0, totalSkipped = 0, totalMs = 0;
    const suites: string[] = [];

    for (const { filePath, result } of entries) {
        if (!result.Summary || !result.TestCases) { continue; }
        const s = result.Summary;
        const className = esc(basename(filePath, extname(filePath)));
        const suiteName = esc(basename(filePath));
        const timeS = (s.DurationMs / 1000).toFixed(3);
        totalTests += s.Total; totalFailures += s.Failures;
        totalErrors += s.Errors; totalSkipped += s.Skipped; totalMs += s.DurationMs;

        const cases = result.TestCases.map((tc: any) => {
            const tcTime = (tc.DurationMs / 1000).toFixed(3);
            const name = esc(tc.Case);
            if (tc.Status === 'Passed') {
                return `    <testcase name="${name}" classname="${className}" time="${tcTime}"/>`;
            } else if (tc.Status === 'Failed') {
                const msg = esc(tc.Failure || 'Test failed');
                const body = tc.ErrorStack?.length ? esc(tc.ErrorStack.join('\n')) : msg;
                return `    <testcase name="${name}" classname="${className}" time="${tcTime}">\n      <failure message="${msg}">${body}</failure>\n    </testcase>`;
            } else if (tc.Status === 'Skipped') {
                return `    <testcase name="${name}" classname="${className}" time="${tcTime}">\n      <skipped/>\n    </testcase>`;
            }
            return `    <testcase name="${name}" classname="${className}" time="${tcTime}"/>`;
        }).join('\n');

        suites.push(`  <testsuite name="${suiteName}" tests="${s.Total}" failures="${s.Failures}" errors="${s.Errors}" skipped="${s.Skipped}" time="${timeS}">\n${cases}\n  </testsuite>`);
    }

    const totalTimeS = (totalMs / 1000).toFixed(3);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="OEUnit" tests="${totalTests}" failures="${totalFailures}" errors="${totalErrors}" skipped="${totalSkipped}" time="${totalTimeS}">\n${suites.join('\n')}\n</testsuites>\n`;
}

/**
 * Reports a single test case result to a TestRun.
 */
function reportTestCaseToRun(
    run: vscode.TestRun,
    item: vscode.TestItem,
    tc: { Status: string; Failure?: string; DurationMs?: number; ErrorStack?: string[] }
): void {
    switch (tc.Status) {
        case 'Passed':
            run.appendOutput(`  ✓ ${item.label} (${tc.DurationMs ?? 0}ms)\r\n`, undefined, item);
            run.passed(item, tc.DurationMs);
            break;
        case 'Failed': {
            const msg = tc.Failure || 'Test failed';
            run.appendOutput(`  ✗ ${item.label}: ${msg} (${tc.DurationMs ?? 0}ms)\r\n`, undefined, item);
            if (tc.ErrorStack && tc.ErrorStack.length > 0) {
                run.appendOutput(tc.ErrorStack.map(l => `    ${l}`).join('\r\n') + '\r\n', undefined, item);
            }
            run.failed(item, new vscode.TestMessage(msg), tc.DurationMs);
            break;
        }
        case 'Skipped':
            run.appendOutput(`  - ${item.label} (skipped, ${tc.DurationMs ?? 0}ms)\r\n`, undefined, item);
            run.skipped(item);
            break;
        default:
            run.appendOutput(`  ? ${item.label} (status: ${tc.Status})\r\n`, undefined, item);
            run.errored(item, new vscode.TestMessage(`Unexpected status: ${tc.Status}`), tc.DurationMs);
    }
}

/**
 * Creates a VS Code TestRun for a given TestItem and reports the JSON result
 * returned by execRunTest to it, so results appear in the Test Results view.
 * Safe to call even if the TestItem has no children yet.
 */
function reportRunResultToTestRun(
    controller: vscode.TestController,
    result: any,
    testItem: vscode.TestItem,
    methodName?: string
): void {
    // Build the include list: a specific method child if one was requested, otherwise the file item.
    const includeItems: vscode.TestItem[] = [];
    if (methodName) {
        testItem.children.forEach(c => {
            if (c.label === methodName || c.id.endsWith(`::${methodName}`)) {
                includeItems.push(c);
            }
        });
    }
    if (includeItems.length === 0) {
        includeItems.push(testItem);
    }

    const run = controller.createTestRun(new vscode.TestRunRequest(includeItems), undefined, true);
    try {
        if (result.Status === 'ERROR') {
            const msg = new vscode.TestMessage(result.Reply || 'Unknown error');
            includeItems.forEach(i => {
                run.appendOutput(`ERROR: ${result.Reply || 'Unknown error'}\r\n`, undefined, i);
                run.failed(i, msg);
            });
            return;
        }

        if (!result.TestCases || result.TestCases.length === 0) {
            includeItems.forEach(i => run.skipped(i));
            return;
        }

        // Report individual method items when the file TestItem has children.
        if (testItem.children.size > 0) {
            result.TestCases.forEach((tc: any) => {
                let childItem: vscode.TestItem | undefined;
                testItem.children.forEach(c => {
                    if (c.label === tc.Case || c.id.endsWith(`::${tc.Case}`)) {
                        childItem = c;
                    }
                });
                if (childItem) {
                    reportTestCaseToRun(run, childItem, tc);
                }
            });
            // Set the file-level state only when running all methods (not a single method).
            if (!methodName && result.Summary) {
                const passed = result.Summary.Total - result.Summary.Failures - result.Summary.Errors - result.Summary.Skipped;
                run.appendOutput(`${'─'.repeat(60)}\r\n`, undefined, testItem);
                run.appendOutput(`Total: ${result.Summary.Total}  Passed: ${passed}  Failed: ${result.Summary.Failures}  Errors: ${result.Summary.Errors}  Skipped: ${result.Summary.Skipped}  (${result.Summary.DurationMs}ms)\r\n`, undefined, testItem);
                if (result.Summary.Failures > 0 || result.Summary.Errors > 0) {
                    run.failed(testItem,
                        new vscode.TestMessage(`${result.Summary.Failures} failure(s), ${result.Summary.Errors} error(s)`),
                        result.Summary.DurationMs);
                } else {
                    run.passed(testItem, result.Summary.DurationMs);
                }
            }
        } else {
            // No children yet (discovery may not have run) — report on the item directly.
            const tc = result.TestCases.find((t: any) => !methodName || t.Case === methodName)
                ?? result.TestCases[0];
            reportTestCaseToRun(run, includeItems[0], tc);
        }
    } finally {
        run.end();
    }
}

/**
 * Rebuilds the entire VS Code test tree from scratch.
 *
 * In single-project mode the tree root contains folder and file nodes directly.
 * In multi-project mode a top-level project node (labelled with the folder name)
 * is inserted for each project context so users can distinguish tests that share
 * identical sub-folder structures across different OpenEdge versions or environments.
 *
 * All items are registered in testItemProjects so that the run handler can
 * resolve the correct server for any selected node, even folder-level nodes
 * that carry no URI.
 */
async function discoverTests(controller: vscode.TestController) {
    const contexts = projectDiscovery ? projectDiscovery.getContexts() : [];

    if (!contexts || contexts.length === 0) {
        return;
    }

    controller.items.replace([]);
    testItemProjects.clear();

    // When multiple projects are present, nest each project's tests under a
    // top-level project node so users can distinguish identically named folders
    // across different projects. With a single project, files appear at the root.
    const useProjectNodes = contexts.length > 1;

    for (const projectContext of contexts) {
        // Read testFilePattern scoped to each project folder so individual
        // projects can override the glob (e.g. a non-standard test directory).
        const folderConfig = vscode.workspace.getConfiguration('oeunit', projectContext.rootUri);
        const testPattern = folderConfig.get<string>('testFilePattern', '**/test/**/*.cls');
        const pattern = new vscode.RelativePattern(projectContext.rootUri, testPattern);
        const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');

        // In multi-project mode, nest everything under a root node labelled with
        // the project folder name so users can tell projects apart when multiple
        // projects share identical sub-folder names.
        let rootItems: vscode.TestItemCollection;
        if (useProjectNodes) {
            const projectLabel = basename(projectContext.rootUri.fsPath);
            let projectItem = controller.items.get(projectContext.id);
            if (!projectItem) {
                projectItem = controller.createTestItem(projectContext.id, projectLabel);
                projectItem.canResolveChildren = false;
                controller.items.add(projectItem);
            }
            // Register the project node itself so resolveProjectIdForTestItem
            // can walk up to it from any descendant.
            testItemProjects.set(projectContext.id, projectContext.id);
            rootItems = projectItem.children;
        } else {
            rootItems = controller.items;
        }

        // Build a per-project classFileMap scoped strictly to this project's
        // root so INHERITS chain resolution never crosses into another project.
        const projectClassFileMap = new Map<string, string>();
        const allCls = await vscode.workspace.findFiles(
            new vscode.RelativePattern(projectContext.rootUri, '**/*.cls'),
            '**/node_modules/**'
        );
        for (const f of allCls) {
            projectClassFileMap.set(f.fsPath.replace(/\\/g, '/').toLowerCase(), f.fsPath);
        }

        for (const file of files) {
            await addTestFile(controller, file, projectContext, rootItems, projectClassFileMap);
        }
    }
}

/**
 * Adds a single .cls test file and its discovered test methods to the test tree.
 *
 * The file is placed under the same relative sub-folder path it has inside the
 * project root, creating intermediate folder nodes as needed.  Every created
 * node — folder, file, or method — is registered in testItemProjects keyed by
 * the project context so the run handler can route execution to the right server.
 *
 * @param rootItems  The collection to attach top-level nodes to.  In
 *                   multi-project mode this is the project node's children;
 *                   in single-project mode it is controller.items directly.
 */
async function addTestFile(
    controller: vscode.TestController,
    fileUri: vscode.Uri,
    projectContext: ProjectContext,
    rootItems: vscode.TestItemCollection,
    classFileMap: Map<string, string>
) {
    const filePath = fileUri.fsPath;
    const workspaceRoot = projectContext.rootUri.fsPath;

    try {
        const content = readFileSync(filePath, 'utf-8');
        if (isAbstractClass(content)) {
            return;
        }
        const testMethods = extractAllTestMethods(content, fileUri, classFileMap);

        if (testMethods.length === 0) {
            return;
        }

        const relativePath = relative(workspaceRoot, filePath);
        const pathParts = relativePath.split(sep);
        
        let currentItems = rootItems;
        let currentPath = workspaceRoot;
        
        for (let i = 0; i < pathParts.length - 1; i++) {
            const folderName = pathParts[i];
            currentPath = join(currentPath, folderName);
            const folderId = currentPath;
            
            let folderItem = currentItems.get(folderId);
            
            if (!folderItem) {
                folderItem = controller.createTestItem(folderId, folderName);
                folderItem.canResolveChildren = false;
                currentItems.add(folderItem);
                testItemProjects.set(folderId, projectContext.id);
            }
            
            currentItems = folderItem.children;
        }

        const fileName = pathParts[pathParts.length - 1];
        const fileItem = controller.createTestItem(filePath, fileName, fileUri);
        currentItems.add(fileItem);
        testItemProjects.set(fileItem.id, projectContext.id);

        for (const method of testMethods) {
            const methodId = `${filePath}::${method.name}`;
            // For inherited methods, sourceUri points to the parent file where
            // the method is declared so Go-to-Definition navigates correctly.
            const methodUri = method.sourceUri ?? fileUri;
            const methodItem = controller.createTestItem(methodId, method.name, methodUri);

            methodItem.range = new vscode.Range(
                new vscode.Position(method.line, 0),
                new vscode.Position(method.line, 0)
            );

            fileItem.children.add(methodItem);
            testItemProjects.set(methodId, projectContext.id);
        }

    } catch (error) {
        console.error(`Error parsing test file ${filePath}:`, error);
    }
}

/**
 * Walks up the test item hierarchy until it finds a node registered in
 * testItemProjects and returns its associated ProjectContext.id.
 *
 * This lets the run handler resolve the correct project (and therefore the
 * correct server manager) for any item the user selects, regardless of whether
 * it is a project node, a folder, a file, or an individual test method.
 */
function resolveProjectIdForTestItem(item: vscode.TestItem | undefined): string | undefined {
    if (!item) {
        return undefined;
    }
    const direct = testItemProjects.get(item.id);
    if (direct) {
        return direct;
    }
    return resolveProjectIdForTestItem(item.parent);
}

/**
 * Presents a quick-pick so the user can choose which project to act on.
 *
 * Short-circuits to the only/first context when multi-project mode is off or
 * there is only one project, so single-project users are never prompted.
 * Each entry shows the project folder name and a running/stopped icon to give
 * instant visibility of the current server state.
 *
 * Returns `undefined` when the user cancels the quick-pick.
 */
async function pickProjectContext(actionLabel: string): Promise<ProjectContext | undefined> {
    const contexts = projectDiscovery ? projectDiscovery.getContexts() : [];
    if (contexts.length === 0) {
        vscode.window.showWarningMessage('No OEUnit project contexts available.');
        return undefined;
    }
    if (contexts.length === 1) {
        return contexts[0];
    }
    const items = contexts.map(ctx => {
        const isRunning = serverManagers.get(ctx.id)?.isServerRunning() ?? false;
        return {
            label: basename(ctx.rootUri.fsPath),
            description: `${ctx.rootUri.fsPath}  $(${isRunning ? 'check' : 'circle-slash'})`,
            context: ctx
        };
    });
    const picked = await vscode.window.showQuickPick(items, {
        title: `OEUnit: ${actionLabel}`,
        placeHolder: 'Select a project'
    });
    return picked?.context;
}

async function startPersistentServer(
    testRunner: OEUnitTestRunner,
    context: vscode.ExtensionContext,
    isManual: boolean = false,
    projectContextOverride?: ProjectContext
) {
    const projectContext: ProjectContext | undefined = projectContextOverride ?? projectDiscovery?.getDefaultContext();

    if (!projectContext) {
        console.log('[OEUnit] No project context available, skipping server startup');
        updateStatusBar('stopped');
        return;
    }

    // Read settings scoped to this project's folder so that folder-level
    // overrides in a multi-root workspace are honoured.
    const config = vscode.workspace.getConfiguration('oeunit', projectContext.rootUri);

    // Guard against concurrent startup attempts for the same project.
    // onDidChangeContexts can fire multiple times in rapid succession at startup;
    // without this check each event would attempt to launch a second server
    // process while the first is still initialising.
    if (serverStarting.has(projectContext.id)) {
        console.log('[OEUnit] Server startup already in progress for', projectContext.id);
        return;
    }
    serverStarting.add(projectContext.id);

    const autostart = config.get<boolean>('autostart', true);

    if (!autostart && !isManual) {
        console.log('[OEUnit] Autostart disabled for project, skipping automatic server startup');
        serverStarting.delete(projectContext.id);
        updateStatusBar('stopped');
        return;
    }

    const workspaceFolder = projectContext.rootUri.fsPath;

    console.log('[OEUnit] Starting server initialization for project:', workspaceFolder);

    // Check for openedge-project.json first
    const projectJsonPath = projectContext.projectFile ? projectContext.projectFile.fsPath : join(workspaceFolder, 'openedge-project.json');
    if (!existsSync(projectJsonPath)) {
        if (!isManual) {
            // In multi-project auto-start, silently skip folders without a project file.
            console.log('[OEUnit] No openedge-project.json for project, skipping:', workspaceFolder);
            serverStarting.delete(projectContext.id);
            return;
        }
        const errorMsg = `OEUnit server cannot start. File not found: ${projectJsonPath}`;
        console.log('[OEUnit] openedge-project.json not found, skipping server startup');
        serverOutputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
        serverOutputChannel.show(true);
        updateStatusBar('error');
        vscode.window.showErrorMessage(errorMsg);
        serverStarting.delete(projectContext.id);
        return;
    }

    // Get all required configuration
    const execName = config.get<string>('exec');
    const oeArgs = config.get<string>('oeargs');
    const timeout = config.get<number>('timeout') ?? 60;
    let loglevel = config.get<string>('loglevel') ?? 'error';

    // Port assignment strategy:
    //   1. If the workspace folder has an explicit oeunit.port value set (per-folder
    //      override in .code-workspace or folder .vscode/settings.json), use it
    //      directly without any conflict check — the user owns that choice.
    //   2. Otherwise, start at the configured base port + project index and scan
    //      upward (step = 1) until a port that is both unclaimed by another running
    //      serverManager AND free on the loopback interface is found.
    //      If the range [startPort+index .. portEnd] is exhausted, also try from
    //      startPort so a slot freed by a stopped project is reused before giving up.
    const portInspect = config.inspect<number>('port');
    const portFolderExplicit = portInspect?.workspaceFolderValue;
    let port: number;

    if (typeof portFolderExplicit === 'number') {
        port = portFolderExplicit;
    } else {
        const startPort = portInspect?.workspaceValue ?? portInspect?.globalValue ?? 5555;
        const portEnd = config.get<number>('portEnd', 6000);

        // Collect ports already claimed by other running (or starting) server managers.
        const claimedPorts = new Set<number>();
        for (const [id, mgr] of serverManagers.entries()) {
            if (id !== projectContext.id && mgr.isServerRunning()) {
                const p = mgr.getPort();
                if (typeof p === 'number') { claimedPorts.add(p); }
            }
        }

        const contexts = projectDiscovery.getContexts();
        const index = Math.max(0, contexts.findIndex(ctx => ctx.id === projectContext.id));
        const preferredPort = startPort + index;

        // Scan from the preferred port first; if the range above it is full, wrap
        // back to startPort so already-stopped slots can be reused.
        const found = await findAvailablePort(preferredPort, portEnd, claimedPorts)
                   ?? await findAvailablePort(startPort, Math.min(preferredPort - 1, portEnd), claimedPorts);

        if (found === undefined) {
            const errorMsg = `OEUnit server cannot start for project ${basename(projectContext.id)}: no free port found in range ${startPort}–${portEnd}. Raise oeunit.portEnd or set an explicit oeunit.port for this folder.`;
            serverOutputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
            serverOutputChannel.show(true);
            updateStatusBar('error');
            vscode.window.showErrorMessage(errorMsg);
            serverStarting.delete(projectContext.id);
            return;
        }
        port = found;
        if (port !== preferredPort) {
            console.log(`[OEUnit] Preferred port ${preferredPort} unavailable for ${basename(projectContext.id)}, using ${port}`);
            serverOutputChannel.appendLine(`[INFO] Port ${preferredPort} occupied, assigned port ${port} for ${basename(projectContext.id)}.`);
        }
    }
    if (!['info', 'warning', 'error'].includes(loglevel)) {
        loglevel = 'error';
    }
    const customEnvVars = config.get<Record<string, string>>('environmentVariables', {});

    console.log('[OEUnit] Configuration values:');
    console.log('  - oeunit.exec:', execName || '(empty)');
    console.log('  - oeunit.oeargs:', oeArgs ? `${oeArgs.substring(0, 50)}...` : '(empty)');
    console.log('  - oeunit.port:', port);
    console.log('  - oeunit.timeout:', timeout);
    console.log('  - oeunit.loglevel:', loglevel);

    try {
        // Parse openedge-project.json — robust read with encoding checks (from upstream)
        const rawBytes = readFileSync(projectJsonPath);

        // Check for UTF-16 BOM (not allowed — JSON must be UTF-8 per RFC 8259)
        if (rawBytes.length >= 2) {
            if ((rawBytes[0] === 0xFF && rawBytes[1] === 0xFE) ||
                (rawBytes[0] === 0xFE && rawBytes[1] === 0xFF)) {
                const errorMsg = 'OEUnit server cannot start. openedge-project.json is encoded as UTF-16. JSON files must be UTF-8 encoded per RFC 8259. Please save the file with UTF-8 encoding.';
                serverOutputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
                serverOutputChannel.show(true);
                updateStatusBar('error');
                vscode.window.showErrorMessage(errorMsg);
                return;
            }
        }

        const fileContent = rawBytes.toString('utf-8');

        // Check for UTF-8 BOM (U+FEFF — not allowed in JSON per RFC 8259)
        if (fileContent.charCodeAt(0) === 0xFEFF) {
            const errorMsg = 'OEUnit server cannot start. openedge-project.json contains a UTF-8 BOM (Byte Order Mark) which is not allowed in JSON files per RFC 8259. Please save the file without BOM encoding.';
            serverOutputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
            serverOutputChannel.show(true);
            updateStatusBar('error');
            vscode.window.showErrorMessage(errorMsg);
            return;
        }

        let projectJson: any;
        try {
            projectJson = JSON.parse(stripJsonComments(fileContent));
        } catch (parseError) {
            const errorMsg = `OEUnit server cannot start. Invalid JSON in openedge-project.json: ${parseError instanceof Error ? parseError.message : String(parseError)}`;
            serverOutputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
            serverOutputChannel.show(true);
            updateStatusBar('error');
            vscode.window.showErrorMessage(errorMsg, 'Open File').then(selection => {
                if (selection === 'Open File') {
                    vscode.workspace.openTextDocument(vscode.Uri.file(projectJsonPath)).then(doc => {
                        vscode.window.showTextDocument(doc);
                    });
                }
            });
            return;
        }

        const oeVersion = projectJson.oeversion;
        if (!oeVersion) {
            const errorMsg = `OEUnit server cannot start. openedge-project.json is missing required field: "oeversion"`;
            serverOutputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
            serverOutputChannel.show(true);
            updateStatusBar('error');
            vscode.window.showErrorMessage(errorMsg, 'Open File').then(selection => {
                if (selection === 'Open File') {
                    vscode.workspace.openTextDocument(vscode.Uri.file(projectJsonPath)).then(doc => {
                        vscode.window.showTextDocument(doc);
                    });
                }
            });
            return;
        }

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

        // Now check for missing configuration
        if (!execName || !oeArgs) {
            const missing = [];
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

        const dlcPath = runtime.path;

        // Build PROPATH
        const extensionPath = context.extensionPath;
        const propathEntries: string[] = [
            workspaceFolder,
            join(extensionPath, 'abl')
        ];

        if (projectJson.buildPath && Array.isArray(projectJson.buildPath)) {
            for (const entry of projectJson.buildPath) {
                const entryPath = entry.path || entry;
                const fullPath = isAbsolute(entryPath) 
                    ? entryPath 
                    : join(workspaceFolder, entryPath);
                propathEntries.push(fullPath);
            }
        }

        const propath = propathEntries.join(delimiter);

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
        const manager = new OEUnitServerManager(serverOutputChannel, port, timeout);
        serverManagers.set(projectContext.id, manager);

        const started = await manager.startServer(
            dlcPath,
            execName,
            oeArgs,
            workspaceFolder,
            propath,
            dbArgs,
            dbAliasEnv,
            loglevel,
            customEnvVars
        );        
        
        if (started) {
            testRunner.setServerManager(projectContext.id, manager);
            updateStatusBar('running');
            vscode.window.showInformationMessage('OEUnit persistent server started successfully');
            console.log('[OEUnit] Persistent server started successfully');
        } else {
            serverManagers.delete(projectContext.id);
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
        serverManagers.delete(projectContext.id);
        vscode.window.showErrorMessage(`OEUnit server startup error: ${errorMsg}`, 'Show Output').then(selection => {
            if (selection === 'Show Output') {
                serverOutputChannel.show(true);
            }
        });
    } finally {
        serverStarting.delete(projectContext.id);
    }
}

async function startServer(
    runner: OEUnitTestRunner,
    context: vscode.ExtensionContext,
    projectContextOverride?: ProjectContext
): Promise<void> {
    const projectContext = projectContextOverride ?? projectDiscovery?.getDefaultContext();

    if (!projectContext) {
        vscode.window.showWarningMessage('No OEUnit project context available to start the server');
        return;
    }

    const existing = serverManagers.get(projectContext.id);
    if (existing && existing.isServerRunning()) {
        vscode.window.showInformationMessage(`OEUnit server is already running for project ${projectContext.id}`);
        return;
    }
    
    updateStatusBar('starting');
    await startPersistentServer(runner, context, true, projectContext);
}

async function stopServer(projectContextOverride?: ProjectContext): Promise<void> {
    const projectContext = projectContextOverride ?? projectDiscovery?.getDefaultContext();

    if (!projectContext) {
        vscode.window.showWarningMessage('No OEUnit project context available to stop');
        return;
    }

    const manager = serverManagers.get(projectContext.id);
    if (!manager || !manager.isServerRunning()) {
        vscode.window.showInformationMessage(`OEUnit server is not running for project ${projectContext.id}`);
        if (!projectDiscovery || projectDiscovery.getContexts().length <= 1) {
            updateStatusBar('stopped');
        }
        return;
    }
    
    updateStatusBar('stopping');
    await manager.stopServer();
    testRunner.setServerManager(projectContext.id, null);
    serverManagers.delete(projectContext.id);
    updateStatusBar('stopped');
    vscode.window.showInformationMessage(`OEUnit server stopped for project ${projectContext.id}`);
    console.log('[OEUnit] Server stopped', projectContext.id);
}

async function restartServer(
    runner: OEUnitTestRunner,
    context: vscode.ExtensionContext,
    projectContextOverride?: ProjectContext
): Promise<void> {
    const projectContext = projectContextOverride ?? projectDiscovery?.getDefaultContext();

    if (!projectContext) {
        vscode.window.showWarningMessage('No OEUnit project context available to restart');
        return;
    }

    console.log('[OEUnit] Restarting server for project', projectContext.id);
    
    const manager = serverManagers.get(projectContext.id);
    if (manager && manager.isServerRunning()) {
        await stopServer(projectContext);
        // Wait a moment before restarting
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    await startPersistentServer(runner, context, true, projectContext);
}

async function pingServer(projectContextOverride?: ProjectContext): Promise<void> {
    const projectContext = projectContextOverride ?? projectDiscovery?.getDefaultContext();
    if (!projectContext) {
        vscode.window.showWarningMessage('No OEUnit project context available to ping');
        return;
    }

    const manager = serverManagers.get(projectContext.id);
    if (!manager) {
        vscode.window.showWarningMessage(`OEUnit server manager not initialized for project ${projectContext.id}`);
        return;
    }

    if (!manager.isServerRunning()) {
        vscode.window.showWarningMessage(`OEUnit server is not running for project ${projectContext.id}`);
        return;
    }
    
    try {
        console.log('[OEUnit] Pinging server...');
        const isHealthy = await manager.checkServerHealth();
        
        if (isHealthy) {
            vscode.window.showInformationMessage('OEUnit server responded: PONG Γ£ô');
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

function updateStatusBar(state: 'starting' | 'running' | 'stopping' | 'stopped' | 'error'): void {
    if (projectDiscovery) {
        const contexts = projectDiscovery.getContexts();
        if (contexts.length > 1) {
            const running = contexts.filter(ctx => serverManagers.get(ctx.id)?.isServerRunning()).length;
            const total = contexts.length;
            const noneRunning = running === 0;
            statusBarItem.text = `$(server) OEUnit: ${running}/${total} running`;
            statusBarItem.tooltip = `OEUnit: ${running} of ${total} project server(s) running. Click to restart the last active server.`;
            if (noneRunning) {
                statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            } else if (state === 'error') {
                statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            } else {
                statusBarItem.backgroundColor = undefined;
            }
            return;
        }
    }
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
    const stopPromises: Promise<void>[] = [];
    for (const [projectId, manager] of serverManagers.entries()) {
        console.log('[OEUnit] Deactivating server for project', projectId);
        stopPromises.push(manager.stopServer());
    }
    await Promise.allSettled(stopPromises);
    serverManagers.clear();
    testRunner.clearServerManagers();
}
