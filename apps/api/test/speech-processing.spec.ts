import { describe, expect, it, vi, afterEach } from "vitest";
import { SpeechProcessingService } from "../src/speech-processing/speech-processing.service";

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
