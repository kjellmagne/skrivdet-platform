# skrivDET Backend

Internal/admin-controlled backend monorepo for skrivDET licensing, enterprise configuration, and YAML template management.

## Local Development

Docker is not required for daily development. Run PostgreSQL locally on your machine and point `DATABASE_URL` at it.

Required tools:

- Node.js 22+
- pnpm via Corepack: `corepack enable`
- PostgreSQL 15+

Setup:

```bash
cd /Users/kjellmagnegabrielsen/Kvasetech_Dev/skrivdet-platform
cp .env.example .env
pnpm install
pnpm prisma:migrate
pnpm prisma:seed
pnpm dev:api
```

In another terminal:

```bash
cd /Users/kjellmagnegabrielsen/Kvasetech_Dev/skrivdet-platform
pnpm dev:admin
```

Default local URLs:

- API: `http://localhost:4000/api/v1`
- Swagger: `http://localhost:4000/api/docs`
- OpenAPI JSON: `http://localhost:4000/api/docs-json`
- Admin UI: `http://localhost:3000`

The OpenAPI document is the canonical API reference for both mobile and admin
integrations. Every exposed operation should have a summary, a full description,
request/response shape, authentication notes, and examples where the payload is
part of the mobile contract. Legacy compatibility endpoints are kept in the
spec, but marked as deprecated with `x-skrivdet-status: legacy` and a replacement
hint instead of being removed.

Seed admin user:

- Email: `admin@skrivdet.local`
- Password: `ChangeMe123!`

To choose a different first admin password during seeding:

```bash
SEED_ADMIN_PASSWORD='YourStrongPassword123!' pnpm prisma:seed
```

Useful scripts:

```bash
pnpm dev:api
pnpm dev:admin
pnpm build
pnpm lint
pnpm test
pnpm prisma:migrate
pnpm prisma:seed
```

## API Examples

Newly generated activation keys use the `SKRIVDET-S` and `SKRIVDET-E`
prefixes. Existing `ULFY-S` and `ULFY-E` keys remain valid because activation
checks use the stored key hash, not a hard-coded brand prefix.

Single activation:

```bash
curl -X POST http://localhost:4000/api/v1/activate/single \
  -H 'Content-Type: application/json' \
  -d '{"activationKey":"SKRIVDET-S-...","deviceIdentifier":"iphone-abc","deviceSerialNumber":"C39XK123N72Q","appVersion":"1.0.0"}'
```

Enterprise activation:

```bash
curl -X POST http://localhost:4000/api/v1/activate/enterprise \
  -H 'Content-Type: application/json' \
  -d '{"activationKey":"SKRIVDET-E-...","deviceIdentifier":"iphone-enterprise-1","deviceSerialNumber":"C39XK123N72Q","appVersion":"1.0.0"}'
```

License refresh/check-in:

```bash
curl -X POST http://localhost:4000/api/v1/activation/refresh \
  -H 'Content-Type: application/json' \
  -d '{"activationToken":"...","deviceIdentifier":"iphone-enterprise-1","deviceSerialNumber":"C39XK123N72Q","appVersion":"1.0.1"}'
```

`deviceIdentifier` is the stable value used for license binding and unique-device counts. `deviceSerialNumber` is stored for admin support/audit when the app or MDM environment can provide it. Each activation and refresh updates `lastSeenAt` on the device activation record.

Dedicated license details:

```bash
curl http://localhost:4000/api/v1/license/details \
  -H "Authorization: Bearer <activation-token>"
```

Effective config with license metadata:

```bash
curl http://localhost:4000/api/v1/config/effective \
  -H "Authorization: Bearer <activation-token>"
```

Mobile-facing errors use this shape:

```json
{
  "success": false,
  "error": {
    "code": "activation_key_invalid",
    "message": "Activation key not found"
  }
}
```

Sample enterprise activation payload:

```json
{
  "success": true,
  "activationToken": "...",
  "activationId": "...",
  "license": {
    "type": "enterprise",
    "status": "active",
    "registeredToName": "Acme Health AS",
    "registeredToEmail": "kari@acme-health.example",
    "activatedAt": "2026-04-29T10:15:00.000Z",
    "maintenanceActive": true,
    "maintenanceUntil": "2027-04-29T00:00:00.000Z"
  },
  "tenant": { "id": "...", "name": "Acme Health", "slug": "acme-health" },
  "device": {
    "deviceIdentifier": "iphone-enterprise-1",
    "deviceSerialNumber": "C39XK123N72Q",
    "lastSeenAt": "2026-04-29T10:15:00.000Z"
  },
  "config": {
    "id": "00000000-0000-0000-0000-000000000101",
    "name": "Default Enterprise Profile",
    "speechProviderType": "azure",
    "speechEndpointUrl": "https://kvasetech.com/stt",
    "speechApiKey": "optional-managed-speech-key",
    "privacyControlEnabled": true,
    "piiControlEnabled": true,
    "documentGenerationProviderType": "openai_compatible",
    "documentGenerationEndpointUrl": "https://kvasetech.com/ollama",
    "documentGenerationApiKey": "optional-managed-docgen-key",
    "templateRepositoryUrl": "http://localhost:4000/api/v1/templates/manifest",
    "featureFlags": { "developerMode": false, "allowExternalProviders": false },
    "allowedProviderRestrictions": ["azure", "openai_compatible", "local_heuristic"],
    "managedPolicy": {
      "allowPolicyOverride": false,
      "hideSettings": false,
      "hideRecordingFloatingToolbar": false,
      "visibleSettingsWhenHidden": [
        "live_transcription_during_recording",
        "audio_source",
        "language",
        "privacy_info",
        "dim_screen_during_recording",
        "recording_floating_toolbar",
        "optimize_openai_recording",
        "privacy_prompt",
        "categories"
      ],
      "userMayChangeSpeechProvider": false,
      "userMayChangeFormatter": false,
      "managePrivacyControl": true,
      "userMayChangePrivacyControl": false,
      "managePIIControl": true,
      "userMayChangePIIControl": false,
      "managePrivacyReviewProvider": true,
      "userMayChangePrivacyReviewProvider": false,
      "managePrivacyPrompt": false,
      "manageTemplateCategories": true
    }
  }
}
```

Template manifest:

```bash
curl http://localhost:4000/api/v1/templates/manifest \
  -H "Authorization: Bearer <enterprise-activation-token>"
```

Sample manifest response:

```json
{
  "name": "Enterprise Templates",
  "templates": [
    {
      "id": "00000000-0000-4000-8000-000000000201",
      "title": "Personlig diktat / logg",
      "short_description": "Kort strukturert logg fra personlig diktat.",
      "category": "personlig_diktat",
      "language": "nb-NO",
      "version": "1.0.0",
      "icon": "waveform.and.mic",
      "tags": ["dictation", "personal"],
      "download_url": "/api/v1/templates/00000000-0000-4000-8000-000000000201/download",
      "updated_at": "2026-04-29T12:00:00.000Z"
    }
  ]
}
```

Single-user activations are intentionally blocked from the central repository. Enterprise catalog and download calls are filtered by the tenant tied to the activation token. Internal/dev verification can use `Authorization: Bearer <TEMPLATE_REPOSITORY_API_KEY>` when that override is explicitly configured.

Config profiles keep provider domains separate:

- Speech: `local`, `apple_online`, `openai`, `azure`, `gemini`
- Document generation / formatter: `apple_intelligence`, `openai`, `ollama`, `openai_compatible`, `gemini`, `claude`
- Privacy review / guardrail: `local_heuristic`, `ollama`, `openai_compatible` are the recommended v1 choices
- Presidio PII is configured separately from privacy review
- Optional managed provider credentials are `speechApiKey` and `documentGenerationApiKey`. Prefer internal gateway endpoints or tenant-scoped keys when these fields are sent to mobile devices.
- The admin UI defaults Azure Speech to `https://kvasetech.com/stt`, Ollama/OpenAI-compatible formatter endpoints to `https://kvasetech.com/ollama`, and OpenAI formatter to `https://api.openai.com/v1` with `gpt-5-mini`. Ollama and OpenAI-compatible models are intentionally left blank until selected from the fetched model list or typed manually.
- The local AI server also exposes vLLM as an OpenAI-compatible endpoint at `http://192.168.222.171:8000/v1`. The currently served model id is `gemma-4-26b-a4b-it`; configure it as `openai_compatible` in provider profiles.

Leave provider fields blank when the backend should not manage that setting for the tenant.

Admin config/policy endpoints require a bearer token from `/api/v1/auth/login`.

Managed-policy behavior:

- `allowPolicyOverride` is the master local bypass. Keep it false for strict enterprise policy.
- `hideSettings` asks the iOS app to minimize the Settings screen for managed enterprise users.
- `visibleSettingsWhenHidden` is only a visibility exception list. It can keep specific local rows visible while `hideSettings` is true, but it does not make a centrally managed value editable.
- `hideRecordingFloatingToolbar` hides the quick floating toolbar on the iOS New Recording screen. Recording still works; users rely on managed defaults or the normal Settings screen instead.
- `recording_floating_toolbar` is the visibility-exception key for the local `Show floating toolbar` setting when most settings are hidden.
- Privacy-control values are sent to devices only when their apply switches are enabled: `managePrivacyControl`, `managePIIControl`, `managePrivacyReviewProvider`, and `managePrivacyPrompt`.
- Template categories are sent when `manageTemplateCategories` is true, which is the enterprise default.
- The backend accepts compatibility aliases such as `hideRecordingToolbar`, `hideNewRecordingToolbar`, and `hideFloatingRecordingToolbar`, but mobile payloads should use `hideRecordingFloatingToolbar`.

Clone an existing policy/config profile:

```bash
TOKEN='admin-jwt-from-login'

curl -X POST http://localhost:4000/api/v1/admin/config-profiles/<config-profile-id>/clone \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Copy of Strict enterprise policy"}'
```

The clone endpoint copies managed provider fields, API keys, privacy settings, repository settings, feature flags, provider profile metadata, and managed policy switches. It does not copy tenants or enterprise keys that reference the original policy.

List live provider models while editing a policy:

```bash
curl -X POST http://localhost:4000/api/v1/admin/provider-models \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "providerDomain": "document_generation",
    "providerType": "openai_compatible",
    "endpointUrl": "https://kvasetech.com/ollama",
    "apiKey": "provider-or-gateway-key"
  }'
```

Sample model lookup response:

```json
{
  "success": true,
  "providerType": "openai_compatible",
  "models": [
    { "id": "skrivdet-docgen", "name": "skrivdet-docgen" }
  ]
}
```

Model lookup support:

- `openai` and `openai_compatible` use an OpenAI-compatible `/models` endpoint.
- `ollama` uses `/api/tags`.
- `gemini` uses the Google model-list endpoint.
- `claude` uses the Anthropic model-list endpoint.
- `local`, `apple_online`, `apple_intelligence`, `local_heuristic`, and Azure Speech do not expose useful remote model lists in v1.

## Admin UI

The admin UI supports:

- Admin login
- Current logged-in user display and logout
- Superadmin user management for staff and partner admins
- Solution partner management
- Single-user key generation
- Enterprise key generation
- Maintenance/support expiry dates on generated keys
- Enterprise customer/tenant registration
- Active unique-device license usage counts
- Activation inspection
- Single and enterprise key revoke/reactivate/delete flows
- Enterprise device activation inspection and deletion
- Config profile creation, editing, deletion, and cloning
- Provider model lookup directly from the policy editor
- Policy editing with speech, formatter, Presidio PII, and privacy review kept as separate provider domains
- Device behavior policy switches for hiding most app settings, hiding the iOS recording floating toolbar, and allowing local policy override
- Optional managed provider API keys for speech and document generation formatter
- Template family, language-variant and YAML draft editing
- Template category and reusable section-preset settings
- SF Symbol-style icon picker for templates
- Tenant entitlement assignment for enterprise repository access
- YAML validation before save and publish
- Admin-chosen semver publish flow with immutable version history
- Manual AI preview generation from a saved draft and sample transcript
- Audit log listing

There are no public signup, billing, self-service onboarding, or tenant portal routes.

## API Surface Status

Current mobile app endpoints:

- `POST /api/v1/activate/single`
- `POST /api/v1/activate/enterprise`
- `POST /api/v1/activation/refresh`
- `GET /api/v1/config/effective`
- `GET /api/v1/license/details`
- `GET /api/v1/templates/manifest`
- `GET /api/v1/templates/{id}/download`

Current admin portal endpoints are `/api/v1/auth/login` plus the `/api/v1/admin/*`
route family. The supported template repository workflow is:

- `GET/POST/PATCH /api/v1/admin/template-families`
- `POST /api/v1/admin/template-families/{id}/variants`
- `PATCH /api/v1/admin/template-variants/{id}/draft`
- `POST /api/v1/admin/template-variants/{id}/publish`
- `GET /api/v1/admin/template-variants/{id}/versions`
- `POST /api/v1/admin/template-families/{id}/entitlements`
- `DELETE /api/v1/admin/template-families/{familyId}/entitlements/{tenantId}`

Legacy compatibility endpoints still exist so old data, seed records, or
operational scripts do not break:

- `GET/POST /api/v1/admin/templates`, `PATCH /api/v1/admin/templates/{id}`,
  `POST /api/v1/admin/templates/{id}/publish/{versionId}`, and
  `PATCH /api/v1/admin/templates/{id}/archive` are the old direct
  `Template`/`TemplateVersion` model. The current admin template designer does
  not use these for new work; use family/variant/draft/publish endpoints instead.

Do not remove legacy endpoints without a separate migration and deprecation
window. For now they are documented, marked deprecated in OpenAPI, and protected
by tests so their status is visible without breaking existing callers.

## Docker Deployment

Docker is included for deployment, pull-down setup, server packaging, and production-like verification. It is not the primary local development path.

```bash
cd /Users/kjellmagnegabrielsen/Kvasetech_Dev/skrivdet-platform
cp infra/.env.example infra/.env
docker compose --env-file infra/.env -f infra/docker-compose.yml build
docker compose --env-file infra/.env -f infra/docker-compose.yml up -d
```

Run migrations and seed inside the deployment stack:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.yml run --rm api pnpm prisma migrate deploy
docker compose --env-file infra/.env -f infra/docker-compose.yml run --rm api pnpm prisma:encrypt-secrets
docker compose --env-file infra/.env -f infra/docker-compose.yml run --rm api pnpm prisma db seed
```

For an Ubuntu server behind APISIX, use the server compose file instead. It keeps Postgres private and only binds API/admin to localhost:

```bash
cp infra/.env.server.example infra/.env.server
docker compose --env-file infra/.env.server -f infra/docker-compose.server.yml build
docker compose --env-file infra/.env.server -f infra/docker-compose.server.yml up -d
docker compose --env-file infra/.env.server -f infra/docker-compose.server.yml run --rm api pnpm prisma migrate deploy
docker compose --env-file infra/.env.server -f infra/docker-compose.server.yml run --rm api pnpm prisma:encrypt-secrets
docker compose --env-file infra/.env.server -f infra/docker-compose.server.yml run --rm api pnpm prisma db seed
```

APISIX can route the same public HTTPS hostname to both services:

```bash
APISIX_ADMIN_KEY='your-admin-key' bash infra/apisix/skrivdet-domain-routes.sh
```

The APISIX helper scripts now prefer `SKRIVDET_*` environment variable names and
still fall back to the older `ULFY_*` names where live hosts have not been
cleaned up yet.

To pull prebuilt app images from GitHub Container Registry instead of building on the server, use:

```bash
cp infra/.env.server.example infra/.env.server
sudo mkdir -p /opt/ulfy-data/postgres
sudo chown -R "$USER:$USER" /opt/ulfy-data
docker compose --env-file infra/.env.server -f infra/docker-compose.ghcr.yml pull
docker compose --env-file infra/.env.server -f infra/docker-compose.ghcr.yml up -d postgres
docker compose --env-file infra/.env.server -f infra/docker-compose.ghcr.yml run --rm api pnpm prisma migrate deploy
docker compose --env-file infra/.env.server -f infra/docker-compose.ghcr.yml run --rm api pnpm prisma:encrypt-secrets
docker compose --env-file infra/.env.server -f infra/docker-compose.ghcr.yml run --rm api pnpm prisma db seed
docker compose --env-file infra/.env.server -f infra/docker-compose.ghcr.yml up -d api admin
```

Important: after pulling a new API image, run `pnpm prisma migrate deploy` before relying on the admin UI. If the image expects a newer Prisma schema than the database, admin list endpoints can fail with Prisma `P2022` missing-column errors.

On older Ubuntu hosts using legacy `docker-compose` 1.x, container recreation may fail after image updates. A safe pull/recreate sequence is:

```bash
cd /opt/skrivdet-platform
sudo docker-compose pull api admin
sudo docker-compose run --rm -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 api pnpm prisma migrate deploy
sudo docker-compose run --rm -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 api pnpm prisma:encrypt-secrets
sudo docker rm -f skrivdet-platform_api_1 skrivdet-platform_admin_1
sudo docker-compose up -d --no-deps api admin
```

The public skrivDET deployment serves the product website at `https://skrivdet.no/`, the backend admin at `https://skrivdet.no/backend/`, and the canonical public API at `https://api.skrivdet.no/api/v1/`.

Important routing rule:

- Canonical API host: `api.skrivdet.no/api/*` is proxied directly to the API, so the API receives `/api/*`.
- API route: `/backend/api/*` is proxied to the API after stripping `/backend`, so the API receives `/api/*`.
- Admin route: `/backend` and `/backend/*` is proxied to the admin after stripping `/backend`, so Next.js receives `/`, `/templates`, and `/_next/*`. The admin image uses `NEXT_PUBLIC_BASE_PATH=/backend` as an asset/link prefix, not as a Next.js `basePath`.
- Public product website route: `/` and `/*` on `skrivdet.no`/`www.skrivdet.no` is proxied to the website container on port `8080`.
- Website asset compatibility route: `/skrivdet/assets/*` on `skrivdet.no`/`www.skrivdet.no` strips `/skrivdet` before proxying to the website container. This supports the current website image, which was originally built for the old `/skrivdet` mount path.
- Legacy mobile API compatibility: stale `kvasetech.com/api/*`, `kvasetech.com/backend/api/*`, `kvasetech.com/skrivdet/api/*`, and `kvasetech.com/ulfy/api/*` paths are proxied to the API without redirecting, so mobile Authorization headers are preserved while old app/profile data is refreshed.

```bash
docker compose --env-file .env -f docker-compose.yml pull
docker compose --env-file .env -f docker-compose.yml up -d postgres
docker compose --env-file .env -f docker-compose.yml run --rm api pnpm prisma migrate deploy
docker compose --env-file .env -f docker-compose.yml run --rm api pnpm prisma db seed
docker compose --env-file .env -f docker-compose.yml up -d api admin
APISIX_ADMIN_KEY='your-admin-key' bash infra/apisix/skrivdet-domain-routes.sh
APISIX_ADMIN_KEY='your-admin-key' bash infra/apisix/kvasetech-legacy-redirects.sh
```

Issue and install the Let's Encrypt certificate after DNS for `skrivdet.no`, `www.skrivdet.no`, and `api.skrivdet.no` resolves to the APISIX host:

```bash
sudo APISIX_ADMIN_KEY='your-admin-key' LETSENCRYPT_EMAIL='ops@example.com' bash infra/apisix/issue-skrivdet-letsencrypt.sh
```

After the cutover, legacy `https://kvasetech.com/backend*`, `https://kvasetech.com/skrivdet*`, and `https://kvasetech.com/ulfy*` redirect permanently to the equivalent `https://skrivdet.no` URLs.

Verify the deployed routing after pulling a new admin image:

```bash
bash infra/apisix/check-skrivdet-backend.sh
```

This check fails if either the template list or the full template designer route serves root `/_next/...` assets instead of `/backend/_next/...`.

Public API documentation is available through APISIX at:

- Swagger UI: `https://api.skrivdet.no/api/docs` (protected with HTTP basic auth in production)
- OpenAPI JSON: `https://api.skrivdet.no/api/docs-json`

The admin same-origin API path remains available at `https://skrivdet.no/backend/api/v1/...` for the admin UI and older clients.

## GitHub Docker Images

GitHub Actions builds Docker images on pushes to `main`, version tags like `v1.0.0`, manual workflow runs, and pull requests. Pull requests build images for verification only. Pushes to `main` and tags publish images to GitHub Container Registry.

The current registry package names use the renamed platform repository:

- `ghcr.io/kjellmagne/skrivdet-platform-api:latest`
- `ghcr.io/kjellmagne/skrivdet-platform-admin:latest`
- `ghcr.io/kjellmagne/skrivdet-platform-api:sha-<commit>`
- `ghcr.io/kjellmagne/skrivdet-platform-admin:sha-<commit>`

Production was migrated to these `skrivdet-platform-*` images on 2026-05-10. The production Postgres database name, user, and data path still use legacy `ulfy` identifiers to preserve the existing data volume.

The GitHub admin image is built for the APISIX `/backend` mount by default. It uses `NEXT_PUBLIC_BASE_PATH=/backend` at build time for public links and `_next` asset URLs, while APISIX strips `/backend` before forwarding admin requests to Next.js. It leaves `NEXT_PUBLIC_API_BASE_URL` empty, so browser requests go to the same public origin as `/backend/api/v1/...`. If you set `NEXT_PUBLIC_API_BASE_URL`, use the canonical API origin, for example `https://api.skrivdet.no`.

Required deployment environment variables:

- `DATABASE_URL` for non-compose deployments
- `JWT_SECRET`
- optional `JWT_PREVIOUS_SECRETS` as a comma-separated verification-only rollover list during secret rotation
- `ACTIVATION_TOKEN_SECRET`
- optional `ACTIVATION_TOKEN_PREVIOUS_SECRETS` as a comma-separated verification-only rollover list during activation-token secret rotation
- `CONFIG_SECRET_KEY` as a 32-byte AES key encoded as hex, base64, or base64url
- `CORS_ALLOWED_ORIGINS` with the allowed browser origins, for example `https://skrivdet.no,https://www.skrivdet.no`
- `SWAGGER_ENABLED` plus `SWAGGER_BASIC_AUTH_USERNAME` and `SWAGGER_BASIC_AUTH_PASSWORD` when Swagger should stay exposed in production
- `PUBLIC_BASE_PATH` when serving the admin under a gateway prefix such as `/backend`
- AI preview provider is normally configured in the admin portal under `Settings` by a superadmin. `TEMPLATE_PREVIEW_ENDPOINT_URL`, `TEMPLATE_PREVIEW_API_KEY`, and `TEMPLATE_PREVIEW_MODEL` remain optional deployment fallbacks.
- optional `TEMPLATE_REPOSITORY_API_KEY` for internal repository override access

## v1 Simplifications

- Partner-admin scoping is represented in the model but not fully enforced on every admin list endpoint.
- Config profiles are manually managed JSON-backed records, without an advanced policy engine.
- Activation tokens are short-lived signed device credentials. The API verifies signature, issuer, audience, expiry, and device/license claims on every use, then rotates the token on refresh.
- Secret rotation can be staged by setting `JWT_PREVIOUS_SECRETS` or `ACTIVATION_TOKEN_PREVIOUS_SECRETS`; the API verifies with both current and previous values, but always reissues tokens with the current secret.
- Existing plaintext config-provider secrets should be backfilled with `pnpm prisma:encrypt-secrets` after deploy. New admin saves are encrypted automatically at rest.
- The mobile app still owns local template forking/update behavior; the backend provides the authoritative published repository, tenant filtering, history, and preview tooling.
- AI preview uses one centrally configured OpenAI-compatible preview provider/model. It is managed by superadmins in Settings, with environment variables kept as deployment fallbacks.
