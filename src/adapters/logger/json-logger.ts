import type { Logger, LogFields } from '@/ports/logger'

/**
 * A small JSON logger, deliberately hand-rolled rather than pulled from a library.
 *
 * pino is the obvious choice and was rejected: its transport mechanism spawns worker
 * threads and fights Next's bundler, which is a whole class of problem to debug for a
 * feature we do not need. This is forty lines, has no dependencies, and emits one
 * JSON object per line, which is all that is actually required.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
export type Level = keyof typeof LEVELS

export interface JsonLoggerOptions {
  readonly level?: Level
  /** Human-readable output for a terminal, single-line JSON for anything else. */
  readonly pretty?: boolean
  readonly base?: LogFields
  /** Injected so tests can assert on records without touching stdout. */
  readonly sink?: (line: string) => void
}

export function createJsonLogger(opts: JsonLoggerOptions = {}): Logger {
  const min = LEVELS[opts.level ?? 'info']
  const base = opts.base ?? {}
  const pretty = opts.pretty ?? false
  const sink = opts.sink ?? ((line: string) => process.stdout.write(`${line}\n`))

  function emit(level: Level, fields: LogFields, msg: string): void {
    if (LEVELS[level] < min) return

    const record = { level, time: new Date().toISOString(), msg, ...base, ...fields }

    if (pretty) {
      const rest = Object.entries(record)
        .filter(([k]) => k !== 'level' && k !== 'time' && k !== 'msg')
        .map(([k, v]) => `${k}=${format(v)}`)
        .join(' ')
      sink(`${level.toUpperCase().padEnd(5)} ${msg}${rest ? `  ${rest}` : ''}`)
      return
    }

    sink(safeStringify(record))
  }

  const make = (bound: LogFields): Logger => ({
    debug: (f, m) => emit('debug', { ...bound, ...f }, m),
    info: (f, m) => emit('info', { ...bound, ...f }, m),
    warn: (f, m) => emit('warn', { ...bound, ...f }, m),
    error: (f, m) => emit('error', { ...bound, ...f }, m),
    child: (f) => make({ ...bound, ...f }),
  })

  return make({})
}

function format(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.message
  return safeStringify(v)
}

/** Never let a logging call throw. A cyclic field is a nuisance, not an outage. */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, replacer) ?? 'null'
  } catch {
    return '"[unserialisable]"'
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (typeof value === 'bigint') return value.toString()
  return value
}

/** A logger that collects records in memory, for assertions in tests. */
export function collectingLogger(level: Level = 'debug'): Logger & { records: string[] } {
  const records: string[] = []
  const logger = createJsonLogger({ level, sink: (l) => records.push(l) })
  return Object.assign(logger, { records })
}
