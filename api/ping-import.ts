import { sendJson } from "../server/http.js";

export function GET(): Response {
  return new Response(`import-ok:${typeof sendJson}`);
}
