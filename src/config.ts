import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Instance = "au" | "se" | "no" | "iof";

export const INSTANCE_BASE_URLS: Record<Instance, string> = {
  au: "https://eventor.orienteering.asn.au/api/",
  se: "https://eventor.orientering.se/api/",
  no: "https://eventor.orientering.no/api/",
  iof: "https://eventor.orienteering.sport/api/",
};

export interface Config {
  /** Known instance, or undefined when a custom base URL is used. */
  instance: Instance | undefined;
  baseUrl: string;
  apiKey: string | undefined;
  username: string | undefined;
  password: string | undefined;
  cacheTtlMs: number;
  maxResponseChars: number;
  readOnly: boolean;
  /** Tool names not to register, e.g. for a hosted deployment. */
  excludeTools: string[];
}

/**
 * Load KEY=VALUE pairs from a dotenv-style file into `env`, without
 * overriding variables that are already set.
 */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (env[m[1]] === undefined) env[m[1]] = value;
  }
}

/**
 * Config file locations checked, in order, when variables are not already set:
 * the working directory, the server's own install directory (for git clones),
 * then ~/.config/eventor-mcp.
 */
export function defaultEnvFiles(): string[] {
  const installDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  return [
    join(process.cwd(), ".env"),
    join(installDir, ".env"),
    join(homedir(), ".config", "eventor-mcp", ".env"),
  ];
}

function blankToUndefined(v: string | undefined): string | undefined {
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const instanceRaw = (blankToUndefined(env.EVENTOR_INSTANCE) ?? "au").toLowerCase();
  const customBase = blankToUndefined(env.EVENTOR_BASE_URL);
  if (!customBase && !(instanceRaw in INSTANCE_BASE_URLS)) {
    throw new Error(
      `Unknown EVENTOR_INSTANCE "${instanceRaw}". Use one of ${Object.keys(INSTANCE_BASE_URLS).join(", ")}, or set EVENTOR_BASE_URL.`,
    );
  }
  const instance = customBase ? undefined : (instanceRaw as Instance);
  let baseUrl = customBase ?? INSTANCE_BASE_URLS[instance!];
  if (!baseUrl.endsWith("/")) baseUrl += "/";

  return {
    instance,
    baseUrl,
    apiKey: blankToUndefined(env.EVENTOR_API_KEY),
    username: blankToUndefined(env.EVENTOR_USERNAME),
    password: blankToUndefined(env.EVENTOR_PASSWORD),
    cacheTtlMs: Number(env.EVENTOR_CACHE_TTL_SECONDS ?? 300) * 1000,
    maxResponseChars: Number(env.EVENTOR_MAX_RESPONSE_CHARS ?? 200_000),
    readOnly: /^(1|true|yes)$/i.test(env.EVENTOR_READ_ONLY ?? ""),
    excludeTools: (env.EVENTOR_EXCLUDE_TOOLS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  };
}
