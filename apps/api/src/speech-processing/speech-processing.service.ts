import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
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
    const activation = await this.activationService.assertEnterpriseActivationToken(activationToken);
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
      return this.transcribeWithAzureRest(input, providerProfile, progress);
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

    progress(30, "Uploading audio from isolated server to speech provider.");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(input.audioBuffer)], { type: input.mimeType }), input.filename);
    form.append("model", modelName);
    if (input.languageCode) {
      form.append("language", normalizedLanguageCode(input.languageCode));
    }
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");

    progress(55, "Provider is transcribing the recording.");
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });

    const data = await response.json().catch(() => null);
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

  private async transcribeWithAzureRest(
    input: CreateSpeechJobInput,
    providerProfile: SpeechProviderProfile,
    progress: (percent: number, message: string) => void
  ): Promise<TranscriptPayload> {
    const endpointUrl = stringValue(providerProfile.endpointUrl);
    if (!endpointUrl) {
      throw new BadRequestException(mobileError("speech_endpoint_required", "Managed Azure speech endpoint is required for server processing"));
    }

    progress(30, "Uploading prepared audio to Azure speech endpoint.");
    const response = await fetch(azureRecognitionUrl(endpointUrl, input.languageCode), {
      method: "POST",
      headers: azureHeaders(providerProfile.apiKey),
      body: new Uint8Array(input.audioBuffer)
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || data?.DisplayText || response.statusText || "Azure speech request failed";
      throw new BadRequestException(mobileError("speech_provider_failed", String(detail)));
    }

    progress(88, "Reading Azure transcription result.");
    const text = stringValue(data?.DisplayText)
      ?? stringValue(data?.text)
      ?? stringValue(data?.NBest?.[0]?.Display)
      ?? stringValue(data?.NBest?.[0]?.Lexical)
      ?? "";

    if (!text) {
      throw new BadRequestException(mobileError("empty_transcript", "Azure speech returned an empty transcript"));
    }

    return {
      languageCode: input.languageCode || "und",
      sourceEngine: "Server speech processing (Azure Speech)",
      segments: transcriptSegments(data, text, Math.max(Number(input.durationSeconds || 1), 1)),
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

function azureRecognitionUrl(endpointUrl: string, languageCode?: string) {
  const trimmed = endpointUrl.replace(/\/+$/, "");
  const base = trimmed.includes("/speech/recognition/")
    ? trimmed
    : `${trimmed}/speech/recognition/conversation/cognitiveservices/v1`;
  const url = new URL(base);
  url.searchParams.set("language", languageCode || "nb-NO");
  return url;
}

function azureHeaders(apiKey?: string | null) {
  const headers: Record<string, string> = {
    "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
    Accept: "application/json"
  };
  const key = stringValue(apiKey);
  if (key) {
    headers["Ocp-Apim-Subscription-Key"] = key;
  }
  return headers;
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
