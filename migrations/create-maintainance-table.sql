CREATE TABLE IF NOT EXISTS maintainance (
  id BIGINT NOT NULL AUTO_INCREMENT,
  tenantId VARCHAR(36) NOT NULL,
  userId VARCHAR(36) NOT NULL,
  assetId VARCHAR(36) NOT NULL,
  status ENUM('working', 'not working', 'pending') NOT NULL,
  action ENUM('verified', 'not verified', 'pending') NOT NULL DEFAULT 'not verified',
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_maintainance_tenant_createdAt (tenantId, createdAt),
  KEY idx_maintainance_tenant_asset (tenantId, assetId),
  KEY idx_maintainance_user_createdAt (userId, createdAt),
  KEY idx_maintainance_status_action (status, action),
  CONSTRAINT fk_maintainance_tenant
    FOREIGN KEY (tenantId) REFERENCES tenants (tenantId)
    ON DELETE CASCADE,
  CONSTRAINT fk_maintainance_user
    FOREIGN KEY (userId) REFERENCES users (userId)
    ON DELETE CASCADE,
  CONSTRAINT fk_maintainance_asset
    FOREIGN KEY (assetId) REFERENCES assets (id)
    ON DELETE CASCADE
);
