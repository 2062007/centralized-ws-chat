import json
import os
from urllib.parse import urlparse

import aiohttp

from crypto import encrypt, decrypt

CONFIG_FILE = "config.json"


def normalize_url(url):
    url = (url or "").strip().rstrip("/")
    if url and "://" not in url:
        url = "https://" + url
    return url


def ssl_param(server_url):
    """None = xác minh chứng chỉ bình thường; False = bỏ qua (chứng chỉ tự ký).

    Bản cũ truyền ssl=True cho mọi URL https nên không kết nối được tới server
    localhost dùng chứng chỉ tự ký như README hướng dẫn.
    """
    if os.getenv("CHAT_INSECURE_SSL") == "1":
        return False
    host = urlparse(server_url).hostname or ""
    if host in ("localhost", "127.0.0.1", "::1"):
        return False
    return None


class AuthManager:
    def __init__(self, server_url=None):
        self.username = None
        self.token = None
        self.user_id = None
        self.config = None
        self.server_url = normalize_url(server_url or os.getenv("CHAT_SERVER_URL", "https://localhost"))

    def has_creds(self):
        return os.path.exists(CONFIG_FILE)

    def forget_creds(self):
        if os.path.exists(CONFIG_FILE):
            os.remove(CONFIG_FILE)

    async def _post(self, path, payload):
        timeout = aiohttp.ClientTimeout(total=20)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{self.server_url}{path}", json=payload, ssl=ssl_param(self.server_url)
            ) as resp:
                try:
                    data = await resp.json()
                except Exception:
                    data = {"error": await resp.text()}
                return resp.status, data

    async def _api_login(self, username, password):
        try:
            status, data = await self._post("/api/auth/login", {"username": username, "password": password})
        except (aiohttp.ClientError, OSError) as exc:
            print(f"Không kết nối được server: {exc}")
            return False
        if status == 200:
            self.username = data["username"]
            self.token = data["token"]
            self.user_id = data["userId"]
            return True
        print(f"Đăng nhập thất bại: {data.get('error', status)}")
        return False

    async def load_and_login(self, master_pass):
        try:
            with open(CONFIG_FILE, "r") as f:
                self.config = json.load(f)
            password = decrypt(bytes.fromhex(self.config["encrypted_password"]), master_pass).decode()
            username = self.config["username"]
        except (ValueError, KeyError, OSError) as exc:
            print(f"Không đọc được thông tin đã lưu: {exc}")
            return False
        return await self._api_login(username, password)

    async def login(self, username, password, master_pass):
        if not await self._api_login(username, password):
            return False
        encrypted = encrypt(password.encode(), master_pass)
        self.config = {"username": username, "encrypted_password": encrypted.hex(), "server_url": self.server_url}
        with open(CONFIG_FILE, "w") as f:
            json.dump(self.config, f)
        try:
            os.chmod(CONFIG_FILE, 0o600)
        except OSError:
            pass
        return True

    async def register(self, username, password):
        try:
            status, data = await self._post("/api/auth/register", {"username": username, "password": password})
        except (aiohttp.ClientError, OSError) as exc:
            print(f"Không kết nối được server: {exc}")
            return False
        if status == 201:
            return True
        print(f"Đăng ký thất bại: {data.get('error', status)}")
        return False
