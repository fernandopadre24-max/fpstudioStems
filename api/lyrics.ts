import type { IncomingMessage, ServerResponse } from "node:http";
import { handleLyricsApi } from "../server/lyrics-core.js";

export default function handler(request: IncomingMessage, response: ServerResponse) {
  return handleLyricsApi(request, response);
}
