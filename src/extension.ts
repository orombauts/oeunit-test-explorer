/**
 * Extension entry point. Thin wiring layer: creates the VS Code test controller,
 * registers commands, sets up the file-system watcher, and delegates all
 * business logic to classParser, testDiscovery, and serverLifecycle.
 */
import * as vscode from 'vscode';
import { OEUnitTestRunner } from './testRunner';
import {
    initServerLifecycle, getServerManager, handleConfigurationChange,
    startPersistentServer, startServer, stopServer, restartServer, pingServer, updateStatusBar
} from './serverLifecycle';
import {
    discoverTests, collectTests,
    onClsFileChanged, onClsFileCreated, onClsFileDeleted
} from './testDiscovery';

let testRunner: OEUnitTestRunner;

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

    // Create output channel and status bar item, then hand them to serverLifecycle
    const serverOutputChannel = vscode.window.createOutputChannel('OEUnit Server');
    context.subscriptions.push(serverOutputChannel);

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'oeunit.restartServer';
    statusBarItem.tooltip = 'Click to restart OEUnit server';
    context.subscriptions.push(statusBarItem);

    initServerLifecycle(statusBarItem, serverOutputChannel);
    updateStatusBar('starting');
    statusBarItem.show();

    // Initialize and start the persistent test server
    startPersistentServer(testRunner, context, false);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.restartServer', async () => {
            await restartServer(testRunner, context);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('oeunit.stopServer', async () => {
            await stopServer(testRunner);
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

    // Watch for configuration changes with debouncing
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('oeunit')) {
                handleConfigurationChange(testRunner, context);
            }
        })
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.cls');
    context.subscriptions.push(watcher);

    watcher.onDidChange(uri => onClsFileChanged(controller, uri));
    watcher.onDidCreate(uri => onClsFileCreated(controller, uri));
    watcher.onDidDelete(uri => onClsFileDeleted(controller, uri));

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

                // For test methods (children with no children of their own), run the parent file with method name
                if (test.children.size === 0 && test.parent && test.parent.uri) {
                    console.log('[OEUnit] Running test method:', test.label, 'parent file:', test.parent.uri.fsPath);
                    const methodName = test.id.includes('::') ? test.id.split('::')[1] : test.label;
                    run.started(test);
                    try {
                        await testRunner.runTestFile(test.parent.uri.fsPath, run, test, methodName);
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

export async function deactivate() {
    const mgr = getServerManager();
    if (mgr) {
        await mgr.stopServer();
    }
}
