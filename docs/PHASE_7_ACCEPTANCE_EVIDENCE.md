# Phase 7 acceptance evidence record

This file defines the non-secret evidence fields retained after each controlled real-environment acceptance.

## ES

Registrar: fecha/hora UTC, versión Agent Bridge, commit/release, SHA-256 o digest OCI, modo de despliegue, installation ID, conector/instance ID, correlation IDs de READ/WRITE, resultado de aprobación, ACK final, confirmación de auditoría, evidencia de reinicio y resultado final PASS/FAIL.

No registrar: enrollment token, consumer key/secret, session access token, approval token completo, payloads con datos personales del cliente ni cabeceras Authorization.

## EN

Record: UTC date/time, Agent Bridge version, commit/release, SHA-256 or OCI digest, deployment mode, installation ID, connector/instance ID, READ/WRITE correlation IDs, approval result, final ACK, audit confirmation, restart evidence and final PASS/FAIL result.

Do not record: enrollment token, consumer key/secret, session access token, full approval token, customer personal-data payloads or Authorization headers.
