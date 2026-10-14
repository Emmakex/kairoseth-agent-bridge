# Agent Bridge — supply-chain security / seguridad de cadena de suministro

## ES

### Objetivo

Phase 6 debe producir evidencia verificable de las dependencias incluidas en cada build y bloquear vulnerabilidades conocidas de severidad alta o crítica en dependencias de producción.

### Baseline actual

El CI ejecuta, después de typecheck/tests/build:

1. generación de SBOM CycloneDX con `npm sbom`;
2. validación estructural del SBOM;
3. `npm audit --omit=dev --audit-level=high`;
4. publicación del SBOM como artefacto inmutable de la ejecución de GitHub Actions durante 30 días.

El SBOM no contiene secretos de runtime ni credenciales de conectores. Describe el árbol de paquetes instalado en la ejecución.

### Frontera de seguridad

- El audit se aplica a dependencias de producción; las devDependencies siguen cubiertas por actualización/revisión pero no bloquean el runtime por sí solas.
- Un hallazgo `high` o `critical` en dependencias de producción hace fallar CI.
- Generar un SBOM no equivale a firmar un release. La firma/atestación del artefacto de release es un control separado.
- El repositorio todavía no tiene un `package-lock.json` versionado. Por tanto, esta baseline mejora visibilidad y detección, pero la reproducibilidad exacta de instalación queda pendiente.

### Siguiente endurecimiento

1. versionar un lockfile revisado;
2. sustituir `npm install` por `npm ci`;
3. ligar SBOM al artefacto de release;
4. añadir atestación/firma del release;
5. conservar hash y procedencia del artefacto publicado.

## EN

### Goal

Phase 6 must produce verifiable evidence of the dependencies included in each build and block known high/critical vulnerabilities in production dependencies.

### Current baseline

After typecheck/tests/build, CI performs:

1. CycloneDX SBOM generation with `npm sbom`;
2. structural SBOM validation;
3. `npm audit --omit=dev --audit-level=high`;
4. upload of the SBOM as an immutable GitHub Actions artifact retained for 30 days.

The SBOM contains no runtime secrets or connector credentials. It describes the package tree installed for that workflow run.

### Security boundary

- The blocking audit applies to production dependencies; devDependencies remain subject to maintenance/review but do not independently block runtime production risk.
- A `high` or `critical` production dependency finding fails CI.
- Generating an SBOM is not the same as signing a release. Release artifact signing/attestation is a separate control.
- The repository does not yet version a `package-lock.json`. This baseline improves visibility and detection, but exact install reproducibility remains pending.

### Next hardening step

1. commit a reviewed lockfile;
2. replace `npm install` with `npm ci`;
3. bind the SBOM to the release artifact;
4. add release signing/attestation;
5. retain the published artifact hash and provenance.
