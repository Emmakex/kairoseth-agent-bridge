# Agent Bridge — product identity / identidad de producto

This file records only the Agent Bridge-specific mapping. The global and canonical naming policy lives in `Emmakex/kairoseth-platform` at `docs/COMMERCIAL_PRODUCT_NAMING.md`.

## ES

- Identidad técnica estable: `agent-bridge`
- Componente/runtime técnico: `Agent Bridge`
- Nombre comercial: **Integración de agentes de IA**
- Marca paraguas: **Kairoseth**

Las superficies orientadas a cliente deben mostrar **Integración de agentes de IA** en español. `Agent Bridge` se conserva para código, arquitectura, runtime, paquetes, protocolos, logs técnicos y documentación de ingeniería cuando describe el componente técnico.

Un cambio de nombre comercial no modifica por sí mismo repositorio, package name, rutas, APIs, RBAC, tool IDs, connector IDs, protocolos `kab.*`, códigos de error, datos persistidos ni contratos de integración.

Los tests técnicos no deben fijar nombres comerciales. Los nombres ES/EN se validan únicamente en tests dedicados de identidad/naming/i18n.

## EN

- Stable technical identity: `agent-bridge`
- Technical component/runtime: `Agent Bridge`
- Commercial name: **AI Integration**
- Umbrella brand: **Kairoseth**

Customer-facing surfaces must display **AI Integration** in English. `Agent Bridge` remains valid for code, architecture, runtime, packages, protocols, technical logs, and engineering documentation when it refers to the technical component.

A commercial rename does not by itself change the repository, package name, routes, APIs, RBAC, tool IDs, connector IDs, `kab.*` protocols, error codes, persisted data, or integration contracts.

Technical tests must not pin commercial names. ES/EN commercial labels are validated only in dedicated identity/naming/i18n tests.
