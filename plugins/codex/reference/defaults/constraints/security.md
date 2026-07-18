# Security Constraints

<!-- Reference this from any handoff that could touch auth, secrets, or
     external services. -->

## Secrets
- Never embed API keys, tokens, or passwords in output.
- Reference environment variables by name only.

## Network
- (e.g. no outbound HTTP except to allowed domains)
- (e.g. respect robots.txt and rate limits in browser tasks)

## Data
- (e.g. never log PII; redact emails and IPs in any captured output)

## Code execution
- (e.g. no eval, no shell injection, parameterized queries only)
