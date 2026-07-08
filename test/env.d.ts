/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { Env as WorkerEnv } from "../src/types.js";

// @cloudflare/vitest-pool-workers >=0.6 types `env` from "cloudflare:test" as
// Cloudflare.Env. Augment it with this Worker's binding/var shape.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
