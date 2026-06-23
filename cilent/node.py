import json
import os
import sqlite3

class NodeManager:
    def __init__(self, username):
        self.username = username
        self.enabled = False
        self.db_path = f'node_{username}.db'
        self._init_db()

    def _init_db(self):
        self.conn = sqlite3.connect(self.db_path)
        self.conn.execute('''
            CREATE TABLE IF NOT EXISTS node_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                encrypted_text TEXT NOT NULL,
                received_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        self.conn.commit()

    def set_enabled(self, enabled):
        self.enabled = enabled

    def store_encrypted(self, encrypted):
        if self.enabled:
            self.conn.execute('INSERT INTO node_data (encrypted_text) VALUES (?)', (encrypted,))
            self.conn.commit()

    def get_all_encrypted(self):
        cursor = self.conn.execute('SELECT encrypted_text FROM node_data ORDER BY id')
        return [row[0] for row in cursor.fetchall()]

    async def send_sync(self, ws_client):
        # Send all stored encrypted data to server
        all_data = self.get_all_encrypted()
        for data in all_data:
            await ws_client.send({
                'type': 'node_sync',
                'encrypted_data': data
            })
        # Optionally clear after sending? We'll keep for now.
        print(f"Sent {len(all_data)} node sync entries to server")
