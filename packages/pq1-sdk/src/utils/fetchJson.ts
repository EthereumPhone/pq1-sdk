// A JSON GET/POST with a timeout, for the bundler, chain RPC, Safe and CoW
// clients.

/** Options for `fetchJson`. */
export interface FetchJsonOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** Sent as JSON. */
  body?: unknown
  /** Abort after this long. */
  timeoutMs: number
  /** Also abort when this signal does. */
  signal?: AbortSignal
  fetch?: typeof fetch
}

/** An HTTP answer that isn't 2xx. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string
  ) {
    super(`HTTP ${status} from ${redactUrl(url)}: ${body.slice(0, 200)}`)
    this.name = 'HttpError'
  }
}

/** `url` without its query string, which often carries an API key. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : `${url.slice(0, q)}?…`
}

/** Fetch `url` and parse the JSON body. Throws `HttpError` on a non-2xx
 *  answer, and a plain `Error` on a timeout, a network failure or a body
 *  that isn't JSON. */
export async function fetchJson(url: string, options: FetchJsonOptions): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`timed out after ${options.timeoutMs} ms`)),
    options.timeoutMs
  )
  const onCallerAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  try {
    const headers: Record<string, string> = { ...options.headers }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const resp = await (options.fetch ?? fetch)(url, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    })
    const text = await resp.text()
    if (!resp.ok) throw new HttpError(resp.status, text, url)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`${redactUrl(url)} answered with something that isn't JSON`)
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onCallerAbort)
  }
}
