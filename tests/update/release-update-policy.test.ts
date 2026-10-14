import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  assertRuntimeArtifactFileIntegrity,
  evaluateRuntimeUpdate,
  verifyRuntimeArtifactFile,
  type InstalledRuntimeRelease,
  type RuntimeReleaseDescriptor,
} from "../../src/index.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const COMMIT_A = "1".repeat(40);
const COMMIT_B = "2".repeat(40);
const COMMIT_C = "3".repeat(40);

function installed(
  packageVersion = "1.0.0",
  artifactSha256 = A,
  sourceCommit = COMMIT_A,
): InstalledRuntimeRelease {
  return { packageVersion, artifactSha256, sourceCommit };
}

function release(
  packageVersion: string,
  artifactSha256: string,
  sourceCommit: string,
  channel: "stable" | "candidate" = "stable",
): RuntimeReleaseDescriptor {
  return {
    schemaVersion: "kab.runtime-release.v1",
    technicalProductId: "agent-bridge",
    packageVersion,
    artifactSha256,
    sourceCommit,
    channel,
  };
}

test("newer stable runtime is eligible for update", () => {
  const decision = evaluateRuntimeUpdate(
    installed(),
    release("1.1.0", B, COMMIT_B),
  );

  assert.equal(decision.outcome, "update");
  assert.equal(decision.reason, "newer_release");
});

test("same version and same digest is a no-op", () => {
  const decision = evaluateRuntimeUpdate(
    installed(),
    release("1.0.0", A.toUpperCase(), COMMIT_A),
  );

  assert.equal(decision.outcome, "noop");
  assert.equal(decision.reason, "already_installed");
});

test("same version with a different digest is rejected as a version collision", () => {
  const decision = evaluateRuntimeUpdate(
    installed(),
    release("1.0.0", B, COMMIT_B),
  );

  assert.equal(decision.outcome, "reject");
  assert.equal(decision.reason, "version_digest_collision");
});

test("downgrade is blocked unless the exact previous release is trusted", () => {
  const target = release("0.9.0", B, COMMIT_B);

  const blocked = evaluateRuntimeUpdate(installed(), target);
  assert.equal(blocked.outcome, "reject");
  assert.equal(blocked.reason, "downgrade_blocked");

  const allowed = evaluateRuntimeUpdate(installed(), target, {
    trustedRollbackTarget: installed("0.9.0", B, COMMIT_B),
  });
  assert.equal(allowed.outcome, "rollback");
  assert.equal(allowed.reason, "trusted_previous_release");
});

test("rollback rejects a version match when digest or source commit differs", () => {
  const target = release("0.9.0", B, COMMIT_B);

  const wrongDigest = evaluateRuntimeUpdate(installed(), target, {
    trustedRollbackTarget: installed("0.9.0", C, COMMIT_B),
  });
  assert.equal(wrongDigest.outcome, "reject");
  assert.equal(wrongDigest.reason, "untrusted_rollback_target");

  const wrongCommit = evaluateRuntimeUpdate(installed(), target, {
    trustedRollbackTarget: installed("0.9.0", B, COMMIT_C),
  });
  assert.equal(wrongCommit.outcome, "reject");
  assert.equal(wrongCommit.reason, "untrusted_rollback_target");
});

test("candidate upgrades require explicit deployment opt-in", () => {
  const target = release("1.1.0-dev.1", B, COMMIT_B, "candidate");

  const blocked = evaluateRuntimeUpdate(installed(), target);
  assert.equal(blocked.outcome, "reject");
  assert.equal(blocked.reason, "candidate_blocked");

  const allowed = evaluateRuntimeUpdate(installed(), target, {
    allowCandidate: true,
  });
  assert.equal(allowed.outcome, "update");
});

test("stable channel cannot carry a prerelease version", () => {
  const invalid = evaluateRuntimeUpdate(
    installed(),
    release("1.1.0-rc.1", B, COMMIT_B, "stable"),
  );

  assert.equal(invalid.outcome, "reject");
  assert.equal(invalid.reason, "invalid_release_descriptor");
});

test("artifact verification streams SHA-256 and fails closed on mismatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bridge-update-"));
  const artifact = join(directory, "runtime.tar.gz");
  const content = Buffer.from("attested runtime artifact\n", "utf8");
  const expected = createHash("sha256").update(content).digest("hex");

  try {
    await writeFile(artifact, content);

    const verification = await verifyRuntimeArtifactFile(artifact, expected);
    assert.equal(verification.matches, true);
    assert.equal(verification.actualSha256, expected);

    await assert.rejects(
      () => assertRuntimeArtifactFileIntegrity(artifact, "0".repeat(64)),
      /SHA-256 verification failed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
