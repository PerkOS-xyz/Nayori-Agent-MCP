#!/usr/bin/env node
// Tiny MCP client for this server.
//   node call.mjs                         -> list tools
//   node call.mjs <toolName> '<json args>' -> call a tool and pretty-print the result
// Spawns server.mjs over stdio with the current environment.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [toolName, rawArgs] = process.argv.slice(2);
let args = {};
if (rawArgs !== undefined) {
  try {
    args = JSON.parse(rawArgs);
  } catch {
    console.error("Arguments must be one JSON object, for example '{\"asset\":\"sbtc\"}'.");
    process.exit(2);
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(dirname(fileURLToPath(import.meta.url)), "server.mjs")],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "nayori-agent-call", version: "0.1.0" });

let exitCode = 0;
try {
  await client.connect(transport);
  if (!toolName) {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}\n    ${t.description}\n`);
    console.log(`${tools.length} tools`);
  } else {
    const result = await client.callTool({ name: toolName, arguments: args });
    for (const part of result.content ?? []) {
      if (part.type !== "text") continue;
      try {
        console.log(JSON.stringify(JSON.parse(part.text), null, 2));
      } catch {
        console.log(part.text);
      }
    }
    if (result.isError) exitCode = 1;
  }
} catch (err) {
  console.error(`call failed: ${err?.message ?? err}`);
  exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
process.exit(exitCode);
