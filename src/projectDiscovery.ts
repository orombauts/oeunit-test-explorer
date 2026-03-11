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
            const configured = config.get<string>('workspaceFolder');
            const folder = this.resolveWorkspaceFolder(configured, workspaceFolders);
            if (folder) {
                const projectPath = path.join(folder.uri.fsPath, 'openedge-project.json');
                const projectFile = fs.existsSync(projectPath) ? vscode.Uri.file(projectPath) : null;
                nextContexts.push(this.createContext(folder.uri.fsPath, folder.uri, folder, projectFile));
            }
        } else {
            // In multi-project mode, honour exactly the workspace folders defined
            // in the .code-workspace file — one project context per folder that
            // has an openedge-project.json at its root.  Recursive findFiles is
            // intentionally avoided to prevent sub-directories (or a Root folder
            // that physically contains other named workspace folders) from
            // generating unexpected extra contexts.
            for (const folder of workspaceFolders) {
                const projectPath = path.join(folder.uri.fsPath, 'openedge-project.json');
                if (fs.existsSync(projectPath)) {
                    const projectFile = vscode.Uri.file(projectPath);
                    nextContexts.push(this.createContext(folder.uri.fsPath, folder.uri, folder, projectFile));
                }
            }
        }

        nextContexts.sort((a, b) => a.rootUri.fsPath.localeCompare(b.rootUri.fsPath));

        this.contexts = nextContexts;
        this.onDidChangeEmitter.fire(this.getContexts());
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
