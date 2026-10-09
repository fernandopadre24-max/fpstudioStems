import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { handleLyricsApi } from "./lyrics-core.ts";

export function lyricsApiPlugin(): Plugin {
  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (!requestUrl.pathname.startsWith("/api/lyrics")) {
      next();
      return;
    }
    await handleLyricsApi(request, response);
  };

  return {
    name: "stemroller-lyrics",
    configureServer(server) {
      server.middlewares.use(middleware as never);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware as never);
    },
  };
}
