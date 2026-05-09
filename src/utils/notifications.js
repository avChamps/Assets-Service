const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

function cleanText(value) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

async function createNotification({
  db,
  tenantId,
  userId = null,
  title,
  message,
  type = 'general',
  linkUrl = null,
  entityType = null,
  entityId = null,
  createdBy = null
}) {
  const normalizedTitle = cleanText(title);
  const normalizedMessage = cleanText(message);

  if (!tenantId || !normalizedTitle || !normalizedMessage) {
    return null;
  }

  const queryRunner = db || pool.promise();
  const notificationId = uuidv4();

  await queryRunner.query(
    `
      INSERT INTO notifications (
        notificationId,
        tenantId,
        userId,
        title,
        message,
        type,
        linkUrl,
        entityType,
        entityId,
        createdBy
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      notificationId,
      tenantId,
      cleanText(userId),
      normalizedTitle,
      normalizedMessage,
      cleanText(type) || 'general',
      cleanText(linkUrl),
      cleanText(entityType),
      cleanText(entityId),
      cleanText(createdBy)
    ]
  );

  return notificationId;
}

async function createNotificationSafely(payload) {
  try {
    return await createNotification(payload);
  } catch (error) {
    console.error('Notification creation failed:', error.message);
    return null;
  }
}

async function createNotificationsSafely(notifications) {
  const createdIds = [];

  for (const notification of notifications) {
    const notificationId = await createNotificationSafely(notification);

    if (notificationId) {
      createdIds.push(notificationId);
    }
  }

  return createdIds;
}

module.exports = {
  createNotification,
  createNotificationSafely,
  createNotificationsSafely
};
