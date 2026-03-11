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
                nextContexts.push(this.buildContextForFolder(folder));
            }
        } else {
            const projectFiles = await vscode.workspace.findFiles('**/openedge-project.json', '**/node_modules/**');
            for (const file of projectFiles) {
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(file);
                if (!workspaceFolder) {
                    continue;
                }
                const rootUri = vscode.Uri.file(path.dirname(file.fsPath));
                const id = rootUri.fsPath;
                nextContexts.push(this.createContext(id, rootUri, workspaceFolder, file));
            }

            if (nextContexts.length === 0 && workspaceFolders.length > 0) {
                // Fallback to workspace folders to avoid empty context list in multi-project mode
                for (const folder of workspaceFolders) {
                    nextContexts.push(this.buildContextForFolder(folder));
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

    private buildContextForFolder(folder: vscode.WorkspaceFolder): ProjectContext {
        const projectPath = path.join(folder.uri.fsPath, 'openedge-project.json');
        const projectFile = fs.existsSync(projectPath) ? vscode.Uri.file(projectPath) : null;
        const projectConfig = projectFile ? this.safeReadProject(projectFile) : null;
        return this.createContext(folder.uri.fsPath, folder.uri, folder, projectFile, projectConfig);
    }

    private createContext(
        id: string,
        rootUri: vscode.Uri,
        workspaceFolder: vscode.WorkspaceFolder,
        projectFile: vscode.Uri | null,
        projectConfig?: any | null
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
