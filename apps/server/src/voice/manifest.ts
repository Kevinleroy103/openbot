/**
 * What voice calls download (experiment), pinned by size and SHA-256 like voice input's Parakeet:
 * llama.cpp's server (the runner), the small voice model it runs, and Kokoro's voices. Speech in and
 * the sherpa-onnx library come from voice input, which a call needs anyway.
 */
import type { SttArchive, SttPlatform } from "../stt/manifest.ts"

export interface VoiceManifest {
  /** llama.cpp's prebuilt server per platform (Linux: the Vulkan build uses any GPU and needs no CUDA). */
  readonly runners: Partial<Record<SttPlatform, SttArchive>>
  readonly model: {
    readonly label: string
    /** One GGUF file. */
    readonly file: SttArchive
    /** Added to every request (the model's own switches, e.g. no thinking out loud). */
    readonly requestExtras: Readonly<Record<string, unknown>>
  }
  readonly voices: {
    readonly label: string
    readonly archive: SttArchive
    /** Files in the unpacked folder. */
    readonly model: string
    readonly voices: string
    readonly tokens: string
    readonly dataDir: string
    readonly lexicon: string
    readonly lang: string
  }
}

const LLAMA_CPP = "https://github.com/ggml-org/llama.cpp/releases/download/b11797"

export const VOICE_MANIFEST: VoiceManifest = {
  runners: {
    "linux-x64": {
      url: `${LLAMA_CPP}/llama-b11797-bin-ubuntu-vulkan-x64.tar.gz`,
      sha256: "2f8f1526b9604d5301e5cb993615a27fc747ffb631c6e6d99f9cc34171d6dd6e",
      bytes: 34_946_197,
    },
    "darwin-arm64": {
      url: `${LLAMA_CPP}/llama-b11797-bin-macos-arm64.tar.gz`,
      sha256: "6d2becf713e3db78fa57155b3e12e46c7f723b077729c60fd0f9d198e2f726fa",
      bytes: 16_136_172,
    },
  },
  model: {
    label: "Qwen3.5 2B",
    file: {
      url: "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf",
      sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
      bytes: 1_280_835_840,
    },
    requestExtras: { chat_template_kwargs: { enable_thinking: false } },
  },
  voices: {
    label: "Kokoro",
    archive: {
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
      sha256: "c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298",
      bytes: 349_906_910,
    },
    model: "model.onnx",
    voices: "voices.bin",
    tokens: "tokens.txt",
    dataDir: "espeak-ng-data",
    lexicon: "lexicon-us-en.txt",
    lang: "en-us",
  },
}

export const voiceDownloadBytes = (manifest: VoiceManifest, platform: SttPlatform): number | undefined => {
  const runner = manifest.runners[platform]
  return runner === undefined ? undefined : runner.bytes + manifest.model.file.bytes + manifest.voices.archive.bytes
}
