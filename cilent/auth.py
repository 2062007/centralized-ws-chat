import json
import os
import aiohttp
import pyaes
from crypto import encrypt, decrypt

CONFIG_FILE = 'config.json'

class AuthManager:
    def __init__(self):
        self.username = None
        self.token = None
        self.user_id = None
        self.config = None

    def has_creds(self):
        return os.path.exists(CONFIG_FILE)

    def load_and_login(self, master_pass):
        try:
            with open(CONFIG_FILE, 'r') as f:
                self.config = json.load(f)
            username = self.config['username']
            encrypted_pass = bytes.fromhex(self.config['encrypted_password'])
            # Decrypt with master_pass (using pyaes)
            decrypted = decrypt(encrypted_pass, master_pass.encode())
            password = decrypted.decode()
            # Now login via API
            return self._api_login(username, password)
        except Exception as e:
            print(f"Error loading credentials: {e}")
            return False

    def _api_login(self, username, password):
        # Call server login
        import asyncio
        async def login():
            async with aiohttp.ClientSession() as session:
                async with session.post('https://localhost/api/auth/login', 
                                        json={'username': username, 'password': password},
                                        ssl=False) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        self.username = data['username']
                        self.token = data['token']
                        self.user_id = data['userId']
                        return True
                    else:
                        return False
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(login())
        loop.close()
        if result:
            # Save credentials with encrypted password
            encrypted = encrypt(password.encode(), master_pass.encode())
            self.config = {
                'username': username,
                'encrypted_password': encrypted.hex()
            }
            with open(CONFIG_FILE, 'w') as f:
                json.dump(self.config, f)
        return result

    def login(self, username, password, master_pass):
        if self._api_login(username, password):
            # Save creds
            encrypted = encrypt(password.encode(), master_pass.encode())
            self.config = {
                'username': username,
                'encrypted_password': encrypted.hex()
            }
            with open(CONFIG_FILE, 'w') as f:
                json.dump(self.config, f)
            return True
        return False

    def register(self, username, password, master_pass):
        import asyncio
        async def reg():
            async with aiohttp.ClientSession() as session:
                async with session.post('https://localhost/api/auth/register',
                                        json={'username': username, 'password': password},
                                        ssl=False) as resp:
                    return resp.status == 201
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(reg())
        loop.close()
        return result
