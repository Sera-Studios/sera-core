/**
 * @fileoverview Structured logger for sera-core
 * @module sera-core/logging/Logger
 *
 * Provides structured logging with JSON and human-readable text output modes.
 * No external dependencies - uses process.stdout.write / process.stderr.write.
 *
 * Usage:
 *   import { createLogger, configureLogging } from './logging/Logger';
 *
 *   configureLogging({ format: 'json', level: 'info' });
 *   const log = createLogger('mcp');
 *   log.info('Tool call', { tool: 'submit_finding', durationMs: 45 });
 */

export interface LoggerOptions {
    format: 'json' | 'text';
    level: 'debug' | 'info' | 'warn' | 'error';
}

export interface LogEntry {
    timestamp: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    module: string;
    message: string;
    data?: Record<string, unknown>;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_VALUE: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
    debug: 'DEBUG',
    info: 'INFO ',
    warn: 'WARN ',
    error: 'ERROR',
};

// ============================================================================
// GLOBAL STATE
// ============================================================================

let globalOptions: LoggerOptions = { format: 'text', level: 'info' };
let captureCallback: ((entry: LogEntry) => void) | undefined;
let outputStream: NodeJS.WritableStream = process.stdout;
let errorStream: NodeJS.WritableStream = process.stderr;

/**
 * Configure global logging defaults. Call once at startup before creating loggers.
 */
export function configureLogging(options: Partial<LoggerOptions>): void {
    globalOptions = { ...globalOptions, ...options };
}

/**
 * Create a logger for a module using global defaults.
 */
export function createLogger(module: string): Logger {
    return new Logger(module, { ...globalOptions });
}

/**
 * Set a capture callback that receives every log entry (for testnet LogBuffer integration).
 */
export function setCaptureCallback(cb: ((entry: LogEntry) => void) | undefined): void {
    captureCallback = cb;
}

/**
 * Override the output stream (for testing - redirect from stdout/stderr).
 */
export function setOutputStream(stdout: NodeJS.WritableStream, stderr?: NodeJS.WritableStream): void {
    outputStream = stdout;
    errorStream = stderr || stdout;
}

/**
 * Reset output streams to defaults (for test cleanup).
 */
export function resetOutputStream(): void {
    outputStream = process.stdout;
    errorStream = process.stderr;
}

// ============================================================================
// LOGGER CLASS
// ============================================================================

export class Logger {
    private module: string;
    private options: LoggerOptions;
    private minLevel: number;

    constructor(module: string, options?: LoggerOptions) {
        this.module = module;
        this.options = options || { ...globalOptions };
        this.minLevel = LEVEL_VALUE[this.options.level];
    }

    debug(message: string, data?: Record<string, unknown>): void {
        this.log('debug', message, data);
    }

    info(message: string, data?: Record<string, unknown>): void {
        this.log('info', message, data);
    }

    warn(message: string, data?: Record<string, unknown>): void {
        this.log('warn', message, data);
    }

    error(message: string, data?: Record<string, unknown>): void {
        this.log('error', message, data);
    }

    /**
     * Create a child logger with a different module name but inherited options.
     */
    child(module: string): Logger {
        return new Logger(module, { ...this.options });
    }

    private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
        if (LEVEL_VALUE[level] < this.minLevel) return;

        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            module: this.module,
            message,
            ...(data !== undefined ? { data } : {}),
        };

        // Capture callback (for testnet LogBuffer)
        if (captureCallback) {
            captureCallback(entry);
        }

        // Format and write
        const line = this.options.format === 'json'
            ? this.formatJson(entry)
            : this.formatText(entry);

        // Error-level goes to stderr in text mode
        if (level === 'error' && this.options.format === 'text') {
            errorStream.write(line);
        } else {
            outputStream.write(line);
        }
    }

    private formatJson(entry: LogEntry): string {
        return JSON.stringify(entry) + '\n';
    }

    private formatText(entry: LogEntry): string {
        // Format: HH:MM:SS.mmm [module] LEVEL  message key=value ...
        const time = entry.timestamp.substring(11, 23); // HH:MM:SS.mmm from ISO string
        let line = `${time} [${entry.module}] ${LEVEL_LABEL[entry.level]}  ${entry.message}`;

        if (entry.data) {
            for (const [key, value] of Object.entries(entry.data)) {
                line += ` ${key}=${value}`;
            }
        }

        return line + '\n';
    }
}
