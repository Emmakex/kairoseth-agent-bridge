# Clustered A2A acceptance / Aceptación A2A clustered

## ES

La implementación Platform se considerará aceptada cuando una prueba end-to-end demuestre, con dos instancias lógicas de Agent Bridge usando `PlatformA2ATaskStore`, que:

1. ambas leen la misma tarea `TASK_STATE_AUTH_REQUIRED`;
2. ambas intentan `claimTransition` con el mismo `taskId`, scope y `actionFingerprint`;
3. exactamente una recibe un claim;
4. la perdedora recibe `null` y no ejecuta el side effect;
5. la ganadora completa con el mismo `claimId`;
6. una segunda finalización con otro claim o el claim ya consumido devuelve `false`;
7. una caída después del claim deja `TASK_STATE_WORKING` bloqueado sin expiración automática;
8. scope, fingerprint, sesión o respuesta inválidos fallan cerrados;
9. no existe fallback a `FileA2ATaskStore` ni `InMemoryA2ATaskStore`.

## EN

The Platform implementation is accepted when an end-to-end test proves, with two logical Agent Bridge instances using `PlatformA2ATaskStore`, that:

1. both observe the same `TASK_STATE_AUTH_REQUIRED` task;
2. both attempt `claimTransition` with the same `taskId`, scope and `actionFingerprint`;
3. exactly one receives a claim;
4. the loser receives `null` and does not execute the side effect;
5. the winner completes with the same `claimId`;
6. a second completion with another or already-consumed claim returns `false`;
7. a crash after claim leaves `TASK_STATE_WORKING` blocked with no automatic expiry;
8. invalid scope, fingerprint, session or response fails closed;
9. there is no fallback to `FileA2ATaskStore` or `InMemoryA2ATaskStore`.
