# Clustered A2A acceptance / Aceptación A2A clustered

Status: **accepted / aceptado — 2026-10-16**

Evidence / Evidencia:

- Kairoseth Platform implementation: `Emmakex/Kairoseth-Command-Center` PR #50.
- Platform merge commit: `4b2bfa241b8215658081fb11010190c332dfd62f`.
- Acceptance workflow: `Agent Bridge A2A Acceptance` — successful against the real Docker Platform stack and MongoDB.
- Agent Bridge client contract: `PlatformA2ATaskStore` from Agent Bridge PR #64.

## ES

La aceptación clustered/shared queda cerrada. La prueba end-to-end ejecutada contra Kairoseth Platform demostró, con dos clientes lógicos concurrentes sobre el mismo backend autoritativo, que:

1. ambos operan sobre la misma tarea `TASK_STATE_AUTH_REQUIRED` y el mismo scope/fingerprint;
2. ambos intentan el claim con `claimId` distintos;
3. exactamente uno recibe un claim y el perdedor recibe `null`;
4. Platform persiste `TASK_STATE_WORKING` antes de devolver el ganador;
5. solo el claim exacto ganador puede completar la transición;
6. una segunda finalización con el claim ya consumido devuelve `completed: false`;
7. el registro terminal queda visible desde el otro cliente lógico;
8. MongoDB conserva una sola tarea autoritativa y elimina el claim tras completar;
9. scope y tenancy se ligan al workspace autenticado, y las respuestas/bindings inválidos fallan cerrados;
10. no existe fallback a `FileA2ATaskStore` ni `InMemoryA2ATaskStore` cuando se usa `PlatformA2ATaskStore`.

Los claims siguen sin expiración automática. Una caída incierta después del claim deja `TASK_STATE_WORKING` bloqueado para reconciliación explícita, evitando una segunda ejecución WRITE/CRITICAL.

## EN

The clustered/shared acceptance is closed. The end-to-end test against Kairoseth Platform proved, with two concurrent logical clients sharing the same authoritative backend, that:

1. both operate on the same `TASK_STATE_AUTH_REQUIRED` task and the same scope/fingerprint;
2. both race the claim with different `claimId` values;
3. exactly one receives a claim and the loser receives `null`;
4. Platform persists `TASK_STATE_WORKING` before returning the winner;
5. only the exact winning claim can complete the transition;
6. replaying completion with the consumed claim returns `completed: false`;
7. the terminal record is visible from the other logical client;
8. MongoDB retains one authoritative task and removes the claim after completion;
9. scope and tenancy are bound to the authenticated workspace, while invalid responses/bindings fail closed;
10. there is no fallback to `FileA2ATaskStore` or `InMemoryA2ATaskStore` when `PlatformA2ATaskStore` is selected.

Claims still have no automatic expiry. An uncertain crash after claim leaves `TASK_STATE_WORKING` blocked for explicit reconciliation, preventing a second WRITE/CRITICAL execution.
