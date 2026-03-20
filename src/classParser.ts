/**
 * ABL class-file parsing utilities shared across the extension.
 * Responsible for extracting the class header, detecting abstract classes,
 * resolving INHERITS chains, and collecting test methods (own and inherited).
 */
import { readFileSync } from 'fs';
import * as vscode from 'vscode';

export interface TestMethod {
    name: string;
    line: number;
    sourceUri?: vscode.Uri; // set for methods inherited from a parent class
}

// Returns the text of the class definition header: from the CLASS keyword
// (matched only at the start of a line) up to the ':' that closes it.
export function extractClassHeader(content: string): string | undefined {
    const classMatch = /^[ \t]*CLASS\b/im.exec(content);
    if (!classMatch) { return undefined; }
    const colon = content.indexOf(':', classMatch.index);
    if (colon === -1) { return undefined; }
    return content.slice(classMatch.index, colon);
}

export function isAbstractClass(content: string): boolean {
    const header = extractClassHeader(content);
    if (!header) { return false; }
    return /\bABSTRACT\b/i.test(header);
}

export function extractSuperClassName(content: string): string | undefined {
    const header = extractClassHeader(content);
    if (!header) { return undefined; }
    const match = header.match(/\bINHERITS\s+([\w.]+)/i);
    return match ? match[1] : undefined;
}

// Synchronous lookup using the pre-built map.
export function findClassFile(className: string, classFileMap: Map<string, string>): string | undefined {
    const suffix = '/' + className.replace(/\./g, '/').toLowerCase() + '.cls';
    for (const [normalized, fsPath] of classFileMap) {
        if (normalized.endsWith(suffix)) {
            return fsPath;
        }
    }
    return undefined;
}

// Extract test methods declared directly in this file's content (no inheritance traversal).
// Handles the full OE METHOD syntax:
//   METHOD [visibility] [STATIC|ABSTRACT] [OVERRIDE] [FINAL] {VOID|return-type} method-name (
// visibility can be PACKAGE-PRIVATE / PACKAGE-PROTECTED (contains hyphens).
// Return type can be a dot-qualified class name.
// All optional modifiers are consumed by (?:[\w.-]+\s+)+ before the name is captured.
export function extractOwnTestMethods(content: string): TestMethod[] {
    const methods: TestMethod[] = [];
    const lines = content.split('\n');
    let isTestAnnotated = false;

    const namedTestRe = /^METHOD\b\s+(?:[\w.-]+\s+)+(test\w+)\s*\(/i;
    const annotatedRe = /^METHOD\b\s+(?:[\w.-]+\s+)+([\w]+)\s*\(/i;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.toLowerCase().includes('@test')) {
            isTestAnnotated = true;
            continue;
        }

        const namedMatch = namedTestRe.exec(line);
        if (namedMatch) {
            methods.push({ name: namedMatch[1], line: i });
            isTestAnnotated = false;
        } else if (isTestAnnotated) {
            const annotatedMatch = annotatedRe.exec(line);
            if (annotatedMatch) {
                methods.push({ name: annotatedMatch[1], line: i });
                isTestAnnotated = false;
            }
        }
    }

    return methods;
}

// Walk the INHERITS chain and collect all test methods, with child methods taking
// precedence over same-named parent methods (i.e. overrides are not duplicated).
export function extractAllTestMethods(
    content: string,
    fileUri: vscode.Uri,
    classFileMap: Map<string, string>,
    visited = new Set<string>()
): TestMethod[] {
    const filePath = fileUri.fsPath;
    if (visited.has(filePath)) { return []; }
    visited.add(filePath);

    const ownMethods = extractOwnTestMethods(content);

    const superClassName = extractSuperClassName(content);
    if (!superClassName) {
        return ownMethods;
    }

    const superFilePath = findClassFile(superClassName, classFileMap);
    if (!superFilePath || visited.has(superFilePath)) {
        return ownMethods;
    }

    try {
        const superContent = readFileSync(superFilePath, 'utf-8');
        const superUri = vscode.Uri.file(superFilePath);
        const parentMethods = extractAllTestMethods(superContent, superUri, classFileMap, visited);

        // Exclude parent methods that the child already defines (overridden)
        const ownNames = new Set(ownMethods.map(m => m.name.toLowerCase()));
        const inherited = parentMethods
            .filter(m => !ownNames.has(m.name.toLowerCase()))
            .map(m => ({ ...m, sourceUri: m.sourceUri ?? superUri }));

        return [...ownMethods, ...inherited];
    } catch {
        return ownMethods;
    }
}
