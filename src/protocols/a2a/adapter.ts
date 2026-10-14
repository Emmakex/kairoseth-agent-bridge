import type {
  RiskLevel,
  SupportedLocale,
  ToolDefinition,
} from "../../core/contracts.js";
import type { ToolRegistry } from "../../core/registry.js";
import type {
  A2AAgentCard,
  A2AAgentCardAdapterOptions,
  A2AAgentInterface,
  A2AAgentProvider,
  A2AAgentSkill,
  A2ASecurityRequirement,
  A2ASecurityScheme,
} from "./contracts.js";

const DEFAULT_MEDIA_MODES = ["application/json"] as const;
const MAX_TEXT_LENGTH = 2_000;
const MAX_VERSION_LENGTH = 64;
const MAX_TENANT_LENGTH = 256;
const MAX_TAG_LENGTH = 64;
const SECURITY_SCHEME_KEYS = new Set([
  "apiKeySecurityScheme",
  "httpAuthSecurityScheme",
  "oauth2SecurityScheme",
  "openIdConnectSecurityScheme",
  "mtlsSecurityScheme",
]);
const SECURITY_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const MEDIA_TYPE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+*-]*$/;

/**
 * A2A discovery adapter only. AgentSkill is descriptive metadata and MUST NOT
 * become an authorization source. Execution is added separately and will flow
 * through BridgeRuntime, exactly like MCP.
 */
export class A2AAgentCardAdapter {
  private readonly defaultLocale: SupportedLocale;
  private readonly interfaces: readonly A2AAgentInterface[];
  private readonly inputModes: readonly string[];
  private readonly outputModes: readonly string[];
  private readonly provider?: A2AAgentProvider;
  private readonly documentationUrl?: string;
  private readonly iconUrl?: string;
  private readonly securitySchemes?: Readonly<Record<string, A2ASecurityScheme>>;
  private readonly securityRequirements?: readonly A2ASecurityRequirement[];

  constructor(
    private readonly registry: ToolRegistry,
    private readonly options: A2AAgentCardAdapterOptions,
  ) {
    validateAgentOptions(options);
    this.defaultLocale = options.defaultLocale ?? "en";
    this.interfaces = structuredClone(options.supportedInterfaces);
    this.inputModes = normalizeMediaModes(
      options.defaultInputModes ?? DEFAULT_MEDIA_MODES,
      "defaultInputModes",
    );
    this.outputModes = normalizeMediaModes(
      options.defaultOutputModes ?? DEFAULT_MEDIA_MODES,
      "defaultOutputModes",
    );
    this.provider = options.provider ? structuredClone(options.provider) : undefined;
    this.documentationUrl = options.documentationUrl;
    this.iconUrl = options.iconUrl;
    this.securitySchemes = options.securitySchemes
      ? structuredClone(options.securitySchemes)
      : undefined;
    this.securityRequirements = options.securityRequirements
      ? structuredClone(options.securityRequirements)
      : undefined;
  }

  getAgentCard(
    locale: SupportedLocale = this.defaultLocale,
  ): A2AAgentCard {
    const localized = this.options.localizations[locale];
    const skills = this.registry
      .list()
      .map((tool) => describeSkill(tool, locale))
      .sort((left, right) => compareIds(left.id, right.id));

    return {
      name: localized.name,
      description: localized.description,
      supportedInterfaces: structuredClone(this.interfaces),
      ...(this.provider ? { provider: structuredClone(this.provider) } : {}),
      version: this.options.version,
      ...(this.documentationUrl
        ? { documentationUrl: this.documentationUrl }
        : {}),
      capabilities: {
        streaming: false,
        pushNotifications: false,
        extendedAgentCard: false,
      },
      ...(this.securitySchemes
        ? { securitySchemes: structuredClone(this.securitySchemes) }
        : {}),
      ...(this.securityRequirements
        ? { securityRequirements: structuredClone(this.securityRequirements) }
        : {}),
      defaultInputModes: [...this.inputModes],
      defaultOutputModes: [...this.outputModes],
      skills,
      ...(this.iconUrl ? { iconUrl: this.iconUrl } : {}),
    };
  }

  getSkill(
    id: string,
    locale: SupportedLocale = this.defaultLocale,
  ): A2AAgentSkill | null {
    const tool = this.registry.get(id);
    return tool ? describeSkill(tool, locale) : null;
  }
}

function describeSkill(
  tool: ToolDefinition,
  locale: SupportedLocale,
): A2AAgentSkill {
  validateSkillId(tool.id);
  requireBilingualTool(tool);
  const text = tool.localizations![locale]!;

  return {
    id: tool.id,
    name: boundedText(text.name, `${tool.id} ${locale} name`),
    description: boundedText(
      text.description,
      `${tool.id} ${locale} description`,
    ),
    tags: tagsForTool(tool),
    inputModes: ["application/json"],
    outputModes: ["application/json"],
  };
}

function tagsForTool(tool: ToolDefinition): readonly string[] {
  const tags = new Set<string>([
    "kairoseth",
    "tool",
    tool.risk.toLowerCase(),
  ]);
  const namespace = tool.id.split(".", 1)[0]?.toLowerCase();
  if (namespace && /^[a-z0-9_-]{1,64}$/.test(namespace)) {
    tags.add(namespace);
  }
  return [...tags].sort(compareIds).map((tag) => {
    if (tag.length > MAX_TAG_LENGTH) {
      throw new Error(`A2A skill tag exceeds ${MAX_TAG_LENGTH} characters.`);
    }
    return tag;
  });
}

function requireBilingualTool(tool: ToolDefinition): void {
  for (const locale of ["es", "en"] as const) {
    const localized = tool.localizations?.[locale];
    if (!localized?.name.trim() || !localized.description.trim()) {
      throw new Error(
        `A2A skill ${tool.id} requires ES and EN localized name/description before it can be published.`,
      );
    }
  }
}

function validateAgentOptions(options: A2AAgentCardAdapterOptions): void {
  if (
    typeof options.version !== "string" ||
    !options.version.trim() ||
    options.version.length > MAX_VERSION_LENGTH
  ) {
    throw new Error(
      `A2A agent version must be 1-${MAX_VERSION_LENGTH} characters.`,
    );
  }
  for (const locale of ["es", "en"] as const) {
    const localized = options.localizations[locale];
    boundedText(localized.name, `A2A agent ${locale} name`);
    boundedText(localized.description, `A2A agent ${locale} description`);
  }
  validateInterfaces(options.supportedInterfaces, options.allowInsecureHttp === true);
  if (options.provider) validateProvider(options.provider);
  if (options.documentationUrl) {
    validatePublicUrl(options.documentationUrl, "documentationUrl");
  }
  if (options.iconUrl) validatePublicUrl(options.iconUrl, "iconUrl");
  if (options.securitySchemes) validateSecuritySchemes(options.securitySchemes);
  if (options.securityRequirements) {
    validateSecurityRequirements(
      options.securityRequirements,
      options.securitySchemes,
    );
  }
  normalizeMediaModes(
    options.defaultInputModes ?? DEFAULT_MEDIA_MODES,
    "defaultInputModes",
  );
  normalizeMediaModes(
    options.defaultOutputModes ?? DEFAULT_MEDIA_MODES,
    "defaultOutputModes",
  );
}

function validateInterfaces(
  interfaces: readonly A2AAgentInterface[],
  allowInsecureHttp: boolean,
): void {
  if (!Array.isArray(interfaces) || interfaces.length === 0) {
    throw new Error("A2A Agent Card requires at least one supported interface.");
  }

  const seen = new Set<string>();
  for (const item of interfaces) {
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      throw new Error(`A2A interface URL is invalid: ${item.url}`);
    }
    const validScheme =
      url.protocol === "https:" ||
      (allowInsecureHttp && url.protocol === "http:");
    if (!validScheme || url.username || url.password || url.hash) {
      throw new Error(
        "A2A interface URL must use HTTPS without embedded credentials or fragments unless HTTP is explicitly enabled for local/dev use.",
      );
    }
    if (
      typeof item.protocolBinding !== "string" ||
      !item.protocolBinding.trim() ||
      item.protocolBinding.length > 256
    ) {
      throw new Error("A2A interface protocolBinding is invalid.");
    }
    if (item.protocolVersion !== "1.0") {
      throw new Error(
        "A2A discovery baseline publishes protocolVersion 1.0 only.",
      );
    }
    if (
      item.tenant !== undefined &&
      (!item.tenant.trim() || item.tenant.length > MAX_TENANT_LENGTH)
    ) {
      throw new Error("A2A interface tenant is invalid.");
    }
    const key = `${url.toString()}|${item.protocolBinding}|${item.protocolVersion}|${item.tenant ?? ""}`;
    if (seen.has(key)) {
      throw new Error("A2A supportedInterfaces contains a duplicate interface.");
    }
    seen.add(key);
  }
}

function validateProvider(provider: A2AAgentProvider): void {
  boundedText(provider.organization, "A2A provider organization");
  validatePublicUrl(provider.url, "provider.url");
}

function validatePublicUrl(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`A2A ${label} is invalid.`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new Error(`A2A ${label} must be an HTTP(S) URL without credentials.`);
  }
}

function validateSecuritySchemes(
  schemes: Readonly<Record<string, A2ASecurityScheme>>,
): void {
  const entries = Object.entries(schemes);
  if (entries.length === 0) {
    throw new Error("A2A securitySchemes cannot be empty when declared.");
  }
  for (const [name, scheme] of entries) {
    if (!SECURITY_NAME_PATTERN.test(name)) {
      throw new Error(`A2A security scheme name is invalid: ${name}`);
    }
    if (scheme === null || typeof scheme !== "object" || Array.isArray(scheme)) {
      throw new Error(`A2A security scheme ${name} must be an object.`);
    }
    const discriminators = Object.keys(scheme).filter((key) =>
      SECURITY_SCHEME_KEYS.has(key),
    );
    if (discriminators.length !== 1) {
      throw new Error(
        `A2A security scheme ${name} must declare exactly one A2A 1.0 security-scheme variant.`,
      );
    }
  }
}

function validateSecurityRequirements(
  requirements: readonly A2ASecurityRequirement[],
  schemes: Readonly<Record<string, A2ASecurityScheme>> | undefined,
): void {
  if (!Array.isArray(requirements) || requirements.length === 0) {
    throw new Error(
      "A2A securityRequirements cannot be empty when declared.",
    );
  }
  if (!schemes) {
    throw new Error(
      "A2A securityRequirements requires matching securitySchemes.",
    );
  }
  for (const requirement of requirements) {
    const names = Object.keys(requirement);
    if (names.length === 0) {
      throw new Error("A2A security requirement cannot be empty.");
    }
    for (const name of names) {
      if (!(name in schemes)) {
        throw new Error(
          `A2A security requirement references unknown scheme: ${name}`,
        );
      }
      const scopes = requirement[name];
      if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) {
        throw new Error(
          `A2A security requirement scopes are invalid for scheme: ${name}`,
        );
      }
    }
  }
}

function normalizeMediaModes(
  values: readonly string[],
  label: string,
): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`A2A ${label} must contain at least one media type.`);
  }
  const normalized = values.map((value) => value.trim().toLowerCase());
  if (
    normalized.some(
      (value) => !value || value.length > 128 || !MEDIA_TYPE_PATTERN.test(value),
    )
  ) {
    throw new Error(`A2A ${label} contains an invalid media type.`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`A2A ${label} contains duplicate media types.`);
  }
  return normalized;
}

function validateSkillId(id: string): void {
  if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error(
      "A2A skill id must be 1-256 characters without control characters.",
    );
  }
}

function boundedText(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_TEXT_LENGTH ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error(
      `${label} must be non-empty text up to ${MAX_TEXT_LENGTH} characters.`,
    );
  }
  return value;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Risk is included only as descriptive A2A tag metadata. It MUST NOT be used
 * by callers or the adapter to grant authorization or bypass Bridge policy.
 */
export function a2aRiskTag(risk: RiskLevel): string {
  return risk.toLowerCase();
}
