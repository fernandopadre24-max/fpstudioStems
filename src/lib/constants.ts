export const SAMPLE_RATE = 44100;

export type StemId =
  | "drums"
  | "drumLow"
  | "drumHigh"
  | "percussion"
  | "bass"
  | "subBass"
  | "other"
  | "otherLow"
  | "otherHigh"
  | "otherPerc"
  | "vocals"
  | "leadVocal"
  | "backingVocal"
  | "clonedVocal"
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
    description: "Os ataques: bumbo, caixa, tons e pratos",
    color: "#ff7a59",
  },
  {
    id: "drumLow",
    label: "Bumbo e caixa",
    description: "Só o corpo grave da bateria (experimental)",
    color: "#ef4444",
  },
  {
    id: "drumHigh",
    label: "Pratos e hats",
    description: "Só a parte aguda da bateria (experimental)",
    color: "#fb923c",
  },
  {
    // ATENCAO: apesar do nome antigo "Percussao", esta trilha NAO sao os
    // instrumentos de percussao: o HPSS separa a bateria em ataque (fica em
    // "Bateria") e o que sobra dele (corpo/calda). Este e o lado ressonante.
    id: "percussion",
    label: "Ressonância",
    description: "Corpo e cauda dos tambores e pratos, sem os ataques",
    color: "#f5a524",
  },
  {
    id: "bass",
    label: "Baixo",
    description: "Linha de baixo",
    color: "#4cc9f0",
  },
  {
    id: "subBass",
    label: "Sub-baixo",
    description: "Graves do baixo (sub/sintetizador)",
    color: "#2563eb",
  },
  {
    id: "other",
    label: "Outros",
    description: "Teclados, cordas e demais instrumentos",
    color: "#b892ff",
  },
  {
    id: "otherLow",
    label: "Outros (graves)",
    description: "Instrumentos graves dentro dos outros (aproximado)",
    color: "#a78bfa",
  },
  {
    id: "otherHigh",
    label: "Outros (agudos)",
    description: "Instrumentos agudos dentro dos outros (aproximado)",
    color: "#d8b4fe",
  },
  {
    id: "otherPerc",
    label: "Outros (ataques)",
    description: "Só os ataques dos outros instrumentos, sem a sustentação (experimental)",
    color: "#c084fc",
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
    id: "clonedVocal",
    label: "Voz transformada",
    description: "Voz principal com o timbre trocado",
    color: "#ff9ecd",
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

// Presets de separacao: definem quantas e quais trilhas saem, combinando o
// modelo base (Demucs) com estagios extras (percussao, voz/backing) e divisoes
// por faixa de frequencia. As trilhas extras sao aproximadas (DSP), mas somam de
// volta ao original.
export type StemPresetId = "4" | "6" | "8" | "10" | "12";

export interface StemPreset {
  id: StemPresetId;
  label: string;
  description: string;
  model: StemModelId;
  /** Divide a bateria em percussao (ataques) + ressonancia via HPSS. */
  percussion: boolean;
  /** Divide os vocais em voz principal + backing (modelo KARA 2). */
  vocals: boolean;
  /** Divide o baixo em sub-baixo (graves) + baixo. */
  bassBands: boolean;
  /** Separa a parte percussiva dos "outros" (ataques/efeitos). */
  otherPerc: boolean;
  /** Divide os "outros" harmonicos em graves/agudos. */
  otherBands: boolean;
  /** Divide a bateria (parte percussiva) em bumbo/caixa e pratos/hats. */
  drumBands: boolean;
  /** Trilhas na ordem em que aparecem no editor. */
  stems: StemId[];
}

export const STEM_PRESETS: StemPreset[] = [
  {
    id: "4",
    label: "4 trilhas — HT-Demucs",
    description: "Bateria, baixo, outros e vocais. Mais rapido.",
    model: "htdemucs",
    percussion: false,
    vocals: false,
    bassBands: false,
    otherPerc: false,
    otherBands: false,
    drumBands: false,
    stems: ["drums", "bass", "other", "vocals"],
  },
  {
    id: "6",
    label: "6 trilhas — HT-Demucs 6s",
    description: "Adiciona guitarra e piano as 4 trilhas padrao.",
    model: "htdemucs_6s",
    percussion: false,
    vocals: false,
    bassBands: false,
    otherPerc: false,
    otherBands: false,
    drumBands: false,
    stems: ["drums", "bass", "other", "vocals", "guitar", "piano"],
  },
  {
    id: "8",
    label: "8 trilhas — detalhado",
    description: "6 instrumentos + ressonância da bateria + voz principal e backing.",
    model: "htdemucs_6s",
    percussion: true,
    vocals: true,
    bassBands: false,
    otherPerc: false,
    otherBands: false,
    drumBands: false,
    stems: ["drums", "percussion", "bass", "other", "guitar", "piano", "leadVocal", "backingVocal"],
  },
  {
    id: "10",
    label: "10 trilhas — avancado",
    description: "8 trilhas + sub-baixo + ataques dos outros instrumentos.",
    model: "htdemucs_6s",
    percussion: true,
    vocals: true,
    bassBands: true,
    otherPerc: true,
    otherBands: false,
    drumBands: false,
    stems: [
      "drums",
      "percussion",
      "subBass",
      "bass",
      "other",
      "otherPerc",
      "guitar",
      "piano",
      "leadVocal",
      "backingVocal",
    ],
  },
  {
    id: "12",
    label: "12 trilhas — maximo",
    description:
      "10 trilhas + bumbo/caixa e pratos/hats separados + outros divididos em graves e agudos.",
    model: "htdemucs_6s",
    percussion: true,
    vocals: true,
    bassBands: true,
    otherPerc: true,
    otherBands: true,
    drumBands: true,
    stems: [
      "drumLow",
      "drumHigh",
      "percussion",
      "subBass",
      "bass",
      "otherLow",
      "otherHigh",
      "otherPerc",
      "guitar",
      "piano",
      "leadVocal",
      "backingVocal",
    ],
  },
];

export const PRESET_BY_ID = new Map<StemPresetId, StemPreset>(
  STEM_PRESETS.map((preset) => [preset.id, preset]),
);

export function getPreset(id: StemPresetId): StemPreset {
  const preset = PRESET_BY_ID.get(id);
  if (!preset) throw new Error(`Preset desconhecido: ${id}`);
  return preset;
}

/**
 * Trilhas finais de um preset, com a divisao de voz/backing ligada ou
 * desligada. A divisao e opcional: quando ligada, os vocais viram voz
 * principal + backing (modelo KARA 2); quando desligada, sai uma trilha de
 * vocais so. Os dois casos ocupam o mesmo lugar na lista, no fim.
 */
export function presetStemIds(preset: StemPreset, splitVocals: boolean): StemId[] {
  const base = preset.stems.filter(
    (id) => id !== "vocals" && id !== "leadVocal" && id !== "backingVocal",
  );
  return splitVocals ? [...base, "leadVocal", "backingVocal"] : [...base, "vocals"];
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