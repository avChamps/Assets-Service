# Storage Details Document

## Purpose

This document describes where the Assets Service stores application data, uploaded files, temporary files, credentials, and logs.

## Primary Database

The service uses MySQL through `mysql2` connection pooling.

Configuration is read from environment variables:

- `DB_HOST`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

The database stores tenant, user, asset, ticket, maintenance, warranty, subscription, notification, audit, and document metadata records.

## Main Tables

Important application tables include:

- `users`: user profile, tenant membership, role/status, and password hash.
- `tenants`: company/tenant profile and subscription defaults.
- `documents`: document metadata and the remote document URL/path.
- `notifications`: per-tenant/per-user notifications and read state.
- `auditLogs`: security and business activity trail.
- `tenantSubscriptions`: tenant subscription history and status.
- Asset-related tables used by asset, retired inventory, ticket, maintenance, warranty, report, and analytics routes.

## Document File Storage

Document upload flow:

1. The API receives a file on `POST /api/documents/upload` in the `file` field.
2. `multer` writes the file temporarily to the operating system temp directory under `assets-service-documents`.
3. The maximum accepted document size is 10 MB.
4. A generated filename is created with timestamp, UUID, sanitized original basename, and original extension.
5. The file is uploaded over SFTP to the configured VPS upload root.
6. The temporary local file is deleted after upload or on upload failure.
7. The database stores document metadata and the public path returned by the SFTP upload helper.

Default VPS paths:

- Remote root: `VPS_UPLOAD_ROOT_DIR`, default `/var/www/AVChamps-Images`
- Public base path: `VPS_UPLOAD_PUBLIC_BASE_PATH`, default `/AVChamps-Images`
- Tenant folder pattern: `assets-Images/{tenantId}`

## Temporary Storage

Temporary document files are stored under the host OS temp directory:

- Node expression: `path.join(os.tmpdir(), 'assets-service-documents')`
- Files are removed by the route after upload completion or handled error.

Operational cleanup should periodically remove stale files from this temp directory in case of process crashes.

## Authentication And Session Storage

The service uses stateless JWTs. Auth tokens, OTP tokens, and reset tokens are signed by the server and returned to the client; they are not stored in a database table.

Token lifetimes:

- Login OTP token: 2 minutes.
- Forgot password OTP token: 2 minutes.
- Password reset token: 10 minutes.
- Auth token: `JWT_EXPIRES_IN`, default 1 day.

## WhatsApp Auth Storage

WhatsApp/Baileys authentication state is stored locally in the `baileys_auth` directory. This directory contains integration session material and should be treated as sensitive operational data.

## Configuration Storage

Runtime configuration is loaded from `.env` through `dotenv`.

Sensitive values include:

- `JWT_SECRET`
- `DB_PASSWORD`
- SMTP credentials
- VPS SFTP credentials
- WhatsApp group/session configuration

Production secrets should be stored in a secret manager or protected deployment environment variables, not committed to the repository.

## Backup Requirements

Recommended backup scope:

- MySQL database: full scheduled backups plus point-in-time recovery where available.
- VPS upload root: scheduled backup of uploaded document files.
- Environment/secret configuration: backed up through the deployment secret manager, not plain files.

Recommended recovery checks:

- Restore database backup to a non-production environment.
- Verify document paths in `documents.imageUrl` still map to restored files.
- Validate tenant-level access after restore.

## Deletion Requirements

When deleting tenant data, remove:

- Tenant-scoped database rows.
- Associated document files from remote VPS storage.
- Related notifications and audit records according to retention policy.
- Any local integration/session state if it belongs exclusively to that tenant.

