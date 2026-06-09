import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, Min, MinLength } from "class-validator";
import { ApiBearerAuth, ApiBody, ApiConflictResponse, ApiOkResponse, ApiOperation, ApiParam, ApiProperty, ApiTags, ApiUnauthorizedResponse } from "@nestjs/swagger";
import * as bcrypt from "bcryptjs";
import * as yaml from "js-yaml";
import { TemplateSectionFormatValues } from "@skrivdet/contracts";
import { PrismaService } from "../prisma/prisma.service";
import { AdminGuard } from "../auth/admin.guard";
import { activationKeyPrefix, createActivationKey, sha256 } from "../common/crypto";
import { AuditService } from "../common/audit.service";
import { TemplatesService } from "../templates/templates.service";
import { decryptConfigProfileSecrets, decryptPreviewProviderSetting, encryptConfigProfileSecrets, encryptPreviewProviderSetting } from "../common/secret-crypto";

const TEMPLATE_PREVIEW_PROVIDER_SETTING_KEY = "templatePreviewProvider";
const ADMIN_SECRET_MASK = "********";

class SingleKeyDto {
  @ApiProperty({ example: "Ola Nordmann" })
  @IsString()
  purchaserFullName!: string;

  @ApiProperty({ example: "ola@example.com" })
  @IsEmail()
  purchaserEmail!: string;

  @ApiProperty({ required: false, example: "2026-04-28T00:00:00.000Z" })
  @IsOptional()
  @IsString()
  purchaseDate?: string;

  @ApiProperty({ required: false, example: "2027-04-29T00:00:00.000Z" })
  @IsOptional()
  @IsString()
  maintenanceUntil?: string;

  @ApiProperty({ required: false, example: "Purchased through selected solution partner." })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ required: false, example: "partner-uuid" })
  @IsOptional()
  @IsString()
  partnerId?: string;
}

class EnterpriseKeyDto {
  @ApiProperty({ example: "tenant-uuid" })
  @IsString()
  tenantId!: string;

  @ApiProperty({ example: "config-profile-uuid" })
  @IsString()
  configProfileId!: string;

  @ApiProperty({ required: false, example: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxDevices?: number;

  @ApiProperty({ required: false, example: "2027-04-29T00:00:00.000Z" })
  @IsOptional()
  @IsString()
  maintenanceUntil?: string;

  @ApiProperty({ required: false, example: "Enterprise pilot key." })
  @IsOptional()
  @IsString()
  notes?: string;
}

class EnterpriseKeyUpdateDto {
  @ApiProperty({ required: false, example: "config-profile-uuid" })
  @IsOptional()
  @IsString()
  configProfileId?: string;
}

export class ConfigDto {
  @ApiProperty({ example: "Default Enterprise Profile" })
  @IsString()
  name!: string;

  @ApiProperty({ required: false, example: "partner-uuid" })
  @IsOptional()
  @IsString()
  partnerId?: string;

  @ApiProperty({ required: false, example: "Central configuration for selected enterprise tenant." })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    required: false,
    enum: ["local", "apple_online", "openai", "azure", "gemini"],
    example: "azure",
    description: "Managed speech provider for the iOS app. Values are local, apple_online, openai, azure and gemini; Gemini is supported by the app contract but is still presented as experimental/not-ready in the admin UI."
  })
  @IsOptional()
  @IsString()
  speechProviderType?: string;
  @ApiProperty({
    required: false,
    example: "https://kvasetech.com/stt",
    description: "Speech endpoint URL for endpoint-driven providers, especially Azure Speech containers, internal STT gateways, or controlled-environment routes."
  })
  @IsOptional()
  @IsString()
  speechEndpointUrl?: string;
  @ApiProperty({
    required: false,
    example: "gpt-4o-transcribe",
    description: "Optional speech model identifier. Mainly useful for OpenAI speech; leave unset for local, apple_online and normal Azure container setups."
  })
  @IsOptional()
  @IsString()
  speechModelName?: string;
  @ApiProperty({ required: false, example: "sk-speech-provider-key", description: "Optional managed speech provider API key. Prefer internal gateway endpoints or short-lived tenant-scoped keys when possible." })
  @IsOptional()
  @IsString()
  speechApiKey?: string;
  @ApiProperty({
    required: false,
    example: true,
    nullable: true,
    description: "Master privacy-control toggle. Omit or send null to leave the app's local setting alone; send true/false only when this should be centrally managed."
  })
  @IsOptional()
  @IsBoolean()
  privacyControlEnabled?: boolean | null;
  @ApiProperty({
    required: false,
    example: true,
    nullable: true,
    description: "Enables the Presidio-based PII step inside privacy control. Omit or send null to leave the local PII toggle alone."
  })
  @IsOptional()
  @IsBoolean()
  piiControlEnabled?: boolean | null;
  @ApiProperty({
    required: false,
    example: "https://presidio.example.internal",
    description: "Base URL for Microsoft Presidio Analyzer. The iOS app appends /health and /analyze."
  })
  @IsOptional()
  @IsString()
  presidioEndpointUrl?: string;
  @ApiProperty({
    required: false,
    example: "secret://skrivdet/presidio",
    description: "Optional backend-side secret reference for Presidio. Retained for compatibility/internal operations; the app does not dereference this."
  })
  @IsOptional()
  @IsString()
  presidioSecretRef?: string;
  @ApiProperty({ required: false, example: "managed-presidio-key", description: "Optional managed Presidio API key. The iOS app sends it as Authorization Bearer, X-API-Key, and apikey for common gateway compatibility." })
  @IsOptional()
  @IsString()
  presidioApiKey?: string;
  @ApiProperty({
    required: false,
    example: 0.35,
    minimum: 0,
    maximum: 1,
    description: "Minimum Presidio detection confidence threshold. Typical values are 0.3-0.7."
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  presidioScoreThreshold?: number;
  @ApiProperty({ required: false, example: true, description: "When true, person-name detection should only react to full names." })
  @IsOptional()
  @IsBoolean()
  presidioFullPersonNamesOnly?: boolean;
  @ApiProperty({ required: false, example: true, description: "Detect person names." })
  @IsOptional()
  @IsBoolean()
  presidioDetectPerson?: boolean;
  @ApiProperty({ required: false, example: true, description: "Detect email addresses." })
  @IsOptional()
  @IsBoolean()
  presidioDetectEmail?: boolean;
  @ApiProperty({ required: false, example: true, description: "Detect phone numbers." })
  @IsOptional()
  @IsBoolean()
  presidioDetectPhone?: boolean;
  @ApiProperty({ required: false, example: true, description: "Detect places and addresses." })
  @IsOptional()
  @IsBoolean()
  presidioDetectLocation?: boolean;
  @ApiProperty({ required: false, example: true, description: "Detect other identifiers such as case ids, national ids or reference numbers." })
  @IsOptional()
  @IsBoolean()
  presidioDetectIdentifier?: boolean;
  @ApiProperty({
    required: false,
    enum: ["local_heuristic", "openai_compatible", "ollama"],
    example: "openai_compatible",
    description: "Managed privacy-review/guardrail provider. Do not model OpenAI or vLLM as separate policy providers; use openai_compatible plus endpoint/model/API key."
  })
  @IsOptional()
  @IsString()
  privacyReviewProviderType?: string;
  @ApiProperty({
    required: false,
    example: "https://privacy.example.internal/v1",
    description: "Endpoint URL for privacy-review providers. Visible/relevant for openai_compatible and ollama; hide for local_heuristic."
  })
  @IsOptional()
  @IsString()
  privacyReviewEndpointUrl?: string;
  @ApiProperty({ required: false, example: "privacy-review-v1", description: "Model identifier used for the privacy-review step." })
  @IsOptional()
  @IsString()
  privacyReviewModel?: string;
  @ApiProperty({ required: false, example: "sk-privacy-review-key", description: "Optional managed privacy-review provider API key. Prefer internal gateway endpoints or short-lived tenant-scoped keys when possible." })
  @IsOptional()
  @IsString()
  privacyReviewApiKey?: string;
  @ApiProperty({
    required: false,
    example: "Review the transcript for sensitive personal information before document generation. Prefer caution when uncertain.",
    description: "Saved Personvern prompt text for privacy review guidance. It is sent to the iOS app only when managedPolicy.managePrivacyPrompt is true; otherwise devices keep the built-in or local prompt."
  })
  @IsOptional()
  @IsString()
  privacyPrompt?: string;
  @ApiProperty({
    required: false,
    enum: ["apple_intelligence", "openai_compatible", "ollama"],
    example: "openai_compatible",
    description: "Managed document-generation provider. OpenAI, vLLM and OpenAI-style gateways should all be represented as openai_compatible plus endpoint/model/API key."
  })
  @IsOptional()
  @IsString()
  documentGenerationProviderType?: string;
  @ApiProperty({
    required: false,
    example: "https://api.openai.com/v1",
    description: "Endpoint URL for document generation. Visible/relevant for openai_compatible and ollama; hide for apple_intelligence."
  })
  @IsOptional()
  @IsString()
  documentGenerationEndpointUrl?: string;
  @ApiProperty({ required: false, example: "gpt-5-mini", description: "Model identifier used to generate/formulate the final document." })
  @IsOptional()
  @IsString()
  documentGenerationModel?: string;
  @ApiProperty({ required: false, example: "sk-document-provider-key", description: "Optional managed document-generation provider API key. Prefer internal gateway endpoints or short-lived tenant-scoped keys when possible." })
  @IsOptional()
  @IsString()
  documentGenerationApiKey?: string;
  @ApiProperty({
    required: false,
    example: "https://api.skrivdet.no/api/v1/templates/manifest",
    description: "Enterprise template manifest URL. The app should call it with Authorization: Bearer <activationToken>."
  })
  @IsOptional()
  @IsString()
  templateRepositoryUrl?: string;
  @ApiProperty({ required: false, example: "https://telemetry.example.internal/events", description: "Optional telemetry endpoint for enterprise deployments." })
  @IsOptional()
  @IsString()
  telemetryEndpointUrl?: string;
  @ApiProperty({
    required: false,
    example: { developerMode: false, allowExternalProviders: false },
    description: "Boolean feature flags currently honored by the iOS app. Additional flags are passed through but ignored by older clients."
  })
  @IsOptional()
  @IsObject()
  featureFlags?: Record<string, boolean>;
  @ApiProperty({
    required: false,
    example: ["azure", "openai_compatible", "local_heuristic"],
    description: "Provider restriction hints for client/policy display. Strong enforcement depends on the iOS app version."
  })
  @IsOptional()
  @IsArray()
  allowedProviderRestrictions?: string[];
  @ApiProperty({
    required: false,
    description: "Provider catalog metadata returned to enterprise clients for richer provider availability UI. Top-level speech/documentGeneration fields still define the default managed provider; providerProfiles lists which providers are available and stores connection profiles for built-in and custom formatter providers.",
    example: {
      speech: { selected: "azure", available: ["local", "apple_online", "azure"], providers: { azure: { enabled: true, endpointUrl: "https://kvasetech.com/stt", privacyClass: "Safe" } } },
      formatter: { selected: "openai_compatible", selectedProviderId: "openai_compatible", available: ["apple_intelligence", "openai_compatible"], providers: [{ id: "openai_compatible", name: "OpenAI-compatible", type: "openai_compatible", enabled: true, endpointUrl: "https://api.openai.com/v1", modelName: "gpt-5-mini", privacyEmphasis: "managed" }] },
      privacyReview: { selected: "local_heuristic" },
      presidio: { scoreThreshold: 0.7, detectEmail: true, detectPerson: true }
    }
  })
  @IsOptional()
  @IsObject()
  providerProfiles?: Record<string, unknown>;
  @ApiProperty({
    required: false,
    description: "Policy switches consumed by the iOS app. allowPolicyOverride is the master bypass; managePrivacyControl/managePIIControl/managePrivacyReviewProvider decide whether the saved privacy fields are sent as policy at all; granular userMayChange flags allow one area to change locally while the rest stays centrally managed. hideSettings asks the app to hide/minimize local settings for managed areas. hideRecordingFloatingToolbar hides the quick toolbar on the New Recording screen. visibleSettingsWhenHidden lists the specific settings/menu items that may remain visible/editable while hideSettings is true. It is only a visibility exception list and does not centrally manage the setting value. The language exception means app UI language, not speech transcription language or template/transcript output language.",
    example: {
      allowPolicyOverride: false,
      hideSettings: true,
      hideRecordingFloatingToolbar: false,
      visibleSettingsWhenHidden: ["live_transcription_during_recording", "audio_source", "language", "recording_floating_toolbar", "privacy_prompt", "categories"],
      userMayChangeSpeechProvider: true,
      userMayChangeFormatter: false,
      managePrivacyControl: true,
      userMayChangePrivacyControl: false,
      managePIIControl: true,
      userMayChangePIIControl: false,
      managePrivacyReviewProvider: true,
      userMayChangePrivacyReviewProvider: false,
      managePrivacyPrompt: true,
      manageTemplateCategories: true
    }
  })
  @IsOptional()
  @IsObject()
  managedPolicy?: Record<string, unknown>;
  @ApiProperty({
    required: false,
    nullable: true,
    example: "00000000-0000-4000-8000-000000000401",
    description: "Optional tenant default template id. This guides the app toward a preferred template; strong enforcement is app-version dependent."
  })
  @IsOptional()
  @IsString()
  defaultTemplateId?: string | null;
  [key: string]: unknown;
}

class CloneConfigDto {
  @ApiProperty({ required: false, example: "Copy of Default Enterprise Profile" })
  @IsOptional()
  @IsString()
  name?: string;
}

class ProviderModelLookupDto {
  @ApiProperty({
    example: "document_generation",
    enum: ["speech", "document_generation", "privacy_review"],
    description: "Provider domain whose model list should be queried."
  })
  @IsIn(["speech", "document_generation", "privacy_review"])
  providerDomain!: "speech" | "document_generation" | "privacy_review";

  @ApiProperty({
    example: "openai_compatible",
    description: "Provider identifier. For document_generation and privacy_review, OpenAI and vLLM-style providers should be queried as openai_compatible."
  })
  @IsString()
  providerType!: string;

  @ApiProperty({
    required: false,
    example: "https://api.openai.com/v1",
    description: "Provider base URL or gateway URL used to fetch available model ids."
  })
  @IsOptional()
  @IsString()
  endpointUrl?: string;

  @ApiProperty({ required: false, example: "provider-api-key", description: "Optional credential used only for this model-list lookup." })
  @IsOptional()
  @IsString()
  apiKey?: string;

  @ApiProperty({
    required: false,
    example: "config-profile-uuid",
    description: "Optional ConfigProfile id. When the admin form contains a masked saved key, the server uses this id to reuse the stored credential for model lookup."
  })
  @IsOptional()
  @IsString()
  configProfileId?: string;

  @ApiProperty({
    required: false,
    example: "custom-openai-compatible",
    description: "Optional provider profile id inside providerProfiles.formatter.providers or providerProfiles.speech.providers. Used to resolve saved nested provider credentials."
  })
  @IsOptional()
  @IsString()
  providerProfileId?: string;
}

class TemplatePreviewProviderSettingDto {
  @ApiProperty({ required: false, example: "openai-compatible", description: "Metadata label for the preview provider. The current preview runner expects an OpenAI-compatible chat-completions endpoint." })
  @IsOptional()
  @IsString()
  providerType?: string;

  @ApiProperty({ required: false, example: "https://api.openai.com/v1/chat/completions" })
  @IsOptional()
  @IsString()
  endpointUrl?: string;

  @ApiProperty({ required: false, example: "gpt-5-mini" })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiProperty({ required: false, example: "sk-preview-provider-key", description: "Write-only. Omit to keep the existing saved key; send an empty string to clear it." })
  @IsOptional()
  @IsString()
  apiKey?: string;
}

class TemplateDto {
  @ApiProperty({ example: "Personlig diktat / logg" })
  @IsString()
  title!: string;

  @ApiProperty({ example: "Kort beskrivelse" })
  @IsString()
  shortDescription!: string;

  @ApiProperty({ required: false, example: "template-category-uuid" })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiProperty({ example: "nb-NO" })
  @IsString()
  language!: string;

  @ApiProperty({ example: "waveform.and.mic" })
  @IsString()
  icon!: string;

  @ApiProperty({ example: ["dictation", "personal"], type: [String] })
  @IsArray()
  tags!: string[];

  @ApiProperty({ required: false, example: "tenant-uuid" })
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiProperty({ example: "1.0.0" })
  @IsString()
  @MinLength(1)
  version!: string;

  @ApiProperty({ example: "title: Personlig diktat / logg\nlanguage: nb-NO\nsections:\n  - id: context\n    title: Kontekst\n    prompt: Oppsummer relevant kontekst kort.\n" })
  @IsString()
  yamlContent!: string;
}

class TemplateFamilyDto {
  @ApiProperty({ example: "Personlig diktat / logg" })
  @IsString()
  title!: string;

  @ApiProperty({ example: "Core personal dictation template." })
  @IsString()
  shortDescription!: string;

  @ApiProperty({ required: false, example: "template-category-uuid" })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiProperty({ required: false, example: "waveform.and.mic" })
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiProperty({ required: false, example: ["dictation", "personal"], type: [String] })
  @IsOptional()
  @IsArray()
  tags?: string[];

  @ApiProperty({ required: false, example: false, description: "When true, all enterprise tenants can see this family." })
  @IsOptional()
  @IsBoolean()
  isGlobal?: boolean;
}

class TemplateVariantDto {
  @ApiProperty({ example: "nb-NO" })
  @IsString()
  language!: string;

  @ApiProperty({ description: "One language-specific YAML template using the iOS app schema." })
  @IsString()
  yamlContent!: string;

  @ApiProperty({ required: false, description: "Sample transcript used by manual preview generation." })
  @IsOptional()
  @IsString()
  sampleTranscript?: string;
}

class TemplateDraftDto {
  @ApiProperty({ description: "Mutable draft YAML using the iOS app schema." })
  @IsString()
  yamlContent!: string;

  @ApiProperty({ required: false, description: "Sample transcript used by manual preview generation." })
  @IsOptional()
  @IsString()
  sampleTranscript?: string;
}

class TemplatePublishDto {
  @ApiProperty({ required: false, example: "patch", enum: ["patch", "minor", "major"] })
  @IsOptional()
  @IsIn(["patch", "minor", "major"])
  bump?: "patch" | "minor" | "major";

  @ApiProperty({ required: false, example: "1.0.0", description: "Exact semver override. Used mostly for first publish." })
  @IsOptional()
  @IsString()
  version?: string;
}

class TemplateEntitlementDto {
  @ApiProperty({ example: "tenant-uuid" })
  @IsString()
  tenantId!: string;
}

class TemplateAiAssistDto {
  @ApiProperty({ example: "Follow-up conversation with a user after a service meeting." })
  @IsString()
  useCase!: string;

  @ApiProperty({ required: false, example: "nb-NO" })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiProperty({ required: false, example: "oppfolgingssamtale" })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({ required: false, example: "Oppfølgingssamtale" })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ required: false, example: "arrow.triangle.2.circlepath" })
  @IsOptional()
  @IsString()
  icon?: string;
}

class TemplateCategoryDto {
  @ApiProperty({ example: "oppfolgingssamtale" })
  @IsString()
  slug!: string;

  @ApiProperty({ example: "Oppfølgingssamtale" })
  @IsString()
  title!: string;

  @ApiProperty({ required: false, example: "arrow.triangle.2.circlepath", description: "SF Symbol name used by the iOS app and mapped to a matching admin icon where possible." })
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiProperty({ required: false, example: 30, description: "Display order for centrally managed category catalogs. Lower values appear first." })
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiProperty({ required: false, example: "Templates for structured follow-up conversations." })
  @IsOptional()
  @IsString()
  description?: string;
}

class TemplateSectionPresetDto {
  @ApiProperty({ example: "action-items" })
  @IsString()
  slug!: string;

  @ApiProperty({ example: "Action items" })
  @IsString()
  title!: string;

  @ApiProperty({ example: "Extract follow-up tasks with owner and deadline when present." })
  @IsString()
  purpose!: string;

  @ApiProperty({ required: false, example: "table" })
  @IsOptional()
  @IsString()
  @IsIn([...TemplateSectionFormatValues])
  format?: string;

  @ApiProperty({ required: false, example: false })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiProperty({ required: false, example: ["task", "owner", "deadline"], type: [String] })
  @IsOptional()
  @IsArray()
  extractionHints?: string[];

  @ApiProperty({ required: false, example: 30 })
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

class TemplateTagDto {
  @ApiProperty({ example: "Dictation" })
  @IsString()
  name!: string;

  @ApiProperty({ required: false, example: "#0d9488" })
  @IsOptional()
  @IsString()
  color?: string;

  @ApiProperty({ required: false, example: "Templates used for personal or professional dictation notes." })
  @IsOptional()
  @IsString()
  description?: string;
}

class TenantDto {
  @ApiProperty({ example: "Acme Health" })
  @IsString()
  name!: string;

  @ApiProperty({ example: "acme-health" })
  @IsString()
  slug!: string;

  @ApiProperty({ required: false, example: "Acme Health AS" })
  @IsOptional()
  @IsString()
  legalName?: string;

  @ApiProperty({ required: false, example: "999888777" })
  @IsOptional()
  @IsString()
  organizationNumber?: string;

  @ApiProperty({ required: false, example: "Kari Nordmann" })
  @IsOptional()
  @IsString()
  contactName?: string;

  @ApiProperty({ required: false, example: "kari@acme.example" })
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiProperty({ required: false, example: "+47 900 00 000" })
  @IsOptional()
  @IsString()
  contactPhone?: string;

  @ApiProperty({ required: false, example: "billing@acme.example" })
  @IsOptional()
  @IsEmail()
  billingEmail?: string;

  @ApiProperty({ required: false, example: "Storgata 1" })
  @IsOptional()
  @IsString()
  addressLine1?: string;

  @ApiProperty({ required: false, example: "Floor 4" })
  @IsOptional()
  @IsString()
  addressLine2?: string;

  @ApiProperty({ required: false, example: "0155" })
  @IsOptional()
  @IsString()
  postalCode?: string;

  @ApiProperty({ required: false, example: "Oslo" })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiProperty({ required: false, example: "NO" })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiProperty({ required: false, example: "active" })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiProperty({ required: false, example: "Enterprise customer managed by staff admins." })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ required: false, example: "partner-uuid" })
  @IsOptional()
  @IsString()
  partnerId?: string;

  @ApiProperty({ required: false, example: "config-profile-uuid" })
  @IsOptional()
  @IsString()
  configProfileId?: string;
}

class PartnerDto {
  @ApiProperty({ example: "Nordic Solutions AS" })
  @IsString()
  name!: string;

  @ApiProperty({ required: false, example: "partner@example.no" })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ required: false, example: "Selected solution partner for northern Norway." })
  @IsOptional()
  @IsString()
  notes?: string;
}

class AdminUserCreateDto {
  @ApiProperty({ example: "partner.admin@example.no" })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: "Partner Admin" })
  @IsString()
  fullName!: string;

  @ApiProperty({ example: "partner_admin", enum: ["superadmin", "staff_admin", "partner_admin"] })
  @IsIn(["superadmin", "staff_admin", "partner_admin"])
  role!: "superadmin" | "staff_admin" | "partner_admin";

  @ApiProperty({ required: false, example: "partner-uuid" })
  @IsOptional()
  @IsString()
  partnerId?: string;

  @ApiProperty({ example: "ChangeMe123!", minLength: 8 })
  @IsString()
  @MinLength(8)
  password!: string;
}

class AdminUserUpdateDto {
  @ApiProperty({ required: false, example: "partner.admin@example.no" })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ required: false, example: "Partner Admin" })
  @IsOptional()
  @IsString()
  fullName?: string;

  @ApiProperty({ required: false, example: "partner_admin", enum: ["superadmin", "staff_admin", "partner_admin"] })
  @IsOptional()
  @IsIn(["superadmin", "staff_admin", "partner_admin"])
  role?: "superadmin" | "staff_admin" | "partner_admin";

  @ApiProperty({ required: false, example: "partner-uuid" })
  @IsOptional()
  @IsString()
  partnerId?: string | null;

  @ApiProperty({ required: false, example: "ChangeMe123!", minLength: 8 })
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}

@ApiTags("Admin")
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: "Missing or invalid admin bearer token." })
@UseGuards(AdminGuard)
@Controller("admin")
export class AdminController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly templates: TemplatesService) {}

  @Get("me")
  @ApiOperation({ summary: "Current admin user" })
  @ApiOkResponse({ description: "Decoded admin JWT claims.", schema: { example: { sub: "admin-uuid", email: "admin@example.com", role: "superadmin", partnerId: null } } })
  async me(@Req() req: any) {
    const user = await this.prisma.adminUser.findUnique({ where: { id: req.user.sub }, include: { partner: true } });
    return user ? { id: user.id, email: user.email, fullName: user.fullName, role: user.role, partnerId: user.partnerId, partner: user.partner } : req.user;
  }

  @Get("settings/template-preview-provider")
  @ApiOperation({ summary: "Get AI preview provider setting", description: "Superadmin only. Returns masked provider configuration for manual template preview generation." })
  @ApiOkResponse({ description: "Template preview provider setting." })
  async templatePreviewProviderSetting(@Req() req: any) {
    this.requireSuperadmin(req);
    const setting = await this.prisma.systemSetting.findUnique({ where: { key: TEMPLATE_PREVIEW_PROVIDER_SETTING_KEY } });
    return this.safeTemplatePreviewProviderSetting(setting?.value);
  }

  @Patch("settings/template-preview-provider")
  @ApiOperation({ summary: "Update AI preview provider setting", description: "Superadmin only. API key is write-only and is never returned unmasked." })
  @ApiBody({ type: TemplatePreviewProviderSettingDto })
  @ApiOkResponse({ description: "Template preview provider setting updated." })
  async updateTemplatePreviewProviderSetting(@Body() dto: TemplatePreviewProviderSettingDto, @Req() req: any) {
    this.requireSuperadmin(req);
    const current = await this.prisma.systemSetting.findUnique({ where: { key: TEMPLATE_PREVIEW_PROVIDER_SETTING_KEY } });
    const existing = this.templatePreviewProviderValue(current?.value);
    const nextProviderType = dto.providerType === undefined ? existing.providerType : this.emptyToNull(dto.providerType) ?? "openai-compatible";
    const nextEndpointUrl = dto.endpointUrl === undefined ? existing.endpointUrl : this.emptyToNull(dto.endpointUrl) ?? null;
    const nextModel = dto.model === undefined ? existing.model : this.emptyToNull(dto.model) ?? null;
    const apiKeyScopeChanged = this.previewProviderApiKeyScopeChanged(existing, {
      providerType: nextProviderType,
      endpointUrl: nextEndpointUrl
    });
    const next = {
      providerType: nextProviderType,
      endpointUrl: nextEndpointUrl,
      model: nextModel,
      apiKey: dto.apiKey === undefined
        ? (apiKeyScopeChanged ? null : existing.apiKey)
        : this.emptyToNull(dto.apiKey)
    };
    const storedValue = encryptPreviewProviderSetting(next);
    const setting = await this.prisma.systemSetting.upsert({
      where: { key: TEMPLATE_PREVIEW_PROVIDER_SETTING_KEY },
      update: { value: storedValue },
      create: { key: TEMPLATE_PREVIEW_PROVIDER_SETTING_KEY, value: storedValue }
    });
    await this.audit.log({
      actorAdminId: req.user.sub,
      actorEmail: req.user.email,
      action: "settings.template_preview_provider.update",
      targetType: "SystemSetting",
      targetId: TEMPLATE_PREVIEW_PROVIDER_SETTING_KEY,
      metadata: {
        providerType: next.providerType,
        endpointUrlConfigured: Boolean(next.endpointUrl),
        model: next.model,
        apiKeyConfigured: Boolean(next.apiKey)
      }
    });
    return this.safeTemplatePreviewProviderSetting(setting.value);
  }

  @Post("settings/template-preview-provider/models")
  @ApiOperation({ summary: "List AI preview provider models", description: "Superadmin only. Uses the saved preview provider API key when the request omits apiKey." })
  @ApiBody({ type: TemplatePreviewProviderSettingDto })
  @ApiOkResponse({ description: "Preview provider model list." })
  async templatePreviewProviderModels(@Body() dto: TemplatePreviewProviderSettingDto, @Req() req: any) {
    this.requireSuperadmin(req);
    const current = await this.prisma.systemSetting.findUnique({ where: { key: TEMPLATE_PREVIEW_PROVIDER_SETTING_KEY } });
    const saved = this.templatePreviewProviderValue(current?.value);
    const providerType = this.previewProviderLookupType(dto.providerType ?? saved.providerType);
    const endpointUrl = this.emptyToNull(dto.endpointUrl) ?? saved.endpointUrl ?? "";
    const requestApiKey = this.emptyToNull(dto.apiKey);
    const canReuseSavedApiKey = this.previewProviderRequestMatchesSavedSetting(dto, saved);
    if (requestApiKey === undefined && saved.apiKey && !canReuseSavedApiKey) {
      throw new BadRequestException("Enter an API key to test unsaved preview provider changes, or save the preview provider first.");
    }
    const apiKey = requestApiKey ?? (canReuseSavedApiKey ? saved.apiKey ?? "" : "");
    const models = await this.lookupProviderModels({
      providerDomain: "document_generation",
      providerType,
      endpointUrl,
      apiKey
    });
    return { models };
  }

  @Get("settings/template-preview-provider/status")
  @ApiOperation({ summary: "Get AI preview provider runtime status", description: "Returns whether manual template preview generation is currently configured, without exposing secrets." })
  @ApiOkResponse({ description: "Preview provider runtime status." })
  async templatePreviewProviderRuntimeStatus() {
    return this.templates.previewProviderStatus();
  }

  @Get("partners")
  @ApiOperation({ summary: "List solution partners", description: "Superadmins and staff see all partners. Partner admins see only their assigned partner." })
  @ApiOkResponse({ description: "Partner list." })
  partners(@Req() req: any) {
    const partnerId = this.scopedPartnerId(req);
    return this.prisma.partner.findMany({
      where: partnerId ? { id: partnerId } : {},
      orderBy: { name: "asc" },
      include: {
        tenants: { select: { id: true, name: true, slug: true, status: true } },
        admins: { select: { id: true, email: true, fullName: true, role: true, partnerId: true, createdAt: true } }
      }
    });
  }

  @Post("partners")
  @ApiOperation({ summary: "Create solution partner", description: "Superadmin only." })
  @ApiBody({ type: PartnerDto })
  @ApiOkResponse({ description: "Partner created." })
  async createPartner(@Body() dto: PartnerDto, @Req() req: any) {
    this.requireSuperadmin(req);
    const partner = await this.prisma.partner.create({ data: this.cleanPartner(dto) as any });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "partner.create", targetType: "Partner", targetId: partner.id });
    return partner;
  }

  @Patch("partners/:id")
  @ApiOperation({ summary: "Update solution partner", description: "Superadmin only." })
  @ApiParam({ name: "id", description: "Partner UUID." })
  @ApiBody({ type: PartnerDto })
  @ApiOkResponse({ description: "Partner updated." })
  async updatePartner(@Param("id") id: string, @Body() dto: Partial<PartnerDto>, @Req() req: any) {
    this.requireSuperadmin(req);
    const partner = await this.prisma.partner.update({ where: { id }, data: this.cleanPartner(dto) });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "partner.update", targetType: "Partner", targetId: id });
    return partner;
  }

  @Delete("partners/:id")
  @ApiOperation({ summary: "Delete solution partner", description: "Superadmin only. Partners in use by users, tenants, keys, or config profiles cannot be deleted." })
  @ApiParam({ name: "id", description: "Partner UUID." })
  @ApiOkResponse({ description: "Partner deleted.", schema: { example: { success: true } } })
  @ApiConflictResponse({ description: "Partner is in use and cannot be deleted." })
  async deletePartner(@Param("id") id: string, @Req() req: any) {
    this.requireSuperadmin(req);
    const [admins, tenants, singleKeys, enterpriseKeys, configProfiles] = await Promise.all([
      this.prisma.adminUser.count({ where: { partnerId: id } }),
      this.prisma.tenant.count({ where: { partnerId: id } }),
      this.prisma.singleLicenseKey.count({ where: { partnerId: id } }),
      this.prisma.enterpriseLicenseKey.count({ where: { partnerId: id } }),
      this.prisma.configProfile.count({ where: { partnerId: id } })
    ]);
    if (admins || tenants || singleKeys || enterpriseKeys || configProfiles) {
      throw new ConflictException("Cannot delete partner while users, tenants, keys, or config profiles reference it.");
    }
    await this.prisma.partner.delete({ where: { id } });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "partner.delete", targetType: "Partner", targetId: id });
    return { success: true };
  }

  @Get("users")
  @ApiOperation({ summary: "List admin portal users", description: "Superadmin only." })
  @ApiOkResponse({ description: "Admin portal users." })
  users(@Req() req: any) {
    this.requireSuperadmin(req);
    return this.prisma.adminUser.findMany({ orderBy: { createdAt: "desc" }, include: { partner: true } }).then((users) => users.map((user) => this.withoutPassword(user)));
  }

  @Post("users")
  @ApiOperation({ summary: "Create admin portal user", description: "Superadmin only. Partner admins must be assigned to a solution partner." })
  @ApiBody({ type: AdminUserCreateDto })
  @ApiOkResponse({ description: "Admin user created." })
  async createUser(@Body() dto: AdminUserCreateDto, @Req() req: any) {
    this.requireSuperadmin(req);
    const data = await this.cleanAdminUser(dto, true);
    const user = await this.prisma.adminUser.create({ data, include: { partner: true } });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "admin_user.create", targetType: "AdminUser", targetId: user.id });
    return this.withoutPassword(user);
  }

  @Patch("users/:id")
  @ApiOperation({ summary: "Update admin portal user", description: "Superadmin only." })
  @ApiParam({ name: "id", description: "AdminUser UUID." })
  @ApiBody({ type: AdminUserUpdateDto })
  @ApiOkResponse({ description: "Admin user updated." })
  async updateUser(@Param("id") id: string, @Body() dto: AdminUserUpdateDto, @Req() req: any) {
    this.requireSuperadmin(req);
    const existing = await this.prisma.adminUser.findUnique({ where: { id } });
    const effectiveRole = dto.role ?? existing?.role;
    const effectivePartnerId = dto.partnerId === undefined ? existing?.partnerId : dto.partnerId;
    if (effectiveRole === "partner_admin" && !effectivePartnerId) {
      throw new ConflictException("Partner admins must be assigned to a solution partner.");
    }
    if (dto.role && dto.role !== "superadmin") await this.ensureAnotherSuperadmin(id);
    const data: any = await this.cleanAdminUser(dto, false);
    if (dto.password || dto.role !== undefined || dto.partnerId !== undefined) {
      data.tokenVersion = { increment: 1 };
      data.failedLoginCount = 0;
      data.lockedUntil = null;
    }
    const user = await this.prisma.adminUser.update({ where: { id }, data, include: { partner: true } });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "admin_user.update", targetType: "AdminUser", targetId: id });
    return this.withoutPassword(user);
  }

  @Delete("users/:id")
  @ApiOperation({ summary: "Delete admin portal user", description: "Superadmin only." })
  @ApiParam({ name: "id", description: "AdminUser UUID." })
  @ApiOkResponse({ description: "Admin user deleted.", schema: { example: { success: true } } })
  async deleteUser(@Param("id") id: string, @Req() req: any) {
    this.requireSuperadmin(req);
    if (id === req.user.sub) throw new ConflictException("You cannot delete your own admin user.");
    await this.ensureAnotherSuperadmin(id);
    await this.prisma.adminUser.delete({ where: { id } });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "admin_user.delete", targetType: "AdminUser", targetId: id });
    return { success: true };
  }

  @Get("overview")
  @ApiOperation({ summary: "Admin dashboard overview", description: "Counts and latest audit entries for the internal admin dashboard." })
  @ApiOkResponse({ description: "Overview counters and recent audit logs.", schema: { example: { singleKeys: 12, enterpriseKeys: 3, activations: 8, activeUniqueDevices: 7, templates: 5, audits: [] } } })
  async overview(@Req() req: any) {
    const partnerId = this.scopedPartnerId(req);
    const singleWhere = partnerId ? { partnerId } : {};
    const enterpriseWhere = partnerId ? { OR: [{ partnerId }, { tenant: { partnerId } }] } : {};
    const activationWhere = partnerId ? { OR: [{ tenant: { partnerId } }, { singleLicenseKey: { partnerId } }] } : {};
    const templateWhere = partnerId ? { entitlements: { some: { tenant: { partnerId } } } } : {};
    const [singleKeys, enterpriseKeys, activations, activeUniqueDevices, templates, audits] = await Promise.all([
      this.prisma.singleLicenseKey.count({ where: singleWhere }),
      this.prisma.enterpriseLicenseKey.count({ where: enterpriseWhere }),
      this.prisma.deviceActivation.count({ where: activationWhere }),
      this.prisma.deviceActivation.findMany({ where: { ...activationWhere, status: "active" }, select: { deviceIdentifier: true } }),
      this.prisma.templateFamily.count({ where: templateWhere }),
      this.prisma.activationAuditLog.findMany({ where: partnerId ? { actorAdminId: req.user.sub } : {}, orderBy: { createdAt: "desc" }, take: 25 })
    ]);
    return { singleKeys, enterpriseKeys, activations, activeUniqueDevices: new Set(activeUniqueDevices.map((item) => item.deviceIdentifier)).size, templates, audits };
  }

  @Get("single-keys")
  @ApiOperation({ summary: "List single-user license keys", description: "Returns single-user key records. Full keys are never returned after creation; only hashed storage and key prefixes are retained." })
  @ApiOkResponse({ description: "Single-user license key list." })
  singleKeys(@Req() req: any) {
    const partnerId = this.scopedPartnerId(req);
    return this.prisma.singleLicenseKey.findMany({ where: partnerId ? { partnerId } : {}, orderBy: { createdAt: "desc" }, include: { partner: true, activations: true } });
  }

  @Post("single-keys")
  @ApiOperation({ summary: "Generate single-user activation key", description: "Creates a display-once activation key. The response includes activationKey once; store/copy it immediately." })
  @ApiBody({ type: SingleKeyDto })
  @ApiOkResponse({ description: "Single-user key generated.", schema: { example: { id: "license-uuid", activationKey: "SKRIVDET-S-ABC123-DEF456-GHI789-JKL012", keyPrefix: "SKRIVDET-S-ABC123", purchaserFullName: "Ola Nordmann", purchaserEmail: "ola@example.com", status: "active" } } })
  async createSingleKey(@Body() dto: SingleKeyDto, @Req() req: any) {
    const partnerId = this.scopedPartnerId(req) ?? dto.partnerId;
    const activationKey = createActivationKey("SKRIVDET-S");
    const key = await this.prisma.singleLicenseKey.create({
      data: {
        keyHash: sha256(activationKey),
        keyPrefix: activationKeyPrefix(activationKey),
        purchaserFullName: dto.purchaserFullName,
        purchaserEmail: dto.purchaserEmail,
        purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : undefined,
        maintenanceUntil: dto.maintenanceUntil ? new Date(dto.maintenanceUntil) : undefined,
        notes: dto.notes,
        partnerId,
        createdByAdminId: req.user.sub
      }
    });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "license.single.generate", targetType: "SingleLicenseKey", targetId: key.id });
    return { ...key, activationKey };
  }

  @Patch("single-keys/:id/revoke")
  @ApiOperation({ summary: "Toggle single-user license revocation", description: "Revokes an active key, or reactivates a revoked key without resetting the device binding." })
  @ApiParam({ name: "id", description: "SingleLicenseKey UUID." })
  @ApiOkResponse({ description: "License key revocation toggled." })
  async revokeSingle(@Param("id") id: string, @Req() req: any) {
    const current = await this.assertSingleKeyAccess(req, id);
    const status = current.status === "revoked" ? "active" : "revoked";
    const key = await this.prisma.singleLicenseKey.update({ where: { id }, data: { status } });
    await this.prisma.deviceActivation.updateMany({ where: { singleLicenseKeyId: id }, data: { status } });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: status === "revoked" ? "license.single.revoke" : "license.single.reactivate", targetType: "SingleLicenseKey", targetId: id });
    return key;
  }

  @Patch("single-keys/:id/reset")
  @ApiOperation({ summary: "Reset single-user device binding", description: "Deletes device activations for the single-user key and makes it active/unbound again." })
  @ApiParam({ name: "id", description: "SingleLicenseKey UUID." })
  @ApiOkResponse({ description: "License key reset." })
  async resetSingle(@Param("id") id: string, @Req() req: any) {
    await this.assertSingleKeyAccess(req, id);
    await this.prisma.deviceActivation.deleteMany({ where: { singleLicenseKeyId: id } });
    const key = await this.prisma.singleLicenseKey.update({ where: { id }, data: { deviceIdentifier: null, deviceSerialNumber: null, activatedAt: null, lastCheckIn: null, lastSeenAt: null, status: "active" } });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "license.single.reset", targetType: "SingleLicenseKey", targetId: id });
    return key;
  }

  @Delete("single-keys/:id")
  @ApiOperation({ summary: "Delete single-user license key", description: "Deletes a single-user key and any associated device activations." })
  @ApiParam({ name: "id", description: "SingleLicenseKey UUID." })
  @ApiOkResponse({ description: "Single-user key deleted.", schema: { example: { success: true, deletedActivations: 1 } } })
  async deleteSingleKey(@Param("id") id: string, @Req() req: any) {
    await this.assertSingleKeyAccess(req, id);
    const deletedActivations = await this.prisma.deviceActivation.deleteMany({ where: { singleLicenseKeyId: id } });
    await this.prisma.singleLicenseKey.delete({ where: { id } });
    await this.audit.log({
      actorAdminId: req.user.sub,
      actorEmail: req.user.email,
      action: "license.single.delete",
      targetType: "SingleLicenseKey",
      targetId: id,
      metadata: { deletedActivations: deletedActivations.count }
    });
    return { success: true, deletedActivations: deletedActivations.count };
  }

  @Get("enterprise-keys")
  @ApiOperation({ summary: "List enterprise license keys" })
  @ApiOkResponse({ description: "Enterprise license key list with tenant/config profile info." })
  enterpriseKeys(@Req() req: any) {
    const partnerId = this.scopedPartnerId(req);
    return this.prisma.enterpriseLicenseKey.findMany({
      where: partnerId ? { OR: [{ partnerId }, { tenant: { partnerId } }] } : {},
      orderBy: { createdAt: "desc" },
      include: { tenant: { include: { configProfile: true } }, partner: true, configProfile: true, activations: true }
    });
  }

  @Post("enterprise-keys")
  @ApiOperation({ summary: "Generate enterprise activation key", description: "Creates a display-once enterprise activation key linked to a tenant and config profile." })
  @ApiBody({ type: EnterpriseKeyDto })
  @ApiOkResponse({ description: "Enterprise key generated.", schema: { example: { id: "enterprise-key-uuid", activationKey: "SKRIVDET-E-ABC123-DEF456-GHI789-JKL012", keyPrefix: "SKRIVDET-E-ABC123", status: "active", maxDevices: 100 } } })
  async createEnterpriseKey(@Body() dto: EnterpriseKeyDto, @Req() req: any) {
    const tenant = await this.assertTenantAccess(req, dto.tenantId);
    await this.assertConfigAccess(req, dto.configProfileId);
    const activationKey = createActivationKey("SKRIVDET-E");
    const key = await this.prisma.enterpriseLicenseKey.create({
      data: {
        keyHash: sha256(activationKey),
        keyPrefix: activationKeyPrefix(activationKey),
        tenantId: dto.tenantId,
        configProfileId: dto.configProfileId,
        maxDevices: dto.maxDevices,
        maintenanceUntil: dto.maintenanceUntil ? new Date(dto.maintenanceUntil) : undefined,
        notes: dto.notes,
        partnerId: tenant.partnerId,
        createdByAdminId: req.user.sub
      },
      include: { tenant: true, configProfile: true }
    });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "license.enterprise.generate", targetType: "EnterpriseLicenseKey", targetId: key.id });
    return { ...key, activationKey };
  }

  @Patch("enterprise-keys/:id")
  @ApiOperation({ summary: "Update enterprise license key assignment", description: "Updates the config profile assigned to an existing enterprise key. Devices activated with this key receive the new profile on their next activation refresh." })
  @ApiParam({ name: "id", description: "EnterpriseLicenseKey UUID." })
  @ApiBody({ type: EnterpriseKeyUpdateDto })
  @ApiOkResponse({ description: "Enterprise key updated." })
  async updateEnterpriseKey(@Param("id") id: string, @Body() dto: EnterpriseKeyUpdateDto, @Req() req: any) {
    await this.assertEnterpriseKeyAccess(req, id);
    if (dto.configProfileId) await this.assertConfigAccess(req, dto.configProfileId);
    const key = await this.prisma.enterpriseLicenseKey.update({
      where: { id },
      data: {
        ...(dto.configProfileId ? { configProfileId: dto.configProfileId } : {})
      },
      include: { tenant: { include: { configProfile: true } }, partner: true, configProfile: true, activations: true }
    });
    await this.audit.log({
      actorAdminId: req.user.sub,
      actorEmail: req.user.email,
      action: "license.enterprise.update",
      targetType: "EnterpriseLicenseKey",
      targetId: id,
      metadata: { configProfileId: dto.configProfileId }
    });
    return key;
  }

  @Delete("enterprise-keys/:id")
  @ApiOperation({ summary: "Delete enterprise license key", description: "Deletes an enterprise key and any registered device activations for that key." })
  @ApiParam({ name: "id", description: "EnterpriseLicenseKey UUID." })
  @ApiOkResponse({ description: "Enterprise key deleted.", schema: { example: { success: true, deletedActivations: 3 } } })
  async deleteEnterpriseKey(@Param("id") id: string, @Req() req: any) {
    await this.assertEnterpriseKeyAccess(req, id);
    const deletedActivations = await this.prisma.deviceActivation.deleteMany({ where: { enterpriseLicenseKeyId: id } });
    await this.prisma.enterpriseLicenseKey.delete({ where: { id } });
    await this.audit.log({
      actorAdminId: req.user.sub,
      actorEmail: req.user.email,
      action: "license.enterprise.delete",
      targetType: "EnterpriseLicenseKey",
      targetId: id,
      metadata: { deletedActivations: deletedActivations.count }
    });
    return { success: true, deletedActivations: deletedActivations.count };
  }

  @Get("tenants")
  @ApiOperation({ summary: "List tenants", description: "Returns enterprise/customer tenant records with active unique-device license usage counts." })
  @ApiOkResponse({ description: "Tenant list with license usage.", schema: { example: [{ id: "tenant-uuid", name: "Acme Health", slug: "acme-health", contactEmail: "kari@acme.example", licenseUsage: { activeDevices: 8, totalDevices: 10, enterpriseKeys: 2, licensedDevices: 100, unlimited: false } }] } })
  async tenants(@Req() req: any) {
    const partnerId = this.scopedPartnerId(req);
    const tenants = await this.prisma.tenant.findMany({
      where: partnerId ? { partnerId } : {},
      orderBy: { name: "asc" },
      include: { configProfile: true, partner: true, activations: true, enterpriseKeys: true }
    });
    return tenants.map((tenant) => ({ ...tenant, licenseUsage: this.tenantLicenseUsage(tenant) }));
  }

  @Post("tenants")
  @ApiOperation({ summary: "Create tenant/customer", description: "Registers an enterprise customer/tenant and optional contact/legal/billing details." })
  @ApiBody({ type: TenantDto })
  @ApiOkResponse({ description: "Tenant created." })
  async tenantsCreate(@Body() dto: TenantDto, @Req() req: any) {
    const partnerId = this.scopedPartnerId(req);
    if (partnerId) dto.partnerId = partnerId;
    if (dto.configProfileId) await this.assertConfigAccess(req, dto.configProfileId);
    const tenant = await this.prisma.tenant.create({ data: this.cleanTenant(dto) as any });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "tenant.create", targetType: "Tenant", targetId: tenant.id });
    return tenant;
  }

  @Patch("tenants/:id")
  @ApiOperation({ summary: "Update tenant/customer details" })
  @ApiParam({ name: "id", description: "Tenant UUID." })
  @ApiBody({ type: TenantDto })
  @ApiOkResponse({ description: "Tenant updated." })
  async tenantsUpdate(@Param("id") id: string, @Body() dto: Partial<TenantDto>, @Req() req: any) {
    await this.assertTenantAccess(req, id);
    const partnerId = this.scopedPartnerId(req);
    if (partnerId) dto.partnerId = partnerId;
    if (dto.configProfileId) await this.assertConfigAccess(req, dto.configProfileId);
    const tenant = await this.prisma.tenant.update({ where: { id }, data: this.cleanTenant(dto) as any });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "tenant.update", targetType: "Tenant", targetId: id });
    return tenant;
  }

  @Delete("tenants/:id")
  @ApiOperation({ summary: "Delete tenant/customer", description: "Deletes a tenant only when it has no enterprise keys, activations, or tenant-specific templates." })
  @ApiParam({ name: "id", description: "Tenant UUID." })
  @ApiOkResponse({ description: "Tenant deleted.", schema: { example: { success: true } } })
  @ApiConflictResponse({ description: "Tenant is in use and cannot be deleted." })
  async tenantsDelete(@Param("id") id: string, @Req() req: any) {
    await this.assertTenantAccess(req, id);
    const [enterpriseKeys, activations, templates, entitlements] = await Promise.all([
      this.prisma.enterpriseLicenseKey.count({ where: { tenantId: id } }),
      this.prisma.deviceActivation.count({ where: { tenantId: id } }),
      this.prisma.template.count({ where: { tenantId: id } }),
      this.prisma.tenantTemplateEntitlement.count({ where: { tenantId: id } })
    ]);
    if (enterpriseKeys || activations || templates || entitlements) {
      throw new ConflictException("Cannot delete tenant with enterprise keys, activations, or template entitlements. Disable it instead.");
    }
    await this.prisma.tenant.delete({ where: { id } });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "tenant.delete", targetType: "Tenant", targetId: id });
    return { success: true };
  }

  @Get("license-usage")
  @ApiOperation({ summary: "Enterprise license usage summary", description: "Shows unique active device counts per tenant and global active unique-device totals." })
  @ApiOkResponse({ description: "License usage summary.", schema: { example: { activeUniqueDevices: 8, tenants: [{ tenantId: "tenant-uuid", name: "Acme Health", activeDevices: 8, totalDevices: 10, licensedDevices: 100, unlimited: false }] } } })
  async licenseUsage(@Req() req: any) {
    const partnerId = this.scopedPartnerId(req);
    const tenants = await this.prisma.tenant.findMany({ where: partnerId ? { partnerId } : {}, orderBy: { name: "asc" }, include: { activations: true, enterpriseKeys: true } });
    const activeDeviceSet = new Set<string>();
    const tenantUsage = tenants.map((tenant) => {
      const usage = this.tenantLicenseUsage(tenant);
      tenant.activations.filter((activation) => activation.status === "active").forEach((activation) => activeDeviceSet.add(activation.deviceIdentifier));
      return { tenantId: tenant.id, name: tenant.name, slug: tenant.slug, ...usage };
    });
    return { activeUniqueDevices: activeDeviceSet.size, tenants: tenantUsage };
  }

  @Get("config-profiles")
  @ApiOperation({ summary: "List config profiles" })
  @ApiOkResponse({ description: "Config profile list." })
  configProfiles(@Req() req: any) {
    const partnerId = this.scopedPartnerId(req);
    return this.prisma.configProfile
      .findMany({ where: partnerId ? { partnerId } : {}, orderBy: { updatedAt: "desc" }, include: { partner: true } })
      .then((profiles) => profiles.map((profile) => this.maskAdminConfigSecrets(profile)));
  }

  @Post("config-profiles")
  @ApiOperation({ summary: "Create config profile", description: "Creates a manually managed enterprise configuration profile." })
  @ApiBody({ type: ConfigDto })
  @ApiOkResponse({ description: "Config profile created." })
  async createConfig(@Body() dto: ConfigDto, @Req() req: any) {
    const partnerId = this.scopedPartnerId(req);
    if (partnerId) dto.partnerId = partnerId;
    const profile = await this.prisma.configProfile.create({ data: this.cleanConfig(dto) as any });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "config.create", targetType: "ConfigProfile", targetId: profile.id });
    return this.maskAdminConfigSecrets(profile);
  }

  @Post("config-profiles/:id/clone")
  @ApiOperation({ summary: "Clone config profile", description: "Creates a new policy/config profile by copying all managed provider, privacy, repository, and policy fields from an existing profile." })
  @ApiParam({ name: "id", description: "ConfigProfile UUID to clone." })
  @ApiBody({ type: CloneConfigDto, required: false })
  @ApiOkResponse({ description: "Config profile cloned." })
  async cloneConfig(@Param("id") id: string, @Body() dto: CloneConfigDto = {}, @Req() req: any) {
    const source = await this.assertConfigAccess(req, id);
    const {
      id: _id,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      tenants: _tenants,
      enterpriseKeys: _enterpriseKeys,
      partner: _partner,
      ...copyable
    } = source as any;
    const name = this.emptyToNull(dto?.name) ?? `Copy of ${source.name}`;
    const profile = await this.prisma.configProfile.create({
      data: {
        ...copyable,
        managedPolicy: this.normalizeManagedPolicy(copyable.managedPolicy, copyable),
        name
      },
      include: { partner: true }
    });
    await this.audit.log({
      actorAdminId: req.user.sub,
      actorEmail: req.user.email,
      action: "config.clone",
      targetType: "ConfigProfile",
      targetId: profile.id,
      metadata: { sourceConfigProfileId: id }
    });
    return this.maskAdminConfigSecrets(profile);
  }

  @Post("provider-models")
  @ApiOperation({ summary: "List provider models", description: "Loads available model identifiers from a speech, document-generation, or privacy-review provider using the endpoint and API key supplied by the admin policy editor." })
  @ApiBody({ type: ProviderModelLookupDto })
  @ApiOkResponse({ description: "Provider models.", schema: { example: { success: true, providerType: "openai_compatible", models: [{ id: "my-model", name: "my-model" }] } } })
  async providerModels(@Body() dto: ProviderModelLookupDto) {
    const lookup = await this.resolveProviderModelLookup(dto);
    const models = await this.lookupProviderModels(lookup);
    return { success: true, providerType: dto.providerType, models };
  }

  @Patch("config-profiles/:id")
  @ApiOperation({ summary: "Update config profile" })
  @ApiParam({ name: "id", description: "ConfigProfile UUID." })
  @ApiBody({ type: ConfigDto })
  @ApiOkResponse({ description: "Config profile updated." })
  async updateConfig(@Param("id") id: string, @Body() dto: ConfigDto, @Req() req: any) {
    const existing = await this.assertConfigAccess(req, id);
    const partnerId = this.scopedPartnerId(req);
    if (partnerId) dto.partnerId = partnerId;
    const profile = await this.prisma.configProfile.update({ where: { id }, data: this.cleanConfig(dto, existing) as any });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "config.update", targetType: "ConfigProfile", targetId: id });
    return this.maskAdminConfigSecrets(profile);
  }

  @Delete("config-profiles/:id")
  @ApiOperation({ summary: "Delete config profile", description: "Deletes a config profile only when no tenants or enterprise keys reference it." })
  @ApiParam({ name: "id", description: "ConfigProfile UUID." })
  @ApiOkResponse({ description: "Config profile deleted.", schema: { example: { success: true } } })
  @ApiConflictResponse({ description: "Config profile is in use and cannot be deleted." })
  async deleteConfig(@Param("id") id: string, @Req() req: any) {
    await this.assertConfigAccess(req, id);
    const [tenants, enterpriseKeys] = await Promise.all([
      this.prisma.tenant.count({ where: { configProfileId: id } }),
      this.prisma.enterpriseLicenseKey.count({ where: { configProfileId: id } })
    ]);
    if (tenants || enterpriseKeys) {
      throw new ConflictException("Cannot delete config profile while tenants or enterprise keys reference it.");
    }
    await this.prisma.configProfile.delete({ where: { id } });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "config.delete", targetType: "ConfigProfile", targetId: id });
    return { success: true };
  }

  @Get("template-families")
  @ApiOperation({ summary: "Template repository families", description: "Lists template families with language variants, mutable drafts, published version history and tenant entitlements." })
  @ApiOkResponse({ description: "Template repository family list." })
  templateFamilies(@Req() req: any) {
    const partnerId = this.scopedPartnerId(req);
    return this.prisma.templateFamily.findMany({
      where: partnerId ? { OR: [{ isGlobal: true }, { entitlements: { some: { tenant: { partnerId } } } }] } : {},
      orderBy: { updatedAt: "desc" },
      include: this.templateFamilyInclude()
    });
  }

  @Post("template-families")
  @ApiOperation({ summary: "Create template family", description: "Creates the logical use-case family that groups language-specific template variants." })
  @ApiBody({ type: TemplateFamilyDto })
  @ApiOkResponse({ description: "Template family created." })
  async createTemplateFamily(@Body() dto: TemplateFamilyDto, @Req() req: any) {
    const family = await this.prisma.templateFamily.create({
      data: {
        title: dto.title,
        shortDescription: dto.shortDescription,
        categoryId: dto.categoryId || undefined,
        icon: dto.icon || "doc.text",
        tags: this.normalizeTagList(dto.tags ?? []),
        isGlobal: dto.isGlobal ?? false
      },
      include: this.templateFamilyInclude()
    });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.family.create", targetType: "TemplateFamily", targetId: family.id });
    return family;
  }

  @Patch("template-families/:id")
  @ApiOperation({ summary: "Update template family metadata" })
  @ApiParam({ name: "id", description: "TemplateFamily UUID." })
  @ApiBody({ type: TemplateFamilyDto })
  @ApiOkResponse({ description: "Template family updated." })
  async updateTemplateFamily(@Param("id") id: string, @Body() dto: Partial<TemplateFamilyDto>, @Req() req: any) {
    await this.assertTemplateFamilyAccess(req, id);
    const family = await this.prisma.templateFamily.update({
      where: { id },
      data: {
        title: dto.title,
        shortDescription: dto.shortDescription,
        categoryId: dto.categoryId || undefined,
        icon: dto.icon,
        tags: dto.tags === undefined ? undefined : this.normalizeTagList(dto.tags),
        isGlobal: dto.isGlobal
      },
      include: this.templateFamilyInclude()
    });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.family.update", targetType: "TemplateFamily", targetId: id });
    return family;
  }

  @Patch("template-families/:id/archive")
  @ApiOperation({ summary: "Archive template family", description: "Archived families are hidden from the mobile manifest." })
  @ApiParam({ name: "id", description: "TemplateFamily UUID." })
  @ApiOkResponse({ description: "Template family archived." })
  async archiveTemplateFamily(@Param("id") id: string, @Req() req: any) {
    await this.assertTemplateFamilyAccess(req, id);
    const family = await this.prisma.templateFamily.update({ where: { id }, data: { state: "archived" }, include: this.templateFamilyInclude() });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.family.archive", targetType: "TemplateFamily", targetId: id });
    return family;
  }

  @Post("template-families/:id/variants")
  @ApiOperation({ summary: "Create language variant draft", description: "Creates one language-specific YAML track inside a template family." })
  @ApiParam({ name: "id", description: "TemplateFamily UUID." })
  @ApiBody({ type: TemplateVariantDto })
  @ApiOkResponse({ description: "Template variant created." })
  async createTemplateVariant(@Param("id") id: string, @Body() dto: TemplateVariantDto, @Req() req: any) {
    await this.assertTemplateFamilyAccess(req, id);
    const metadata = this.templates.metadataFromYaml(dto.yamlContent);
    if (metadata.language !== dto.language) throw new ConflictException("Variant language must match identity.language in the YAML.");
    const variant = await this.prisma.templateVariant.create({
      data: {
        familyId: id,
        language: metadata.language,
        templateIdentityId: metadata.id,
        draft: { create: { yamlContent: dto.yamlContent, sampleTranscript: dto.sampleTranscript, createdByAdminId: req.user.sub } }
      },
      include: { family: true, draft: true, publishedVersions: { orderBy: { publishedAt: "desc" } } }
    });
    await this.prisma.templateFamily.update({
      where: { id },
      data: { title: metadata.title, shortDescription: metadata.shortDescription, icon: metadata.icon, tags: this.normalizeTagList(metadata.tags) }
    });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.variant.create", targetType: "TemplateVariant", targetId: variant.id });
    return variant;
  }

  @Patch("template-variants/:id/draft")
  @ApiOperation({ summary: "Update template variant draft", description: "Updates the mutable draft YAML and sample transcript. This does not affect the mobile app until published." })
  @ApiParam({ name: "id", description: "TemplateVariant UUID." })
  @ApiBody({ type: TemplateDraftDto })
  @ApiOkResponse({ description: "Template draft updated." })
  async updateTemplateDraft(@Param("id") id: string, @Body() dto: TemplateDraftDto, @Req() req: any) {
    const variant = await this.assertTemplateVariantAccess(req, id);
    const metadata = this.templates.metadataFromYaml(dto.yamlContent);
    const draft = await this.prisma.templateDraft.upsert({
      where: { variantId: id },
      update: {
        yamlContent: dto.yamlContent,
        sampleTranscript: dto.sampleTranscript,
        previewError: null
      },
      create: {
        variantId: id,
        yamlContent: dto.yamlContent,
        sampleTranscript: dto.sampleTranscript,
        createdByAdminId: req.user.sub
      }
    });
    await this.prisma.templateVariant.update({ where: { id }, data: { language: metadata.language, templateIdentityId: metadata.id } });
    await this.prisma.templateFamily.update({ where: { id: variant.familyId }, data: { title: metadata.title, shortDescription: metadata.shortDescription, icon: metadata.icon, tags: this.normalizeTagList(metadata.tags) } });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.draft.update", targetType: "TemplateDraft", targetId: draft.id });
    return draft;
  }

  @Post("template-variants/:id/publish")
  @ApiOperation({ summary: "Publish template variant draft", description: "Validates the current draft, applies the selected semver bump, and stores an immutable published YAML snapshot." })
  @ApiParam({ name: "id", description: "TemplateVariant UUID." })
  @ApiBody({ type: TemplatePublishDto })
  @ApiOkResponse({ description: "Template variant published.", schema: { example: { success: true, version: "1.0.1" } } })
  async publishTemplateVariant(@Param("id") id: string, @Body() dto: TemplatePublishDto, @Req() req: any) {
    await this.assertTemplateVariantAccess(req, id);
    return this.templates.publishVariantDraft(id, dto, { id: req.user.sub, email: req.user.email });
  }

  @Get("template-variants/:id/versions")
  @ApiOperation({ summary: "Published version history for a template variant" })
  @ApiParam({ name: "id", description: "TemplateVariant UUID." })
  @ApiOkResponse({ description: "Published template versions." })
  async templateVariantVersions(@Param("id") id: string, @Req() req: any) {
    await this.assertTemplateVariantAccess(req, id);
    return this.prisma.publishedTemplateVersion.findMany({ where: { variantId: id }, orderBy: { publishedAt: "desc" } });
  }

  @Post("template-families/:id/entitlements")
  @ApiOperation({ summary: "Assign template family to tenant" })
  @ApiParam({ name: "id", description: "TemplateFamily UUID." })
  @ApiBody({ type: TemplateEntitlementDto })
  @ApiOkResponse({ description: "Tenant entitlement assigned." })
  async addTemplateEntitlement(@Param("id") id: string, @Body() dto: TemplateEntitlementDto, @Req() req: any) {
    await this.assertTemplateFamilyAccess(req, id);
    await this.assertTenantAccess(req, dto.tenantId);
    const entitlement = await this.prisma.tenantTemplateEntitlement.upsert({
      where: { tenantId_familyId: { tenantId: dto.tenantId, familyId: id } },
      update: {},
      create: { tenantId: dto.tenantId, familyId: id, createdByAdminId: req.user.sub },
      include: { tenant: true, family: true }
    });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.entitlement.assign", targetType: "TemplateFamily", targetId: id, metadata: { tenantId: dto.tenantId } });
    return entitlement;
  }

  @Delete("template-families/:familyId/entitlements/:tenantId")
  @ApiOperation({ summary: "Remove template family tenant assignment" })
  @ApiParam({ name: "familyId", description: "TemplateFamily UUID." })
  @ApiParam({ name: "tenantId", description: "Tenant UUID." })
  @ApiOkResponse({ description: "Tenant entitlement removed.", schema: { example: { success: true } } })
  async removeTemplateEntitlement(@Param("familyId") familyId: string, @Param("tenantId") tenantId: string, @Req() req: any) {
    await this.assertTemplateFamilyAccess(req, familyId);
    await this.assertTenantAccess(req, tenantId);
    await this.prisma.tenantTemplateEntitlement.deleteMany({ where: { familyId, tenantId } });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.entitlement.remove", targetType: "TemplateFamily", targetId: familyId, metadata: { tenantId } });
    return { success: true };
  }

  @Post("template-drafts/ai-assist")
  @ApiOperation({ summary: "Generate AI-assisted draft proposal", description: "Creates a reviewable YAML draft proposal from a use-case description. The proposal is never auto-published." })
  @ApiBody({ type: TemplateAiAssistDto })
  @ApiOkResponse({ description: "Draft proposal generated." })
  aiAssistTemplateDraft(@Body() dto: TemplateAiAssistDto) {
    return this.templates.buildAssistedDraft(dto);
  }

  @Post("template-drafts/:id/preview")
  @ApiOperation({ summary: "Generate real AI preview for a draft", description: "Runs the centrally configured preview provider/model against the current draft and sample transcript. This is manual and never runs on every edit." })
  @ApiParam({ name: "id", description: "TemplateDraft UUID." })
  @ApiOkResponse({ description: "Generated preview metadata and markdown." })
  async generateTemplatePreview(@Param("id") id: string, @Req() req: any) {
    await this.assertTemplateDraftAccess(req, id);
    return this.templates.generatePreview(id, { id: req.user.sub, email: req.user.email });
  }

  @Get("template-drafts/:id/preview")
  @ApiOperation({ summary: "Get latest stored draft preview" })
  @ApiParam({ name: "id", description: "TemplateDraft UUID." })
  @ApiOkResponse({ description: "Latest preview metadata and markdown." })
  async getTemplatePreview(@Param("id") id: string, @Req() req: any) {
    const draft = await this.assertTemplateDraftAccess(req, id);
    return this.templates.mapPreview(draft);
  }

  @Get("templates")
  @ApiOperation({
    summary: "Legacy direct template list",
    description: "Deprecated compatibility endpoint for direct Template/TemplateVersion records. Use template-family and template-variant endpoints for the current designer/repository workflow.",
    deprecated: true
  })
  @ApiOkResponse({ description: "Template list." })
  templatesList(@Req() req: any) {
    const partnerId = this.scopedPartnerId(req);
    return this.prisma.template.findMany({
      where: partnerId ? { OR: [{ tenantId: null }, { tenant: { partnerId } }] } : {},
      orderBy: { updatedAt: "desc" },
      include: { category: true, tenant: true, versions: { orderBy: { createdAt: "desc" } } }
    });
  }

  @Get("template-categories")
  @ApiOperation({ summary: "List template categories" })
  @ApiOkResponse({ description: "Template categories." })
  categories() {
    return this.prisma.templateCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { title: "asc" }] });
  }

  @Post("template-categories")
  @ApiOperation({ summary: "Create template category", description: "Superadmin only. Categories are used by template families and YAML identity metadata." })
  @ApiBody({ type: TemplateCategoryDto })
  @ApiOkResponse({ description: "Template category created." })
  async createTemplateCategory(@Body() dto: TemplateCategoryDto, @Req() req: any) {
    this.requireSuperadmin(req);
    const category = await this.prisma.templateCategory.create({
      data: { slug: this.normalizeSlug(dto.slug), title: dto.title, icon: dto.icon || "folder", sortOrder: dto.sortOrder ?? 0, description: dto.description }
    });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.category.create", targetType: "TemplateCategory", targetId: category.id });
    return category;
  }

  @Patch("template-categories/:id")
  @ApiOperation({ summary: "Update template category", description: "Superadmin only." })
  @ApiParam({ name: "id", description: "TemplateCategory UUID." })
  @ApiBody({ type: TemplateCategoryDto })
  @ApiOkResponse({ description: "Template category updated." })
  async updateTemplateCategory(@Param("id") id: string, @Body() dto: Partial<TemplateCategoryDto>, @Req() req: any) {
    this.requireSuperadmin(req);
    const category = await this.prisma.templateCategory.update({
      where: { id },
      data: {
        slug: dto.slug ? this.normalizeSlug(dto.slug) : undefined,
        title: dto.title,
        icon: dto.icon,
        sortOrder: dto.sortOrder,
        description: dto.description
      }
    });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.category.update", targetType: "TemplateCategory", targetId: id });
    return category;
  }

  @Delete("template-categories/:id")
  @ApiOperation({ summary: "Delete template category", description: "Superadmin only. Categories in use by templates or families cannot be deleted." })
  @ApiParam({ name: "id", description: "TemplateCategory UUID." })
  @ApiOkResponse({ description: "Template category deleted.", schema: { example: { success: true } } })
  async deleteTemplateCategory(@Param("id") id: string, @Req() req: any) {
    this.requireSuperadmin(req);
    const [templates, families] = await Promise.all([
      this.prisma.template.count({ where: { categoryId: id } }),
      this.prisma.templateFamily.count({ where: { categoryId: id } })
    ]);
    if (templates || families) throw new ConflictException("Cannot delete a category while templates or template families use it.");
    await this.prisma.templateCategory.delete({ where: { id } });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.category.delete", targetType: "TemplateCategory", targetId: id });
    return { success: true };
  }

  @Get("template-section-presets")
  @ApiOperation({ summary: "List template section presets", description: "Reusable section building blocks shown in the admin template designer." })
  @ApiOkResponse({ description: "Template section presets." })
  templateSectionPresets() {
    return this.prisma.templateSectionPreset.findMany({ orderBy: [{ sortOrder: "asc" }, { title: "asc" }] });
  }

  @Post("template-section-presets")
  @ApiOperation({ summary: "Create template section preset", description: "Superadmin only." })
  @ApiBody({ type: TemplateSectionPresetDto })
  @ApiOkResponse({ description: "Template section preset created." })
  async createTemplateSectionPreset(@Body() dto: TemplateSectionPresetDto, @Req() req: any) {
    this.requireSuperadmin(req);
    const preset = await this.prisma.templateSectionPreset.create({ data: this.cleanTemplateSectionPresetCreate(dto) });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.section_preset.create", targetType: "TemplateSectionPreset", targetId: preset.id });
    return preset;
  }

  @Patch("template-section-presets/:id")
  @ApiOperation({ summary: "Update template section preset", description: "Superadmin only." })
  @ApiParam({ name: "id", description: "TemplateSectionPreset UUID." })
  @ApiBody({ type: TemplateSectionPresetDto })
  @ApiOkResponse({ description: "Template section preset updated." })
  async updateTemplateSectionPreset(@Param("id") id: string, @Body() dto: Partial<TemplateSectionPresetDto>, @Req() req: any) {
    this.requireSuperadmin(req);
    const preset = await this.prisma.templateSectionPreset.update({ where: { id }, data: this.cleanTemplateSectionPresetUpdate(dto) });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.section_preset.update", targetType: "TemplateSectionPreset", targetId: id });
    return preset;
  }

  @Delete("template-section-presets/:id")
  @ApiOperation({ summary: "Delete template section preset", description: "Superadmin only. Existing template YAML is not changed." })
  @ApiParam({ name: "id", description: "TemplateSectionPreset UUID." })
  @ApiOkResponse({ description: "Template section preset deleted.", schema: { example: { success: true } } })
  async deleteTemplateSectionPreset(@Param("id") id: string, @Req() req: any) {
    this.requireSuperadmin(req);
    await this.prisma.templateSectionPreset.delete({ where: { id } });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.section_preset.delete", targetType: "TemplateSectionPreset", targetId: id });
    return { success: true };
  }

  @Get("template-tags")
  @ApiOperation({ summary: "List template tag catalog", description: "Returns shared colored template tags from the managed catalog only." })
  @ApiOkResponse({ description: "Template tag catalog.", schema: { example: [{ id: "tag-uuid", slug: "dictation", name: "Dictation", color: "#0d9488", description: "Dictation templates." }] } })
  templateTags() {
    return this.prisma.templateTag.findMany({ orderBy: { name: "asc" } });
  }

  @Post("template-tags")
  @ApiOperation({ summary: "Create template tag", description: "Superadmin only. Creates a reusable colored tag in the shared template tag catalog." })
  @ApiBody({ type: TemplateTagDto })
  @ApiOkResponse({ description: "Template tag created." })
  async createTemplateTag(@Body() dto: TemplateTagDto, @Req() req: any) {
    this.requireSuperadmin(req);
    const slug = this.normalizeTagSlug(dto.name);
    await this.ensureTemplateTagSlugAvailable(slug);
    const tag = await this.prisma.templateTag.create({ data: this.cleanTemplateTag(dto, slug) });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.tag.create", targetType: "TemplateTag", targetId: tag.id });
    return tag;
  }

  @Patch("template-tags/:id")
  @ApiOperation({ summary: "Update template tag", description: "Superadmin only. Renaming a tag updates current template family and draft references." })
  @ApiParam({ name: "id", description: "TemplateTag UUID." })
  @ApiBody({ type: TemplateTagDto })
  @ApiOkResponse({ description: "Template tag updated." })
  async updateTemplateTag(@Param("id") id: string, @Body() dto: Partial<TemplateTagDto>, @Req() req: any) {
    this.requireSuperadmin(req);
    const current = await this.prisma.templateTag.findUnique({ where: { id } });
    if (!current) throw new NotFoundException("Template tag not found");
    const nextSlug = dto.name !== undefined ? this.normalizeTagSlug(dto.name) : current.slug;
    if (nextSlug !== current.slug) await this.ensureTemplateTagSlugAvailable(nextSlug, id);
    const tag = await this.prisma.templateTag.update({
      where: { id },
      data: this.cleanTemplateTag({
        name: dto.name ?? current.name,
        color: dto.color ?? current.color,
        description: dto.description === undefined ? current.description ?? undefined : dto.description
      }, nextSlug)
    });
    if (nextSlug !== current.slug) await this.replaceTemplateTagReferences(current.slug, nextSlug);
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.tag.update", targetType: "TemplateTag", targetId: id, metadata: { previousSlug: current.slug, slug: nextSlug } });
    return tag;
  }

  @Delete("template-tags/:id")
  @ApiOperation({ summary: "Delete template tag", description: "Superadmin only. Removes the tag from the shared catalog and current template family/draft references." })
  @ApiParam({ name: "id", description: "TemplateTag UUID." })
  @ApiOkResponse({ description: "Template tag deleted.", schema: { example: { success: true } } })
  async deleteTemplateTag(@Param("id") id: string, @Req() req: any) {
    this.requireSuperadmin(req);
    const tag = await this.prisma.templateTag.findUnique({ where: { id } });
    if (!tag) throw new NotFoundException("Template tag not found");
    await this.removeTemplateTagReferences(tag.slug);
    await this.prisma.templateTag.delete({ where: { id } });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.tag.delete", targetType: "TemplateTag", targetId: id, metadata: { slug: tag.slug } });
    return { success: true };
  }

  @Post("templates")
  @ApiOperation({
    summary: "Legacy create direct template draft/version",
    description: "Deprecated compatibility endpoint for the old direct Template/TemplateVersion model. Use POST /admin/template-families and POST /admin/template-families/{id}/variants for new templates.",
    deprecated: true
  })
  @ApiBody({ type: TemplateDto })
  @ApiOkResponse({ description: "Template created." })
  async createTemplate(@Body() dto: TemplateDto, @Req() req: any) {
    if (this.scopedPartnerId(req)) {
      if (!dto.tenantId) throw new ForbiddenException("Partner admins can only create tenant-specific templates.");
      await this.assertTenantAccess(req, dto.tenantId);
    }
    this.templates.validateYamlContent(dto.yamlContent);
    const template = await this.prisma.template.create({
      data: {
        title: dto.title,
        shortDescription: dto.shortDescription,
        categoryId: dto.categoryId || undefined,
        language: dto.language,
        icon: dto.icon,
        tags: this.normalizeTagList(dto.tags),
        tenantId: dto.tenantId || undefined,
        versions: { create: { version: dto.version, yamlContent: dto.yamlContent, createdByAdminId: req.user.sub } }
      },
      include: { versions: true }
    });
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.create", targetType: "Template", targetId: template.id });
    return template;
  }

  @Patch("templates/:id")
  @ApiOperation({
    summary: "Legacy update direct template metadata/version",
    description: "Deprecated compatibility endpoint for old direct templates. Use PATCH /admin/template-variants/{id}/draft for current repository drafts.",
    deprecated: true
  })
  @ApiParam({ name: "id", description: "Template UUID." })
  @ApiBody({ type: TemplateDto })
  @ApiOkResponse({ description: "Template updated." })
  async updateTemplate(@Param("id") id: string, @Body() dto: Partial<TemplateDto>, @Req() req: any) {
    await this.assertTemplateAccess(req, id);
    if (dto.tenantId) await this.assertTenantAccess(req, dto.tenantId);
    const template = await this.prisma.template.update({
      where: { id },
      data: {
        title: dto.title,
        shortDescription: dto.shortDescription,
        categoryId: dto.categoryId || undefined,
        language: dto.language,
        icon: dto.icon,
        tags: dto.tags === undefined ? undefined : this.normalizeTagList(dto.tags),
        tenantId: dto.tenantId || undefined
      }
    });
    if (dto.version && dto.yamlContent) {
      this.templates.validateYamlContent(dto.yamlContent);
      await this.prisma.templateVersion.create({ data: { templateId: id, version: dto.version, yamlContent: dto.yamlContent, createdByAdminId: req.user.sub } });
    }
    await this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.update", targetType: "Template", targetId: id });
    return template;
  }

  @Post("templates/:id/publish/:versionId")
  @ApiOperation({
    summary: "Legacy publish direct template version",
    description: "Deprecated compatibility endpoint for TemplateVersion publishing. Use POST /admin/template-variants/{id}/publish for current repository variants.",
    deprecated: true
  })
  @ApiParam({ name: "id", description: "Template UUID." })
  @ApiParam({ name: "versionId", description: "TemplateVersion UUID." })
  @ApiOkResponse({ description: "Template version published.", schema: { example: { success: true } } })
  async publish(@Param("id") id: string, @Param("versionId") versionId: string, @Req() req: any) {
    await this.assertTemplateAccess(req, id);
    return this.templates.publish(id, versionId, { id: req.user.sub, email: req.user.email });
  }

  @Patch("templates/:id/archive")
  @ApiOperation({
    summary: "Legacy archive direct template",
    description: "Deprecated compatibility endpoint for old direct templates. Use PATCH /admin/template-families/{id}/archive for current repository families.",
    deprecated: true
  })
  @ApiParam({ name: "id", description: "Template UUID." })
  @ApiOkResponse({ description: "Template archived." })
  async archive(@Param("id") id: string, @Req() req: any) {
    await this.assertTemplateAccess(req, id);
    this.audit.log({ actorAdminId: req.user.sub, actorEmail: req.user.email, action: "template.archive", targetType: "Template", targetId: id });
    return this.prisma.template.update({ where: { id }, data: { state: "archived" } });
  }

  @Get("activations")
  @ApiOperation({ summary: "List device activations" })
  @ApiOkResponse({ description: "Device activation list." })
  activations(@Req() req: any) {
    const partnerId = this.scopedPartnerId(req);
    return this.prisma.deviceActivation.findMany({
      where: partnerId ? { OR: [{ tenant: { partnerId } }, { singleLicenseKey: { partnerId } }] } : {},
      orderBy: { lastSeenAt: "desc" },
      include: { singleLicenseKey: true, enterpriseLicenseKey: { include: { tenant: true } } }
    });
  }

  @Delete("activations/:id")
  @ApiOperation({ summary: "Delete enterprise device activation", description: "Removes one enterprise device activation to free a licensed device slot. Single-user activations must be reset from the license key." })
  @ApiParam({ name: "id", description: "DeviceActivation UUID." })
  @ApiOkResponse({ description: "Enterprise device activation deleted.", schema: { example: { success: true } } })
  @ApiConflictResponse({ description: "Single-user activations cannot be deleted directly." })
  async deleteActivation(@Param("id") id: string, @Req() req: any) {
    const activation = await this.findScopedActivation(req, id);
    if (activation.kind !== "enterprise" || !activation.enterpriseLicenseKeyId) {
      throw new ConflictException("Only enterprise device activations can be deleted directly. Reset single-user licenses instead.");
    }
    await this.prisma.deviceActivation.delete({ where: { id } });
    await this.audit.log({
      actorAdminId: req.user.sub,
      actorEmail: req.user.email,
      action: "activation.enterprise.delete",
      targetType: "DeviceActivation",
      targetId: id,
      metadata: { enterpriseLicenseKeyId: activation.enterpriseLicenseKeyId, tenantId: activation.tenantId, deviceIdentifier: activation.deviceIdentifier }
    });
    return { success: true };
  }

  @Get("audit-logs")
  @ApiOperation({ summary: "List audit logs", description: "Returns latest activation/config/license/template audit entries." })
  @ApiOkResponse({ description: "Audit log list." })
  auditLogs(@Req() req: any) {
    const partnerId = this.scopedPartnerId(req);
    return this.prisma.activationAuditLog.findMany({ where: partnerId ? { actorAdminId: req.user.sub } : {}, orderBy: { createdAt: "desc" }, take: 200 });
  }

  private cleanConfig(dto: ConfigDto, existing?: { providerProfiles?: unknown }) {
    const data = encryptConfigProfileSecrets({
      name: dto.name,
      partnerId: this.emptyToNull(dto.partnerId),
      description: this.emptyToNull(dto.description as string | undefined),
      speechProviderType: this.emptyToNull(dto.speechProviderType),
      speechEndpointUrl: this.emptyToNull(dto.speechEndpointUrl),
      speechModelName: this.emptyToNull(dto.speechModelName),
      speechApiKey: this.emptySecretToNull(dto.speechApiKey),
      privacyControlEnabled: dto.privacyControlEnabled ?? null,
      piiControlEnabled: dto.piiControlEnabled ?? null,
      presidioEndpointUrl: this.emptyToNull(dto.presidioEndpointUrl),
      presidioSecretRef: this.emptyToNull(dto.presidioSecretRef),
      presidioApiKey: this.emptySecretToNull(dto.presidioApiKey),
      presidioScoreThreshold: dto.presidioScoreThreshold ?? null,
      presidioFullPersonNamesOnly: dto.presidioFullPersonNamesOnly ?? null,
      presidioDetectPerson: dto.presidioDetectPerson ?? null,
      presidioDetectEmail: dto.presidioDetectEmail ?? null,
      presidioDetectPhone: dto.presidioDetectPhone ?? null,
      presidioDetectLocation: dto.presidioDetectLocation ?? null,
      presidioDetectIdentifier: dto.presidioDetectIdentifier ?? null,
      privacyReviewProviderType: normalizeOpenAiCompatibleProvider(this.emptyToNull(dto.privacyReviewProviderType)),
      privacyReviewEndpointUrl: this.emptyToNull(dto.privacyReviewEndpointUrl),
      privacyReviewModel: this.emptyToNull(dto.privacyReviewModel),
      privacyReviewApiKey: this.emptySecretToNull(dto.privacyReviewApiKey),
      privacyPrompt: this.emptyToNull(dto.privacyPrompt),
      documentGenerationProviderType: normalizeOpenAiCompatibleProvider(this.emptyToNull(dto.documentGenerationProviderType)),
      documentGenerationEndpointUrl: this.emptyToNull(dto.documentGenerationEndpointUrl),
      documentGenerationModel: this.emptyToNull(dto.documentGenerationModel),
      documentGenerationApiKey: this.emptySecretToNull(dto.documentGenerationApiKey),
      templateRepositoryUrl: this.emptyToNull(dto.templateRepositoryUrl),
      telemetryEndpointUrl: this.emptyToNull(dto.telemetryEndpointUrl),
      featureFlags: dto.featureFlags ?? {},
      allowedProviderRestrictions: dto.allowedProviderRestrictions ?? [],
      providerProfiles: this.preserveMaskedProviderSecrets(dto.providerProfiles ?? {}, existing?.providerProfiles),
      managedPolicy: this.normalizeManagedPolicy(dto.managedPolicy, dto),
      defaultTemplateId: this.emptyToNull(dto.defaultTemplateId ?? undefined)
    });
    return data;
  }

  private emptyToNull(value?: string | null) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  private emptySecretToNull(value?: string | null) {
    if (value === ADMIN_SECRET_MASK) return undefined;
    return this.emptyToNull(value);
  }

  private normalizeManagedPolicy(policy?: Record<string, unknown>, profile?: Record<string, any> | null) {
    return {
      ...(policy ?? {}),
      managePrivacyControl: firstBoolean(policy?.managePrivacyControl, policy?.privacyControlManaged) ?? profileHasValue(profile, "privacyControlEnabled"),
      userMayChangePrivacyControl: firstBoolean(policy?.userMayChangePrivacyControl, policy?.allowPrivacyControlChange) ?? false,
      managePIIControl: firstBoolean(policy?.managePIIControl, policy?.piiControlManaged) ?? hasManagedPIIPolicyFields(profile),
      userMayChangePIIControl: firstBoolean(policy?.userMayChangePIIControl, policy?.allowPIIControlChange) ?? false,
      managePrivacyReviewProvider: firstBoolean(policy?.managePrivacyReviewProvider, policy?.privacyReviewProviderManaged, policy?.managePrivacyReview) ?? hasManagedPrivacyReviewPolicyFields(profile),
      userMayChangePrivacyReviewProvider: firstBoolean(policy?.userMayChangePrivacyReviewProvider, policy?.userMayChangePrivacyReview, policy?.allowPrivacyReviewProviderChange) ?? false,
      managePrivacyPrompt: firstBoolean(policy?.managePrivacyPrompt, policy?.privacyPromptManaged) ?? profileHasValue(profile, "privacyPrompt"),
      hideRecordingFloatingToolbar: firstBoolean(policy?.hideRecordingFloatingToolbar, policy?.hideRecordingToolbar, policy?.hideNewRecordingToolbar, policy?.hideFloatingRecordingToolbar) ?? false,
      manageTemplateCategories: firstBoolean(policy?.manageTemplateCategories, policy?.templateCategoriesManaged) ?? true
    };
  }

  private maskAdminConfigSecrets<T extends { speechApiKey?: string | null; documentGenerationApiKey?: string | null; privacyReviewApiKey?: string | null; presidioApiKey?: string | null; privacyPrompt?: string | null }>(profile: T) {
    return {
      ...profile,
      speechApiKey: profile.speechApiKey ? ADMIN_SECRET_MASK : null,
      presidioApiKey: profile.presidioApiKey ? ADMIN_SECRET_MASK : null,
      privacyReviewApiKey: profile.privacyReviewApiKey ? ADMIN_SECRET_MASK : null,
      documentGenerationApiKey: profile.documentGenerationApiKey ? ADMIN_SECRET_MASK : null,
      managedPolicy: this.normalizeManagedPolicy((profile as T & { managedPolicy?: Record<string, unknown> }).managedPolicy, profile as Record<string, any>),
      providerProfiles: this.maskNestedProviderSecrets((profile as T & { providerProfiles?: unknown }).providerProfiles)
    };
  }

  private preserveMaskedProviderSecrets(next: unknown, existing: unknown): unknown {
    if (next === ADMIN_SECRET_MASK) return existing;
    if (Array.isArray(next)) {
      const existingItems = Array.isArray(existing) ? existing : [];
      const existingById = new Map(existingItems.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).id === "string").map((item) => [item.id, item]));
      return next.map((item, index) => {
        const itemId = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>).id : undefined;
        return this.preserveMaskedProviderSecrets(item, typeof itemId === "string" ? existingById.get(itemId) : existingItems[index]);
      });
    }
    if (next && typeof next === "object") {
      const source = next as Record<string, unknown>;
      const existingRecord = existing && typeof existing === "object" && !Array.isArray(existing) ? existing as Record<string, unknown> : {};
      return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, key === "apiKey" && value === ADMIN_SECRET_MASK ? existingRecord[key] : this.preserveMaskedProviderSecrets(value, existingRecord[key])]));
    }
    return next;
  }

  private maskNestedProviderSecrets(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.maskNestedProviderSecrets(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, key === "apiKey" && typeof item === "string" && item ? ADMIN_SECRET_MASK : this.maskNestedProviderSecrets(item)]));
    }
    return value;
  }

  private safeTemplatePreviewProviderSetting(value: unknown) {
    const setting = this.templatePreviewProviderValue(value);
    return {
      providerType: setting.providerType,
      endpointUrl: setting.endpointUrl,
      model: setting.model,
      apiKeyConfigured: Boolean(setting.apiKey),
      apiKeyPreview: this.maskSecret(setting.apiKey)
    };
  }

  private previewProviderRequestMatchesSavedSetting(
    dto: TemplatePreviewProviderSettingDto,
    saved: ReturnType<AdminController["templatePreviewProviderValue"]>
  ) {
    const requestProviderType = this.emptyToNull(dto.providerType);
    const requestEndpointUrl = this.emptyToNull(dto.endpointUrl);

    if (requestProviderType === undefined && requestEndpointUrl === undefined) {
      return true;
    }

    const normalizedRequestProviderType = this.previewProviderLookupType(requestProviderType ?? saved.providerType);
    const normalizedSavedProviderType = this.previewProviderLookupType(saved.providerType);
    const normalizedRequestEndpoint = requestEndpointUrl ?? saved.endpointUrl ?? "";
    const normalizedSavedEndpoint = saved.endpointUrl ?? "";

    return normalizedRequestProviderType === normalizedSavedProviderType
      && normalizedRequestEndpoint === normalizedSavedEndpoint;
  }

  private previewProviderApiKeyScopeChanged(
    current: ReturnType<AdminController["templatePreviewProviderValue"]>,
    next: { providerType: string; endpointUrl: string | null }
  ) {
    const currentProviderType = this.previewProviderLookupType(current.providerType);
    const nextProviderType = this.previewProviderLookupType(next.providerType);
    if (currentProviderType !== nextProviderType) {
      return true;
    }

    const currentEndpointOrigin = this.urlOrigin(current.endpointUrl);
    const nextEndpointOrigin = this.urlOrigin(next.endpointUrl);
    return currentEndpointOrigin !== nextEndpointOrigin;
  }

  private urlOrigin(value?: string | null) {
    const trimmed = this.emptyToNull(value);
    if (!trimmed) return null;

    try {
      return new URL(trimmed).origin;
    } catch {
      return trimmed;
    }
  }

  private templatePreviewProviderValue(value: unknown) {
    const source = decryptPreviewProviderSetting(value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
    return {
      providerType: typeof source.providerType === "string" && source.providerType.trim() ? source.providerType.trim() : "openai-compatible",
      endpointUrl: typeof source.endpointUrl === "string" && source.endpointUrl.trim() ? source.endpointUrl.trim() : null,
      model: typeof source.model === "string" && source.model.trim() ? source.model.trim() : null,
      apiKey: typeof source.apiKey === "string" && source.apiKey.trim() ? source.apiKey.trim() : null
    };
  }

  private maskSecret(value?: string | null) {
    if (!value) return null;
    if (value.length <= 8) return "••••";
    return `${value.slice(0, 4)}••••${value.slice(-4)}`;
  }

  private previewProviderLookupType(value?: string | null) {
    const normalized = value?.trim().toLowerCase().replace(/-/g, "_");
    if (normalized === "openai") return "openai";
    return "openai_compatible";
  }

  private async resolveProviderModelLookup(dto: ProviderModelLookupDto): Promise<ProviderModelLookupDto> {
    const providedApiKey = this.emptySecretToNull(dto.apiKey);
    const shouldTrySavedSecret = dto.configProfileId && (dto.apiKey === undefined || dto.apiKey === ADMIN_SECRET_MASK);
    if (!shouldTrySavedSecret) {
      return { ...dto, apiKey: providedApiKey ?? undefined };
    }

    const profile = await this.prisma.configProfile.findUnique({
      where: { id: dto.configProfileId },
      select: {
        speechProviderType: true,
        speechEndpointUrl: true,
        speechApiKey: true,
        privacyReviewProviderType: true,
        privacyReviewEndpointUrl: true,
        privacyReviewApiKey: true,
        documentGenerationProviderType: true,
        documentGenerationEndpointUrl: true,
        documentGenerationApiKey: true,
        providerProfiles: true
      }
    });
    if (!profile) return { ...dto, apiKey: providedApiKey ?? undefined };

    const saved = this.savedProviderModelLookup(decryptConfigProfileSecrets(profile), dto);
    return {
      ...dto,
      endpointUrl: this.emptyToNull(dto.endpointUrl) ?? saved.endpointUrl ?? dto.endpointUrl,
      apiKey: providedApiKey ?? saved.apiKey ?? undefined
    };
  }

  private savedProviderModelLookup(profile: {
    speechProviderType?: string | null;
    speechEndpointUrl?: string | null;
    speechApiKey?: string | null;
    privacyReviewProviderType?: string | null;
    privacyReviewEndpointUrl?: string | null;
    privacyReviewApiKey?: string | null;
    documentGenerationProviderType?: string | null;
    documentGenerationEndpointUrl?: string | null;
    documentGenerationApiKey?: string | null;
    providerProfiles?: unknown;
  }, dto: ProviderModelLookupDto) {
    const providerProfiles = profile.providerProfiles && typeof profile.providerProfiles === "object" && !Array.isArray(profile.providerProfiles)
      ? profile.providerProfiles as Record<string, any>
      : {};

    if (dto.providerDomain === "speech") {
      const providers = providerProfiles.speech?.providers;
      const profileKey = dto.providerProfileId ?? dto.providerType;
      const nested = providers && typeof providers === "object" && !Array.isArray(providers) ? providers[profileKey] : null;
      return {
        endpointUrl: this.stringValue(nested?.endpointUrl) ?? (profile.speechProviderType === dto.providerType ? profile.speechEndpointUrl : null),
        apiKey: this.stringValue(nested?.apiKey) ?? (profile.speechProviderType === dto.providerType ? profile.speechApiKey : null)
      };
    }

    if (dto.providerDomain === "document_generation") {
      const providers = Array.isArray(providerProfiles.formatter?.providers) ? providerProfiles.formatter.providers : [];
      const selectedProviderId = this.stringValue(providerProfiles.formatter?.selectedProviderId);
      const nested = providers.find((provider: any) => {
        if (!provider || typeof provider !== "object") return false;
        return provider.id === dto.providerProfileId || (!dto.providerProfileId && provider.id === selectedProviderId) || (!dto.providerProfileId && provider.type === dto.providerType);
      });
      return {
        endpointUrl: this.stringValue(nested?.endpointUrl) ?? profile.documentGenerationEndpointUrl,
        apiKey: this.stringValue(nested?.apiKey) ?? profile.documentGenerationApiKey
      };
    }

    if (dto.providerDomain === "privacy_review") {
      return {
        endpointUrl: profile.privacyReviewProviderType === dto.providerType ? profile.privacyReviewEndpointUrl : null,
        apiKey: profile.privacyReviewProviderType === dto.providerType ? profile.privacyReviewApiKey : null
      };
    }

    return { endpointUrl: null, apiKey: null };
  }

  private stringValue(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private async lookupProviderModels(dto: ProviderModelLookupDto) {
    const provider = dto.providerType;
    if (!provider || ["", "local", "apple_online", "apple_intelligence", "local_heuristic"].includes(provider)) {
      throw new BadRequestException("This provider does not expose a remote model list.");
    }
    if (provider === "azure" && dto.providerDomain === "speech") {
      throw new BadRequestException("Azure Speech container policies do not use model names in the current app.");
    }

    if (provider === "ollama") return this.lookupOllamaModels(dto.endpointUrl);
    if (["openai", "gemini", "claude"].includes(provider) && !this.emptyToNull(dto.apiKey)) {
      throw new BadRequestException("API key is required for this provider model lookup.");
    }
    if (provider === "gemini") return this.lookupGeminiModels(dto.endpointUrl, dto.apiKey);
    if (provider === "claude") return this.lookupClaudeModels(dto.endpointUrl, dto.apiKey);
    if (["openai", "openai_compatible", "vllm"].includes(provider)) return this.lookupOpenAiCompatibleModels(dto);

    throw new BadRequestException(`Model lookup is not supported for provider "${provider}".`);
  }

  private async lookupOpenAiCompatibleModels(dto: ProviderModelLookupDto) {
    const fallbackBase = dto.providerType === "openai"
      ? "https://api.openai.com/v1"
      : dto.providerType === "vllm"
        ? "http://localhost:8000/v1"
        : undefined;
    const endpoint = this.openAiCompatibleModelsUrl(dto.endpointUrl, fallbackBase);
    const response = await this.fetchJson(endpoint, this.providerHeaders(dto.apiKey));
    const data = Array.isArray(response?.data) ? response.data : [];
    let models = data.map((item: any) => item?.id ?? item?.name).filter(Boolean);
    if (dto.providerDomain === "speech" && dto.providerType === "openai") {
      const speechModels = models.filter((model: string) => /transcribe|whisper|speech/i.test(model));
      if (speechModels.length) models = speechModels;
    }
    return this.modelOptions(models);
  }

  private async lookupOllamaModels(endpointUrl?: string) {
    const endpoint = this.ollamaTagsUrl(endpointUrl);
    const response = await this.fetchJson(endpoint, this.providerHeaders(undefined));
    const models = Array.isArray(response?.models) ? response.models.map((item: any) => item?.name ?? item?.model).filter(Boolean) : [];
    return this.modelOptions(models);
  }

  private async lookupGeminiModels(endpointUrl?: string, apiKey?: string) {
    const endpoint = this.geminiModelsUrl(endpointUrl, apiKey);
    const response = await this.fetchJson(endpoint, this.providerHeaders(apiKey));
    const models = Array.isArray(response?.models)
      ? response.models.map((item: any) => String(item?.name ?? "").replace(/^models\//, "")).filter(Boolean)
      : [];
    return this.modelOptions(models);
  }

  private async lookupClaudeModels(endpointUrl?: string, apiKey?: string) {
    const endpoint = this.modelsUrl(endpointUrl, "https://api.anthropic.com/v1");
    const response = await this.fetchJson(endpoint, {
      ...this.providerHeaders(undefined),
      ...(apiKey?.trim() ? { "x-api-key": apiKey.trim() } : {}),
      "anthropic-version": "2023-06-01"
    });
    const data = Array.isArray(response?.data) ? response.data : [];
    return this.modelOptions(data.map((item: any) => item?.id ?? item?.display_name).filter(Boolean));
  }

  private async fetchJson(url: string, headers: Record<string, string>) {
    let response: Response;
    try {
      response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(10000) });
    } catch (error: any) {
      throw new BadRequestException(`Could not reach provider model endpoint: ${error?.message ?? "request failed"}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const readableDetail = this.readableProviderError(detail);
      throw new BadRequestException(`Provider model endpoint returned ${response.status}${readableDetail ? `: ${readableDetail}` : ""}. Check the provider endpoint URL and APISIX/upstream health.`);
    }
    return response.json();
  }

  private providerHeaders(apiKey?: string) {
    const headers: Record<string, string> = { "Accept": "application/json" };
    const key = this.emptySecretToNull(apiKey) ?? undefined;
    if (key) {
      headers.Authorization = `Bearer ${key}`;
      headers["X-API-Key"] = key;
    }
    return headers;
  }

  private modelsUrl(endpointUrl?: string, fallbackBase?: string) {
    const base = this.providerBaseUrl(endpointUrl, fallbackBase);
    const path = base.pathname.replace(/\/+$/, "");
    if (path.endsWith("/models")) return base.toString();
    base.pathname = `${path}/models`.replace(/\/{2,}/g, "/");
    base.search = "";
    return base.toString();
  }

  private openAiCompatibleModelsUrl(endpointUrl?: string, fallbackBase?: string) {
    const explicit = this.emptyToNull(endpointUrl);
    if (explicit) {
      try {
        const explicitUrl = new URL(explicit);
        const explicitPath = explicitUrl.pathname.replace(/\/+$/, "");
        if (explicitPath.endsWith("/models")) {
          explicitUrl.search = "";
          return explicitUrl.toString();
        }
      } catch {
        // Let providerBaseUrl below raise the standard validation error.
      }
    }
    const base = this.providerBaseUrl(endpointUrl, fallbackBase);
    const path = base.pathname.replace(/\/+$/, "");
    if (path.endsWith("/models")) return base.toString();
    if (path.endsWith("/v1")) {
      base.pathname = `${path}/models`;
    } else {
      base.pathname = `${path}/v1/models`;
    }
    base.pathname = base.pathname.replace(/\/{2,}/g, "/");
    base.search = "";
    return base.toString();
  }

  private ollamaTagsUrl(endpointUrl?: string) {
    const base = this.providerBaseUrl(endpointUrl, "http://localhost:11434");
    const path = base.pathname.replace(/\/+$/, "");
    if (!path.endsWith("/api/tags")) {
      base.pathname = `${path}/api/tags`.replace(/\/{2,}/g, "/");
    }
    base.search = "";
    return base.toString();
  }

  private geminiModelsUrl(endpointUrl?: string, apiKey?: string) {
    const base = this.providerBaseUrl(endpointUrl, "https://generativelanguage.googleapis.com");
    const path = base.pathname.replace(/\/+$/, "");
    if (path.endsWith("/models")) {
      base.pathname = path;
    } else if (path.endsWith("/v1beta") || path.endsWith("/v1")) {
      base.pathname = `${path}/models`;
    } else {
      base.pathname = `${path}/v1beta/models`.replace(/\/{2,}/g, "/");
    }
    base.search = "";
    if (apiKey?.trim()) base.searchParams.set("key", apiKey.trim());
    return base.toString();
  }

  private providerBaseUrl(endpointUrl?: string, fallbackBase?: string) {
    const raw = this.emptyToNull(endpointUrl) ?? fallbackBase;
    if (!raw) throw new BadRequestException("Endpoint URL is required to list models for this provider.");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException("Endpoint URL is not valid.");
    }
    if (!["http:", "https:"].includes(url.protocol)) throw new BadRequestException("Endpoint URL must use http or https.");
    const normalizedPath = url.pathname
      .replace(/\/chat\/completions\/?$/i, "")
      .replace(/\/responses\/?$/i, "")
      .replace(/\/audio\/transcriptions\/?$/i, "")
      .replace(/\/models\/?$/i, "");
    url.pathname = normalizedPath || "/";
    url.search = "";
    return url;
  }

  private modelOptions(models: string[]) {
    return [...new Set(models.map((model) => model.trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b))
      .map((model) => ({ id: model, name: model }));
  }

  private readableProviderError(body: string) {
    return body
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
  }

  private cleanPartner(dto: Partial<PartnerDto>) {
    return {
      name: dto.name,
      email: dto.email,
      notes: dto.notes
    };
  }

  private normalizeSlug(value: string) {
    const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) throw new ConflictException("Slug must contain at least one letter or number.");
    return slug;
  }

  private cleanTemplateSectionPresetCreate(dto: TemplateSectionPresetDto) {
    return {
      slug: this.normalizeSlug(dto.slug),
      title: dto.title,
      purpose: dto.purpose,
      format: dto.format ?? "prose",
      required: dto.required ?? false,
      extractionHints: dto.extractionHints ?? [],
      sortOrder: dto.sortOrder ?? 0
    };
  }

  private cleanTemplateSectionPresetUpdate(dto: Partial<TemplateSectionPresetDto>) {
    const data: Record<string, unknown> = {};
    if (dto.slug !== undefined) data.slug = this.normalizeSlug(dto.slug);
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.purpose !== undefined) data.purpose = dto.purpose;
    if (dto.format !== undefined) data.format = dto.format;
    if (dto.required !== undefined) data.required = dto.required;
    if (dto.extractionHints !== undefined) data.extractionHints = dto.extractionHints;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    return data;
  }

  private cleanTemplateTag(dto: TemplateTagDto, slug: string) {
    return {
      slug,
      name: dto.name.trim(),
      color: this.normalizeTagColor(dto.color),
      description: this.emptyToNull(dto.description)
    };
  }

  private normalizeTagSlug(value: string) {
    return this.normalizeSlug(value);
  }

  private normalizeTagColor(value?: string | null) {
    const color = value?.trim();
    if (!color) return "#64748b";
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new BadRequestException("Tag color must be a hex color such as #0d9488.");
    return color.toLowerCase();
  }

  private async ensureTemplateTagSlugAvailable(slug: string, currentId?: string) {
    const existing = await this.prisma.templateTag.findUnique({ where: { slug } });
    if (existing && existing.id !== currentId) throw new ConflictException("A tag with this name already exists.");
  }

  private normalizeTagList(tags: unknown, replace?: { from: string; to: string | null }) {
    if (!Array.isArray(tags)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of tags) {
      if (typeof item !== "string" || !item.trim()) continue;
      let tag = this.normalizeTagSlug(item);
      if (replace && tag === replace.from) {
        if (!replace.to) continue;
        tag = replace.to;
      }
      if (seen.has(tag)) continue;
      seen.add(tag);
      result.push(tag);
    }
    return result;
  }

  private async replaceTemplateTagReferences(fromSlug: string, toSlug: string) {
    await this.updateTemplateTagReferences({ from: fromSlug, to: toSlug });
  }

  private async removeTemplateTagReferences(slug: string) {
    await this.updateTemplateTagReferences({ from: slug, to: null });
  }

  private async updateTemplateTagReferences(replace: { from: string; to: string | null }) {
    const [families, templates, drafts] = await Promise.all([
      this.prisma.templateFamily.findMany({ select: { id: true, tags: true } }),
      this.prisma.template.findMany({ select: { id: true, tags: true } }),
      this.prisma.templateDraft.findMany({ select: { id: true, yamlContent: true } })
    ]);

    for (const family of families) {
      const tags = this.normalizeTagList(family.tags, replace);
      await this.prisma.templateFamily.update({ where: { id: family.id }, data: { tags } });
    }
    for (const template of templates) {
      const tags = this.normalizeTagList(template.tags, replace);
      await this.prisma.template.update({ where: { id: template.id }, data: { tags } });
    }
    for (const draft of drafts) {
      const yamlContent = this.rewriteTemplateDraftTags(draft.yamlContent, replace);
      if (yamlContent !== draft.yamlContent) {
        await this.prisma.templateDraft.update({ where: { id: draft.id }, data: { yamlContent, previewError: null } });
      }
    }
  }

  private rewriteTemplateDraftTags(yamlContent: string, replace: { from: string; to: string | null }) {
    let parsed: any;
    try {
      parsed = yaml.load(yamlContent);
    } catch {
      return yamlContent;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return yamlContent;
    const current = parsed.identity?.tags;
    if (!Array.isArray(current)) return yamlContent;
    const nextTags = this.normalizeTagList(current, replace);
    const currentKey = JSON.stringify(this.normalizeTagList(current));
    const nextKey = JSON.stringify(nextTags);
    if (currentKey === nextKey) return yamlContent;
    parsed.identity = { ...(parsed.identity ?? {}), tags: nextTags };
    return yaml.dump(parsed, { lineWidth: 100, noRefs: true, sortKeys: false });
  }

  private async cleanAdminUser(dto: AdminUserCreateDto | AdminUserUpdateDto, creating: boolean) {
    if (dto.role === "partner_admin" && !dto.partnerId) {
      throw new ConflictException("Partner admins must be assigned to a solution partner.");
    }
    const data: Record<string, unknown> = {};
    if (dto.email !== undefined) data.email = dto.email.toLowerCase();
    if (dto.fullName !== undefined) data.fullName = dto.fullName;
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.partnerId !== undefined) data.partnerId = dto.partnerId || null;
    if ("password" in dto && dto.password) data.passwordHash = await bcrypt.hash(dto.password, 12);
    if (creating && !data.passwordHash) throw new ConflictException("Password is required.");
    return data as any;
  }

  private withoutPassword(user: any) {
    const { passwordHash: _passwordHash, ...safeUser } = user;
    return safeUser;
  }

  private cleanTenant(dto: Partial<TenantDto>) {
    return {
      name: dto.name,
      slug: dto.slug,
      legalName: dto.legalName,
      organizationNumber: dto.organizationNumber,
      contactName: dto.contactName,
      contactEmail: dto.contactEmail,
      contactPhone: dto.contactPhone,
      billingEmail: dto.billingEmail,
      addressLine1: dto.addressLine1,
      addressLine2: dto.addressLine2,
      postalCode: dto.postalCode,
      city: dto.city,
      country: dto.country ?? undefined,
      status: dto.status ?? undefined,
      notes: dto.notes,
      partnerId: dto.partnerId,
      configProfileId: dto.configProfileId
    };
  }

  private requireSuperadmin(req: any) {
    if (req.user?.role !== "superadmin") throw new ForbiddenException("Only superadmins can manage admin portal users and solution partners.");
  }

  private scopedPartnerId(req: any) {
    if (req.user?.role !== "partner_admin") return null;
    if (!req.user.partnerId) throw new ForbiddenException("Partner admin has no partner assignment.");
    return req.user.partnerId as string;
  }

  private async ensureAnotherSuperadmin(userId: string) {
    const user = await this.prisma.adminUser.findUnique({ where: { id: userId } });
    if (user?.role !== "superadmin") return;
    const otherSuperadmins = await this.prisma.adminUser.count({ where: { role: "superadmin", NOT: { id: userId } } });
    if (!otherSuperadmins) throw new ConflictException("At least one superadmin must remain.");
  }

  private async assertTenantAccess(req: any, tenantId: string) {
    const partnerId = this.scopedPartnerId(req);
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId, ...(partnerId ? { partnerId } : {}) } });
    if (!tenant) throw new ForbiddenException("Tenant is not available to this admin user.");
    return tenant;
  }

  private async assertConfigAccess(req: any, configProfileId: string) {
    const partnerId = this.scopedPartnerId(req);
    const profile = await this.prisma.configProfile.findFirst({ where: { id: configProfileId, ...(partnerId ? { partnerId } : {}) } });
    if (!profile) throw new ForbiddenException("Config profile is not available to this admin user.");
    return profile;
  }

  private async assertSingleKeyAccess(req: any, keyId: string) {
    const partnerId = this.scopedPartnerId(req);
    const key = await this.prisma.singleLicenseKey.findFirst({ where: { id: keyId, ...(partnerId ? { partnerId } : {}) } });
    if (!key) throw new ForbiddenException("License key is not available to this admin user.");
    return key;
  }

  private async assertEnterpriseKeyAccess(req: any, keyId: string) {
    const partnerId = this.scopedPartnerId(req);
    const key = await this.prisma.enterpriseLicenseKey.findFirst({
      where: { id: keyId, ...(partnerId ? { OR: [{ partnerId }, { tenant: { partnerId } }] } : {}) }
    });
    if (!key) throw new ForbiddenException("License key is not available to this admin user.");
    return key;
  }

  private templateFamilyInclude() {
    return {
      category: true,
      entitlements: { include: { tenant: true }, orderBy: { createdAt: "desc" as const } },
      variants: {
        orderBy: { language: "asc" as const },
        include: {
          draft: true,
          publishedVersions: { orderBy: [{ publishedAt: "desc" as const }, { createdAt: "desc" as const }] }
        }
      }
    };
  }

  private async assertTemplateFamilyAccess(req: any, familyId: string) {
    const partnerId = this.scopedPartnerId(req);
    const family = await this.prisma.templateFamily.findFirst({
      where: {
        id: familyId,
        ...(partnerId ? { entitlements: { some: { tenant: { partnerId } } } } : {})
      }
    });
    if (!family) throw new ForbiddenException("Template family is not available to this admin user.");
    return family;
  }

  private async assertTemplateVariantAccess(req: any, variantId: string) {
    const partnerId = this.scopedPartnerId(req);
    const variant = await this.prisma.templateVariant.findFirst({
      where: {
        id: variantId,
        ...(partnerId ? { family: { entitlements: { some: { tenant: { partnerId } } } } } : {})
      }
    });
    if (!variant) throw new ForbiddenException("Template variant is not available to this admin user.");
    return variant;
  }

  private async assertTemplateDraftAccess(req: any, draftId: string) {
    const partnerId = this.scopedPartnerId(req);
    const draft = await this.prisma.templateDraft.findFirst({
      where: {
        id: draftId,
        ...(partnerId ? { variant: { family: { entitlements: { some: { tenant: { partnerId } } } } } } : {})
      }
    });
    if (!draft) throw new ForbiddenException("Template draft is not available to this admin user.");
    return draft;
  }

  private async assertTemplateAccess(req: any, templateId: string) {
    const partnerId = this.scopedPartnerId(req);
    if (!partnerId) return;
    const template = await this.prisma.template.findFirst({ where: { id: templateId, tenant: { partnerId } } });
    if (!template) throw new ForbiddenException("Template is not available to this admin user.");
  }

  private async findScopedActivation(req: any, activationId: string) {
    const partnerId = this.scopedPartnerId(req);
    const activation = await this.prisma.deviceActivation.findFirst({
      where: {
        id: activationId,
        ...(partnerId ? { OR: [{ tenant: { partnerId } }, { enterpriseLicenseKey: { tenant: { partnerId } } }] } : {})
      }
    });
    if (!activation) throw new ForbiddenException("Device activation is not available to this admin user.");
    return activation;
  }

  private tenantLicenseUsage(tenant: { activations: Array<{ status: string; deviceIdentifier: string }>; enterpriseKeys: Array<{ maxDevices: number | null; status: string }> }) {
    const activeDevices = new Set(tenant.activations.filter((activation) => activation.status === "active").map((activation) => activation.deviceIdentifier));
    const totalDevices = new Set(tenant.activations.map((activation) => activation.deviceIdentifier));
    const activeKeys = tenant.enterpriseKeys.filter((key) => key.status === "active");
    const unlimited = activeKeys.some((key) => key.maxDevices == null);
    const licensedDevices = unlimited ? null : activeKeys.reduce((sum, key) => sum + (key.maxDevices ?? 0), 0);
    return {
      activeDevices: activeDevices.size,
      totalDevices: totalDevices.size,
      enterpriseKeys: tenant.enterpriseKeys.length,
      activeEnterpriseKeys: activeKeys.length,
      licensedDevices,
      unlimited,
      availableDevices: licensedDevices == null ? null : Math.max(licensedDevices - activeDevices.size, 0)
    };
  }
}

function normalizeOpenAiCompatibleProvider(providerType?: string | null) {
  if (providerType === "openai" || providerType === "vllm") return "openai_compatible";
  return providerType;
}

function firstBoolean(...values: unknown[]) {
  return values.find((value): value is boolean => typeof value === "boolean");
}

function profileHasValue(profile: Record<string, any> | null | undefined, key: string) {
  const value = profile?.[key];
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function hasManagedPIIPolicyFields(profile: Record<string, any> | null | undefined) {
  return [
    "piiControlEnabled",
    "presidioEndpointUrl",
    "presidioSecretRef",
    "presidioApiKey",
    "presidioScoreThreshold",
    "presidioFullPersonNamesOnly",
    "presidioDetectPerson",
    "presidioDetectEmail",
    "presidioDetectPhone",
    "presidioDetectLocation",
    "presidioDetectIdentifier"
  ].some((key) => profileHasValue(profile, key));
}

function hasManagedPrivacyReviewPolicyFields(profile: Record<string, any> | null | undefined) {
  return [
    "privacyReviewProviderType",
    "privacyReviewEndpointUrl",
    "privacyReviewModel",
    "privacyReviewApiKey"
  ].some((key) => profileHasValue(profile, key));
}
