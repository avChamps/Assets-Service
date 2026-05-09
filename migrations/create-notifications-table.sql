CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT NOT NULL AUTO_INCREMENT,
  notificationId VARCHAR(36) NOT NULL,
  tenantId VARCHAR(36) NOT NULL,
  userId VARCHAR(36) NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(80) NOT NULL DEFAULT 'general',
  linkUrl VARCHAR(1024) NULL,
  entityType VARCHAR(80) NULL,
  entityId VARCHAR(80) NULL,
  isRead TINYINT(1) NOT NULL DEFAULT 0,
  readAt TIMESTAMP NULL DEFAULT NULL,
  createdBy VARCHAR(36) NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_notifications_notificationId (notificationId),
  KEY idx_notifications_tenant_user_createdAt (tenantId, userId, createdAt),
  KEY idx_notifications_tenant_user_isRead (tenantId, userId, isRead),
  KEY idx_notifications_entity (entityType, entityId),
  CONSTRAINT fk_notifications_tenant
    FOREIGN KEY (tenantId) REFERENCES tenants (tenantId)
    ON DELETE CASCADE,
  CONSTRAINT fk_notifications_user
    FOREIGN KEY (userId) REFERENCES users (userId)
    ON DELETE CASCADE,
  CONSTRAINT fk_notifications_createdBy
    FOREIGN KEY (createdBy) REFERENCES users (userId)
    ON DELETE SET NULL
);
