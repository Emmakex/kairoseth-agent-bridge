import type { SupportedLocale } from "./core/contracts.js";

/**
 * Stable technical identity and locale-specific commercial labels for the
 * Agent Bridge product boundary.
 *
 * Global naming policy is owned by Kairoseth Platform in
 * docs/COMMERCIAL_PRODUCT_NAMING.md. Technical IDs remain stable; only
 * customer-facing labels are localized.
 */
export const AGENT_BRIDGE_PRODUCT_IDENTITY = Object.freeze({
  technicalId: "agent-bridge",
  technicalName: "Agent Bridge",
  commercialNames: Object.freeze({
    es: "Integración de agentes de IA",
    en: "AI Integration",
  } satisfies Readonly<Record<SupportedLocale, string>>),
});

export function getAgentBridgeCommercialName(locale: SupportedLocale): string {
  return AGENT_BRIDGE_PRODUCT_IDENTITY.commercialNames[locale];
}
