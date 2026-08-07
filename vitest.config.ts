import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The heaviest specs (e.g. sync idempotency) run several full syncAll passes
    // over the miniflare D1 isolate, which carries real per-op overhead. Vitest's
    // 5s default is tight for that under a loaded CI runner and flakes as a timeout
    // (not an assertion). 15s gives headroom while still failing a genuine hang.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // Test-only overrides so specs are self-contained and deterministic.
        // Secrets are NOT in wrangler.toml — supply them here for tests only.
        bindings: {
          GORELO_BASE_URL: "https://api.usw.gorelo.io",
          ENFORCE_IP_ALLOWLIST: "false",
          // SENTRY_ENABLED is deliberately unset here: the Sentry monitor is off by
          // default, so the suite never emits to the hardcoded DSN and specs stay
          // hermetic. (Production opts in via wrangler.toml [vars].)
          // Keep the token gate off by default in tests so resource-endpoint specs
          // don't need to mint a bearer token. Production sets this in wrangler.toml
          // (currently "enforce"); the dedicated enforcement specs override the mode
          // per-test via env.HALO_TOKEN_ENFORCE, so all three modes are still covered.
          HALO_TOKEN_ENFORCE: "off",          
          DEFAULT_GROUP_ID: "7",
          DEFAULT_TYPE_ID: "3",
          DEFAULT_STATUS_ID: "1",
          DEFAULT_PRIORITY: "2",
          DEFAULT_SOURCE: "6",
          CATCHALL_CLIENT_ID: "999",
          HDB_TAG_ID: "31974",
          HUNTRESS_TAG_ID: "32870",
          FALLBACK_TAG_ID: "32885",
          EMERGENCY_PRIORITY: "1",
          GORELO_API_KEY: "test-gorelo-key",
          ADMIN_KEY: "test-admin-key",
          NOTIFLY_URLS: "jsons://hooks.example.com/dead-letter",
          HALO_CLIENT_ID: "halo-test-id",
          HALO_CLIENT_SECRET: "halo-test-secret",
          // Monitoring-alert ingress (POST /v1/alerts). IP allowlist is off in tests
          // (ENFORCE_IP_ALLOWLIST=false), so only the shared secret gates the endpoint.
          ALERT_SHARED_SECRET: "alert-test-secret",
        },
      },
    }),
  ],
});
