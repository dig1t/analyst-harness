export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SECRET_KEY_RE = /token|secret|password|passwd|api[_-]?key|authorization|cookie/i;

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: 'json' | 'pretty';
  sink?: (line: string) => void;
  bindings?: LogFields;
  now?: () => Date;
}

/** Replace values whose key looks like a credential, recursively. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const format = options.format ?? 'json';
  const sink = options.sink ?? ((line: string) => process.stderr.write(line + '\n'));
  const now = options.now ?? (() => new Date());
  const bindings = options.bindings ?? {};

  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields) => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const merged: LogFields = { ...bindings, ...(fields ?? {}) };
    for (const [k, v] of Object.entries(merged)) merged[k] = serializeError(v);
    const safe = redact(merged) as LogFields;
    if (format === 'json') {
      sink(JSON.stringify({ time: now().toISOString(), level: lvl, msg, ...safe }));
    } else {
      const extra = Object.keys(safe).length ? ' ' + JSON.stringify(safe) : '';
      sink(`${now().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}${extra}`);
    }
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}

/** A logger that discards everything; handy default for tests and libraries. */
export const silentLogger: Logger = createLogger({ level: 'silent' });
