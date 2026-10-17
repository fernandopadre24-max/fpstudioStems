// Foto de referencia de cada tipo de voz. Sao avatares livres (UI Faces via
// randomuser.me/xsgames), guardados junto do app: nao dependem de rede e nao
// tem nada a ver com a voz real da musica — servem so para escolher no olho.

const files = import.meta.glob("../assets/voices/*.jpg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const AVATARS: Record<string, string> = {};
for (const [path, url] of Object.entries(files)) {
  const name = path.split("/").pop() ?? "";
  AVATARS[name.replace(/\.jpg$/, "")] = url;
}

export function voiceAvatar(id: string): string | null {
  return AVATARS[id] ?? null;
}
