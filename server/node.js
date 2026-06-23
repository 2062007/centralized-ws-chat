const db = require('./db');
const crypto = require('crypto');

const MASTER_KEY = Buffer.from(process.env.MASTER_KEY || 'default32bytekey!!default32bytekey', 'utf8'); // 32 bytes

function encryptForNode(data) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptFromNode(encryptedBase64) {
  const buffer = Buffer.from(encryptedBase64, 'base64');
  const iv = buffer.subarray(0, 16);
  const tag = buffer.subarray(16, 32);
  const encrypted = buffer.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

function saveNodeData(userId, encryptedData) {
  const stmt = db.prepare('INSERT INTO node_sync (user_id, encrypted_data) VALUES (?, ?)');
  return stmt.run(userId, encryptedData);
}

function getNodeData(userId) {
  const stmt = db.prepare('SELECT encrypted_data FROM node_sync WHERE user_id = ? ORDER BY synced_at DESC LIMIT 1');
  const row = stmt.get(userId);
  return row ? row.encrypted_data : null;
}

module.exports = { encryptForNode, decryptFromNode, saveNodeData, getNodeData };
