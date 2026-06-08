SET @schema_name = DATABASE();

SELECT IF(
  COUNT(*) = 0,
  'ALTER TABLE maintainance ADD COLUMN maintenanceType ENUM(''Break-Fix'', ''Software/Firmware upgrade'', ''General Check'', ''System Upgrade'') NULL DEFAULT NULL AFTER action',
  'SELECT ''maintenanceType column already exists'' AS message'
) INTO @add_maintenance_type_sql
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = @schema_name
  AND TABLE_NAME = 'maintainance'
  AND COLUMN_NAME = 'maintenanceType';

PREPARE add_maintenance_type_stmt FROM @add_maintenance_type_sql;
EXECUTE add_maintenance_type_stmt;
DEALLOCATE PREPARE add_maintenance_type_stmt;

SELECT IF(
  COUNT(*) = 0,
  'ALTER TABLE maintainance ADD KEY idx_maintainance_type (maintenanceType)',
  'SELECT ''idx_maintainance_type index already exists'' AS message'
) INTO @add_maintenance_type_index_sql
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = @schema_name
  AND TABLE_NAME = 'maintainance'
  AND INDEX_NAME = 'idx_maintainance_type';

PREPARE add_maintenance_type_index_stmt FROM @add_maintenance_type_index_sql;
EXECUTE add_maintenance_type_index_stmt;
DEALLOCATE PREPARE add_maintenance_type_index_stmt;
