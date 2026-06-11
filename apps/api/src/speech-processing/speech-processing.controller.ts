import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UploadedFile,
  UseInterceptors
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags
} from "@nestjs/swagger";
import { SPEECH_UPLOAD_LIMIT_BYTES, SpeechProcessingService } from "./speech-processing.service";
import { mobileError } from "../activation/activation.service";

@ApiTags("Enterprise Speech Processing")
@ApiBearerAuth()
@Controller("speech-processing")
export class SpeechProcessingController {
  constructor(private readonly speechProcessing: SpeechProcessingService) {}

  @Post("jobs")
  @UseInterceptors(FileInterceptor("audio", {
    limits: {
      fileSize: SPEECH_UPLOAD_LIMIT_BYTES,
      files: 1
    }
  }))
  @ApiOperation({
    summary: "Create server-side STT job",
    description: "Enterprise-only endpoint. The API accepts one audio file, verifies that server processing is enabled for the selected managed speech provider, processes the file in an isolated transient job, and never persists the audio payload."
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["audio", "provider", "languageCode"],
      properties: {
        audio: { type: "string", format: "binary" },
        provider: { type: "string", example: "openai" },
        languageCode: { type: "string", example: "nb-NO" },
        durationSeconds: { type: "number", example: 74 },
        modelName: { type: "string", example: "gpt-4o-transcribe" },
        speakerDiarizationEnabled: { type: "boolean", example: false }
      }
    }
  })
  @ApiOkResponse({ description: "Created job.", schema: { example: { success: true, jobId: "uuid", status: "queued", percent: 5, message: "Queued for isolated speech processing." } } })
  async createJob(
    @Headers("authorization") authorization: string | undefined,
    @UploadedFile() file: any,
    @Body() body: Record<string, string>
  ) {
    const activationToken = this.bearerToken(authorization);
    if (!file?.buffer?.length) {
      throw new BadRequestException({ success: false, error: { code: "audio_required", message: "Audio file is required" } });
    }

    return this.speechProcessing.createJob(activationToken, {
      audioBuffer: file.buffer,
      filename: file.originalname || "recording.m4a",
      mimeType: file.mimetype || "application/octet-stream",
      provider: body.provider,
      languageCode: body.languageCode,
      durationSeconds: Number(body.durationSeconds || 0),
      modelName: body.modelName,
      speakerDiarizationEnabled: body.speakerDiarizationEnabled === "true"
    });
  }

  @Get("jobs/:id")
  @ApiOperation({ summary: "Read server-side STT job status" })
  @ApiOkResponse({ description: "Job status and transcript when complete." })
  async jobStatus(
    @Headers("authorization") authorization: string | undefined,
    @Param("id") id: string
  ) {
    return this.speechProcessing.jobStatus(this.bearerToken(authorization), id);
  }

  private bearerToken(authorization: string | undefined) {
    const [scheme, token] = (authorization || "").split(" ");
    if (scheme !== "Bearer" || !token) {
      throw new BadRequestException(mobileError("activation_token_required", "Enterprise activation token is missing. Refresh the license in the app and try again."));
    }
    return token;
  }
}
