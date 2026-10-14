# Agent Bridge — supply-chain security / seguridad de cadena de suministro

## ES

### Objetivo

Phase 6 debe producir evidencia verificable de las dependencias incluidas en cada build, usar instalaciones reproducibles y detectar vulnerabilidades tanto en dependencias como en el código JavaScript/TypeScript del bridge.

### Baseline actual

El repositorio versiona `package-lock.json` (`lockfileVersion: 3`) y CI instala dependencias exclusivamente con `npm ci` sobre Node.js 22.

Después de la instalación bloqueada, CI ejecuta:

1. typecheck, tests y build;
2. generación de SBOM CycloneDX con `npm sbom`;
3. validación estructural del SBOM;
4. `npm audit --omit=dev --audit-level=high`;
5. publicación del SBOM como artefacto de GitHub Actions durante 30 días.

Además, un workflow CodeQL independiente analiza JavaScript/TypeScript con la suite `security-extended` en pull requests hacia `main`, pushes a `main` y una ejecución semanal. Esto añade análisis estático de vulnerabilidades de código sin sustituir los tests ni el audit de dependencias.

`actions/setup-node` usa cache de npm, pero la resolución autorizada sigue determinada por el lockfile y `npm ci` rechaza incoherencias entre `package.json` y `package-lock.json`.

El SBOM no contiene secretos de runtime ni credenciales de conectores. Describe el árbol de paquetes instalado en la ejecución.

### Frontera de seguridad

- El lockfile fija las versiones resueltas e integridades de paquetes para instalaciones reproducibles.
- `npm ci` no actualiza silenciosamente el lockfile durante CI.
- `npm audit` bloquea hallazgos `high` o `critical` en dependencias de producción.
- CodeQL cubre patrones vulnerables del código JavaScript/TypeScript y usa `security-extended` para ampliar la señal más allá de la suite por defecto.
- Los hallazgos de CodeQL quedan en GitHub code scanning para triage y seguimiento; no convierten el análisis estático en una autoridad de runtime.
- Generar un SBOM o ejecutar CodeQL no equivale a firmar un release. La firma/atestación del artefacto publicado es un control separado.

### Siguiente endurecimiento

1. ligar SBOM y checksum al artefacto de release;
2. añadir atestación/firma verificable del release;
3. conservar hash, procedencia y metadatos verificables del artefacto publicado;
4. mantener el scanning actualizado sin debilitar los gates de runtime, tests y policy.

## EN

### Goal

Phase 6 must produce verifiable evidence of the dependencies included in each build, use reproducible installs, and detect vulnerabilities both in dependencies and in the bridge JavaScript/TypeScript source.

### Current baseline

The repository versions `package-lock.json` (`lockfileVersion: 3`) and CI installs dependencies exclusively with `npm ci` on Node.js 22.

After the locked install, CI performs:

1. typecheck, tests, and build;
2. CycloneDX SBOM generation with `npm sbom`;
3. structural SBOM validation;
4. `npm audit --omit=dev --audit-level=high`;
5. upload of the SBOM as a GitHub Actions artifact retained for 30 days.

An independent CodeQL workflow also analyzes JavaScript/TypeScript with the `security-extended` suite on pull requests targeting `main`, pushes to `main`, and a weekly scheduled run. This adds static vulnerability analysis without replacing tests or dependency auditing.

`actions/setup-node` uses npm caching, while authorized dependency resolution remains determined by the lockfile and `npm ci` rejects mismatches between `package.json` and `package-lock.json`.

The SBOM contains no runtime secrets or connector credentials. It describes the package tree installed for that workflow run.

### Security boundary

- The lockfile fixes resolved package versions and integrity hashes for reproducible installs.
- `npm ci` does not silently rewrite the lockfile during CI.
- `npm audit` blocks `high` or `critical` findings in production dependencies.
- CodeQL covers vulnerable patterns in JavaScript/TypeScript source and uses `security-extended` for signal beyond the default query suite.
- CodeQL findings remain in GitHub code scanning for triage and tracking; static analysis does not become a runtime authority.
- Generating an SBOM or running CodeQL is not the same as signing a release. Release artifact signing/attestation remains a separate control.

### Next hardening step

1. bind SBOM and checksum to the release artifact;
2. add verifiable release signing/attestation;
3. retain verifiable artifact hash, provenance, and publication metadata;
4. keep scanning current without weakening runtime, test, or policy gates.
