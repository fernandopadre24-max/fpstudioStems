import type { IncomingMessage, ServerResponse } from "node:http";

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  void request;
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/plain");
  response.end("node-ok");
}
