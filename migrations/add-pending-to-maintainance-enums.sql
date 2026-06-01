ALTER TABLE maintainance
  MODIFY status ENUM('working', 'not working', 'pending') NOT NULL,
  MODIFY action ENUM('verified', 'not verified', 'pending') NOT NULL DEFAULT 'not verified';
