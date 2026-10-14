import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";

import { normalizeSha256 } from "./release-update-policy.js";

export interface RuntimeArtifactDigestVerification {
  expectedSha256: string;
  actualSha256: string;
  matches: boolean;
}

export async function verifyRuntimeArtifactFile(
  filePath: string,
  expectedSha256: string,
): Promise<RuntimeArtifactDigestVerification> {
  const expected = normalizeSha256(expectedSha256);
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  const actual = hash.digest("hex");
  const matches = timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex"),
  );

  return {
    expectedSha256: expected,
    actualSha256: actual,
    matches,
  };
}

export async function assertRuntimeArtifactFileIntegrity(
  filePath: string,
  expectedSha256: string,
): Promise<RuntimeArtifactDigestVerification> {
  const verification = await verifyRuntimeArtifactFile(filePath, expectedSha256);
  if (!verification.matches) {
    throw new Error("Runtime artifact SHA-256 verification failed.");
  }
  return verification;
}
