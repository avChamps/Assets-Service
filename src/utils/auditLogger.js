const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

function getRequestIp(req) {
  const forwardedFor = req?.headers?.['x-forwarded-for'];

  if (forwardedFor) {
    return String(forwardedFor).split(',')[0].trim();
  }

  return req?.ip || req?.socket?.remoteAddress || null;
}

function toJson(value) {
  if (value === undefined || value === null) {
    return null;
  }

  return JSON.stringify(value);
}

async function logAuditEvent({
  connection,
  req,
  tenantId,
  actorUserId,
  actorEmail,
  action,
  entityType,
  entityId,
  entityLabel,
  status = 'success',
  metadata
}) {
  try {
    const user = req?.user || {};
    const db = connection || pool.promise();

    await db.query(
      `
        INSERT INTO auditLogs (
          auditId,
          tenantId,
          actorUserId,
          actorEmail,
          action,
          entityType,
          entityId,
          entityLabel,
          status,
          ipAddress,
          userAgent,
          requestMethod,
          requestPath,
          metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        uuidv4(),
        tenantId || user.tenantId || null,
        actorUserId || user.userId || null,
        actorEmail || user.workEmail || null,
        action,
        entityType,
        entityId || null,
        entityLabel || null,
        status,
        getRequestIp(req),
        req?.headers?.['user-agent'] || null,
        req?.method || null,
        req?.originalUrl || req?.url || null,
        toJson(metadata)
      ]
    );
  } catch (error) {
    console.warn('Audit log write failed:', error.message);
  }
}

module.exports = {
  logAuditEvent
};
