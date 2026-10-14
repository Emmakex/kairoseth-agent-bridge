import type {
  AuthenticatedPrincipalProvenance,
  InvocationContext,
  InvocationProtocol,
  InvocationProvenance,
} from "./contracts.js";

const MAX_CORRELATION_ID_LENGTH = 256;
const MAX_PRINCIPAL_ID_LENGTH = 1024;
const MAX_AUTH_METHOD_LENGTH = 128;

export interface CreateInvocationProvenanceOptions {
  protocol: InvocationProtocol;
  correlationId: string;
  rootCorrelationId?: string | undefined;
  parentCorrelationId?: string | undefined;
  principal?: AuthenticatedPrincipalProvenance | undefined;
}

export function createInvocationProvenance(
  options: CreateInvocationProvenanceOptions,
): InvocationProvenance {
  const correlationId = validateIdentifier(
    options.correlationId,
    MAX_CORRELATION_ID_LENGTH,
    "correlationId",
  );
  const provenance = normalizeInvocationProvenance({
    version: "kab.provenance.v1",
    protocol: options.protocol,
    rootCorrelationId: options.rootCorrelationId ?? correlationId,
    ...(options.parentCorrelationId
      ? { parentCorrelationId: options.parentCorrelationId }
      : {}),
    ...(options.principal ? { principal: options.principal } : {}),
  });

  if (provenance.parentCorrelationId === correlationId) {
    throw new Error(
      "Invocation provenance parent correlation cannot equal the current correlation ID.",
    );
  }

  return provenance;
}

/**
 * Builds lineage for a child agent/tool invocation while preserving the root
 * correlation and linking the child to the immediate parent invocation.
 */
export function deriveChildInvocationProvenance(
  parent: InvocationContext,
  childCorrelationId: string,
  protocol: InvocationProtocol,
  principal?: AuthenticatedPrincipalProvenance,
): InvocationProvenance {
  return createInvocationProvenance({
    protocol,
    correlationId: childCorrelationId,
    rootCorrelationId:
      parent.provenance?.rootCorrelationId ?? parent.correlationId,
    parentCorrelationId: parent.correlationId,
    ...(principal ? { principal } : {}),
  });
}

export function normalizeInvocationProvenance(
  provenance: InvocationProvenance,
): InvocationProvenance {
  if (provenance.version !== "kab.provenance.v1") {
    throw new Error("Invocation provenance version is unsupported.");
  }
  if (!isInvocationProtocol(provenance.protocol)) {
    throw new Error("Invocation provenance protocol is unsupported.");
  }

  const rootCorrelationId = validateIdentifier(
    provenance.rootCorrelationId,
    MAX_CORRELATION_ID_LENGTH,
    "rootCorrelationId",
  );
  const parentCorrelationId = provenance.parentCorrelationId
    ? validateIdentifier(
        provenance.parentCorrelationId,
        MAX_CORRELATION_ID_LENGTH,
        "parentCorrelationId",
      )
    : undefined;

  return {
    version: "kab.provenance.v1",
    protocol: provenance.protocol,
    rootCorrelationId,
    ...(parentCorrelationId ? { parentCorrelationId } : {}),
    ...(provenance.principal
      ? { principal: normalizePrincipal(provenance.principal) }
      : {}),
  };
}

function normalizePrincipal(
  principal: AuthenticatedPrincipalProvenance,
): AuthenticatedPrincipalProvenance {
  const issuer = validateIdentifier(
    principal.issuer,
    MAX_PRINCIPAL_ID_LENGTH,
    "principal issuer",
  );
  const subject = validateIdentifier(
    principal.subject,
    MAX_PRINCIPAL_ID_LENGTH,
    "principal subject",
  );
  const authenticationMethod = validateIdentifier(
    principal.authenticationMethod,
    MAX_AUTH_METHOD_LENGTH,
    "authentication method",
  );
  const clientId = principal.clientId
    ? validateIdentifier(
        principal.clientId,
        MAX_PRINCIPAL_ID_LENGTH,
        "principal clientId",
      )
    : undefined;

  return {
    issuer,
    subject,
    authenticationMethod,
    ...(clientId ? { clientId } : {}),
  };
}

function isInvocationProtocol(value: string): value is InvocationProtocol {
  return (
    value === "kairoseth-native" ||
    value === "mcp" ||
    value === "a2a" ||
    value === "rest" ||
    value === "webhook" ||
    value === "internal"
  );
}

function validateIdentifier(
  value: string,
  maxLength: number,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invocation provenance ${label} is invalid.`);
  }
  return value;
}
