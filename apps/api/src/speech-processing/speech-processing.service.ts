import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import * as SpeechSDK from "microsoft-cognitiveservices-speech-sdk";
import { ActivationService, mobileError } from "../activation/activation.service";
import { decryptConfigProfileSecrets } from "../common/secret-crypto";

type CreateSpeechJobInput = {
  audioBuffer: Buffer;
  filename: string;
  mimeType: string;
  provider?: string;
  languageCode?: string;
  durationSeconds?: number;
  modelName?: string;
  speakerDiarizationEnabled?: boolean;
};

type SpeechJobStatus = "queued" | "processing" | "completed" | "failed";

type TranscriptSegment = {
  id: string;
  text: string;
  startTime: number;
  endTime: number;
  speakerLabel?: string | null;
};

type TranscriptPayload = {
  languageCode: string;
  sourceEngine: string;
  segments: TranscriptSegment[];
  previewText: string;
};

type SpeechJob = {
  id: string;
  activationId: string;
  tenantId: string;
  status: SpeechJobStatus;
  percent: number;
  message: string;
  provider: string;
  createdAt: number;
  updatedAt: number;
  transcript?: TranscriptPayload;
  error?: { code: string; message: string };
};

type SpeechProviderProfile = {
  type?: string | null;
  enabled?: boolean;
  endpointUrl?: string | null;
  modelName?: string | null;
  apiKey?: string | null;
  serverProcessingEnabled?: boolean;
  serverProcessingEndpointUrl?: string | null;
};

const JOB_TTL_MS = 15 * 60 * 1000;
const OPENAI_DEFAULT_ENDPOINT = "https://api.openai.com/v1";
const OPENAI_DEFAULT_MODEL = "gpt-4o-transcribe";
const SPEECH_TICKS_PER_SECOND = 10_000_000;
const AZURE_STANDARD_RECOGNITION_PATH = "/speech/recognition/conversation/cognitiveservices/v1";
type OpenAiTranscriptionResponseFormat = "json" | "verbose_json";

@Injectable()
export class SpeechProcessingService {
  private readonly jobs = new Map<string, SpeechJob>();

  constructor(private readonly activationService: ActivationService) {}

  async createJob(activationToken: string, input: CreateSpeechJobInput) {
    const activation = await this.activationService.assertEnterpriseActivationToken(activationToken);
    const provider = normalizeProvider(input.provider);
    const providerProfile = this.assertProviderOffloadEnabled(activation, provider);

    const job: SpeechJob = {
      id: randomUUID(),
      activationId: activation.id,
      tenantId: activation.tenantId as string,
      status: "queued",
      percent: 5,
      message: "Queued for isolated speech processing.",
      provider,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.jobs.set(job.id, job);
    this.scheduleCleanup(job.id);

    void this.processJob(job.id, input, providerProfile).catch((error) => {
      this.failJob(job.id, "speech_processing_failed", userErrorMessage(error));
    });

    return this.publicJob(job);
  }

  async jobStatus(activationToken: string, jobId: string) {
    const activation = await this.activationService.assertEnterpriseActivationToken(activationToken, { allowRotatedToken: true });
    this.purgeExpiredJobs();
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new NotFoundException(mobileError("speech_job_not_found", "Speech processing job was not found"));
    }
    if (job.activationId !== activation.id) {
      throw new ForbiddenException(mobileError("speech_job_forbidden", "Speech processing job belongs to another activation"));
    }
    return this.publicJob(job);
  }

  private assertProviderOffloadEnabled(activation: any, provider: string): SpeechProviderProfile {
    const configProfile = decryptConfigProfileSecrets(activation.enterpriseLicenseKey.configProfile);
    const providerProfiles = recordValue(configProfile.providerProfiles);
    const speechProfiles = recordValue(recordValue(providerProfiles.speech).providers);
    const selectedProvider = stringValue(recordValue(providerProfiles.speech).selected) ?? stringValue(configProfile.speechProviderType);
    const profile = recordValue(speechProfiles[provider]) as SpeechProviderProfile;
    const selectedMatches = provider === selectedProvider || !selectedProvider;
    const topLevelSelectedProfile: SpeechProviderProfile = selectedMatches ? {
      endpointUrl: stringValue(configProfile.speechEndpointUrl),
      modelName: stringValue(configProfile.speechModelName),
      apiKey: stringValue(configProfile.speechApiKey),
      serverProcessingEnabled: false
    } : {};
    const resolved = {
      ...topLevelSelectedProfile,
      ...profile
    };

    if (resolved.enabled === false || resolved.serverProcessingEnabled !== true) {
      throw new ForbiddenException(mobileError("speech_server_processing_disabled", "Server speech processing is not enabled for this enterprise provider"));
    }

    return resolved;
  }

  private async processJob(jobId: string, input: CreateSpeechJobInput, providerProfile: SpeechProviderProfile) {
    this.updateJob(jobId, 15, "Audio received. Starting isolated provider request.");
    const activeJob = this.jobs.get(jobId);
    if (!activeJob) return;

    const transcript = await this.transcribeWithManagedProvider(activeJob.provider, input, providerProfile, (percent, message) => {
      this.updateJob(jobId, percent, message);
    });

    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "completed";
    job.percent = 100;
    job.message = "Speech processing complete.";
    job.transcript = transcript;
    job.updatedAt = Date.now();
  }

  private async transcribeWithManagedProvider(
    provider: string,
    input: CreateSpeechJobInput,
    providerProfile: SpeechProviderProfile,
    progress: (percent: number, message: string) => void
  ): Promise<TranscriptPayload> {
    if (provider === "azure") {
      return this.transcribeWithAzureSdk(input, providerProfile, progress);
    }

    return this.transcribeWithOpenAICompatible(input, providerProfile, progress);
  }

  private async transcribeWithOpenAICompatible(
    input: CreateSpeechJobInput,
    providerProfile: SpeechProviderProfile,
    progress: (percent: number, message: string) => void
  ): Promise<TranscriptPayload> {
    const endpointUrl = stringValue(providerProfile.endpointUrl) ?? OPENAI_DEFAULT_ENDPOINT;
    const apiKey = stringValue(providerProfile.apiKey);
    const modelName = stringValue(input.modelName) ?? stringValue(providerProfile.modelName) ?? OPENAI_DEFAULT_MODEL;
    const requestUrl = transcriptionUrl(endpointUrl);

    if (!apiKey) {
      throw new BadRequestException(mobileError("speech_api_key_required", "Managed speech provider API key is required for server processing"));
    }

    const preferredFormat = openAiTranscriptionResponseFormat(modelName);

    progress(30, "Uploading audio from isolated server to speech provider.");
    progress(55, "Provider is transcribing the recording.");
    let { response, data } = await requestOpenAiTranscription(requestUrl, apiKey, input, modelName, preferredFormat);
    if (!response.ok && preferredFormat === "verbose_json" && isResponseFormatCompatibilityError(data)) {
      ({ response, data } = await requestOpenAiTranscription(requestUrl, apiKey, input, modelName, "json"));
    }

    if (!response.ok) {
      const detail = data?.error?.message || data?.message || response.statusText || "Speech provider request failed";
      throw new BadRequestException(mobileError("speech_provider_failed", String(detail)));
    }

    progress(88, "Reading transcription result.");
    const text = stringValue(data?.text) ?? "";
    if (!text) {
      throw new BadRequestException(mobileError("empty_transcript", "Speech provider returned an empty transcript"));
    }

    const segments = transcriptSegments(data, text, Math.max(Number(input.durationSeconds || 1), 1));
    return {
      languageCode: input.languageCode || "und",
      sourceEngine: `Server speech processing (${modelName})`,
      segments,
      previewText: text
    };
  }

  private async transcribeWithAzureSdk(
    input: CreateSpeechJobInput,
    providerProfile: SpeechProviderProfile,
    progress: (percent: number, message: string) => void
  ): Promise<TranscriptPayload> {
    const endpointUrl = stringValue(providerProfile.endpointUrl);
    if (!endpointUrl) {
      throw new BadRequestException(mobileError("speech_endpoint_required", "Managed Azure speech endpoint is required for server processing"));
    }

    progress(30, "Streaming prepared audio to Azure speech endpoint.");
    const duration = Math.max(Number(input.durationSeconds || 1), 1);
    const speechConfig = azureSpeechConfig(endpointUrl, providerProfile.apiKey, input.languageCode);
    speechConfig.speechRecognitionLanguage = input.languageCode || "nb-NO";
    speechConfig.outputFormat = SpeechSDK.OutputFormat.Detailed;
    speechConfig.setProperty(SpeechSDK.PropertyId.SpeechServiceResponse_RequestWordLevelTimestamps, "true");
    speechConfig.setProperty(SpeechSDK.PropertyId.SpeechServiceResponse_OutputFormatOption, "detailed");

    const audioConfig = SpeechSDK.AudioConfig.fromWavFileInput(input.audioBuffer, input.filename || "server-stt.wav");
    const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
    const segments: TranscriptSegment[] = [];

    try {
      await recognizeAzureFile(recognizer, duration, (result) => {
        const segment = azureResultSegment(result, duration);
        if (!segment) return;
        segments.push(segment);
        const endRatio = Math.min(segment.endTime / duration, 1);
        progress(45 + endRatio * 40, "Azure is transcribing the recording.");
      });
    } catch (error) {
      throw new BadRequestException(mobileError("speech_provider_failed", userErrorMessage(error)));
    } finally {
      await closeAzureRecognizer(recognizer);
      audioConfig.close();
    }

    progress(88, "Reading Azure transcription result.");
    const text = segments.map((segment) => segment.text).join(" ").trim();

    if (!text) {
      throw new BadRequestException(mobileError("empty_transcript", "Azure speech returned an empty transcript"));
    }

    return {
      languageCode: input.languageCode || "und",
      sourceEngine: "Server speech processing (Azure Speech)",
      segments: segments.length ? segments : transcriptSegments(null, text, duration),
      previewText: text
    };
  }

  private updateJob(jobId: string, percent: number, message: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "processing";
    job.percent = clampPercent(percent);
    job.message = message;
    job.updatedAt = Date.now();
  }

  private failJob(jobId: string, code: string, message: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "failed";
    job.percent = Math.max(job.percent, 1);
    job.message = message;
    job.error = { code, message };
    job.updatedAt = Date.now();
  }

  private publicJob(job: SpeechJob) {
    return {
      success: true,
      jobId: job.id,
      status: job.status,
      percent: job.percent,
      message: job.message,
      provider: job.provider,
      transcript: job.status === "completed" ? job.transcript : undefined,
      error: job.error
    };
  }

  private scheduleCleanup(jobId: string) {
    setTimeout(() => {
      const job = this.jobs.get(jobId);
      if (!job) return;
      if (Date.now() - job.updatedAt >= JOB_TTL_MS) {
        this.jobs.delete(jobId);
      }
    }, JOB_TTL_MS).unref?.();
  }

  private purgeExpiredJobs() {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of this.jobs.entries()) {
      if (job.updatedAt < cutoff) {
        this.jobs.delete(id);
      }
    }
  }
}

function normalizeProvider(value?: string) {
  const normalized = value?.trim().replace(/-/g, "_").toLowerCase();
  if (!normalized) {
    throw new BadRequestException(mobileError("speech_provider_required", "Speech provider is required"));
  }
  if (normalized === "openai_compatible") return "openai";
  return normalized;
}

function transcriptionUrl(endpointUrl: string) {
  const trimmed = endpointUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/audio/transcriptions")) return trimmed;
  return `${trimmed}/audio/transcriptions`;
}

function normalizedLanguageCode(value: string) {
  return value.split(/[-_]/)[0]?.toLowerCase() || value;
}

async function requestOpenAiTranscription(
  requestUrl: string,
  apiKey: string,
  input: CreateSpeechJobInput,
  modelName: string,
  responseFormat: OpenAiTranscriptionResponseFormat
) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(input.audioBuffer)], { type: input.mimeType }), input.filename);
  form.append("model", modelName);
  if (input.languageCode) {
    form.append("language", normalizedLanguageCode(input.languageCode));
  }
  form.append("response_format", responseFormat);
  if (responseFormat === "verbose_json") {
    form.append("timestamp_granularities[]", "segment");
  }

  const response = await fetch(requestUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

function openAiTranscriptionResponseFormat(modelName: string): OpenAiTranscriptionResponseFormat {
  const normalized = modelName.trim().toLowerCase();
  if (normalized.includes("gpt-4o-transcribe") || normalized.includes("gpt-4o-mini-transcribe")) {
    return "json";
  }
  return "verbose_json";
}

function isResponseFormatCompatibilityError(data: any) {
  const detail = `${data?.error?.message ?? ""} ${data?.message ?? ""}`.toLowerCase();
  return detail.includes("response_format")
    && detail.includes("verbose_json")
    && detail.includes("not compatible");
}

function azureSpeechConfig(endpointUrl: string, apiKey?: string | null, languageCode?: string) {
  const url = azureSpeechConnectionUrl(endpointUrl, languageCode);
  const key = stringValue(apiKey);
  if (url.pathname.includes("/speech/recognition/")) {
    return SpeechSDK.SpeechConfig.fromEndpoint(url, key);
  }
  const hostUrl = new URL(url);
  if (hostUrl.protocol === "ws:") {
    hostUrl.protocol = "http:";
  } else if (hostUrl.protocol === "wss:") {
    hostUrl.protocol = "https:";
  }
  return SpeechSDK.SpeechConfig.fromHost(hostUrl, key);
}

function azureSpeechConnectionUrl(endpointUrl: string, languageCode?: string) {
  const candidate = endpointUrl.includes("://") ? endpointUrl : `http://${endpointUrl}`;
  const url = new URL(candidate);
  if (!url.hostname) {
    throw new BadRequestException(mobileError("speech_endpoint_required", "Managed Azure speech endpoint is required for server processing"));
  }

  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new BadRequestException(mobileError("speech_endpoint_required", "Managed Azure speech endpoint must use http, https, ws, or wss"));
  }

  url.search = "";
  url.hash = "";

  const routePrefix = url.pathname.replace(/\/+$/, "");
  if (!routePrefix || routePrefix === "/") {
    url.pathname = "";
    return url;
  }

  if (!routePrefix.endsWith(AZURE_STANDARD_RECOGNITION_PATH)) {
    url.pathname = `${routePrefix}/${AZURE_STANDARD_RECOGNITION_PATH.replace(/^\/+/, "")}`;
  }
  url.searchParams.set("language", languageCode || "nb-NO");
  return url;
}

function recognizeAzureFile(
  recognizer: SpeechSDK.SpeechRecognizer,
  duration: number,
  onSegment: (result: SpeechSDK.SpeechRecognitionResult) => void
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeoutMs = Math.min(Math.max((duration * 4 + 120) * 1000, 60_000), JOB_TTL_MS - 30_000);
    const timeout = setTimeout(() => {
      finish(new Error("Azure speech processing timed out"));
    }, timeoutMs);

    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      recognizer.stopContinuousRecognitionAsync(
        () => error ? reject(error) : resolve(),
        (stopError) => error ? reject(error) : reject(new Error(stopError))
      );
    };

    recognizer.recognized = (_sender, event) => {
      if (event.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
        onSegment(event.result);
      }
      if (event.result.reason === SpeechSDK.ResultReason.Canceled) {
        const details = SpeechSDK.CancellationDetails.fromResult(event.result);
        const cancellationError = azureCancellationError(details, event.result.errorDetails);
        finish(cancellationError);
      }
    };

    recognizer.canceled = (_sender, event) => {
      finish(azureCancellationError(event, event.errorDetails));
    };

    recognizer.sessionStopped = () => {
      finish();
    };

    recognizer.startContinuousRecognitionAsync(
      undefined,
      (error) => finish(new Error(error))
    );
  });
}

function azureResultSegment(result: SpeechSDK.SpeechRecognitionResult, fallbackDuration: number): TranscriptSegment | null {
  const text = stringValue(result.text) ?? azureDisplayText(result) ?? "";
  if (!text.trim()) return null;
  const startTime = Math.max(result.offset / SPEECH_TICKS_PER_SECOND, 0);
  const resultDuration = Math.max(result.duration / SPEECH_TICKS_PER_SECOND, 0.1);
  return {
    id: randomUUID(),
    text,
    startTime,
    endTime: Math.max(startTime + resultDuration, Math.min(fallbackDuration, startTime + 0.1)),
    speakerLabel: stringValue(result.speakerId) ?? null
  };
}

function azureDisplayText(result: SpeechSDK.SpeechRecognitionResult) {
  const json = result.properties.getProperty(SpeechSDK.PropertyId.SpeechServiceResponse_JsonResult);
  const data = parseJson(json);
  return stringValue(data?.DisplayText)
    ?? stringValue(data?.NBest?.[0]?.Display)
    ?? stringValue(data?.NBest?.[0]?.Lexical);
}

function parseJson(value?: string) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function closeAzureRecognizer(recognizer: SpeechSDK.SpeechRecognizer) {
  return new Promise<void>((resolve) => {
    recognizer.close(resolve, () => resolve());
  });
}

function azureCancellationError(details: any, fallbackDetails?: string) {
  const detail = stringValue(fallbackDetails) ?? stringValue(details?.errorDetails);
  if (detail) return new Error(detail);

  const rawErrorCode = details?.ErrorCode ?? details?.errorCode;
  const numericErrorCode = typeof rawErrorCode === "number" ? rawErrorCode : Number(rawErrorCode);
  if (Number.isFinite(numericErrorCode) && numericErrorCode !== 0) {
    return new Error(`Azure speech recognition was canceled with error code ${numericErrorCode}`);
  }

  return undefined;
}

function transcriptSegments(data: any, fallbackText: string, duration: number): TranscriptSegment[] {
  const rawSegments = Array.isArray(data?.segments) ? data.segments : [];
  const segments = rawSegments
    .map((segment: any) => ({
      id: randomUUID(),
      text: stringValue(segment?.text) ?? "",
      startTime: Number(segment?.start ?? 0),
      endTime: Number(segment?.end ?? Math.max(duration, 0.1)),
      speakerLabel: stringValue(segment?.speaker) ?? null
    }))
    .filter((segment: TranscriptSegment) => segment.text.trim().length > 0);

  if (segments.length) return segments;
  return [{
    id: randomUUID(),
    text: fallbackText,
    startTime: 0,
    endTime: Math.max(duration, 0.1),
    speakerLabel: null
  }];
}

function clampPercent(value: number) {
  return Math.min(Math.max(Math.round(value), 0), 100);
}

function userErrorMessage(error: any) {
  return error?.response?.error?.message
    || error?.response?.message
    || error?.message
    || "Speech processing failed";
}

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
