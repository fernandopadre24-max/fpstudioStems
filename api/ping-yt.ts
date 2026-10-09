import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const BASE = "https://invidious.f5.si";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function pow(randomData: string, difficulty: number): { nonce: string; hash: string; ms: number } | null {
  const target = "0".repeat(Math.max(1, Math.min(difficulty, 8)));
  const start = Date.now();
  for (let nonce = 0; nonce < 10_000_000; nonce += 1) {
    const hash = createHash("sha256").update(randomData + String(nonce)).digest("hex");
    if (hash.startsWith(target)) return { nonce: String(nonce), hash, ms: Date.now() - start };
  }
  return null;
}

function cookies(response: Response): string[] {
  const header = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  return (header ?? []).map((pair) => pair.split(";")[0]);
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  void request;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  const lines: string[] = [];

  const apiUrl = `${BASE}/api/v1/videos/tI9kSZgMLsc?local=true`;
  const apiRes = await fetch(apiUrl, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(25000),
  });
  const apiBody = await apiRes.text();
  lines.push(`api http=${apiRes.status} type=${apiRes.headers.get("content-type")} len=${apiBody.length}`);
  lines.push(`api body: ${apiBody.slice(0, 220).replace(/\s+/g, " ")}`);

  const challengeMatch = apiBody.match(/\{"rules":[\s\S]*?"spent":(?:true|false)\}\}/);
  if (!challengeMatch) {
    response.end(lines.join("\n"));
    return;
  }
  lines.push("anubis no endpoint da api");

  const parsed = JSON.parse(challengeMatch[0]) as {
    rules: { difficulty: number };
    challenge: { id: string; randomData: string };
  };
  const solution = pow(parsed.challenge.randomData, parsed.rules.difficulty);
  if (!solution) {
    lines.push("pow falhou");
    response.end(lines.join("\n"));
    return;
  }
  lines.push(`pow nonce=${solution.nonce} ms=${solution.ms}`);

  const apiCookies = cookies(apiRes);
  const passUrl =
    `${BASE}/.within.website/x/cmd/anubis/api/pass-challenge` +
    `?id=${encodeURIComponent(parsed.challenge.id)}` +
    `&response=${solution.hash}` +
    `&nonce=${solution.nonce}` +
    `&redir=${encodeURIComponent("/api/v1/videos/tI9kSZgMLsc?local=true")}` +
    `&elapsedTime=${solution.ms}`;
  const passRes = await fetch(passUrl, {
    headers: { "User-Agent": UA, Cookie: apiCookies.join("; "), Referer: apiUrl },
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  lines.push(`pass http=${passRes.status}`);
  const auth = cookies(passRes)
    .filter((pair) => !/Max-Age=0/i.test(pair))
    .join("; ");
  lines.push(`auth=${auth ? `sim (${auth.length} chars)` : "nao"}`);

  if (!auth) {
    response.end(lines.join("\n"));
    return;
  }

  const retry = await fetch(apiUrl, {
    headers: { "User-Agent": UA, Accept: "application/json", Cookie: auth },
    signal: AbortSignal.timeout(25000),
  });
  const retryBody = await retry.text();
  lines.push(`api2 http=${retry.status} type=${retry.headers.get("content-type")} len=${retryBody.length}`);
  lines.push(`api2 body: ${retryBody.slice(0, 220).replace(/\s+/g, " ")}`);

  response.statusCode = 200;
  response.end(lines.join("\n"));
}
