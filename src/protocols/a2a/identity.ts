import type { SupportedLocale } from "../../core/contracts.js";
import type { A2AExecutionContext } from "./execution-contracts.js";

const MAX_ID_LENGTH = 256;
const MAX_ACTOR_LENGTH = 512;
const MAX_ISSUER_LENGTH = 1024;
const MAX_SCOPE_COUNT = 128;
const MAX_SCOPE_LENGTH = 256;

export type A2AAuthenticationMethod =
  | "oauth2"
  | "bearer"
  | "mtls"
  | "api-key"
  | "custom";

/**
 * Authentication evidence produced by the trusted A2A transport/host after it
 * has verified the configured Agent Card security scheme. No bearer/API-key
 * secret is carried here.
 */
export interface A2AVerifiedTransportPrincipal {
  issuer: string;
  subject: string;
  authenticationMethod: A2AAuthenticationMethod;
  clientId?: string | undefined;
  scopes?: readonly string[] | undefined;
}

/**
 * Authoritative Kairoseth binding returned by Platform/control-plane logic.
 * Tenant and installation are deliberately absent from the transport principal
 * so remote callers cannot self-assert them.
 */
export interface A2APrincipalBinding {
  actor: string;
  tenantId: string;
  installationId: string;
  delegationRequired: boolean;
}

export type A2APrincipalBindingResolver = (
  principal: A2AVerifiedTransportPrincipal,
) => Promise<A2APrincipalBinding | null>;

export interface A2AIdentityMappingRequest {
  principal: A2AVerifiedTransportPrincipal;
  correlationId: string;
  activatedExtensions: readonly string[];
  locale?: SupportedLocale | undefined;
  approvalToken?: string | undefined;
  delegationToken?: string | undefined;
}

export type A2AIdentityMappingResult =
  | {
      mapped: true;
      context: A2AExecutionContext;
    }
  | {
      mapped: false;
      reason: string;
    };

/**
 * Maps already-verified transport identity into the execution context consumed
 * by A2A adapters. The resolver is the trust boundary for Kairoseth tenant and
 * installation assignment.
 */
export class A2AIdentityMapper {
  constructor(private readonly resolveBinding: A2APrincipalBindingResolver) {}

  async map(
    request: A2AIdentityMappingRequest,
  ): Promise<A2AIdentityMappingResult> {
    const principal = normalizePrincipal(request.principal);
    if (!principal) {
      return { mapped: false, reason: "Verified A2A principal is invalid." };
    }
    if (!boundedString(request.correlationId, MAX_ID_LENGTH)) {
      return { mapped: false, reason: "A2A correlation ID is invalid." };
    }
    if (!validExtensions(request.activatedExtensions)) {
      return {
        mapped: false,
        reason: "A2A activated extension set is invalid.",
      };
    }
    if (request.approvalToken !== undefined && !validToken(request.approvalToken)) {
      return { mapped: false, reason: "A2A approval token is invalid." };
    }
    if (
      request.delegationToken !== undefined &&
      !validToken(request.delegationToken)
    ) {
      return { mapped: false, reason: "A2A delegation token is invalid." };
    }

    let binding: A2APrincipalBinding | null;
    try {
      binding = await this.resolveBinding(principal);
    } catch {
      return {
        mapped: false,
        reason: "Kairoseth A2A principal binding lookup failed.",
      };
    }
    if (!binding || !validBinding(binding)) {
      return {
        mapped: false,
        reason: "A2A principal is not bound to an authorized Kairoseth installation.",
      };
    }

    const metadata: Record<string, string> = {
      protocol: "a2a",
      "a2a.auth.issuer": principal.issuer,
      "a2a.auth.subject": principal.subject,
      "a2a.auth.method": principal.authenticationMethod,
    };
    if (principal.clientId) metadata["a2a.auth.clientId"] = principal.clientId;
    if (principal.scopes.length > 0) {
      metadata["a2a.auth.scopes"] = principal.scopes.join(" ");
    }

    return {
      mapped: true,
      context: {
        protocolVersion: "1.0",
        activatedExtensions: [...request.activatedExtensions],
        ...(request.locale ? { locale: request.locale } : {}),
        invocation: {
          correlationId: request.correlationId,
          actor: binding.actor,
          tenantId: binding.tenantId,
          installationId: binding.installationId,
          delegationRequired: binding.delegationRequired,
          ...(request.approvalToken
            ? { approvalToken: request.approvalToken }
            : {}),
          ...(request.delegationToken
            ? { delegationToken: request.delegationToken }
            : {}),
          metadata,
        },
      },
    };
  }
}

function normalizePrincipal(
  value: A2AVerifiedTransportPrincipal,
): (A2AVerifiedTransportPrincipal & { scopes: readonly string[] }) | null {
  if (
    !value ||
    !boundedString(value.issuer, MAX_ISSUER_LENGTH) ||
    !boundedString(value.subject, MAX_ACTOR_LENGTH) ||
    !isAuthenticationMethod(value.authenticationMethod) ||
    (value.clientId !== undefined && !boundedString(value.clientId, MAX_ID_LENGTH))
  ) {
    return null;
  }

  const scopes = value.scopes ?? [];
  if (!Array.isArray(scopes) || scopes.length > MAX_SCOPE_COUNT) return null;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (!boundedString(scope, MAX_SCOPE_LENGTH) || seen.has(scope)) return null;
    seen.add(scope);
    normalized.push(scope);
  }
  normalized.sort(compareStrings);

  return {
    issuer: value.issuer,
    subject: value.subject,
    authenticationMethod: value.authenticationMethod,
    ...(value.clientId ? { clientId: value.clientId } : {}),
    scopes: normalized,
  };
}

function validBinding(binding: A2APrincipalBinding): boolean {
  return (
    boundedString(binding.actor, MAX_ACTOR_LENGTH) &&
    boundedString(binding.tenantId, MAX_ID_LENGTH) &&
    boundedString(binding.installationId, MAX_ID_LENGTH) &&
    typeof binding.delegationRequired === "boolean"
  );
}

function validExtensions(values: readonly string[]): boolean {
  if (!Array.isArray(values)) return false;
  const seen = new Set<string>();
  for (const value of values) {
    if (!boundedString(value, 2048) || seen.has(value)) return false;
    let uri: URL;
    try {
      uri = new URL(value);
    } catch {
      return false;
    }
    if (uri.protocol !== "https:" || uri.username || uri.password || uri.hash) {
      return false;
    }
    seen.add(value);
  }
  return true;
}

function validToken(value: string): boolean {
  return value.length > 0 && value.length <= 16_384 && !/[\u0000-\u001f\u007f]/.test(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isAuthenticationMethod(
  value: unknown,
): value is A2AAuthenticationMethod {
  return (
    value === "oauth2" ||
    value === "bearer" ||
    value === "mtls" ||
    value === "api-key" ||
    value === "custom"
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
