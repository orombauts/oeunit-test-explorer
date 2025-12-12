import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';

// JSON message types
interface TestRequest {
    RequestType: 'TEST';
    TestFile: string;
    TestMethod?: string;
    LogLevel: string;
}

interface PingRequest {
    RequestType: 'PING';
}

interface ShutdownRequest {
    RequestType: 'SHUTDOWN';
}

type ServerRequest = TestRequest | PingRequest | ShutdownRequest;

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

export class OEUnitServerManager {
    private serverProcess: cp.ChildProcess | null = null;
    private outputChannel: vscode.OutputChannel;
    private port: number;
    private timeout: number;
    private isRunning: boolean = false;

    constructor(outputChannel: vscode.OutputChannel, port: number = 5555, timeout: number = 60) {
        this.outputChannel = outputChannel;
        this.port = port;
        this.timeout = timeout;
    }

    async startServer(
        dlcPath: string,
        execName: string,
        oeArgs: string,
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

        const oeArgsArray = oeArgs.split(' ').filter(arg => arg.trim() !== '');

        // Format database aliases for SESSION:PARAMETER
        // Format: "port,logLevel,dbName1:alias1|alias2,dbName2:alias3|alias4,..."
        const dbAliasParams: string[] = [];
        for (const [key, value] of Object.entries(dbAliasEnv)) {
            const dbName = key.replace('OEUNIT_ALIAS_', '').toLowerCase();
            const aliases = value.replace(/,/g, '|'); // Convert commas to pipes
            dbAliasParams.push(`${dbName}:${aliases}`);
        }
        const sessionParam = [String(this.port), loglevel, String(this.timeout), ...dbAliasParams].join(',');

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
            const shutdownRequest: ShutdownRequest = { RequestType: 'SHUTDOWN' };
            await this.sendJsonRequest(shutdownRequest);
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

    async runTest(testFile: string, testMethod: string | undefined, logLevel: string): Promise<TestResponse> {
        if (!this.isRunning) {
            throw new Error('OEUnit server is not running');
        }

        const request: TestRequest = {
            RequestType: 'TEST',
            TestFile: testFile,
            TestMethod: testMethod,
            LogLevel: logLevel
        };

        this.outputChannel.appendLine(`[ServerManager] Sending test request: ${JSON.stringify(request)}`);

        const response = await this.sendJsonRequest<TestResponse>(request);
        this.outputChannel.appendLine(`[ServerManager] Received response status: ${response.Status}`);

        if (response.Summary) {
            this.outputChannel.appendLine(`[ServerManager] Tests: ${response.Summary.Total}, Failures: ${response.Summary.Failures}, Errors: ${response.Summary.Errors}, Skipped: ${response.Summary.Skipped}`);
        }

        return response;
    }

    private async sendJsonRequest<T = TestResponse>(request: ServerRequest): Promise<T> {
        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            let responseData = Buffer.alloc(0);

            client.connect(this.port, 'localhost', () => {
                this.outputChannel.appendLine(`[ServerManager] Connected to server`);
                // Send JSON request
                const requestJson = JSON.stringify(request);
                const buffer = Buffer.from(requestJson, 'utf8');
                client.write(buffer, (err) => {
                    if (err) {
                        this.outputChannel.appendLine(`[ServerManager] Write error: ${err.message}`);
                    } else {
                        this.outputChannel.appendLine(`[ServerManager] Request sent, waiting for response...`);
                    }
                });
            });

            client.on('data', (data) => {
                responseData = Buffer.concat([responseData, data]);
                this.outputChannel.appendLine(`[ServerManager] Received ${data.length} bytes`);
            });

            client.on('end', () => {
                this.outputChannel.appendLine(`[ServerManager] Connection ended`);
                client.destroy();
                
                try {
                    const responseText = responseData.toString('utf8');
                    this.outputChannel.appendLine(`[ServerManager] Response JSON: ${responseText}`);
                    const response = JSON.parse(responseText) as T;
                    resolve(response);
                } catch (error) {
                    reject(new Error(`Failed to parse JSON response: ${error}`));
                }
            });

            client.on('error', (error: any) => {
                this.outputChannel.appendLine(`[ServerManager] Socket error: ${error.message || error.code || error}`);
                this.outputChannel.appendLine(`[ServerManager] Error details: ${JSON.stringify(error)}`);
                client.destroy();
                reject(error);
            });

            // Timeout after configured seconds
            client.setTimeout(this.timeout * 1000, () => {
                this.outputChannel.appendLine(`[ServerManager] Request timeout`);
                client.destroy();
                reject(new Error('Request timeout'));
            });
        });
    }

    async checkServerHealth(): Promise<boolean> {
        try {
            // Send PING and wait for PONG response
            this.outputChannel.appendLine(`[ServerManager] Sending PING to server on port ${this.port}...`);
            const pingRequest: PingRequest = { RequestType: 'PING' };
            const response = await this.sendJsonRequest<TestResponse>(pingRequest);

            if (response.Status === 'OK' && response.Reply === 'PONG') {
                this.outputChannel.appendLine(`[ServerManager] Received PONG - server is healthy`);
                return true;
            } else {
                this.outputChannel.appendLine(`[ServerManager] Unexpected response: ${JSON.stringify(response)}`);
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
