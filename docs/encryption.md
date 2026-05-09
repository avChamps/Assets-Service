# Encryption Document

## Purpose

This document describes encryption, hashing, token signing, transport security, and secret handling for the Assets Service.

## Password Protection

User passwords are never stored in plain text.

Current implementation:

- Passwords are hashed with `bcrypt`.
- Hash cost currently uses salt rounds value `10`.
- Login compares the submitted password with the stored bcrypt hash.
- Password reset writes a new bcrypt hash to the `users.password` field.

Operational requirement:

- Never log passwords, OTPs, reset tokens, JWT secrets, or database credentials.
- Consider increasing bcrypt cost after performance testing if login latency remains acceptable.

## Token Signing

The service uses JSON Web Tokens signed with `JWT_SECRET`.

Token types:

- Login OTP token, valid for 2 minutes.
- Forgot-password OTP token, valid for 2 minutes.
- Password reset token, valid for 10 minutes.
- Auth token, default valid for 1 day unless `JWT_EXPIRES_IN` overrides it.

JWT payloads include user and tenant identity fields used by protected routes. Some OTP tokens also include the OTP value and purpose field.

Operational requirements:

- Use a high-entropy production `JWT_SECRET`.
- Rotate `JWT_SECRET` after suspected exposure.
- Keep token lifetimes short for OTP and password reset flows.
- Send tokens only over HTTPS in production.

## Transport Encryption

Production deployments must terminate HTTPS/TLS at the load balancer, reverse proxy, or application gateway in front of this Express service.

External transport paths:

- Client to API: HTTPS required in production.
- API to SMTP provider: configured SMTP TLS/SSL should be enabled.
- API to VPS file storage: SFTP over SSH.
- API to MySQL: enable TLS if the database is reachable over an untrusted network.

## File Transfer Encryption

Uploaded documents are transferred from the API server to the VPS using SFTP through `ssh2-sftp-client`.

The SFTP credentials are loaded from:

- `VPS_SFTP_HOST`
- `VPS_SFTP_PORT`
- `VPS_SFTP_USERNAME`
- `VPS_SFTP_PASSWORD`

Recommended hardening:

- Prefer SSH key authentication over password authentication.
- Restrict the SFTP user to the upload directory.
- Disable direct root login for file uploads.
- Apply least-privilege filesystem permissions on the upload root.

## Encryption At Rest

Current application code does not perform field-level encryption for database columns or uploaded files. Protection at rest should be provided by infrastructure controls unless application-level encryption is added.

Recommended controls:

- Enable disk encryption on the database host and VPS storage volume.
- Enable encrypted database backups.
- Encrypt uploaded-file backups.
- Restrict database and upload storage access by network and identity.
- Consider application-level encryption for highly sensitive document content before upload.

## Secrets Management

Secrets are loaded from environment variables.

Sensitive secrets include:

- JWT signing secret.
- MySQL password.
- SMTP user/password.
- SFTP host/user/password or future SSH private key.
- WhatsApp session/auth data.

Requirements:

- Do not commit `.env` files or real values in `.env.example`.
- Use production secret management through the hosting platform, CI/CD secret store, or a dedicated secret manager.
- Rotate secrets when staff access changes or exposure is suspected.
- Keep `.env.example` limited to placeholder values.

## Audit And Monitoring

The service writes security-relevant records to `auditLogs`, including actor identity, action, entity, request path, IP address, user agent, and metadata.

Recommended monitoring:

- Repeated failed login attempts.
- Password reset activity.
- Unusual document upload volume.
- Cross-tenant access failures.
- Changes to user role/status.
- Secret or configuration changes in deployment tooling.

## Known Gaps And Recommendations

- Add database TLS configuration if MySQL is outside the private application network.
- Add file type validation and malware scanning for uploaded documents.
- Add encryption at rest verification to deployment runbooks.
- Move SFTP from password auth to SSH key auth.
- Add explicit token revocation strategy for compromised accounts.
- Add rate limiting for login, OTP, password reset, and upload endpoints.

