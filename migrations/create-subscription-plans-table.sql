CREATE TABLE IF NOT EXISTS subscriptionPlans (
  id INT NOT NULL AUTO_INCREMENT,
  subscriptionType VARCHAR(100) NOT NULL,
  maxUsers INT NOT NULL,
  maxAssets INT NOT NULL,
  isActive BOOLEAN NOT NULL DEFAULT TRUE,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_subscriptionPlans_subscription_type (subscriptionType),
  CONSTRAINT chk_subscriptionPlans_max_users CHECK (maxUsers > 0),
  CONSTRAINT chk_subscriptionPlans_max_assets CHECK (maxAssets > 0)
);

INSERT INTO subscriptionPlans (subscriptionType, maxUsers, maxAssets, isActive)
VALUES
  ('trial', 1, 25, TRUE),
  ('basic', 5, 100, TRUE),
  ('standard', 15, 500, TRUE),
  ('premium', 50, 2000, TRUE)
ON DUPLICATE KEY UPDATE
  maxUsers = VALUES(maxUsers),
  maxAssets = VALUES(maxAssets),
  isActive = VALUES(isActive);
