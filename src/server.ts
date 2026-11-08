import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { EventorClient, EventorError, parseXml, type AuthMode, type QueryValue } from "./client.js";
import type { Config } from "./config.js";
import { confirmParam, ENDPOINTS, endpointsFor, type EndpointDef } from "./endpoints.js";

export const VERSION = "0.2.0";

/** Tools registered here rather than generated from the endpoint table. */
const UTILITY_TOOLS = ["eventor_get", "clear_cache"];

const rawParam = z
  .boolean()
  .optional()
  .describe("Return Eventor's XML unchanged instead of converting it to JSON (e.g. to feed event software).");

/** Fill in times for date-only from/to values, as Eventor expects yyyy-mm-dd hh:mm:ss. */
export function normaliseDate(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return /^to/i.test(key) ? `${value} 23:59:59` : `${value} 00:00:00`;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return `${value}:00`;
  return value;
}

/**
 * Text returned to the model: JSON for XML responses (unless raw), optionally
 * filtered locally, truncated to the configured limit.
 */
export function formatBody(body: string, raw: boolean, maxChars: number, filter?: (doc: unknown) => unknown): string {
  const looksXml = body.trimStart().startsWith("<");
  let text = body;
  if (!raw && looksXml) {
    try {
      const doc = parseXml(body);
      text = JSON.stringify(filter ? filter(doc) : doc);
    } catch {
      text = body;
    }
  }
  if (text.length > maxChars) {
    text =
      text.slice(0, maxChars) +
      `\n\n[Truncated: response was ${text.length.toLocaleString()} characters, limit is ${maxChars.toLocaleString()}. ` +
      `Narrow the request (dates, IDs, top, fewer include* flags) or raise EVENTOR_MAX_RESPONSE_CHARS.]`;
  }
  return text;
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof EventorError || err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
}

function resolveAuth(def: EndpointDef, config: Config, useLogin: boolean | undefined): AuthMode {
  if (def.auth !== "organiser") return def.auth;
  if (useLogin) return "person";
  return config.apiKey ? "apiKey" : "person";
}

/** Split tool arguments into path parameters, query parameters and control values. */
export function buildRequest(def: EndpointDef, args: Record<string, unknown>) {
  const { raw, confirm: _confirm, xml, useLogin, ...rest } = args;
  let path = def.path;
  const query: Record<string, QueryValue> = { ...def.fixedQuery };
  for (const [key, value] of Object.entries(rest)) {
    if (def.localParams && key in def.localParams) continue;
    if (path.includes(`{${key}}`)) {
      path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
    } else {
      query[key] = normaliseDate(key, value) as QueryValue;
    }
  }
  return {
    path,
    query,
    raw: raw === true,
    body: typeof xml === "string" ? xml : undefined,
    useLogin: useLogin as boolean | undefined,
  };
}

function registerEndpoint(server: McpServer, client: EventorClient, def: EndpointDef) {
  // useLogin can only fail unless a personal login is configured, so don't offer it.
  const { useLogin: _useLogin, ...paramsWithoutLogin } = def.params;
  const hasLogin = Boolean(client.config.username && client.config.password);
  // Strict: a mistyped filter must be an error, not silently return unfiltered data.
  const inputSchema = z.strictObject({
    ...(hasLogin ? def.params : paramsWithoutLogin),
    ...def.localParams,
    ...(def.write ? { confirm: confirmParam } : { raw: rawParam }),
  });
  const notes = [
    `Calls ${def.method} /api/${def.path}; returns ${def.returns}.`,
    def.experimental ? "Experimental: undocumented organiser endpoint, behaviour may differ between Eventor instances." : "",
  ]
    .filter(Boolean)
    .join(" ");

  server.registerTool(
    def.name,
    {
      title: def.title,
      description: `${def.description} ${notes}`,
      inputSchema,
      annotations: {
        title: def.title,
        readOnlyHint: !def.write,
        destructiveHint: !!def.write,
        idempotentHint: def.method !== "POST",
        openWorldHint: true,
      },
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const req = buildRequest(def, args);
        const res = await client.request(req.path, {
          method: def.method,
          query: req.query,
          body: def.xmlBody ? req.body : undefined,
          auth: resolveAuth(def, client.config, req.useLogin),
        });
        const filter = def.filter ? (doc: unknown) => def.filter!(doc, args) : undefined;
        const text = formatBody(res.body, req.raw, client.config.maxResponseChars, filter);
        return { content: [{ type: "text", text: text || `HTTP ${res.status} (empty response)` }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

export function createServer(config: Config, client = new EventorClient(config)): McpServer {
  const server = new McpServer(
    { name: "eventor", version: VERSION },
    {
      instructions:
        `Tools for the Eventor orienteering API at ${config.baseUrl}. ` +
        "Start with get_api_key_organisation to learn your own organisation ID; many member, start, result and activity tools only accept that ID. " +
        "Prefer filters (dates, IDs, top) to keep responses small. Tools marked WRITES TO EVENTOR change public data: only call them after the user explicitly approves the exact change.",
    },
  );

  // A misspelled exclusion would silently expose the tool it meant to hide.
  const known = new Set([...ENDPOINTS.map((e) => e.name), ...UTILITY_TOOLS]);
  const unknown = config.excludeTools.filter((name) => !known.has(name));
  if (unknown.length) throw new Error(`EVENTOR_EXCLUDE_TOOLS names unknown tools: ${unknown.join(", ")}`);
  const excluded = new Set(config.excludeTools);

  for (const def of endpointsFor(config.instance, config.readOnly)) {
    if (!excluded.has(def.name)) registerEndpoint(server, client, def);
  }

  if (!excluded.has("eventor_get")) {
    server.registerTool(
      "eventor_get",
      {
        title: "Raw Eventor GET",
        description:
          "Escape hatch: GET any Eventor API path (relative to /api/) with arbitrary query parameters, for endpoints not covered by a dedicated tool.",
        inputSchema: z.strictObject({
          path: z.string().min(1).describe('Path relative to the API root, e.g. "events" or "event/12345".'),
          query: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .optional()
            .describe("Query parameters."),
          auth: z
            .enum(["apiKey", "person", "both", "none"])
            .default("apiKey")
            .describe("Credentials to send: club API key, personal login, both, or none."),
          raw: rawParam,
        }),
        annotations: { title: "Raw Eventor GET", readOnlyHint: true, openWorldHint: true },
      },
      async ({ path, query, auth, raw }): Promise<CallToolResult> => {
        try {
          if (/^https?:/i.test(path) || path.includes("..")) throw new Error("path must be relative to the Eventor API root.");
          const res = await client.request(path, { query, auth });
          return { content: [{ type: "text", text: formatBody(res.body, raw === true, client.config.maxResponseChars) }] };
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  if (!excluded.has("clear_cache")) {
    server.registerTool(
      "clear_cache",
      {
        title: "Clear cache",
        description: `Clear cached Eventor responses (GET responses are cached for ${Math.round(config.cacheTtlMs / 1000)}s, as Eventor's terms ask).`,
        inputSchema: z.strictObject({}),
        annotations: { title: "Clear cache", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async (): Promise<CallToolResult> => ({
        content: [{ type: "text", text: `Cleared ${client.clearCache()} cached responses.` }],
      }),
    );
  }

  return server;
}
