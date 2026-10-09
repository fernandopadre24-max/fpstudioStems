import { createWriteStream, promises as fs, chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDir = path.join(projectRoot, ".bin");
const distBinDir = path.join(projectRoot, "dist", "bin");
const platform = process.platform;

const YTDLP_VERSION = "2026.08.19";

function getBinaryName() {
  if (platform === "win32") return "yt-dlp.exe";
  if (platform === "linux") return "yt-dlp_linux";
  if (platform === "darwin") return "yt-dlp_macos";
  return "yt-dlp";
}

function getBinaryPath() {
  return path.join(binDir, getBinaryName());
}

async function main() {
  const binaryPath = getBinaryPath();
  const binaryName = getBinaryName();

  // Verifica se já existe no .bin
  try {
    await fs.access(binaryPath);
    console.log(`yt-dlp já existe em ${binaryPath}, pulando download.`);
  } catch {
    const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${binaryName}`;
    console.log(`Baixando yt-dlp de ${downloadUrl}...`);

    await fs.mkdir(binDir, { recursive: true });

    const response = await fetch(downloadUrl, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`Falha ao baixar o yt-dlp (HTTP ${response.status}).`);
    }

    const temporary = `${binaryPath}.download`;
    await pipeline(response.body, createWriteStream(temporary));

    if (platform !== "win32") {
      chmodSync(temporary, 0o755);
    }

    await fs.rm(binaryPath, { force: true }).catch(() => undefined);
    await fs.rename(temporary, binaryPath);
    console.log(`yt-dlp instalado em ${binaryPath}`);
  }

  // Copia para o dist/bin (preservado no deploy)
  mkdirSync(distBinDir, { recursive: true });
  const distBinaryPath = path.join(distBinDir, binaryName);
  copyFileSync(binaryPath, distBinaryPath);
  if (platform !== "win32") {
    chmodSync(distBinaryPath, 0o755);
  }
  console.log(`yt-dlp copiado para ${distBinaryPath}`);
}

main().catch((error) => {
  console.error("Erro ao configurar yt-dlp:", error);
  process.exit(1);
});