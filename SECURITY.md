# Security Policy

## Demo Security Boundary

CrisisRoute AI is a hackathon demonstration, not a production emergency service. It currently has no production-grade identity, authentication, authorization, distributed rate limiting, or persistent audit store. Do not expose it as an operational dispatch system.

## Implemented Controls

- `GONKA_API_KEY` is used only by the Node server and is never sent to browser code.
- `.env`, `.env.local`, and `.env.*.local` are ignored and excluded from release archives.
- The static server exposes an explicit root/source allowlist and blocks dotfiles, traversal, encoded separators, and nonpublic backend files.
- Request bodies and Gonka responses have bounded sizes.
- Production requires an explicit Live switch and complete server-side configuration.
- Analyze is limited to one concurrent request and a bounded per-process submission budget.
- Static and API responses include CSP, clickjacking, MIME-sniffing, referrer, and permissions protections.
- API responses use `Cache-Control: no-store`; HTTPS production requests receive HSTS.
- Public errors use allowlisted codes and fields without stack, cause, prompt, raw content, or credentials.
- No `Access-Control-Allow-Origin: *` policy is configured.
- Graceful shutdown stops new analysis work and closes the listener without printing secrets.

The Analyze counter is intentionally in memory and resets on restart. It is demo cost protection, not a complete production quota system.

## Secret Handling

Store the Gonka key in `.env.local` for local development or the hosting platform's secret environment controls. Never put credentials in `render.yaml`, screenshots, videos, issues, logs, browser storage, or chat transcripts. Rotate a key immediately if exposed.

## Reporting a Vulnerability

Report security concerns privately to the project maintainers through the private contact channel associated with the hackathon submission. Do not include live credentials, personal crisis data, or exploit details in a public issue. Provide a minimal reproduction using synthetic data.
