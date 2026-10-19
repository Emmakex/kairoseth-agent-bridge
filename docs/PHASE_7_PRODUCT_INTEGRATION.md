# Phase 7 — Product integration and real-environment acceptance

Status: **in progress**

Phase 6 closed the production-hardening baseline. Phase 7 does not reopen runtime hardening: it proves that the stable Agent Bridge can be operated as a product integration from Kairoseth Platform through a real connector path and can recover safely across process restarts.

---

## ES — Integración de producto y aceptación en entorno real

### Objetivo

Demostrar un flujo operativo completo con el mismo runtime compartido de Agent Bridge:

`Kairoseth Platform -> enrollment -> sesión autenticada -> conector real -> READ -> WRITE aprobado -> auditoría -> observabilidad -> reinicio/reentrega segura`.

La aceptación debe demostrar comportamiento de producto, no solo unidades aisladas del runtime.

### Regla de arquitectura

- Kairoseth Platform sigue siendo el plano de control y la superficie del operador.
- Agent Bridge sigue siendo el runtime técnico compartido.
- No se crea un runtime privado por producto ni por conector.
- Los conectores conservan los contratos comunes de identidad, riesgo, aprobación, auditoría y ES/EN.
- Una reentrega después de reinicio no puede repetir efectos ya confirmados.

### Phase 7.1 — Primer flujo completo WooCommerce

Estado: **implementado en aceptación automatizada; pendiente de CI/merge y posterior ejecución contra entorno real**.

La primera prueba transversal usa el conector oficial WooCommerce porque cubre de forma compacta los dos tipos de operación esenciales:

1. enrollment de una instalación persistente;
2. apertura de sesión autenticada con Kairoseth Platform;
3. publicación de snapshot/observabilidad;
4. `woocommerce.store.orders.list` como operación READ real del conector;
5. `woocommerce.store.orders.update-status` como operación WRITE con aprobación firmada de un solo uso;
6. entrega de auditoría sanitizada;
7. parada del runtime;
8. creación de una nueva instancia del proceso sobre el mismo estado durable;
9. conservación exacta de identidad y binding;
10. reentrega de los mismos comandos;
11. respuesta `duplicate` usando receipts persistidos, sin volver a ejecutar llamadas WooCommerce;
12. comprobación de que credenciales, session tokens y approval tokens no quedan persistidos.

La aceptación automatizada vive en:

`tests/acceptance/phase7-woocommerce-real-flow.test.ts`

### Condición de salida de 7.1

7.1 se considera cerrada cuando:

- el test transversal está verde en CI;
- el cambio está mergeado en `main`;
- el mismo contrato se ejecuta después contra una instalación WooCommerce controlada usando Kairoseth Platform real;
- Platform refleja conectividad, readiness, versión, modo de despliegue y salud del conector durante la prueba;
- se conserva evidencia de READ, WRITE aprobado, auditoría y reinicio sin doble efecto.

### Siguientes microfases

- **7.2**: runner/procedimiento reproducible para aceptación contra Kairoseth Platform real sin introducir secretos en el repositorio.
- **7.3**: primera instalación controlada real con el artefacto estable publicado.
- **7.4**: repetir el patrón con PrestaShop o el siguiente consumidor que aporte la prueba comercial más rápida.
- **7.5**: integrar el primer consumidor de producto — inicialmente IA Empleado salvo que otra integración proporcione antes la prueba end-to-end real.

---

## EN — Product integration and real-environment acceptance

### Objective

Prove one complete operational path using the same shared Agent Bridge runtime:

`Kairoseth Platform -> enrollment -> authenticated session -> real connector -> READ -> approved WRITE -> audit -> observability -> safe restart/redelivery`.

The acceptance must demonstrate product behavior rather than another isolated runtime unit test.

### Architecture rule

- Kairoseth Platform remains the control plane and operator surface.
- Agent Bridge remains the shared technical runtime.
- No private runtime is created per product or connector.
- Connectors retain the common identity, risk, approval, audit and ES/EN contracts.
- Redelivery after restart must never repeat already confirmed effects.

### Phase 7.1 — First complete WooCommerce flow

Status: **implemented as automated acceptance; CI/merge and later real-environment execution remain**.

The first transversal proof uses the official WooCommerce connector because it covers both essential operation classes compactly:

1. enroll one durable installation;
2. open an authenticated Kairoseth Platform session;
3. publish runtime snapshot/observability;
4. execute `woocommerce.store.orders.list` as a real connector READ;
5. execute `woocommerce.store.orders.update-status` as a WRITE protected by a single-use signed approval;
6. deliver sanitized audit events;
7. stop the runtime;
8. create a new process instance over the same durable state;
9. preserve the exact bridge identity and installation binding;
10. redeliver the same commands;
11. acknowledge them as `duplicate` from durable receipts without issuing WooCommerce requests again;
12. prove connector credentials, session credentials and approval tokens are not persisted.

The automated acceptance lives at:

`tests/acceptance/phase7-woocommerce-real-flow.test.ts`

### 7.1 exit condition

7.1 is complete when:

- the transversal test is green in CI;
- the change is merged to `main`;
- the same contract is then exercised against a controlled WooCommerce installation using the real Kairoseth Platform;
- Platform exposes connectivity, readiness, runtime version, deployment mode and connector health during the exercise;
- evidence is retained for the READ, approved WRITE, audit delivery and restart without duplicate effects.

### Next microphases

- **7.2**: reproducible runner/procedure for real Kairoseth Platform acceptance without repository secrets.
- **7.3**: first controlled real installation using the published stable artifact.
- **7.4**: repeat the pattern with PrestaShop or whichever next consumer provides the fastest commercial proof.
- **7.5**: integrate the first product consumer — initially IA Empleado unless another integration produces the real end-to-end proof earlier.
