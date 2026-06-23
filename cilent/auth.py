import json
import os
import aiohttp
from crypto import encrypt, decrypt

CONFIG_FILE = 'config.json'

class AuthManager:
    def __init__(self, server_url=None):
        self.username = None
        self.token = None
        self.user_id = None
        self.config = None
        # Lưu server_url
        self.server_url = server_url or os.getenv('CHAT_SERVER_URL', 'https://localhost')

    def has_creds(self):
        return os.path.exists(CONFIG_FILE)

    def load_and_login(self, master_pass):
        try:
            with open(CONFIG_FILE, 'r') as f:
                self.config = json.load(f)
            username = self.config['username']
            encrypted_pass = bytes.fromhex(self.config['encrypted_password'])
            decrypted = decrypt(encrypted_pass, master_pass.encode())
            password = decrypted.decode()
            return self._api_login(username, password)
        except Exception as e:
            print(f"Error loading credentials: {e}")
            return False

    def _api_login(self, username, password):
        import asyncio
        async def login():
            async with aiohttp.ClientSession() as session:
                url = f"{self.server_url}/api/auth/login"
                use_ssl = self.server_url.startswith('https://')
                async with session.post(url, json={'username': username, 'password': password}, ssl=use_ssl) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        self.username = data['username']
                        self.token = data['token']
                        self.user_id = data['userId']
                        return True
                    else:
                        error = await resp.text()
                        print(f"Login error: {error}")
                        return False
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(login())
        loop.close()
        return result

    def login(self, username, password, master_pass):
        if self._api_login(username, password):
            # Lưu thông tin đăng nhập (bao gồm cả server_url)
            encrypted = encrypt(password.encode(), master_pass.encode())
            self.config = {
                'username': username,
                'encrypted_password': encrypted.hex(),
                'server_url': self.server_url  # lưu URL để dùng sau
            }
            with open(CONFIG_FILE, 'w') as f:
                json.dump(self.config, f)
            return True
        return False

    def register(self, username, password, master_pass):
        import asyncio
        async def reg():
            async with aiohttp.ClientSession() as session:
                url = f"{self.server_url}/api/auth/register"
                use_ssl = self.server_url.startswith('https://')
                async with session.post(url, json={'username': username, 'password': password}, ssl=use_ssl) as resp:
                    return resp.status == 201
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(reg())
        loop.close()
        return result
