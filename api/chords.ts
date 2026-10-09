import type { IncomingMessage, ServerResponse } from "node:http";
import { handleChordsApi } from "../server/chords-core";

export default function handler(request: IncomingMessage, response: ServerResponse) {
  return handleChordsApi(request, response);
}
