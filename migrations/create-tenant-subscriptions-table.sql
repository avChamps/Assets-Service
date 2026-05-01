CREATE TABLE IF NOT EXISTS tenantSubscriptions (
  id INT NOT NULL AUTO_INCREMENT,
  subscriptionId VARCHAR(36) NOT NULL,
  tenantId VARCHAR(36) NOT NULL,
  subscriptionType VARCHAR(100) NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  subscriptionStartDate DATE NOT NULL,
  subscriptionEndDate DATE NOT NULL,
  paymentDate DATE DEFAULT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  notes TEXT DEFAULT NULL,
  createdBy VARCHAR(36) NOT NULL,
  updatedBy VARCHAR(36) DEFAULT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tenantSubscriptions_subscription_id (subscriptionId),
  KEY idx_tenantSubscriptions_tenant_dates (tenantId, subscriptionStartDate, subscriptionEndDate),
  KEY idx_tenantSubscriptions_status (status),
  CONSTRAINT fk_tenantSubscriptions_tenant
    FOREIGN KEY (tenantId) REFERENCES tenants (tenantId)
    ON DELETE CASCADE,
  CONSTRAINT fk_tenantSubscriptions_created_by
    FOREIGN KEY (createdBy) REFERENCES users (userId)
    ON DELETE RESTRICT,
  CONSTRAINT fk_tenantSubscriptions_updated_by
    FOREIGN KEY (updatedBy) REFERENCES users (userId)
    ON DELETE SET NULL
);
