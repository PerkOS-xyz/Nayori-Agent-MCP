#!/usr/bin/env node
// Nayori agent MCP server (stdio, Stacks mainnet): provider or client, depending on the key.
// stdout is reserved for the MCP protocol; diagnostics go to stderr and never contain keys.

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as chain from "./lib/chain.mjs";
import * as signer from "./lib/signer.mjs";
import { tools } from "./lib/tools.mjs";
import { schemas } from "./lib/schemas.mjs";
import { resolveFee } from "./lib/rails.mjs";

const jsonResult = (value, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** Validate strictly, run the handler, and turn every failure into a clean tool error. */
export async function runTool(tool, rawInput, deps) {
  const parsed = schemas[tool.name].safeParse(rawInput ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
    return jsonResult({ error: "Invalid input", issues }, true);
  }
  try {
    return jsonResult(await tool.handler(parsed.data, deps));
  } catch (err) {
    return jsonResult({ error: err?.message ?? "Unknown error", kind: err?.name ?? "Error" }, true);
  }
}

export function createServer(deps = { chain, signer, env: process.env }) {
  const server = new McpServer({ name: "nayori-agent-mcp", version: "0.2.0" });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: true },
      },
      (input) => runTool(tool, input, deps)
    );
  }
  return server;
}

async function main() {
  resolveFee(process.env); // fail fast on a bad or over-cap fee override
  let mode = "read-only (NAYORI_AGENT_ENV_FILE not set)";
  if (signer.signerConfigured(process.env)) {
    try {
      mode = `signing as ${signer.verifySigner(process.env).address}`;
    } catch (err) {
      mode = `read-only (signer env file rejected: ${err.message})`;
    }
  }
  console.error(`[nayori-agent-mcp] mainnet, ${mode}`);
  await createServer().connect(new StdioServerTransport());
}

const isEntry = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((err) => {
    console.error(`[nayori-agent-mcp] fatal: ${err?.message ?? "startup failed"}`);
    process.exit(1);
  });
}
