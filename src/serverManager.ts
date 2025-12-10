import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';

export class OEUnitServerManager {
    private serverProcess: cp.ChildProcess | null = null;
    private outputChannel: vscode.OutputChannel;
    private port: number;
    private isRunning: boolean = false;

    constructor(outputChannel: vscode.OutputChannel, port: number = 5555) {
        this.outputChannel = outputChannel;
        this.port = port;
    }

    async startServer(
        dlcPath: string,
        execName: string,
        oeArgs: string,
        oeunitHome: string,
        oeunitRunner: string,
        workspaceFolder: string,
        propath: string,
        dbArgs: string[],
        dbAliasEnv: Record<string, string>,
        loglevel: string
    ): Promise<boolean> {
        if (this.isRunning) {
            this.outputChannel.appendLine('[ServerManager] Server already running');
            return true;
        }

        this.outputChannel.appendLine('[ServerManager] Starting OEUnit persistent server...');

        const progresPath = path.join(dlcPath, 'bin', execName);
        const extensionPath = path.join(__dirname, '..');
        const oeunitServerPath = path.join(extensionPath, 'abl', 'OEUnitServer.p');

        if (!fs.existsSync(oeunitServerPath)) {
            this.outputChannel.appendLine(`\n${'='.repeat(80)}`);
            this.outputChannel.appendLine(`[ERROR] OEUnitServer.p not found`);
            this.outputChannel.appendLine(`Expected location: ${oeunitServerPath}`);
            this.outputChannel.appendLine(`${'='.repeat(80)}\n`);
            return false;
        }

        const runnerPath = path.join(oeunitHome, oeunitRunner);
        const oeArgsArray = oeArgs.split(' ').filter(arg => arg.trim() !== '');

        // Format database aliases for SESSION:PARAMETER
        // Format: "port,logLevel,dbName1:alias1|alias2,dbName2:alias3|alias4,..."
        const dbAliasParams: string[] = [];
        for (const [key, value] of Object.entries(dbAliasEnv)) {
            const dbName = key.replace('OEUNIT_ALIAS_', '').toLowerCase();
            const aliases = value.replace(/,/g, '|'); // Convert commas to pipes
            dbAliasParams.push(`${dbName}:${aliases}`);
        }
        const sessionParam = [String(this.port), loglevel, ...dbAliasParams].join(',');

        const args = [
            '-b',
            ...oeArgsArray,
            ...dbArgs,
            '-p', oeunitServerPath,
            '-param', sessionParam
        ];

        if (!fs.existsSync(progresPath)) {
            this.outputChannel.appendLine(`\n${'='.repeat(80)}`);
            this.outputChannel.appendLine(`[ERROR] Progress executable not found`);
            this.outputChannel.appendLine(`Expected location: ${progresPath}`);
            this.outputChannel.appendLine(`Check your 'oeunit.exec' setting and DLC path configuration.`);
            this.outputChannel.appendLine(`${'='.repeat(80)}\n`);
            return false;
        }

        this.outputChannel.appendLine(`[ServerManager] Command: "${progresPath}" ${args.join(' ')}`);
        this.outputChannel.appendLine(`[ServerManager] Port: ${this.port}`);
        this.outputChannel.appendLine(`[ServerManager] SESSION:PARAMETER: ${sessionParam}`);

        return new Promise((resolve) => {
            this.serverProcess = cp.spawn(progresPath, args, {
                cwd: workspaceFolder,
                env: {
                    ...process.env,
                    DLC: dlcPath,
                    PROPATH: propath
                }
            });

            this.serverProcess.stdout?.on('data', (data) => {
                this.outputChannel.append(data.toString());
            });

            this.serverProcess.stderr?.on('data', (data) => {
                this.outputChannel.append(data.toString());
            });

            this.serverProcess.on('error', (error) => {
                this.outputChannel.appendLine(`\n${'='.repeat(80)}`);
                this.outputChannel.appendLine(`[ERROR] Server process error: ${error.message}`);
                this.outputChannel.appendLine(`${'='.repeat(80)}\n`);
                this.isRunning = false;
            });

            this.serverProcess.on('exit', (code) => {
                if (code !== 0 && code !== null) {
                    this.outputChannel.appendLine(`\n${'='.repeat(80)}`);
                    this.outputChannel.appendLine(`[ERROR] Server exited with error code: ${code}`);
                    this.outputChannel.appendLine(`Check the output above for error details.`);
                    this.outputChannel.appendLine(`${'='.repeat(80)}\n`);
                } else {
                    this.outputChannel.appendLine(`[ServerManager] Server exited with code: ${code}`);
                }
                this.isRunning = false;
                this.serverProcess = null;
            });

            // Wait a bit for server to start, then use PING/PONG to verify it's ready
            setTimeout(async () => {
                let connected = false;
                for (let i = 0; i < 5; i++) {
                    connected = await this.checkServerHealth();
                    if (connected) break;
                    if (i < 4) {
                        this.outputChannel.appendLine(`[ServerManager] PING failed, retry ${i + 1}/4...`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
                
                if (connected) {
                    this.isRunning = true;
                    this.outputChannel.appendLine('[ServerManager] Server started successfully and responding to PING');
                    resolve(true);
                } else {
                    this.outputChannel.appendLine(`\n${'='.repeat(80)}`);
                    this.outputChannel.appendLine('[ERROR] Server failed to respond to PING');
                    this.outputChannel.appendLine('The server process may have started but is not responding.');
                    this.outputChannel.appendLine('Check the output above for any error messages.');
                    this.outputChannel.appendLine(`${'='.repeat(80)}\n`);
                    this.stopServer();
                    resolve(false);
                }
            }, 2000);
        });
    }

    async stopServer(): Promise<void> {
        if (!this.isRunning || !this.serverProcess) {
            return;
        }

        this.outputChannel.appendLine('[ServerManager] Stopping server...');

        try {
            // Send shutdown command
            await this.sendRequest('SHUTDOWN');
            this.outputChannel.appendLine('[ServerManager] Shutdown command sent');
        } catch (error) {
            this.outputChannel.appendLine(`[ServerManager] Error sending shutdown: ${error}`);
        }

        // Give it a moment to shutdown gracefully
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Force kill if still running
        if (this.serverProcess && !this.serverProcess.killed) {
            this.serverProcess.kill();
            this.outputChannel.appendLine('[ServerManager] Server process killed');
        }

        this.isRunning = false;
        this.serverProcess = null;
    }

    async runTest(runnerPath: string, outputDir: string, testFile: string, logLevel: string): Promise<string> {
        if (!this.isRunning) {
            throw new Error('OEUnit server is not running');
        }

        const request = `${runnerPath},${outputDir},${testFile},${logLevel}`;
        this.outputChannel.appendLine(`[ServerManager] Sending test request: ${request}`);

        const response = await this.sendRequest(request);
        this.outputChannel.appendLine(`[ServerManager] Received response: ${response}`);

        return response;
    }

    async sendRequest(request: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            let response = '';

            client.connect(this.port, 'localhost', () => {
                this.outputChannel.appendLine(`[ServerManager] Connected to server, sending: ${request}`);
                // Write the request as a buffer with proper encoding
                const buffer = Buffer.from(request, 'utf8');
                client.write(buffer, (err) => {
                    if (err) {
                        this.outputChannel.appendLine(`[ServerManager] Write error: ${err.message}`);
                    } else {
                        this.outputChannel.appendLine(`[ServerManager] Data written successfully, waiting for response...`);
                    }
                });
            });

            client.on('data', (data) => {
                response += data.toString('utf8');
                this.outputChannel.appendLine(`[ServerManager] Received data: ${data.toString('utf8')}`);
                // Close connection after receiving response
                client.end();
            });

            client.on('end', () => {
                this.outputChannel.appendLine(`[ServerManager] Connection ended`);
                client.destroy();
                resolve(response);
            });

            client.on('error', (error) => {
                this.outputChannel.appendLine(`[ServerManager] Socket error: ${error.message}`);
                client.destroy();
                reject(error);
            });

            // Timeout after 60 seconds
            client.setTimeout(60000, () => {
                this.outputChannel.appendLine(`[ServerManager] Request timeout`);
                client.destroy();
                reject(new Error('Request timeout'));
            });
        });
    }

    private async checkServerHealth(): Promise<boolean> {
        try {
            // Send PING and wait for PONG response
            this.outputChannel.appendLine(`[ServerManager] Sending PING to server on port ${this.port}...`);
            const response = await this.sendRequest('PING');
            
            if (response === 'PONG') {
                this.outputChannel.appendLine(`[ServerManager] Received PONG - server is healthy`);
                return true;
            } else {
                this.outputChannel.appendLine(`[ServerManager] Unexpected response: ${response}`);
                return false;
            }
        } catch (error: any) {
            const errorMsg = error.message || error.code || 'Unknown error';
            this.outputChannel.appendLine(`[ServerManager] Health check error: ${errorMsg}`);
            return false;
        }
    }

    isServerRunning(): boolean {
        return this.isRunning;
    }
}
