#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultEnvFiles, loadConfig, loadEnvFile } from "./config.js";
import { createServer } from "./server.js";

async function main() {
  for (const file of defaultEnvFiles()) loadEnvFile(file);
  const config = loadConfig();
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; diagnostics go to stderr.
  console.error(
    `eventor-mcp connected to ${config.baseUrl}` +
      (config.apiKey ? "" : " (warning: EVENTOR_API_KEY not set)") +
      (config.readOnly ? " [read-only]" : ""),
  );
}

main().catch((err) => {
  console.error(`eventor-mcp failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
