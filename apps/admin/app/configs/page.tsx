"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ChevronDown, CopyPlus, Loader2, Plus, Save, Settings, ShieldCheck, Trash2 } from "lucide-react";
import { RequireAuth } from "../../components/RequireAuth";
import { EmptyState, FieldLabel, FormSection, IconAction, InfoTip, LoadingPanel, PageHeader, PanelHeader, SidePanel, StatCard } from "../../components/AdminUI";
import { TemplateIcon } from "../../components/TemplateControls";
import { getErrorMessage, useToast } from "../../components/ToastProvider";
import { api } from "../../lib/api";

const helpText = {
  speechProviderType: "Choose where audio is converted to text. On-device and controlled-environment options keep more data under your control. Cloud providers may send audio or transcript content to an external service. Values: local, apple_online, openai, azure, gemini. Gemini is shown as experimental/not-ready until the full flow is approved. Locks app UI when managed.",
  speechEndpointUrl: "Endpoint URL for the selected speech provider. Use this for self-hosted or controlled-environment speech services such as Azure Speech containers or internal gateway routes. Locks app UI when set.",
  speechModelName: "Optional model identifier for speech providers that expose multiple models. Leave unset when the service does not use model names. Locks app UI when set.",
  speechApiKey: "Optional API key for the selected speech provider. Prefer an internal gateway endpoint or tenant-scoped key when possible. If sent to the app, it should be treated as a managed credential.",
  speechServerProcessing: "Enterprise-only saved-recording mode. The iOS app uploads the finished audio to the skrivDET API, where a short-lived isolated job sends it to this managed STT provider and reports percentage progress back to the app. Audio is not written to persistent storage by the API.",
  speechServerProcessingEndpointUrl: "API base URL for isolated speech jobs. The app calls /jobs below this URL with its enterprise activation token. Use the public skrivDET API unless this tenant has a dedicated private API gateway.",
  documentGenerationProviderType: "Choose how skrivDET turns the transcript into a finished note. Add provider profiles manually, then choose the default managed provider. Values exposed here: ollama and openai_compatible. Use OpenAI-compatible for OpenAI, vLLM, and internal OpenAI-compatible gateways. Locks app UI when a managed provider is selected.",
  documentGenerationEndpointUrl: "Endpoint URL for the document-generation provider. Use this for internal gateways, self-hosted providers, or OpenAI-compatible services. Locks app UI when set.",
  documentGenerationModel: "Model identifier used for document generation. Choose the organization-approved model for note formatting. Locks app UI when set.",
  documentGenerationApiKey: "Optional API key for the document-generation provider. Prefer internal gateways or tenant-scoped keys. If sent to the app, it should be treated as a managed credential.",
  managePrivacyControl: "Apply this profile's main privacy-control setting to the app. When on, the app starts from the value below. Example: turn this on when every municipal device should use privacy control by default; leave it off when privacy control is a local team choice.",
  userMayChangePrivacyControl: "Let the user change the main privacy-control switch after the policy is applied. Example: enable this when the organization wants privacy control on by default but allows a clinician, manager, or field worker to turn it off for a specific local workflow.",
  privacyControlEnabled: "The policy value for the main privacy-control switch. On means transcripts pass through privacy protection before document generation. Off means the organization intentionally disables the guardrail for this profile.",
  managePrivacyReviewProvider: "Apply this profile's privacy-review/guardrail provider to the app. When off, the saved provider below is kept in the admin profile but is not sent to devices. Example: leave it off while testing a new privacy gateway; turn it on when devices should actually use it.",
  privacyReviewProviderType: "Choose which provider reviews transcript text for privacy concerns before document generation. Local heuristic stays on the device. Ollama or OpenAI-compatible should point to an approved internal gateway or self-hosted service.",
  privacyReviewEndpointUrl: "Endpoint URL for the privacy-review provider. Use this for internal or self-hosted privacy-review services. Locks app UI when set.",
  privacyReviewModel: "Model identifier used for the privacy-review step. Locks app UI when set.",
  privacyReviewApiKey: "Optional API key for the privacy-review provider. Use this for authenticated OpenAI-compatible privacy gateways or protected Ollama routes.",
  userMayChangePrivacyReviewProvider: "Let the user choose a different privacy-review provider after this policy is applied. Example: keep this off for regulated teams that must use the approved gateway; turn it on for pilots where local heuristic, Ollama, and gateway behavior are being compared.",
  managePrivacyPrompt: "When checked, this profile sends the Personvern prompt below to the app and the app uses that text for privacy review. When unchecked, the text is saved here but not sent, so devices use the built-in prompt or the user's local app setting.",
  privacyPrompt: "Prompt text for privacy review guidance. It is only sent to the app when Use policy Personvern prompt is checked. Example: Ask skrivDET to remove names, phone numbers and sensitive case details before document generation, and to mark uncertainty instead of guessing.",
  managePIIControl: "Apply this profile's Presidio PII analyzer settings to the app. When off, the saved endpoint, score, and detection choices below are not sent to devices. Example: turn it on when Presidio is production-ready; leave it off while the organization is still testing false positives.",
  userMayChangePIIControl: "Let the user change the Presidio PII analyzer switch and analyzer details after the policy is applied. Example: enable this for pilot users who tune thresholds; keep it off when the central Presidio setup must be used consistently.",
  piiControlEnabled: "The policy value for the Presidio PII analyzer. This is the structured detector step inside privacy control. On means Presidio checks for names, email, phone numbers, places, and identifiers according to the options below.",
  presidioEndpointUrl: "Endpoint URL for the Presidio analyzer used for PII detection. Typically an internal or protected service. Locks app UI when set.",
  presidioSecretRef: "Optional backend-side secret reference for Presidio access. Use when Presidio is protected by a gateway or internal auth layer. Partial support; no practical UI lock beyond managed connection.",
  presidioApiKey: "Optional managed Presidio API key. The app sends it as Authorization Bearer, X-API-Key, and apikey for common gateway compatibility.",
  presidioScoreThreshold: "Minimum confidence score from Presidio before a detected entity is treated as PII. Lower values catch more possible PII but may create more false positives. Higher values are stricter but may miss uncertain detections.",
  templateRepositoryUrl: "Catalog URL for centrally managed templates. Enterprise users use this repository to browse and download entitled templates. Locks app UI. Full support.",
  defaultTemplateId: "Optional default template for the tenant. Guides users toward the organization's preferred starting template. Partial support; not strongly enforced yet.",
  manageTemplateCategories: "When checked, the backend sends the central category list and the app shows category names, icons, and order from organization policy. When unchecked, devices keep local category settings.",
  developerMode: "Shows internal testing tools and reusable recordings for provider and formatting validation. Locks app UI. Full support.",
  allowExternalProviders: "When off, the app blocks user-managed external speech and LLM connections outside the managed provider list. Enterprise-managed providers in this profile still work.",
  allowPolicyOverride: "When enabled, the user can temporarily ignore centrally managed provider and privacy settings on this device. When disabled, centrally managed settings stay enforced. Locks app UI. Full support.",
  userMayChangeSpeechProvider: "When enabled, the app starts with the default speech provider from this policy, but the user may switch to another speech provider that is checked as available in the list above. When disabled, the default speech provider is enforced and cannot be changed locally.",
  hideSettings: "When enabled, the iOS app should hide most local settings for managed enterprise users and leave only operational screens such as license status, about, support, and diagnostics. Optional items below can be kept visible/editable.",
  hideRecordingFloatingToolbar: "When enabled, the iOS app removes the floating quick toolbar from the New Recording screen. Use this when users should follow the managed defaults without quick on-screen controls. They can still start recordings and use Settings or policy defaults.",
  visibleSettingsWhenHidden: "Optional visibility exceptions to Hide most app settings. Checked items remain visible in the app even when the rest of Settings is hidden. This does not centrally manage the setting value."
};

type ProviderDefinition = {
  value: string;
  label: string;
  privacy: string;
  endpoint: boolean;
  model: boolean;
  diarization?: boolean;
  ready: boolean;
  iconName: string;
  endpointDefault?: string;
  modelDefault?: string;
};

type SpeechProviderConfig = {
  endpointUrl: string;
  modelName: string;
  apiKey: string;
  speakerDiarizationEnabled: boolean;
  serverProcessingEnabled: boolean;
  serverProcessingEndpointUrl: string;
};

type FormatterProviderProfile = {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  builtIn: boolean;
  endpointUrl: string;
  modelName: string;
  apiKey: string;
  privacyEmphasis: string;
};

const speechProviders: ProviderDefinition[] = [
  { value: "local", label: "Local", privacy: "Safe", endpoint: false, model: false, diarization: false, ready: true, iconName: "iphone" },
  { value: "apple_online", label: "Apple Online", privacy: "Use with caution", endpoint: false, model: false, diarization: false, ready: true, iconName: "appicon:apple" },
  { value: "openai", label: "OpenAI Speech", privacy: "Use with caution", endpoint: true, model: true, diarization: true, ready: true, iconName: "appicon:chatgpt", endpointDefault: "https://api.openai.com/v1", modelDefault: "gpt-4o-transcribe" },
  { value: "azure", label: "Azure / on-prem speech", privacy: "Safe", endpoint: true, model: false, diarization: false, ready: true, iconName: "appicon:azure", endpointDefault: "https://kvasetech.com/stt" },
  { value: "gemini", label: "Gemini Speech", privacy: "Use with caution", endpoint: true, model: true, diarization: false, ready: false, iconName: "appicon:google-gemini", endpointDefault: "https://generativelanguage.googleapis.com", modelDefault: "gemini-live-2.5-flash-preview" }
];

const formatterProviders: ProviderDefinition[] = [
  { value: "apple_intelligence", label: "Apple Intelligence", ready: true, endpoint: false, model: false, privacy: "Safe", iconName: "apple.intelligence" },
  { value: "openai_compatible", label: "OpenAI-compatible", ready: true, endpoint: true, model: true, privacy: "Managed by default", iconName: "server.rack", endpointDefault: "https://kvasetech.com/ollama" },
  { value: "ollama", label: "Ollama", ready: true, endpoint: true, model: true, privacy: "Managed by default", iconName: "appicon:ollama", endpointDefault: "https://kvasetech.com/ollama" }
];

const privacyReviewProviders = [
  { value: "", label: "Not managed", ready: true, privacy: "Local setting kept" },
  { value: "local_heuristic", label: "Local heuristic", ready: true, privacy: "Safe" },
  { value: "openai_compatible", label: "OpenAI-compatible", ready: true, privacy: "Safe only when explicitly approved", endpointDefault: "https://kvasetech.com/ollama" },
  { value: "ollama", label: "Ollama", ready: true, privacy: "Safe only when explicitly approved", endpointDefault: "https://kvasetech.com/ollama" }
];

const hiddenSettingsOptions = [
  { value: "live_transcription_during_recording", label: "Live talegjenkjenning under opptak", description: "Let users change live speech recognition behavior during recording." },
  { value: "audio_source", label: "Lyd kilde", description: "Let users choose the recording input/source when available." },
  { value: "language", label: "Språk", description: "App language - Let users choose the app language locally." },
  { value: "privacy_info", label: "Vis personverninfo", description: "Let users show or hide privacy information in the app." },
  { value: "dim_screen_during_recording", label: "Demp skjermen under opptak", description: "Let users control screen dimming while recording." },
  { value: "recording_floating_toolbar", label: "Flytende opptaksverktøylinje", description: "Let users show or hide the quick toolbar on the New Recording screen." },
  { value: "optimize_openai_recording", label: "Optimalisere OpenAI-opptak", description: "Let users control OpenAI recording optimization options." },
  { value: "privacy_prompt", label: "Personvern prompt", description: "Let users view or adjust the privacy prompt when most settings are hidden." },
  { value: "categories", label: "Kategorier", description: "Let users open category controls. If templateCategories is centrally managed, local editing should still be read-only." }
];

const empty = {
  name: "",
  description: "",
  partnerId: "",
  speechProviderType: "local",
  speechEndpointUrl: "",
  speechModelName: "",
  speechApiKey: "",
  speechDiarizationEnabled: false,
  speechAvailableProviders: ["local", "apple_online", "openai", "azure"],
  speechProviderConfigs: {},
  speechServerProcessingEndpointUrl: "https://api.skrivdet.no/api/v1/speech-processing",
  managePrivacyControl: true,
  privacyControlEnabled: true,
  userMayChangePrivacyControl: false,
  managePIIControl: true,
  piiControlEnabled: true,
  userMayChangePIIControl: false,
  presidioEndpointUrl: "",
  presidioSecretRef: "",
  presidioApiKey: "",
  piiScoreThreshold: "0.70",
  detectEmail: true,
  detectPhone: true,
  detectPerson: true,
  detectLocation: true,
  detectIdentifier: true,
  fullPersonNamesOnly: false,
  privacyReviewProviderType: "local_heuristic",
  privacyReviewEndpointUrl: "",
  privacyReviewModel: "",
  privacyReviewApiKey: "",
  managePrivacyReviewProvider: true,
  privacyPrompt: "",
  documentGenerationProviderType: "",
  documentGenerationEndpointUrl: "",
  documentGenerationModel: "",
  documentGenerationApiKey: "",
  formatterPrivacyEmphasis: "safe",
  selectedFormatterProviderId: "",
  formatterProviders: [],
  templateRepositoryUrl: "https://api.skrivdet.no/api/v1/templates/manifest",
  telemetryEndpointUrl: "",
  developerMode: false,
  allowExternalProviders: false,
  allowPolicyOverride: false,
  hideSettings: false,
  hideRecordingFloatingToolbar: false,
  visibleSettingsWhenHidden: [],
  userMayChangeSpeechProvider: false,
  userMayChangeFormatter: false,
  userMayChangePrivacyReviewProvider: false,
  managePrivacyPrompt: false,
  manageTemplateCategories: true,
  defaultTemplateId: ""
};

type ModelKind = "speech" | "formatter" | "review";
type ModelLookupConfig = {
  providerDomain: string;
  providerType: string;
  endpointUrl: string;
  apiKey: string;
  configProfileId?: string;
  providerProfileId?: string;
};
const SAVED_SECRET_MASK = "********";

export default function ConfigsPage() {
  const [profiles, setProfiles] = useState<any[]>([]);
  const [partners, setPartners] = useState<any[]>([]);
  const [form, setForm] = useState<any>(empty);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cloningId, setCloningId] = useState("");
  const [modelLoading, setModelLoading] = useState("");
  const [modelLoadingKey, setModelLoadingKey] = useState("");
  const [modelOptions, setModelOptions] = useState<Record<ModelKind, string[]>>({ speech: [], formatter: [], review: [] });
  const [modelLookupKeys, setModelLookupKeys] = useState<Record<ModelKind, string>>({ speech: "", formatter: "", review: "" });
  const [editorOpen, setEditorOpen] = useState(false);
  const autoFormatterLookupKey = useRef("");
  const autoReviewLookupKey = useRef("");
  const { notify } = useToast();
  const selectedPrivacyReviewProvider = privacyReviewProviders.find((item) => item.value === form.privacyReviewProviderType);
  const configuredFormatterProviders = currentFormatterProviders(form);
  const selectedFormatterProvider = configuredFormatterProviders.find((provider) => provider.id === form.selectedFormatterProviderId) ?? configuredFormatterProviders[0];
  const enabledSpeechProviders = normalizedSpeechAvailable(form);
  const enabledFormatterProviders = configuredFormatterProviders.filter((provider) => provider.enabled);
  const externalProviderAccessRequired = requiresExternalProviderAccess(form);
  const selectedPartnerName = partners.find((partner) => partner.id === form.partnerId)?.name ?? "Internal";
  const selectedSpeechProviderLabel = speechProviders.find((provider) => provider.value === form.speechProviderType)?.label ?? "Not managed";
  const selectedFormatterProviderLabel = selectedFormatterProvider?.name ?? "Not managed";
  const selectedReviewProviderLabel = form.managePrivacyReviewProvider === false
    ? "Local setting"
    : privacyReviewProviders.find((provider) => provider.value === form.privacyReviewProviderType)?.label ?? "Not managed";
  const privacyPolicyApplied = Boolean(form.managePrivacyControl);
  const privacyPolicyHardOff = privacyPolicyApplied && !form.privacyControlEnabled && !form.userMayChangePrivacyControl;
  const privacySubstepsAvailable = !privacyPolicyHardOff;
  const piiPolicyApplied = privacySubstepsAvailable && Boolean(form.managePIIControl);
  const reviewPolicyApplied = privacySubstepsAvailable && Boolean(form.managePrivacyReviewProvider);
  const privacyPromptPolicyApplied = privacySubstepsAvailable && Boolean(form.managePrivacyPrompt);
  const activePolicySwitches = [
    form.hideSettings,
    form.hideRecordingFloatingToolbar,
    form.allowPolicyOverride,
    form.userMayChangeSpeechProvider,
    form.userMayChangeFormatter,
    privacyPolicyApplied,
    privacyPolicyApplied && form.userMayChangePrivacyControl,
    piiPolicyApplied,
    piiPolicyApplied && form.userMayChangePIIControl,
    reviewPolicyApplied,
    reviewPolicyApplied && form.userMayChangePrivacyReviewProvider,
    privacyPromptPolicyApplied,
    form.manageTemplateCategories,
    ...normalizeVisibleSettingsWhenHidden(form)
  ].filter(Boolean).length;

  async function load() {
    try {
      const [profileData, partnerData] = await Promise.all([api("/admin/config-profiles"), api("/admin/partners")]);
      setProfiles(profileData);
      setPartners(partnerData);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load().catch((err) => notify({ tone: "danger", title: "Could not load profiles", message: getErrorMessage(err) })); }, []);

  useEffect(() => {
    if (!editorOpen) return;
    const formatter = currentFormatterProviders(form).find((provider) => provider.id === form.selectedFormatterProviderId);
    const definition = formatterProviderDefinition(formatter?.type);
    if (!formatter || !formatter.enabled || !definition?.model) {
      autoFormatterLookupKey.current = "";
      resetModelLookup("formatter");
      return;
    }

    const config = modelLookupConfig("formatter");
    if (definition.endpoint && !config.endpointUrl.trim()) {
      autoFormatterLookupKey.current = "";
      resetModelLookup("formatter");
      return;
    }

    const requestKey = modelRequestKey("formatter");
    if (modelLoading === "formatter" || modelLookupKeys.formatter === requestKey || autoFormatterLookupKey.current === requestKey) return;

    const timeout = window.setTimeout(() => {
      autoFormatterLookupKey.current = requestKey;
      lookupModels("formatter", config, { silent: true }).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [editorOpen, form.selectedFormatterProviderId, form.formatterProviders, modelLookupKeys.formatter, modelLoading]);

  useEffect(() => {
    if (!editorOpen) return;
    const providerType = form.privacyReviewProviderType ?? "";
    if (!providerType || providerType === "local_heuristic") {
      autoReviewLookupKey.current = "";
      resetModelLookup("review");
      return;
    }

    const config = modelLookupConfig("review");
    if (!config.endpointUrl.trim()) {
      autoReviewLookupKey.current = "";
      resetModelLookup("review");
      return;
    }

    const requestKey = modelRequestKey("review");
    if (modelLoading === "review" || modelLookupKeys.review === requestKey || autoReviewLookupKey.current === requestKey) return;

    const timeout = window.setTimeout(() => {
      autoReviewLookupKey.current = requestKey;
      lookupModels("review", config, { silent: true }).catch(() => undefined);
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [editorOpen, form.privacyReviewProviderType, form.privacyReviewEndpointUrl, form.privacyReviewApiKey, modelLookupKeys.review, modelLoading]);

  const stats = useMemo(() => ({
    total: profiles.length,
    speechManaged: profiles.filter((profile) => profile.speechProviderType).length,
    privacyEnabled: profiles.filter((profile) => profile.privacyControlEnabled).length,
    safeReview: profiles.filter((profile) => ["local_heuristic", "ollama", "openai_compatible"].includes(profile.privacyReviewProviderType)).length
  }), [profiles]);

  function edit(profile: any) {
    const providerProfiles = profile.providerProfiles ?? {};
    const managedPolicy = profile.managedPolicy ?? {};
    const speechProviderType = speechProviders.some((provider) => provider.ready && provider.value === profile.speechProviderType)
      ? profile.speechProviderType
      : "";
    const documentGenerationProviderType = normalizeFormatterProviderType(profile.documentGenerationProviderType ?? "");
    const privacyReviewProviderType = normalizeReviewProviderType(profile.privacyReviewProviderType ?? "");
    const speechProviderConfigs = speechConfigFromProfile(profile, providerProfiles);
    const speechAvailableProviders = providerProfiles?.speech?.available?.length
      ? providerProfiles.speech.available
      : speechProviderType
        ? [speechProviderType]
        : [];
    const formatterProfiles = formatterProfilesFromProfile(profile, providerProfiles);
    const selectedFormatterProviderId = providerProfiles?.formatter?.selectedProviderId
      ?? formatterProfiles.find((provider) => provider.type === documentGenerationProviderType && provider.endpointUrl === (profile.documentGenerationEndpointUrl ?? ""))?.id
      ?? formatterProfiles.find((provider) => provider.enabled)?.id
      ?? "";
    setSelected(profile.id);
    setForm({
      ...empty,
      ...profile,
      partnerId: profile.partnerId ?? "",
      speechProviderType,
      speechProviderConfigs,
      speechAvailableProviders,
      documentGenerationProviderType,
      privacyReviewProviderType,
      speechApiKey: profile.speechApiKey ? SAVED_SECRET_MASK : "",
      presidioApiKey: profile.presidioApiKey ? SAVED_SECRET_MASK : "",
      documentGenerationApiKey: profile.documentGenerationApiKey ? SAVED_SECRET_MASK : "",
      privacyReviewApiKey: profile.privacyReviewApiKey ? SAVED_SECRET_MASK : "",
      privacyPrompt: profile.privacyPrompt ?? "",
      managePrivacyControl: managedPolicy?.managePrivacyControl ?? managedPolicy?.privacyControlManaged ?? profileHasValue(profile, "privacyControlEnabled"),
      privacyControlEnabled: profile.privacyControlEnabled ?? true,
      userMayChangePrivacyControl: managedPolicy?.userMayChangePrivacyControl ?? managedPolicy?.allowPrivacyControlChange ?? false,
      managePIIControl: managedPolicy?.managePIIControl ?? managedPolicy?.piiControlManaged ?? hasManagedPIIPolicyFields(profile),
      piiControlEnabled: profile.piiControlEnabled ?? true,
      userMayChangePIIControl: managedPolicy?.userMayChangePIIControl ?? managedPolicy?.allowPIIControlChange ?? false,
      speechDiarizationEnabled: providerProfiles?.speech?.speakerDiarizationEnabled ?? false,
      piiScoreThreshold: String(profile.presidioScoreThreshold ?? providerProfiles?.presidio?.scoreThreshold ?? "0.70"),
      detectEmail: profile.presidioDetectEmail ?? providerProfiles?.presidio?.detectEmail ?? true,
      detectPhone: profile.presidioDetectPhone ?? providerProfiles?.presidio?.detectPhone ?? true,
      detectPerson: profile.presidioDetectPerson ?? providerProfiles?.presidio?.detectPerson ?? true,
      detectLocation: profile.presidioDetectLocation ?? providerProfiles?.presidio?.detectLocation ?? true,
      detectIdentifier: profile.presidioDetectIdentifier ?? providerProfiles?.presidio?.detectIdentifier ?? true,
      fullPersonNamesOnly: profile.presidioFullPersonNamesOnly ?? providerProfiles?.presidio?.fullPersonNamesOnly ?? false,
      formatterPrivacyEmphasis: providerProfiles?.formatter?.privacyEmphasis ?? "managed",
      formatterProviders: formatterProfiles,
      selectedFormatterProviderId,
      developerMode: profile.featureFlags?.developerMode ?? false,
      allowExternalProviders: profile.featureFlags?.allowExternalProviders ?? false,
      allowPolicyOverride: managedPolicy?.allowPolicyOverride ?? managedPolicy?.allowLocalOverride ?? managedPolicy?.userMayOverridePolicy ?? false,
      hideSettings: managedPolicy?.hideSettings ?? managedPolicy?.hideAppSettings ?? managedPolicy?.hideSettingsUI ?? false,
      hideRecordingFloatingToolbar: managedPolicy?.hideRecordingFloatingToolbar ?? managedPolicy?.hideRecordingToolbar ?? managedPolicy?.hideNewRecordingToolbar ?? managedPolicy?.hideFloatingRecordingToolbar ?? false,
      visibleSettingsWhenHidden: normalizeVisibleSettingsWhenHidden(managedPolicy),
      userMayChangeSpeechProvider: managedPolicy?.userMayChangeSpeechProvider ?? false,
      userMayChangeFormatter: managedPolicy?.userMayChangeFormatter ?? false,
      managePrivacyReviewProvider: managedPolicy?.managePrivacyReviewProvider ?? managedPolicy?.privacyReviewProviderManaged ?? managedPolicy?.managePrivacyReview ?? hasManagedPrivacyReviewPolicyFields(profile),
      userMayChangePrivacyReviewProvider: managedPolicy?.userMayChangePrivacyReviewProvider ?? false,
      managePrivacyPrompt: managedPolicy?.managePrivacyPrompt ?? managedPolicy?.privacyPromptManaged ?? Boolean(profile.privacyPrompt?.trim()),
      manageTemplateCategories: managedPolicy?.manageTemplateCategories ?? managedPolicy?.templateCategoriesManaged ?? true,
      defaultTemplateId: profile.defaultTemplateId ?? ""
    });
    setModelOptions({ speech: [], formatter: [], review: [] });
    setModelLookupKeys({ speech: "", formatter: "", review: "" });
    setEditorOpen(true);
  }

  function createNew() {
    setSelected("");
    setForm(empty);
    setModelOptions({ speech: [], formatter: [], review: [] });
    setModelLookupKeys({ speech: "", formatter: "", review: "" });
    setEditorOpen(true);
  }

  function resetModelLookup(kind: ModelKind) {
    setModelOptions((current) => ({ ...current, [kind]: [] }));
    setModelLookupKeys((current) => ({ ...current, [kind]: "" }));
  }

  function refreshModelsForNextForm(kind: ModelKind, nextForm: any, shouldLookup: boolean) {
    resetModelLookup(kind);
    if (!shouldLookup) return;
    const config = modelLookupConfig(kind, nextForm);
    window.setTimeout(() => {
      lookupModels(kind, config, { silent: true }).catch(() => undefined);
    }, 0);
  }

  function applyProviderDefault(kind: "speech" | "formatter" | "review", value: string) {
    if (kind === "speech") {
      const provider = speechProviders.find((item) => item.value === value);
      const next = {
        ...form,
        speechProviderType: value,
        speechEndpointUrl: provider?.endpoint ? provider.endpointDefault ?? form.speechEndpointUrl : "",
        speechModelName: provider?.model ? providerDefaultModel(provider) : "",
        speechApiKey: provider?.endpoint ? form.speechApiKey : "",
        speechDiarizationEnabled: value === "openai" ? form.speechDiarizationEnabled : false
      };
      setForm(next);
      refreshModelsForNextForm("speech", next, Boolean(provider?.model));
      return;
    }
    if (kind === "formatter") {
      const provider = formatterProviders.find((item) => item.value === value);
      const next = {
        ...form,
        documentGenerationProviderType: value,
        documentGenerationEndpointUrl: provider?.endpoint ? provider.endpointDefault ?? form.documentGenerationEndpointUrl : "",
        documentGenerationModel: provider?.model ? providerDefaultModel(provider) : "",
        documentGenerationApiKey: provider?.endpoint ? form.documentGenerationApiKey : "",
        formatterPrivacyEmphasis: formatterPrivacyDefault(value, form.formatterPrivacyEmphasis)
      };
      setForm(next);
      refreshModelsForNextForm("formatter", next, Boolean(provider?.model));
      return;
    }
    const provider = privacyReviewProviders.find((item) => item.value === value);
    const canUseRemoteReview = Boolean(value && value !== "local_heuristic");
    const next = {
      ...form,
      privacyReviewProviderType: value,
      privacyReviewEndpointUrl: canUseRemoteReview ? provider?.endpointDefault ?? form.privacyReviewEndpointUrl : "",
      privacyReviewModel: canUseRemoteReview ? providerDefaultModel(provider) : "",
      privacyReviewApiKey: canUseRemoteReview ? form.privacyReviewApiKey : "",
    };
    setForm(next);
    refreshModelsForNextForm("review", next, canUseRemoteReview);
  }

  function toggleHiddenSetting(value: string, checked: boolean) {
    const current = new Set(normalizeVisibleSettingsWhenHidden(form));
    if (checked) current.add(value);
    else current.delete(value);
    const next = hiddenSettingsOptions.map((option) => option.value).filter((optionValue) => current.has(optionValue));
    setForm({ ...form, visibleSettingsWhenHidden: next });
  }

  function modelLookupConfig(kind: ModelKind, source = form): ModelLookupConfig {
    const speechConfig = speechProviderConfig(source, source.speechProviderType);
    const formatter = currentFormatterProviders(source).find((provider) => provider.id === source.selectedFormatterProviderId) ?? currentFormatterProviders(source)[0];
    return {
      speech: {
        providerDomain: "speech",
        providerType: source.speechProviderType ?? "",
        endpointUrl: speechConfig.endpointUrl ?? "",
        apiKey: speechConfig.apiKey ?? "",
        configProfileId: selected || undefined,
        providerProfileId: source.speechProviderType || undefined
      },
      formatter: formatterModelLookupConfig(formatter),
      review: {
        providerDomain: "privacy_review",
        providerType: source.privacyReviewProviderType ?? "",
        endpointUrl: source.privacyReviewEndpointUrl ?? "",
        apiKey: source.privacyReviewApiKey ?? "",
        configProfileId: selected || undefined
      }
    }[kind];
  }

  function formatterModelLookupConfig(provider?: FormatterProviderProfile): ModelLookupConfig {
    return {
      providerDomain: "document_generation",
      providerType: provider?.type ?? "",
      endpointUrl: provider?.endpointUrl ?? "",
      apiKey: provider?.apiKey ?? "",
      configProfileId: selected || undefined,
      providerProfileId: provider?.id || undefined
    };
  }

  function modelRequestKey(kind: ModelKind, source = form) {
    return modelRequestKeyFromConfig(modelLookupConfig(kind, source));
  }

  function modelRequestKeyFromConfig(config: ModelLookupConfig) {
    return [
      config.providerDomain,
      config.providerType,
      config.endpointUrl,
      keyFingerprint(config.apiKey),
      config.configProfileId ?? "",
      config.providerProfileId ?? ""
    ].join("|");
  }

  async function lookupModels(kind: ModelKind, config = modelLookupConfig(kind), options: { silent?: boolean } = {}) {
    const requestKey = modelRequestKeyFromConfig(config);
    if ((modelLoading === kind && modelLoadingKey === requestKey) || modelLookupKeys[kind] === requestKey) return;
    if (!config.providerType) {
      if (!options.silent) notify({ tone: "info", title: "No provider selected", message: "Choose a managed provider before loading models." });
      return;
    }
    setModelLoading(kind);
    setModelLoadingKey(requestKey);
    try {
      const response = await api("/admin/provider-models", { method: "POST", body: JSON.stringify(config) });
      const models = (response.models ?? []).map((model: any) => model.id ?? model.name).filter(Boolean);
      setModelOptions((current) => ({ ...current, [kind]: models }));
      setModelLookupKeys((current) => ({ ...current, [kind]: requestKey }));
    } catch (err: any) {
      if (!options.silent) notify({ tone: "danger", title: "Could not load models", message: getErrorMessage(err) });
    } finally {
      setModelLoading("");
      setModelLoadingKey("");
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const speechAvailableProviders = normalizedSpeechAvailable(form);
      const formatterProfiles = currentFormatterProviders(form);
      const enabledFormatterProfiles = formatterProfiles.filter((provider) => provider.enabled);
      const selectedSpeechConfig = speechProviderConfig(form, form.speechProviderType);
      const selectedFormatter = formatterProfiles.find((provider) => provider.id === form.selectedFormatterProviderId && provider.enabled) ?? enabledFormatterProfiles[0] ?? null;
      const selectedFormatterDefinition = selectedFormatter ? formatterProviders.find((item) => item.value === selectedFormatter.type) : null;
      const privacySubstepsAvailable = !(form.managePrivacyControl && !form.privacyControlEnabled && !form.userMayChangePrivacyControl);
      const allowedProviderRestrictions = Array.from(new Set([
        ...speechAvailableProviders,
        ...enabledFormatterProfiles.map((provider) => provider.type),
        privacySubstepsAvailable && form.managePrivacyReviewProvider ? form.privacyReviewProviderType : ""
      ].filter(Boolean)));
      const allowExternalProviders = Boolean(form.allowExternalProviders || requiresExternalProviderAccess({ speechAvailableProviders }));
      const featureFlags = {
        developerMode: Boolean(form.developerMode),
        allowExternalProviders
      };
      const providerProfiles = {
        speech: {
          selected: form.speechProviderType || null,
          available: speechAvailableProviders,
          providers: Object.fromEntries(speechProviders.map((provider) => {
            const config = speechProviderConfig(form, provider.value);
            return [provider.value, {
              type: provider.value,
              name: provider.label,
              enabled: speechAvailableProviders.includes(provider.value),
              endpointUrl: provider.endpoint ? config.endpointUrl || null : null,
              modelName: provider.model ? config.modelName || null : null,
              apiKey: provider.endpoint ? config.apiKey || null : null,
              speakerDiarizationEnabled: provider.diarization ? Boolean(config.speakerDiarizationEnabled) : false,
              serverProcessingEnabled: provider.endpoint ? Boolean(config.serverProcessingEnabled) : false,
              serverProcessingEndpointUrl: provider.endpoint && config.serverProcessingEnabled ? config.serverProcessingEndpointUrl || null : null,
              privacyClass: provider.privacy,
              ready: provider.ready
            }];
          }))
        },
        formatter: {
          selected: selectedFormatter?.type || null,
          selectedProviderId: selectedFormatter?.id || null,
          available: enabledFormatterProfiles.map((provider) => provider.id),
          privacyEmphasis: selectedFormatter?.privacyEmphasis ?? form.formatterPrivacyEmphasis,
          providers: formatterProfiles.map((provider) => ({
            id: provider.id,
            name: provider.name,
            type: provider.type,
            enabled: Boolean(provider.enabled),
            builtIn: false,
            endpointUrl: formatterProviderDefinition(provider.type)?.endpoint ? provider.endpointUrl || null : null,
            modelName: formatterProviderDefinition(provider.type)?.model ? provider.modelName || null : null,
            apiKey: formatterProviderDefinition(provider.type)?.endpoint ? provider.apiKey || null : null,
            privacyEmphasis: provider.privacyEmphasis,
            privacyClass: formatterProviderDefinition(provider.type)?.privacy ?? null
          })),
          privacyClass: selectedFormatterDefinition?.privacy ?? null
        },
      };
      const managedPolicy = {
        allowPolicyOverride: Boolean(form.allowPolicyOverride),
        hideSettings: Boolean(form.hideSettings),
        hideRecordingFloatingToolbar: Boolean(form.hideRecordingFloatingToolbar),
        visibleSettingsWhenHidden: normalizeVisibleSettingsWhenHidden(form),
        userMayChangeSpeechProvider: Boolean(form.userMayChangeSpeechProvider),
        userMayChangeFormatter: Boolean(form.userMayChangeFormatter),
        managePrivacyControl: Boolean(form.managePrivacyControl),
        userMayChangePrivacyControl: Boolean(form.managePrivacyControl && form.userMayChangePrivacyControl),
        managePIIControl: Boolean(privacySubstepsAvailable && form.managePIIControl),
        userMayChangePIIControl: Boolean(privacySubstepsAvailable && form.managePIIControl && form.userMayChangePIIControl),
        managePrivacyReviewProvider: Boolean(privacySubstepsAvailable && form.managePrivacyReviewProvider),
        userMayChangePrivacyReviewProvider: Boolean(privacySubstepsAvailable && form.managePrivacyReviewProvider && form.userMayChangePrivacyReviewProvider),
        managePrivacyPrompt: Boolean(privacySubstepsAvailable && form.managePrivacyPrompt),
        manageTemplateCategories: Boolean(form.manageTemplateCategories)
      };
      const speechProvider = speechProviders.find((item) => item.value === form.speechProviderType);
      const reviewProvider = privacyReviewProviders.find((item) => item.value === form.privacyReviewProviderType);
      const payload = {
        name: form.name,
        description: form.description,
        partnerId: form.partnerId || null,
        speechProviderType: form.speechProviderType || null,
        speechEndpointUrl: speechProvider?.endpoint ? selectedSpeechConfig.endpointUrl || null : null,
        speechModelName: speechProvider?.model ? selectedSpeechConfig.modelName || null : null,
        speechApiKey: selected && selectedSpeechConfig.apiKey === SAVED_SECRET_MASK ? undefined : speechProvider?.endpoint ? selectedSpeechConfig.apiKey || null : null,
        privacyControlEnabled: Boolean(form.privacyControlEnabled),
        piiControlEnabled: Boolean(form.piiControlEnabled),
        presidioEndpointUrl: form.presidioEndpointUrl || null,
        presidioSecretRef: form.presidioSecretRef || null,
        presidioApiKey: selected && form.presidioApiKey === SAVED_SECRET_MASK ? undefined : form.presidioApiKey || null,
        presidioScoreThreshold: Number(form.piiScoreThreshold || 0.7),
        presidioFullPersonNamesOnly: Boolean(form.fullPersonNamesOnly),
        presidioDetectPerson: Boolean(form.detectPerson),
        presidioDetectEmail: Boolean(form.detectEmail),
        presidioDetectPhone: Boolean(form.detectPhone),
        presidioDetectLocation: Boolean(form.detectLocation),
        presidioDetectIdentifier: Boolean(form.detectIdentifier),
        privacyReviewProviderType: form.privacyReviewProviderType || null,
        privacyReviewEndpointUrl: reviewProvider && form.privacyReviewProviderType !== "local_heuristic" ? form.privacyReviewEndpointUrl || null : null,
        privacyReviewModel: reviewProvider && form.privacyReviewProviderType !== "local_heuristic" ? form.privacyReviewModel || null : null,
        privacyReviewApiKey: selected && form.privacyReviewApiKey === SAVED_SECRET_MASK ? undefined : reviewProvider && form.privacyReviewProviderType !== "local_heuristic" ? form.privacyReviewApiKey || null : null,
        privacyPrompt: form.privacyPrompt || null,
        documentGenerationProviderType: selectedFormatter?.type || null,
        documentGenerationEndpointUrl: selectedFormatterDefinition?.endpoint ? selectedFormatter.endpointUrl || null : null,
        documentGenerationModel: selectedFormatterDefinition?.model ? selectedFormatter.modelName || null : null,
        documentGenerationApiKey: selected && selectedFormatter?.apiKey === SAVED_SECRET_MASK ? undefined : selectedFormatterDefinition?.endpoint ? selectedFormatter?.apiKey || null : null,
        templateRepositoryUrl: form.templateRepositoryUrl || null,
        telemetryEndpointUrl: form.telemetryEndpointUrl || null,
        featureFlags,
        allowedProviderRestrictions,
        providerProfiles,
        managedPolicy,
        defaultTemplateId: form.defaultTemplateId || null
      };

      await api(selected ? `/admin/config-profiles/${selected}` : "/admin/config-profiles", { method: selected ? "PATCH" : "POST", body: JSON.stringify(payload) });
      notify({ tone: "success", title: selected ? "Profile updated" : "Profile created" });
      setSelected("");
      setForm(empty);
      setEditorOpen(false);
      await load();
    } catch (err: any) {
      notify({ tone: "danger", title: "Could not save profile", message: getErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  async function deleteProfile(profile: any) {
    if (!window.confirm(`Delete ${profile.name}? This cannot be undone.`)) return;
    try {
      await api(`/admin/config-profiles/${profile.id}`, { method: "DELETE" });
      if (selected === profile.id) {
        setSelected("");
        setForm(empty);
        setEditorOpen(false);
      }
      notify({ tone: "success", title: "Profile deleted" });
      await load();
    } catch (err: any) {
      notify({ tone: "danger", title: "Could not delete profile", message: getErrorMessage(err) });
    }
  }

  async function cloneProfile(profile: any) {
    setCloningId(profile.id);
    try {
      const cloned = await api(`/admin/config-profiles/${profile.id}/clone`, {
        method: "POST",
        body: JSON.stringify({ name: `Copy of ${profile.name}` })
      });
      notify({ tone: "success", title: "Profile cloned", message: `${profile.name} was copied.` });
      await load();
      edit(cloned);
    } catch (err: any) {
      notify({ tone: "danger", title: "Could not clone profile", message: getErrorMessage(err) });
    } finally {
      setCloningId("");
    }
  }

  function toggleSpeechProvider(providerValue: string, enabled: boolean) {
    if (!speechProviders.find((provider) => provider.value === providerValue)?.ready) return;
    const current = normalizedSpeechAvailable(form);
    const nextAvailable = enabled ? Array.from(new Set([...current, providerValue])) : current.filter((value: string) => value !== providerValue);
    const nextDefault = nextAvailable.includes(form.speechProviderType) ? form.speechProviderType : nextAvailable[0] ?? "";
    const provider = speechProviders.find((item) => item.value === nextDefault);
    const config = speechProviderConfig(form, nextDefault);
    setForm({
      ...form,
      speechAvailableProviders: nextAvailable,
      speechProviderType: nextDefault,
      speechEndpointUrl: provider?.endpoint ? config.endpointUrl : "",
      speechModelName: provider?.model ? config.modelName : "",
      speechApiKey: provider?.endpoint ? config.apiKey : "",
      speechDiarizationEnabled: provider?.diarization ? config.speakerDiarizationEnabled : false
    });
  }

  function setSpeechDefault(providerValue: string) {
    const provider = speechProviders.find((item) => item.value === providerValue);
    if (!provider?.ready) return;
    const config = speechProviderConfig(form, providerValue);
    setForm({
      ...form,
      speechAvailableProviders: Array.from(new Set([...normalizedSpeechAvailable(form), providerValue])),
      speechProviderType: providerValue,
      speechEndpointUrl: provider?.endpoint ? config.endpointUrl : "",
      speechModelName: provider?.model ? config.modelName : "",
      speechApiKey: provider?.endpoint ? config.apiKey : "",
      speechDiarizationEnabled: provider?.diarization ? config.speakerDiarizationEnabled : false
    });
    refreshModelsForNextForm("speech", { ...form, speechProviderType: providerValue, speechProviderConfigs: form.speechProviderConfigs }, Boolean(provider?.model));
  }

  function updateSpeechConfig(providerValue: string, patch: Partial<SpeechProviderConfig>) {
    const current = speechProviderConfig(form, providerValue);
    const normalizedPatch = { ...patch };
    if (typeof normalizedPatch.modelName === "string" && providerValue === "openai") {
      normalizedPatch.speakerDiarizationEnabled = normalizedPatch.modelName.toLowerCase().includes("diarize");
    }
    const nextConfigs = {
      ...(form.speechProviderConfigs ?? {}),
      [providerValue]: { ...current, ...normalizedPatch }
    };
    const next = { ...form, speechProviderConfigs: nextConfigs };
    if (form.speechProviderType === providerValue) {
      const provider = speechProviders.find((item) => item.value === providerValue);
      const nextConfig = nextConfigs[providerValue];
      Object.assign(next, {
        speechEndpointUrl: provider?.endpoint ? nextConfig.endpointUrl : "",
        speechModelName: provider?.model ? nextConfig.modelName : "",
        speechApiKey: provider?.endpoint ? nextConfig.apiKey : "",
        speechDiarizationEnabled: provider?.diarization ? nextConfig.speakerDiarizationEnabled : false
      });
    }
    setForm(next);
  }

  function toggleFormatterProvider(providerId: string, enabled: boolean) {
    const profiles = currentFormatterProviders(form).map((provider) => provider.id === providerId ? { ...provider, enabled } : provider);
    const selectedStillEnabled = profiles.some((provider) => provider.id === form.selectedFormatterProviderId && provider.enabled);
    const nextSelected = selectedStillEnabled ? form.selectedFormatterProviderId : profiles.find((provider) => provider.enabled)?.id ?? profiles[0]?.id ?? "";
    const selectedProvider = profiles.find((provider) => provider.id === nextSelected);
    setForm({
      ...form,
      formatterProviders: profiles,
      selectedFormatterProviderId: nextSelected,
      documentGenerationProviderType: selectedProvider?.type ?? "",
      documentGenerationEndpointUrl: selectedProvider?.endpointUrl ?? "",
      documentGenerationModel: selectedProvider?.modelName ?? "",
      documentGenerationApiKey: selectedProvider?.apiKey ?? "",
      formatterPrivacyEmphasis: selectedProvider?.privacyEmphasis ?? form.formatterPrivacyEmphasis
    });
  }

  function setFormatterDefault(providerId: string) {
    const profiles = currentFormatterProviders(form).map((provider) => provider.id === providerId ? { ...provider, enabled: true } : provider);
    const selectedProvider = profiles.find((provider) => provider.id === providerId);
    const next = {
      ...form,
      formatterProviders: profiles,
      selectedFormatterProviderId: providerId,
      documentGenerationProviderType: selectedProvider?.type ?? "",
      documentGenerationEndpointUrl: selectedProvider?.endpointUrl ?? "",
      documentGenerationModel: selectedProvider?.modelName ?? "",
      documentGenerationApiKey: selectedProvider?.apiKey ?? "",
      formatterPrivacyEmphasis: selectedProvider?.privacyEmphasis ?? form.formatterPrivacyEmphasis
    };
    setForm(next);
    refreshModelsForNextForm("formatter", next, Boolean(formatterProviderDefinition(selectedProvider?.type)?.model));
  }

  function lookupFormatterModels(provider: FormatterProviderProfile) {
    const definition = formatterProviderDefinition(provider.type);
    if (!definition?.model) {
      resetModelLookup("formatter");
      return;
    }
    const config = formatterModelLookupConfig(provider);
    if (definition.endpoint && !config.endpointUrl.trim()) {
      resetModelLookup("formatter");
      return;
    }
    lookupModels("formatter", config, { silent: true }).catch(() => undefined);
  }

  function updateFormatterProvider(providerId: string, patch: Partial<FormatterProviderProfile>) {
    const profiles = currentFormatterProviders(form).map((provider) => provider.id === providerId ? { ...provider, ...patch } : provider);
    const selectedProvider = profiles.find((provider) => provider.id === form.selectedFormatterProviderId);
    setForm({
      ...form,
      formatterProviders: profiles,
      documentGenerationProviderType: selectedProvider?.type ?? "",
      documentGenerationEndpointUrl: selectedProvider?.endpointUrl ?? "",
      documentGenerationModel: selectedProvider?.modelName ?? "",
      documentGenerationApiKey: selectedProvider?.apiKey ?? "",
      formatterPrivacyEmphasis: selectedProvider?.privacyEmphasis ?? form.formatterPrivacyEmphasis
    });
  }

  function addFormatterProvider() {
    const id = `custom-${Date.now().toString(36)}`;
    const profile: FormatterProviderProfile = {
      id,
      name: "New provider",
      type: "openai_compatible",
      enabled: true,
      builtIn: false,
      endpointUrl: "https://kvasetech.com/ollama",
      modelName: "",
      apiKey: "",
      privacyEmphasis: "managed"
    };
    setForm({
      ...form,
      formatterProviders: [...currentFormatterProviders(form), profile],
      selectedFormatterProviderId: id,
      documentGenerationProviderType: profile.type,
      documentGenerationEndpointUrl: profile.endpointUrl,
      documentGenerationModel: profile.modelName,
      documentGenerationApiKey: profile.apiKey,
      formatterPrivacyEmphasis: profile.privacyEmphasis
    });
  }

  function removeFormatterProvider(providerId: string) {
    const profiles = currentFormatterProviders(form).filter((provider) => provider.id !== providerId);
    const nextSelected = profiles.some((provider) => provider.id === form.selectedFormatterProviderId) ? form.selectedFormatterProviderId : profiles.find((provider) => provider.enabled)?.id ?? profiles[0]?.id ?? "";
    const selectedProvider = profiles.find((provider) => provider.id === nextSelected);
    setForm({
      ...form,
      formatterProviders: profiles,
      selectedFormatterProviderId: nextSelected,
      documentGenerationProviderType: selectedProvider?.type ?? "",
      documentGenerationEndpointUrl: selectedProvider?.endpointUrl ?? "",
      documentGenerationModel: selectedProvider?.modelName ?? "",
      documentGenerationApiKey: selectedProvider?.apiKey ?? "",
      formatterPrivacyEmphasis: selectedProvider?.privacyEmphasis ?? form.formatterPrivacyEmphasis
    });
  }

  return (
    <RequireAuth>
      <PageHeader title="Config profiles" description="Enterprise app settings with speech, formatter, Presidio and privacy review kept as separate provider domains." />
      {loading ? <LoadingPanel label="Loading config profiles" /> : (
        <>
          <div className="page-stack">
            <div className="grid four">
              <StatCard label="Profiles" value={stats.total} icon={<Settings size={18} />} sub="enterprise configs" />
              <StatCard label="Speech managed" value={stats.speechManaged} icon={<Settings size={18} />} sub="selected centrally" />
              <StatCard label="Privacy enabled" value={stats.privacyEnabled} icon={<ShieldCheck size={18} />} sub="guardrail master toggle" />
              <StatCard label="Safe review" value={stats.safeReview} icon={<ShieldCheck size={18} />} sub="eligible providers" />
            </div>

            <div className="panel">
              <PanelHeader title="Configuration profiles" description="List first. Open a profile to edit provider selections and policy in a slide-in panel." actions={<IconAction label="New profile" tone="primary" onClick={createNew}><Plus size={16} /></IconAction>} />
              {!profiles.length ? <EmptyState title="No config profiles" message="Create the first profile before generating enterprise keys." /> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Partner</th>
                        <th>Speech model</th>
                        <th>Formatter model</th>
                        <th>Privacy model</th>
                        <th className="actions">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {profiles.map((profile) => (
                        <tr key={profile.id} className="clickable-row" onDoubleClick={() => edit(profile)}>
                          <td><b>{profile.name}</b><br /><span className="muted">{profile.description || "No description"}</span></td>
                          <td>{profile.partner?.name ?? <span className="muted">Internal</span>}</td>
                          <td><ModelSummary {...speechModelSummary(profile)} /></td>
                          <td><ModelSummary {...formatterModelSummary(profile)} /></td>
                          <td><ModelSummary {...privacyReviewModelSummary(profile)} /></td>
                          <td className="row actions">
                            <IconAction label="Edit profile" onClick={() => edit(profile)}><Settings size={14} /></IconAction>
                            <IconAction label="Clone profile" onClick={() => cloneProfile(profile)} disabled={cloningId === profile.id}><CopyPlus size={14} /></IconAction>
                            <IconAction label="Delete profile" tone="danger" onClick={() => deleteProfile(profile)}><Trash2 size={14} /></IconAction>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <SidePanel
            open={editorOpen}
            wide
            title={selected ? "Edit Config Profile" : "Create Config Profile"}
            description="Only fields set here are sent in the mobile config. Provider-profile metadata is stored for backend/admin policy."
            onClose={() => !saving && setEditorOpen(false)}
            footer={<><button type="button" className="button secondary" onClick={() => setEditorOpen(false)} disabled={saving}>Cancel</button><button type="submit" form="config-editor-form" className="button" disabled={saving}><Save size={16} /> {saving ? "Saving..." : "Save profile"}</button></>}
          >
            <form id="config-editor-form" onSubmit={save} className="config-editor-form">
              <div className="config-editor-hero">
                <div>
                  <span className="config-editor-kicker">Enterprise policy</span>
                  <h3>{form.name || "Untitled config profile"}</h3>
                  <p>{form.description || "Define the effective provider, privacy, repository, and device behavior policy returned to enterprise activations."}</p>
                </div>
                <div className="config-editor-hero-meta">
                  <span><strong>{selectedPartnerName}</strong>Owner</span>
                  <span><strong>{enabledSpeechProviders.length}</strong>Speech providers</span>
                  <span><strong>{enabledFormatterProviders.length}</strong>Formatters</span>
                  <span><strong>{activePolicySwitches}</strong>Policy switches</span>
                </div>
              </div>

              <div className="config-workbench">
                <aside className="config-outline" aria-label="Config profile sections">
                  <div className="config-outline-title">
                    <span>Profile map</span>
                    <small>Click a section to jump.</small>
                  </div>
                  <a href="#config-profile-section" className="config-outline-item">
                    <span className="config-outline-number">1</span>
                    <span><strong>Profile</strong><small>{selectedPartnerName}</small></span>
                  </a>
                  <a href="#config-speech-section" className="config-outline-item">
                    <span className="config-outline-number">2</span>
                    <span><strong>Speech</strong><small>{selectedSpeechProviderLabel}</small></span>
                  </a>
                  <a href="#config-formatter-section" className="config-outline-item">
                    <span className="config-outline-number">3</span>
                    <span><strong>Document generation</strong><small>{selectedFormatterProviderLabel}</small></span>
                  </a>
                  <a href="#config-privacy-section" className="config-outline-item">
                    <span className="config-outline-number">4</span>
                    <span><strong>Privacy</strong><small>{form.managePrivacyControl === false ? "Local setting" : form.privacyControlEnabled ? selectedReviewProviderLabel : "Disabled"}</small></span>
                  </a>
                  <a href="#config-policy-section" className="config-outline-item">
                    <span className="config-outline-number">5</span>
                    <span><strong>Repository & policy</strong><small>{form.hideSettings ? "Settings minimized" : "Normal settings"}</small></span>
                  </a>
                </aside>

                <div className="config-editor-content form-stack">
              <section id="config-profile-section">
              <FormSection title="Profile" description="Ownership and plain-language description.">
                <div className="grid three">
                  <div className="field"><FieldLabel>Name</FieldLabel><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
                  <div className="field"><FieldLabel>Description</FieldLabel><input className="input" value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
                  <div className="field"><FieldLabel help="Partner admins assigned to this solution partner can manage this profile.">Solution partner</FieldLabel><select value={form.partnerId ?? ""} onChange={(e) => setForm({ ...form, partnerId: e.target.value })}><option value="">Internal / no partner</option>{partners.map((partner) => <option key={partner.id} value={partner.id}>{partner.name}</option>)}</select></div>
                </div>
              </FormSection>
              </section>

              <section id="config-speech-section">
              <FormSection title="Speech processing" description="Make speech providers available to the app, configure the providers that need connection details, and choose the default managed provider.">
                <div className="provider-list">
	                  {speechProviders.map((provider) => {
	                    const available = normalizedSpeechAvailable(form).includes(provider.value);
	                    const config = speechProviderConfig(form, provider.value);
	                    return (
	                      <div className={`provider-row${available ? " enabled" : ""}`} key={provider.value}>
	                        <div className="provider-row-main">
	                          <label className="provider-enable">
	                            <input type="checkbox" checked={available} disabled={!provider.ready} onChange={(e) => toggleSpeechProvider(provider.value, e.target.checked)} />
	                            <span className="provider-icon-badge"><TemplateIcon symbol={provider.iconName} size={22} /></span>
	                            <span className="provider-copy"><strong>{provider.label}</strong><small>{provider.privacy}{provider.ready ? "" : " · coming soon in iOS"}</small></span>
	                          </label>
	                          <label className="provider-default"><input type="radio" name="speech-default-provider" checked={form.speechProviderType === provider.value} disabled={!available || !provider.ready} onChange={() => setSpeechDefault(provider.value)} /> Default</label>
	                        </div>
                        {available && (provider.endpoint || provider.model || provider.diarization) && (
                          <div className="provider-config-grid">
                            {provider.endpoint && <div className="field"><FieldLabel help={helpText.speechEndpointUrl}>Endpoint URL</FieldLabel><input className="input" value={config.endpointUrl} onChange={(e) => updateSpeechConfig(provider.value, { endpointUrl: e.target.value })} /></div>}
                            {provider.model && <ModelField label="Model name" help={helpText.speechModelName} value={config.modelName} onChange={(value) => updateSpeechConfig(provider.value, { modelName: value })} loading={modelLoading === "speech" && modelLoadingKey === modelRequestKey("speech")} options={form.speechProviderType === provider.value && modelLookupKeys.speech === modelRequestKey("speech") ? modelOptions.speech : []} onOpen={() => setSpeechDefault(provider.value)} />}
                            {provider.endpoint && <div className="field"><FieldLabel help={helpText.speechApiKey}>Managed API key</FieldLabel><input className="input" type="password" autoComplete="off" value={config.apiKey} onChange={(e) => updateSpeechConfig(provider.value, { apiKey: e.target.value })} placeholder="Optional managed key" /></div>}
                            {provider.diarization && <label className="checkbox-row provider-inline-check"><input type="checkbox" checked={Boolean(config.speakerDiarizationEnabled)} onChange={(e) => updateSpeechConfig(provider.value, { speakerDiarizationEnabled: e.target.checked })} /> Saved-recording diarization</label>}
                            {provider.endpoint && (
                              <>
                                <label className="checkbox-row provider-inline-check">
                                  <input type="checkbox" checked={Boolean(config.serverProcessingEnabled)} onChange={(e) => updateSpeechConfig(provider.value, { serverProcessingEnabled: e.target.checked })} />
                                  <span><FieldLabel help={helpText.speechServerProcessing}>Server process saved recordings</FieldLabel></span>
                                </label>
                                {config.serverProcessingEnabled && (
                                  <div className="field">
                                    <FieldLabel help={helpText.speechServerProcessingEndpointUrl}>Server processing API</FieldLabel>
                                    <input className="input" value={config.serverProcessingEndpointUrl} onChange={(e) => updateSpeechConfig(provider.value, { serverProcessingEndpointUrl: e.target.value })} />
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <label className="checkbox-row section-footer-check"><input type="checkbox" checked={form.userMayChangeSpeechProvider} onChange={(e) => setForm({ ...form, userMayChangeSpeechProvider: e.target.checked })} /> Allow users to choose another available speech provider <InfoTip text={helpText.userMayChangeSpeechProvider} /></label>
              </FormSection>
              </section>

              <section id="config-formatter-section">
              <FormSection title="Document generation" description="Maintain the formatter providers the app may use. Add tenant-specific OpenAI-compatible or Ollama endpoints when needed." actions={<button type="button" className="button secondary" onClick={addFormatterProvider}><Plus size={14} /> Add provider</button>}>
                {!configuredFormatterProviders.length ? (
                  <EmptyState title="No document providers" message="Add an OpenAI-compatible or Ollama provider profile when this policy should centrally manage document generation." />
                ) : <div className="provider-list">
                  {configuredFormatterProviders.map((provider) => {
                    const definition = formatterProviderDefinition(provider.type);
                    const formatterLookupKey = modelRequestKeyFromConfig(formatterModelLookupConfig(provider));
                    return (
                      <div className={`provider-row${provider.enabled ? " enabled" : ""}`} key={provider.id}>
                        <div className="provider-row-main">
                          <label className="provider-enable"><input type="checkbox" checked={provider.enabled} onChange={(e) => toggleFormatterProvider(provider.id, e.target.checked)} /><span><strong>{provider.name}</strong><small>{definition?.label ?? provider.type} · {provider.privacyEmphasis}</small></span></label>
                          <div className="row provider-row-actions">
                            <label className="provider-default"><input type="radio" name="formatter-default-provider" checked={form.selectedFormatterProviderId === provider.id} disabled={!provider.enabled} onChange={() => setFormatterDefault(provider.id)} /> Default</label>
                            <IconAction label="Remove provider" tone="danger" onClick={() => removeFormatterProvider(provider.id)}><Trash2 size={14} /></IconAction>
                          </div>
                        </div>
                        {provider.enabled && (
                          <div className="provider-config-grid">
                            <div className="field"><FieldLabel>Provider name</FieldLabel><input className="input" value={provider.name} onChange={(e) => updateFormatterProvider(provider.id, { name: e.target.value })} /></div>
                            <div className="field"><FieldLabel help={helpText.documentGenerationProviderType}>Provider type</FieldLabel><select value={provider.type} onChange={(e) => updateFormatterProvider(provider.id, { type: e.target.value, endpointUrl: formatterProviderDefinition(e.target.value)?.endpointDefault ?? provider.endpointUrl, privacyEmphasis: formatterPrivacyDefault(e.target.value, provider.privacyEmphasis) })}>{formatterProviders.filter((item) => item.value !== "apple_intelligence").map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
                            {definition?.endpoint && <div className="field"><FieldLabel help={helpText.documentGenerationEndpointUrl}>Endpoint URL</FieldLabel><input className="input" value={provider.endpointUrl} onChange={(e) => updateFormatterProvider(provider.id, { endpointUrl: e.target.value })} /></div>}
                            {definition?.model && <ModelField label="Model name" help={helpText.documentGenerationModel} value={provider.modelName} onChange={(value) => updateFormatterProvider(provider.id, { modelName: value })} loading={modelLoading === "formatter" && modelLoadingKey === formatterLookupKey} options={modelLookupKeys.formatter === formatterLookupKey ? modelOptions.formatter : []} onOpen={() => lookupFormatterModels(provider)} />}
                            {definition?.endpoint && <div className="field"><FieldLabel help={helpText.documentGenerationApiKey}>Managed API key</FieldLabel><input className="input" type="password" autoComplete="off" value={provider.apiKey} onChange={(e) => updateFormatterProvider(provider.id, { apiKey: e.target.value })} placeholder="Optional managed key" /></div>}
                            <div className="field"><FieldLabel>Privacy classification</FieldLabel><select value={provider.privacyEmphasis} onChange={(e) => updateFormatterProvider(provider.id, { privacyEmphasis: e.target.value })}><option value="safe">Safe</option><option value="managed">Managed</option><option value="caution">Use with caution</option><option value="unsafe">Unsafe</option></select></div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>}
                <label className="checkbox-row section-footer-check"><input type="checkbox" checked={form.userMayChangeFormatter} onChange={(e) => setForm({ ...form, userMayChangeFormatter: e.target.checked })} /> Allow users to choose another available formatter</label>
              </FormSection>
              </section>

              <section id="config-privacy-section">
              <FormSection title="Privacy control" description="Master guardrail switch plus two independent substeps: Presidio PII and privacy review.">
                <div className="privacy-policy-stack">
                  <div className={`privacy-policy-card${privacyPolicyApplied ? "" : " inactive"}`}>
                    <div className="privacy-policy-card-header">
                      <label className="policy-toggle privacy-apply-toggle"><input type="checkbox" checked={form.managePrivacyControl} onChange={(e) => setForm({ ...form, managePrivacyControl: e.target.checked, userMayChangePrivacyControl: e.target.checked ? form.userMayChangePrivacyControl : false })} /><span><FieldLabel help={helpText.managePrivacyControl}>Apply privacy-control policy</FieldLabel><small>{privacyPolicyApplied ? "Central policy controls the main app switch." : "Devices keep their local privacy-control switch."}</small></span></label>
                      <span className={`policy-state-pill${privacyPolicyApplied ? " active" : ""}`}>{privacyPolicyApplied ? "Applied" : "Local"}</span>
                    </div>
                    <fieldset className="privacy-policy-controls" disabled={!privacyPolicyApplied}>
                      <label className="policy-toggle"><input type="checkbox" checked={form.privacyControlEnabled} onChange={(e) => setForm({ ...form, privacyControlEnabled: e.target.checked })} /> <span><FieldLabel help={helpText.privacyControlEnabled}>Privacy control on</FieldLabel><small>{form.privacyControlEnabled ? "The guardrail is on by policy." : "The guardrail is off by policy."}</small></span></label>
                      <label className="policy-toggle"><input type="checkbox" checked={form.userMayChangePrivacyControl} onChange={(e) => setForm({ ...form, userMayChangePrivacyControl: e.target.checked })} /> <span><FieldLabel help={helpText.userMayChangePrivacyControl}>User may change privacy control</FieldLabel><small>{form.userMayChangePrivacyControl ? "Policy sets the starting value only." : "Policy locks the value."}</small></span></label>
                    </fieldset>
                  </div>

                  <div className={`privacy-policy-card${piiPolicyApplied ? "" : " inactive"}${privacyPolicyHardOff ? " blocked" : ""}`}>
                    <div className="privacy-policy-card-header">
                      <label className="policy-toggle privacy-apply-toggle"><input type="checkbox" checked={form.managePIIControl} disabled={privacyPolicyHardOff} onChange={(e) => setForm({ ...form, managePIIControl: e.target.checked, userMayChangePIIControl: e.target.checked ? form.userMayChangePIIControl : false })} /><span><FieldLabel help={helpText.managePIIControl}>Apply Presidio PII policy</FieldLabel><small>{privacyPolicyHardOff ? "Inactive because privacy control is locked off." : piiPolicyApplied ? "Presidio defaults are sent to devices." : "Devices keep local Presidio settings."}</small></span></label>
                      <span className={`policy-state-pill${piiPolicyApplied ? " active" : ""}`}>{privacyPolicyHardOff ? "Blocked" : piiPolicyApplied ? "Applied" : "Local"}</span>
                    </div>
                    <fieldset className="privacy-policy-controls" disabled={!piiPolicyApplied}>
                      <div className="policy-toggle-grid">
                        <label className="policy-toggle"><input type="checkbox" checked={form.piiControlEnabled} onChange={(e) => setForm({ ...form, piiControlEnabled: e.target.checked })} /> <span><FieldLabel help={helpText.piiControlEnabled}>Presidio PII on</FieldLabel><small>{form.piiControlEnabled ? "Structured PII check is on." : "Structured PII check is off."}</small></span></label>
                        <label className="policy-toggle"><input type="checkbox" checked={form.userMayChangePIIControl} onChange={(e) => setForm({ ...form, userMayChangePIIControl: e.target.checked })} /> <span><FieldLabel help={helpText.userMayChangePIIControl}>User may change Presidio PII</FieldLabel><small>{form.userMayChangePIIControl ? "User may tune the analyzer." : "Analyzer settings are locked."}</small></span></label>
                      </div>
                      <div className="grid two">
                        <div className="field"><FieldLabel help={helpText.presidioEndpointUrl}>Presidio endpoint URL</FieldLabel><input className="input" value={form.presidioEndpointUrl ?? ""} onChange={(e) => setForm({ ...form, presidioEndpointUrl: e.target.value })} /></div>
                        <div className="field"><FieldLabel help={helpText.presidioApiKey}>Managed API key</FieldLabel><input className="input" type="password" autoComplete="off" value={form.presidioApiKey ?? ""} onChange={(e) => setForm({ ...form, presidioApiKey: e.target.value })} placeholder="Optional managed key" /></div>
                        <div className="field"><FieldLabel help={helpText.presidioScoreThreshold}>Minimum score</FieldLabel><div className="range-control"><input type="range" min="0" max="1" step="0.05" value={form.piiScoreThreshold} onChange={(e) => setForm({ ...form, piiScoreThreshold: e.target.value })} /><output>{Number(form.piiScoreThreshold || 0).toFixed(2)}</output></div></div>
                      </div>
                      <div className="row checkbox-group privacy-detection-group">
                        <label className="checkbox-row"><input type="checkbox" checked={Boolean(form.fullPersonNamesOnly)} onChange={(e) => setForm({ ...form, fullPersonNamesOnly: e.target.checked })} /> Only react to full names</label>
                        <label className="checkbox-row"><input type="checkbox" checked={Boolean(form.detectPerson)} onChange={(e) => setForm({ ...form, detectPerson: e.target.checked })} /> Person names</label>
                        <label className="checkbox-row"><input type="checkbox" checked={Boolean(form.detectEmail)} onChange={(e) => setForm({ ...form, detectEmail: e.target.checked })} /> Email addresses</label>
                        <label className="checkbox-row"><input type="checkbox" checked={Boolean(form.detectPhone)} onChange={(e) => setForm({ ...form, detectPhone: e.target.checked })} /> Phone numbers</label>
                        <label className="checkbox-row"><input type="checkbox" checked={Boolean(form.detectLocation)} onChange={(e) => setForm({ ...form, detectLocation: e.target.checked })} /> Places and addresses</label>
                        <label className="checkbox-row"><input type="checkbox" checked={Boolean(form.detectIdentifier)} onChange={(e) => setForm({ ...form, detectIdentifier: e.target.checked })} /> Other identifiers</label>
                      </div>
                    </fieldset>
                  </div>

                  <div className={`privacy-policy-card${reviewPolicyApplied ? "" : " inactive"}${privacyPolicyHardOff ? " blocked" : ""}`}>
                    <div className="privacy-policy-card-header">
                      <label className="policy-toggle privacy-apply-toggle"><input type="checkbox" checked={form.managePrivacyReviewProvider} disabled={privacyPolicyHardOff} onChange={(e) => setForm({ ...form, managePrivacyReviewProvider: e.target.checked, userMayChangePrivacyReviewProvider: e.target.checked ? form.userMayChangePrivacyReviewProvider : false })} /><span><FieldLabel help={helpText.managePrivacyReviewProvider}>Apply privacy-review policy</FieldLabel><small>{privacyPolicyHardOff ? "Inactive because privacy control is locked off." : reviewPolicyApplied ? "Review provider is sent to devices." : "Devices keep local review provider."}</small></span></label>
                      <span className={`policy-state-pill${reviewPolicyApplied ? " active" : ""}`}>{privacyPolicyHardOff ? "Blocked" : reviewPolicyApplied ? "Applied" : "Local"}</span>
                    </div>
                    <fieldset className="privacy-policy-controls" disabled={!reviewPolicyApplied}>
                      <div className="policy-toggle-grid single">
                        <label className="policy-toggle"><input type="checkbox" checked={form.userMayChangePrivacyReviewProvider} onChange={(e) => setForm({ ...form, userMayChangePrivacyReviewProvider: e.target.checked })} /> <span><FieldLabel help={helpText.userMayChangePrivacyReviewProvider}>User may change privacy review</FieldLabel><small>{form.userMayChangePrivacyReviewProvider ? "Policy provider is the default only." : "Provider choice is locked."}</small></span></label>
                      </div>
                      <ProviderHint provider={selectedPrivacyReviewProvider} />
                      <div className="grid two">
                        <div className="field"><FieldLabel help={helpText.privacyReviewProviderType}>Selected review provider</FieldLabel><select value={form.privacyReviewProviderType ?? ""} onChange={(e) => applyProviderDefault("review", e.target.value)}>{privacyReviewProviders.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}{provider.ready ? "" : " (not recommended)"}</option>)}</select></div>
                        {form.privacyReviewProviderType && form.privacyReviewProviderType !== "local_heuristic" && <div className="field"><FieldLabel help={helpText.privacyReviewEndpointUrl}>Endpoint URL</FieldLabel><input className="input" value={form.privacyReviewEndpointUrl ?? ""} onChange={(e) => setForm({ ...form, privacyReviewEndpointUrl: e.target.value })} /></div>}
                        {form.privacyReviewProviderType && form.privacyReviewProviderType !== "local_heuristic" && <ModelField label="Model name" help={helpText.privacyReviewModel} value={form.privacyReviewModel ?? ""} onChange={(value) => setForm({ ...form, privacyReviewModel: value })} disabled={!reviewPolicyApplied} loading={modelLoading === "review" && modelLoadingKey === modelRequestKey("review")} options={modelLookupKeys.review === modelRequestKey("review") ? modelOptions.review : []} onOpen={() => lookupModels("review")} />}
                        {form.privacyReviewProviderType && form.privacyReviewProviderType !== "local_heuristic" && <div className="field"><FieldLabel help={helpText.privacyReviewApiKey}>Managed API key</FieldLabel><input className="input" type="password" autoComplete="off" value={form.privacyReviewApiKey ?? ""} onChange={(e) => setForm({ ...form, privacyReviewApiKey: e.target.value })} placeholder="Optional managed key" /></div>}
                      </div>
                    </fieldset>
                  </div>

                  <div className={`privacy-policy-card${privacyPromptPolicyApplied ? "" : " inactive"}${privacyPolicyHardOff ? " blocked" : ""}`}>
                    <div className="privacy-policy-card-header">
                      <label className="policy-toggle privacy-apply-toggle"><input type="checkbox" checked={form.managePrivacyPrompt} disabled={privacyPolicyHardOff} onChange={(e) => setForm({ ...form, managePrivacyPrompt: e.target.checked })} /> <span><FieldLabel help={helpText.managePrivacyPrompt}>Use policy Personvern prompt</FieldLabel><small>{privacyPolicyHardOff ? "Inactive because privacy control is locked off." : privacyPromptPolicyApplied ? "Prompt text is sent to devices." : "Devices use built-in or local prompt."}</small></span></label>
                      <span className={`policy-state-pill${privacyPromptPolicyApplied ? " active" : ""}`}>{privacyPolicyHardOff ? "Blocked" : privacyPromptPolicyApplied ? "Applied" : "Local"}</span>
                    </div>
                    <fieldset className="privacy-policy-controls" disabled={!privacyPromptPolicyApplied}>
                      <div className="field">
                        <FieldLabel help={helpText.privacyPrompt}>Personvern prompt text</FieldLabel>
                        <textarea value={form.privacyPrompt ?? ""} onChange={(e) => setForm({ ...form, privacyPrompt: e.target.value })} placeholder="Example: Remove names, phone numbers and sensitive case details before document generation. Mark uncertainty instead of guessing." />
                      </div>
                    </fieldset>
                  </div>
                </div>
              </FormSection>
              </section>

              <section id="config-policy-section">
              <FormSection title="Repository, telemetry and policy" description="Sparse managed config: leave fields blank when the tenant should keep local settings.">
                <div className="policy-section-stack">
                  <div className="policy-card">
                    <div className="policy-card-header">
                      <h4>Repository and telemetry</h4>
                      <p>Central catalog and optional operational endpoints returned to enterprise devices.</p>
                    </div>
                    <div className="policy-card-body">
                      <div className="grid two">
                        <div className="field"><FieldLabel help={helpText.templateRepositoryUrl}>Template repository URL</FieldLabel><input className="input" value={form.templateRepositoryUrl ?? ""} onChange={(e) => setForm({ ...form, templateRepositoryUrl: e.target.value })} /></div>
                        <div className="field"><FieldLabel>Telemetry endpoint URL</FieldLabel><input className="input" value={form.telemetryEndpointUrl ?? ""} onChange={(e) => setForm({ ...form, telemetryEndpointUrl: e.target.value })} /></div>
                      </div>
                      <div className="field"><FieldLabel help={helpText.defaultTemplateId}>Default template ID</FieldLabel><input className="input" value={form.defaultTemplateId ?? ""} onChange={(e) => setForm({ ...form, defaultTemplateId: e.target.value })} /></div>
                      <label className="checkbox-row section-footer-check"><input type="checkbox" checked={form.manageTemplateCategories} onChange={(e) => setForm({ ...form, manageTemplateCategories: e.target.checked })} /> <FieldLabel help={helpText.manageTemplateCategories}>Manage template categories</FieldLabel></label>
                    </div>
                  </div>

                  <div className="policy-card">
                    <div className="policy-card-header">
                      <h4>Device policy behavior</h4>
                      <p>Keep override off for strict enterprise control. Only enable local changes deliberately.</p>
                    </div>
                    <div className="policy-card-body">
                      <div className="policy-toggle-grid">
                        <label className="policy-toggle"><input type="checkbox" checked={form.hideSettings} onChange={(e) => setForm({ ...form, hideSettings: e.target.checked })} /><span><FieldLabel help={helpText.hideSettings}>Hide most app settings</FieldLabel><small>Keeps managed enterprise users focused on status, support, and daily use.</small></span></label>
                        <label className="policy-toggle"><input type="checkbox" checked={form.hideRecordingFloatingToolbar} onChange={(e) => setForm({ ...form, hideRecordingFloatingToolbar: e.target.checked })} /><span><FieldLabel help={helpText.hideRecordingFloatingToolbar}>Hide floating recording toolbar</FieldLabel><small>Removes the quick setup bubble from New Recording.</small></span></label>
                        <label className="policy-toggle"><input type="checkbox" checked={form.allowPolicyOverride} onChange={(e) => setForm({ ...form, allowPolicyOverride: e.target.checked })} /><span><FieldLabel help={helpText.allowPolicyOverride}>Allow device policy override</FieldLabel><small>Lets users temporarily bypass managed provider and privacy settings.</small></span></label>
                      </div>
                      <div className={`hidden-settings-exceptions${form.hideSettings ? "" : " disabled"}`}>
                        <div className="form-subsection-header">
                          <h4>Keep visible when most settings are hidden <InfoTip text={helpText.visibleSettingsWhenHidden} /></h4>
                          <p>{form.hideSettings ? "Checked settings remain available in the app." : "Enable Hide most app settings to use these exceptions."}</p>
                        </div>
                        <div className="policy-toggle-grid compact">
                          {hiddenSettingsOptions.map((option) => (
                            <label className="policy-toggle" key={option.value}>
                              <input
                                type="checkbox"
                                checked={normalizeVisibleSettingsWhenHidden(form).includes(option.value)}
                                disabled={!form.hideSettings}
                                onChange={(event) => toggleHiddenSetting(option.value, event.target.checked)}
                              />
                              <span><strong>{option.label}</strong><small>{option.description}</small></span>
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="policy-card">
                    <div className="policy-card-header">
                      <h4>Feature flags and provider restrictions</h4>
                      <p>Allowed provider restrictions are generated from the provider lists above and returned as backend provider values.</p>
                    </div>
                    <div className="policy-card-body">
                      <div className="policy-toggle-grid compact">
                        <label className="policy-toggle"><input type="checkbox" checked={form.developerMode} onChange={(e) => setForm({ ...form, developerMode: e.target.checked })} /><span><FieldLabel help={helpText.developerMode}>Developer mode</FieldLabel><small>Shows testing and validation tools in the app.</small></span></label>
                        <label className="policy-toggle"><input type="checkbox" checked={form.allowExternalProviders || externalProviderAccessRequired} disabled={externalProviderAccessRequired} onChange={(e) => setForm({ ...form, allowExternalProviders: e.target.checked })} /><span><FieldLabel help={helpText.allowExternalProviders}>Allow external providers</FieldLabel><small>{externalProviderAccessRequired ? "Required because OpenAI speech is available to the app." : "Blocks user-managed external connections when off."}</small></span></label>
                      </div>
                      <div className="provider-restriction-preview">
                        {Array.from(new Set([...normalizedSpeechAvailable(form), ...configuredFormatterProviders.filter((provider) => provider.enabled).map((provider) => provider.type), form.privacyReviewProviderType].filter(Boolean))).map((value) => <span className="badge" key={value}>{value}</span>)}
                      </div>
                    </div>
                  </div>
                </div>
              </FormSection>
              </section>
                </div>
              </div>
            </form>
          </SidePanel>
        </>
      )}
    </RequireAuth>
  );
}

function normalizedSpeechAvailable(source: any) {
  const values = Array.isArray(source.speechAvailableProviders) ? source.speechAvailableProviders : [];
  const providerValues = new Set(speechProviders.filter((provider) => provider.ready).map((provider) => provider.value));
  return values.filter((value: unknown): value is string => typeof value === "string" && providerValues.has(value));
}

function requiresExternalProviderAccess(source: any) {
  return normalizedSpeechAvailable(source).some((value: string) => value === "openai");
}

function profileHasValue(source: any, key: string) {
  const value = source?.[key];
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function hasManagedPIIPolicyFields(source: any) {
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
  ].some((key) => profileHasValue(source, key));
}

function hasManagedPrivacyReviewPolicyFields(source: any) {
  return [
    "privacyReviewProviderType",
    "privacyReviewEndpointUrl",
    "privacyReviewModel",
    "privacyReviewApiKey"
  ].some((key) => profileHasValue(source, key));
}

function speechProviderConfig(source: any, providerValue: string): SpeechProviderConfig {
  const provider = speechProviders.find((item) => item.value === providerValue);
  const existing = source.speechProviderConfigs?.[providerValue] ?? {};
  return {
    endpointUrl: existing.endpointUrl ?? provider?.endpointDefault ?? "",
    modelName: existing.modelName ?? provider?.modelDefault ?? "",
    apiKey: existing.apiKey ?? "",
    speakerDiarizationEnabled: Boolean(existing.speakerDiarizationEnabled),
    serverProcessingEnabled: Boolean(existing.serverProcessingEnabled),
    serverProcessingEndpointUrl: existing.serverProcessingEndpointUrl ?? "https://api.skrivdet.no/api/v1/speech-processing"
  };
}

function speechConfigFromProfile(profile: any, providerProfiles: any) {
  return Object.fromEntries(speechProviders.map((provider) => {
    const stored = providerProfiles?.speech?.providers?.[provider.value] ?? {};
    const selected = profile.speechProviderType === provider.value;
    return [provider.value, {
      endpointUrl: selected ? profile.speechEndpointUrl ?? stored.endpointUrl ?? provider.endpointDefault ?? "" : stored.endpointUrl ?? provider.endpointDefault ?? "",
      modelName: selected ? profile.speechModelName ?? stored.modelName ?? provider.modelDefault ?? "" : stored.modelName ?? provider.modelDefault ?? "",
      apiKey: selected ? profile.speechApiKey ?? stored.apiKey ?? "" : stored.apiKey ?? "",
      speakerDiarizationEnabled: selected ? providerProfiles?.speech?.speakerDiarizationEnabled ?? stored.speakerDiarizationEnabled ?? false : stored.speakerDiarizationEnabled ?? false,
      serverProcessingEnabled: Boolean(stored.serverProcessingEnabled),
      serverProcessingEndpointUrl: stored.serverProcessingEndpointUrl ?? "https://api.skrivdet.no/api/v1/speech-processing"
    }];
  }));
}

function formatterProviderDefinition(providerType?: string | null) {
  return formatterProviders.find((provider) => provider.value === normalizeFormatterProviderType(providerType));
}

function defaultFormatterProfiles(): FormatterProviderProfile[] {
  return [];
}

function currentFormatterProviders(source: any): FormatterProviderProfile[] {
  const stored = Array.isArray(source.formatterProviders) ? source.formatterProviders : [];
  const merged = new Map<string, FormatterProviderProfile>();
  for (const provider of stored) {
    if (!provider?.id || !provider?.type) continue;
    const definition = formatterProviderDefinition(provider.type);
    merged.set(provider.id, {
      id: String(provider.id),
      name: String(provider.name || definition?.label || "Provider"),
      type: normalizeFormatterProviderType(provider.type),
      enabled: Boolean(provider.enabled),
      builtIn: false,
      endpointUrl: String(provider.endpointUrl ?? definition?.endpointDefault ?? ""),
      modelName: String(provider.modelName ?? definition?.modelDefault ?? ""),
      apiKey: String(provider.apiKey ?? ""),
      privacyEmphasis: String(provider.privacyEmphasis ?? formatterPrivacyDefault(provider.type, "managed"))
    });
  }
  return Array.from(merged.values());
}

function formatterProfilesFromProfile(profile: any, providerProfiles: any): FormatterProviderProfile[] {
  const storedProfiles = providerProfiles?.formatter?.providers;
  const selectedProviderId = providerProfiles?.formatter?.selectedProviderId;
  const selectedType = normalizeFormatterProviderType(profile.documentGenerationProviderType ?? providerProfiles?.formatter?.selected);
  const selectedDefinition = formatterProviderDefinition(selectedType);
  const manualStoredProfiles = Array.isArray(storedProfiles)
    ? storedProfiles.filter((provider) => {
        const type = normalizeFormatterProviderType(provider?.type);
        if (!type || type === "apple_intelligence") return false;
        if (!provider?.builtIn) return true;
        return provider.id === selectedProviderId || (selectedType && type === selectedType);
      })
    : [];
  const profiles = manualStoredProfiles.length
    ? manualStoredProfiles
    : selectedType && selectedType !== "apple_intelligence"
      ? [{
          id: `manual-${selectedType}`,
          name: selectedDefinition?.label ?? "Document provider",
          type: selectedType,
          enabled: true,
          builtIn: false,
          endpointUrl: profile.documentGenerationEndpointUrl ?? selectedDefinition?.endpointDefault ?? "",
          modelName: profile.documentGenerationModel ?? selectedDefinition?.modelDefault ?? "",
          apiKey: profile.documentGenerationApiKey ?? "",
          privacyEmphasis: providerProfiles?.formatter?.privacyEmphasis ?? formatterPrivacyDefault(selectedType, "managed")
        }]
      : defaultFormatterProfiles();
  const mapped = currentFormatterProviders({ formatterProviders: profiles });
  return mapped.map((provider) => {
    const isSelected = provider.id === selectedProviderId || (!selectedProviderId && provider.type === selectedType);
    if (!isSelected) return provider;
    return {
      ...provider,
      enabled: true,
      endpointUrl: profile.documentGenerationEndpointUrl ?? provider.endpointUrl,
      modelName: profile.documentGenerationModel ?? provider.modelName,
      apiKey: profile.documentGenerationApiKey ?? provider.apiKey,
      privacyEmphasis: providerProfiles?.formatter?.privacyEmphasis ?? provider.privacyEmphasis
    };
  });
}

type ModelSummaryProps = {
  title: string;
  detail: string;
  empty?: boolean;
};

function ModelSummary({ title, detail, empty = false }: ModelSummaryProps) {
  return (
    <div className={`model-summary${empty ? " empty" : ""}`}>
      <strong>{title}</strong>
      {detail && <span>{detail}</span>}
    </div>
  );
}

function speechModelSummary(profile: any): ModelSummaryProps {
  const providerType = profile.speechProviderType || "local";
  const provider = speechProviders.find((item) => item.value === providerType);
  if (!provider?.model) {
    return {
      title: provider?.label ?? providerType,
      detail: "",
      empty: false
    };
  }
  return {
    title: profile.speechModelName || "No model selected",
    detail: provider.label,
    empty: !profile.speechModelName
  };
}

function formatterModelSummary(profile: any): ModelSummaryProps {
  const providerProfiles = profile.providerProfiles ?? {};
  const providerType = normalizeFormatterProviderType(profile.documentGenerationProviderType ?? providerProfiles?.formatter?.selected);
  if (!providerType) return { title: "Not managed", detail: "", empty: true };
  if (providerType === "apple_intelligence") return { title: "Apple Intelligence", detail: "", empty: false };

  const selectedProvider = selectedFormatterProfileFromProfile(profile, providerProfiles);
  return {
    title: selectedProvider?.name ?? formatterProviderDefinition(providerType)?.label ?? providerType,
    detail: "",
    empty: false
  };
}

function privacyReviewModelSummary(profile: any): ModelSummaryProps {
  const managedPolicy = profile.managedPolicy ?? {};
  const appliesPrivacyControl = managedPolicy.managePrivacyControl ?? managedPolicy.privacyControlManaged ?? profileHasValue(profile, "privacyControlEnabled");
  const appliesPrivacyReview = managedPolicy.managePrivacyReviewProvider ?? managedPolicy.privacyReviewProviderManaged ?? managedPolicy.managePrivacyReview ?? hasManagedPrivacyReviewPolicyFields(profile);
  if (!appliesPrivacyControl) {
    return { title: "Local setting", detail: "Not centrally managed", empty: true };
  }
  if (!profile.privacyControlEnabled) return { title: "Privacy disabled", detail: "No review model", empty: true };
  if (!appliesPrivacyReview) return { title: "Local review", detail: "Review provider not centrally managed", empty: true };
  const providerType = normalizeReviewProviderType(profile.privacyReviewProviderType);
  if (!providerType) return { title: "Not managed", detail: "Local app setting", empty: true };
  const provider = privacyReviewProviders.find((item) => item.value === providerType);
  if (providerType === "local_heuristic") return { title: "Local heuristic", detail: "No remote model", empty: true };

  return {
    title: provider?.label ?? providerType,
    detail: profile.privacyReviewModel || "No model selected",
    empty: !profile.privacyReviewModel
  };
}

function selectedFormatterProfileFromProfile(profile: any, providerProfiles: any) {
  const profiles = formatterProfilesFromProfile(profile, providerProfiles);
  const selectedProviderId = providerProfiles?.formatter?.selectedProviderId;
  const selectedType = normalizeFormatterProviderType(profile.documentGenerationProviderType ?? providerProfiles?.formatter?.selected);
  return profiles.find((provider) => provider.id === selectedProviderId)
    ?? profiles.find((provider) => provider.enabled && provider.type === selectedType)
    ?? profiles.find((provider) => provider.type === selectedType)
    ?? profiles.find((provider) => provider.enabled)
    ?? profiles[0];
}

function ProviderHint({ provider }: { provider?: { privacy?: string; ready?: boolean } }) {
  if (!provider) return null;
  return <div className="config-hint"><span>{provider.privacy}</span>{provider.ready === false && <strong>Coming soon / not production ready</strong>}</div>;
}

function ModelField({
  label,
  help,
  value,
  onChange,
  disabled,
  loading,
  options,
  onOpen
}: {
  label: string;
  help: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  loading?: boolean;
  options: string[];
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const comboboxRef = useRef<HTMLDivElement>(null);
  const filteredOptions = useMemo(() => {
    const query = value.trim().toLowerCase();
    return query ? options.filter((model) => model.toLowerCase().includes(query)) : options;
  }, [options, value]);

  useEffect(() => {
    setActiveIndex(0);
  }, [value, options.length]);

  function showMenu() {
    if (disabled) return;
    setOpen(true);
  }

  function openMenu() {
    if (disabled) return;
    showMenu();
    onOpen();
  }

  function selectModel(model: string) {
    onChange(model);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openMenu();
      setActiveIndex((current) => Math.min(current + 1, Math.max(filteredOptions.length - 1, 0)));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    }
    if (event.key === "Enter" && open && filteredOptions[activeIndex]) {
      event.preventDefault();
      selectModel(filteredOptions[activeIndex]);
    }
    if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="field">
      <FieldLabel help={help}>{label}</FieldLabel>
      <div
        ref={comboboxRef}
        className="model-combobox"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <div className="model-combobox-control">
          <input
            className="input"
            value={value}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            autoComplete="off"
            placeholder={disabled ? "" : "Type or choose a model"}
            onFocus={openMenu}
            onClick={openMenu}
            onChange={(event) => {
              onChange(event.target.value);
              showMenu();
            }}
            onKeyDown={handleKeyDown}
            disabled={disabled}
          />
          <span className="model-combobox-indicator" aria-hidden="true">
            {loading ? <Loader2 size={14} className="spin" /> : <ChevronDown size={14} />}
          </span>
        </div>
        {open && !disabled && (
          <div className="model-menu" role="listbox">
            {loading && <div className="model-menu-empty">Loading models...</div>}
            {!loading && filteredOptions.map((model, index) => (
              <button
                key={model}
                type="button"
                role="option"
                aria-selected={model === value}
                className={`model-option${index === activeIndex ? " active" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectModel(model);
                }}
              >
                {model}
              </button>
            ))}
            {!loading && filteredOptions.length === 0 && (
              <div className="model-menu-empty">
                {options.length ? "No matching models. Keep typing to use a custom value." : "Models load automatically when available. You can type a custom value."}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function keyFingerprint(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  return `${trimmed.length}:${trimmed.slice(0, 2)}:${trimmed.slice(-4)}`;
}

function providerDefaultModel(provider?: unknown) {
  if (!provider || typeof provider !== "object" || !("modelDefault" in provider)) return "";
  const value = (provider as { modelDefault?: unknown }).modelDefault;
  return typeof value === "string" ? value : "";
}

function formatterPrivacyDefault(providerType: string, fallback: string) {
  if (providerType === "apple_intelligence") return "safe";
  if (["ollama", "openai_compatible"].includes(providerType)) return "managed";
  return fallback;
}

function normalizeFormatterProviderType(providerType?: string | null) {
  if (providerType === "openai" || providerType === "vllm") return "openai_compatible";
  return providerType ?? "";
}

function normalizeReviewProviderType(providerType?: string | null) {
  if (providerType === "openai" || providerType === "vllm") return "openai_compatible";
  return providerType ?? "";
}

function normalizeVisibleSettingsWhenHidden(source: any) {
  const raw = source?.visibleSettingsWhenHidden ?? source?.settingsVisibleWhenHidden ?? source?.allowedSettingsWhenHidden;
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(hiddenSettingsOptions.map((option) => option.value));
  return raw.filter((value): value is string => typeof value === "string" && allowed.has(value));
}
