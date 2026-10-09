import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { handleYouTubeApi } from "./youtube-core.js";

export function youtubeApiPlugin(): Plugin {
  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (!requestUrl.pathname.startsWith("/api/youtube/")) {
      next();
      return;
    }
    await handleYouTubeApi(request, response);
  };

  return {
    name: "stemroller-youtube",
    configureServer(server) {
      server.middlewares.use(middleware as never);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware as never);
    },
  };
}
