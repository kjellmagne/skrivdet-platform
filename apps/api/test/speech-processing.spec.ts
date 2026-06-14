import { describe, expect, it, vi, afterEach } from "vitest";
import {
  AZURE_TRANSCRIBE_CHUNK_SECONDS,
  OPENAI_TRANSCRIBE_MAX_DURATION_SECONDS,
  SPEECH_JOB_TTL_MS,
  SPEECH_MAX_PROCESSING_MS,
  SPEECH_UPLOAD_LIMIT_BYTES,
  SpeechProcessingService,
  chunkedProgressPercent,
  shouldChunkAzureTranscription,
  shouldChunkOpenAiTranscription
} from "../src/speech-processing/speech-processing.service";

describe("SpeechProcessingService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses json response format for newer OpenAI transcribe models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "Hei verden" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new SpeechProcessingService({} as any);

    const transcript = await (service as any).transcribeWithOpenAICompatible(speechInput("gpt-4o-transcribe-api-ev3"), {
      endpointUrl: "https://api.openai.com/v1",
      apiKey: "test-key"
    }, vi.fn());

    expect(transcript.previewText).toBe("Hei verden");
    const form = fetchMock.mock.calls[0][1].body as FormData;
    expect(form.get("response_format")).toBe("json");
    expect(form.has("timestamp_granularities[]")).toBe(false);
  });

  it("keeps server speech job limits long enough for two-hour processing", () => {
    expect(SPEECH_MAX_PROCESSING_MS).toBeGreaterThanOrEqual(120 * 60 * 1000);
    expect(SPEECH_JOB_TTL_MS).toBeGreaterThan(SPEECH_MAX_PROCESSING_MS);
    expect(SPEECH_UPLOAD_LIMIT_BYTES).toBeGreaterThanOrEqual(512 * 1024 * 1024);
  });

  it("chunks long OpenAI transcription jobs instead of sending unsupported full-duration requests", () => {
    expect(shouldChunkOpenAiTranscription("gpt-4o-transcribe", OPENAI_TRANSCRIBE_MAX_DURATION_SECONDS + 1)).toBe(true);
    expect(shouldChunkOpenAiTranscription("gpt-4o-mini-transcribe", 2 * 60 * 60)).toBe(true);
    expect(shouldChunkOpenAiTranscription("gpt-4o-transcribe", OPENAI_TRANSCRIBE_MAX_DURATION_SECONDS)).toBe(false);
    expect(shouldChunkOpenAiTranscription("whisper-1", 2 * 60 * 60)).toBe(false);
  });

  it("chunks long Microsoft on-prem speech jobs for batch-style processing", () => {
    expect(shouldChunkAzureTranscription(AZURE_TRANSCRIBE_CHUNK_SECONDS + 1)).toBe(true);
    expect(shouldChunkAzureTranscription(2 * 60 * 60)).toBe(true);
    expect(shouldChunkAzureTranscription(AZURE_TRANSCRIBE_CHUNK_SECONDS)).toBe(false);
  });

  it("calculates Microsoft chunk progress from aggregate work instead of chunk order", () => {
    const ratios = [0, 0, 0, 0];
    const reported: number[] = [];
    const report = (chunkIndex: number, ratio: number) => {
      ratios[chunkIndex] = Math.max(ratios[chunkIndex], ratio);
      reported.push(Math.round(chunkedProgressPercent(ratios)));
    };

    report(3, 1);
    report(0, 0.1);
    report(1, 0.5);
    report(0, 1);

    expect(reported).toEqual([44, 45, 52, 64]);
    expect(reported).toEqual([...reported].sort((left, right) => left - right));
  });

  it("does not let a speech job percent move backwards", () => {
    const service = new SpeechProcessingService({} as any);
    const job = {
      id: "job-1",
      activationId: "activation-1",
      tenantId: "tenant-1",
      status: "queued",
      percent: 60,
      message: "Ahead",
      provider: "azure",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    (service as any).jobs.set(job.id, job);

    (service as any).updateJob(job.id, 42, "Earlier chunk reported later");

    expect(job.percent).toBe(60);
    expect(job.message).toBe("Ahead");
  });

  it("falls back to json when an OpenAI-compatible provider rejects verbose_json", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "response_format verbose_json is not compatible with model custom-stt. Use json or text instead" }
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "Fallback ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new SpeechProcessingService({} as any);

    const transcript = await (service as any).transcribeWithOpenAICompatible(speechInput("custom-stt"), {
      endpointUrl: "https://example.test/v1",
      apiKey: "test-key"
    }, vi.fn());

    expect(transcript.previewText).toBe("Fallback ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1].body as FormData).get("response_format")).toBe("verbose_json");
    expect((fetchMock.mock.calls[1][1].body as FormData).get("response_format")).toBe("json");
    expect((fetchMock.mock.calls[1][1].body as FormData).has("timestamp_granularities[]")).toBe(false);
  });
});

function speechInput(modelName: string) {
  return {
    audioBuffer: Buffer.from("test-audio"),
    filename: "recording.wav",
    mimeType: "audio/wav",
    languageCode: "nb-NO",
    durationSeconds: 3,
    modelName
  };
}
