ALTER TABLE assets
  ADD COLUMN serialNoUnique VARCHAR(255)
    GENERATED ALWAYS AS (
      CASE
        WHEN isActive = 1 AND serialNo IS NOT NULL AND TRIM(serialNo) <> ''
        THEN LOWER(TRIM(serialNo))
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN ipAddressUnique VARCHAR(255)
    GENERATED ALWAYS AS (
      CASE
        WHEN isActive = 1 AND ipAddress IS NOT NULL AND TRIM(ipAddress) <> ''
        THEN LOWER(TRIM(ipAddress))
        ELSE NULL
      END
    ) STORED,
  ADD COLUMN macAddressUnique VARCHAR(255)
    GENERATED ALWAYS AS (
      CASE
        WHEN isActive = 1 AND macAddress IS NOT NULL AND TRIM(macAddress) <> ''
        THEN LOWER(TRIM(macAddress))
        ELSE NULL
      END
    ) STORED,
  ADD UNIQUE KEY uq_assets_tenant_active_serial_no (tenantId, serialNoUnique),
  ADD UNIQUE KEY uq_assets_tenant_active_ip_address (tenantId, ipAddressUnique),
  ADD UNIQUE KEY uq_assets_tenant_active_mac_address (tenantId, macAddressUnique);
