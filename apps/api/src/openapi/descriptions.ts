type OperationDoc = {
  description?: string;
  deprecated?: boolean;
  "x-skrivdet-status"?: string;
  "x-skrivdet-replacement"?: string;
};

type OpenApiLike = {
  paths?: unknown;
};

type ParameterDoc = {
  name?: string;
  in?: string;
  description?: string;
  deprecated?: boolean;
  "x-skrivdet-status"?: string;
};

type OperationMetadata = Pick<OperationDoc, "deprecated" | "x-skrivdet-status" | "x-skrivdet-replacement">;

const operationDescriptions: Record<string, string> = {
  "POST /api/v1/auth/login": [
    "Authenticates an internal skrivDET admin portal user with email and password and returns a bearer JWT plus safe user metadata.",
    "Repeated failed login attempts are rate limited and can temporarily lock the targeted admin account.",
    "There is no public registration flow: admin users are created by superadmins from the admin portal.",
    "Use this token as Authorization: Bearer <token> for all /api/v1/admin/* endpoints."
  ].join(" "),

  "POST /api/v1/activate/single": [
    "Mobile-facing endpoint used when an iPhone user manually enters a single-user activation key.",
    "The backend validates the hashed key, checks active/revoked/expired/disabled status, binds the license to exactly one device in v1, records app version and device serial metadata, and returns an activation token.",
    "The response includes license owner and maintenance fields so Settings can show a complete license overview."
  ].join(" "),
  "POST /api/v1/activate/enterprise": [
    "Mobile-facing endpoint used when an iPhone user manually enters an enterprise activation key.",
    "The backend validates the key, checks tenant/key/device-limit status, registers this device activation, resolves the effective config profile, and returns tenant, license, device and config metadata.",
    "The activation token returned here is also used as the bearer token for enterprise template manifest/download access.",
    "When managedPolicy.manageTemplateCategories is true, config.templateCategories contains the centrally managed category catalog; each item id matches YAML identity.category and manifest category values."
  ].join(" "),
  "POST /api/v1/activation/refresh": [
    "Mobile check-in endpoint for an already activated device.",
    "The app sends the activation token plus current device/app metadata; the backend verifies the signed token, rotates it, updates lastSeenAt/lastCheckIn/appVersion/deviceSerialNumber, and returns current license status.",
    "Enterprise responses include the latest effective config profile so central policy changes are picked up without reactivation, including config.templateCategories when category management is enabled."
  ].join(" "),
  "GET /api/v1/config/effective": [
    "Returns the current effective enterprise configuration for the supplied Authorization: Bearer <activationToken> without requiring a full refresh body.",
    "The config payload is sparse: fields that are present are intentional managed policy, while omitted fields should leave local app settings unchanged.",
    "For single-user activations this returns no tenant and an empty config object because single licenses do not receive central policy in v1.",
    "Enterprise config may include templateCategories when managedPolicy.manageTemplateCategories is enabled so the app can use server-side category titles, SF Symbol icons and display order."
  ].join(" "),
  "GET /api/v1/license/details": [
    "Returns the canonical mobile Settings license-details payload for Authorization: Bearer <activationToken>.",
    "Use this when the iPhone app needs to rebuild the full license screen from server state, including registered owner, maintenance status, tenant, device and selected config profile metadata.",
    "It has no mutation side effects beyond normal token validation."
  ].join(" "),

  "GET /api/v1/templates/manifest": [
    "Mobile-facing enterprise template catalog endpoint.",
    "Requires an enterprise activation token in Authorization: Bearer <activationToken> and returns only the latest published template variants entitled to that activation's tenant.",
    "Single-user activations do not receive central repository access; tenant filtering is applied by the backend before the manifest is returned.",
    "Internal verification may use Authorization: Bearer <TEMPLATE_REPOSITORY_API_KEY> when that override is explicitly configured."
  ].join(" "),
  "GET /api/v1/templates/{id}/download": [
    "Downloads the raw YAML snapshot for a tenant-entitled published template variant.",
    "The id is the template identity UUID from the manifest, not the admin draft id.",
    "The app should store downloaded repository templates as repository-managed templates and fork local edits into separate custom templates instead of modifying the managed source."
  ].join(" "),

  "GET /api/v1/admin/me": [
    "Returns the currently authenticated admin portal user derived from the bearer JWT.",
    "The response includes safe profile fields such as id, email, fullName, role, partnerId and partner metadata when available.",
    "Use this for session display, role checks and logout/session validation in the admin UI."
  ].join(" "),
  "GET /api/v1/admin/settings/template-preview-provider": [
    "Returns the centrally configured AI preview provider used by the admin template designer.",
    "Superadmin-only endpoint; secrets are masked and never returned in clear text.",
    "The preview provider is independent of tenant runtime provider policy and is only used when an admin manually generates a draft preview."
  ].join(" "),
  "PATCH /api/v1/admin/settings/template-preview-provider": [
    "Creates or updates the global AI preview provider setting for template preview generation.",
    "Superadmin-only endpoint; API keys are write-only, masked after save, and replaced only when a new key is submitted.",
    "Changing provider type or endpoint may clear incompatible saved secrets to avoid accidentally reusing a key with the wrong service."
  ].join(" "),
  "POST /api/v1/admin/settings/template-preview-provider/models": [
    "Fetches model identifiers from the configured template-preview provider for the Settings model picker.",
    "Superadmins may use either the saved provider credential or a credential supplied in the request to test unsaved changes.",
    "This endpoint does not save settings; it only probes the provider endpoint and returns normalized model ids."
  ].join(" "),
  "GET /api/v1/admin/settings/template-preview-provider/status": [
    "Returns runtime readiness for the template preview provider without exposing configuration secrets.",
    "The template designer uses this to show whether Generate preview can call the centrally configured provider.",
    "A configured status means endpoint, model and credential requirements are satisfied from settings or environment variables."
  ].join(" "),

  "GET /api/v1/admin/partners": [
    "Lists solution partners visible to the current admin.",
    "Superadmins and staff can see all partners; partner admins are scoped to their own partner.",
    "Returned partner records include related tenants and admin users for the partner-management screen."
  ].join(" "),
  "POST /api/v1/admin/partners": [
    "Creates a solution partner organization that can own tenants, license keys, config profiles and partner-admin users.",
    "Superadmin-only endpoint; a successful create is audit logged.",
    "Use partners to scope solution-provider access without exposing a public customer portal."
  ].join(" "),
  "PATCH /api/v1/admin/partners/{id}": [
    "Updates solution partner metadata such as name, contact details and notes.",
    "Superadmin-only endpoint; it does not move existing tenant/license ownership unless partner fields in related records are changed separately.",
    "A successful update is written to the audit log."
  ].join(" "),
  "DELETE /api/v1/admin/partners/{id}": [
    "Deletes a solution partner only when no admin users, tenants, single keys, enterprise keys or config profiles still reference it.",
    "Superadmin-only endpoint; use this for cleanup of unused partner records, not for disabling an active partner relationship.",
    "If the partner is in use the endpoint returns a conflict instead of cascading deletes."
  ].join(" "),

  "GET /api/v1/admin/users": [
    "Lists internal admin portal users for user management.",
    "Superadmin-only endpoint; password hashes are stripped from every response.",
    "Use role and partnerId to determine whether a user is a superadmin, staff admin or partner admin scoped to a solution partner."
  ].join(" "),
  "POST /api/v1/admin/users": [
    "Creates an internal admin portal user and hashes the supplied password before storage.",
    "Superadmin-only endpoint; partner_admin users must be assigned to a solution partner so their access can be scoped.",
    "The created user is returned without password hash and the operation is audit logged."
  ].join(" "),
  "PATCH /api/v1/admin/users/{id}": [
    "Updates an admin portal user's profile, role, partner assignment, active state or password.",
    "Superadmin-only endpoint; password is changed only when a new password is supplied.",
    "The endpoint prevents removing the final superadmin and validates partner_admin users have a partner assignment."
  ].join(" "),
  "DELETE /api/v1/admin/users/{id}": [
    "Deletes an internal admin portal user.",
    "Superadmin-only endpoint; the current user cannot delete themselves and the system must retain at least one superadmin.",
    "This removes admin access only and does not delete audit log entries created by that user."
  ].join(" "),

  "GET /api/v1/admin/overview": [
    "Returns dashboard counters and recent audit activity for the admin overview screen.",
    "Counts include single keys, enterprise keys, activations, active unique devices and template families, scoped by partner where applicable.",
    "Use this endpoint for lightweight operational status; detailed management screens have their own list endpoints."
  ].join(" "),

  "GET /api/v1/admin/single-keys": [
    "Lists single-user license keys visible to the current admin, including partner metadata and device activation records.",
    "Full activation keys are never returned after creation; only keyPrefix, status, owner details, maintenance dates and activation metadata are exposed.",
    "Partner admins only see keys assigned to their partner."
  ].join(" "),
  "POST /api/v1/admin/single-keys": [
    "Generates a display-once single-user activation key for an individual purchaser.",
    "The backend stores only a hash and key prefix, records purchaser/maintenance/partner metadata, and returns the full activationKey one time in the response.",
    "The resulting key can be activated by one device in v1 and all generation is audit logged."
  ].join(" "),
  "PATCH /api/v1/admin/single-keys/{id}/revoke": [
    "Toggles a single-user key between active and revoked states.",
    "Revoking also updates associated device activations so mobile refresh/check-in will report the revoked status.",
    "Reactivating restores active status but does not clear the existing device binding; use reset when a device needs to be replaced."
  ].join(" "),
  "PATCH /api/v1/admin/single-keys/{id}/reset": [
    "Clears the single-user license's device binding and deletes associated device activation rows.",
    "Use this when support needs to move a single-user license to a different iPhone.",
    "The key is returned to active/unbound state and the reset is audit logged."
  ].join(" "),
  "DELETE /api/v1/admin/single-keys/{id}": [
    "Permanently deletes a single-user license key and any associated device activations.",
    "Use this for cleanup of incorrectly generated keys, not for normal suspension; revoke is safer for reversible license blocking.",
    "The response includes how many activation rows were deleted."
  ].join(" "),

  "GET /api/v1/admin/enterprise-keys": [
    "Lists enterprise activation keys visible to the current admin.",
    "Each record includes tenant, partner, config profile and registered device activations so the admin UI can show license usage and assignment details.",
    "Partner admins are scoped to keys owned by their partner or tenants owned by their partner."
  ].join(" "),
  "POST /api/v1/admin/enterprise-keys": [
    "Generates a display-once enterprise activation key linked to a tenant and config profile.",
    "The backend stores only a key hash/prefix, copies partner ownership from the tenant, applies optional maxDevices and maintenance dates, and returns the full activationKey once.",
    "Devices activated with this key receive the tenant/customer assigned config profile on activation and refresh, with the key profile retained as a fallback."
  ].join(" "),
  "DELETE /api/v1/admin/enterprise-keys/{id}": [
    "Permanently deletes an enterprise activation key and registered device activations for that key.",
    "Use this for cleanup of wrongly generated enterprise keys; for active production tenants, revocation/disable workflows should be preferred when available.",
    "The response reports the number of activation records deleted."
  ].join(" "),

  "GET /api/v1/admin/tenants": [
    "Lists enterprise customer tenants visible to the current admin.",
    "Each tenant includes assigned config profile, partner, enterprise keys, activations and calculated licenseUsage with active device counts.",
    "This is the main customer register endpoint for the admin portal."
  ].join(" "),
  "POST /api/v1/admin/tenants": [
    "Creates an enterprise tenant/customer record with identity, contact, legal, billing and default config profile metadata.",
    "Partner admins automatically create tenants under their own partner scope.",
    "The tenant can later receive enterprise keys and template family entitlements."
  ].join(" "),
  "PATCH /api/v1/admin/tenants/{id}": [
    "Updates tenant/customer details such as contact information, status, assigned partner and default config profile.",
    "Partner admins can only update tenants inside their partner scope and cannot move a tenant to another partner.",
    "Changing the tenant config profile changes the effective policy returned to enterprise devices on their next activation refresh."
  ].join(" "),
  "DELETE /api/v1/admin/tenants/{id}": [
    "Deletes a tenant only when it has no enterprise keys, device activations, tenant-specific templates or template entitlements.",
    "This protects license history and template access relationships from accidental cascade deletion.",
    "For active customers, disable or update status instead of deleting."
  ].join(" "),
  "GET /api/v1/admin/license-usage": [
    "Returns enterprise license usage across visible tenants.",
    "The response includes global active unique-device count and per-tenant active device, total activation, licensed device and unlimited-license indicators.",
    "Use this for dashboards and license allocation screens."
  ].join(" "),

  "GET /api/v1/admin/config-profiles": [
    "Lists enterprise config/policy profiles visible to the current admin.",
    "Secrets such as provider API keys are masked in the admin response; write a new value to replace a saved secret.",
    "Profiles contain sparse managed policy fields, provider catalogs, privacy settings, repository settings and device behavior switches.",
    "Privacy-control, Presidio PII and privacy-review values are delivered to iOS only when their managedPolicy apply switches are true.",
    "The Personvern prompt text is delivered to iOS only when managedPolicy.managePrivacyPrompt is true; otherwise the app uses its built-in or local prompt."
  ].join(" "),
  "POST /api/v1/admin/config-profiles": [
    "Creates an enterprise config profile used by tenants and enterprise activation keys.",
    "The payload can manage speech providers, document generation, privacy control, Presidio, privacy review, template repository, telemetry and managedPolicy behavior.",
    "managedPolicy.hideSettings can be paired with visibleSettingsWhenHidden to keep specific app settings such as audio source, app UI language, privacy info, recording dimming, floating recording toolbar, OpenAI recording optimization, privacy prompt, live transcription and categories visible/editable.",
    "managedPolicy.hideRecordingFloatingToolbar hides the floating quick toolbar on the iOS New Recording screen while keeping recording itself available.",
    "visibleSettingsWhenHidden is only a visibility exception list; it does not centrally manage the setting value.",
    "Use managedPolicy.managePrivacyControl, managePIIControl and managePrivacyReviewProvider to decide whether saved privacy values are actually sent to devices.",
    "Only fields intentionally applied in the profile should be sent to the app as managed policy."
  ].join(" "),
  "POST /api/v1/admin/config-profiles/{id}/clone": [
    "Copies an existing config profile into a new profile, preserving provider settings, privacy settings, repository fields and managedPolicy flags.",
    "Secrets are copied server-side and remain masked in the returned admin response.",
    "Use cloning to create a tenant-specific variant from a known-good policy without re-entering every provider setting."
  ].join(" "),
  "POST /api/v1/admin/provider-models": [
    "Loads model identifiers from a provider endpoint for the config profile editor.",
    "Supports speech, document-generation and privacy-review domains using the provider type, endpoint URL and API key supplied by the admin UI.",
    "The endpoint probes the provider only; it does not save the selected model or credential."
  ].join(" "),
  "PATCH /api/v1/admin/config-profiles/{id}": [
    "Updates an existing config/policy profile.",
    "Masked secrets are preserved when the admin does not submit a replacement key; explicit empty values clear a managed secret.",
    "Use managedPolicy.visibleSettingsWhenHidden as the visibility exception list for settings that should remain visible when hideSettings is enabled. The language exception means app UI language, not speech transcription language or template/transcript output language. Include recording_floating_toolbar when the toolbar setting should remain visible, and privacy_prompt when the Personvern prompt UI should remain available.",
    "Use managedPolicy.managePrivacyControl, managePIIControl, managePrivacyReviewProvider and managePrivacyPrompt to decide whether saved privacy values and Personvern prompt text are actually sent to devices.",
    "Changes affect future enterprise activation/refresh/effective-config responses for tenants or keys using this profile."
  ].join(" "),
  "DELETE /api/v1/admin/config-profiles/{id}": [
    "Deletes a config profile only when no tenants or enterprise keys reference it.",
    "This prevents accidentally removing the policy used by activated devices.",
    "Use clone/update for policy evolution and delete only unused profiles."
  ].join(" "),

  "GET /api/v1/admin/template-families": [
    "Lists template repository families with their language variants, current draft, published version history and tenant entitlements.",
    "A family represents one use case across languages; each variant is one language-specific YAML track.",
    "Partner admins see global families plus families entitled to their tenants."
  ].join(" "),
  "POST /api/v1/admin/template-families": [
    "Creates a template family, the logical grouping used for translations and tenant entitlements.",
    "The family holds metadata such as title, description, category, icon, tags and global/tenant availability.",
    "Language-specific YAML is added through the variant endpoints."
  ].join(" "),
  "PATCH /api/v1/admin/template-families/{id}": [
    "Updates template family metadata such as title, description, category, icon, tags and global state.",
    "This does not by itself publish YAML changes; mobile clients only see published variants.",
    "The update is audit logged and respects partner template access scope."
  ].join(" "),
  "PATCH /api/v1/admin/template-families/{id}/archive": [
    "Archives a template family so it is hidden from mobile manifests and normal repository browsing.",
    "Published version history remains stored for audit/history, but archived families are not offered to entitled tenants.",
    "Use this to retire a use case without deleting historical template data."
  ].join(" "),
  "POST /api/v1/admin/template-families/{id}/variants": [
    "Creates a language-specific template variant draft inside a family.",
    "The YAML identity.language must match the requested variant language and identity.id becomes the app-facing template id.",
    "Creating a variant does not make it visible to mobile clients until the draft is published."
  ].join(" "),
  "PATCH /api/v1/admin/template-variants/{id}/draft": [
    "Updates the mutable draft YAML and optional sample transcript for one template variant.",
    "The backend validates/extracts YAML metadata, updates family display metadata, clears stale preview errors and audit logs the draft change.",
    "Draft changes are admin-only and do not affect mobile manifests/downloads until publish."
  ].join(" "),
  "POST /api/v1/admin/template-variants/{id}/publish": [
    "Publishes the current draft of a template variant.",
    "The backend validates the YAML schema, applies the selected semver bump, writes an immutable published snapshot and makes that version available to entitled mobile clients.",
    "Publication is explicit; AI assist and preview generation never auto-publish."
  ].join(" "),
  "GET /api/v1/admin/template-variants/{id}/versions": [
    "Returns immutable published version history for a template variant.",
    "Use this for admin history, rollback inspection and audit workflows.",
    "Mobile clients receive only the latest entitled published version in the manifest."
  ].join(" "),
  "POST /api/v1/admin/template-families/{id}/entitlements": [
    "Assigns a template family to a tenant so that tenant's enterprise activations can see the family in the mobile manifest.",
    "Entitlement is stored at the family level; the app receives only the entitled language variants it can use.",
    "The endpoint is idempotent through upsert and is audit logged."
  ].join(" "),
  "DELETE /api/v1/admin/template-families/{familyId}/entitlements/{tenantId}": [
    "Removes a tenant's entitlement to a template family.",
    "After removal, future manifest requests for that tenant no longer include the family's published variants unless the family is global.",
    "Existing app-local copies are not deleted by the backend; the app should handle repository update/removal UX locally."
  ].join(" "),
  "POST /api/v1/admin/template-drafts/ai-assist": [
    "Generates a reviewable template draft proposal from an admin-provided use-case description.",
    "The result follows the current YAML schema and may include title, category, sections, content rules and sample transcript suggestions.",
    "The proposal is never saved or published automatically; an admin must review and apply it."
  ].join(" "),
  "POST /api/v1/admin/template-drafts/{id}/preview": [
    "Generates a real AI preview for the current draft and sample transcript using the centrally configured preview provider.",
    "Preview generation is manual, stores the latest result/error on the draft, and returns rendered markdown plus provider/model metadata.",
    "This is an admin design-time preview and does not publish the template."
  ].join(" "),
  "GET /api/v1/admin/template-drafts/{id}/preview": [
    "Returns the latest stored preview result for a template draft.",
    "Use this when reopening the designer so the admin can see the last generated markdown, provider/model metadata and generation timestamp.",
    "No provider call is made by this endpoint."
  ].join(" "),

  "GET /api/v1/admin/templates": [
    "Legacy direct-template endpoint retained for compatibility with early Template/TemplateVersion data and seed records.",
    "The current admin template designer and mobile template repository use template families, variants, drafts and published versions instead.",
    "Do not build new workflows on this endpoint; use GET /api/v1/admin/template-families for current repository management."
  ].join(" "),
  "POST /api/v1/admin/templates": [
    "Legacy direct-template create endpoint retained so old operational scripts and seed-compatible data can still be maintained.",
    "The current supported authoring path is POST /api/v1/admin/template-families followed by POST /api/v1/admin/template-families/{id}/variants.",
    "New admin UI work should not create direct Template/TemplateVersion records."
  ].join(" "),
  "PATCH /api/v1/admin/templates/{id}": [
    "Legacy direct-template update endpoint for the old Template/TemplateVersion model.",
    "When version and yamlContent are supplied, the backend validates the YAML and creates another TemplateVersion record.",
    "Current template repository updates should use PATCH /api/v1/admin/template-variants/{id}/draft and explicit variant publish."
  ].join(" "),
  "POST /api/v1/admin/templates/{id}/publish/{versionId}": [
    "Legacy direct-template publish endpoint for old TemplateVersion records.",
    "The backend validates YAML schema, marks the version as published and updates the template's publishedVersionId.",
    "Current repository publishing should use POST /api/v1/admin/template-variants/{id}/publish."
  ].join(" "),
  "PATCH /api/v1/admin/templates/{id}/archive": [
    "Legacy direct-template archive endpoint.",
    "Archived direct templates retain historical versions but are not part of the current family/variant repository workflow.",
    "Current repository retirement should archive template families through PATCH /api/v1/admin/template-families/{id}/archive."
  ].join(" "),

  "GET /api/v1/admin/template-categories": [
    "Lists reusable template categories used by template families and direct template metadata.",
    "Categories provide stable slugs/titles plus SF Symbol icons for catalog grouping, the admin designer category dropdown and the enterprise mobile config templateCategories catalog.",
    "The list is sorted by sortOrder and then title; the same order is returned to the iOS app when categories are centrally managed."
  ].join(" "),
  "POST /api/v1/admin/template-categories": [
    "Creates a reusable template category.",
    "Superadmin-only endpoint; slugs are normalized and used by template metadata, YAML identity.category values and manifest category values.",
    "The icon field stores an SF Symbol name, and sortOrder controls category display ordering in admin and mobile config payloads."
  ].join(" "),
  "PATCH /api/v1/admin/template-categories/{id}": [
    "Updates a template category's slug, title, icon, sort order or description.",
    "Superadmin-only endpoint; existing templates keep their category relationship by id while display metadata changes.",
    "Slug changes should be coordinated with YAML/editor expectations because template YAML identity.category and mobile manifest category should use the same canonical value."
  ].join(" "),
  "DELETE /api/v1/admin/template-categories/{id}": [
    "Deletes a template category only if no direct templates or template families use it.",
    "Superadmin-only endpoint; this guard prevents orphaned category references.",
    "Use update/rename when a category is active."
  ].join(" "),
  "GET /api/v1/admin/template-section-presets": [
    "Lists reusable template section presets shown in the template designer's add-section flow.",
    "Presets include title, purpose, format, required/default flags, sort order and extraction hints.",
    "They are catalog building blocks only; editing presets does not rewrite existing YAML drafts."
  ].join(" "),
  "POST /api/v1/admin/template-section-presets": [
    "Creates a reusable template section preset for the designer.",
    "Superadmin-only endpoint; presets help admins build consistent template sections without hand-writing YAML every time.",
    "The preset becomes available for future draft editing."
  ].join(" "),
  "PATCH /api/v1/admin/template-section-presets/{id}": [
    "Updates a template section preset's display and default section fields.",
    "Superadmin-only endpoint; changes affect new uses of the preset in the designer.",
    "Existing template YAML remains unchanged until an admin edits it."
  ].join(" "),
  "DELETE /api/v1/admin/template-section-presets/{id}": [
    "Deletes a reusable template section preset from the designer catalog.",
    "Superadmin-only endpoint; existing template YAML is not changed and no published versions are modified.",
    "Use this to remove confusing or unused section building blocks."
  ].join(" "),
  "GET /api/v1/admin/template-tags": [
    "Lists the shared colored tag catalog used by template families and the template designer.",
    "Tags include slug, name, color and optional description so UI chips can be consistent everywhere.",
    "Template records store tag slugs, allowing rename/recolor workflows to propagate through catalog lookup."
  ].join(" "),
  "POST /api/v1/admin/template-tags": [
    "Creates a reusable colored template tag in the shared catalog.",
    "Superadmin-only endpoint; duplicate normalized tag names are rejected to avoid ambiguous chips.",
    "New tags can be selected immediately on template families and drafts."
  ].join(" "),
  "PATCH /api/v1/admin/template-tags/{id}": [
    "Updates a reusable template tag's name, color or description.",
    "Superadmin-only endpoint; when the name changes, current template family and draft tag references are rewritten to the new normalized slug.",
    "This keeps tag chips consistent without dead references."
  ].join(" "),
  "DELETE /api/v1/admin/template-tags/{id}": [
    "Deletes a reusable template tag from the catalog and removes that tag slug from current family/draft references.",
    "Superadmin-only endpoint; this is a global cleanup action, not just removal from one template.",
    "Use with care when tags are actively used for catalog filtering."
  ].join(" "),

  "GET /api/v1/admin/activations": [
    "Lists device activations visible to the current admin.",
    "Records include single-license or enterprise-key context, device identifier, serial number, app version, status and lastSeenAt/check-in timestamps.",
    "Use this to inspect license usage and device registrations."
  ].join(" "),
  "DELETE /api/v1/admin/activations/{id}": [
    "Deletes one enterprise device activation to free a device slot for that enterprise key/tenant.",
    "Single-user activations cannot be deleted directly because their binding must be reset from the single-license key.",
    "The deletion is audit logged with key, tenant and device metadata."
  ].join(" "),
  "GET /api/v1/admin/audit-logs": [
    "Lists recent activation, license, tenant, config, template, settings and admin-user audit events.",
    "Superadmins/staff see global events; partner admins are scoped to events created under their partner/admin access.",
    "Use this for operational traceability rather than as an analytics endpoint."
  ].join(" "),

  "GET /api/v1/health": [
    "Checks whether the API process is running and can successfully query PostgreSQL.",
    "Use this for APISIX upstream health checks, deployment smoke tests and production-like verification.",
    "A successful response includes ok=true, service name and server timestamp."
  ].join(" ")
};

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

const legacyDirectTemplateReplacement = "Use /api/v1/admin/template-families, /api/v1/admin/template-families/{id}/variants, /api/v1/admin/template-variants/{id}/draft and /api/v1/admin/template-variants/{id}/publish.";

const operationMetadata: Record<string, OperationMetadata> = {
  "GET /api/v1/admin/templates": {
    deprecated: true,
    "x-skrivdet-status": "legacy",
    "x-skrivdet-replacement": "GET /api/v1/admin/template-families"
  },
  "POST /api/v1/admin/templates": {
    deprecated: true,
    "x-skrivdet-status": "legacy",
    "x-skrivdet-replacement": legacyDirectTemplateReplacement
  },
  "PATCH /api/v1/admin/templates/{id}": {
    deprecated: true,
    "x-skrivdet-status": "legacy",
    "x-skrivdet-replacement": legacyDirectTemplateReplacement
  },
  "POST /api/v1/admin/templates/{id}/publish/{versionId}": {
    deprecated: true,
    "x-skrivdet-status": "legacy",
    "x-skrivdet-replacement": "POST /api/v1/admin/template-variants/{id}/publish"
  },
  "PATCH /api/v1/admin/templates/{id}/archive": {
    deprecated: true,
    "x-skrivdet-status": "legacy",
    "x-skrivdet-replacement": "PATCH /api/v1/admin/template-families/{id}/archive"
  }
};

export function enrichOpenApiDescriptions<T extends OpenApiLike>(document: T): T {
  if (!document.paths || typeof document.paths !== "object") return document;

  for (const [path, pathItem] of Object.entries(document.paths as Record<string, unknown>)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!HTTP_METHODS.has(method)) continue;
      const operationKey = `${method.toUpperCase()} ${path}`;
      if (operation && typeof operation === "object") {
        const operationDoc = operation as OperationDoc & { parameters?: unknown };
        const description = operationDescriptions[operationKey];
        if (description) operationDoc.description = description;

        const metadata = operationMetadata[operationKey];
        if (metadata) Object.assign(operationDoc, metadata);

      }
    }
  }
  return document;
}
