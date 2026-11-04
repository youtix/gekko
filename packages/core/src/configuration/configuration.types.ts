export type FileFormat = 'JSON' | 'JSON5' | 'YAML';

/** The error of JSON5.parse, whose message reads "JSON5: <reason> at <line>:<column>", the line and column also given apart */
export type Json5SyntaxError = SyntaxError & { lineNumber: number; columnNumber: number };
