import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ensureYtDlp } from "../server/youtube-core.js";

const VIDEO = "tI9kSZgMLsc";
const WATCH = `https://www.youtube.com/watch?v=${VIDEO}`;
const CLIENTS = [
  "default",
  "android_vr",
  "tv",
  "ios",
  "web_safari",
  "mweb",
  "android",
  "web_embedded",
];

function runYt(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { windowsHide: true, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ ok: false, out: error.message }));
    child.on("close", (code) => {
      const text = (stdout || stderr).trim();
      resolve({ ok: code === 0 && stdout.length > 0, out: text });
    });
  });
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  void request;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  const lines: string[] = [];

  try {
    const executable = await ensureYtDlp();
    const env: NodeJS.ProcessEnv = process.env.VERCEL
      ? {
          ...process.env,
          HOME: "/tmp",
          TMPDIR: "/tmp",
          TEMP: "/tmp",
          TMP: "/tmp",
          XDG_CACHE_HOME: "/tmp/stemroller-cache",
        }
      : process.env;

    const base = ["-f", "bestaudio", "-g", "--no-warnings", "--no-playlist", "--socket-timeout", "20"];

    for (const client of CLIENTS) {
      const args =
        client === "default"
          ? [...base, WATCH]
          : [...base, "--extractor-args", `youtube:player_client=${client}`, WATCH];
      const start = Date.now();
      const result = await runYt(executable, args, env);
      const ms = Date.now() - start;
      lines.push(
        `${client} -> ok=${result.ok} ${ms}ms :: ${result.out.slice(0, 180).replace(/\s+/g, " ")}`,
      );
    }

    const combo = await runYt(
      executable,
      [
        ...base,
        "--extractor-args",
        "youtube:player_client=android_vr,tv,ios,web",
        WATCH,
      ],
      env,
    );
    lines.push(`combo -> ok=${combo.ok} :: ${combo.out.slice(0, 180).replace(/\s+/g, " ")}`);
  } catch (error) {
    lines.push(`ERR ${error instanceof Error ? error.message : String(error)}`);
  }

  response.statusCode = 200;
  response.end(lines.join("\n"));
}
