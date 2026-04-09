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

/**
 * Strips single-line (//) and block (/* ... *\/) comments from a JSON string,
 * returning valid JSON that can be passed to JSON.parse().
 *
 * The parser is state-machine based and correctly ignores comment-like sequences
 * inside string literals (including escaped quotes).
 */
export function stripJsonComments(src: string): string {
    let out = '';
    let i = 0;
    const len = src.length;

    while (i < len) {
        const ch = src[i];

        // String literal — copy verbatim, handling backslash escapes
        if (ch === '"') {
            out += ch;
            i++;
            while (i < len) {
                const sc = src[i];
                out += sc;
                if (sc === '\\') {
                    i++;
                    if (i < len) { out += src[i]; i++; }
                } else if (sc === '"') {
                    i++;
                    break;
                } else {
                    i++;
                }
            }
            continue;
        }

        // Possible comment start
        if (ch === '/' && i + 1 < len) {
            const next = src[i + 1];

            // Single-line comment — skip to end of line
            if (next === '/') {
                i += 2;
                while (i < len && src[i] !== '\n') { i++; }
                continue;
            }

            // Block comment — skip to closing */
            if (next === '*') {
                i += 2;
                while (i + 1 < len) {
                    if (src[i] === '*' && src[i + 1] === '/') { i += 2; break; }
                    i++;
                }
                continue;
            }
        }

        out += ch;
        i++;
    }

    return out;
}
