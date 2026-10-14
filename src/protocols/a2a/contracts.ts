import type { SupportedLocale } from "../../core/contracts.js";

export interface A2ALocalizedAgentText {
  name: string;
  description: string;
}

export type A2AAgentLocalizations = Readonly<
  Record<SupportedLocale, A2ALocalizedAgentText>
>;

export interface A2AAgentInterface {
  url: string;
  protocolBinding: string;
  protocolVersion: "1.0";
  tenant?: string | undefined;
}

export interface A2AAgentProvider {
  url: string;
  organization: string;
}

export interface A2AAgentExtension {
  uri: string;
  description?: string | undefined;
  required?: boolean | undefined;
  params?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Agent Card descriptions are user/agent-facing, so official Kairoseth
 * extension declarations are localized in both supported product languages.
 * URI, required flag and params must remain semantically identical.
 */
export type A2AAgentExtensionLocalizations = Readonly<
  Record<SupportedLocale, readonly A2AAgentExtension[]>
>;

export interface A2AAgentCapabilities {
  streaming?: boolean | undefined;
  pushNotifications?: boolean | undefined;
  extensions?: readonly A2AAgentExtension[] | undefined;
  extendedAgentCard?: boolean | undefined;
}

/**
 * A2A SecurityRequirement follows the OpenAPI-style map of security-scheme
 * name to required scopes. Discovery only; Bridge policy remains authoritative.
 */
export type A2ASecurityRequirement = Readonly<
  Record<string, readonly string[]>
>;

/**
 * Discovery pass-through for an A2A 1.0 SecurityScheme union. The host owns
 * authentication configuration; the adapter never derives it from tool risk.
 */
export type A2ASecurityScheme = Readonly<Record<string, unknown>>;

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: readonly string[];
  inputModes?: readonly string[] | undefined;
  outputModes?: readonly string[] | undefined;
  securityRequirements?: readonly A2ASecurityRequirement[] | undefined;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  supportedInterfaces: readonly A2AAgentInterface[];
  provider?: A2AAgentProvider | undefined;
  version: string;
  documentationUrl?: string | undefined;
  capabilities: A2AAgentCapabilities;
  securitySchemes?: Readonly<Record<string, A2ASecurityScheme>> | undefined;
  securityRequirements?: readonly A2ASecurityRequirement[] | undefined;
  defaultInputModes: readonly string[];
  defaultOutputModes: readonly string[];
  skills: readonly A2AAgentSkill[];
  iconUrl?: string | undefined;
}

export interface A2AAgentCardAdapterOptions {
  version: string;
  localizations: A2AAgentLocalizations;
  supportedInterfaces: readonly A2AAgentInterface[];
  provider?: A2AAgentProvider | undefined;
  documentationUrl?: string | undefined;
  iconUrl?: string | undefined;
  /** Public-card authentication metadata supplied by the trusted A2A host. */
  securitySchemes?: Readonly<Record<string, A2ASecurityScheme>> | undefined;
  securityRequirements?: readonly A2ASecurityRequirement[] | undefined;
  /** Localized declarations for optional/required A2A extensions. */
  extensions?: A2AAgentExtensionLocalizations | undefined;
  /** A2A media types; default is application/json for Bridge structured data. */
  defaultInputModes?: readonly string[] | undefined;
  defaultOutputModes?: readonly string[] | undefined;
  defaultLocale?: SupportedLocale | undefined;
  /** Production requires HTTPS. Enable only for controlled local/dev hosts. */
  allowInsecureHttp?: boolean | undefined;
}
