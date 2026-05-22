import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import * as yaml from "js-yaml";
import { randomUUID } from "crypto";
import { JwtService } from "@nestjs/jwt";
import { TemplateYamlSchema } from "@skrivdet/contracts";
import type { TemplateYaml } from "@skrivdet/contracts";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { mobileError } from "../activation/activation.service";
import { tokenHash } from "../common/crypto";
import { appEnvironment } from "../config/environment";
import { verifyActivationToken } from "../activation/activation-token";

const TEMPLATE_PREVIEW_PROVIDER_SETTING_KEY = "templatePreviewProvider";

export const AppTemplateYamlSchema = TemplateYamlSchema;
type AppTemplateYaml = TemplateYaml;
type PublishBump = "patch" | "minor" | "major";
type TemplateSectionInput = AppTemplateYaml["structure"]["sections"][number];
type AssistedDraftProfile = {
  category: string;
  icon: string;
  shortDescription: string;
  tags: string[];
  context: AppTemplateYaml["context"];
  perspective: AppTemplateYaml["perspective"];
  sections: TemplateSectionInput[];
  contentRules: AppTemplateYaml["content_rules"];
  llmPrompting: AppTemplateYaml["llm_prompting"];
  sampleTranscript: string;
};

@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly jwt: JwtService) {}

  async manifest(tenantId?: string) {
    const templates = await this.prisma.template.findMany({
      where: {
        state: "published",
        OR: [{ tenantId: null }, ...(tenantId ? [{ tenantId }] : [])]
      },
      include: { category: true, versions: true },
      orderBy: [{ updatedAt: "desc" }]
    });

    return {
      name: tenantId ? "Enterprise Templates" : "skrivDET Templates",
      templates: templates
        .map((template) => {
          const version = template.versions.find((item) => item.id === template.publishedVersionId) ?? template.versions.find((item) => item.state === "published");
          if (!version) return null;
          const metadata = this.metadataFromYaml(version.yamlContent);
          return {
            id: metadata.id,
            title: metadata.title,
            short_description: metadata.shortDescription,
            category: metadata.category,
            language: metadata.language,
            version: metadata.version,
            icon: metadata.icon,
            tags: metadata.tags,
            download_url: `/api/v1/templates/${metadata.id}/download`,
            updated_at: template.updatedAt.toISOString()
          };
        })
        .filter(Boolean)
    };
  }

  async manifestForEnterpriseActivation(activationToken: string) {
    const activation = await this.assertEnterpriseTemplateActivation(activationToken);
    const variants = await this.entitledPublishedVariants(activation.tenantId);
    return this.manifestFromVariants(variants, "Enterprise Templates");
  }

  async manifestForScopedBearer(bearer: string) {
    if (this.isInternalRepositoryBearer(bearer)) {
      return this.manifestForInternalApiKey(bearer);
    }
    return this.manifestForEnterpriseActivation(bearer);
  }

  async manifestForInternalApiKey(apiKey: string) {
    this.assertRepositoryApiKey(apiKey);
    const variants = await this.prisma.templateVariant.findMany({
      where: { family: { state: { not: "archived" } }, publishedVersions: { some: {} } },
      include: this.variantManifestInclude(),
      orderBy: [{ family: { title: "asc" } }, { language: "asc" }]
    });
    return this.manifestFromVariants(variants, "skrivDET Templates");
  }

  async downloadYaml(id: string) {
    const template = await this.prisma.template.findUnique({ where: { id }, include: { versions: true } });
    if (template?.state === "published") {
      const version = template.versions.find((item) => item.id === template.publishedVersionId) ?? template.versions.find((item) => item.state === "published");
      if (!version) throw new NotFoundException("Published template version not found");
      return this.toAppCompatibleYaml(version.yamlContent);
    }

    const variant = await this.prisma.templateVariant.findFirst({
      where: { OR: [{ id }, { templateIdentityId: id }], family: { state: { not: "archived" } } },
      include: { publishedVersions: { orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }] } }
    });
    const latest = variant?.publishedVersions[0];
    if (!latest) throw new NotFoundException("Template not found");
    return this.toAppCompatibleYaml(latest.yamlContent);
  }

  async downloadYamlForEnterpriseActivation(id: string, activationToken: string) {
    const activation = await this.assertEnterpriseTemplateActivation(activationToken);
    const variant = await this.prisma.templateVariant.findFirst({
      where: {
        OR: [{ id }, { templateIdentityId: id }],
        family: {
          state: { not: "archived" },
          OR: [{ isGlobal: true }, { entitlements: { some: { tenantId: activation.tenantId } } }]
        }
      },
      include: { publishedVersions: { orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }] } }
    });
    const latest = variant?.publishedVersions[0];
    if (!latest) throw new NotFoundException(mobileError("template_not_found", "Template not found or not assigned to this tenant"));
    return this.toAppCompatibleYaml(latest.yamlContent);
  }

  async downloadYamlForInternalApiKey(id: string, apiKey: string) {
    this.assertRepositoryApiKey(apiKey);
    return this.downloadYaml(id);
  }

  async downloadYamlForScopedBearer(id: string, bearer: string) {
    if (this.isInternalRepositoryBearer(bearer)) {
      return this.downloadYamlForInternalApiKey(id, bearer);
    }
    return this.downloadYamlForEnterpriseActivation(id, bearer);
  }

  validateYamlContent(yamlContent: string) {
    let parsed: unknown;
    try {
      parsed = yaml.load(yamlContent);
    } catch (error) {
      throw new BadRequestException(`Invalid YAML: ${(error as Error).message}`);
    }
    const result = AppTemplateYamlSchema.safeParse(parsed);
    if (!result.success) throw new BadRequestException({ message: "Template schema validation failed", issues: result.error.issues });
    return result.data;
  }

  metadataFromYaml(yamlContent: string) {
    const template = this.validateYamlContent(yamlContent);
    return {
      id: template.identity.id,
      title: template.identity.title,
      shortDescription: template.identity.short_description ?? template.identity.title,
      category: template.identity.category,
      language: template.identity.language,
      version: template.identity.version,
      icon: template.identity.icon ?? "doc.text",
      tags: template.identity.tags ?? []
    };
  }

  yamlWithVersion(yamlContent: string, version: string) {
    const parsed = this.validateYamlContent(yamlContent) as AppTemplateYaml;
    parsed.identity.version = version;
    return renderAppCompatibleYaml(parsed);
  }

  toAppCompatibleYaml(yamlContent: string) {
    return renderAppCompatibleYaml(this.validateYamlContent(yamlContent));
  }

  buildAssistedDraft(input: { useCase: string; language?: string; category?: string; title?: string; icon?: string }) {
    const language = normalizeTemplateLanguage(input.language);
    const profile = assistedDraftProfile(input.useCase, language);
    const title = limitTemplateTitle(input.title?.trim() || this.titleFromUseCase(input.useCase));
    const category = input.category?.trim() || profile.category;
    const icon = input.icon?.trim() || profile.icon;
    const tags = uniqueStrings(["ai-assist", TemplateSlug(category), ...profile.tags]);
    const yamlContent = this.createYaml({
      id: randomUUID(),
      title,
      shortDescription: profile.shortDescription,
      category,
      language,
      icon,
      tags,
      context: {
        ...profile.context,
        purpose: profile.context.purpose || `Create a clear, structured document for: ${input.useCase}`
      },
      perspective: profile.perspective,
      sections: profile.sections,
      contentRules: profile.contentRules,
      llmPrompting: profile.llmPrompting
    });
    return { yamlContent, sampleTranscript: profile.sampleTranscript, metadata: this.metadataFromYaml(yamlContent) };
  }

  async publishVariantDraft(variantId: string, input: { bump?: PublishBump; version?: string }, actor?: { id?: string; email?: string }) {
    const variant = await this.prisma.templateVariant.findUnique({
      where: { id: variantId },
      include: {
        family: true,
        draft: true,
        publishedVersions: { orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }] }
      }
    });
    if (!variant?.draft) throw new NotFoundException("Template draft not found");

    const current = this.validateYamlContent(variant.draft.yamlContent);
    const version = input.version?.trim() || (variant.publishedVersions[0] ? this.bumpVersion(variant.publishedVersions[0].version, input.bump ?? "patch") : current.identity.version);
    if (!isSemver(version)) throw new BadRequestException("Publish version must use semver x.y.z.");
    const yamlContent = this.yamlWithVersion(variant.draft.yamlContent, version);
    const metadata = this.metadataFromYaml(yamlContent);

    const existing = await this.prisma.publishedTemplateVersion.findUnique({ where: { variantId_version: { variantId, version } } });
    if (existing) throw new ConflictException(`Version ${version} is already published for this variant.`);

    const published = await this.prisma.$transaction(async (tx) => {
      await tx.templateVariant.update({
        where: { id: variantId },
        data: { language: metadata.language, templateIdentityId: metadata.id }
      });
      await tx.templateDraft.update({ where: { id: variant.draft!.id }, data: { yamlContent, previewError: null } });
      await tx.templateFamily.update({
        where: { id: variant.familyId },
        data: {
          title: metadata.title,
          shortDescription: metadata.shortDescription,
          icon: metadata.icon,
          tags: metadata.tags,
          state: "published"
        }
      });
      return tx.publishedTemplateVersion.create({
        data: { variantId, version, yamlContent, createdByAdminId: actor?.id }
      });
    });

    await this.audit.log({ actorAdminId: actor?.id, actorEmail: actor?.email, action: "template.variant.publish", targetType: "TemplateVariant", targetId: variantId, metadata: { version } });
    return { success: true, version, published };
  }

  async publish(templateId: string, versionId: string, actor?: { id?: string; email?: string }) {
    const version = await this.prisma.templateVersion.findFirst({ where: { id: versionId, templateId } });
    if (!version) throw new NotFoundException("Template version not found");
    this.validateYamlContent(version.yamlContent);

    await this.prisma.$transaction([
      this.prisma.templateVersion.updateMany({ where: { templateId }, data: { state: "draft", publishedAt: null } }),
      this.prisma.templateVersion.update({ where: { id: versionId }, data: { state: "published", publishedAt: new Date() } }),
      this.prisma.template.update({ where: { id: templateId }, data: { state: "published", publishedVersionId: versionId } })
    ]);
    await this.audit.log({ actorAdminId: actor?.id, actorEmail: actor?.email, action: "template.publish", targetType: "Template", targetId: templateId, metadata: { versionId } });
    return { success: true };
  }

  async generatePreview(draftId: string, actor?: { id?: string; email?: string }) {
    const draft = await this.prisma.templateDraft.findUnique({ where: { id: draftId }, include: { variant: { include: { family: true } } } });
    if (!draft) throw new NotFoundException("Template draft not found");
    const parsed = this.validateYamlContent(draft.yamlContent);
    const { providerType, endpoint, apiKey, model } = await this.previewProviderConfig();

    if (!endpoint || !apiKey || !model) {
      const message = "Preview provider is not configured. Configure Settings > AI preview provider or set TEMPLATE_PREVIEW_ENDPOINT_URL, TEMPLATE_PREVIEW_API_KEY and TEMPLATE_PREVIEW_MODEL.";
      await this.prisma.templateDraft.update({ where: { id: draftId }, data: { previewError: message } });
      throw new BadRequestException(message);
    }

    try {
      const messages = formatterPreviewMessages(parsed, draft.sampleTranscript || "No sample transcript was provided.");
      const requestBody = {
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages
      };
      let response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });
      if (response.status === 400) {
        const { response_format: _responseFormat, ...fallbackRequestBody } = requestBody;
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(fallbackRequestBody)
        });
      }

      if (!response.ok) throw new Error(`Preview provider returned ${response.status}`);
      const payload = await response.json() as any;
      const content = previewTextFromProviderPayload(payload);
      if (!content) throw new Error("Preview provider response did not contain generated content.");
      const formatterPayload = parseFormatterPreviewPayload(content);
      const markdown = previewDocumentMarkdown(formatterPayload, parsed);
      const previewSections = formatterPayload.sections ?? previewSectionsFromMarkdown(markdown, parsed);

      const updated = await this.prisma.templateDraft.update({
        where: { id: draftId },
        data: {
          previewMarkdown: markdown,
          previewStructured: {
            outputContract: "mobile-json-v1",
            title: parsed.identity.title,
            summary: formatterPayload.summary ?? null,
            decisions: formatterPayload.decisions ?? [],
            actions: formatterPayload.actions ?? [],
            blockers: formatterPayload.blockers ?? [],
            nextSteps: formatterPayload.nextSteps ?? [],
            actionItems: formatterPayload.actionItems ?? [],
            structuredOutputJSON: formatterPayload.structuredOutputJSON ?? null,
            sections: previewSections
          },
          previewProviderType: providerType,
          previewProviderModel: model,
          previewGeneratedAt: new Date(),
          previewError: null
        }
      });
      await this.audit.log({ actorAdminId: actor?.id, actorEmail: actor?.email, action: "template.preview.generate", targetType: "TemplateDraft", targetId: draftId, metadata: { providerType, model } });
      return this.mapPreview(updated);
    } catch (error) {
      const message = `Preview generation failed: ${(error as Error).message}`;
      const updated = await this.prisma.templateDraft.update({ where: { id: draftId }, data: { previewError: message } });
      return this.mapPreview(updated);
    }
  }

  mapPreview(draft: { previewMarkdown?: string | null; previewStructured?: unknown; previewProviderType?: string | null; previewProviderModel?: string | null; previewGeneratedAt?: Date | null; previewError?: string | null }) {
    return {
      markdown: draft.previewMarkdown ?? null,
      renderedMarkdown: draft.previewMarkdown ?? null,
      extractedFields: draft.previewStructured ?? null,
      provider: draft.previewProviderType ? { type: draft.previewProviderType, model: draft.previewProviderModel } : null,
      generatedAt: draft.previewGeneratedAt?.toISOString() ?? null,
      error: draft.previewError ?? null
    };
  }

  async previewProviderStatus() {
    const { providerType, endpoint, apiKey, model } = await this.previewProviderConfig();
    const missingFields = [
      !endpoint ? "endpointUrl" : null,
      !apiKey ? "apiKey" : null,
      !model ? "model" : null
    ].filter(Boolean);
    return {
      configured: Boolean(endpoint && apiKey && model),
      providerType: providerType ?? null,
      model: model ?? null,
      endpointConfigured: Boolean(endpoint),
      apiKeyConfigured: Boolean(apiKey),
      missingFields
    };
  }

  private async previewProviderConfig() {
    const setting = await this.prisma.systemSetting.findUnique({ where: { key: TEMPLATE_PREVIEW_PROVIDER_SETTING_KEY } });
    const stored = this.previewProviderSettingValue(setting?.value);
    const providerType = stored.providerType || process.env.TEMPLATE_PREVIEW_PROVIDER_TYPE || "openai-compatible";
    const endpoint = stored.endpointUrl || process.env.TEMPLATE_PREVIEW_ENDPOINT_URL || null;
    return {
      providerType,
      endpoint: this.previewChatCompletionsEndpoint(endpoint, providerType),
      apiKey: stored.apiKey || process.env.TEMPLATE_PREVIEW_API_KEY || null,
      model: stored.model || process.env.TEMPLATE_PREVIEW_MODEL || null
    };
  }

  private previewChatCompletionsEndpoint(endpoint?: string | null, providerType?: string | null) {
    if (!endpoint?.trim()) return null;
    const normalizedProvider = providerType?.trim().toLowerCase().replace(/-/g, "_");
    if (!["openai", "openai_compatible"].includes(normalizedProvider ?? "")) return endpoint.trim();

    try {
      const url = new URL(endpoint.trim());
      const path = url.pathname.replace(/\/+$/, "");
      if (path.endsWith("/chat/completions")) return url.toString();
      const basePath = path
        .replace(/\/responses$/i, "")
        .replace(/\/models$/i, "");
      url.pathname = `${basePath || ""}/chat/completions`.replace(/\/{2,}/g, "/");
      url.search = "";
      return url.toString();
    } catch {
      return endpoint.trim();
    }
  }

  private previewProviderSettingValue(value: unknown) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return {
      providerType: typeof source.providerType === "string" && source.providerType.trim() ? source.providerType.trim() : null,
      endpointUrl: typeof source.endpointUrl === "string" && source.endpointUrl.trim() ? source.endpointUrl.trim() : null,
      apiKey: typeof source.apiKey === "string" && source.apiKey.trim() ? source.apiKey.trim() : null,
      model: typeof source.model === "string" && source.model.trim() ? source.model.trim() : null
    };
  }

  private async entitledPublishedVariants(tenantId: string) {
    return this.prisma.templateVariant.findMany({
      where: {
        family: {
          state: { not: "archived" },
          OR: [{ isGlobal: true }, { entitlements: { some: { tenantId } } }]
        },
        publishedVersions: { some: {} }
      },
      include: this.variantManifestInclude(),
      orderBy: [{ family: { title: "asc" } }, { language: "asc" }]
    });
  }

  private variantManifestInclude() {
    return {
      family: { include: { category: true } },
      publishedVersions: { orderBy: [{ publishedAt: "desc" as const }, { createdAt: "desc" as const }] }
    };
  }

  private manifestFromVariants(variants: any[], name: string) {
    return {
      name,
      templates: variants
        .map((variant) => {
          const latest = variant.publishedVersions?.[0];
          if (!latest) return null;
          const metadata = this.metadataFromYaml(latest.yamlContent);
          return {
            id: metadata.id,
            title: metadata.title,
            short_description: metadata.shortDescription,
            category: metadata.category,
            language: metadata.language,
            version: metadata.version,
            icon: metadata.icon,
            tags: metadata.tags,
            download_url: `/api/v1/templates/${metadata.id}/download`,
            updated_at: latest.publishedAt.toISOString()
          };
        })
        .filter(Boolean)
    };
  }

  private async assertEnterpriseTemplateActivation(activationToken: string) {
    if (!activationToken) throw new UnauthorizedException(mobileError("activation_token_required", "Activation token is required"));
    let claims;
    try {
      claims = await verifyActivationToken(this.jwt, activationToken);
    } catch {
      throw new UnauthorizedException(mobileError("activation_token_invalid", "Invalid activation token"));
    }
    const activation = await this.prisma.deviceActivation.findUnique({
      where: { activationTokenHash: tokenHash(activationToken) },
      include: { enterpriseLicenseKey: true, tenant: true }
    });
    if (!activation) throw new UnauthorizedException(mobileError("activation_token_invalid", "Invalid activation token"));
    if (!activation.enterpriseLicenseKeyId || claims.kind !== activation.kind || claims.licenseId !== activation.enterpriseLicenseKeyId || claims.deviceIdentifier !== activation.deviceIdentifier) {
      throw new UnauthorizedException(mobileError("activation_token_invalid", "Invalid activation token"));
    }
    if (activation.kind !== "enterprise" || !activation.tenantId || !activation.enterpriseLicenseKey) {
      throw new ForbiddenException(mobileError("template_repository_enterprise_required", "Template repository access requires an active enterprise activation"));
    }
    this.assertActiveStatus(activation.status, "activation");
    this.assertActiveStatus(activation.enterpriseLicenseKey.status, "license");
    if (activation.enterpriseLicenseKey.expiresAt && activation.enterpriseLicenseKey.expiresAt.getTime() < Date.now()) {
      throw new ForbiddenException(mobileError("license_expired", "License is expired"));
    }
    return activation as typeof activation & { tenantId: string };
  }

  private assertRepositoryApiKey(apiKey: string) {
    const configured = appEnvironment().TEMPLATE_REPOSITORY_API_KEY;
    if (!configured || apiKey !== configured) {
      throw new UnauthorizedException(mobileError("template_repository_unauthorized", "Template repository authorization failed"));
    }
  }

  private isInternalRepositoryBearer(bearer: string) {
    const configured = appEnvironment().TEMPLATE_REPOSITORY_API_KEY;
    return Boolean(configured && bearer === configured);
  }

  private assertActiveStatus(status: string, target: "activation" | "license") {
    if (status !== "active") throw new ForbiddenException(mobileError(`${target}_${status}`, `${target === "license" ? "License" : "Activation"} is ${status}`));
  }

  private bumpVersion(version: string, bump: PublishBump) {
    const [major, minor, patch] = version.split(".").map((part) => Number(part));
    if ([major, minor, patch].some((part) => Number.isNaN(part))) return "1.0.0";
    if (bump === "major") return `${major + 1}.0.0`;
    if (bump === "minor") return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
  }

  private titleFromUseCase(useCase: string) {
    const cleaned = useCase.trim().replace(/\s+/g, " ");
    if (!cleaned) return "New skrivDET template";
    return cleaned.length > 64 ? `${cleaned.slice(0, 61)}...` : cleaned;
  }

  private createYaml(input: {
    id: string;
    title: string;
    shortDescription: string;
    category: string;
    language: string;
    icon: string;
    tags: string[];
    context: AppTemplateYaml["context"];
    perspective: AppTemplateYaml["perspective"];
    sections: TemplateSectionInput[];
    contentRules: AppTemplateYaml["content_rules"];
    llmPrompting: AppTemplateYaml["llm_prompting"];
  }) {
    return renderAppCompatibleYaml({
      identity: {
        id: input.id,
        title: input.title,
        icon: input.icon,
        short_description: input.shortDescription,
        category: input.category,
        tags: input.tags,
        language: input.language,
        version: "1.0.0"
      },
      context: input.context,
      perspective: input.perspective,
      structure: { sections: input.sections },
      content_rules: input.contentRules,
      llm_prompting: input.llmPrompting
    });
  }
}

function assistedDraftProfile(useCase: string, language: string): AssistedDraftProfile {
  const normalized = normalizeText(useCase);
  if (hasAny(normalized, ["incident", "accident", "deviation", "avvik", "hendelse", "skade", "risk", "risiko", "security", "sikkerhet", "privacy", "personvern"])) {
    return incidentProfile(language);
  }
  if (hasAny(normalized, ["health", "care", "patient", "resident", "municipal", "kommune", "bruker", "helse", "omsorg", "saksbehandler", "home visit", "hjemmebesok", "pårørende", "parorende"])) {
    return healthFollowUpProfile(language);
  }
  if (hasAny(normalized, ["employee", "medarbeider", "ansatt", "hr", "manager", "leder", "performance", "check in", "check-in", "utviklingssamtale", "oppfolgingssamtale"])) {
    return hrProfile(language);
  }
  if (hasAny(normalized, ["inspection", "audit", "field", "site visit", "tilsyn", "befaring", "kontroll", "observasjon", "avvikskontroll"])) {
    return inspectionProfile(language);
  }
  if (hasAny(normalized, ["customer", "client", "project", "onboarding", "sales", "kunde", "prosjekt", "leveranse", "stakeholder"])) {
    return projectProfile(language);
  }
  return genericProfile(language);
}

function healthFollowUpProfile(language: string): AssistedDraftProfile {
  const nb = isNorwegian(language);
  return {
    category: "helse_og_oppfolging",
    icon: "person.2.wave.2",
    shortDescription: nb
      ? "Lager et klart oppfølgingsnotat med behov, beslutninger, ansvar og neste steg."
      : "Creates a clear follow-up note with needs, decisions, responsibilities, and next steps.",
    tags: ["health", "follow-up", "municipal", "case-work"],
    context: {
      purpose: nb
        ? "Gjør en helse-, omsorgs- eller tjenestesamtale om til et kort oppfølgingsnotat som viser hva som ble avklart, hva som gjenstår, og hvem som følger opp."
        : "Turn a health, care, or service conversation into a short follow-up note showing what was clarified, what remains open, and who follows up.",
      typical_setting: nb
        ? "Kommunal oppfølgingssamtale, helsemøte, hjemmebesøk eller telefonsamtale med bruker, pårørende eller tjenesteyter."
        : "Municipal follow-up conversation, care meeting, home visit, or phone call with a resident, next of kin, or service provider.",
      typical_participants: nb
        ? [{ role: "saksbehandler" }, { role: "bruker" }, { role: "pårørende", name: null }, { role: "tjenesteyter", name: null }]
        : [{ role: "case worker" }, { role: "resident" }, { role: "next of kin", name: null }, { role: "service provider", name: null }],
      goals: nb
        ? ["Få frem hovedbehov og viktig kontekst.", "Skille tydelige beslutninger fra åpne spørsmål.", "Synliggjøre ansvar, frister og neste kontakt."]
        : ["Capture main needs and important context.", "Separate clear decisions from open questions.", "Show responsibilities, deadlines, and next contact."],
      related_processes: nb ? ["Tjenesteoppfølging", "Journalnotat", "Saksbehandling"] : ["Service follow-up", "Case documentation", "Care coordination"]
    },
    perspective: {
      voice: "third_person",
      audience: "arkiv",
      tone: "formell",
      style_rules: nb
        ? ["Skriv nøkternt og respektfullt.", "Skill fakta fra vurderinger.", "Bruk bare informasjon som støttes av samtalen.", "Hold notatet kort nok til praktisk oppfølging."]
        : ["Write neutrally and respectfully.", "Separate facts from assessments.", "Use only information supported by the conversation.", "Keep the note short enough for practical follow-up."],
      preserve_original_voice: false
    },
    sections: [
      section(nb ? "Sammendrag" : "Summary", nb ? "Gi en kort oversikt over tema, bakgrunn og viktigste avklaringer." : "Give a short overview of the topic, background, and most important clarifications.", "prose", true, nb ? ["tema", "bakgrunn", "hovedbehov", "avklart"] : ["topic", "background", "main need", "clarified"]),
      section(nb ? "Behov og observasjoner" : "Needs and observations", nb ? "List konkrete behov, observasjoner og forhold som påvirker videre oppfølging." : "List concrete needs, observations, and circumstances that affect follow-up.", "bullet_list", true, nb ? ["behov", "observasjon", "utfordring", "støtte", "endring"] : ["need", "observation", "challenge", "support", "change"]),
      section(nb ? "Beslutninger" : "Decisions", nb ? "Ta bare med beslutninger som ble tydelig avklart i samtalen." : "Include only decisions that were clearly agreed in the conversation.", "bullet_list", false, nb ? ["besluttet", "avtalt", "konkludert", "skal"] : ["decided", "agreed", "concluded", "will"]),
      section(nb ? "Oppfølging" : "Follow-up", nb ? "Vis oppgaver, ansvarlige og frister når dette kommer frem." : "Show tasks, owners, and deadlines when they are mentioned.", "table", true, nb ? ["følge opp", "ansvarlig", "frist", "neste kontakt", "ringe"] : ["follow up", "owner", "deadline", "next contact", "call"]),
      section(nb ? "Uavklart" : "Open questions", nb ? "Fang opp manglende informasjon, usikkerhet og spørsmål som må avklares senere." : "Capture missing information, uncertainty, and questions that need later clarification.", "bullet_list", false, nb ? ["uavklart", "usikkert", "mangler", "må sjekkes"] : ["unclear", "uncertain", "missing", "must check"])
    ],
    contentRules: {
      required_elements: nb
        ? ["Ta med behov, beslutninger, ansvarlige og frister når samtalen støtter det.", "Marker tydelig hva som er uavklart.", "Bruk bare informasjon som er relevant for oppfølging."]
        : ["Include needs, decisions, owners, and deadlines when supported by the conversation.", "Clearly mark what remains open.", "Use only information relevant to follow-up."],
      exclusions: nb
        ? ["Ikke ta med småprat.", "Ikke ta med sensitive detaljer som ikke er nødvendige for oppfølging.", "Ikke gjett diagnose, motivasjon eller ansvar."]
        : ["Do not include small talk.", "Do not include sensitive details that are not needed for follow-up.", "Do not guess diagnosis, motivation, or responsibility."],
      uncertainty_handling: nb ? "Skriv Uavklart eller Ikke oppgitt når samtalen ikke gir nok grunnlag." : "Write Open or Not specified when the conversation does not provide enough support.",
      action_item_format: nb ? "Tiltak - ansvarlig - frist" : "Action - owner - deadline",
      decision_marker: nb ? "Beslutning:" : "Decision:",
      speaker_attribution: "role_only"
    },
    llmPrompting: prompting(
      nb ? "Prioriter konkrete oppfølgingsbehov, ansvar og frister fremfor en lang kronologisk gjenfortelling." : "Prioritize concrete follow-up needs, responsibilities, and deadlines over a long chronological recap.",
      nb ? "Hvis et felt mangler grunnlag i samtalen, skriv Ikke oppgitt eller Uavklart i stedet for å fylle inn selv." : "If a field has no support in the conversation, write Not specified or Open instead of filling it in yourself."
    ),
    sampleTranscript: nb
      ? [
          "Saksbehandler: Vi følger opp møtet om hjemmesituasjonen og behovet for praktisk bistand.",
          "Bruker: Det viktigste nå er hjelp om morgenen og en tydelig plan for medisiner.",
          "Pårørende: Jeg kan sende oppdatert medisinliste i morgen.",
          "Saksbehandler: Da avtaler vi at jeg kontakter hjemmetjenesten innen fredag og ringer tilbake mandag."
        ].join("\n")
      : [
          "Case worker: We are following up on the home situation and the need for practical support.",
          "Resident: The most important thing now is morning help and a clear medication plan.",
          "Next of kin: I can send the updated medication list tomorrow.",
          "Case worker: I will contact the home care service by Friday and call back on Monday."
        ].join("\n")
  };
}

function hrProfile(language: string): AssistedDraftProfile {
  const nb = isNorwegian(language);
  return {
    category: "hr",
    icon: "person.crop.circle.badge.checkmark",
    shortDescription: nb ? "Lager et balansert HR-notat med tema, medarbeiderperspektiv, avtaler og oppfølging." : "Creates a balanced HR note with topics, employee perspective, agreements, and follow-up.",
    tags: ["hr", "employee", "follow-up", "manager"],
    context: {
      purpose: nb ? "Dokumenter en medarbeider- eller ledersamtale på en tydelig, respektfull og handlingsrettet måte." : "Document an employee or manager conversation clearly, respectfully, and actionably.",
      typical_setting: nb ? "Samtale mellom leder og medarbeider, eventuelt med HR til stede." : "Conversation between a manager and employee, possibly with HR present.",
      typical_participants: nb ? [{ role: "leder" }, { role: "medarbeider" }, { role: "HR", name: null }] : [{ role: "manager" }, { role: "employee" }, { role: "HR", name: null }],
      goals: nb ? ["Oppsummere tema og medarbeiderens perspektiv.", "Dokumentere avtaler uten å overtolke.", "Synliggjøre neste steg og ansvar."] : ["Summarize topics and the employee perspective.", "Document agreements without over-interpreting.", "Show next steps and ownership."],
      related_processes: nb ? ["HR-oppfølging", "Medarbeiderutvikling", "Lederoppfølging"] : ["HR follow-up", "Employee development", "Manager follow-up"]
    },
    perspective: {
      voice: "third_person",
      audience: "hr",
      tone: "semi_formell",
      style_rules: nb ? ["Skriv respektfullt og saklig.", "Unngå diagnose, skyld eller spekulasjon.", "Skill medarbeiderens utsagn fra avtalte tiltak."] : ["Write respectfully and factually.", "Avoid diagnosis, blame, or speculation.", "Separate employee statements from agreed actions."],
      preserve_original_voice: true
    },
    sections: [
      section(nb ? "Sammendrag" : "Summary", nb ? "Oppsummer hovedtema og kontekst kort." : "Briefly summarize the main topics and context.", "prose", true, nb ? ["tema", "bakgrunn", "status"] : ["topic", "background", "status"]),
      section(nb ? "Medarbeiderens perspektiv" : "Employee perspective", nb ? "Gjengi viktige punkter fra medarbeideren uten å overtolke." : "Capture important points from the employee without over-interpreting.", "bullet_list", true, nb ? ["opplever", "ønsker", "bekymret", "trenger"] : ["experiences", "wants", "concerned", "needs"]),
      section(nb ? "Avtaler" : "Agreements", nb ? "List konkrete avtaler og beslutninger som partene bekreftet." : "List concrete agreements and decisions confirmed by the parties.", "bullet_list", true, nb ? ["avtalt", "besluttet", "enig", "skal"] : ["agreed", "decided", "confirmed", "will"]),
      section(nb ? "Oppfølging" : "Follow-up", nb ? "Vis tiltak, ansvarlig person og frist når dette er sagt." : "Show actions, owner, and deadline when stated.", "table", true, nb ? ["ansvarlig", "frist", "følge opp", "neste møte"] : ["owner", "deadline", "follow up", "next meeting"])
    ],
    contentRules: {
      required_elements: nb ? ["Ta med avtaler, ansvar og frister når de er tydelige.", "Bevar viktige direkte formuleringer fra medarbeideren når de betyr noe."] : ["Include agreements, owners, and deadlines when clear.", "Preserve important direct employee wording when it matters."],
      exclusions: nb ? ["Ikke legg til vurderinger som ikke ble sagt.", "Ikke inkluder private detaljer som ikke er relevante for HR-oppfølging."] : ["Do not add assessments that were not stated.", "Do not include private details that are not relevant for HR follow-up."],
      uncertainty_handling: nb ? "Marker uklare punkter som Må avklares." : "Mark unclear points as Needs clarification.",
      action_item_format: nb ? "Tiltak - ansvarlig - frist" : "Action - owner - deadline",
      decision_marker: nb ? "Avtale:" : "Agreement:",
      speaker_attribution: "role_only"
    },
    llmPrompting: prompting(
      nb ? "Skriv balansert, presist og uten juridiske konklusjoner. Fokuser på det som faktisk ble sagt og avtalt." : "Write in a balanced, precise way without legal conclusions. Focus on what was actually said and agreed.",
      nb ? "Hvis samtalen ikke bekrefter en avtale, plasser punktet under Må avklares i stedet." : "If the conversation does not confirm an agreement, place it under Needs clarification instead."
    ),
    sampleTranscript: nb
      ? [
          "Leder: Målet er å følge opp arbeidsbelastning og avtale konkrete tiltak.",
          "Medarbeider: Jeg opplever at fristene kommer tett, og jeg trenger tydeligere prioritering.",
          "HR: Vi bør skille mellom midlertidige tiltak og det som skal vurderes videre.",
          "Leder: Jeg tar ansvar for prioriteringslisten innen onsdag, og vi setter nytt møte om to uker."
        ].join("\n")
      : [
          "Manager: The goal is to follow up on workload and agree concrete actions.",
          "Employee: I feel the deadlines are close together, and I need clearer priorities.",
          "HR: We should separate temporary actions from what needs further review.",
          "Manager: I will own the priority list by Wednesday, and we will meet again in two weeks."
        ].join("\n")
  };
}

function incidentProfile(language: string): AssistedDraftProfile {
  const nb = isNorwegian(language);
  return {
    category: "avvik_og_hendelser",
    icon: "exclamationmark.triangle",
    shortDescription: nb ? "Lager et faktabasert hendelsesnotat med tidslinje, konsekvens, tiltak og oppfølging." : "Creates a factual incident note with timeline, impact, actions, and follow-up.",
    tags: ["incident", "deviation", "risk", "follow-up"],
    context: {
      purpose: nb ? "Dokumenter en hendelse eller et avvik på en ryddig måte som støtter videre håndtering." : "Document an incident or deviation clearly so it can be handled further.",
      typical_setting: nb ? "Melding, debrief eller oppfølgingssamtale etter en hendelse, feil, skade eller risiko." : "Report, debrief, or follow-up conversation after an incident, error, harm, or risk.",
      typical_participants: nb ? [{ role: "melder" }, { role: "leder" }, { role: "ansvarlig fagperson", name: null }] : [{ role: "reporter" }, { role: "manager" }, { role: "responsible specialist", name: null }],
      goals: nb ? ["Få frem hva som skjedde.", "Skille fakta, konsekvens og antatt årsak.", "Synliggjøre strakstiltak og videre ansvar."] : ["Capture what happened.", "Separate facts, impact, and assumed cause.", "Show immediate actions and further ownership."],
      related_processes: nb ? ["Avvikshåndtering", "Risikostyring", "Kvalitetsarbeid"] : ["Deviation handling", "Risk management", "Quality work"]
    },
    perspective: {
      voice: "third_person",
      audience: "ledelse",
      tone: "formell",
      style_rules: nb ? ["Skriv nøkternt og faktabasert.", "Ikke fordel skyld.", "Marker antakelser tydelig.", "Bruk kronologi når det hjelper forståelsen."] : ["Write neutrally and factually.", "Do not assign blame.", "Clearly mark assumptions.", "Use chronology when it aids understanding."],
      preserve_original_voice: false
    },
    sections: [
      section(nb ? "Hendelse" : "Incident", nb ? "Beskriv kort hva som skjedde, hvor og når." : "Briefly describe what happened, where, and when.", "prose", true, nb ? ["hva skjedde", "tidspunkt", "sted", "involvert"] : ["what happened", "time", "place", "involved"]),
      section(nb ? "Fakta og tidslinje" : "Facts and timeline", nb ? "List kjente fakta i rekkefølge uten å tolke mer enn samtalen støtter." : "List known facts in order without interpreting beyond the conversation.", "numbered_list", true, nb ? ["først", "deretter", "etterpå", "klokken"] : ["first", "then", "afterwards", "time"]),
      section(nb ? "Konsekvens og risiko" : "Impact and risk", nb ? "Fang opp konsekvenser, risiko og hvem eller hva som ble berørt." : "Capture impact, risk, and who or what was affected.", "bullet_list", true, nb ? ["konsekvens", "risiko", "berørt", "skade"] : ["impact", "risk", "affected", "harm"]),
      section(nb ? "Tiltak" : "Actions taken", nb ? "List strakstiltak og planlagte tiltak med ansvarlig når mulig." : "List immediate and planned actions with owner when possible.", "table", true, nb ? ["tiltak", "ansvarlig", "frist", "gjort"] : ["action", "owner", "deadline", "done"]),
      section(nb ? "Videre oppfølging" : "Further follow-up", nb ? "Vis spørsmål, undersøkelser eller beslutninger som må følges opp." : "Show questions, investigations, or decisions that need follow-up.", "bullet_list", false, nb ? ["må undersøkes", "uavklart", "neste steg"] : ["must investigate", "unclear", "next step"])
    ],
    contentRules: {
      required_elements: nb ? ["Ta med tidspunkt, sted, berørte parter, konsekvens og tiltak når oppgitt.", "Skill bekreftede fakta fra antakelser."] : ["Include time, place, affected parties, impact, and actions when stated.", "Separate confirmed facts from assumptions."],
      exclusions: nb ? ["Ikke fordel skyld.", "Ikke ta med rykter eller usikre personopplysninger.", "Ikke konkluder med årsak hvis den ikke er avklart."] : ["Do not assign blame.", "Do not include rumors or uncertain personal data.", "Do not conclude cause if it is not clarified."],
      uncertainty_handling: nb ? "Merk usikker informasjon som Foreløpig eller Uavklart." : "Mark uncertain information as Preliminary or Unclear.",
      action_item_format: nb ? "Tiltak - ansvarlig - frist - status" : "Action - owner - deadline - status",
      decision_marker: nb ? "Beslutning/tiltak:" : "Decision/action:",
      speaker_attribution: "role_only"
    },
    llmPrompting: prompting(
      nb ? "Prioriter etterprøvbare fakta, konsekvens og tiltak. Ikke skriv en fortelling som fyller hullene." : "Prioritize verifiable facts, impact, and actions. Do not write a story that fills the gaps.",
      nb ? "Hvis årsak, ansvar eller konsekvens ikke er tydelig, skriv at det må avklares." : "If cause, responsibility, or impact is not clear, write that it needs clarification."
    ),
    sampleTranscript: nb
      ? [
          "Melder: Hendelsen skjedde rundt klokken 09.30 ved inngangen.",
          "Leder: Hva vet vi sikkert, og hva er fortsatt uklart?",
          "Melder: En bruker falt, men årsaken er ikke bekreftet. Førstehjelp ble gitt med en gang.",
          "Leder: Jeg varsler kvalitetsteamet i dag, og Per sjekker kamera og rutine innen fredag."
        ].join("\n")
      : [
          "Reporter: The incident happened around 09:30 by the entrance.",
          "Manager: What do we know for certain, and what is still unclear?",
          "Reporter: A resident fell, but the cause is not confirmed. First aid was given immediately.",
          "Manager: I will notify the quality team today, and Pat will check camera footage and procedure by Friday."
        ].join("\n")
  };
}

function inspectionProfile(language: string): AssistedDraftProfile {
  const nb = isNorwegian(language);
  return {
    category: "tilsyn_og_befaring",
    icon: "checklist",
    shortDescription: nb ? "Lager et befaringsnotat med observasjoner, avvik, tiltak og neste steg." : "Creates an inspection note with observations, deviations, actions, and next steps.",
    tags: ["inspection", "field-work", "quality", "follow-up"],
    context: {
      purpose: nb ? "Gjør observasjoner fra befaring, tilsyn eller kontroll om til et notat som kan følges opp." : "Turn observations from an inspection, audit, or site visit into a note that can be followed up.",
      typical_setting: nb ? "Befaring, tilsyn, internkontroll eller feltbesøk." : "Inspection, audit, internal control, or field visit.",
      typical_participants: nb ? [{ role: "inspektør" }, { role: "kontaktperson" }, { role: "ansvarlig utfører", name: null }] : [{ role: "inspector" }, { role: "contact person" }, { role: "responsible operator", name: null }],
      goals: nb ? ["Dokumentere observasjoner.", "Skille avvik fra anbefalinger.", "Få frem tiltak, ansvar og frist."] : ["Document observations.", "Separate deviations from recommendations.", "Capture actions, owner, and deadline."],
      related_processes: nb ? ["Tilsyn", "Internkontroll", "Kvalitetsoppfølging"] : ["Inspection", "Internal control", "Quality follow-up"]
    },
    perspective: {
      voice: "third_person",
      audience: "colleagues",
      tone: "semi_formell",
      style_rules: nb ? ["Skriv konkret og observerbart.", "Skill avvik, risiko og anbefaling.", "Ikke legg til funn som ikke ble nevnt."] : ["Write concretely and observably.", "Separate deviation, risk, and recommendation.", "Do not add findings that were not mentioned."],
      preserve_original_voice: false
    },
    sections: [
      section(nb ? "Sammendrag" : "Summary", nb ? "Oppsummer sted, formål og hovedinntrykk." : "Summarize place, purpose, and main impression.", "prose", true, nb ? ["sted", "formål", "hovedinntrykk"] : ["place", "purpose", "main impression"]),
      section(nb ? "Observasjoner" : "Observations", nb ? "List konkrete observasjoner fra befaringen." : "List concrete observations from the inspection.", "bullet_list", true, nb ? ["observerte", "så", "målt", "registrert"] : ["observed", "saw", "measured", "registered"]),
      section(nb ? "Avvik og risiko" : "Deviations and risk", nb ? "Fang opp avvik, mangler og risiko som ble nevnt." : "Capture deviations, gaps, and risks that were mentioned.", "bullet_list", false, nb ? ["avvik", "mangel", "risiko", "brudd"] : ["deviation", "gap", "risk", "breach"]),
      section(nb ? "Tiltak" : "Actions", nb ? "List tiltak med ansvarlig og frist når mulig." : "List actions with owner and deadline when possible.", "table", true, nb ? ["tiltak", "ansvar", "frist", "utbedre"] : ["action", "owner", "deadline", "fix"]),
      section(nb ? "Neste steg" : "Next steps", nb ? "Beskriv videre kontroll, dokumentasjon eller avklaringer." : "Describe further checks, documentation, or clarifications.", "bullet_list", false, nb ? ["neste steg", "dokumentasjon", "kontroll"] : ["next step", "documentation", "check"])
    ],
    contentRules: {
      required_elements: nb ? ["Ta med observasjon, avvik, tiltak, ansvar og frist når dette er sagt."] : ["Include observation, deviation, action, owner, and deadline when stated."],
      exclusions: nb ? ["Ikke legg til tekniske vurderinger som ikke ble sagt.", "Ikke bland anbefalinger inn i faktiske funn."] : ["Do not add technical assessments that were not stated.", "Do not mix recommendations into factual findings."],
      uncertainty_handling: nb ? "Skriv Må kontrolleres hvis funnet ikke er bekreftet." : "Write Needs checking if the finding is not confirmed.",
      action_item_format: nb ? "Tiltak - ansvarlig - frist" : "Action - owner - deadline",
      decision_marker: nb ? "Avtalt tiltak:" : "Agreed action:",
      speaker_attribution: "role_only"
    },
    llmPrompting: prompting(
      nb ? "Hold funn konkrete og etterprøvbare. Ikke gjør observasjoner mer alvorlige enn samtalen støtter." : "Keep findings concrete and verifiable. Do not make observations more severe than the conversation supports.",
      nb ? "Hvis ansvar eller frist mangler, skriv Ikke oppgitt." : "If owner or deadline is missing, write Not specified."
    ),
    sampleTranscript: nb
      ? [
          "Inspektør: Vi starter med observasjonen ved inngangspartiet.",
          "Kontaktperson: Rekkverket er løst, men området er ikke sperret av ennå.",
          "Inspektør: Det bør registreres som avvik, og midlertidig sikring må på plass.",
          "Kontaktperson: Drift tar ansvar for sikring i dag og sender dokumentasjon innen fredag."
        ].join("\n")
      : [
          "Inspector: We start with the observation by the entrance.",
          "Contact person: The railing is loose, but the area is not blocked off yet.",
          "Inspector: That should be registered as a deviation, and temporary securing is needed.",
          "Contact person: Operations will secure it today and send documentation by Friday."
        ].join("\n")
  };
}

function projectProfile(language: string): AssistedDraftProfile {
  const nb = isNorwegian(language);
  return {
    category: "prosjekt_og_kunde",
    icon: "person.2",
    shortDescription: nb ? "Lager et møte- eller kundereferat med behov, beslutninger, åpne spørsmål og oppgaver." : "Creates a meeting or customer note with needs, decisions, open questions, and tasks.",
    tags: ["customer", "project", "meeting", "follow-up"],
    context: {
      purpose: nb ? "Gjør en kunde-, prosjekt- eller leveransesamtale om til et nyttig referat for videre arbeid." : "Turn a customer, project, or delivery conversation into a useful note for continued work.",
      typical_setting: nb ? "Kundemøte, prosjektmøte, avklaringsmøte eller onboarding-samtale." : "Customer meeting, project meeting, clarification meeting, or onboarding conversation.",
      typical_participants: nb ? [{ role: "kunde" }, { role: "prosjektleder" }, { role: "fagansvarlig", name: null }] : [{ role: "customer" }, { role: "project lead" }, { role: "subject matter expert", name: null }],
      goals: nb ? ["Oppsummere behov og beslutninger.", "Fange åpne spørsmål.", "Synliggjøre oppgaver, ansvar og frister."] : ["Summarize needs and decisions.", "Capture open questions.", "Show tasks, ownership, and deadlines."],
      related_processes: nb ? ["Prosjektoppfølging", "Kundeoppfølging", "Leveranse"] : ["Project follow-up", "Customer follow-up", "Delivery"]
    },
    perspective: {
      voice: "third_person",
      audience: "colleagues",
      tone: "semi_formell",
      style_rules: nb ? ["Skriv kort og handlingsrettet.", "Skill kundebehov fra interne vurderinger.", "Fremhev beslutninger og åpne punkter."] : ["Write briefly and actionably.", "Separate customer needs from internal assessments.", "Highlight decisions and open points."],
      preserve_original_voice: false
    },
    sections: [
      section(nb ? "Sammendrag" : "Summary", nb ? "Oppsummer formål, status og hovedpunkter." : "Summarize purpose, status, and main points.", "prose", true, nb ? ["formål", "status", "hovedpunkt"] : ["purpose", "status", "main point"]),
      section(nb ? "Behov og krav" : "Needs and requirements", nb ? "List kundens behov, krav eller forventninger." : "List customer needs, requirements, or expectations.", "bullet_list", true, nb ? ["behov", "krav", "forventer", "ønsker"] : ["need", "requirement", "expects", "wants"]),
      section(nb ? "Beslutninger" : "Decisions", nb ? "List beslutninger som ble tydelig avklart." : "List decisions that were clearly agreed.", "bullet_list", false, nb ? ["besluttet", "avtalt", "godkjent"] : ["decided", "agreed", "approved"]),
      section(nb ? "Oppgaver" : "Tasks", nb ? "Vis oppgaver, ansvarlige og frister." : "Show tasks, owners, and deadlines.", "table", true, nb ? ["oppgave", "ansvarlig", "frist", "leverer"] : ["task", "owner", "deadline", "deliver"]),
      section(nb ? "Åpne spørsmål" : "Open questions", nb ? "Fang opp det som må avklares før neste steg." : "Capture what must be clarified before the next step.", "bullet_list", false, nb ? ["uavklart", "spørsmål", "må avklares"] : ["unclear", "question", "must clarify"])
    ],
    contentRules: {
      required_elements: nb ? ["Ta med beslutninger, oppgaver, ansvar og frister når de er tydelige."] : ["Include decisions, tasks, owners, and deadlines when clear."],
      exclusions: nb ? ["Ikke ta med intern spekulasjon.", "Ikke gjør kundens ønske om til en forpliktelse hvis det ikke ble avtalt."] : ["Do not include internal speculation.", "Do not turn a customer wish into a commitment if it was not agreed."],
      uncertainty_handling: nb ? "Marker uklare forpliktelser som Åpent punkt." : "Mark unclear commitments as Open point.",
      action_item_format: nb ? "Oppgave - ansvarlig - frist" : "Task - owner - deadline",
      decision_marker: nb ? "Beslutning:" : "Decision:",
      speaker_attribution: "none"
    },
    llmPrompting: prompting(
      nb ? "Prioriter beslutninger, avklaringer og neste steg fremfor lange diskusjonsreferater." : "Prioritize decisions, clarifications, and next steps over long discussion minutes.",
      nb ? "Hvis en forpliktelse ikke er tydelig avtalt, skriv den som åpent spørsmål." : "If a commitment was not clearly agreed, write it as an open question."
    ),
    sampleTranscript: nb
      ? [
          "Kunde: Vi trenger en første leveranse innen slutten av måneden.",
          "Prosjektleder: Da foreslår jeg at vi avklarer omfanget før fredag.",
          "Fagansvarlig: Integrasjonen er mulig, men API-tilgang må bekreftes.",
          "Kunde: Jeg sender kontaktperson for API i morgen."
        ].join("\n")
      : [
          "Customer: We need a first delivery by the end of the month.",
          "Project lead: Then I suggest we clarify scope before Friday.",
          "Subject matter expert: The integration is possible, but API access must be confirmed.",
          "Customer: I will send the API contact tomorrow."
        ].join("\n")
  };
}

function genericProfile(language: string): AssistedDraftProfile {
  const nb = isNorwegian(language);
  return {
    category: "annet",
    icon: "doc.text",
    shortDescription: nb ? "Lager et strukturert notat med sammendrag, viktige punkter og oppfølging." : "Creates a structured note with summary, key points, and follow-up.",
    tags: ["general", "structured-note"],
    context: {
      purpose: nb ? "Gjør en samtale, et møte eller et diktat om til et tydelig og nyttig notat." : "Turn a conversation, meeting, or dictation into a clear and useful note.",
      typical_setting: nb ? "Opptak, samtale, møte eller muntlig notat fanget i skrivDET." : "Recording, conversation, meeting, or spoken note captured in skrivDET.",
      typical_participants: nb ? [{ role: "deltaker" }, { role: "ansvarlig", name: null }] : [{ role: "participant" }, { role: "responsible person", name: null }],
      goals: nb ? ["Oppsummere hovedpoeng.", "Fange beslutninger og åpne spørsmål.", "Synliggjøre neste steg."] : ["Summarize main points.", "Capture decisions and open questions.", "Show next steps."],
      related_processes: []
    },
    perspective: {
      voice: "third_person",
      audience: "self",
      tone: "semi_formell",
      style_rules: nb ? ["Skriv klart og kort.", "Bruk bare informasjon fra samtalen.", "Ikke fyll inn manglende detaljer selv."] : ["Write clearly and briefly.", "Use only information from the conversation.", "Do not fill in missing details yourself."],
      preserve_original_voice: false
    },
    sections: [
      section(nb ? "Sammendrag" : "Summary", nb ? "Oppsummer hovedtema og viktigste konklusjoner." : "Summarize the main topic and most important conclusions.", "prose", true, nb ? ["tema", "bakgrunn", "konklusjon"] : ["topic", "background", "conclusion"]),
      section(nb ? "Viktige punkter" : "Key points", nb ? "List viktige observasjoner, fakta eller avklaringer." : "List important observations, facts, or clarifications.", "bullet_list", true, nb ? ["viktig", "avklart", "poeng", "fakta"] : ["important", "clarified", "point", "fact"]),
      section(nb ? "Beslutninger" : "Decisions", nb ? "List beslutninger som tydelig ble tatt." : "List decisions that were clearly made.", "bullet_list", false, nb ? ["besluttet", "avtalt", "konkludert"] : ["decided", "agreed", "concluded"]),
      section(nb ? "Oppfølging" : "Follow-up", nb ? "List oppgaver, ansvarlige og frister når dette finnes." : "List tasks, owners, and deadlines when available.", "table", false, nb ? ["følge opp", "ansvarlig", "frist", "neste steg"] : ["follow up", "owner", "deadline", "next step"])
    ],
    contentRules: {
      required_elements: nb ? ["Ta med bare informasjon som støttes av samtalen.", "Marker manglende ansvar eller frist tydelig."] : ["Include only information supported by the conversation.", "Clearly mark missing owner or deadline."],
      exclusions: nb ? ["Ikke ta med småprat.", "Ikke gjett manglende detaljer."] : ["Do not include small talk.", "Do not guess missing details."],
      uncertainty_handling: nb ? "Skriv Ikke oppgitt når informasjon mangler." : "Write Not specified when information is missing.",
      action_item_format: nb ? "Oppgave - ansvarlig - frist" : "Task - owner - deadline",
      decision_marker: nb ? "Beslutning:" : "Decision:",
      speaker_attribution: "none"
    },
    llmPrompting: prompting(
      nb ? "Lag et nyttig notat som kan brukes direkte etter samtalen." : "Create a useful note that can be used directly after the conversation.",
      nb ? "Hvis en seksjon ikke har støtte i samtalen, skriv at den ikke ble dekket." : "If a section has no support in the conversation, write that it was not covered."
    ),
    sampleTranscript: nb
      ? [
          "Deltaker 1: Vi starter med kort bakgrunn og hovedpunkter.",
          "Deltaker 2: Det viktigste er at tiltakene blir tydelige og fulgt opp.",
          "Deltaker 1: Ansvarlig person og frist bør fremkomme i notatet."
        ].join("\n")
      : [
          "Participant 1: We start with a short background and the main points.",
          "Participant 2: The most important thing is that the actions are clear and followed up.",
          "Participant 1: Owner and deadline should appear in the note."
        ].join("\n")
  };
}

function section(title: string, purpose: string, format: TemplateSectionInput["format"], required: boolean, extraction_hints: string[]): TemplateSectionInput {
  return { title, purpose, format, required, extraction_hints };
}

function prompting(system_prompt_additions: string, fallback_behavior: string): AppTemplateYaml["llm_prompting"] {
  return {
    system_prompt_additions,
    fallback_behavior,
    post_processing: {
      extract_action_items: true
    }
  };
}

function normalizeTemplateLanguage(value?: string | null): AppTemplateYaml["identity"]["language"] {
  if (value === "nn-NO" || value === "en-US") return value;
  return "nb-NO";
}

function limitTemplateTitle(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ") || "New skrivDET template";
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => TemplateSlug(value)).filter(Boolean)));
}

function isNorwegian(language: string) {
  return language === "nb-NO" || language === "nn-NO";
}

function hasAny(source: string, keywords: string[]) {
  return keywords.some((keyword) => source.includes(normalizeText(keyword)));
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function TemplateSlug(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "template";
}

function isSemver(value: string) {
  return /^\d+\.\d+\.\d+$/.test(value);
}

type PreviewMessage = { role: "system" | "user"; content: string };
type PreviewOutputSection = { id: string; title: string; markdown: string };
type FormatterPreviewPayload = {
  documentMarkdown?: string | null;
  summary?: string | null;
  decisions?: string[];
  actions?: string[];
  blockers?: string[];
  nextSteps?: string[];
  actionItems?: string[];
  structuredOutputJSON?: string | null;
  sections?: PreviewOutputSection[];
};

function formatterPreviewMessages(template: AppTemplateYaml, sampleTranscript: string): PreviewMessage[] {
  return [
    { role: "system", content: formatterPreviewSystemPrompt() },
    { role: "user", content: formatterPreviewUserPrompt(template, sampleTranscript) }
  ];
}

function formatterPreviewSystemPrompt() {
  return [
    "You turn transcripts from recordings, meetings, dictations, and reports into template-based structured documents.",
    "Return only valid JSON with exactly these keys:",
    "- documentMarkdown: string",
    "- sections: array of objects with id, title, markdown",
    "- summary: string",
    "- decisions: array of strings",
    "- actions: array of strings",
    "- blockers: array of strings",
    "- nextSteps: array of strings",
    "- actionItems: array of strings",
    "- structuredOutputJSON: string or null",
    "",
    "Every array item outside sections must be a plain string.",
    "Each sections item must match one template section exactly, in the same order, using the provided section id and title.",
    "documentMarkdown must be the complete user-facing document and must follow the selected template sections, order, tone, perspective, content rules, and fallback behavior.",
    "Do not add extra documentMarkdown headings that are not in the template.",
    "Do not rename template section headings.",
    "If structured side-output is requested by the template, put it as a JSON string in structuredOutputJSON. Otherwise use null.",
    "Keep the output factual and faithful to the transcript.",
    "Do not invent people, dates, decisions, action owners, diagnoses, or consent.",
    "If the transcript does not support a section, include one short fallback sentence for that section instead of leaving it empty.",
    "",
    "Language rule:",
    "- Keep the JSON keys in English exactly as specified above.",
    "- Write all user-visible values in the same language as the transcript.",
    "- If the transcript language is unclear, use the template language.",
    "- Keep template section titles exactly as provided."
  ].join("\n");
}

function formatterPreviewUserPrompt(template: AppTemplateYaml, sampleTranscript: string) {
  const sectionPlan = template.structure.sections.map((section) => {
    const hints = bulletList(section.extraction_hints ?? [], "No extraction hints.");
    return [
      `## ${section.title}`,
      `- ID: ${templateSectionId(section)}`,
      `- Purpose: ${section.purpose}`,
      `- Format: ${section.format}`,
      `- Required: ${section.required ? "yes" : "no"}`,
      "- Extraction hints:",
      hints
    ].join("\n");
  }).join("\n\n");
  const postProcessing = template.llm_prompting.post_processing;
  const structuredOutput = postProcessing?.structured_output
    ? JSON.stringify(postProcessing.structured_output, null, 2)
    : null;

  return [
    `Template title: ${template.identity.title}`,
    `Template id: ${template.identity.id}`,
    `Template version: ${template.identity.version}`,
    `Template language: ${template.identity.language}`,
    `Category: ${template.identity.category}`,
    "",
    "Voice, audience, and tone:",
    `- Voice: ${template.perspective.voice}`,
    `- Audience: ${template.perspective.audience}`,
    `- Tone: ${template.perspective.tone}`,
    `- Preserve original voice: ${template.perspective.preserve_original_voice ? "yes" : "no"}`,
    "",
    "Style rules:",
    bulletList(template.perspective.style_rules ?? [], "Use clear, precise, neutral language."),
    "",
    "Template purpose:",
    template.context.purpose,
    "",
    "Typical setting:",
    template.context.typical_setting || "Not specified.",
    "",
    "Participants:",
    bulletList((template.context.typical_participants ?? []).map((participant) => participant.name ? `${participant.role}: ${participant.name}` : participant.role), "Not specified."),
    "",
    "Goals:",
    bulletList(template.context.goals ?? [], "No explicit goals defined."),
    "",
    "Related processes:",
    bulletList(template.context.related_processes ?? [], "No related processes defined."),
    "",
    "Required content:",
    bulletList(template.content_rules.required_elements ?? [], "Use only information supported by the transcript."),
    "",
    "Exclusions:",
    bulletList(template.content_rules.exclusions ?? [], "Do not include irrelevant, unsupported, or unnecessary personal details."),
    "",
    "Uncertainty handling:",
    `- ${template.content_rules.uncertainty_handling || "If the transcript is unclear or incomplete, explicitly mark missing or unclear information instead of inventing content."}`,
    "",
    "Speaker attribution:",
    `- ${template.content_rules.speaker_attribution || "none"}`,
    "",
    "Action and decision formatting:",
    `- Action item format: ${template.content_rules.action_item_format || "not specified"}`,
    `- Decision marker: ${template.content_rules.decision_marker || "not specified"}`,
    "",
    "Template-specific system additions:",
    template.llm_prompting.system_prompt_additions || "- No extra template-specific additions.",
    "",
    "Fallback behavior:",
    `- ${template.llm_prompting.fallback_behavior || "If a required section has no support in the transcript, write that it was not covered instead of generating unsupported content."}`,
    "",
    "Output structure:",
    "Use this exact section plan. Include all required sections, keep section titles unchanged, and do not add headings outside this plan.",
    "",
    sectionPlan,
    "",
    "Post-processing:",
    postProcessing?.extract_action_items
      ? "Populate actionItems only when the transcript contains clear, explicit follow-up tasks or commitments. Otherwise return an empty actionItems array. Do not add a separate action-item section unless that section already exists in the template structure."
      : "Return an empty actionItems array for this template.",
    structuredOutput
      ? `If structured side-output is requested, put a JSON string matching this schema in structuredOutputJSON:\n${structuredOutput}`
      : "Return null for structuredOutputJSON.",
    "",
    "Sample transcript:",
    sampleTranscript
  ].join("\n");
}

function previewTextFromProviderPayload(payload: unknown): string | null {
  return textValue(payload)?.trim() || null;
}

function textValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(textValue).filter(Boolean).join("\n").trim() || null;
  }
  if (!isPlainObject(value)) return null;

  const directKeys = ["content", "text", "output_text", "message"];
  for (const key of directKeys) {
    const text = textValue(value[key]);
    if (text) return text;
  }

  if (Array.isArray(value.choices)) {
    for (const choice of value.choices) {
      const text = textValue(choice);
      if (text) return text;
    }
  }

  if (Array.isArray(value.output)) {
    for (const item of value.output) {
      const text = textValue(item);
      if (text) return text;
    }
  }

  return null;
}

function parseFormatterPreviewPayload(content: string): FormatterPreviewPayload {
  const candidates = [content, extractJSONObject(content)].filter((value): value is string => Boolean(value?.trim()));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const payload = normalizeFormatterPreviewPayload(parsed);
      if (payload.documentMarkdown || payload.sections?.length) return payload;
    } catch {
      // Try the next candidate below.
    }
  }

  throw new Error("Preview provider response did not contain the mobile JSON output contract.");
}

function normalizeFormatterPreviewPayload(value: unknown): FormatterPreviewPayload {
  if (!isPlainObject(value)) return {};

  const structuredOutput = value.structuredOutputJSON ?? value.structured_output_json ?? value.structuredoutputjson ?? value.structured_output;
  return {
    documentMarkdown: stringValue(value.documentMarkdown ?? value.document_markdown ?? value.document ?? value.markdown ?? value.note),
    summary: stringValue(value.summary),
    decisions: stringArray(value.decisions),
    actions: stringArray(value.actions),
    blockers: stringArray(value.blockers),
    nextSteps: stringArray(value.nextSteps ?? value.next_steps ?? value.nextsteps),
    actionItems: stringArray(value.actionItems ?? value.action_items ?? value.actionitems),
    structuredOutputJSON: typeof structuredOutput === "string" ? structuredOutput : isPlainObject(structuredOutput) || Array.isArray(structuredOutput) ? JSON.stringify(structuredOutput, null, 2) : null,
    sections: outputSections(value.sections)
  };
}

function previewDocumentMarkdown(payload: FormatterPreviewPayload, template: AppTemplateYaml) {
  const markdown = payload.documentMarkdown?.trim();
  if (markdown && documentMarkdownMatchesTemplate(markdown, template)) return markdown;

  if (payload.sections?.length) {
    return payload.sections.map((section) => `## ${section.title}\n${section.markdown}`).join("\n\n");
  }

  if (markdown) {
    throw new Error("Preview documentMarkdown did not match the template section headings and order.");
  }

  throw new Error("Preview provider response did not include documentMarkdown or sections.");
}

function documentMarkdownMatchesTemplate(markdown: string, template: AppTemplateYaml) {
  const headings = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+\S/.test(line))
    .map((line) => normalizeHeading(line.replace(/^#{1,6}\s+/, "")));
  if (!headings.length) return false;

  const normalizedTemplateSections = template.structure.sections.map((section) => normalizeHeading(section.title));
  const requiredTemplateSections = new Set(template.structure.sections
    .filter((section) => section.required)
    .map((section) => normalizeHeading(section.title)));

  const matchedRequiredSections = new Set<string>();
  let searchIndex = 0;

  for (const heading of headings) {
    const matchIndex = normalizedTemplateSections.indexOf(heading, searchIndex);
    if (matchIndex === -1) return false;
    if (requiredTemplateSections.has(heading)) matchedRequiredSections.add(heading);
    searchIndex = matchIndex + 1;
  }

  return requiredTemplateSections.size === matchedRequiredSections.size
    && [...requiredTemplateSections].every((section) => matchedRequiredSections.has(section));
}

function outputSections(value: unknown): PreviewOutputSection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sections = value
    .map((item) => {
      if (!isPlainObject(item)) return null;
      const title = stringValue(item.title);
      const markdown = stringValue(item.markdown ?? item.contentMarkdown ?? item.content ?? item.text);
      if (!title || !markdown) return null;
      return {
        id: stringValue(item.id) || templateSlug(title),
        title,
        markdown
      };
    })
    .filter((item): item is PreviewOutputSection => Boolean(item));
  return sections.length ? sections : undefined;
}

function previewSectionsFromMarkdown(markdown: string, template: AppTemplateYaml): PreviewOutputSection[] {
  const markdownByHeading = markdownSections(markdown);
  return template.structure.sections.flatMap((section) => {
    const sectionMarkdown = markdownByHeading.get(normalizeHeading(section.title))?.trim();
    if (!sectionMarkdown) return [];
    return [{
      id: templateSectionId(section),
      title: section.title,
      markdown: sectionMarkdown
    }];
  });
}

function markdownSections(markdown: string) {
  const sections = new Map<string, string>();
  let currentHeading: string | null = null;
  let currentBody: string[] = [];

  const commit = () => {
    if (!currentHeading) return;
    const body = currentBody.join("\n").trim();
    if (body) sections.set(currentHeading, body);
  };

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      commit();
      currentHeading = normalizeHeading(heading[1]);
      currentBody = [];
      continue;
    }
    if (currentHeading) currentBody.push(line);
  }

  commit();
  return sections;
}

function stringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map(stringValue).filter((item): item is string => Boolean(item));
    return items.length ? items : undefined;
  }
  const string = stringValue(value);
  return string ? [string] : undefined;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isPlainObject(value)) {
    const preferred = ["text", "title", "summary", "name", "decision", "action", "blocker", "nextStep", "next_step", "item", "markdown", "content"];
    for (const key of preferred) {
      const text = stringValue(value[key]);
      if (text) return text;
    }
  }
  return null;
}

function extractJSONObject(content: string) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  if (fenced?.[1]?.trim()) return fenced[1].trim();

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start >= 0 && end > start) return content.slice(start, end + 1);
  return null;
}

function templateSectionId(section: AppTemplateYaml["structure"]["sections"][number]) {
  return templateSlug(`${section.title}-${section.purpose}`);
}

function normalizeHeading(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/:/g, "")
    .trim()
    .toLowerCase();
}

function templateSlug(value: string) {
  const folded = value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  const pieces = folded.match(/[\p{L}\p{N}]+/gu) ?? [];
  return pieces.join("_") || randomUUID().toLowerCase();
}

function bulletList(values: string[], fallback: string) {
  const trimmed = values.map((value) => value.trim()).filter(Boolean);
  return trimmed.length ? trimmed.map((value) => `- ${value}`).join("\n") : `- ${fallback}`;
}

function renderAppCompatibleYaml(value: unknown) {
  return `${renderYamlValue(value, 0).join("\n")}\n`;
}

function renderYamlValue(value: unknown, indent: number): string[] {
  if (Array.isArray(value)) return renderYamlArray(value, indent);
  if (isPlainObject(value)) return renderYamlDictionary(value, indent);
  return [`${spaces(indent)}${renderYamlScalar(value)}`];
}

function renderYamlDictionary(dictionary: Record<string, unknown>, indent: number): string[] {
  const entries = Object.entries(dictionary).filter(([, value]) => value !== undefined);
  if (!entries.length) return [`${spaces(indent)}{}`];

  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (isInlineYamlScalar(value)) {
      lines.push(`${spaces(indent)}${key}: ${renderYamlScalar(value)}`);
    } else {
      lines.push(`${spaces(indent)}${key}:`);
      lines.push(...renderYamlValue(value, indent + 2));
    }
  }
  return lines;
}

function renderYamlArray(array: unknown[], indent: number): string[] {
  if (!array.length) return [`${spaces(indent)}[]`];

  const lines: string[] = [];
  for (const item of array) {
    if (isInlineYamlScalar(item)) {
      lines.push(`${spaces(indent)}- ${renderYamlScalar(item)}`);
    } else if (isPlainObject(item)) {
      lines.push(...renderYamlArrayDictionaryItem(item, indent));
    } else {
      lines.push(`${spaces(indent)}-`);
      lines.push(...renderYamlValue(item, indent + 2));
    }
  }
  return lines;
}

function renderYamlArrayDictionaryItem(dictionary: Record<string, unknown>, indent: number): string[] {
  const entries = Object.entries(dictionary).filter(([, value]) => value !== undefined);
  if (!entries.length) return [`${spaces(indent)}- {}`];

  const lines: string[] = [];
  let first = true;
  for (const [key, value] of entries) {
    const prefix = first ? `${spaces(indent)}- ` : spaces(indent + 2);
    if (isInlineYamlScalar(value)) {
      lines.push(`${prefix}${key}: ${renderYamlScalar(value)}`);
    } else {
      lines.push(`${prefix}${key}:`);
      lines.push(...renderYamlValue(value, indent + 4));
    }
    first = false;
  }
  return lines;
}

function renderYamlScalar(value: unknown) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (Array.isArray(value) && value.length === 0) return "[]";
  if (isPlainObject(value) && Object.keys(value).length === 0) return "{}";
  return JSON.stringify(value ?? null);
}

function isInlineYamlScalar(value: unknown) {
  if (value === null) return true;
  if (["string", "boolean", "number"].includes(typeof value)) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (isPlainObject(value) && Object.keys(value).length === 0) return true;
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function spaces(count: number) {
  return " ".repeat(count);
}
