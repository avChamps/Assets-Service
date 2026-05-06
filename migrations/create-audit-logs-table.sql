CREATE TABLE IF NOT EXISTS auditLogs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  auditId VARCHAR(36) NOT NULL,
  tenantId VARCHAR(36) NULL,
  actorUserId VARCHAR(36) NULL,
  actorEmail VARCHAR(255) NULL,
  action VARCHAR(80) NOT NULL,
  entityType VARCHAR(80) NOT NULL,
  entityId VARCHAR(80) NULL,
  entityLabel VARCHAR(255) NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'success',
  ipAddress VARCHAR(64) NULL,
  userAgent VARCHAR(512) NULL,
  requestMethod VARCHAR(10) NULL,
  requestPath VARCHAR(1024) NULL,
  metadata JSON NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auditLogs_auditId (auditId),
  KEY idx_auditLogs_tenant_createdAt (tenantId, createdAt),
  KEY idx_auditLogs_actor_createdAt (actorUserId, createdAt),
  KEY idx_auditLogs_action_createdAt (action, createdAt),
  KEY idx_auditLogs_entity (entityType, entityId),
  CONSTRAINT fk_auditLogs_tenant
    FOREIGN KEY (tenantId) REFERENCES tenants (tenantId)
    ON DELETE CASCADE,
  CONSTRAINT fk_auditLogs_actor
    FOREIGN KEY (actorUserId) REFERENCES users (userId)
    ON DELETE SET NULL
);
