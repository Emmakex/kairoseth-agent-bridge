import assert from "node:assert/strict";
import test from "node:test";

import { validateStableReleaseIdentity } from "../../src/update/stable-release-policy.js";

test("stable release identity accepts exact vMAJOR.MINOR.PATCH", () => {
  assert.deepEqual(validateStableReleaseIdentity("v1.2.3", "1.2.3"), {
    tag: "v1.2.3",
    version: "1.2.3",
  });
  assert.deepEqual(validateStableReleaseIdentity("v0.1.0", "0.1.0"), {
    tag: "v0.1.0",
    version: "0.1.0",
  });
});

test("stable release identity rejects prerelease and build metadata", () => {
  assert.throws(
    () => validateStableReleaseIdentity("v1.2.3-dev.1", "1.2.3-dev.1"),
    /without prerelease or build metadata/i,
  );
  assert.throws(
    () => validateStableReleaseIdentity("v1.2.3+build.7", "1.2.3+build.7"),
    /without prerelease or build metadata/i,
  );
});

test("stable release identity rejects tag/version mismatch", () => {
  assert.throws(
    () => validateStableReleaseIdentity("v1.2.4", "1.2.3"),
    /exactly match package version/i,
  );
});

test("stable release identity rejects loose or zero-padded semver", () => {
  for (const version of ["1.2", "01.2.3", "1.02.3", "1.2.03", "v1.2.3"]) {
    assert.throws(
      () => validateStableReleaseIdentity(`v${version}`, version),
      /must be exact major\.minor\.patch/i,
    );
  }
});
