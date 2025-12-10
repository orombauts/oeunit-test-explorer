import * as vscode from 'vscode';
import * as fs from 'fs';
import * as xml2js from 'xml2js';

export interface TestResult {
    name: string;
    status: 'passed' | 'failed' | 'error' | 'skipped';
    time: number;
    message?: string;
}

export class OEUnitResultParser {
    async parseResultFile(xmlPath: string, outputChannel: vscode.OutputChannel): Promise<TestResult[]> {
        try {
            const xmlContent = fs.readFileSync(xmlPath, 'utf-8');
            const parser = new xml2js.Parser();
            const result = await parser.parseStringPromise(xmlContent);

            const results: TestResult[] = [];

            // OEUnit XML format typically follows JUnit format
            if (result.testsuite) {
                const testsuite = result.testsuite;
                outputChannel.appendLine(`\nTest Results Summary:`);
                outputChannel.appendLine(`  Total: ${testsuite.$.tests || 0}`);
                outputChannel.appendLine(`  Failures: ${testsuite.$.failures || 0}`);
                outputChannel.appendLine(`  Errors: ${testsuite.$.errors || 0}`);
                outputChannel.appendLine(`  Time: ${testsuite.$.time || 0}s`);

                if (testsuite.testcase) {
                    const testcases = Array.isArray(testsuite.testcase) ? testsuite.testcase : [testsuite.testcase];
                    
                    outputChannel.appendLine(`\nIndividual Test Results:`);
                    
                    for (const testcase of testcases) {
                        const testName = testcase.$.name || 'Unknown';
                        const time = parseFloat(testcase.$.time || '0');
                        
                        let status: 'passed' | 'failed' | 'error' | 'skipped' = 'passed';
                        let message = '';

                        if (testcase.failure) {
                            status = 'failed';
                            const failures = Array.isArray(testcase.failure) ? testcase.failure : [testcase.failure];
                            message = failures[0].$.message || failures[0]._ || 'Test failed';
                            outputChannel.appendLine(`  ✗ ${testName} - FAILED`);
                            outputChannel.appendLine(`    ${message}`);
                        } else if (testcase.error) {
                            status = 'error';
                            const errors = Array.isArray(testcase.error) ? testcase.error : [testcase.error];
                            message = errors[0].$.message || errors[0]._ || 'Test error';
                            outputChannel.appendLine(`  ✗ ${testName} - ERROR`);
                            outputChannel.appendLine(`    ${message}`);
                        } else if (testcase.skipped) {
                            status = 'skipped';
                            message = 'Test skipped/ignored';
                            outputChannel.appendLine(`  ○ ${testName} - SKIPPED`);
                        } else {
                            outputChannel.appendLine(`  ✓ ${testName} - PASSED (${time}s)`);
                        }

                        results.push({
                            name: testName,
                            status: status,
                            time: time,
                            message: message
                        });
                    }
                }
            } else if (result.testsuites) {
                // Multiple test suites
                const testsuites = result.testsuites;
                let totalTests = 0;
                let totalFailures = 0;
                let totalErrors = 0;

                if (testsuites.testsuite) {
                    const suites = Array.isArray(testsuites.testsuite) ? testsuites.testsuite : [testsuites.testsuite];
                    
                    for (const suite of suites) {
                        totalTests += parseInt(suite.$.tests || '0');
                        totalFailures += parseInt(suite.$.failures || '0');
                        totalErrors += parseInt(suite.$.errors || '0');

                        if (suite.testcase) {
                            const testcases = Array.isArray(suite.testcase) ? suite.testcase : [suite.testcase];
                            
                            for (const testcase of testcases) {
                                const testName = testcase.$.name || 'Unknown';
                                const time = parseFloat(testcase.$.time || '0');
                                
                                let status: 'passed' | 'failed' | 'error' | 'skipped' = 'passed';
                                let message = '';

                                if (testcase.failure) {
                                    status = 'failed';
                                    const failures = Array.isArray(testcase.failure) ? testcase.failure : [testcase.failure];
                                    message = failures[0].$.message || failures[0]._ || 'Test failed';
                                } else if (testcase.error) {
                                    status = 'error';
                                    const errors = Array.isArray(testcase.error) ? testcase.error : [testcase.error];
                                    message = errors[0].$.message || errors[0]._ || 'Test error';
                                } else if (testcase.skipped) {
                                    status = 'skipped';
                                    message = 'Test skipped/ignored';
                                }

                                results.push({
                                    name: testName,
                                    status: status,
                                    time: time,
                                    message: message
                                });
                            }
                        }
                    }
                }

                outputChannel.appendLine(`\nOverall Test Results:`);
                outputChannel.appendLine(`  Total: ${totalTests}`);
                outputChannel.appendLine(`  Failures: ${totalFailures}`);
                outputChannel.appendLine(`  Errors: ${totalErrors}`);
            }

            return results;
        } catch (error) {
            outputChannel.appendLine(`Error parsing XML results: ${error}`);
            return [];
        }
    }
}
