import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { PrismaModule } from "./prisma/prisma.module";
import { ActivationModule } from "./activation/activation.module";
import { TemplatesModule } from "./templates/templates.module";
import { SpeechProcessingModule } from "./speech-processing/speech-processing.module";
import { AdminModule } from "./admin/admin.module";
import { HealthModule } from "./health/health.module";
import { validateEnvironment } from "./config/environment";
import { RateLimitGuard } from "./common/rate-limit.guard";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    ThrottlerModule.forRoot([{
      name: "default",
      ttl: 60_000,
      limit: 120
    }]),
    PrismaModule,
    AuthModule,
    ActivationModule,
    TemplatesModule,
    SpeechProcessingModule,
    AdminModule,
    HealthModule
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard
    }
  ]
})
export class AppModule {}
