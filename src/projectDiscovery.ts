import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

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
        const useMulti = config.get<boolean>('multiProjectMode', false);
        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

        const nextContexts: ProjectContext[] = [];

        if (!useMulti) {
            // ── Legacy single-project mode ──────────────────────────────────
            // Honour oeunit.workspaceFolder if set, otherwise use the first
            // workspace folder.
            const configured = config.get<string>('workspaceFolder');
            const folder = this.resolveWorkspaceFolder(configured, workspaceFolders);
            if (folder) {
                const projectJsonPath = path.join(folder.uri.fsPath, 'openedge-project.json');
                const projectFile = fs.existsSync(projectJsonPath) ? vscode.Uri.file(projectJsonPath) : null;
                nextContexts.push(this.createContext(folder.uri.fsPath, folder.uri, folder, projectFile));
            }
        } else {
            // ── Multi-project mode: three-tier discovery priority ────────────
            const explicitPaths = config.get<string[]>('projectPaths', []).map(p => path.normalize(p)).filter(Boolean);

            if (explicitPaths.length > 0) {
                // Priority 1: User has listed explicit project folders.
                // Only these paths are used; automatic detection is skipped.
                for (let i = 0; i < explicitPaths.length; i++) {
                    const folderPath = explicitPaths[i];
                    const rootUri = vscode.Uri.file(folderPath);
                    const projectJsonPath = path.join(folderPath, 'openedge-project.json');
                    const projectFile = fs.existsSync(projectJsonPath) ? vscode.Uri.file(projectJsonPath) : null;

                    // Try to match against an official VS Code workspace folder so
                    // API calls that require a WorkspaceFolder still work correctly.
                    const knownFolder = workspaceFolders.find(f =>
                        path.normalize(f.uri.fsPath).toLowerCase() === folderPath.toLowerCase()
                    ) ?? this.makeSyntheticFolder(rootUri, i);

                    nextContexts.push(this.createContext(folderPath, rootUri, knownFolder, projectFile));
                }
            } else if (workspaceFolders.length > 1) {
                // Priority 2: Multi-root workspace (.code-workspace) — one context
                // per workspace folder whose root contains openedge-project.json.
                // Recursive findFiles is intentionally avoided to prevent a "Root"
                // folder that physically contains the named sub-folders from
                // producing duplicate contexts.
                for (const folder of workspaceFolders) {
                    const projectJsonPath = path.join(folder.uri.fsPath, 'openedge-project.json');
                    if (fs.existsSync(projectJsonPath)) {
                        const projectFile = vscode.Uri.file(projectJsonPath);
                        nextContexts.push(this.createContext(folder.uri.fsPath, folder.uri, folder, projectFile));
                    }
                }
            } else {
                // Priority 3: Single folder opened directly — detect
                // openedge-project.json at the workspace root, exactly as in
                // single-project legacy mode, but wrapped in a multi-project context.
                const folder = workspaceFolders[0];
                if (folder) {
                    const projectJsonPath = path.join(folder.uri.fsPath, 'openedge-project.json');
                    const projectFile = fs.existsSync(projectJsonPath) ? vscode.Uri.file(projectJsonPath) : null;
                    nextContexts.push(this.createContext(folder.uri.fsPath, folder.uri, folder, projectFile));
                }
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
        return { uri, name: path.basename(uri.fsPath), index };
    }

    getContexts(): ProjectContext[] {
        return [...this.contexts];
    }

    getDefaultContext(): ProjectContext | undefined {
        return this.contexts[0];
    }

    findContextForUri(uri: vscode.Uri): ProjectContext | undefined {
        const matching = this.contexts.filter(ctx => uri.fsPath.startsWith(ctx.rootUri.fsPath + path.sep) || uri.fsPath === ctx.rootUri.fsPath);
        if (matching.length === 0) {
            return undefined;
        }
        return matching.sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];
    }

    private resolveWorkspaceFolder(configured: string | undefined, folders: readonly vscode.WorkspaceFolder[]): vscode.WorkspaceFolder | undefined {
        if (configured) {
            const match = folders.find(folder => path.normalize(folder.uri.fsPath) === path.normalize(configured));
            if (match) {
                return match;
            }
        }
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
            const content = fs.readFileSync(file.fsPath, 'utf-8');
            return JSON.parse(content);
        } catch (error) {
            console.warn('[OEUnit] Failed to parse openedge-project.json:', file.fsPath, error);
            return null;
        }
    }
}
