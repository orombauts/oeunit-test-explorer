import * as vscode from 'vscode';
import { basename } from 'path';
import { OEUnitServerManager } from './serverManager';
import { log } from './utils';

// Import types from serverManager
interface TestCaseSummary {
    Errors: number;
    Skipped: number;
    Total: number;
    DurationMs: number;
    Failures: number;
    Name: string;
}

interface TestCaseResult {
    Case: string;
    DurationMs: number;
    Status: 'Passed' | 'Failed' | 'Skipped';
    Failure?: string;
    ErrorStack?: string[];
}

interface TestResponse {
    Status: 'COMPLETED' | 'ERROR' | 'OK';
    Summary?: TestCaseSummary;
    TestCases?: TestCaseResult[];
    Reply?: string;
}

export class OEUnitTestRunner {
    private outputChannel: vscode.OutputChannel;
    private extensionVersion: string = 'unknown';
    private readonly serverManagers = new Map<string, OEUnitServerManager>();
    private onRunCompleteCallback?: (filePath: string, result: any) => void;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('OEUnit Test Runner');
    }

    private log(message: string): void {
        log(this.outputChannel, 'TestRunner', message);
    }

    setExtensionVersion(version: string) {
        this.extensionVersion = version;
    }

    setServerManager(projectId: string, serverManager: OEUnitServerManager | null) {
        if (!serverManager) {
            this.serverManagers.delete(projectId);
        } else {
            this.serverManagers.set(projectId, serverManager);
        }
    }

    clearServerManagers(): void {
        this.serverManagers.clear();
    }

    /**
     * Registers a callback invoked whenever a test file run completes successfully.
     * Used by extension.ts to keep the results cache up to date for all run paths,
     * including Test Explorer runs that bypass the LM tool handlers.
     */
    setOnRunComplete(cb: (filePath: string, result: any) => void): void {
        this.onRunCompleteCallback = cb;
    }

    async runTestFile(
        filePath: string,
        run: vscode.TestRun,
        testItem: vscode.TestItem,
        projectId: string,
        testMethod?: string
    ): Promise<void> {
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`\nRunning tests in: ${basename(filePath)} (Extension v${this.extensionVersion})`);
        this.outputChannel.appendLine(`[TestRunner] Project: ${projectId}`);
        if (testMethod) {
            this.outputChannel.appendLine(`Test method: ${testMethod}`);
        }
        this.outputChannel.appendLine('-'.repeat(80));

        // Check if server is running
        const serverManager = this.serverManagers.get(projectId) ?? null;
        const serverRunning = serverManager && serverManager.isServerRunning();
        this.log(`Server manager exists: ${!!serverManager}, Server running: ${serverRunning}`);

        if (!serverRunning) {
            if (!serverManager) {
                // No server manager exists yet — server was never started this session.
                // Start it automatically on the first test run using the known projectId so
                // no project-picker QuickPick is shown to the user.
                this.log('Server never started this session. Starting automatically for first test run...');
                vscode.window.showInformationMessage('OEUnit server was not running — starting automatically for test run...');
                await vscode.commands.executeCommand('oeunit.startServerForProject', projectId);

                // Re-check after startup attempt
                const serverNowRunning = this.serverManagers.get(projectId)?.isServerRunning() ?? false;
                if (!serverNowRunning) {
                    const errorMessage = new vscode.TestMessage('OEUnit server failed to start. Check OEUnit Server output for details.');
                    if (testItem.children.size > 0) {
                        testItem.children.forEach(child => run.failed(child, errorMessage));
                    }
                    run.failed(testItem, errorMessage);
                    return;
                }
                // Server is now running — fall through to run the test
            } else {
                // Server was started before but is no longer running
                this.log('ERROR: Server is not running. Tests cannot be executed.');
                this.log('Please start the server using the "OEUnit: Start Server" command before running tests.');

                const errorMessage = new vscode.TestMessage('OEUnit server is not running. Please start the server first.');
                const actions: vscode.MessageItem[] = [{ title: 'Start Server' }];

                vscode.window.showErrorMessage('Cannot run tests: OEUnit server is not running', ...actions).then(selection => {
                    if (selection?.title === 'Start Server') {
                        vscode.commands.executeCommand('oeunit.startServer');
                    }
                });

                if (testItem.children.size > 0) {
                    testItem.children.forEach(child => run.failed(child, errorMessage));
                }
                run.failed(testItem, errorMessage);
                return;
            }
        }

        // Use persistent server
        return this.runTestViaServer(serverManager!, projectId, filePath, run, testItem, testMethod);
    }

    private async runTestViaServer(
        serverManager: OEUnitServerManager,
        projectId: string,
        filePath: string,
        run: vscode.TestRun,
        testItem: vscode.TestItem,
        testMethod?: string
    ): Promise<void> {
        // Scope the config read to the project folder so folder-level settings
        // (e.g. per-project loglevel) are honoured in multi-root workspaces.
        const config = vscode.workspace.getConfiguration('oeunit', vscode.Uri.file(projectId));
        const logLevel = config.get<string>('loglevel') ?? 'info';

        try {
            // Send test request with JSON protocol - TestMethod parameter runs specific test method
            const response = await serverManager.runTest(filePath, testMethod, logLevel) as any as TestResponse;

            if (response.Status === 'COMPLETED') {
                this.onRunCompleteCallback?.(filePath, response);
            }

            if (response.Status === 'ERROR') {
                const errorMsg = response.Reply || 'Unknown error occurred';
                this.outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
                run.appendOutput(`ERROR: ${errorMsg}\r\n`, undefined, testItem);
                run.failed(testItem, new vscode.TestMessage(errorMsg));
                return;
            }

            if (response.Status === 'COMPLETED' && response.Summary && response.TestCases) {
                this.outputChannel.appendLine(`\n[OK] Tests completed successfully`);
                this.outputChannel.appendLine(`Summary: ${response.Summary.Total} tests, ${response.Summary.Failures} failures, ${response.Summary.Errors} errors, ${response.Summary.Skipped} skipped`);
                this.outputChannel.appendLine(`Duration: ${response.Summary.DurationMs}ms`);

                run.appendOutput(`${basename(filePath)}\r\n`, undefined, testItem);
                run.appendOutput(`${'─'.repeat(60)}\r\n`, undefined, testItem);

                // Process test cases from JSON response
                await this.processJsonResults(response, run, testItem);

                const passed = response.Summary.Total - response.Summary.Failures - response.Summary.Errors - response.Summary.Skipped;
                run.appendOutput(`${'─'.repeat(60)}\r\n`, undefined, testItem);
                run.appendOutput(`Total: ${response.Summary.Total}  Passed: ${passed}  Failed: ${response.Summary.Failures}  Errors: ${response.Summary.Errors}  Skipped: ${response.Summary.Skipped}  (${response.Summary.DurationMs}ms)\r\n`, undefined, testItem);

                // Mark the test file as passed if there are no failures or errors
                // Only update status for items with children (test files), not leaf items (individual methods)
                // to avoid overwriting detailed failure messages set in processJsonResults
                if (testItem.children.size > 0) {
                    if (response.Summary.Failures === 0 && response.Summary.Errors === 0) {
                        run.passed(testItem, response.Summary.DurationMs);
                    } else {
                        run.failed(testItem, new vscode.TestMessage(`${response.Summary.Failures} test(s) failed, ${response.Summary.Errors} error(s)`));
                    }
                }
            } else {
                const errorMsg = 'Unexpected response format from server';
                this.outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
                this.outputChannel.appendLine(`Response: ${JSON.stringify(response)}`);
                run.appendOutput(`ERROR: ${errorMsg}\r\n`, undefined, testItem);
                run.failed(testItem, new vscode.TestMessage(errorMsg));
            }
        } catch (error) {
            this.outputChannel.appendLine(`\n[ERROR] ${error}`);
            run.failed(testItem, new vscode.TestMessage(String(error)));
        }
    }

    private async processJsonResults(response: TestResponse, run: vscode.TestRun, testItem: vscode.TestItem): Promise<void> {
        if (!response.TestCases || response.TestCases.length === 0) {
            this.outputChannel.appendLine('[WARNING] No test cases in response');
            return;
        }

        // If test item has children (test file with multiple test methods), update all children
        if (testItem.children.size > 0) {
            let testIndex = 0;
            testItem.children.forEach(child => {
                if (testIndex < response.TestCases!.length) {
                    const testCase = response.TestCases![testIndex];
                    this.updateTestStatus(child, testCase, run);
                    testIndex++;
                }
            });
        } else {
            // Test item is a single test method (no children) - update it directly
            // Find the matching test case by name (Case property should match testItem.label)
            if (response.TestCases.length > 0) {
                this.log(`Updating single test method: ${testItem.label}`);
                const testCase = response.TestCases.find(tc => tc.Case === testItem.label);
                if (testCase) {
                    this.updateTestStatus(testItem, testCase, run);
                } else {
                    this.log(`ERROR: Could not find test case matching "${testItem.label}" in response`);
                    this.log(`Available test cases: ${response.TestCases.map(tc => tc.Case).join(', ')}`);
                    run.failed(testItem, new vscode.TestMessage(`Test case "${testItem.label}" not found in server response`));
                }
            } else {
                this.log(`No test cases found in response for ${testItem.label}`);
                run.failed(testItem, new vscode.TestMessage('No test cases in server response'));
            }
        }
    }

    private updateTestStatus(testItem: vscode.TestItem, testCase: TestCaseResult, run: vscode.TestRun): void {
        switch (testCase.Status) {
            case 'Passed':
                run.appendOutput(`  ✓ ${testCase.Case} (${testCase.DurationMs}ms)\r\n`, undefined, testItem);
                run.passed(testItem, testCase.DurationMs);
                this.outputChannel.appendLine(`   ${testCase.Case} (${testCase.DurationMs}ms)`);
                break;

            case 'Failed': {
                const hasStack = testCase.ErrorStack && testCase.ErrorStack.length > 0;
                const stackText = hasStack ? testCase.ErrorStack!.join('\n') : '';
                let messageText: string;
                if (!testCase.Failure && hasStack) {
                    // Lifecycle error (e.g. BeforeAllTests threw): Failure is empty but a stack
                    // was captured. Surface a clear headline and attach the full stack as markdown.
                    messageText = `Test class error (see stack trace)\n\n\`\`\`\n${stackText}\n\`\`\``;
                } else if (testCase.Failure && hasStack) {
                    messageText = `${testCase.Failure}\n${stackText}`;
                } else {
                    messageText = testCase.Failure || 'Test failed';
                }
                const failureMsg = testCase.Failure || (hasStack ? 'Test class error' : 'Test failed');
                const errorMsg = new vscode.TestMessage(messageText);
                run.appendOutput(`  ✗ ${testCase.Case}: ${failureMsg} (${testCase.DurationMs}ms)\r\n`, undefined, testItem);
                if (hasStack) {
                    run.appendOutput(testCase.ErrorStack!.map(l => `    ${l}`).join('\r\n') + '\r\n', undefined, testItem);
                }
                this.outputChannel.appendLine(`   -${testCase.Case}: ${failureMsg} (${testCase.DurationMs}ms)`);
                run.failed(testItem, errorMsg, testCase.DurationMs);
                break;
            }

            case 'Skipped':
                run.appendOutput(`  - ${testCase.Case} (skipped, ${testCase.DurationMs}ms)\r\n`, undefined, testItem);
                run.skipped(testItem);
                this.outputChannel.appendLine(`  - ${testCase.Case} (skipped, ${testCase.DurationMs}ms)`);
                break;

            default:
                run.appendOutput(`  ? ${testItem.label} (unknown status: ${testCase.Status})\r\n`, undefined, testItem);
                this.outputChannel.appendLine(`  ? ${testItem.label} (unknown status: ${testCase.Status})`);
                break;
        }
    }
}
