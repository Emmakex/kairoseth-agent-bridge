# Phase 7 real-environment acceptance checklist

## ES

Esta checklist se usa únicamente cuando la aceptación automatizada ya está verde. No contiene secretos ni valores de cliente.

- instalar exactamente un artefacto estable publicado de Agent Bridge;
- registrar la instalación desde Kairoseth Platform con un token de enrollment de un solo uso;
- verificar que la identidad y el binding quedan persistidos fuera del release;
- configurar una instancia WooCommerce controlada mediante SecretProvider;
- verificar en Kairoseth Platform conectividad, readiness, versión, modo de despliegue y salud del conector;
- ejecutar un READ de pedidos y conservar el correlation ID;
- solicitar y aprobar un WRITE de cambio de estado de pedido;
- comprobar que el WRITE se ejecuta una sola vez y que la auditoría llega a Platform;
- reiniciar el proceso conservando el mismo directorio durable;
- confirmar que identidad e installation binding no cambian;
- reentregar los mismos comandos y comprobar ACK `duplicate` sin nuevas mutaciones WooCommerce;
- confirmar que logs, estado durable y evidencias no contienen consumer secret, session token ni approval token;
- registrar fecha, versión, digest del artefacto, installation ID, correlation IDs y resultado de la aceptación.

La aceptación falla si cualquier mutación se repite, si cambia la identidad tras el reinicio, si el control plane pierde aislamiento tenant/installation o si aparecen secretos en evidencias persistidas.

## EN

Use this checklist only after automated acceptance is green. It contains no customer or secret values.

- install exactly one published stable Agent Bridge artifact;
- enroll the installation from Kairoseth Platform with a single-use enrollment token;
- verify identity and installation binding persist outside the release directory;
- configure one controlled WooCommerce instance through SecretProvider;
- verify connectivity, readiness, runtime version, deployment mode and connector health in Kairoseth Platform;
- execute one order READ and retain its correlation ID;
- request and approve one order-status WRITE;
- verify the WRITE executes exactly once and audit reaches Platform;
- restart the process while preserving the same durable state directory;
- confirm bridge identity and installation binding are unchanged;
- redeliver the same commands and verify `duplicate` ACKs with no new WooCommerce mutation;
- confirm logs, durable state and retained evidence contain no consumer secret, session token or approval token;
- record date, version, artifact digest, installation ID, correlation IDs and acceptance result.

Acceptance fails if any mutation repeats, identity changes after restart, tenant/installation isolation is lost, or secrets appear in persisted evidence.
