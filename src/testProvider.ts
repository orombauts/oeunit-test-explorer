import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface TestItem {
    type: 'file' | 'method';
    label: string;
    filePath?: string;
    methodName?: string;
    status?: 'passed' | 'failed' | 'running' | 'pending';
    line?: number;
}

export class OEUnitTestProvider implements vscode.TreeDataProvider<TestItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TestItem | undefined | null | void> = new vscode.EventEmitter<TestItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TestItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private testFiles: Map<string, TestItem[]> = new Map();

    constructor() {}

    refresh(): void {
        this.discoverTests();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TestItem): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(
            element.label,
            element.type === 'file' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );

        if (element.type === 'file') {
            treeItem.contextValue = 'testFile';
            treeItem.iconPath = new vscode.ThemeIcon('file-code');
            treeItem.description = this.getTestCount(element);
            treeItem.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [vscode.Uri.file(element.filePath!)]
            };
        } else {
            treeItem.contextValue = 'testMethod';
            treeItem.iconPath = this.getTestIcon(element.status);
            treeItem.command = {
                command: 'vscode.open',
                title: 'Open Test',
                arguments: [
                    vscode.Uri.file(element.filePath!),
                    { selection: new vscode.Range(element.line || 0, 0, element.line || 0, 0) }
                ]
            };
        }

        return treeItem;
    }

    getChildren(element?: TestItem): Thenable<TestItem[]> {
        if (!element) {
            // Root level - return all test files
            return Promise.resolve(Array.from(this.testFiles.keys()).map(filePath => ({
                type: 'file' as const,
                label: path.basename(filePath),
                filePath: filePath
            })));
        } else if (element.type === 'file') {
            // Return test methods for this file
            return Promise.resolve(this.testFiles.get(element.filePath!) || []);
        }
        return Promise.resolve([]);
    }

    async getAllTests(): Promise<TestItem[]> {
        const allTests: TestItem[] = [];
        for (const [filePath, methods] of this.testFiles) {
            allTests.push({
                type: 'file',
                label: path.basename(filePath),
                filePath: filePath
            });
        }
        return allTests;
    }

    private async discoverTests(): Promise<void> {
        this.testFiles.clear();

        const config = vscode.workspace.getConfiguration('oeunit');
        const testPattern = config.get<string>('testFilePattern', '**/test/**/*.cls');

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return;
        }

        for (const folder of workspaceFolders) {
            const files = await vscode.workspace.findFiles(
                new vscode.RelativePattern(folder, testPattern),
                '**/node_modules/**'
            );

            for (const file of files) {
                await this.parseTestFile(file.fsPath);
            }
        }
    }

    private async parseTestFile(filePath: string): Promise<void> {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const testMethods = this.extractTestMethods(content, filePath);
            
            if (testMethods.length > 0) {
                this.testFiles.set(filePath, testMethods);
            }
        } catch (error) {
            console.error(`Error parsing test file ${filePath}:`, error);
        }
    }

    private isAbstractClass(content: string): boolean {
        // Check if the class is declared as abstract
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmedLine = line.trim().toUpperCase();
            // Match CLASS ... ABSTRACT pattern
            if (trimmedLine.startsWith('CLASS ') && trimmedLine.includes('ABSTRACT')) {
                return true;
            }
        }
        return false;
    }

    private extractTestMethods(content: string, filePath: string): TestItem[] {
        const methods: TestItem[] = [];
        const lines = content.split('\n');
        
        // Skip abstract classes - they should not be tested
        if (this.isAbstractClass(content)) {
            return methods;
        }
        
        // Look for methods with @Test annotation or methods starting with "test"
        let isTestAnnotated = false;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Check for @Test annotation
            if (line.toLowerCase().includes('@test')) {
                isTestAnnotated = true;
                continue;
            }
            
            // Match method definitions
            // Pattern: METHOD PUBLIC VOID TestMethodName():
            const methodMatch = line.match(/METHOD\s+(?:PUBLIC|PRIVATE|PROTECTED)?\s+(?:VOID|[\w]+)\s+(test\w+)\s*\(/i);
            
            if (methodMatch) {
                const methodName = methodMatch[1];
                methods.push({
                    type: 'method',
                    label: methodName,
                    filePath: filePath,
                    methodName: methodName,
                    status: 'pending',
                    line: i
                });
                isTestAnnotated = false;
            } else if (isTestAnnotated) {
                // If we had @Test but didn't match method pattern, try another pattern
                const altMethodMatch = line.match(/METHOD\s+(?:PUBLIC|PRIVATE|PROTECTED)?\s+(?:VOID|[\w]+)\s+([\w]+)\s*\(/i);
                if (altMethodMatch) {
                    const methodName = altMethodMatch[1];
                    methods.push({
                        type: 'method',
                        label: methodName,
                        filePath: filePath,
                        methodName: methodName,
                        status: 'pending',
                        line: i
                    });
                    isTestAnnotated = false;
                }
            }
        }
        
        return methods;
    }

    private getTestCount(element: TestItem): string {
        if (element.filePath) {
            const methods = this.testFiles.get(element.filePath) || [];
            return `${methods.length} test${methods.length !== 1 ? 's' : ''}`;
        }
        return '';
    }

    private getTestIcon(status?: string): vscode.ThemeIcon {
        switch (status) {
            case 'passed':
                return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
            case 'failed':
                return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
            case 'running':
                return new vscode.ThemeIcon('loading~spin');
            default:
                return new vscode.ThemeIcon('circle-outline');
        }
    }

    updateTestStatus(filePath: string, methodName: string, status: 'passed' | 'failed' | 'running'): void {
        const methods = this.testFiles.get(filePath);
        if (methods) {
            const method = methods.find(m => m.methodName === methodName);
            if (method) {
                method.status = status;
                this._onDidChangeTreeData.fire();
            }
        }
    }
}
