# Agent Bridge — supply-chain security / seguridad de cadena de suministro

## ES

### Objetivo

Phase 6 debe producir evidencia verificable de las dependencias incluidas en cada build, usar instalaciones reproducibles y bloquear vulnerabilidades conocidas de severidad alta o crítica en dependencias de producción.

### Baseline actual

El repositorio versiona `package-lock.json` (`lockfileVersion: 3`) y CI instala dependencias exclusivamente con `npm ci` sobre Node.js 22.

Después de la instalación bloqueada, CI ejecuta:

1. typecheck, tests y build;
2. generación de SBOM CycloneDX con `npm sbom`;
3. validación estructural del SBOM;
4. `npm audit --omit=dev --audit-level=high`;
5. publicación del SBOM como artefacto de GitHub Actions durante 30 días.

`actions/setup-node` usa cache de npm, pero la resolución autorizada sigue determinada por el lockfile y `npm ci` rechaza incoherencias entre `package.json` y `package-lock.json`.

El SBOM no contiene secretos de runtime ni credenciales de conectores. Describe el árbol de paquetes instalado en la ejecución.

### Frontera de seguridad

- El lockfile fija las versiones resueltas e integridades de paquetes para instalaciones reproducibles.
- `npm ci` no actualiza silenciosamente el lockfile durante CI.
- El audit se aplica a dependencias de producción; las devDependencies siguen cubiertas por actualización/revisión pero no bloquean el runtime por sí solas.
- Un hallazgo `high` o `critical` en dependencias de producción hace fallar CI.
- Generar un SBOM no equivale a firmar un release. La firma/atestación del artefacto de release es un control separado.

### Siguiente endurecimiento

1. ligar SBOM y checksum al artefacto de release;
2. añadir atestación/firma del release;
3. conservar hash, procedencia y metadatos verificables del artefacto publicado;
4. añadir scanning adicional del código/dependencias cuando aporte señal distinta al audit actual.

## EN

### Goal

Phase 6 must produce verifiable evidence of the dependencies included in each build, use reproducible installs, and block known high/critical vulnerabilities in production dependencies.

### Current baseline

The repository versions `package-lock.json` (`lockfileVersion: 3`) and CI installs dependencies exclusively with `npm ci` on Node.js 22.

After the locked install, CI performs:

1. typecheck, tests, and build;
2. CycloneDX SBOM generation with `npm sbom`;
3. structural SBOM validation;
4. `npm audit --omit=dev --audit-level=high`;
5. upload of the SBOM as a GitHub Actions artifact retained for 30 days.

`actions/setup-node` uses npm caching, while authorized dependency resolution remains determined by the lockfile and `npm ci` rejects mismatches between `package.json` and `package-lock.json`.

The SBOM contains no runtime secrets or connector credentials. It describes the package tree installed for that workflow run.

### Security boundary

- The lockfile fixes resolved package versions and integrity hashes for reproducible installs.
- `npm ci` does not silently rewrite the lockfile during CI.
- The blocking audit applies to production dependencies; devDependencies remain subject to maintenance/review but do not independently block runtime production risk.
- A `high` or `critical` production dependency finding fails CI.
- Generating an SBOM is not the same as signing a release. Release artifact signing/attestation is a separate control.

### Next hardening step

1. bind SBOM and checksum to the release artifact;
2. add release signing/attestation;
3. retain verifiable artifact hash, provenance, and publication metadata;
4. add further code/dependency scanning where it provides signal beyond the current audit gate.
