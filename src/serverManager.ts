import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import { Socket } from 'net';
import { log } from './utils';

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
    private serverProcess: ChildProcess | null = null;
    private outputChannel: vscode.OutputChannel;
    private port: number;
    private timeout: number;
    private isRunning: boolean = false;

    constructor(outputChannel: vscode.OutputChannel, port: number = 5555, timeout: number = 60) {
        this.outputChannel = outputChannel;
        this.port = port;
        this.timeout = timeout;
    }

    getPort(): number {
        return this.port;
    }

    private log(message: string): void {
        log(this.outputChannel, 'ServerManager', message);
    }

    async startServer(
        dlcPath: string,
        execName: string,
        oeArgs: string,
        workspaceFolder: string,
        propath: string,
        dbArgs: string[],
        dbAliasEnv: Record<string, string>,
        loglevel: string,
        customEnvVars: Record<string, string> = {}
    ): Promise<boolean> {
        if (this.isRunning) {
            this.log('Server already running');
            return true;
        }

        this.log('Starting OEUnit persistent server...');

        const progresPath = join(dlcPath, 'bin', execName);
        const extensionPath = join(__dirname, '..');
        const oeunitServerPath = join(extensionPath, 'abl', 'OEUnitServer.p');

        if (!existsSync(oeunitServerPath)) {
            this.log(`\n${'='.repeat(80)}`);
            this.log(`ERROR: OEUnitServer.p not found`);
            this.log(`Expected location: ${oeunitServerPath}`);
            this.log(`${'='.repeat(80)}\n`);
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

        if (!existsSync(progresPath)) {
            this.log(`\n${'='.repeat(80)}`);
            this.log(`ERROR: Progress executable not found`);
            this.log(`Expected location: ${progresPath}`);
            this.log(`Check your 'oeunit.exec' setting and DLC path configuration.`);
            this.log(`${'='.repeat(80)}\n`);
            return false;
        }

        this.log(`Command: "${progresPath}" ${args.join(' ')}`);
        this.log(`Port: ${this.port}`);
        this.log(`SESSION:PARAMETER: ${sessionParam}`);

        return new Promise((resolve) => {
            this.serverProcess = spawn(progresPath, args, {
                cwd: workspaceFolder,
                env: {
                    ...process.env,
                    DLC: dlcPath,
                    PROPATH: propath,
                    ...customEnvVars
                }
            });

            this.serverProcess.stdout?.on('data', (data) => {
                this.outputChannel.append(data.toString());
            });

            this.serverProcess.stderr?.on('data', (data) => {
                this.outputChannel.append(data.toString());
            });

            this.serverProcess.on('error', (error) => {
                this.log(`\n${'='.repeat(80)}`);
                this.log(`ERROR: Server process error: ${error.message}`);
                this.log(`${'='.repeat(80)}\n`);
                this.isRunning = false;
            });

            this.serverProcess.on('exit', (code) => {
                if (code !== 0 && code !== null) {
                    this.log(`\n${'='.repeat(80)}`);
                    this.log(`ERROR: Server exited with error code: ${code}`);
                    this.log(`Check the output above for error details.`);
                    this.log(`${'='.repeat(80)}\n`);
                } else {
                    this.log(`Server exited with code: ${code}`);
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
                        this.log(`PING failed, retry ${i + 1}/4...`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }

                if (connected) {
                    this.isRunning = true;
                    this.log('Server started successfully and responding to PING');
                    resolve(true);
                } else {
                    this.log(`\n${'='.repeat(80)}`);
                    this.log('ERROR: Server failed to respond to PING');
                    this.log('The server process may have started but is not responding.');
                    this.log('Check the output above for any error messages.');
                    this.log(`${'='.repeat(80)}\n`);
                    this.stopServer();
                    resolve(false);
                }
            }, 5000);
        });
    }

    killServer(): void {
        if (!this.serverProcess) {
            this.log('No server process to kill');
            return;
        }
        this.log('Force-killing server process...');
        this.serverProcess.kill();
        this.isRunning = false;
        this.serverProcess = null;
        this.log('Server process killed');
    }

    async stopServer(): Promise<void> {
        if (!this.isRunning || !this.serverProcess) {
            return;
        }

        this.log('Stopping server...');

        try {
            // Send shutdown command without waiting for response
            // The server will disconnect immediately after processing the shutdown request
            await this.sendShutdownRequest();
            this.log('Shutdown command sent');
        } catch (error) {
            this.log(`Error sending shutdown: ${error}`);
        }

        // Give it a moment to shutdown gracefully
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Force kill if still running
        if (this.serverProcess && !this.serverProcess.killed) {
            this.serverProcess.kill();
            this.log('Server process killed');
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

        this.log(`Sending test request: ${JSON.stringify(request)}`);

        const response = await this.sendJsonRequest<TestResponse>(request);
        this.log(`Received response status: ${response.Status}`);

        if (response.Summary) {
            this.log(`Tests: ${response.Summary.Total}, Failures: ${response.Summary.Failures}, Errors: ${response.Summary.Errors}, Skipped: ${response.Summary.Skipped}`);
        }

        return response;
    }

    private async sendShutdownRequest(): Promise<void> {
        return new Promise((resolve, reject) => {
            const client = new Socket();
            const shutdownRequest: ShutdownRequest = { RequestType: 'SHUTDOWN' };

            // Use a short timeout for shutdown since we don't expect a response
            const timeoutMs = 2000;
            let shutdownSent = false;

            client.connect(this.port, 'localhost', () => {
                this.log(`Connected to server for shutdown`);
                // Send JSON request
                const requestJson = JSON.stringify(shutdownRequest);
                const buffer = Buffer.from(requestJson, 'utf8');
                client.write(buffer, (err) => {
                    if (err) {
                        this.log(`Write error: ${err.message}`);
                        client.destroy();
                        reject(err);
                    } else {
                        shutdownSent = true;
                        this.log(`Shutdown request sent successfully`);
                        // Don't wait for response, just close the connection
                        client.destroy();
                        resolve();
                    }
                });
            });

            client.on('error', (error: any) => {
                // If shutdown was already sent, ignore errors (expected behavior)
                if (shutdownSent) {
                    this.log(`Connection error after shutdown (expected): ${error.code || error.message}`);
                    client.destroy();
                    resolve();
                } else {
                    this.log(`Socket error: ${error.message || error.code || error}`);
                    client.destroy();
                    reject(error);
                }
            });

            client.on('close', () => {
                if (shutdownSent) {
                    resolve();
                }
            });

            // Short timeout for shutdown
            client.setTimeout(timeoutMs, () => {
                if (shutdownSent) {
                    this.log(`Shutdown timeout (request was sent)`);
                    client.destroy();
                    resolve();
                } else {
                    this.log(`Shutdown connection timeout`);
                    client.destroy();
                    reject(new Error('Shutdown connection timeout'));
                }
            });
        });
    }

    private async sendJsonRequest<T = TestResponse>(request: ServerRequest): Promise<T> {
        return new Promise((resolve, reject) => {
            const client = new Socket();
            let responseData = Buffer.alloc(0);

            client.connect(this.port, 'localhost', () => {
                this.log(`Connected to server`);
                // Send JSON request
                const requestJson = JSON.stringify(request);
                const buffer = Buffer.from(requestJson, 'utf8');
                client.write(buffer, (err) => {
                    if (err) {
                        this.log(`Write error: ${err.message}`);
                    } else {
                        this.log(`Request sent, waiting for response...`);
                    }
                });
            });

            client.on('data', (data) => {
                responseData = Buffer.concat([responseData, data]);
                this.log(`Received ${data.length} bytes`);
            });

            client.on('end', () => {
                this.log(`Connection ended`);
                client.destroy();

                try {
                    const responseText = responseData.toString('utf8');
                    this.log(`Response JSON: ${responseText}`);
                    const response = JSON.parse(responseText) as T;
                    resolve(response);
                } catch (error) {
                    reject(new Error(`Failed to parse JSON response: ${error}`));
                }
            });

            client.on('error', (error: any) => {
                this.log(`Socket error: ${error.message || error.code || error}`);
                this.log(`Error details: ${JSON.stringify(error)}`);
                client.destroy();
                reject(error);
            });

            // Timeout after configured seconds
            client.setTimeout(this.timeout * 1000, () => {
                this.log(`Request timeout`);
                client.destroy();
                reject(new Error('Request timeout'));
            });
        });
    }

    async checkServerHealth(): Promise<boolean> {
        try {
            // Send PING and wait for PONG response
            this.log(`Sending PING to server on port ${this.port}...`);
            const pingRequest: PingRequest = { RequestType: 'PING' };
            const response = await this.sendJsonRequest<TestResponse>(pingRequest);

            if (response.Status === 'OK' && response.Reply === 'PONG') {
                this.log(`Received PONG - server is healthy`);
                return true;
            } else {
                this.log(`Unexpected response: ${JSON.stringify(response)}`);
                return false;
            }
        } catch (error: any) {
            const errorMsg = error.message || error.code || 'Unknown error';
            this.log(`Health check error: ${errorMsg}`);
            return false;
        }
    }

    isServerRunning(): boolean {
        return this.isRunning;
    }
}
