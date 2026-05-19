import { Module } from "@nestjs/common";
import { ActivationModule } from "../activation/activation.module";
import { SpeechProcessingController } from "./speech-processing.controller";
import { SpeechProcessingService } from "./speech-processing.service";

@Module({
  imports: [ActivationModule],
  controllers: [SpeechProcessingController],
  providers: [SpeechProcessingService]
})
export class SpeechProcessingModule {}
