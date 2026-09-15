import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

/**
 * Image OCR is intentionally a local, best-effort source reader. It never
 * creates a table, performs financial coercion, approves a mapping, or treats
 * text found in an image as an instruction. The caller must obtain reviewed
 * word/box selection before any normalized import can be considered.
 */

export const FinanceImageFormatSchema = z.enum(['png', 'jpeg', 'webp']);
export type FinanceImageFormat = z.infer<typeof FinanceImageFormatSchema>;

/** Hard upper bounds. Callers may request lower bounds for a particular run. */
export const FINANCE_IMAGE_OCR_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxPixels: 40_000_000,
  maxDimension: 100_000,
  maxWords: 20_000,
  maxTextCharacters: 256 * 1024,
  maxDecodedBytes: 48 * 1024 * 1024,
  maxOutputBytes: 2 * 1024 * 1024,
  timeoutMs: 15_000,
  minimumConfidence: 0.8,
});
export type FinanceImageOcrLimits = {
  [K in keyof typeof FINANCE_IMAGE_OCR_LIMITS]: number;
};

const IMAGE_OCR_LIMIT_KEYS = [
  'maxBytes',
  'maxPixels',
  'maxDimension',
  'maxWords',
  'maxTextCharacters',
  'maxDecodedBytes',
  'maxOutputBytes',
  'timeoutMs',
] as const;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const FORMAT_ALIASES: Readonly<Record<string, FinanceImageFormat>> = {
  png: 'png',
  'image/png': 'png',
  jpeg: 'jpeg',
  jpg: 'jpeg',
  'image/jpeg': 'jpeg',
  webp: 'webp',
  'image/webp': 'webp',
};

export function parseFinanceImageFormat(value: unknown): FinanceImageFormat {
  if (typeof value !== 'string')
    throw new Error('finance-image-ocr-format-invalid');
  const format = FORMAT_ALIASES[value.toLowerCase()];
  if (!format) throw new Error('finance-image-ocr-format-unsupported');
  return format;
}

const ImageDimensionsSchema = z.strictObject({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  pixelCount: z.number().int().positive(),
  frameCount: z.number().int().positive(),
  /** ImageMagick's orientation label is retained to prove the coordinate frame. */
  orientation: z.string().min(1).max(32),
});
export type FinanceImageOcrDimensions = z.infer<typeof ImageDimensionsSchema>;

const ImageOcrWordSchema = z.strictObject({
  /** A single uploaded image is represented as page 1 for review tooling. */
  page: z.literal(1),
  block: z.number().int().nonnegative(),
  paragraph: z.number().int().nonnegative(),
  line: z.number().int().nonnegative(),
  word: z.number().int().positive(),
  text: z.string().min(1).max(10_000),
  /** All coordinates are integer pixels in the original, top-left image. */
  coordinateSpace: z.literal('image-pixels-top-left'),
  box: z.strictObject({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  confidence: z.number().min(0).max(1).nullable(),
  confidenceStatus: z.enum(['high', 'uncertain', 'unreadable']),
  sourceAnchor: z.string().min(1).max(240),
  id: z.string().regex(/^image-page-1-word-[1-9][0-9]*$/u),
});
export type FinanceImageOcrWord = z.infer<typeof ImageOcrWordSchema>;

/**
 * This candidate deliberately has no source-cell/table shape. A later review
 * operation must select exact words/boxes (and record corrections) before it
 * can create authoritative source provenance.
 */
const ImageOcrCandidateSchema = z.strictObject({
  kind: z.literal('ocr-text'),
  authority: z.literal('untrusted-source-data'),
  reviewStatus: z.literal('needs-source-review'),
  normalized: z.literal(false),
  sourceSelection: z.null(),
});
export type FinanceImageOcrCandidate = z.infer<typeof ImageOcrCandidateSchema>;

export const FinanceImageOcrUnavailableReasonSchema = z.enum([
  'invalid',
  'unsupported',
  'format-mismatch',
  'bytes-limit',
  'pixels-limit',
  'dimension-limit',
  'orientation-unsupported',
  'multi-frame-unsupported',
  'decoder-unavailable',
  'decode-failed',
  'decode-output-limit',
  'ocr-unavailable',
  'ocr-failed',
  'ocr-output-invalid',
  'ocr-provenance-unavailable',
  'output-limit',
  'text-limit',
  'words-limit',
  'timeout',
  'aborted',
  'worker-failed',
]);
export type FinanceImageOcrUnavailableReason = z.infer<
  typeof FinanceImageOcrUnavailableReasonSchema
>;

const ImageOcrUnavailableSchema = z.strictObject({
  status: z.literal('unavailable'),
  format: FinanceImageFormatSchema,
  sourceDigest: z.string().regex(SHA256_HEX),
  dimensions: ImageDimensionsSchema.nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  coordinateSpace: z.literal('image-pixels-top-left'),
  engine: z.null(),
  text: z.literal(''),
  words: z.array(ImageOcrWordSchema).max(0),
  truncated: z.literal(false),
  textBasis: z.literal('machine-transcription-requires-review'),
  reason: FinanceImageOcrUnavailableReasonSchema,
  issues: z.array(z.string().min(1).max(500)).max(20),
});

export const FinanceImageOcrEngineProvenanceSchema = z.strictObject({
  id: z.literal('tesseract'),
  version: z.string().min(1).max(64),
  languages: z.array(z.string().min(1).max(32)).min(1).max(4),
  trainedData: z
    .array(
      z.strictObject({
        language: z.string().min(1).max(32),
        sha256: z.string().regex(SHA256_HEX),
      }),
    )
    .min(1)
    .max(4),
});
export type FinanceImageOcrEngineProvenance = z.infer<
  typeof FinanceImageOcrEngineProvenanceSchema
>;

const AbsoluteRuntimePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => isAbsolute(value),
    'Runtime artifact path must be absolute',
  );

/**
 * A release-owned manifest binds the executable and traineddata bytes that a
 * worker is allowed to use. Host PATH discovery alone is deliberately not an
 * approval mechanism. The release image must supply this manifest after its
 * packaged artifacts have been hashed.
 */
export const FinanceImageOcrApprovedRuntimeManifestSchema = z
  .strictObject({
    magick: z.strictObject({
      path: AbsoluteRuntimePathSchema,
      sha256: z.string().regex(SHA256_HEX),
    }),
    tesseract: z.strictObject({
      path: AbsoluteRuntimePathSchema,
      sha256: z.string().regex(SHA256_HEX),
      version: z.string().min(1).max(64),
    }),
    trainedData: z
      .array(
        z.strictObject({
          language: z.enum(['eng', 'fra']),
          path: AbsoluteRuntimePathSchema,
          sha256: z.string().regex(SHA256_HEX),
        }),
      )
      .min(1)
      .max(2),
  })
  .superRefine((manifest, context) => {
    const languages = manifest.trainedData.map((entry) => entry.language);
    if (new Set(languages).size !== languages.length)
      context.addIssue({
        code: 'custom',
        message: 'Approved OCR traineddata languages must be unique',
      });
    if (
      new Set(manifest.trainedData.map((entry) => entry.path)).size !==
      manifest.trainedData.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Approved OCR traineddata paths must be unique',
      });
  });
export type FinanceImageOcrApprovedRuntimeManifest = z.infer<
  typeof FinanceImageOcrApprovedRuntimeManifestSchema
>;

const ImageOcrResultSchema = z.strictObject({
  status: z.enum(['extracted', 'no-text']),
  /** Confidence/readability is separate so low confidence cannot be mistaken for authority. */
  qualityStatus: z.enum(['high-confidence', 'uncertain', 'unreadable']),
  format: FinanceImageFormatSchema,
  sourceDigest: z.string().regex(SHA256_HEX),
  pageCount: z.literal(1),
  dimensions: ImageDimensionsSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  coordinateSpace: z.literal('image-pixels-top-left'),
  engine: FinanceImageOcrEngineProvenanceSchema.nullable(),
  text: z.string().max(FINANCE_IMAGE_OCR_LIMITS.maxTextCharacters),
  words: z.array(ImageOcrWordSchema).max(FINANCE_IMAGE_OCR_LIMITS.maxWords),
  truncated: z.literal(false),
  textBasis: z.literal('machine-transcription-requires-review'),
  candidate: ImageOcrCandidateSchema,
  issues: z.array(z.string().min(1).max(500)).max(20),
});

export const FinanceImageOcrExtractionSchema = z.discriminatedUnion('status', [
  ImageOcrResultSchema,
  ImageOcrUnavailableSchema,
]);
export type FinanceImageOcrExtraction = z.infer<
  typeof FinanceImageOcrExtractionSchema
>;

export interface FinanceImageOcrRuntimeInput {
  readonly bytes: Uint8Array;
  readonly format: FinanceImageFormat;
  readonly limits: FinanceImageOcrLimits;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface FinanceImageOcrRuntime {
  /** Verify release-owned executable bytes before any source decoding. */
  verify?(input: {
    readonly limits: FinanceImageOcrLimits;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  }): Promise<void>;
  /** Decode only the image header. No source text or financial meaning is inferred. */
  identify(input: FinanceImageOcrRuntimeInput): Promise<{
    readonly format: FinanceImageFormat;
    readonly width: number;
    readonly height: number;
    readonly frameCount?: number;
    readonly orientation?: string;
  }>;
  /** Immutable engine/traineddata provenance for the candidate. */
  describe?(input: {
    readonly limits: FinanceImageOcrLimits;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  }): Promise<FinanceImageOcrEngineProvenance>;
  /** Decode to a bounded 8-bit grayscale PGM for OCR. */
  decodeToPgm(input: FinanceImageOcrRuntimeInput): Promise<Uint8Array>;
  /** Run OCR and return bounded Tesseract TSV source output. */
  recognizeTsv(input: {
    readonly pgm: Uint8Array;
    readonly width: number;
    readonly height: number;
    readonly limits: FinanceImageOcrLimits;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
  }): Promise<string>;
}

export class FinanceImageOcrCommandError extends Error {
  readonly reason: FinanceImageOcrUnavailableReason;

  constructor(reason: FinanceImageOcrUnavailableReason) {
    super(`finance-image-ocr-${reason}`);
    this.name = 'FinanceImageOcrCommandError';
    this.reason = reason;
  }
}

type ImageOcrCommandStage = 'identify' | 'decode' | 'ocr';

interface LimitedProcessInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly input: Uint8Array;
  readonly outputLimit: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly stage: ImageOcrCommandStage;
}

interface LimitedProcessResult {
  readonly stdout: Buffer;
}

const terminateChildProcessGroup = (child: {
  readonly pid?: number;
  kill: (signal?: NodeJS.Signals) => boolean;
}): void => {
  if (
    process.platform !== 'win32' &&
    child.pid !== undefined &&
    child.pid > 0
  ) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Fall back to the direct child if the group has already exited.
    }
  }
  child.kill('SIGKILL');
};

const stageUnavailableReason = (
  stage: ImageOcrCommandStage,
): FinanceImageOcrUnavailableReason =>
  stage === 'ocr' ? 'ocr-unavailable' : 'decoder-unavailable';
const stageFailureReason = (
  stage: ImageOcrCommandStage,
): FinanceImageOcrUnavailableReason =>
  stage === 'ocr' ? 'ocr-failed' : 'decode-failed';

/**
 * Runs an allowlisted executable with shell=false, bounded stdout and a hard
 * deadline. Stderr is drained but never retained or returned to callers.
 */
async function runLimitedProcess(
  input: LimitedProcessInput,
): Promise<LimitedProcessResult> {
  if (input.signal?.aborted) throw new FinanceImageOcrCommandError('aborted');
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    !Number.isSafeInteger(input.outputLimit) ||
    input.outputLimit < 1
  )
    throw new FinanceImageOcrCommandError('worker-failed');

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(input.command, [...input.args], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: SAFE_CHILD_ENV,
        cwd: '/tmp',
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch {
      reject(
        new FinanceImageOcrCommandError(stageUnavailableReason(input.stage)),
      );
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    const stdout: Buffer[] = [];
    const timer = setTimeout(
      () => terminate(new FinanceImageOcrCommandError('timeout')),
      input.timeoutMs,
    );
    const inputBuffer = Buffer.isBuffer(input.input)
      ? input.input
      : Buffer.from(
          input.input.buffer,
          input.input.byteOffset,
          input.input.byteLength,
        );

    const cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    };
    const terminate = (error: FinanceImageOcrCommandError) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateChildProcessGroup(child);
      reject(error);
    };
    const onAbort = () => terminate(new FinanceImageOcrCommandError('aborted'));

    child.stdout.on('data', (chunk: Buffer | Uint8Array) => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += value.byteLength;
      if (stdoutBytes > input.outputLimit) {
        terminate(
          new FinanceImageOcrCommandError(
            input.stage === 'decode' ? 'decode-output-limit' : 'output-limit',
          ),
        );
        return;
      }
      stdout.push(value);
    });
    // Never retain diagnostics. Draining prevents a child blocked on stderr.
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', () => undefined);
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      terminate(
        new FinanceImageOcrCommandError(
          error.code === 'ENOENT'
            ? stageUnavailableReason(input.stage)
            : stageFailureReason(input.stage),
        ),
      );
    });
    child.once('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0) {
        reject(
          new FinanceImageOcrCommandError(stageFailureReason(input.stage)),
        );
        return;
      }
      resolve({ stdout: Buffer.concat(stdout, stdoutBytes) });
    });

    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      child.stdin.end(inputBuffer);
    } catch {
      terminate(
        new FinanceImageOcrCommandError(stageFailureReason(input.stage)),
      );
    }
  });
}

const imageMagickFormat = (value: string): FinanceImageFormat | undefined => {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'PNG') return 'png';
  if (normalized === 'JPEG' || normalized === 'JPG') return 'jpeg';
  if (normalized === 'WEBP') return 'webp';
  return undefined;
};

const parsePositiveInteger = (value: string): number | undefined => {
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const SAFE_CHILD_ENV = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/local/bin',
  HOME: '/tmp',
  LANG: 'C',
  LC_ALL: 'C',
  TMPDIR: '/tmp',
});
const SAFE_EXECUTABLE_DIRECTORIES = [
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/opt/homebrew/bin',
  '/opt/local/bin',
] as const;
const RUNTIME_ARTIFACT_MAX_BYTES = 128 * 1024 * 1024;

const nativeImageLimitArgs = (limits: FinanceImageOcrLimits): string[] => [
  '-limit',
  'thread',
  '1',
  '-limit',
  'area',
  String(limits.maxPixels),
  '-limit',
  'width',
  String(limits.maxDimension),
  '-limit',
  'height',
  String(limits.maxDimension),
  '-limit',
  'memory',
  String(limits.maxDecodedBytes),
  '-limit',
  'map',
  String(limits.maxDecodedBytes),
  '-limit',
  'disk',
  '0',
];

/** Resolve development PATH names once; never pass the caller's PATH to a child. */
const resolveExecutablePath = (command: string): string => {
  if (isAbsolute(command)) return command;
  for (const directory of SAFE_EXECUTABLE_DIRECTORIES) {
    const candidate = join(directory, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through the fixed, non-secret search path.
    }
  }
  return command;
};

async function readBoundedRuntimeFile(path: string): Promise<Buffer> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1)
    throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
  if (stat.size > RUNTIME_ARTIFACT_MAX_BYTES)
    throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch {
    throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
  }
  if (data.byteLength !== stat.size) {
    data.fill(0);
    throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
  }
  return data;
}

async function verifyRuntimeFile(
  path: string,
  expectedSha256: string,
): Promise<void> {
  const data = await readBoundedRuntimeFile(path);
  try {
    if (sha256(data) !== expectedSha256)
      throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
  } finally {
    data.fill(0);
  }
}

/** Runtime backed by the installed ImageMagick and Tesseract executables. */
export function createFinanceImageOcrRuntime(
  options: {
    readonly magickExecutable?: string;
    readonly tesseractExecutable?: string;
    readonly language?: string;
    /** Release-owned byte manifest; required by the worker adapter. */
    readonly approvedManifest?: FinanceImageOcrApprovedRuntimeManifest;
    /** Keep direct local development usable while worker calls fail closed. */
    readonly requireApprovedManifest?: boolean;
  } = {},
): FinanceImageOcrRuntime {
  const manifest = options.approvedManifest
    ? FinanceImageOcrApprovedRuntimeManifestSchema.parse(
        options.approvedManifest,
      )
    : undefined;
  const magickExecutable = resolveExecutablePath(
    options.magickExecutable ?? manifest?.magick.path ?? 'magick',
  );
  const tesseractExecutable = resolveExecutablePath(
    options.tesseractExecutable ?? manifest?.tesseract.path ?? 'tesseract',
  );
  const language = options.language ?? 'eng';
  // Only fixed Tesseract language names are accepted; they are not paths or shell fragments.
  if (!/^(?:eng|fra|eng\+fra)$/u.test(language))
    throw new Error('finance-image-ocr-language-invalid');
  const languages = language.split('+');
  const approvedTessdataDirectory = manifest
    ? dirname(manifest.trainedData[0]!.path)
    : undefined;
  if (
    manifest &&
    manifest.trainedData.some(
      (entry) => dirname(entry.path) !== approvedTessdataDirectory,
    )
  )
    throw new Error('finance-image-ocr-approved-runtime-path-mismatch');

  if (
    manifest &&
    (magickExecutable !== manifest.magick.path ||
      tesseractExecutable !== manifest.tesseract.path)
  )
    throw new Error('finance-image-ocr-approved-runtime-path-mismatch');

  return {
    async verify() {
      if (options.requireApprovedManifest && !manifest)
        throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
      if (!manifest) return;
      await verifyRuntimeFile(manifest.magick.path, manifest.magick.sha256);
      await verifyRuntimeFile(
        manifest.tesseract.path,
        manifest.tesseract.sha256,
      );
    },
    async identify(input) {
      const result = await runLimitedProcess({
        command: magickExecutable,
        args: [
          'identify',
          '-ping',
          ...nativeImageLimitArgs(input.limits),
          '-format',
          '%m %w %h %[orientation] %n\n',
          `${input.format}:-`,
        ],
        input: input.bytes,
        outputLimit: Math.min(input.limits.maxOutputBytes, 1024),
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        stage: 'identify',
      });
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
      } catch {
        throw new FinanceImageOcrCommandError('decode-failed');
      }
      const lines = text.trim().split(/\r?\n/u);
      if (lines.length !== 1)
        throw new FinanceImageOcrCommandError('multi-frame-unsupported');
      const match = /^([^\s]+)\s+(\d+)\s+(\d+)\s+([^\s]+)\s+(\d+)$/u.exec(
        lines[0]!,
      );
      const format = match ? imageMagickFormat(match[1]!) : undefined;
      const width = match ? parsePositiveInteger(match[2]!) : undefined;
      const height = match ? parsePositiveInteger(match[3]!) : undefined;
      const orientation = match?.[4];
      const frameCount = match ? parsePositiveInteger(match[5]!) : undefined;
      if (
        !format ||
        width === undefined ||
        height === undefined ||
        !orientation ||
        frameCount === undefined
      )
        throw new FinanceImageOcrCommandError('decode-failed');
      return { format, width, height, orientation, frameCount };
    },

    async describe(input) {
      const versionResult = await runLimitedProcess({
        command: tesseractExecutable,
        args: ['--version'],
        input: new Uint8Array(),
        outputLimit: 4_096,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        stage: 'ocr',
      });
      const listResult = await runLimitedProcess({
        command: tesseractExecutable,
        args: [
          ...(approvedTessdataDirectory
            ? ['--tessdata-dir', approvedTessdataDirectory]
            : []),
          '--list-langs',
        ],
        input: new Uint8Array(),
        outputLimit: 4_096,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        stage: 'ocr',
      });
      let versionText: string;
      let listText: string;
      try {
        versionText = new TextDecoder('utf-8', { fatal: true }).decode(
          versionResult.stdout,
        );
        listText = new TextDecoder('utf-8', { fatal: true }).decode(
          listResult.stdout,
        );
      } catch {
        throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
      }
      const version = /^tesseract\s+([^\s]+)/im.exec(versionText)?.[1];
      const tessDataDirectory =
        /^List of available languages in\s+"([^"]+)"/im.exec(listText)?.[1];
      if (!version || !tessDataDirectory || !isAbsolute(tessDataDirectory))
        throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
      if (manifest && version !== manifest.tesseract.version)
        throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
      const normalizedTessDataDirectory = tessDataDirectory.replace(
        /[\\/]+$/u,
        '',
      );
      if (
        approvedTessdataDirectory &&
        normalizedTessDataDirectory !== approvedTessdataDirectory
      )
        throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
      const trainedData = [];
      for (const currentLanguage of languages) {
        const approvedEntry = manifest?.trainedData.find(
          (entry) => entry.language === currentLanguage,
        );
        if (manifest && !approvedEntry)
          throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
        const dataPath = approvedEntry
          ? approvedEntry.path
          : join(normalizedTessDataDirectory, `${currentLanguage}.traineddata`);
        let data: Buffer;
        try {
          data = await readBoundedRuntimeFile(dataPath);
        } catch (error) {
          if (error instanceof FinanceImageOcrCommandError) throw error;
          throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
        }
        if (data.byteLength === 0) {
          data.fill(0);
          throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
        }
        const trainedSha256 = sha256(data);
        data.fill(0);
        if (approvedEntry && trainedSha256 !== approvedEntry.sha256)
          throw new FinanceImageOcrCommandError('ocr-provenance-unavailable');
        trainedData.push({ language: currentLanguage, sha256: trainedSha256 });
      }
      return {
        id: 'tesseract' as const,
        version,
        languages,
        trainedData,
      };
    },

    async decodeToPgm(input) {
      const result = await runLimitedProcess({
        command: magickExecutable,
        args: [
          ...nativeImageLimitArgs(input.limits),
          `${input.format}:-`,
          '-background',
          'white',
          '-alpha',
          'remove',
          '-colorspace',
          'Gray',
          '-define',
          'pgm:format=bin',
          '-depth',
          '8',
          'PGM:-',
        ],
        input: input.bytes,
        outputLimit: input.limits.maxDecodedBytes,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        stage: 'decode',
      });
      return result.stdout;
    },

    async recognizeTsv(input) {
      const result = await runLimitedProcess({
        command: tesseractExecutable,
        args: [
          'stdin',
          'stdout',
          ...(approvedTessdataDirectory
            ? ['--tessdata-dir', approvedTessdataDirectory]
            : []),
          '--psm',
          '6',
          '-l',
          language,
          'tsv',
        ],
        input: input.pgm,
        outputLimit: input.limits.maxOutputBytes,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        stage: 'ocr',
      });
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
      } catch {
        throw new FinanceImageOcrCommandError('ocr-output-invalid');
      }
    },
  };
}

const isFinitePositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function validateLimits(
  requested: Partial<FinanceImageOcrLimits> | undefined,
): FinanceImageOcrLimits {
  const limits = {
    ...FINANCE_IMAGE_OCR_LIMITS,
    ...(requested ?? {}),
  } as FinanceImageOcrLimits;
  for (const key of IMAGE_OCR_LIMIT_KEYS) {
    const value = limits[key];
    const maximum = FINANCE_IMAGE_OCR_LIMITS[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new Error('finance-image-ocr-invalid-limits');
  }
  if (
    typeof limits.minimumConfidence !== 'number' ||
    !Number.isFinite(limits.minimumConfidence) ||
    limits.minimumConfidence < 0 ||
    limits.minimumConfidence > 1
  )
    throw new Error('finance-image-ocr-invalid-limits');
  return limits;
}

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const dimensionsOf = (
  width: number,
  height: number,
  frameCount: number,
  orientation: string,
): FinanceImageOcrDimensions | undefined => {
  if (!isFinitePositiveInteger(width) || !isFinitePositiveInteger(height))
    return undefined;
  if (!isFinitePositiveInteger(frameCount) || !orientation) return undefined;
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount < 1) return undefined;
  return { width, height, pixelCount, frameCount, orientation };
};

const defaultOrientation = (value: string | undefined): string =>
  value?.trim() || 'Undefined';
const hasDefaultOrientation = (value: string): boolean =>
  ['undefined', 'topleft', 'top-left', '1'].includes(
    value.trim().toLowerCase(),
  );

const unavailable = (
  sourceDigest: string,
  imageFormat: FinanceImageFormat,
  reason: FinanceImageOcrUnavailableReason,
  dimensions: FinanceImageOcrDimensions | null = null,
  issues: readonly string[] = [],
): FinanceImageOcrExtraction =>
  FinanceImageOcrExtractionSchema.parse({
    status: 'unavailable',
    format: imageFormat,
    sourceDigest,
    dimensions,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    coordinateSpace: 'image-pixels-top-left',
    engine: null,
    text: '',
    words: [],
    truncated: false,
    textBasis: 'machine-transcription-requires-review',
    reason,
    issues: [unavailableIssue(reason), ...issues].slice(0, 20),
  });

const unavailableIssue = (reason: FinanceImageOcrUnavailableReason): string => {
  switch (reason) {
    case 'decoder-unavailable':
      return 'Image decoding runtime is unavailable; no OCR candidate was produced.';
    case 'ocr-unavailable':
      return 'OCR runtime is unavailable; no OCR candidate was produced.';
    case 'pixels-limit':
      return 'Image pixel count exceeds the bounded OCR limit.';
    case 'bytes-limit':
      return 'Original image bytes exceed the bounded OCR limit.';
    case 'timeout':
      return 'Image decoding or OCR exceeded its hard deadline.';
    case 'aborted':
      return 'Image decoding or OCR was aborted before completion.';
    default:
      return 'Image source could not be read into a bounded OCR candidate.';
  }
};

interface PgmPayload {
  readonly bytes: Uint8Array;
  readonly pixelOffset: number;
}

const isPgmWhitespace = (value: number): boolean =>
  value === 0x09 ||
  value === 0x0a ||
  value === 0x0c ||
  value === 0x0d ||
  value === 0x20;

function readPgmToken(
  bytes: Uint8Array,
  offset: number,
): { readonly value: string; readonly end: number } | undefined {
  let cursor = offset;
  for (;;) {
    while (cursor < bytes.length && isPgmWhitespace(bytes[cursor]!))
      cursor += 1;
    if (bytes[cursor] !== 0x23) break; // '#'
    while (cursor < bytes.length && bytes[cursor] !== 0x0a) cursor += 1;
  }
  const start = cursor;
  while (cursor < bytes.length && !isPgmWhitespace(bytes[cursor]!)) cursor += 1;
  if (cursor === start) return undefined;
  return {
    value: Buffer.from(bytes.subarray(start, cursor)).toString('ascii'),
    end: cursor,
  };
}

function validatePgm(
  input: Uint8Array,
  width: number,
  height: number,
  limits: FinanceImageOcrLimits,
): PgmPayload {
  if (!(input instanceof Uint8Array) || input.byteLength < 10)
    throw new FinanceImageOcrCommandError('decode-failed');
  if (input.byteLength > limits.maxDecodedBytes)
    throw new FinanceImageOcrCommandError('decode-output-limit');
  const magic = readPgmToken(input, 0);
  const decodedWidth = magic && readPgmToken(input, magic.end);
  const decodedHeight = decodedWidth && readPgmToken(input, decodedWidth.end);
  const maxValue = decodedHeight && readPgmToken(input, decodedHeight.end);
  if (
    !magic ||
    magic.value !== 'P5' ||
    !decodedWidth ||
    !decodedHeight ||
    !maxValue ||
    decodedWidth.value !== String(width) ||
    decodedHeight.value !== String(height) ||
    maxValue.value !== '255'
  )
    throw new FinanceImageOcrCommandError('decode-failed');
  let pixelOffset = maxValue.end;
  if (!isPgmWhitespace(input[pixelOffset] ?? -1))
    throw new FinanceImageOcrCommandError('decode-failed');
  // Consume exactly the separator after maxval. PGM pixels can themselves be whitespace.
  if (input[pixelOffset] === 0x0d) {
    pixelOffset += 1;
    if (input[pixelOffset] === 0x0a) pixelOffset += 1;
  } else if (input[pixelOffset] !== undefined) {
    pixelOffset += 1;
  }
  const expectedBytes = width * height;
  if (
    !Number.isSafeInteger(expectedBytes) ||
    input.byteLength - pixelOffset !== expectedBytes
  )
    throw new FinanceImageOcrCommandError('decode-failed');
  return { bytes: input, pixelOffset };
}

const parseTsvInteger = (value: string): number | undefined => {
  if (!/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

interface ParsedOcr {
  readonly words: FinanceImageOcrWord[];
  readonly text: string;
  readonly hasUnsafeText: boolean;
}

const TSV_HEADER = [
  'level',
  'page_num',
  'block_num',
  'par_num',
  'line_num',
  'word_num',
  'left',
  'top',
  'width',
  'height',
  'conf',
  'text',
].join('\t');

function parseTesseractTsv(
  tsv: string,
  width: number,
  height: number,
  limits: FinanceImageOcrLimits,
): ParsedOcr {
  if (Buffer.byteLength(tsv, 'utf8') > limits.maxOutputBytes)
    throw new FinanceImageOcrCommandError('output-limit');
  if (tsv.includes('\0'))
    throw new FinanceImageOcrCommandError('ocr-output-invalid');
  const rows = tsv.split(/\r?\n/u);
  if (rows[0] !== TSV_HEADER)
    throw new FinanceImageOcrCommandError('ocr-output-invalid');
  const words: FinanceImageOcrWord[] = [];
  const lineText = new Map<string, string[]>();
  let textCharacters = 0;
  let hasUnsafeText = false;
  for (const row of rows.slice(1)) {
    if (!row) continue;
    const fields = row.split('\t');
    if (fields.length < 12)
      throw new FinanceImageOcrCommandError('ocr-output-invalid');
    const level = parseTsvInteger(fields[0]!);
    const page = parseTsvInteger(fields[1]!);
    const block = parseTsvInteger(fields[2]!);
    const paragraph = parseTsvInteger(fields[3]!);
    const line = parseTsvInteger(fields[4]!);
    const word = parseTsvInteger(fields[5]!);
    if (
      level === undefined ||
      page !== 1 ||
      block === undefined ||
      paragraph === undefined ||
      line === undefined ||
      word === undefined
    )
      throw new FinanceImageOcrCommandError('ocr-output-invalid');
    if (level !== 5) continue;
    if (word < 1) throw new FinanceImageOcrCommandError('ocr-output-invalid');
    const x = parseTsvInteger(fields[6]!);
    const y = parseTsvInteger(fields[7]!);
    const wordWidth = parseTsvInteger(fields[8]!);
    const wordHeight = parseTsvInteger(fields[9]!);
    if (
      x === undefined ||
      y === undefined ||
      wordWidth === undefined ||
      wordWidth < 1 ||
      wordHeight === undefined ||
      wordHeight < 1 ||
      x + wordWidth > width ||
      y + wordHeight > height
    )
      throw new FinanceImageOcrCommandError('ocr-output-invalid');
    const rawText = fields.slice(11).join('\t');
    if (!rawText.trim()) continue;
    textCharacters += rawText.length;
    if (textCharacters > limits.maxTextCharacters)
      throw new FinanceImageOcrCommandError('text-limit');
    if (words.length >= limits.maxWords)
      throw new FinanceImageOcrCommandError('words-limit');
    if (
      [...rawText].some((character) => {
        const code = character.charCodeAt(0);
        const unsafe = code < 32 && ![9, 10, 13].includes(code);
        if (unsafe) hasUnsafeText = true;
        return unsafe;
      })
    )
      throw new FinanceImageOcrCommandError('ocr-output-invalid');
    const confidenceValue = Number(fields[10]);
    let confidence: number | null = null;
    if (Number.isFinite(confidenceValue) && confidenceValue >= 0) {
      if (confidenceValue > 100)
        throw new FinanceImageOcrCommandError('ocr-output-invalid');
      confidence = confidenceValue / 100;
    } else if (confidenceValue !== -1) {
      throw new FinanceImageOcrCommandError('ocr-output-invalid');
    }
    const index = words.length;
    const confidenceStatus =
      confidence === null
        ? ('unreadable' as const)
        : confidence >= limits.minimumConfidence
          ? ('high' as const)
          : ('uncertain' as const);
    const value: FinanceImageOcrWord = {
      page: 1,
      block,
      paragraph,
      line,
      word,
      text: rawText,
      coordinateSpace: 'image-pixels-top-left',
      box: { x, y, width: wordWidth, height: wordHeight },
      confidence,
      confidenceStatus,
      sourceAnchor: `image-page-1:pixel-box-${x},${y},${wordWidth},${wordHeight}:word-${index + 1}`,
      id: `image-page-1-word-${index + 1}`,
    };
    words.push(value);
    const key = `${block}/${paragraph}/${line}`;
    const group = lineText.get(key);
    if (group) group.push(rawText.trim());
    else lineText.set(key, [rawText.trim()]);
  }
  const text = [...lineText.values()]
    .map((line) => line.join(' '))
    .join('\n')
    .trim();
  if (text.length > limits.maxTextCharacters)
    throw new FinanceImageOcrCommandError('text-limit');
  return { words, text, hasUnsafeText };
}

const stageRemainingMs = (startedAt: number, limit: number): number => {
  const remaining = Math.floor(limit - (performance.now() - startedAt));
  return Math.max(1, remaining);
};

async function runStage<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  if (signal?.aborted) throw new FinanceImageOcrCommandError('aborted');
  const pending = operation();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(new FinanceImageOcrCommandError('aborted')));
    timer = setTimeout(
      () => finish(() => reject(new FinanceImageOcrCommandError('timeout'))),
      timeoutMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

const hasExpectedImageMagic = (
  bytes: Uint8Array,
  format: FinanceImageFormat,
): boolean => {
  if (format === 'png') {
    return (
      bytes.byteLength >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (format === 'jpeg')
    return (
      bytes.byteLength >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  return (
    bytes.byteLength >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  );
};

interface PredecodedImageHeader {
  readonly width: number;
  readonly height: number;
  readonly frameCount: number;
  /** Header parsers do not transform pixels or infer EXIF orientation. */
  readonly orientation: 'Unknown';
}

const readUint16Be = (
  bytes: Uint8Array,
  offset: number,
): number | undefined => {
  if (offset < 0 || offset + 2 > bytes.byteLength) return undefined;
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
};

const readUint32Be = (
  bytes: Uint8Array,
  offset: number,
): number | undefined => {
  if (offset < 0 || offset + 4 > bytes.byteLength) return undefined;
  return (
    bytes[offset]! * 0x1000000 +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
};

const readUint16Le = (
  bytes: Uint8Array,
  offset: number,
): number | undefined => {
  if (offset < 0 || offset + 2 > bytes.byteLength) return undefined;
  return bytes[offset]! | (bytes[offset + 1]! << 8);
};

const readUint24Le = (
  bytes: Uint8Array,
  offset: number,
): number | undefined => {
  if (offset < 0 || offset + 3 > bytes.byteLength) return undefined;
  return (
    bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
  );
};

const asciiAt = (bytes: Uint8Array, offset: number, length: number): string =>
  Buffer.from(bytes.subarray(offset, offset + length)).toString('ascii');

const headerDimensions = (
  width: number | undefined,
  height: number | undefined,
  frameCount: number,
): PredecodedImageHeader => {
  if (
    width === undefined ||
    height === undefined ||
    !isFinitePositiveInteger(width) ||
    !isFinitePositiveInteger(height) ||
    !isFinitePositiveInteger(frameCount)
  )
    throw new FinanceImageOcrCommandError('decode-failed');
  return { width, height, frameCount, orientation: 'Unknown' };
};

function predecodePngHeader(bytes: Uint8Array): PredecodedImageHeader {
  let cursor = 8;
  let width: number | undefined;
  let height: number | undefined;
  let frameCount = 1;
  let ended = false;
  while (cursor < bytes.byteLength) {
    if (bytes.byteLength - cursor < 12)
      throw new FinanceImageOcrCommandError('decode-failed');
    const length = readUint32Be(bytes, cursor);
    if (length === undefined || length > bytes.byteLength - cursor - 12)
      throw new FinanceImageOcrCommandError('decode-failed');
    const type = asciiAt(bytes, cursor + 4, 4);
    const dataOffset = cursor + 8;
    if (type === 'IHDR') {
      if (length !== 13 || width !== undefined)
        throw new FinanceImageOcrCommandError('decode-failed');
      width = readUint32Be(bytes, dataOffset);
      height = readUint32Be(bytes, dataOffset + 4);
    } else if (type === 'acTL') {
      if (length !== 8) throw new FinanceImageOcrCommandError('decode-failed');
      const frames = readUint32Be(bytes, dataOffset);
      if (frames === undefined || frames < 1)
        throw new FinanceImageOcrCommandError('decode-failed');
      frameCount = frames;
    } else if (type === 'IEND') {
      if (length !== 0) throw new FinanceImageOcrCommandError('decode-failed');
      ended = true;
      break;
    }
    cursor += 12 + length;
  }
  if (!ended) throw new FinanceImageOcrCommandError('decode-failed');
  return headerDimensions(width, height, frameCount);
}

const JPEG_STANDALONE_MARKERS = new Set([
  0x01, 0xd8, 0xd9, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7,
]);
const JPEG_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function predecodeJpegHeader(bytes: Uint8Array): PredecodedImageHeader {
  let cursor = 2;
  let width: number | undefined;
  let height: number | undefined;
  let frameCount = 0;
  while (cursor < bytes.byteLength) {
    if (bytes[cursor] !== 0xff)
      throw new FinanceImageOcrCommandError('decode-failed');
    while (cursor < bytes.byteLength && bytes[cursor] === 0xff) cursor += 1;
    if (cursor >= bytes.byteLength) break;
    const marker = bytes[cursor]!;
    cursor += 1;
    if (marker === 0x00) throw new FinanceImageOcrCommandError('decode-failed');
    if (marker === 0xda) break; // Scan data follows; dimensions must precede it.
    if (marker === 0xd9) break;
    if (JPEG_STANDALONE_MARKERS.has(marker)) continue;
    const segmentLength = readUint16Be(bytes, cursor);
    if (
      segmentLength === undefined ||
      segmentLength < 2 ||
      segmentLength > bytes.byteLength - cursor
    )
      throw new FinanceImageOcrCommandError('decode-failed');
    const dataOffset = cursor + 2;
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 9)
        throw new FinanceImageOcrCommandError('decode-failed');
      const frameHeight = readUint16Be(bytes, dataOffset + 1);
      const frameWidth = readUint16Be(bytes, dataOffset + 3);
      if (!frameWidth || !frameHeight)
        throw new FinanceImageOcrCommandError('decode-failed');
      if (width !== undefined) {
        frameCount += 1;
      } else {
        width = frameWidth;
        height = frameHeight;
        frameCount = 1;
      }
    }
    cursor += segmentLength;
  }
  return headerDimensions(width, height, frameCount || 1);
}

function predecodeWebpHeader(bytes: Uint8Array): PredecodedImageHeader {
  const riffSize = readUint32Le(bytes, 4);
  if (riffSize === undefined || riffSize > bytes.byteLength - 8)
    throw new FinanceImageOcrCommandError('decode-failed');
  const end = 8 + riffSize;
  let cursor = 12;
  let width: number | undefined;
  let height: number | undefined;
  let animated = false;
  let animationFrames = 0;
  while (cursor < end) {
    if (end - cursor < 8)
      throw new FinanceImageOcrCommandError('decode-failed');
    const type = asciiAt(bytes, cursor, 4);
    const length = readUint32Le(bytes, cursor + 4);
    if (length === undefined || length > end - cursor - 8)
      throw new FinanceImageOcrCommandError('decode-failed');
    const dataOffset = cursor + 8;
    if (type === 'VP8X') {
      if (length < 10) throw new FinanceImageOcrCommandError('decode-failed');
      animated ||= (bytes[dataOffset]! & 0x02) !== 0;
      const encodedWidth = readUint24Le(bytes, dataOffset + 4);
      const encodedHeight = readUint24Le(bytes, dataOffset + 7);
      width = encodedWidth === undefined ? undefined : encodedWidth + 1;
      height = encodedHeight === undefined ? undefined : encodedHeight + 1;
    } else if (type === 'VP8 ') {
      if (
        length < 10 ||
        bytes[dataOffset + 3] !== 0x9d ||
        bytes[dataOffset + 4] !== 0x01 ||
        bytes[dataOffset + 5] !== 0x2a
      )
        throw new FinanceImageOcrCommandError('decode-failed');
      const encodedWidth = readUint16Le(bytes, dataOffset + 6);
      const encodedHeight = readUint16Le(bytes, dataOffset + 8);
      width = encodedWidth === undefined ? undefined : encodedWidth & 0x3fff;
      height = encodedHeight === undefined ? undefined : encodedHeight & 0x3fff;
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[dataOffset] !== 0x2f)
        throw new FinanceImageOcrCommandError('decode-failed');
      const b1 = bytes[dataOffset + 1]!;
      const b2 = bytes[dataOffset + 2]!;
      const b3 = bytes[dataOffset + 3]!;
      const b4 = bytes[dataOffset + 4]!;
      width = 1 + (b1 | ((b2 & 0x3f) << 8));
      height = 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10));
    } else if (type === 'ANIM') {
      animated = true;
    } else if (type === 'ANMF') {
      animated = true;
      animationFrames += 1;
    }
    const paddedLength = length + (length & 1);
    if (paddedLength > end - dataOffset)
      throw new FinanceImageOcrCommandError('decode-failed');
    cursor = dataOffset + paddedLength;
  }
  if (animated || animationFrames > 0)
    animationFrames = Math.max(2, animationFrames);
  return headerDimensions(width, height, Math.max(1, animationFrames));
}

const readUint32Le = (
  bytes: Uint8Array,
  offset: number,
): number | undefined => {
  if (offset < 0 || offset + 4 > bytes.byteLength) return undefined;
  return (
    bytes[offset]! +
    (bytes[offset + 1]! << 8) +
    (bytes[offset + 2]! << 16) +
    bytes[offset + 3]! * 0x1000000
  );
};

function predecodeImageHeader(
  bytes: Uint8Array,
  format: FinanceImageFormat,
): PredecodedImageHeader {
  if (format === 'png') return predecodePngHeader(bytes);
  if (format === 'jpeg') return predecodeJpegHeader(bytes);
  return predecodeWebpHeader(bytes);
}

/**
 * Extract a bounded OCR candidate from one original image. The original byte
 * digest is checked before any decoder output can be accepted.
 */
export async function extractFinanceImageOcr(
  bytes: Uint8Array,
  options: {
    readonly format: FinanceImageFormat | string;
    readonly expectedSourceDigest?: string;
    readonly limits?: Partial<FinanceImageOcrLimits>;
    readonly signal?: AbortSignal;
    readonly runtime?: FinanceImageOcrRuntime;
  },
): Promise<FinanceImageOcrExtraction> {
  const imageFormat = parseFinanceImageFormat(options.format);
  const sourceDigest =
    bytes instanceof Uint8Array ? sha256(bytes) : sha256(new Uint8Array());
  if (
    options.expectedSourceDigest !== undefined &&
    (!SHA256_HEX.test(options.expectedSourceDigest) ||
      options.expectedSourceDigest !== sourceDigest)
  )
    throw new Error('finance-image-ocr-source-digest-mismatch');
  const limits = validateLimits(options.limits);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
    return unavailable(sourceDigest, imageFormat, 'invalid');
  if (bytes.byteLength > limits.maxBytes)
    return unavailable(sourceDigest, imageFormat, 'bytes-limit');
  // Force the decoder to the authenticated format so SVG/MVG/PDF or another
  // ImageMagick delegate can never be interpreted as an uploaded image.
  if (!hasExpectedImageMagic(bytes, imageFormat))
    return unavailable(sourceDigest, imageFormat, 'unsupported');
  if (options.signal?.aborted)
    return unavailable(sourceDigest, imageFormat, 'aborted');
  let predecoded: PredecodedImageHeader;
  try {
    predecoded = predecodeImageHeader(bytes, imageFormat);
  } catch (error) {
    if (error instanceof FinanceImageOcrCommandError)
      return unavailable(sourceDigest, imageFormat, error.reason);
    return unavailable(sourceDigest, imageFormat, 'decode-failed');
  }
  // Apply the dimension gate before multiplying header values. A hostile
  // uint32 image header can overflow a pixel-count calculation; it must still
  // be rejected before any native decoder sees the bytes.
  if (
    predecoded.width > limits.maxDimension ||
    predecoded.height > limits.maxDimension
  )
    return unavailable(sourceDigest, imageFormat, 'dimension-limit');
  const predecodedDimensions = dimensionsOf(
    predecoded.width,
    predecoded.height,
    predecoded.frameCount,
    predecoded.orientation,
  );
  if (!predecodedDimensions)
    return unavailable(sourceDigest, imageFormat, 'decode-failed');
  if (predecodedDimensions.pixelCount > limits.maxPixels)
    return unavailable(
      sourceDigest,
      imageFormat,
      'pixels-limit',
      predecodedDimensions,
    );
  if (predecoded.frameCount !== 1)
    return unavailable(
      sourceDigest,
      imageFormat,
      'multi-frame-unsupported',
      predecodedDimensions,
    );
  const runtime = options.runtime ?? createFinanceImageOcrRuntime();
  const owned = Buffer.from(bytes);
  const startedAt = performance.now();
  let dimensions: FinanceImageOcrDimensions | null = null;
  let pgm: Uint8Array | undefined;
  try {
    if (runtime.verify) {
      await runStage(
        () =>
          runtime.verify!({
            limits,
            signal: options.signal,
            timeoutMs: stageRemainingMs(startedAt, limits.timeoutMs),
          }),
        options.signal,
        stageRemainingMs(startedAt, limits.timeoutMs),
      );
    }
    const identified = await runStage(
      () =>
        runtime.identify({
          bytes: owned,
          format: imageFormat,
          limits,
          signal: options.signal,
          timeoutMs: stageRemainingMs(startedAt, limits.timeoutMs),
        }),
      options.signal,
      stageRemainingMs(startedAt, limits.timeoutMs),
    );
    const orientation = defaultOrientation(identified.orientation);
    const frameCount = identified.frameCount ?? 1;
    if (
      !isFinitePositiveInteger(identified.width) ||
      !isFinitePositiveInteger(identified.height)
    )
      return unavailable(sourceDigest, imageFormat, 'decode-failed');
    // Check dimensions before pixel multiplication so an untrusted native
    // response cannot turn a huge value into an overflowed/accepted count.
    if (
      identified.width > limits.maxDimension ||
      identified.height > limits.maxDimension
    )
      return unavailable(sourceDigest, imageFormat, 'dimension-limit');
    dimensions =
      dimensionsOf(
        identified.width,
        identified.height,
        frameCount,
        orientation,
      ) ?? null;
    if (!dimensions)
      return unavailable(sourceDigest, imageFormat, 'decode-failed');
    if (dimensions.pixelCount > limits.maxPixels)
      return unavailable(sourceDigest, imageFormat, 'pixels-limit', dimensions);
    if (dimensions.frameCount !== 1)
      return unavailable(
        sourceDigest,
        imageFormat,
        'multi-frame-unsupported',
        dimensions,
      );
    if (!hasDefaultOrientation(dimensions.orientation))
      return unavailable(
        sourceDigest,
        imageFormat,
        'orientation-unsupported',
        dimensions,
      );
    if (identified.format !== imageFormat)
      return unavailable(
        sourceDigest,
        imageFormat,
        'format-mismatch',
        dimensions,
      );
    if (
      identified.width !== predecoded.width ||
      identified.height !== predecoded.height ||
      frameCount !== predecoded.frameCount
    )
      return unavailable(sourceDigest, imageFormat, 'decode-failed');

    const engine = runtime.describe
      ? await runStage(
          () =>
            runtime.describe!({
              limits,
              signal: options.signal,
              timeoutMs: stageRemainingMs(startedAt, limits.timeoutMs),
            }),
          options.signal,
          stageRemainingMs(startedAt, limits.timeoutMs),
        )
      : null;
    const decodedPgm = await runStage(
      () =>
        runtime.decodeToPgm({
          bytes: owned,
          format: imageFormat,
          limits,
          signal: options.signal,
          timeoutMs: stageRemainingMs(startedAt, limits.timeoutMs),
        }),
      options.signal,
      stageRemainingMs(startedAt, limits.timeoutMs),
    );
    pgm = decodedPgm;
    validatePgm(decodedPgm, dimensions.width, dimensions.height, limits);
    const tsv = await runStage(
      () =>
        runtime.recognizeTsv({
          pgm: decodedPgm,
          width: dimensions!.width,
          height: dimensions!.height,
          limits,
          signal: options.signal,
          timeoutMs: stageRemainingMs(startedAt, limits.timeoutMs),
        }),
      options.signal,
      stageRemainingMs(startedAt, limits.timeoutMs),
    );
    const parsed = parseTesseractTsv(
      tsv,
      dimensions.width,
      dimensions.height,
      limits,
    );
    const qualityStatus: 'high-confidence' | 'uncertain' | 'unreadable' =
      parsed.words.length === 0
        ? 'unreadable'
        : parsed.words.some((word) => word.confidenceStatus !== 'high')
          ? 'uncertain'
          : 'high-confidence';
    const status: 'extracted' | 'no-text' =
      parsed.words.length === 0 ? 'no-text' : 'extracted';
    const issues = [
      'ocr-text-is-untrusted-source-data',
      'ocr-text-requires-reviewed-source-selection',
      'ocr-layout-and-financial-meaning-unconfirmed',
      ...(qualityStatus === 'uncertain' ? ['ocr-confidence-needs-review'] : []),
      ...(qualityStatus === 'unreadable' ? ['ocr-no-readable-words'] : []),
      ...(parsed.hasUnsafeText ? ['ocr-text-decoding-needs-review'] : []),
      ...(engine === null ? ['ocr-engine-provenance-needs-review'] : []),
    ];
    const result = FinanceImageOcrExtractionSchema.parse({
      status,
      qualityStatus,
      format: imageFormat,
      sourceDigest,
      pageCount: 1,
      dimensions,
      width: dimensions.width,
      height: dimensions.height,
      coordinateSpace: 'image-pixels-top-left',
      engine,
      text: parsed.text,
      words: parsed.words,
      truncated: false,
      textBasis: 'machine-transcription-requires-review',
      candidate: {
        kind: 'ocr-text',
        authority: 'untrusted-source-data',
        reviewStatus: 'needs-source-review',
        normalized: false,
        sourceSelection: null,
      },
      issues,
    });
    if (
      Buffer.byteLength(JSON.stringify(result), 'utf8') > limits.maxOutputBytes
    )
      return unavailable(sourceDigest, imageFormat, 'output-limit', dimensions);
    return result;
  } catch (error) {
    if (error instanceof FinanceImageOcrCommandError)
      return unavailable(sourceDigest, imageFormat, error.reason, dimensions);
    return unavailable(sourceDigest, imageFormat, 'worker-failed', dimensions);
  } finally {
    owned.fill(0);
    if (pgm instanceof Uint8Array) pgm.fill(0);
  }
}
