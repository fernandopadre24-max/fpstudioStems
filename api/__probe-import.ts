import { sendJson } from "../server/http.ts";

export function GET(): Response {
  return new Response(`import-ok:${typeof sendJson}`);
}
