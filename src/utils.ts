import * as vscode from 'vscode';

/**
 * Get formatted timestamp matching OEUnitServer.p format
 * Format: MM/DD/YYYY HH:MM:SS.mmm±HH:MM
 */
export function getTimestamp(): string {
    const now = new Date();
    const pad = (n: number, len = 2) => String(n).padStart(len, '0');
    const [M, D, Y, h, m, s, ms] = [
        now.getMonth() + 1, now.getDate(), now.getFullYear(),
        now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds()
    ];
    const tzOffset = -now.getTimezoneOffset();
    const tz = `${tzOffset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(tzOffset) / 60))}:${pad(Math.abs(tzOffset) % 60)}`;
    return `${pad(M)}/${pad(D)}/${Y} ${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}${tz}`;
}

/**
 * Log a message with timestamp and module name to an output channel
 * @param outputChannel The VS Code output channel to write to
 * @param moduleName The name of the module (e.g., 'ServerManager', 'TestRunner')
 * @param message The message to log
 */
export function log(outputChannel: vscode.OutputChannel, moduleName: string, message: string): void {
    outputChannel.appendLine(`${getTimestamp()} [${moduleName}] ${message}`);
}
