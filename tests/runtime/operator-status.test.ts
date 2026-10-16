import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeOperatorLocale,
  renderRuntimeOperatorStatus,
  resolveOperatorLocale,
} from "../../src/runtime/operator-status.js";
import type { RuntimeProcessStatus } from "../../src/runtime/process-status.js";

const STATUS: RuntimeProcessStatus = {
  version: "kab.runtime-process-status.v1",
  pid: 4242,
  runtimeVersion: "0.1.0-dev.0",
  state: "ready",
  updatedAt: "2026-10-16T08:30:00.000Z",
};

test("operator status renders healthy runtime in Spanish", () => {
  assert.equal(
    renderRuntimeOperatorStatus({ status: STATUS, healthy: true }, "es"),
    [
      "Agent Bridge — estado del runtime",
      "Estado: Listo",
      "Salud: Correcta",
      "Versión: 0.1.0-dev.0",
      "PID: 4242",
      "Actualizado: 2026-10-16T08:30:00.000Z",
      "",
    ].join("\n"),
  );
});

test("operator status renders unhealthy degraded runtime in English", () => {
  assert.match(
    renderRuntimeOperatorStatus(
      { status: { ...STATUS, state: "degraded" }, healthy: false },
      "en",
    ),
    /State: Degraded\nHealth: Unhealthy/,
  );
});

test("operator status localizes missing state without inventing runtime details", () => {
  assert.equal(
    renderRuntimeOperatorStatus({ status: null, healthy: false }, "es"),
    "Agent Bridge — estado del runtime\nTodavía no hay estado del runtime.\n",
  );
  assert.equal(
    renderRuntimeOperatorStatus({ status: null, healthy: false }, "en"),
    "Agent Bridge — runtime status\nNo runtime status is available yet.\n",
  );
});

test("operator locale accepts only ES and EN", () => {
  assert.equal(normalizeOperatorLocale(undefined), "en");
  assert.equal(normalizeOperatorLocale(" ES "), "es");
  assert.equal(normalizeOperatorLocale("en"), "en");
  assert.throws(() => normalizeOperatorLocale("fr"), /must be 'es' or 'en'/i);
});

test("CLI locale flag overrides environment and rejects ambiguous options", () => {
  assert.equal(resolveOperatorLocale([], { KAB_OPERATOR_LOCALE: "es" }), "es");
  assert.equal(
    resolveOperatorLocale(["--locale", "en"], { KAB_OPERATOR_LOCALE: "es" }),
    "en",
  );
  assert.equal(resolveOperatorLocale(["--locale=es"], {}), "es");
  assert.throws(
    () => resolveOperatorLocale(["--locale", "es", "--locale=en"], {}),
    /only be specified once/i,
  );
  assert.throws(
    () => resolveOperatorLocale(["--json"], {}),
    /unknown status option/i,
  );
});
