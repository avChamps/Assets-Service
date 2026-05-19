const nm = require('nodemailer');
const pool = require('../config/db');

const REMINDER_DAYS_BEFORE_EXPIRY = 7;
const REMINDER_TYPE = 'subscription_expiry_7_days';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

let reminderJobStarted = false;

function getEmailConfig() {
  const config = {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== 'false',
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD
  };

  if (!config.host || !config.user || !config.password) {
    throw new Error('Email configuration missing. Set SMTP_HOST, SMTP_USER and SMTP_PASSWORD.');
  }

  return config;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatAmount(amount, currency) {
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount)) {
    return `${currency} ${amount}`;
  }

  return `${currency} ${numericAmount.toFixed(2)}`;
}

function createTransporter() {
  const emailConfig = getEmailConfig();

  return nm.createTransport({
    host: emailConfig.host,
    port: emailConfig.port,
    secure: emailConfig.secure,
    auth: {
      user: emailConfig.user,
      pass: emailConfig.password
    }
  });
}

async function getSubscriptionsDueForReminder(db) {
  const [rows] = await db.query(
    `
      SELECT
        s.subscriptionId,
        s.tenantId,
        s.subscriptionType,
        s.amount,
        s.currency,
        s.subscriptionStartDate,
        s.subscriptionEndDate,
        sp.maxUsers,
        sp.maxAssets,
        u.fullName,
        u.workEmail,
        t.companyName
      FROM tenantSubscriptions s
      INNER JOIN tenants t ON t.tenantId = s.tenantId
      INNER JOIN users u ON u.tenantId = s.tenantId
      LEFT JOIN subscriptionPlans sp
        ON sp.subscriptionType = s.subscriptionType
        AND sp.isActive = TRUE
      LEFT JOIN subscriptionReminderLogs rl
        ON rl.subscriptionId = s.subscriptionId
        AND rl.reminderType = ?
        AND rl.status = 'sent'
      WHERE LOWER(s.status) = 'active'
        AND s.subscriptionEndDate = DATE_ADD(CURDATE(), INTERVAL ? DAY)
        AND s.id = (
          SELECT latest.id
          FROM tenantSubscriptions latest
          WHERE latest.tenantId = s.tenantId
          ORDER BY latest.updatedAt DESC, latest.id DESC
          LIMIT 1
        )
        AND u.status = 'active'
        AND rl.id IS NULL
      ORDER BY s.subscriptionEndDate ASC, CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.fullName ASC
    `,
    [REMINDER_TYPE, REMINDER_DAYS_BEFORE_EXPIRY]
  );

  const byTenant = new Map();

  for (const row of rows) {
    if (!byTenant.has(row.tenantId)) {
      byTenant.set(row.tenantId, row);
    }
  }

  return Array.from(byTenant.values());
}

async function reserveReminder(db, subscription) {
  const [result] = await db.query(
    `
      INSERT IGNORE INTO subscriptionReminderLogs (
        subscriptionId,
        tenantId,
        reminderType,
        recipientEmail,
        status
      ) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        recipientEmail = VALUES(recipientEmail),
        status = CASE WHEN status = 'sent' THEN status ELSE 'pending' END,
        errorMessage = CASE WHEN status = 'sent' THEN errorMessage ELSE NULL END
    `,
    [
      subscription.subscriptionId,
      subscription.tenantId,
      REMINDER_TYPE,
      subscription.workEmail,
      'pending'
    ]
  );

  return result.affectedRows >= 1;
}

async function markReminderSent(db, subscriptionId) {
  await db.query(
    `
      UPDATE subscriptionReminderLogs
      SET status = 'sent', sentAt = CURRENT_TIMESTAMP, errorMessage = NULL
      WHERE subscriptionId = ? AND reminderType = ?
    `,
    [subscriptionId, REMINDER_TYPE]
  );
}

async function markReminderFailed(db, subscriptionId, errorMessage) {
  await db.query(
    `
      UPDATE subscriptionReminderLogs
      SET status = 'failed', errorMessage = ?
      WHERE subscriptionId = ? AND reminderType = ?
    `,
    [String(errorMessage || '').slice(0, 1000), subscriptionId, REMINDER_TYPE]
  );
}

async function sendExpiryReminderMail(transporter, subscription) {
  const emailConfig = getEmailConfig();
  const safeFullName = escapeHtml(subscription.fullName || 'User');
  const safeCompanyName = escapeHtml(subscription.companyName || 'your company');
  const safeSubscriptionType = escapeHtml(subscription.subscriptionType);
  const safeEndDate = escapeHtml(subscription.subscriptionEndDate);
  const safeStartDate = escapeHtml(subscription.subscriptionStartDate);
  const safeAmount = escapeHtml(formatAmount(subscription.amount, subscription.currency));
  const safeMaxUsers = escapeHtml(subscription.maxUsers || 'Not configured');
  const safeMaxAssets = escapeHtml(subscription.maxAssets || 'Not configured');

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Subscription Renewal Reminder</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f7f6;">
      <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #f4f7f6;">
        <tr>
          <td align="center" style="padding: 40px 16px;">
            <table width="600" border="0" cellpadding="0" cellspacing="0" style="width: 100%; max-width: 600px; background-color: #ffffff; border: 1px solid #dfe3e8; border-radius: 12px;">
              <tr>
                <td style="padding: 36px 40px 12px 40px;">
                  <h1 style="margin: 0; font-size: 28px; color: #1c293b;">Subscription renewal reminder</h1>
                </td>
              </tr>
              <tr>
                <td style="padding: 12px 40px 28px 40px; color: #555555; font-size: 16px; line-height: 1.6;">
                  <p style="margin: 0 0 18px;">Hello ${safeFullName},</p>
                  <p style="margin: 0 0 18px;">The subscription for ${safeCompanyName} will expire in ${REMINDER_DAYS_BEFORE_EXPIRY} days.</p>
                  <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #f4f7f6; border-radius: 8px;">
                    <tr><td style="padding: 16px 18px 8px;"><strong>Plan:</strong> ${safeSubscriptionType}</td></tr>
                    <tr><td style="padding: 8px 18px;"><strong>Start date:</strong> ${safeStartDate}</td></tr>
                    <tr><td style="padding: 8px 18px;"><strong>End date:</strong> ${safeEndDate}</td></tr>
                    <tr><td style="padding: 8px 18px;"><strong>Amount:</strong> ${safeAmount}</td></tr>
                    <tr><td style="padding: 8px 18px;"><strong>Allowed users:</strong> ${safeMaxUsers}</td></tr>
                    <tr><td style="padding: 8px 18px 16px;"><strong>Allowed assets:</strong> ${safeMaxAssets}</td></tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding: 0 40px 32px 40px; color: #555555; font-size: 14px;">
                  <p style="margin: 0;"><strong>Sincerely,</strong><br>TheAsset SystemsTeam</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  return transporter.sendMail({
    from: emailConfig.user,
    to: subscription.workEmail,
    subject: 'YourAsset Systemssubscription expires in 7 days',
    html: htmlContent
  });
}

async function runSubscriptionExpiryReminderJob() {
  const db = pool.promise();
  const subscriptions = await getSubscriptionsDueForReminder(db);

  if (!subscriptions.length) {
    return { sent: 0, failed: 0 };
  }

  const transporter = createTransporter();
  let sent = 0;
  let failed = 0;

  for (const subscription of subscriptions) {
    const reserved = await reserveReminder(db, subscription);

    if (!reserved) {
      continue;
    }

    try {
      await sendExpiryReminderMail(transporter, subscription);
      await markReminderSent(db, subscription.subscriptionId);
      sent += 1;
    } catch (error) {
      await markReminderFailed(db, subscription.subscriptionId, error.message);
      failed += 1;
    }
  }

  return { sent, failed };
}

function startSubscriptionReminderJob() {
  if (reminderJobStarted) {
    return;
  }

  reminderJobStarted = true;

  setTimeout(() => {
    runSubscriptionExpiryReminderJob()
      .then((result) => {
        console.log(
          `[SubscriptionReminder] Completed. Sent: ${result.sent}, Failed: ${result.failed}`
        );
      })
      .catch((error) => {
        console.error('[SubscriptionReminder] Failed:', error.message);
      });
  }, 10000);

  setInterval(() => {
    runSubscriptionExpiryReminderJob()
      .then((result) => {
        console.log(
          `[SubscriptionReminder] Completed. Sent: ${result.sent}, Failed: ${result.failed}`
        );
      })
      .catch((error) => {
        console.error('[SubscriptionReminder] Failed:', error.message);
      });
  }, ONE_DAY_MS);
}

module.exports = {
  runSubscriptionExpiryReminderJob,
  startSubscriptionReminderJob
};
