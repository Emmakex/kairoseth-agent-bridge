import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLinuxServiceActivationPlan,
  linuxReleaseDirectoryName,
  type LinuxInstalledRuntimeRelease,
  type RuntimeReleaseDescriptor,
} from "../../src/index.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const COMMIT_A = "1".repeat(40);
const COMMIT_B = "2".repeat(40);
const COMMIT_C = "3".repeat(40);

function releasePath(digest: string, root = "/opt/agent-bridge/releases"): string {
  return `${root}/${linuxReleaseDirectoryName(digest)}`;
}

function installed(
  packageVersion = "1.0.0",
  artifactSha256 = A,
  sourceCommit = COMMIT_A,
): LinuxInstalledRuntimeRelease {
  return {
    packageVersion,
    artifactSha256,
    sourceCommit,
    releasePath: releasePath(artifactSha256),
  };
}

function target(
  packageVersion = "1.1.0",
  artifactSha256 = B,
  sourceCommit = COMMIT_B,
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

test("Linux activation plan accepts a newer exact digest-bound release", () => {
  const next = target();
  const result = buildLinuxServiceActivationPlan({
    current: installed(),
    target: next,
    candidateReleasePath: releasePath(next.artifactSha256),
  });

  assert.equal(result.outcome, "activate");
  if (result.outcome !== "activate") return;
  assert.equal(result.mode, "update");
  assert.equal(result.reason, "newer_release");
  assert.equal(result.rollbackReleasePath, releasePath(A));
  assert.equal(result.candidateReleasePath, releasePath(B));
});

test("Linux activation plan returns noop only for the same digest-bound directory", () => {
  const current = installed();
  const same = target("1.0.0", A, COMMIT_A);
  const result = buildLinuxServiceActivationPlan({
    current,
    target: same,
    candidateReleasePath: current.releasePath,
  });

  assert.deepEqual(result, {
    outcome: "noop",
    reason: "already_installed",
    activeReleasePath: current.releasePath,
    target: same,
  });
});

test("Linux activation plan rejects a release identity resolving to another directory", () => {
  const current = installed();
  const same = target("1.0.0", A, COMMIT_A);
  const result = buildLinuxServiceActivationPlan({
    current,
    target: same,
    candidateReleasePath: releasePath(A, "/srv/agent-bridge/releases"),
  });

  assert.equal(result.outcome, "reject");
  if (result.outcome === "reject") {
    assert.equal(result.reason, "release_path_collision");
  }
});

test("Linux activation plan blocks an untrusted downgrade", () => {
  const current = installed("2.0.0", B, COMMIT_B);
  const previous = target("1.0.0", A, COMMIT_A);
  const result = buildLinuxServiceActivationPlan({
    current,
    target: previous,
    candidateReleasePath: releasePath(A),
  });

  assert.equal(result.outcome, "reject");
  if (result.outcome === "reject") assert.equal(result.reason, "downgrade_blocked");
});

test("Linux activation plan allows only the exact trusted previous release rollback", () => {
  const current = installed("2.0.0", B, COMMIT_B);
  const previous = target("1.0.0", A, COMMIT_A);
  const trusted: LinuxInstalledRuntimeRelease = {
    packageVersion: previous.packageVersion,
    artifactSha256: previous.artifactSha256,
    sourceCommit: previous.sourceCommit,
    releasePath: releasePath(A),
  };

  const result = buildLinuxServiceActivationPlan({
    current,
    target: previous,
    candidateReleasePath: trusted.releasePath,
    trustedRollbackTarget: trusted,
  });

  assert.equal(result.outcome, "activate");
  if (result.outcome !== "activate") return;
  assert.equal(result.mode, "rollback");
  assert.equal(result.reason, "trusted_previous_release");
  assert.equal(result.candidateReleasePath, trusted.releasePath);
  assert.equal(result.rollbackReleasePath, current.releasePath);
});

test("Linux activation plan rejects a candidate directory that is not bound to its artifact", () => {
  const next = target();
  const result = buildLinuxServiceActivationPlan({
    current: installed(),
    target: next,
    candidateReleasePath: releasePath(C),
  });

  assert.equal(result.outcome, "reject");
  if (result.outcome === "reject") {
    assert.equal(result.reason, "invalid_candidate_release_path");
  }
});

test("Linux candidate releases require explicit opt-in", () => {
  const next = target("1.1.0-rc.1", C, COMMIT_C, "candidate");
  const blocked = buildLinuxServiceActivationPlan({
    current: installed(),
    target: next,
    candidateReleasePath: releasePath(C),
  });
  assert.equal(blocked.outcome, "reject");
  if (blocked.outcome === "reject") assert.equal(blocked.reason, "candidate_blocked");

  const allowed = buildLinuxServiceActivationPlan({
    current: installed(),
    target: next,
    candidateReleasePath: releasePath(C),
    allowCandidate: true,
  });
  assert.equal(allowed.outcome, "activate");
});
