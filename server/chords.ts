import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { handleChordsApi } from "./chords-core";

export function chordsApiPlugin(): Plugin {
  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (!requestUrl.pathname.startsWith("/api/chords")) {
      next();
      return;
    }
    await handleChordsApi(request, response);
  };

  return {
    name: "stemroller-chords",
    configureServer(server) {
      server.middlewares.use(middleware as never);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware as never);
    },
  };
}
