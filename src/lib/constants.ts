export const SAMPLE_RATE = 44100;

export type StemId =
  | "drums"
  | "percussion"
  | "bass"
  | "other"
  | "vocals"
  | "leadVocal"
  | "backingVocal"
  | "guitar"
  | "piano";

export interface StemMeta {
  id: StemId;
  label: string;
  description: string;
  color: string;
}

export const STEMS: StemMeta[] = [
  {
    id: "drums",
    label: "Bateria",
    description: "Kick, caixa e pratos",
    color: "#ff7a59",
  },
  {
    id: "percussion",
    label: "Percussão",
    description: "Ataques separados da bateria (experimental)",
    color: "#f5a524",
  },
  {
    id: "bass",
    label: "Baixo",
    description: "Linha de baixo",
    color: "#4cc9f0",
  },
  {
    id: "other",
    label: "Outros",
    description: "Teclados, cordas e demais instrumentos",
    color: "#b892ff",
  },
  {
    id: "vocals",
    label: "Vocais",
    description: "Voz principal e harmonias",
    color: "#ffd166",
  },
  {
    id: "leadVocal",
    label: "Voz principal",
    description: "Voz principal (lead) isolada",
    color: "#ffd166",
  },
  {
    id: "backingVocal",
    label: "Backing vocal",
    description: "Backing vocals e harmonias",
    color: "#f4a261",
  },
  {
    id: "guitar",
    label: "Guitarra",
    description: "Guitarras eletricas e acusticas",
    color: "#34d399",
  },
  {
    id: "piano",
    label: "Piano",
    description: "Piano e teclas",
    color: "#f472b6",
  },
];

export const STEM_BY_ID = new Map<StemId, StemMeta>(STEMS.map((stem) => [stem.id, stem]));

export type StemModelId = "htdemucs" | "htdemucs_6s";

export interface StemModelMeta {
  id: StemModelId;
  label: string;
  description: string;
  url: string;
  sizeBytes: number;
  stems: StemId[];
}

export const MODELS: StemModelMeta[] = [
  {
    id: "htdemucs",
    label: "4 trilhas — HT-Demucs",
    description: "Bateria, baixo, outros e vocais. Mais rapido.",
    url: "https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx",
    sizeBytes: 165612636,
    stems: ["drums", "bass", "other", "vocals"],
  },
  {
    id: "htdemucs_6s",
    label: "6 trilhas — HT-Demucs 6s",
    description: "Adiciona guitarra e piano as 4 trilhas padrao.",
    url: "https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx",
    sizeBytes: 142606336,
    stems: ["drums", "bass", "other", "vocals", "guitar", "piano"],
  },
];

export const MODEL_BY_ID = new Map<StemModelId, StemModelMeta>(
  MODELS.map((model) => [model.id, model]),
);

export function getModel(id: StemModelId): StemModelMeta {
  const model = MODEL_BY_ID.get(id);
  if (!model) throw new Error(`Modelo desconhecido: ${id}`);
  return model;
}

export interface ModelAsset {
  id: string;
  url: string;
  sizeBytes: number;
}

// Segundo estagio, opcional: divide o stem de vocais em voz principal (lead) e
// backing/harmonia. UVR-MDX-NET KARA 2 (ONNX, rede pura: STFT/OLA no host).
export const BACKING_VOCAL_MODEL: ModelAsset = {
  id: "kara2",
  url: "https://huggingface.co/musetric/uvr-mdxnet-kara2-onnx/resolve/main/kara2.onnx",
  sizeBytes: 52832612,
};

export type Backend = "auto" | "webgpu" | "wasm";

export const WHISPER_SAMPLE_RATE = 16000;

export interface WhisperModelMeta {
  id: string;
  label: string;
  description: string;
  repo: string;
}

export const WHISPER_MODELS: WhisperModelMeta[] = [
  {
    id: "whisper-tiny",
    label: "Whisper Tiny",
    description: "Mais rapido e leve, precisao menor em musica.",
    repo: "onnx-community/whisper-tiny",
  },
  {
    id: "whisper-base",
    label: "Whisper Base",
    description: "Equilibrio entre tamanho e precisao.",
    repo: "onnx-community/whisper-base",
  },
  {
    id: "whisper-small",
    label: "Whisper Small",
    description: "Mais preciso, download e transcricao mais lentos.",
    repo: "onnx-community/whisper-small",
  },
];

export const WHISPER_BY_ID = new Map<string, WhisperModelMeta>(
  WHISPER_MODELS.map((model) => [model.id, model]),
);

export const DEFAULT_WHISPER_ID = "whisper-base";