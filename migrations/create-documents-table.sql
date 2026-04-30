CREATE TABLE IF NOT EXISTS documents (
  id INT NOT NULL AUTO_INCREMENT,
  userId VARCHAR(36) NOT NULL,
  tenantId VARCHAR(36) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  imageUrl VARCHAR(1024) NOT NULL,
  documentId VARCHAR(36) NOT NULL,
  type VARCHAR(100) NOT NULL,
  uploadedBy VARCHAR(36) NOT NULL,
  uploadedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_documents_document_id (documentId),
  KEY idx_documents_tenant_uploaded_at (tenantId, uploadedAt),
  KEY idx_documents_user_id (userId),
  CONSTRAINT fk_documents_tenant
    FOREIGN KEY (tenantId) REFERENCES tenants (tenantId)
    ON DELETE CASCADE,
  CONSTRAINT fk_documents_user
    FOREIGN KEY (userId) REFERENCES users (userId)
    ON DELETE CASCADE,
  CONSTRAINT fk_documents_uploaded_by
    FOREIGN KEY (uploadedBy) REFERENCES users (userId)
    ON DELETE RESTRICT
);
