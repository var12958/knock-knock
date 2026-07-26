/**
 * @notice Standalone HTTP entrypoint for local development and testing.
 * @dev In a real Flare FCC deployment the tee-node binary proxies actions to
 *      the extension via `POST /action` on EXTENSION_PORT. This file implements
 *      that interface so you can test the handler without the full TEE stack.
 */

import http from "node:http";
import { Framework } from "./base/types.js";
import { validateEnvironment } from "./app/config.js";
import { register, reportState, resetState } from "./app/handlers.js";

validateEnvironment();

const PORT = process.env.EXTENSION_PORT ?? "7702";

const framework = new Framework();
register(framework);

interface ActionBody {
  opType?: string;
  opCommand?: string;
  originalMessage?: string;
}

const server = http.createServer(async (req, res) => {
  // Allow browser callers when the local FCC server is used as a dev proxy.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? "/";

  if (url === "/state" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reportState()));
    return;
  }

  if (url === "/reset" && req.method === "POST") {
    resetState();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url === "/action" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyText = Buffer.concat(chunks).toString("utf-8");
    let body: ActionBody;
    try {
      body = JSON.parse(bodyText) as ActionBody;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: 0, error: "invalid JSON" }));
      return;
    }

    if (!body.opType || !body.opCommand) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: 0, error: "missing opType or opCommand" }));
      return;
    }

    const handler = framework.lookup(body.opType, body.opCommand);
    if (!handler) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: 0,
          error: `unsupported op type/command: ${body.opType}/${body.opCommand}`,
        }),
      );
      return;
    }

    try {
      const [data, status, error] = await handler(body.originalMessage ?? "0x");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data, status, error }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: 0, error: String(err) }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(Number(PORT), () => {
  console.log(`KnockKnock FCC extension listening on port ${PORT}`);
});
