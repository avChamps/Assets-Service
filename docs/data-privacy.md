# Data Privacy Document

## Purpose

This document describes how the Assets Service handles tenant, user, asset, document, notification, audit, and subscription data. It is intended for engineering, operations, and customer/security review.

## Data Collected

The service stores business and user data needed to operate the asset management platform:

- Tenant/company data: tenant ID, company name, company domain, company size, expected asset count, subscription type.
- User data: user ID, tenant ID, full name, work email, phone number, job title, location, role, account status, password hash, audit fields.
- Authentication data: JWT-issued user/tenant identity, short-lived OTP tokens for login and password reset flows.
- Asset and operational records: asset data, tickets, maintenance, warranty, retired inventory, analytics/reporting data.
- Documents: original filename, document ID, document type, uploaded user, tenant ID, uploaded timestamp, and remote file URL/path.
- Notifications: title, message, type, link URL, entity references, read status, creator, tenant ID, and user ID.
- Audit logs: actor user/email, tenant ID, action, entity type, status, IP address, user agent, request method/path, metadata, and creation timestamp.
- Subscription data: plan type, amount, currency, dates, status, notes, creator/updater.

## Data Use

Data is used only for application functionality:

- Authenticating users and enforcing tenant-scoped access.
- Managing assets, documents, tickets, maintenance, warranty tracking, notifications, reports, and subscriptions.
- Sending OTP emails for login and password reset.
- Sending operational WhatsApp notifications for signup/login events.
- Recording audit events for security, operational traceability, and support investigation.

## Access Control

Most API routes require a Bearer JWT. The token is verified using `JWT_SECRET`, and protected routes require token payload fields such as `tenantId` and `userId`.

Tenant isolation is enforced in route queries by filtering records with the authenticated user's `tenantId`. For example, document and notification endpoints restrict reads and writes to records belonging to the caller's tenant.

User role information is included in the JWT payload and user records. Any privileged operation should verify the caller's role before execution.

## Data Sharing

The service may send limited operational data to configured third-party infrastructure:

- SMTP provider: receives user email addresses and OTP email content for authentication flows.
- WhatsApp integration: receives signup/login notification messages when enabled.
- VPS/SFTP storage: receives uploaded document files.
- MySQL database provider/server: stores application records.

No data should be sold or used for unrelated advertising purposes.

## Data Retention

Current schema-level behavior includes cascading deletes from tenant/user relationships for several tables, such as documents, notifications, audit logs, and subscriptions where foreign keys are configured.

Recommended retention rules:

- User accounts: retain while the tenant account is active, then delete or anonymize according to customer contract.
- Documents: retain while needed for asset records; delete when the owning tenant or document is removed.
- Audit logs: retain for a defined security period, typically 180 to 365 days, unless a contract requires longer retention.
- OTP tokens: JWT-based OTP tokens are short-lived and are not stored server-side.
- Temporary upload files: remove immediately after upload completion or failure.

## User Rights Handling

Operational processes should support:

- Access request: export user, tenant, document metadata, and related audit data where permitted.
- Correction request: update incorrect user/company/profile data through authorized APIs or admin operations.
- Deletion request: remove or anonymize user data where legally and contractually permitted.
- Tenant deletion: remove tenant-scoped records and associated uploaded files from remote storage.

## Privacy Safeguards

- Passwords are stored as bcrypt hashes, not plain text.
- API routes use tenant-scoped query filters.
- JWT secrets, SMTP credentials, database credentials, and SFTP credentials are loaded from environment variables.
- Audit logs capture security-relevant events.
- Document uploads use generated remote filenames to reduce filename collision and unsafe path risk.

## Operational Requirements

- Do not commit real secrets to source control or example environment files.
- Limit production database and VPS access to authorized operators only.
- Run production traffic over HTTPS.
- Review audit logs for suspicious authentication failures and unusual access patterns.
- Define and periodically test tenant offboarding and data deletion procedures.

