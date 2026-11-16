/// <reference types="@cloudflare/vitest-plugin/types" />
import type { Env as WorkerEnv } from "../src/core/types.js";

// @cloudflare/vitest-plugin types `env` from "cloudflare:test" as
// Cloudflare.Env. Augment it with this Worker's binding/var shape.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
