import { ensureImage, SANDBOX_IMAGE } from "../server/sandbox.ts";

// Build the sandbox image up front so the first run in a spec doesn't pay for it inside a test timeout.
export default async () => {
  await ensureImage(SANDBOX_IMAGE);
};
