import { XMLParser } from "fast-xml-parser";
import type { Config } from "./config.js";

/** Which credentials a request carries. */
export type AuthMode = "apiKey" | "person" | "both" | "none";

export type QueryValue = string | number | boolean | Array<string | number> | undefined | null;

export interface RequestOptions {
  method?: "GET" | "PUT" | "POST";
  query?: Record<string, QueryValue>;
  auth?: AuthMode;
  body?: string;
  /** Extra headers, e.g. Username/Password for authenticatePerson. */
  headers?: Record<string, string>;
  /** Skip the response cache (GET only). */
  noCache?: boolean;
}

export interface EventorResponse {
  status: number;
  contentType: string;
  body: string;
  fromCache: boolean;
}

export class EventorError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "EventorError";
  }
}

/** Turn a query object into Eventor's conventions: arrays become comma-separated lists. */
export function buildQuery(query: Record<string, QueryValue> = {}): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(","));
    } else {
      params.set(key, String(value));
    }
  }
  return params;
}

type FetchFn = typeof fetch;

export class EventorClient {
  private cache = new Map<string, { expires: number; response: EventorResponse }>();

  constructor(
    readonly config: Config,
    private fetchFn: FetchFn = fetch,
  ) {}

  private authHeaders(mode: AuthMode): Record<string, string> {
    const headers: Record<string, string> = {};
    if (mode === "apiKey" || mode === "both") {
      if (!this.config.apiKey) {
        throw new EventorError("EVENTOR_API_KEY is not set. Add your club's Eventor API key to the server's environment.");
      }
      headers.ApiKey = this.config.apiKey;
    }
    if (mode === "person" || mode === "both") {
      if (!this.config.username || !this.config.password) {
        throw new EventorError(
          "This endpoint needs a personal Eventor login. Set EVENTOR_USERNAME and EVENTOR_PASSWORD in the server's environment.",
        );
      }
      headers.Username = this.config.username;
      headers.Password = this.config.password;
    }
    return headers;
  }

  url(path: string, query?: Record<string, QueryValue>): string {
    const base = new URL(this.config.baseUrl);
    const url = new URL(path.replace(/^\/+/, "").replace(/^api\//, ""), base);
    // The credentials go wherever this URL points, so check what the parser
    // produced. It forgives things a check on the input can't see: leading
    // spaces, tabs inside the scheme, backslashes, encoded dots.
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new EventorError("Refused: the path must stay within the Eventor API root.");
    }
    const qs = buildQuery(query).toString();
    if (qs) url.search = qs;
    return url.toString();
  }

  async request(path: string, opts: RequestOptions = {}): Promise<EventorResponse> {
    const method = opts.method ?? "GET";
    const auth = opts.auth ?? "apiKey";
    const url = this.url(path, opts.query);
    const headers: Record<string, string> = {
      Accept: "application/xml, text/xml, */*",
      ...this.authHeaders(auth),
      ...opts.headers,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/xml; charset=utf-8";

    const cacheKey = `${auth}|${url}|${opts.headers ? Object.keys(opts.headers).join() : ""}`;
    const cacheable = method === "GET" && !opts.noCache && !opts.headers && this.config.cacheTtlMs > 0;
    if (cacheable) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expires > Date.now()) return { ...hit.response, fromCache: true };
    }

    let res: Response;
    try {
      // No redirects: fetch would carry the ApiKey header to wherever one pointed.
      res = await this.fetchFn(url, {
        method,
        headers,
        body: opts.body,
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new EventorError(`Request to Eventor failed: ${(err as Error).message}`);
    }
    const body = await res.text();
    const response: EventorResponse = {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body,
      fromCache: false,
    };
    if (!res.ok) {
      throw new EventorError(describeHttpError(res.status, method, url, body), res.status, body);
    }
    if (cacheable) this.cache.set(cacheKey, { expires: Date.now() + this.config.cacheTtlMs, response });
    // Any write invalidates cached reads, since they may now be stale.
    if (method !== "GET") this.cache.clear();
    return response;
  }

  clearCache(): number {
    const n = this.cache.size;
    this.cache.clear();
    return n;
  }
}

function describeHttpError(status: number, method: string, url: string, body: string): string {
  const path = new URL(url).pathname;
  // IIS error pages are HTML; their <title> is the useful part.
  const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1];
  const snippet = (title ?? body).replace(/\s+/g, " ").trim().slice(0, 500);
  const hint =
    status === 401 || status === 403
      ? " Check the API key / login, and that the organisation ID is your own club's (many endpoints only allow your own organisation)."
      : status === 404
        ? " The resource or endpoint was not found on this Eventor instance."
        : "";
  return `Eventor returned HTTP ${status} for ${method} ${path}.${hint}${snippet ? ` Response: ${snippet}` : ""}`;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  // Keep values as strings: IDs like "0123" and card numbers must not be coerced.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Eventor list wrappers (EventList > Event, PersonList > Person, ...) should
  // always yield arrays, even with a single child.
  isArray: (name, jpath) => {
    const parts = String(jpath).split(".");
    const parent = parts[parts.length - 2];
    return parent !== undefined && parent === `${name}List`;
  },
});

/**
 * Strip XML noise that carries no information for a reader: namespace
 * declarations, and `<X value="..."/>` wrappers, which become plain values.
 */
function compact(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compact);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@xmlns")) continue;
    out[key] = compact(value);
  }
  const keys = Object.keys(out);
  if (keys.length === 1 && keys[0] === "@value") return out["@value"];
  return out;
}

/** Parse an Eventor XML document into a plain JSON-able object. */
export function parseXml(xml: string): unknown {
  const doc = parser.parse(xml) as Record<string, unknown>;
  delete doc["?xml"];
  return compact(doc);
}
