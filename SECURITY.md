# Security Policy

## Reporting a vulnerability

Please report suspected security issues **privately** — do not open a public
issue for anything exploitable.

- Preferred: GitHub's **private vulnerability reporting** for this repository
  (the **Security → Report a vulnerability** tab), which opens a private advisory
  visible only to the maintainers.
- If that is unavailable, contact the repository owner
  ([`00o-sh`](https://github.com/00o-sh)) directly.

Please include enough detail to reproduce (affected endpoint/behavior, a minimal
request, and the impact you observed). We will acknowledge receipt and work with
you on a fix and disclosure timeline. There is no bug-bounty program.

## Scope

This project is a Cloudflare Worker that impersonates a HaloPSA/ITSM instance so
products with a HaloPSA integration (Tier2Tickets / Helpdesk Buttons, Huntress, …)
can create tickets in Gorelo. Security-relevant surfaces:

- The Halo mock endpoints (`/token`, `/users`, `/tickets`, `/actions`, `/api/*`, …)
  and their per-product allowlist (source IP + optional User-Agent gate) + optional
  bearer-token gate.
- The admin endpoints (`/admin/*`) gated by `ADMIN_KEY`.
- Logging (what is and isn't emitted when `DEBUG_LOGS` is off).
- Handling of secrets (`GORELO_API_KEY`, `ADMIN_KEY`, `NOTIFLY_URLS`, the optional
  Halo OAuth pair).

See the [Security section of the README](README.md#security) for the current
controls and how to configure them.

## Current posture

A security review of this relay identified several findings. The following have
been remediated (see the README Security section for details and configuration):

- **Product allowlist fails closed** — enforced by default; only enabled products'
  source IPs/CIDRs (plus an optional per-product User-Agent gate) may reach the mock.
  Disabled only by an explicit `ENFORCE_IP_ALLOWLIST` of `false`/`0`/empty.
- **Bearer-token enforcement** — when the Halo OAuth credentials are set, `/token`
  mints a signed HMAC token and `HALO_TOKEN_ENFORCE` (`off`/`observe`/`enforce`)
  governs whether it is required on the resource endpoints.
- **Reduced log/error disclosure** — no PII, payloads, raw upstream error bodies,
  or internals are logged or returned when `DEBUG_LOGS` is off; 500s return a
  correlatable `request_id` instead of internal detail.
- **Constant-time `ADMIN_KEY` comparison.**
- **Scrubbed notifly error strings** (no destination URLs / signing tokens in logs).

**Known, intentionally deferred items** (they require design decisions and are
**not** addressed here): request **rate limiting** and **routing/contact-trust**
hardening. Deploy accordingly and layer your own controls (e.g. Cloudflare WAF /
rate limiting) as needed.

## AI-assisted development disclosure

Parts of this repository — including some of the security remediations described
above — were written with the assistance of an AI coding tool. The AI:

- **does not claim authorship of or credit for the pre-existing code** it
  modified. The original relay and its logic are the work of the human authors /
  copyright holder; the AI's contribution is limited to the specific changes in
  the commits/pull requests where it was used.
- produces code that **has not been independently proven correct**. It fixed
  concrete issues we had and **works for our deployment**, but AI-generated code
  can contain subtle mistakes.

**If you adopt, fork, or deploy this code, review it yourself.** Do not rely on
it for your environment without your own security review and testing. "Works for
us" is not a guarantee that it is correct, complete, or safe for your use case.

## No warranty / limitation of liability

This software is provided under the [MIT License](LICENSE), **"AS IS", without
warranty of any kind**, express or implied, including but not limited to the
warranties of merchantability, fitness for a particular purpose, and
non-infringement. In no event shall the authors or copyright holders be liable
for any claim, damages, or other liability arising from, out of, or in connection
with the software or its use.

Nothing in this document — including the security controls or the remediation
summary above — constitutes a warranty that the software is free of
vulnerabilities or fit for any particular purpose. You use it at your own risk.
