import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JwtService } from "@nestjs/jwt";
import { ActivationService } from "../src/activation/activation.service";
import { issueActivationToken } from "../src/activation/activation-token";
import { sha256 } from "../src/common/crypto";

describe("ActivationService", () => {
  let prisma: any;
  let service: ActivationService;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test?schema=public");
    vi.stubEnv("JWT_SECRET", "j".repeat(64));
    vi.stubEnv("ACTIVATION_TOKEN_SECRET", "a".repeat(64));
    vi.stubEnv("CONFIG_SECRET_KEY", Buffer.alloc(32, 7).toString("base64"));
    prisma = {
      singleLicenseKey: {
        findUnique: vi.fn(),
        update: vi.fn()
      },
      enterpriseLicenseKey: { findUnique: vi.fn() },
      deviceActivation: {
        upsert: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn()
      },
      templateCategory: {
        findMany: vi.fn().mockResolvedValue([])
      }
    };
    service = new ActivationService(prisma, { log: vi.fn() } as any, new JwtService());
  });

  it("binds a single license to the first device", async () => {
    const maintenanceUntil = new Date("2027-04-29T00:00:00.000Z");
    prisma.singleLicenseKey.findUnique.mockResolvedValue({ id: "key-1", status: "active", expiresAt: null, deviceIdentifier: null, activatedAt: null, maintenanceUntil });
    prisma.deviceActivation.upsert.mockResolvedValue({
      id: "act-1",
      deviceIdentifier: "iphone-1",
      deviceSerialNumber: "SERIAL-1",
      lastSeenAt: new Date("2026-04-29T08:00:00.000Z")
    });
    prisma.singleLicenseKey.update.mockResolvedValue({
      purchaserFullName: "Seed User",
      purchaserEmail: "seed.user@example.com",
      status: "active",
      activatedAt: new Date("2026-04-29T08:00:00.000Z"),
      maintenanceUntil
    });

    const result = await service.activateSingle({ activationKey: "ULFY-S-ABC", deviceIdentifier: "iphone-1", deviceSerialNumber: "SERIAL-1", appVersion: "1.0" });

    expect(result.success).toBe(true);
    expect(result.activationToken).toBeTruthy();
    expect(result.license).toEqual({
      type: "single",
      status: "active",
      registeredToName: "Seed User",
      registeredToEmail: "seed.user@example.com",
      activatedAt: "2026-04-29T08:00:00.000Z",
      maintenanceActive: true,
      maintenanceUntil: "2027-04-29T00:00:00.000Z"
    });
    expect(result.device).toEqual({
      deviceIdentifier: "iphone-1",
      deviceSerialNumber: "SERIAL-1",
      lastSeenAt: "2026-04-29T08:00:00.000Z"
    });
    expect(prisma.singleLicenseKey.findUnique).toHaveBeenCalledWith({ where: { keyHash: sha256("ULFY-S-ABC") } });
    expect(prisma.singleLicenseKey.update.mock.calls[0][0].data.deviceIdentifier).toBe("iphone-1");
    expect(prisma.singleLicenseKey.update.mock.calls[0][0].data.deviceSerialNumber).toBe("SERIAL-1");
    expect(prisma.singleLicenseKey.update.mock.calls[0][0].data.lastSeenAt).toBeInstanceOf(Date);
  });

  it("rejects a second device for a single license", async () => {
    prisma.singleLicenseKey.findUnique.mockResolvedValue({ id: "key-1", status: "active", expiresAt: null, deviceIdentifier: "iphone-1" });
    await expect(service.activateSingle({ activationKey: "ULFY-S-ABC", deviceIdentifier: "iphone-2", appVersion: "1.0" })).rejects.toThrow();
  });

  it("updates last seen and serial number on refresh", async () => {
    const maintenanceUntil = new Date("2027-04-29T00:00:00.000Z");
    prisma.deviceActivation.findUnique.mockResolvedValue({
      id: "act-1",
      kind: "single",
      status: "active",
      deviceIdentifier: "iphone-1",
      deviceSerialNumber: null,
      appVersion: "1.0",
      singleLicenseKeyId: "key-1",
      activatedAt: new Date("2026-04-29T08:00:00.000Z"),
      singleLicenseKey: {
        purchaserFullName: "Seed User",
        purchaserEmail: "seed.user@example.com",
        status: "active",
        expiresAt: null,
        activatedAt: new Date("2026-04-29T08:00:00.000Z"),
        maintenanceUntil
      },
      enterpriseLicenseKey: null
    });
    prisma.deviceActivation.update.mockResolvedValue({});
    prisma.singleLicenseKey.update.mockResolvedValue({});
    const activationToken = await issueActivationToken(new JwtService(), {
      kind: "single",
      licenseId: "key-1",
      deviceIdentifier: "iphone-1"
    });

    const result = await service.refresh({ activationToken, deviceIdentifier: "iphone-1", deviceSerialNumber: "SERIAL-1", appVersion: "1.1" });

    expect(result.success).toBe(true);
    expect(result.activationToken).toBeTruthy();
    expect(result.activationToken).not.toBe(activationToken);
    expect(result.license.registeredToName).toBe("Seed User");
    expect(result.license.maintenanceUntil).toBe("2027-04-29T00:00:00.000Z");
    expect(result.device.deviceSerialNumber).toBe("SERIAL-1");
    expect(result.lastSeenAt).toBeTruthy();
    expect(prisma.deviceActivation.update.mock.calls[0][0].data.lastSeenAt).toBeInstanceOf(Date);
    expect(prisma.singleLicenseKey.update.mock.calls[0][0].data.lastSeenAt).toBeInstanceOf(Date);
  });

  it("returns enterprise tenant, license, and config details", async () => {
    const maintenanceUntil = new Date("2027-04-29T00:00:00.000Z");
    prisma.templateCategory.findMany.mockResolvedValue([
      { slug: "personlig_diktat", title: "Personlig diktat", icon: "waveform.and.mic" },
      { slug: "oppfolgingssamtale", title: "Oppfølgingssamtale", icon: "arrow.triangle.2.circlepath" }
    ]);
    prisma.deviceActivation.findUnique.mockResolvedValue({
      id: "act-2",
      kind: "enterprise",
      status: "active",
      deviceIdentifier: "iphone-2",
      deviceSerialNumber: "SERIAL-2",
      appVersion: "1.0",
      activatedAt: new Date("2026-04-29T08:00:00.000Z"),
      lastSeenAt: new Date("2026-04-29T09:00:00.000Z"),
      singleLicenseKeyId: null,
      enterpriseLicenseKeyId: "enterprise-key-1",
      singleLicenseKey: null,
      enterpriseLicenseKey: {
        status: "active",
        expiresAt: null,
        maintenanceUntil,
        tenant: {
          id: "tenant-1",
          name: "Acme Health",
          slug: "acme-health",
          legalName: "Acme Health AS",
          contactEmail: "kari@acme-health.example"
        },
        configProfile: {
          id: "profile-1",
          name: "Default Enterprise Profile",
          speechProviderType: "openai",
          speechApiKey: "speech-key",
          piiControlEnabled: true,
          presidioApiKey: "presidio-key",
          presidioScoreThreshold: 0.35,
          presidioFullPersonNamesOnly: true,
          presidioDetectPerson: true,
          presidioDetectEmail: true,
          privacyReviewProviderType: "vllm",
          privacyReviewApiKey: "privacy-key",
          privacyPrompt: "Check for sensitive details before document generation.",
          documentGenerationProviderType: "openai",
          documentGenerationApiKey: "docgen-key",
          featureFlags: { developerMode: false, allowExternalProviders: false },
          allowedProviderRestrictions: [],
          providerProfiles: {
            speech: {
              selected: "azure",
              available: ["azure", "openai"],
              providers: {
                azure: { type: "azure", enabled: true, endpointUrl: "https://kvasetech.com/stt", apiKey: "azure-key" },
                openai: { type: "openai", enabled: true, endpointUrl: "https://api.openai.com/v1", modelName: "gpt-4o-transcribe", apiKey: "openai-speech-key" },
                gemini: { type: "gemini", enabled: false, endpointUrl: "https://generativelanguage.googleapis.com", apiKey: "disabled-gemini-key" }
              }
            },
            formatter: {
              selected: "openai_compatible",
              selectedProviderId: "docgen-provider",
              available: ["docgen-provider", "disabled-provider"],
              providers: [
                { id: "docgen-provider", name: "Docgen", type: "openai_compatible", enabled: true, endpointUrl: "https://llm.example.internal/v1", modelName: "skrivdet-docgen", apiKey: "docgen-profile-key" },
                { id: "disabled-provider", name: "Disabled", type: "openai_compatible", enabled: false, endpointUrl: "https://disabled.example/v1", modelName: "disabled", apiKey: "disabled-docgen-key" }
              ]
            }
          },
          managedPolicy: {
            allowPolicyOverride: false,
            hideSettings: true,
            hideRecordingFloatingToolbar: true,
            visibleSettingsWhenHidden: ["live_transcription_during_recording", "audio_source", "language", "recording_floating_toolbar", "privacy_prompt", "unknown_setting"],
            userMayChangeSpeechProvider: true,
            userMayChangeFormatter: true,
            userMayChangePrivacyReviewProvider: true,
            managePrivacyPrompt: true,
            manageTemplateCategories: true
          }
        }
      }
    });
    prisma.deviceActivation.update.mockResolvedValue({});
    const activationToken = await issueActivationToken(new JwtService(), {
      kind: "enterprise",
      licenseId: "enterprise-key-1",
      deviceIdentifier: "iphone-2"
    });

    const result = await service.refresh({ activationToken, deviceIdentifier: "iphone-2", appVersion: "1.1" });

    expect(result.success).toBe(true);
    expect(result.activationToken).toBeTruthy();
    expect(result.activationToken).not.toBe(activationToken);
    expect(result.license).toMatchObject({
      type: "enterprise",
      registeredToName: "Acme Health AS",
      registeredToEmail: "kari@acme-health.example",
      activatedAt: "2026-04-29T08:00:00.000Z",
      maintenanceActive: true,
      maintenanceUntil: "2027-04-29T00:00:00.000Z"
    });
    expect(result.tenant).toMatchObject({ id: "tenant-1", name: "Acme Health", slug: "acme-health" });
    expect(result.config).toMatchObject({
      id: "profile-1",
      name: "Default Enterprise Profile",
      speechApiKey: "speech-key",
      piiControlEnabled: true,
      presidioApiKey: "presidio-key",
      presidioScoreThreshold: 0.35,
      presidioFullPersonNamesOnly: true,
      presidioDetectPerson: true,
      presidioDetectEmail: true,
      privacyReviewProviderType: "openai_compatible",
      privacyReviewApiKey: "privacy-key",
      privacyPrompt: "Check for sensitive details before document generation.",
      documentGenerationProviderType: "openai_compatible",
      documentGenerationApiKey: "docgen-key",
      templateCategories: [
        { id: "personlig_diktat", title: "Personlig diktat", icon: "waveform.and.mic" },
        { id: "oppfolgingssamtale", title: "Oppfølgingssamtale", icon: "arrow.triangle.2.circlepath" }
      ],
      managedPolicy: {
        allowPolicyOverride: false,
        hideSettings: true,
        hideRecordingFloatingToolbar: true,
        visibleSettingsWhenHidden: ["live_transcription_during_recording", "audio_source", "language", "recording_floating_toolbar", "privacy_prompt"],
        userMayChangeSpeechProvider: true,
        userMayChangeFormatter: true,
        managePrivacyControl: false,
        userMayChangePrivacyControl: false,
        managePIIControl: true,
        userMayChangePIIControl: false,
        managePrivacyReviewProvider: true,
        userMayChangePrivacyReviewProvider: true,
        managePrivacyPrompt: true,
        manageTemplateCategories: true
      }
    });
    expect(result.config.providerProfiles).toMatchObject({
      speech: {
        selected: "azure",
        available: ["azure", "openai"],
        providers: {
          azure: { apiKey: "azure-key" },
          openai: { apiKey: "openai-speech-key", modelName: "gpt-4o-transcribe" }
        }
      },
      formatter: {
        selectedProviderId: "docgen-provider",
        available: ["docgen-provider"],
        providers: [{ id: "docgen-provider", apiKey: "docgen-profile-key" }]
      }
    });
    expect(result.config.providerProfiles.speech.providers.gemini).toBeUndefined();
    expect(result.config.providerProfiles.formatter.providers).toHaveLength(1);
  });

  it("uses the tenant assigned profile on enterprise refresh before the original key profile", async () => {
    prisma.deviceActivation.findUnique.mockResolvedValue({
      id: "act-current-profile",
      kind: "enterprise",
      status: "active",
      deviceIdentifier: "iphone-current-profile",
      deviceSerialNumber: null,
      appVersion: "1.0",
      activatedAt: new Date("2026-04-29T08:00:00.000Z"),
      singleLicenseKeyId: null,
      enterpriseLicenseKeyId: "enterprise-key-current-profile",
      singleLicenseKey: null,
      enterpriseLicenseKey: {
        status: "active",
        expiresAt: null,
        maintenanceUntil: null,
        tenant: {
          id: "tenant-current-profile",
          name: "Alta kommune",
          slug: "alta-kommune",
          configProfile: {
            id: "profile-alta",
            name: "Alta kommune profile",
            speechProviderType: "azure",
            documentGenerationProviderType: "openai_compatible",
            featureFlags: {},
            allowedProviderRestrictions: [],
            providerProfiles: {},
            managedPolicy: {}
          }
        },
        configProfile: {
          id: "profile-default",
          name: "Default Enterprise Profile",
          speechProviderType: "openai",
          documentGenerationProviderType: "openai_compatible",
          featureFlags: {},
          allowedProviderRestrictions: [],
          providerProfiles: {},
          managedPolicy: {}
        }
      }
    });
    prisma.deviceActivation.update.mockResolvedValue({});
    const activationToken = await issueActivationToken(new JwtService(), {
      kind: "enterprise",
      licenseId: "enterprise-key-current-profile",
      deviceIdentifier: "iphone-current-profile"
    });

    const result = await service.refresh({ activationToken, deviceIdentifier: "iphone-current-profile", appVersion: "1.1" });

    expect(result.config).toMatchObject({
      id: "profile-alta",
      name: "Alta kommune profile",
      speechProviderType: "azure"
    });
  });

  it("keeps privacy booleans sparse while managing category catalog by default", async () => {
    prisma.templateCategory.findMany.mockResolvedValue([
      { slug: "personlig_diktat", title: "Personlig diktat", icon: "waveform.and.mic" }
    ]);
    prisma.deviceActivation.findUnique.mockResolvedValue({
      id: "act-3",
      kind: "enterprise",
      status: "active",
      deviceIdentifier: "iphone-3",
      deviceSerialNumber: null,
      appVersion: "1.0",
      enterpriseLicenseKeyId: "enterprise-key-2",
      activatedAt: new Date("2026-04-29T08:00:00.000Z"),
      singleLicenseKey: null,
      enterpriseLicenseKey: {
        status: "active",
        expiresAt: null,
        maintenanceUntil: null,
        tenant: {
          id: "tenant-2",
          name: "Sparse Health",
          slug: "sparse-health"
        },
        configProfile: {
          id: "profile-2",
          name: "Sparse policy",
          privacyControlEnabled: true,
          piiControlEnabled: true,
          presidioEndpointUrl: "https://presidio.example.internal",
          presidioApiKey: "presidio-key",
          privacyReviewProviderType: "openai_compatible",
          privacyReviewEndpointUrl: "https://privacy.example.internal/v1",
          privacyReviewApiKey: "privacy-key",
          privacyPrompt: "This policy prompt should not be sent.",
          featureFlags: {},
          allowedProviderRestrictions: [],
          providerProfiles: {},
          managedPolicy: {
            managePrivacyControl: false,
            managePIIControl: false,
            managePrivacyReviewProvider: false,
            managePrivacyPrompt: false
          }
        }
      }
    });
    prisma.deviceActivation.update.mockResolvedValue({});
    const activationToken = await issueActivationToken(new JwtService(), {
      kind: "enterprise",
      licenseId: "enterprise-key-2",
      deviceIdentifier: "iphone-3"
    });

    const result = await service.refresh({ activationToken, deviceIdentifier: "iphone-3", appVersion: "1.1" });

    expect(result.config).not.toHaveProperty("privacyControlEnabled");
    expect(result.config).not.toHaveProperty("piiControlEnabled");
    expect(result.config).not.toHaveProperty("presidioEndpointUrl");
    expect(result.config).not.toHaveProperty("presidioApiKey");
    expect(result.config).not.toHaveProperty("privacyReviewProviderType");
    expect(result.config).not.toHaveProperty("privacyReviewEndpointUrl");
    expect(result.config).not.toHaveProperty("privacyReviewApiKey");
    expect(result.config).not.toHaveProperty("privacyPrompt");
    expect(result.config.templateCategories).toEqual([
      { id: "personlig_diktat", title: "Personlig diktat", icon: "waveform.and.mic" }
    ]);
    expect(result.config.managedPolicy).toMatchObject({
      managePrivacyControl: false,
      userMayChangePrivacyControl: false,
      managePIIControl: false,
      userMayChangePIIControl: false,
      managePrivacyReviewProvider: false,
      userMayChangePrivacyReviewProvider: false,
      managePrivacyPrompt: false,
      hideRecordingFloatingToolbar: false,
      manageTemplateCategories: true
    });
    expect(prisma.templateCategory.findMany).toHaveBeenCalled();
  });
});
