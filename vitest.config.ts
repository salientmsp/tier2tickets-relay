import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // Test-only overrides so specs are self-contained and deterministic.
        // Secrets are NOT in wrangler.toml — supply them here for tests only.
        bindings: {
          GORELO_BASE_URL: "https://api.usw.gorelo.io",
          ENFORCE_IP_ALLOWLIST: "false",
          DEFAULT_GROUP_ID: "7",
          DEFAULT_TYPE_ID: "3",
          DEFAULT_STATUS_ID: "1",
          DEFAULT_PRIORITY: "2",
          DEFAULT_SOURCE: "6",
          CATCHALL_CLIENT_ID: "999",
          HDB_TAG_ID: "31974",
          EMERGENCY_PRIORITY: "1",
          GORELO_API_KEY: "test-gorelo-key",
          ADMIN_KEY: "test-admin-key",
          HALO_CLIENT_ID: "halo-test-id",
          HALO_CLIENT_SECRET: "halo-test-secret",
        },
      },
    }),
  ],
});
