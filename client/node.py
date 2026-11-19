import asyncio
import sqlite3


class NodeManager:
    """Lưu các blob đã mã hoá do server gửi; client không thể giải mã chúng."""

    def __init__(self, username):
        self.username = username
        # Tên file an toàn (username đã được server giới hạn ký tự)
        safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in username)
        self.db_path = f"node_{safe}.db"
        self.conn = sqlite3.connect(self.db_path)
        self.conn.execute(
            """CREATE TABLE IF NOT EXISTS node_data (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   encrypted_text TEXT NOT NULL,
                   received_at DATETIME DEFAULT CURRENT_TIMESTAMP
               )"""
        )
        self.conn.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        # Nâng cấp DB cũ: thêm message_id (id tin nhắn trên server) để chống lưu trùng
        cols = [r[1] for r in self.conn.execute("PRAGMA table_info(node_data)")]
        if "message_id" not in cols:
            self.conn.execute("ALTER TABLE node_data ADD COLUMN message_id INTEGER")
        self.conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_node_message_id ON node_data(message_id)")
        self.conn.commit()
        # Mặc định BẬT: mọi client đều là node backup, trừ khi người dùng /node off
        row = self.conn.execute("SELECT value FROM settings WHERE key = 'node_enabled'").fetchone()
        self.enabled = True if row is None else row[0] == "1"

    def set_enabled(self, enabled):
        """Đổi chế độ node và lưu lại để lần chạy sau giữ nguyên."""
        self.enabled = enabled
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES ('node_enabled', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            ("1" if enabled else "0",),
        )
        self.conn.commit()

    def _get_setting(self, key, default=None):
        row = self.conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return default if row is None else row[0]

    def _set_setting(self, key, value):
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )

    @property
    def cursor(self):
        """id tin nhắn lớn nhất đã được đồng bộ bù xong (0 = chưa có gì)."""
        try:
            return int(self._get_setting("sync_cursor", "0"))
        except ValueError:
            return 0

    def set_cursor(self, value):
        self._set_setting("sync_cursor", int(value))
        self.conn.commit()

    def store_encrypted(self, encrypted, message_id=None):
        """Lưu 1 blob. Trả về True nếu là bản ghi mới (trùng message_id thì bỏ qua)."""
        if not (self.enabled and isinstance(encrypted, str)):
            return False
        if not isinstance(message_id, int) or isinstance(message_id, bool):
            message_id = None
        cur = self.conn.execute(
            "INSERT OR IGNORE INTO node_data (encrypted_text, message_id) VALUES (?, ?)",
            (encrypted, message_id),
        )
        self.conn.commit()
        return cur.rowcount > 0

    def count(self):
        return self.conn.execute("SELECT COUNT(*) FROM node_data").fetchone()[0]

    def get_all_encrypted(self):
        return [r[0] for r in self.conn.execute("SELECT encrypted_text FROM node_data ORDER BY COALESCE(message_id, id), id")]

    async def send_sync(self, ws_client):
        """Gửi lại toàn bộ dữ liệu đã lưu khi server yêu cầu khôi phục."""
        if not self.enabled:
            return 0
        items = self.get_all_encrypted()
        for i, data in enumerate(items, 1):
            await ws_client.send({"type": "node_sync", "encryptedData": data})
            if i % 50 == 0:
                await asyncio.sleep(0.05)  # nhường vòng lặp, tránh nghẽn
        return len(items)

    def close(self):
        self.conn.close()
