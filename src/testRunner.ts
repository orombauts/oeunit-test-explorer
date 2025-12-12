import * as vscode from 'vscode';
import * as path from 'path';
import { OEUnitServerManager } from './serverManager';

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
    private serverManager: OEUnitServerManager | null = null;
    private extensionVersion: string = 'unknown';

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('OEUnit Test Runner');
    }

    setExtensionVersion(version: string) {
        this.extensionVersion = version;
    }

    setServerManager(serverManager: OEUnitServerManager | null) {
        this.serverManager = serverManager;
    }

    async runTestFile(filePath: string, run: vscode.TestRun, testItem: vscode.TestItem, testMethod?: string): Promise<void> {
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`\nRunning tests in: ${path.basename(filePath)} (Extension v${this.extensionVersion})`);
        if (testMethod) {
            this.outputChannel.appendLine(`Test method: ${testMethod}`);
        }
        this.outputChannel.appendLine('-'.repeat(80));

        // Check if server is running
        const serverRunning = this.serverManager && this.serverManager.isServerRunning();
        this.outputChannel.appendLine(`[TestRunner] Server manager exists: ${!!this.serverManager}, Server running: ${serverRunning}`);

        if (!serverRunning) {
            // Server not running - fail the test
            this.outputChannel.appendLine('[TestRunner] ERROR: Server is not running. Tests cannot be executed.');
            this.outputChannel.appendLine('[TestRunner] Please start the server using the "OEUnit: Start Server" command before running tests.');
            
            const errorMessage = new vscode.TestMessage('OEUnit server is not running. Please start the server first.');
            const actions: vscode.MessageItem[] = [{ title: 'Start Server' }];
            
            vscode.window.showErrorMessage('Cannot run tests: OEUnit server is not running', ...actions).then(selection => {
                if (selection?.title === 'Start Server') {
                    vscode.commands.executeCommand('oeunit.startServer');
                }
            });

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
        return this.runTestViaServer(filePath, run, testItem, testMethod);
    }

    private async runTestViaServer(filePath: string, run: vscode.TestRun, testItem: vscode.TestItem, testMethod?: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('oeunit');
        const logLevel = config.get<string>('loglevel') || 'info';

        try {
            // Send test request with JSON protocol - TestMethod parameter runs specific test method
            const response = await this.serverManager!.runTest(filePath, testMethod, logLevel) as any as TestResponse;

            if (response.Status === 'ERROR') {
                const errorMsg = response.Reply || 'Unknown error occurred';
                this.outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
                run.failed(testItem, new vscode.TestMessage(errorMsg));
                return;
            }

            if (response.Status === 'COMPLETED' && response.Summary && response.TestCases) {
                this.outputChannel.appendLine(`\n[OK] Tests completed successfully`);
                this.outputChannel.appendLine(`Summary: ${response.Summary.Total} tests, ${response.Summary.Failures} failures, ${response.Summary.Errors} errors, ${response.Summary.Skipped} skipped`);
                this.outputChannel.appendLine(`Duration: ${response.Summary.DurationMs}ms`);

                // Process test cases from JSON response
                await this.processJsonResults(response, run, testItem);

                // Mark the test file as passed if there are no failures or errors
                if (response.Summary.Failures === 0 && response.Summary.Errors === 0) {
                    run.passed(testItem, response.Summary.DurationMs);
                } else {
                    run.failed(testItem, new vscode.TestMessage(`${response.Summary.Failures} test(s) failed, ${response.Summary.Errors} error(s)`));
                }
            } else {
                const errorMsg = 'Unexpected response format from server';
                this.outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
                this.outputChannel.appendLine(`Response: ${JSON.stringify(response)}`);
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
            if (response.TestCases.length > 0) {
                this.outputChannel.appendLine(`[TestRunner] Updating single test method: ${testItem.label}`);
                const testCase = response.TestCases[0];
                this.updateTestStatus(testItem, testCase, run);
            } else {
                this.outputChannel.appendLine(`[TestRunner] No test method children found for ${testItem.label}`);
            }
        }
    }

    private updateTestStatus(testItem: vscode.TestItem, testCase: TestCaseResult, run: vscode.TestRun): void {
        switch (testCase.Status) {
            case 'Passed':
                run.passed(testItem, testCase.DurationMs);
                this.outputChannel.appendLine(`   ${testCase.Case} (${testCase.DurationMs}ms)`);
                break;

            case 'Failed':
                const failureMsg = testCase.Failure || 'Test failed';
                const errorMsg = new vscode.TestMessage(failureMsg);
                
                // Add error stack if available
                if (testCase.ErrorStack && testCase.ErrorStack.length > 0) {
                    const stackTrace = testCase.ErrorStack.join('\n');
                    this.outputChannel.appendLine(`   ${testCase.Case}: ${failureMsg} (${testCase.DurationMs}ms)`);
                    this.outputChannel.appendLine(`    Stack trace:\n${stackTrace}`);
                } else {
                    this.outputChannel.appendLine(`   ${testCase.Case}: ${failureMsg} (${testCase.DurationMs}ms)`);
                }
                
                run.failed(testItem, errorMsg, testCase.DurationMs);
                break;

            case 'Skipped':
                run.skipped(testItem);
                this.outputChannel.appendLine(`  - ${testCase.Case} (skipped, ${testCase.DurationMs}ms)`);
                break;

            default:
                this.outputChannel.appendLine(`  ? ${testItem.label} (unknown status: ${testCase.Status})`);
                break;
        }
    }
}
