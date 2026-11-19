import asyncio
import sqlite3


class NodeManager:
    """Lưu các blob đã mã hoá do server gửi; client không thể giải mã chúng."""

    def __init__(self, username):
        self.username = username
        self.enabled = False
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
        self.conn.commit()

    def set_enabled(self, enabled):
        self.enabled = enabled

    def store_encrypted(self, encrypted):
        if self.enabled and isinstance(encrypted, str):
            self.conn.execute("INSERT INTO node_data (encrypted_text) VALUES (?)", (encrypted,))
            self.conn.commit()

    def count(self):
        return self.conn.execute("SELECT COUNT(*) FROM node_data").fetchone()[0]

    def get_all_encrypted(self):
        return [r[0] for r in self.conn.execute("SELECT encrypted_text FROM node_data ORDER BY id")]

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
