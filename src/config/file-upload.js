const Client = require('ssh2-sftp-client');
const path = require('path');

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  if (/^your-.+/.test(value)) {
    throw new Error(`${name} is still set to the placeholder value '${value}'`);
  }

  return value;
}

function normalizeRemotePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeRemoteFolder(folder) {
  return String(folder || 'Product-Images')
    .split('/')
    .map(normalizeRemotePart)
    .filter(Boolean)
    .join('/');
}

async function uploadToVPS(localPath, remoteFilename, folder = 'Product-Images') {
  const sftp = new Client();
  const targetFolder = normalizeRemoteFolder(folder);
  const safeFilename = normalizeRemotePart(remoteFilename || path.basename(localPath));
  const rootDir = process.env.VPS_UPLOAD_ROOT_DIR || '/var/www/AVChamps-Images';
  const publicBasePath = process.env.VPS_UPLOAD_PUBLIC_BASE_PATH || '/AVChamps-Images';
  const remoteDir = path.posix.join(rootDir, targetFolder);
  const remotePath = path.posix.join(remoteDir, safeFilename);
  const publicPath = path.posix.join(publicBasePath, targetFolder, safeFilename);
  let connected = false;

  try {
    await sftp.connect({
      host: getRequiredEnv('VPS_SFTP_HOST'),
      port: Number.parseInt(process.env.VPS_SFTP_PORT || '22', 10),
      username: getRequiredEnv('VPS_SFTP_USERNAME'),
      password: getRequiredEnv('VPS_SFTP_PASSWORD')
    });
    connected = true;

    await sftp.mkdir(remoteDir, true);
    await sftp.put(localPath, remotePath);

    return publicPath;
  } catch (error) {
    if (/All configured authentication methods failed/i.test(error.message)) {
      throw new Error('SFTP authentication failed. Check VPS_SFTP_USERNAME and VPS_SFTP_PASSWORD.');
    }

    const detail = error.message && error.message.trim()
      ? error.message
      : 'No error detail returned by the SFTP client';

    throw new Error(`SFTP upload failed: ${detail}`);
  } finally {
    if (connected) {
      await sftp.end().catch(() => {});
    }
  }
}

module.exports = uploadToVPS;
