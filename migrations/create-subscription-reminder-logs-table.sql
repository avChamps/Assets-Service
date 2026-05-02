CREATE TABLE IF NOT EXISTS subscriptionReminderLogs (
  id INT NOT NULL AUTO_INCREMENT,
  subscriptionId VARCHAR(36) NOT NULL,
  tenantId VARCHAR(36) NOT NULL,
  reminderType VARCHAR(50) NOT NULL,
  recipientEmail VARCHAR(255) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  errorMessage TEXT DEFAULT NULL,
  sentAt TIMESTAMP NULL DEFAULT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_subscriptionReminderLogs_subscription_type (subscriptionId, reminderType),
  KEY idx_subscriptionReminderLogs_tenant (tenantId),
  KEY idx_subscriptionReminderLogs_status (status),
  CONSTRAINT fk_subscriptionReminderLogs_subscription
    FOREIGN KEY (subscriptionId) REFERENCES tenantSubscriptions (subscriptionId)
    ON DELETE CASCADE,
  CONSTRAINT fk_subscriptionReminderLogs_tenant
    FOREIGN KEY (tenantId) REFERENCES tenants (tenantId)
    ON DELETE CASCADE
);
