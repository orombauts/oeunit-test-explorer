/**
 * VS Code test-controller tree management and file-system watcher callbacks.
 * Maintains the workspace-wide classFileMap for fast parent-class lookups
 * and keeps the test tree in sync with .cls file changes on disk.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { isAbstractClass, extractAllTestMethods } from './classParser';

// Workspace-wide map of normalised file path -> original fsPath for all .cls files.
// Kept alive across watcher events so parent-class lookups are always fast.
export const classFileMap: Map<string, string> = new Map();

export function collectTests(item: vscode.TestItem, queue: vscode.TestItem[]): void {
    if (item.uri && item.uri.fsPath.endsWith('.cls')) {
        queue.push(item);
        // Don't recurse into children if this is a test file - we already have it
        return;
    }
    item.children.forEach(child => collectTests(child, queue));
}

// Remove a test file's item from the controller tree and clean up any now-empty
// parent folder items.
export function removeTestFileItem(controller: vscode.TestController, filePath: string): void {
    const recurse = (items: vscode.TestItemCollection): boolean => {
        if (items.get(filePath)) {
            items.delete(filePath);
            return true;
        }
        let found = false;
        const emptyFolders: string[] = [];
        items.forEach(child => {
            if (!found && !child.uri) {
                if (recurse(child.children)) {
                    found = true;
                    if (child.children.size === 0) {
                        emptyFolders.push(child.id);
                    }
                }
            }
        });
        emptyFolders.forEach(id => items.delete(id));
        return found;
    };
    recurse(controller.items);
}

// Remove and re-add a single test file without touching the rest of the tree.
export function refreshSingleTestFile(controller: vscode.TestController, fileUri: vscode.Uri): void {
    removeTestFileItem(controller, fileUri.fsPath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (workspaceFolder) {
        addTestFile(controller, fileUri, workspaceFolder.uri.fsPath);
    }
}

export async function discoverTests(controller: vscode.TestController): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return;
    }

    controller.items.replace([]);

    // Rebuild the class file map across all workspace folders first so that
    // parent-class lookups work even when the parent lives in a different folder.
    classFileMap.clear();
    for (const folder of workspaceFolders) {
        const allCls = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, '**/*.cls'),
            '**/node_modules/**'
        );
        for (const f of allCls) {
            classFileMap.set(f.fsPath.replace(/\\/g, '/').toLowerCase(), f.fsPath);
        }
    }

    // Process test files using the now-complete map.
    // Read testFilePattern scoped to each folder so individual projects can
    // override the glob pattern without affecting other workspace folders.
    for (const folder of workspaceFolders) {
        const folderConfig = vscode.workspace.getConfiguration('oeunit', folder.uri);
        const testPattern = folderConfig.get<string>('testFilePattern', '**/test/**/*.cls');
        const testFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, testPattern),
            '**/node_modules/**'
        );
        for (const file of testFiles) {
            addTestFile(controller, file, folder.uri.fsPath);
        }
    }
}

export function addTestFile(controller: vscode.TestController, fileUri: vscode.Uri, workspaceRoot: string): void {
    const filePath = fileUri.fsPath;

    try {
        const content = fs.readFileSync(filePath, 'utf-8');

        // Abstract classes are not runnable test classes, skip them
        if (isAbstractClass(content)) {
            return;
        }

        const testMethods = extractAllTestMethods(content, fileUri, classFileMap);

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
            // For inherited methods, point navigation to the source file where the method is defined
            const methodUri = method.sourceUri ?? fileUri;
            const methodItem = controller.createTestItem(methodId, method.name, methodUri);

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

// Watcher callback handlers — called from the FileSystemWatcher in extension.ts.

export function onClsFileChanged(controller: vscode.TestController, uri: vscode.Uri): void {
    if (uri.path.includes('/test/')) {
        // Re-parse only the changed test file instead of the entire workspace
        refreshSingleTestFile(controller, uri);
    } else {
        // Non-test .cls file changed — could be a parent class used via INHERITS
        discoverTests(controller);
    }
}

export function onClsFileCreated(controller: vscode.TestController, uri: vscode.Uri): void {
    // Keep the map current whenever any .cls file appears
    classFileMap.set(uri.fsPath.replace(/\\/g, '/').toLowerCase(), uri.fsPath);
    if (uri.path.includes('/test/')) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (workspaceFolder) {
            addTestFile(controller, uri, workspaceFolder.uri.fsPath);
        }
    }
}

export function onClsFileDeleted(controller: vscode.TestController, uri: vscode.Uri): void {
    // Keep the map current whenever any .cls file disappears
    classFileMap.delete(uri.fsPath.replace(/\\/g, '/').toLowerCase());
    if (uri.path.includes('/test/')) {
        removeTestFileItem(controller, uri.fsPath);
    } else {
        // Non-test .cls file deleted — could be a parent class, rebuild
        discoverTests(controller);
    }
}
