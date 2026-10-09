import type { IncomingMessage, ServerResponse } from "node:http";
import { handleYouTubeApi } from "../../server/youtube-core.ts";

export default function handler(request: IncomingMessage, response: ServerResponse) {
  return handleYouTubeApi(request, response);
}
