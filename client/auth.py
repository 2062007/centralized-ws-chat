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
        self.last_status = None      # mã HTTP của lần đăng nhập gần nhất
        self.creds_ok = False        # đã giải mã được mật khẩu đã lưu
        self._saved = None           # (username, password) đã lưu
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
        self.last_status = status
        if status == 200:
            self.username = data["username"]
            self.token = data["token"]
            self.user_id = data["userId"]
            self._cache_token()
            return True
        print(f"Đăng nhập thất bại: {data.get('error', status)}")
        return False

    def _write_config(self):
        with open(CONFIG_FILE, "w") as f:
            json.dump(self.config, f)
        try:
            os.chmod(CONFIG_FILE, 0o600)
        except OSError:
            pass

    def _cache_token(self):
        """Lưu token gần nhất: khi server bị reset (mất tài khoản) vẫn dùng nó để node gửi backup lên."""
        if self.config is not None:
            self.config["token"] = self.token
            self.config["user_id"] = self.user_id
            self._write_config()

    def recovery_info(self):
        """(token, user_id, username) đã lưu, hoặc None nếu chưa có."""
        c = self.config or {}
        if c.get("token") and isinstance(c.get("user_id"), int) and c.get("username"):
            return c["token"], c["user_id"], c["username"]
        return None

    async def retry_login(self):
        return bool(self._saved) and await self._api_login(*self._saved)

    async def register_saved(self):
        """Đăng ký lại bằng thông tin đã lưu (nhận lại tài khoản tạm nếu server khôi phục từ backup)."""
        return bool(self._saved) and await self.register(*self._saved)

    async def load_and_login(self, master_pass):
        try:
            with open(CONFIG_FILE, "r") as f:
                self.config = json.load(f)
            password = decrypt(bytes.fromhex(self.config["encrypted_password"]), master_pass).decode()
            username = self.config["username"]
        except (ValueError, KeyError, OSError) as exc:
            print(f"Không đọc được thông tin đã lưu: {exc}")
            return False
        self.creds_ok = True
        self._saved = (username, password)
        return await self._api_login(username, password)

    async def login(self, username, password, master_pass):
        if not await self._api_login(username, password):
            return False
        encrypted = encrypt(password.encode(), master_pass)
        self.config = {"username": username, "encrypted_password": encrypted.hex(), "server_url": self.server_url}
        self._cache_token()
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
