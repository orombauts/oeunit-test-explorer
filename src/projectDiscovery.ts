import * as vscode from 'vscode';
import { basename, join, normalize, sep } from 'path';
import { existsSync, readFileSync } from 'fs';

export interface ProjectContext {
    id: string;
    rootUri: vscode.Uri;
    workspaceFolder: vscode.WorkspaceFolder;
    projectFile: vscode.Uri | null;
    projectConfig: any | null;
}

export class ProjectDiscovery {
    private contexts: ProjectContext[] = [];
    private readonly onDidChangeEmitter = new vscode.EventEmitter<ProjectContext[]>();

    readonly onDidChangeContexts = this.onDidChangeEmitter.event;

    async refresh(): Promise<void> {
        const config = vscode.workspace.getConfiguration('oeunit');
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

        const nextContexts: ProjectContext[] = [];

        // Three-tier discovery priority:
        //   1. oeunit.projectPaths — if non-empty, used as the complete project list;
        //      automatic detection is entirely skipped (full override).
        //   2. Multi-root workspace — one context per workspace folder whose root
        //      contains openedge-project.json.
        //   3. Single-folder root — detect openedge-project.json at the workspace root.
        const explicitPaths = config.get<string[]>('projectPaths', []).map(p => normalize(p)).filter(Boolean);

        if (explicitPaths.length > 0) {
            for (let i = 0; i < explicitPaths.length; i++) {
                const folderPath = explicitPaths[i];
                const rootUri = vscode.Uri.file(folderPath);
                const projectJsonPath = join(folderPath, 'openedge-project.json');
                const projectFile = existsSync(projectJsonPath) ? vscode.Uri.file(projectJsonPath) : null;

                const knownFolder = workspaceFolders.find(f =>
                    normalize(f.uri.fsPath).toLowerCase() === folderPath.toLowerCase()
                ) ?? this.makeSyntheticFolder(rootUri, i);

                nextContexts.push(this.createContext(folderPath, rootUri, knownFolder, projectFile));
            }
        } else if (workspaceFolders.length > 1) {
            // Multi-root workspace: one context per folder containing openedge-project.json.
            // Recursive findFiles is intentionally avoided to prevent a root folder that
            // physically contains sub-folders from producing duplicate contexts.
            for (const folder of workspaceFolders) {
                const projectJsonPath = join(folder.uri.fsPath, 'openedge-project.json');
                if (existsSync(projectJsonPath)) {
                    const projectFile = vscode.Uri.file(projectJsonPath);
                    nextContexts.push(this.createContext(folder.uri.fsPath, folder.uri, folder, projectFile));
                }
            }
        } else {
            const folder = workspaceFolders[0];
            if (folder) {
                const projectJsonPath = join(folder.uri.fsPath, 'openedge-project.json');
                const projectFile = existsSync(projectJsonPath) ? vscode.Uri.file(projectJsonPath) : null;
                nextContexts.push(this.createContext(folder.uri.fsPath, folder.uri, folder, projectFile));
            }
        }

        nextContexts.sort((a, b) => a.rootUri.fsPath.localeCompare(b.rootUri.fsPath));

        this.contexts = nextContexts;
        this.onDidChangeEmitter.fire(this.getContexts());
    }

    /**
     * Creates a minimal WorkspaceFolder-compatible object for a path that is
     * not officially registered as a VS Code workspace folder (e.g. a path from
     * oeunit.projectPaths that sits outside the current .code-workspace).
     */
    private makeSyntheticFolder(uri: vscode.Uri, index: number): vscode.WorkspaceFolder {
        return { uri, name: basename(uri.fsPath), index };
    }

    getContexts(): ProjectContext[] {
        return [...this.contexts];
    }

    getDefaultContext(): ProjectContext | undefined {
        return this.contexts[0];
    }

    findContextForUri(uri: vscode.Uri): ProjectContext | undefined {
        const matching = this.contexts.filter(ctx => uri.fsPath.startsWith(ctx.rootUri.fsPath + sep) || uri.fsPath === ctx.rootUri.fsPath);
        if (matching.length === 0) {
            return undefined;
        }
        return matching.sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
    }

    private resolveWorkspaceFolder(folders: readonly vscode.WorkspaceFolder[]): vscode.WorkspaceFolder | undefined {
        return folders[0];
    }

    private createContext(
        id: string,
        rootUri: vscode.Uri,
        workspaceFolder: vscode.WorkspaceFolder,
        projectFile: vscode.Uri | null,
        projectConfig?: any
    ): ProjectContext {
        const config = projectConfig ?? (projectFile ? this.safeReadProject(projectFile) : null);
        return {
            id,
            rootUri,
            workspaceFolder,
            projectFile,
            projectConfig: config
        };
    }

    private safeReadProject(file: vscode.Uri): any | null {
        try {
            const content = readFileSync(file.fsPath, 'utf-8');
            return JSON.parse(content);
        } catch (error) {
            console.warn('[OEUnit] Failed to parse openedge-project.json:', file.fsPath, error);
            return null;
        }
    }
}
