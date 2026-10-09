import { sendJson } from "../server/http";

export function GET(): Response {
  return new Response(`import-ok:${typeof sendJson}`);
}
