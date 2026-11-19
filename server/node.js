const crypto = require('crypto');

// Khoá AES-256 luôn 32 byte: băm SHA-256 từ MASTER_KEY (chuỗi bất kỳ).
// Bản cũ dùng thẳng chuỗi nên sai độ dài khoá -> createCipheriv ném lỗi.
const RAW_MASTER = process.env.MASTER_KEY;
if (!RAW_MASTER || RAW_MASTER === 'your_32_byte_master_key_for_node_encryption' || RAW_MASTER.length < 16) {
  console.error('❌ MASTER_KEY chưa được đặt (hoặc quá ngắn, cần >= 16 ký tự). Hãy cấu hình trong .env');
  process.exit(1);
}
const MASTER_KEY = crypto.createHash('sha256').update(RAW_MASTER, 'utf8').digest();

// Định dạng: base64( iv(12) | tag(16) | ciphertext )
function encryptForNode(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

// Ném lỗi nếu dữ liệu bị sửa / sai khoá (GCM xác thực toàn vẹn)
function decryptFromNode(encryptedBase64) {
  if (typeof encryptedBase64 !== 'string' || encryptedBase64.length > 20000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encryptedBase64)) {
    throw new Error('invalid base64');
  }
  const buffer = Buffer.from(encryptedBase64, 'base64');
  if (buffer.length < 28 || buffer.toString('base64') !== encryptedBase64) throw new Error('blob too short or non-canonical base64');
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encryptForNode, decryptFromNode };
