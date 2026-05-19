import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { LicenseStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../common/audit.service";
import { sha256, tokenHash } from "../common/crypto";
import { decryptConfigProfileSecrets } from "../common/secret-crypto";
import { issueActivationToken, verifyActivationToken } from "./activation-token";

type ActivationInput = { activationKey: string; deviceIdentifier: string; deviceSerialNumber?: string; appVersion: string };
type RefreshInput = { activationToken: string; deviceIdentifier?: string; deviceSerialNumber?: string; appVersion?: string };

@Injectable()
export class ActivationService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly jwt: JwtService) {}

  async activateSingle(input: ActivationInput) {
    const key = await this.prisma.singleLicenseKey.findUnique({ where: { keyHash: sha256(input.activationKey) } });
    if (!key) throw new NotFoundException(mobileError("activation_key_invalid", "Activation key not found"));
    this.assertUsable(key.status, key.expiresAt);

    if (key.deviceIdentifier && key.deviceIdentifier !== input.deviceIdentifier) {
      throw new ForbiddenException(mobileError("license_already_bound", "Activation key is already bound to another device"));
    }

    const activationToken = await issueActivationToken(this.jwt, {
      kind: "single",
      licenseId: key.id,
      deviceIdentifier: input.deviceIdentifier
    });
    const now = new Date();
    const activation = await this.prisma.deviceActivation.upsert({
      where: { singleLicenseKeyId_deviceIdentifier: { singleLicenseKeyId: key.id, deviceIdentifier: input.deviceIdentifier } },
      update: {
        activationTokenHash: tokenHash(activationToken),
        lastCheckIn: now,
        lastSeenAt: now,
        appVersion: input.appVersion,
        deviceSerialNumber: input.deviceSerialNumber,
        status: "active"
      },
      create: {
        kind: "single",
        singleLicenseKeyId: key.id,
        deviceIdentifier: input.deviceIdentifier,
        deviceSerialNumber: input.deviceSerialNumber,
        activationTokenHash: tokenHash(activationToken),
        appVersion: input.appVersion,
        lastCheckIn: now,
        lastSeenAt: now,
        status: "active"
      }
    });

    const activatedAt = key.activatedAt ?? now;
    const updatedKey = await this.prisma.singleLicenseKey.update({
      where: { id: key.id },
      data: {
        activatedAt,
        deviceIdentifier: input.deviceIdentifier,
        deviceSerialNumber: input.deviceSerialNumber,
        appVersion: input.appVersion,
        lastCheckIn: now,
        lastSeenAt: now
      }
    });
    await this.audit.log({ action: "activation.single", targetType: "SingleLicenseKey", targetId: key.id, metadata: { deviceIdentifier: input.deviceIdentifier, deviceSerialNumber: input.deviceSerialNumber } });

    return {
      success: true,
      activationToken,
      activationId: activation.id,
      license: this.mapSingleLicense(updatedKey),
      device: this.mapDevice(activation),
      config: {}
    };
  }

  async activateEnterprise(input: ActivationInput) {
    const key = await this.prisma.enterpriseLicenseKey.findUnique({
      where: { keyHash: sha256(input.activationKey) },
      include: { tenant: true, configProfile: true, activations: true }
    });
    if (!key) throw new NotFoundException(mobileError("enterprise_key_invalid", "Enterprise key not found"));
    this.assertUsable(key.status, key.expiresAt);

    const existingForDevice = key.activations.find((item) => item.deviceIdentifier === input.deviceIdentifier);
    if (!existingForDevice && key.maxDevices && key.activations.filter((item) => item.status === "active").length >= key.maxDevices) {
      throw new ForbiddenException(mobileError("enterprise_device_limit_reached", "Enterprise device limit reached"));
    }

    const activationToken = await issueActivationToken(this.jwt, {
      kind: "enterprise",
      licenseId: key.id,
      deviceIdentifier: input.deviceIdentifier
    });
    const now = new Date();
    const activation = await this.prisma.deviceActivation.upsert({
      where: { enterpriseLicenseKeyId_deviceIdentifier: { enterpriseLicenseKeyId: key.id, deviceIdentifier: input.deviceIdentifier } },
      update: {
        activationTokenHash: tokenHash(activationToken),
        lastCheckIn: now,
        lastSeenAt: now,
        appVersion: input.appVersion,
        deviceSerialNumber: input.deviceSerialNumber,
        status: "active"
      },
      create: {
        kind: "enterprise",
        enterpriseLicenseKeyId: key.id,
        tenantId: key.tenantId,
        deviceIdentifier: input.deviceIdentifier,
        deviceSerialNumber: input.deviceSerialNumber,
        activationTokenHash: tokenHash(activationToken),
        appVersion: input.appVersion,
        lastCheckIn: now,
        lastSeenAt: now,
        status: "active"
      }
    });
    await this.audit.log({ action: "activation.enterprise", targetType: "EnterpriseLicenseKey", targetId: key.id, metadata: { deviceIdentifier: input.deviceIdentifier, deviceSerialNumber: input.deviceSerialNumber } });

    return {
      success: true,
      activationToken,
      activationId: activation.id,
      license: this.mapEnterpriseLicense(key, activation.activatedAt),
      tenant: this.mapTenant(key.tenant),
      device: this.mapDevice(activation),
      config: await this.mapConfig(key.configProfile)
    };
  }

  async refresh(input: RefreshInput) {
    const activation = await this.findActivationByToken(input.activationToken);
    this.assertUsable(activation.status, null);
    this.assertActivationLicenseUsable(activation);
    if (input.deviceIdentifier && input.deviceIdentifier !== activation.deviceIdentifier) {
      throw new ForbiddenException(mobileError("activation_device_mismatch", "Activation token does not belong to this device"));
    }
    const licenseId = activation.kind === "single" ? activation.singleLicenseKeyId : activation.enterpriseLicenseKeyId;
    if (!licenseId) {
      throw new ForbiddenException(mobileError("activation_token_invalid", "Invalid activation token"));
    }
    const refreshedActivationToken = await issueActivationToken(this.jwt, {
      kind: activation.kind,
      licenseId,
      deviceIdentifier: activation.deviceIdentifier
    });
    const now = new Date();
    await this.prisma.deviceActivation.update({
      where: { id: activation.id },
      data: {
        activationTokenHash: tokenHash(refreshedActivationToken),
        lastCheckIn: now,
        lastSeenAt: now,
        appVersion: input.appVersion ?? activation.appVersion,
        deviceSerialNumber: input.deviceSerialNumber ?? activation.deviceSerialNumber
      }
    });
    if (activation.singleLicenseKeyId) {
      await this.prisma.singleLicenseKey.update({
        where: { id: activation.singleLicenseKeyId },
        data: {
          lastCheckIn: now,
          lastSeenAt: now,
          appVersion: input.appVersion ?? activation.appVersion,
          deviceSerialNumber: input.deviceSerialNumber ?? activation.deviceSerialNumber
        }
      });
    }
    const refreshedActivation = {
      ...activation,
      lastSeenAt: now,
      appVersion: input.appVersion ?? activation.appVersion,
      deviceSerialNumber: input.deviceSerialNumber ?? activation.deviceSerialNumber
    };
    const config = activation.enterpriseLicenseKey?.configProfile ? await this.mapConfig(activation.enterpriseLicenseKey.configProfile) : {};
    const tenant = activation.enterpriseLicenseKey?.tenant ? this.mapTenant(activation.enterpriseLicenseKey.tenant) : null;
    return {
      success: true,
      activationToken: refreshedActivationToken,
      status: activation.status,
      kind: activation.kind,
      lastSeenAt: now.toISOString(),
      license: this.mapActivationLicense(refreshedActivation),
      tenant,
      device: this.mapDevice(refreshedActivation),
      config
    };
  }

  async effectiveConfig(activationToken: string) {
    if (!activationToken) throw new BadRequestException(mobileError("activation_token_required", "activationToken query parameter is required"));
    const activation = await this.findActivationByToken(activationToken);
    this.assertUsable(activation.status, null);
    this.assertActivationLicenseUsable(activation);
    const tenant = activation.enterpriseLicenseKey?.tenant ? this.mapTenant(activation.enterpriseLicenseKey.tenant) : null;
    return {
      success: true,
      tenant,
      license: this.mapActivationLicense(activation),
      config: activation.enterpriseLicenseKey?.configProfile ? await this.mapConfig(activation.enterpriseLicenseKey.configProfile) : {}
    };
  }

  async licenseDetails(activationToken: string) {
    if (!activationToken) throw new BadRequestException(mobileError("activation_token_required", "activationToken query parameter is required"));
    const activation = await this.findActivationByToken(activationToken);
    this.assertUsable(activation.status, null);
    this.assertActivationLicenseUsable(activation);
    const tenant = activation.enterpriseLicenseKey?.tenant ? this.mapTenant(activation.enterpriseLicenseKey.tenant) : null;
    return {
      success: true,
      license: this.mapActivationLicense(activation),
      tenant,
      device: this.mapDevice(activation),
      config: activation.enterpriseLicenseKey?.configProfile ? await this.mapConfig(activation.enterpriseLicenseKey.configProfile) : {}
    };
  }

  async assertEnterpriseActivationToken(activationToken: string) {
    const activation = await this.findActivationByToken(activationToken);
    this.assertUsable(activation.status, null);
    this.assertActivationLicenseUsable(activation);
    if (activation.kind !== "enterprise" || !activation.enterpriseLicenseKey?.configProfile || !activation.tenantId) {
      throw new ForbiddenException(mobileError("enterprise_activation_required", "Enterprise activation is required"));
    }
    return activation;
  }

  private async findActivationByToken(activationToken: string) {
    if (!activationToken) throw new UnauthorizedActivation();

    let claims;
    try {
      claims = await verifyActivationToken(this.jwt, activationToken);
    } catch {
      throw new UnauthorizedActivation();
    }

    const activation = await this.prisma.deviceActivation.findUnique({
      where: { activationTokenHash: tokenHash(activationToken) },
      include: {
        singleLicenseKey: true,
        enterpriseLicenseKey: { include: { configProfile: true, tenant: true } },
        tenant: true
      }
    });
    if (!activation) throw new UnauthorizedActivation();
    const licenseId = activation.kind === "single" ? activation.singleLicenseKeyId : activation.enterpriseLicenseKeyId;
    if (!licenseId || claims.kind !== activation.kind || claims.licenseId !== licenseId || claims.deviceIdentifier !== activation.deviceIdentifier) {
      throw new UnauthorizedActivation();
    }
    return activation;
  }

  private assertUsable(status: LicenseStatus, expiresAt?: Date | null) {
    if (status !== "active") throw new ForbiddenException(mobileError(`license_${status}`, `License is ${status}`));
    if (expiresAt && expiresAt.getTime() < Date.now()) throw new ForbiddenException(mobileError("license_expired", "License is expired"));
  }

  private assertActivationLicenseUsable(activation: any) {
    if (activation.kind === "single" && activation.singleLicenseKey) {
      this.assertUsable(activation.singleLicenseKey.status, activation.singleLicenseKey.expiresAt);
    }
    if (activation.kind === "enterprise" && activation.enterpriseLicenseKey) {
      this.assertUsable(activation.enterpriseLicenseKey.status, activation.enterpriseLicenseKey.expiresAt);
    }
  }

  private mapDevice(activation: { deviceIdentifier: string; deviceSerialNumber?: string | null; lastSeenAt?: Date | null; lastCheckIn?: Date | null }) {
    const lastSeenAt = activation.lastSeenAt ?? activation.lastCheckIn ?? new Date();
    return {
      deviceIdentifier: activation.deviceIdentifier,
      deviceSerialNumber: activation.deviceSerialNumber ?? null,
      lastSeenAt: lastSeenAt.toISOString()
    };
  }

  private mapActivationLicense(activation: any) {
    if (activation.kind === "single" && activation.singleLicenseKey) {
      return this.mapSingleLicense(activation.singleLicenseKey);
    }
    if (activation.kind === "enterprise" && activation.enterpriseLicenseKey) {
      return this.mapEnterpriseLicense(activation.enterpriseLicenseKey, activation.activatedAt);
    }
    return {
      type: activation.kind,
      status: activation.status,
      registeredToName: null,
      registeredToEmail: null,
      activatedAt: activation.activatedAt?.toISOString?.() ?? null,
      maintenanceActive: false,
      maintenanceUntil: null
    };
  }

  private mapSingleLicense(key: { purchaserFullName: string; purchaserEmail: string; status: LicenseStatus; activatedAt?: Date | null; maintenanceUntil?: Date | null }) {
    return {
      type: "single",
      status: key.status,
      registeredToName: key.purchaserFullName,
      registeredToEmail: key.purchaserEmail,
      activatedAt: key.activatedAt?.toISOString() ?? null,
      maintenanceActive: this.isMaintenanceActive(key.status, key.maintenanceUntil),
      maintenanceUntil: key.maintenanceUntil?.toISOString() ?? null
    };
  }

  private mapEnterpriseLicense(key: { status: LicenseStatus; maintenanceUntil?: Date | null; tenant: any }, activatedAt?: Date | null) {
    const tenant = key.tenant;
    return {
      type: "enterprise",
      status: key.status,
      registeredToName: tenant.legalName ?? tenant.name,
      registeredToEmail: tenant.contactEmail ?? tenant.billingEmail ?? null,
      activatedAt: activatedAt?.toISOString() ?? null,
      maintenanceActive: this.isMaintenanceActive(key.status, key.maintenanceUntil),
      maintenanceUntil: key.maintenanceUntil?.toISOString() ?? null
    };
  }

  private isMaintenanceActive(status: LicenseStatus, maintenanceUntil?: Date | null) {
    return status === "active" && (!maintenanceUntil || maintenanceUntil.getTime() >= Date.now());
  }

  private mapTenant(tenant: any) {
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      legalName: tenant.legalName,
      organizationNumber: tenant.organizationNumber,
      contactName: tenant.contactName,
      contactEmail: tenant.contactEmail,
      contactPhone: tenant.contactPhone,
      billingEmail: tenant.billingEmail,
      addressLine1: tenant.addressLine1,
      addressLine2: tenant.addressLine2,
      postalCode: tenant.postalCode,
      city: tenant.city,
      country: tenant.country,
      status: tenant.status
    };
  }

  private async mapConfig(profile: any) {
    const decryptedProfile = decryptConfigProfileSecrets(profile);
    const managedPolicy = this.mapManagedPolicy(decryptedProfile.managedPolicy, decryptedProfile);
    const templateCategories = managedPolicy.manageTemplateCategories
      ? await this.templateCategoryCatalog()
      : undefined;
    return compactObject({
      id: decryptedProfile.id,
      name: decryptedProfile.name,
      speechProviderType: decryptedProfile.speechProviderType,
      speechEndpointUrl: decryptedProfile.speechEndpointUrl,
      speechModelName: decryptedProfile.speechModelName,
      speechApiKey: decryptedProfile.speechApiKey,
      privacyControlEnabled: managedPolicy.managePrivacyControl ? decryptedProfile.privacyControlEnabled : undefined,
      piiControlEnabled: managedPolicy.managePIIControl ? decryptedProfile.piiControlEnabled : undefined,
      presidioEndpointUrl: managedPolicy.managePIIControl ? decryptedProfile.presidioEndpointUrl : undefined,
      presidioSecretRef: managedPolicy.managePIIControl ? decryptedProfile.presidioSecretRef : undefined,
      presidioApiKey: managedPolicy.managePIIControl ? decryptedProfile.presidioApiKey : undefined,
      presidioScoreThreshold: managedPolicy.managePIIControl ? decryptedProfile.presidioScoreThreshold : undefined,
      presidioFullPersonNamesOnly: managedPolicy.managePIIControl ? decryptedProfile.presidioFullPersonNamesOnly : undefined,
      presidioDetectPerson: managedPolicy.managePIIControl ? decryptedProfile.presidioDetectPerson : undefined,
      presidioDetectEmail: managedPolicy.managePIIControl ? decryptedProfile.presidioDetectEmail : undefined,
      presidioDetectPhone: managedPolicy.managePIIControl ? decryptedProfile.presidioDetectPhone : undefined,
      presidioDetectLocation: managedPolicy.managePIIControl ? decryptedProfile.presidioDetectLocation : undefined,
      presidioDetectIdentifier: managedPolicy.managePIIControl ? decryptedProfile.presidioDetectIdentifier : undefined,
      privacyReviewProviderType: managedPolicy.managePrivacyReviewProvider ? normalizeOpenAiCompatibleProvider(decryptedProfile.privacyReviewProviderType) : undefined,
      privacyReviewEndpointUrl: managedPolicy.managePrivacyReviewProvider ? decryptedProfile.privacyReviewEndpointUrl : undefined,
      privacyReviewModel: managedPolicy.managePrivacyReviewProvider ? decryptedProfile.privacyReviewModel : undefined,
      privacyReviewApiKey: managedPolicy.managePrivacyReviewProvider ? decryptedProfile.privacyReviewApiKey : undefined,
      privacyPrompt: managedPolicy.managePrivacyPrompt ? decryptedProfile.privacyPrompt : undefined,
      documentGenerationProviderType: normalizeOpenAiCompatibleProvider(decryptedProfile.documentGenerationProviderType),
      documentGenerationEndpointUrl: decryptedProfile.documentGenerationEndpointUrl,
      documentGenerationModel: decryptedProfile.documentGenerationModel,
      documentGenerationApiKey: decryptedProfile.documentGenerationApiKey,
      templateRepositoryUrl: decryptedProfile.templateRepositoryUrl,
      telemetryEndpointUrl: decryptedProfile.telemetryEndpointUrl,
      featureFlags: decryptedProfile.featureFlags,
      allowedProviderRestrictions: decryptedProfile.allowedProviderRestrictions,
      providerProfiles: mobileProviderProfiles(decryptedProfile.providerProfiles),
      templateCategories,
      managedPolicy,
      defaultTemplateId: decryptedProfile.defaultTemplateId
    });
  }

  private async templateCategoryCatalog() {
    const categories = await this.prisma.templateCategory.findMany({
      orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
      select: { slug: true, title: true, icon: true }
    });
    return categories.map((category) => ({
      id: category.slug,
      title: category.title,
      icon: category.icon || "folder"
    }));
  }

  private mapManagedPolicy(policy: unknown, profile?: Record<string, any> | null) {
    const source = isRecord(policy) ? policy : {};
    const overrideValue = firstBoolean(source.allowPolicyOverride, source.allowLocalOverride, source.userMayOverridePolicy);
    const hideSettingsValue = firstBoolean(source.hideSettings, source.hideAppSettings, source.hideSettingsUI);
    const hideRecordingFloatingToolbarValue = firstBoolean(
      source.hideRecordingFloatingToolbar,
      source.hideRecordingToolbar,
      source.hideNewRecordingToolbar,
      source.hideFloatingRecordingToolbar
    );
    const speechChangeValue = firstBoolean(source.userMayChangeSpeechProvider, source.userMayChangeSpeech, source.allowSpeechProviderChange);
    const formatterChangeValue = firstBoolean(source.userMayChangeFormatter, source.userMayChangeDocumentGenerationProvider, source.allowFormatterChange);
    const privacyControlManagedValue = firstBoolean(source.managePrivacyControl, source.privacyControlManaged);
    const privacyControlChangeValue = firstBoolean(source.userMayChangePrivacyControl, source.allowPrivacyControlChange);
    const piiControlManagedValue = firstBoolean(source.managePIIControl, source.piiControlManaged);
    const piiControlChangeValue = firstBoolean(source.userMayChangePIIControl, source.allowPIIControlChange);
    const privacyReviewManagedValue = firstBoolean(source.managePrivacyReviewProvider, source.privacyReviewProviderManaged, source.managePrivacyReview);
    const privacyReviewChangeValue = firstBoolean(source.userMayChangePrivacyReviewProvider, source.userMayChangePrivacyReview, source.allowPrivacyReviewProviderChange);
    const managePrivacyPromptValue = firstBoolean(source.managePrivacyPrompt, source.privacyPromptManaged);
    const manageTemplateCategoriesValue = firstBoolean(source.manageTemplateCategories, source.templateCategoriesManaged);
    const visibleSettingsWhenHidden = normalizeVisibleSettingsWhenHidden(source.visibleSettingsWhenHidden, source.settingsVisibleWhenHidden, source.allowedSettingsWhenHidden);
    return {
      ...source,
      allowPolicyOverride: overrideValue ?? false,
      hideSettings: hideSettingsValue ?? false,
      hideRecordingFloatingToolbar: hideRecordingFloatingToolbarValue ?? false,
      visibleSettingsWhenHidden,
      userMayChangeSpeechProvider: speechChangeValue ?? false,
      userMayChangeFormatter: formatterChangeValue ?? false,
      managePrivacyControl: privacyControlManagedValue ?? profileHasValue(profile, "privacyControlEnabled"),
      userMayChangePrivacyControl: privacyControlChangeValue ?? false,
      managePIIControl: piiControlManagedValue ?? hasManagedPIIPolicyFields(profile),
      userMayChangePIIControl: piiControlChangeValue ?? false,
      managePrivacyReviewProvider: privacyReviewManagedValue ?? hasManagedPrivacyReviewPolicyFields(profile),
      userMayChangePrivacyReviewProvider: privacyReviewChangeValue ?? false,
      managePrivacyPrompt: managePrivacyPromptValue ?? Boolean(profile?.privacyPrompt?.trim()),
      manageTemplateCategories: manageTemplateCategoriesValue ?? true
    };
  }
}

class UnauthorizedActivation extends ForbiddenException {
  constructor() {
    super(mobileError("activation_token_invalid", "Invalid activation token"));
  }
}

export function mobileError(code: string, message: string) {
  return { success: false, error: { code, message } };
}

function compactObject(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => {
    if (value === null || value === undefined || value === "") return false;
    if (Array.isArray(value) && value.length === 0) return false;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) return false;
    return true;
  }));
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

function normalizeOpenAiCompatibleProvider(providerType?: string | null) {
  if (providerType === "openai" || providerType === "vllm") return "openai_compatible";
  return providerType;
}

function mobileProviderProfiles(value: unknown) {
  if (!isRecord(value)) return undefined;

  return compactObject({
    ...value,
    speech: mobileSpeechProviderProfiles(value.speech),
    formatter: mobileFormatterProviderProfiles(value.formatter)
  });
}

function mobileSpeechProviderProfiles(value: unknown) {
  if (!isRecord(value)) return undefined;

  const providers = isRecord(value.providers) ? value.providers : {};
  const selected = stringValue(value.selected);
  const explicitAvailable = stringArray(value.available);
  const available = explicitAvailable.length
    ? explicitAvailable
    : Object.entries(providers)
      .filter(([, provider]) => !isRecord(provider) || provider.enabled !== false)
      .map(([key]) => key);
  const allowed = new Set([...available, selected].filter(Boolean));
  const filteredProviders = Object.fromEntries(Object.entries(providers).filter(([key, provider]) => {
    if (!allowed.has(key)) return false;
    return !isRecord(provider) || provider.enabled !== false;
  }));

  return compactObject({
    ...value,
    selected,
    available: Array.from(allowed),
    providers: filteredProviders
  });
}

function mobileFormatterProviderProfiles(value: unknown) {
  if (!isRecord(value)) return undefined;

  const providers = Array.isArray(value.providers) ? value.providers.filter(isRecord) : [];
  const selectedProviderId = stringValue(value.selectedProviderId);
  const explicitAvailable = stringArray(value.available);
  const availableIds = explicitAvailable.length
    ? explicitAvailable
    : providers.filter((provider) => provider.enabled !== false).map((provider) => stringValue(provider.id)).filter((id): id is string => Boolean(id));
  const allowed = new Set([...availableIds, selectedProviderId].filter(Boolean));
  const filteredProviders = providers.filter((provider) => {
    const id = stringValue(provider.id);
    if (!id || !allowed.has(id)) return false;
    return provider.enabled !== false;
  });

  return compactObject({
    ...value,
    selectedProviderId,
    available: filteredProviders.map((provider) => stringValue(provider.id)).filter((id): id is string => Boolean(id)),
    providers: filteredProviders
  });
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstBoolean(...values: unknown[]) {
  return values.find((value): value is boolean => typeof value === "boolean");
}

const visibleSettingsWhenHiddenValues = new Set([
  "live_transcription_during_recording",
  "audio_source",
  "language",
  "privacy_info",
  "dim_screen_during_recording",
  "recording_floating_toolbar",
  "optimize_openai_recording",
  "privacy_prompt",
  "categories"
]);

function normalizeVisibleSettingsWhenHidden(...values: unknown[]) {
  const raw = values.find(Array.isArray);
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string" && visibleSettingsWhenHiddenValues.has(value));
}
