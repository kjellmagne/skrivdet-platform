import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { JwtService } from "@nestjs/jwt";
import { TemplatesService } from "../src/templates/templates.service";
import { issueActivationToken } from "../src/activation/activation-token";
import { seedTemplates, templateYaml } from "../../../prisma/seed";

const validYaml = `identity:
  id: 00000000-0000-4000-8000-000000000201
  title: Personlig diktat / logg
  icon: waveform.and.mic
  short_description: Kort strukturert logg.
  category: personlig_diktat
  tags:
    - dictation
    - personal
  language: nb-NO
  version: 1.0.0
context:
  purpose: Create a clear note from the transcript.
  typical_participants:
    - role: speaker
  goals: []
  related_processes: []
perspective:
  voice: third_person
  audience: self
  tone: semi_formell
  style_rules:
    - Do not invent facts.
  preserve_original_voice: false
structure:
  sections:
    - title: Summary
      purpose: Summarize the transcript.
      format: prose
      required: true
      extraction_hints: []
content_rules:
  required_elements: []
  exclusions: []
  uncertainty_handling: Mark unclear information.
  speaker_attribution: none
llm_prompting:
  fallback_behavior: Say when a section was not covered.
  post_processing:
    extract_action_items: true
`;

describe("TemplatesService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/test?schema=public");
    vi.stubEnv("JWT_SECRET", "j".repeat(64));
    vi.stubEnv("ACTIVATION_TOKEN_SECRET", "a".repeat(64));
    vi.stubEnv("CONFIG_SECRET_KEY", Buffer.alloc(32, 11).toString("base64"));
  });

  it("validates the iOS app YAML schema", () => {
    const service = new TemplatesService({} as any, {} as any, new JwtService());
    const parsed = service.validateYamlContent(validYaml);
    expect(parsed.identity.title).toBe("Personlig diktat / logg");
    expect(parsed.structure.sections[0].title).toBe("Summary");
  });

  it("rejects unsupported root fields", () => {
    const service = new TemplatesService({} as any, {} as any, new JwtService());
    expect(() => service.validateYamlContent(`${validYaml}\nrepository_metadata:\n  tenant: acme\n`)).toThrow();
  });

  it("publishes YAML in the app-compatible subset without block scalar chomp indicators", () => {
    const service = new TemplatesService({} as any, {} as any, new JwtService());
    const multilineYaml = validYaml.replace(
      "      purpose: Summarize the transcript.",
      [
        "      purpose: |-",
        "        Role: Clean up the raw speech-to-text transcript.",
        "",
        "        Task: Keep the speaker voice and format turns clearly."
      ].join("\n")
    );

    const normalized = service.yamlWithVersion(multilineYaml, "1.0.1");

    expect(normalized).not.toContain("|-");
    expect(normalized).toContain("\\n\\nTask:");
    expect(normalized).toContain("version: \"1.0.1\"");
    expect(service.validateYamlContent(normalized).structure.sections[0].purpose).toContain("Task: Keep");
  });

  it("returns tenant-filtered manifest entries for enterprise activations", async () => {
    const activationToken = await issueActivationToken(new JwtService(), {
      kind: "enterprise",
      licenseId: "enterprise-key-1",
      deviceIdentifier: "ios-device-1"
    });
    const prisma = {
      deviceActivation: {
        findUnique: vi.fn().mockResolvedValue({
          id: "activation-1",
          kind: "enterprise",
          status: "active",
          deviceIdentifier: "ios-device-1",
          tenantId: "tenant-1",
          enterpriseLicenseKeyId: "enterprise-key-1",
          enterpriseLicenseKey: { status: "active", expiresAt: null }
        })
      },
      templateVariant: {
        findMany: vi.fn().mockResolvedValue([
          {
            templateIdentityId: "00000000-0000-4000-8000-000000000201",
            family: { title: "Personlig diktat / logg" },
            publishedVersions: [{ yamlContent: validYaml, publishedAt: new Date("2026-04-29T12:00:00.000Z") }]
          }
        ])
      }
    };
    const service = new TemplatesService(prisma as any, { log: vi.fn() } as any, new JwtService());

    const manifest = await service.manifestForEnterpriseActivation(activationToken);

    expect(manifest.templates).toHaveLength(1);
    expect(manifest.templates[0]).toMatchObject({
      id: "00000000-0000-4000-8000-000000000201",
      title: "Personlig diktat / logg",
      language: "nb-NO",
      download_url: "/api/v1/templates/00000000-0000-4000-8000-000000000201/download"
    });
    expect(prisma.templateVariant.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        family: expect.objectContaining({
          OR: [{ isGlobal: true }, { entitlements: { some: { tenantId: "tenant-1" } } }]
        })
      })
    }));
  });

  it("rejects repository access for single-user activations", async () => {
    const activationToken = await issueActivationToken(new JwtService(), {
      kind: "single",
      licenseId: "single-key-1",
      deviceIdentifier: "ios-device-2"
    });
    const prisma = {
      deviceActivation: {
        findUnique: vi.fn().mockResolvedValue({
          id: "activation-1",
          kind: "single",
          status: "active",
          deviceIdentifier: "ios-device-2",
          tenantId: null,
          singleLicenseKeyId: "single-key-1",
          enterpriseLicenseKey: null
        })
      }
    };
    const service = new TemplatesService(prisma as any, { log: vi.fn() } as any, new JwtService());

    await expect(service.manifestForEnterpriseActivation(activationToken)).rejects.toThrow();
  });

  it("validates every backend seed template against the mobile schema", () => {
    const service = new TemplatesService({} as any, {} as any, new JwtService());

    for (const template of seedTemplates) {
      expect(() => service.validateYamlContent(templateYaml(template)), template.title).not.toThrow();
    }
  });

  it("validates every bundled iOS template against the backend mobile schema", () => {
    const service = new TemplatesService({} as any, {} as any, new JwtService());
    const currentFile = fileURLToPath(import.meta.url);
    const templateDirectory = [
      "../../../../ios-app/skrivDET/Resources/Templates",
      "../../../../skrivdet-ios-local/ios-app/skrivDET/Resources/Templates"
    ]
      .map((relativePath) => resolve(dirname(currentFile), relativePath))
      .find((candidate) => existsSync(candidate));
    expect(templateDirectory).toBeTruthy();
    const templateFiles = readdirSync(templateDirectory)
      .filter((fileName) => fileName.endsWith(".yaml"))
      .sort();

    expect(templateFiles.length).toBeGreaterThan(0);
    for (const fileName of templateFiles) {
      const yamlContent = readFileSync(resolve(templateDirectory, fileName), "utf8");
      expect(() => service.validateYamlContent(yamlContent), fileName).not.toThrow();
    }
  });

  it("fills relevant assisted draft fields for a municipal health follow-up case", () => {
    const service = new TemplatesService({} as any, {} as any, new JwtService());
    const result = service.buildAssistedDraft({
      useCase: "A Norwegian template for follow-up conversations after municipal health meetings. It should produce a short summary, decisions, next steps, and responsible people.",
      language: "nb-NO",
      category: "helse",
      title: "Oppfølgingssamtale",
      icon: "person.2.wave.2"
    });

    const parsed = service.validateYamlContent(result.yamlContent);
    expect(parsed.identity).toMatchObject({
      title: "Oppfølgingssamtale",
      category: "helse",
      language: "nb-NO",
      icon: "person.2.wave.2"
    });
    expect(parsed.context.typical_participants?.map((participant) => participant.role)).toEqual(expect.arrayContaining(["saksbehandler", "bruker"]));
    expect(parsed.context.goals?.join(" ")).toContain("ansvar");
    expect(parsed.perspective).toMatchObject({ audience: "arkiv", tone: "formell" });
    expect(parsed.structure.sections.map((section) => section.title)).toEqual(expect.arrayContaining(["Behov og observasjoner", "Beslutninger", "Oppfølging"]));
    expect(parsed.structure.sections.find((section) => section.title === "Oppfølging")).toMatchObject({ format: "table", required: true });
    expect(parsed.content_rules.required_elements?.join(" ")).toContain("frister");
    expect(parsed.llm_prompting.system_prompt_additions).toContain("oppfølgingsbehov");
    expect(result.sampleTranscript).toContain("Bruker:");
  });

  it("fills relevant assisted draft fields for an HR employee check-in case", () => {
    const service = new TemplatesService({} as any, {} as any, new JwtService());
    const result = service.buildAssistedDraft({
      useCase: "Employee check-in between manager, employee, and HR. Capture workload, agreements, next meeting, and responsibilities.",
      language: "en-US"
    });

    const parsed = service.validateYamlContent(result.yamlContent);
    expect(parsed.identity.language).toBe("en-US");
    expect(parsed.identity.tags).toEqual(expect.arrayContaining(["hr", "employee", "follow_up", "manager"]));
    expect(parsed.context.typical_participants?.map((participant) => participant.role)).toEqual(expect.arrayContaining(["manager", "employee", "HR"]));
    expect(parsed.perspective).toMatchObject({ audience: "hr", preserve_original_voice: true });
    expect(parsed.structure.sections.map((section) => section.title)).toEqual(expect.arrayContaining(["Employee perspective", "Agreements", "Follow-up"]));
    expect(parsed.content_rules.decision_marker).toBe("Agreement:");
    expect(result.sampleTranscript).toContain("Employee:");
  });

  it("fills relevant assisted draft fields for an incident case", () => {
    const service = new TemplatesService({} as any, {} as any, new JwtService());
    const result = service.buildAssistedDraft({
      useCase: "Incident report after a security deviation. Capture timeline, impact, immediate actions, risk, and further follow-up.",
      language: "en-US"
    });

    const parsed = service.validateYamlContent(result.yamlContent);
    expect(parsed.identity.category).toBe("avvik_og_hendelser");
    expect(parsed.perspective).toMatchObject({ audience: "ledelse", tone: "formell" });
    expect(parsed.structure.sections.map((section) => section.title)).toEqual(expect.arrayContaining(["Facts and timeline", "Impact and risk", "Actions taken"]));
    expect(parsed.content_rules.speaker_attribution).toBe("role_only");
    expect(parsed.content_rules.exclusions?.join(" ")).toContain("blame");
    expect(result.sampleTranscript).toContain("incident happened");
  });

  it("normalizes OpenAI preview base URLs to chat completions and uses the mobile JSON output contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        documentMarkdown: "## Summary\nGenerated note.",
        sections: [{ id: "summary_summarize_the_transcript", title: "Summary", markdown: "Generated note." }],
        summary: "Generated note.",
        decisions: [],
        actions: [],
        blockers: [],
        nextSteps: [],
        actionItems: [],
        structuredOutputJSON: null
      }) } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const update = vi.fn().mockImplementation(({ data }) => ({
      previewMarkdown: data.previewMarkdown ?? null,
      previewStructured: data.previewStructured ?? null,
      previewProviderType: data.previewProviderType ?? null,
      previewProviderModel: data.previewProviderModel ?? null,
      previewGeneratedAt: data.previewGeneratedAt ?? null,
      previewError: data.previewError ?? null
    }));
    const service = new TemplatesService({
      systemSetting: {
        findUnique: vi.fn().mockResolvedValue({
          value: {
            providerType: "openai",
            endpointUrl: "https://api.openai.com/v1",
            apiKey: "sk-preview",
            model: "gpt-5-mini"
          }
        })
      },
      templateDraft: {
        findUnique: vi.fn().mockResolvedValue({
          id: "draft-1",
          yamlContent: validYaml,
          sampleTranscript: "Speaker: short sample.",
          variant: { family: { title: "Family" } }
        }),
        update
      }
    } as any, { log: vi.fn() } as any, new JwtService());

    const preview = await service.generatePreview("draft-1", { id: "admin-1", email: "admin@example.com" });

    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/chat/completions", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer sk-preview" })
    }));
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(requestBody.response_format).toEqual({ type: "json_object" });
    expect(requestBody.messages[0].content).toContain("documentMarkdown");
    expect(requestBody.messages[0].content).toContain("sections");
    expect(preview).toMatchObject({
      markdown: "## Summary\nGenerated note.",
      extractedFields: expect.objectContaining({
        outputContract: "mobile-json-v1",
        sections: [{ id: "summary_summarize_the_transcript", title: "Summary", markdown: "Generated note." }]
      }),
      provider: { type: "openai", model: "gpt-5-mini" },
      error: null
    });
  });

  it("reports missing preview provider fields", async () => {
    const service = new TemplatesService({
      systemSetting: {
        findUnique: vi.fn().mockResolvedValue({
          value: { providerType: "openai", endpointUrl: "https://api.openai.com/v1", model: null, apiKey: null }
        })
      }
    } as any, { log: vi.fn() } as any, new JwtService());

    await expect(service.previewProviderStatus()).resolves.toMatchObject({
      configured: false,
      providerType: "openai",
      endpointConfigured: true,
      apiKeyConfigured: false,
      missingFields: ["apiKey", "model"]
    });
  });
});
