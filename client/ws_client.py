import asyncio
import json

import aiohttp

from auth import ssl_param


class WSClient:
    """Kết nối WebSocket. Khi mất kết nối, đưa None vào hàng đợi để phía trên biết."""

    def __init__(self, token, username, user_id, server_url):
        self.token = token
        self.username = username
        self.user_id = user_id
        self.server_url = server_url
        self.ws = None
        self.session = None
        self.receive_queue = asyncio.Queue()
        self._recv_task = None

    @property
    def connected(self):
        return self.ws is not None and not self.ws.closed

    async def connect(self):
        await self._cleanup()
        self.session = aiohttp.ClientSession()
        ws_url = self.server_url.replace("https://", "wss://", 1).replace("http://", "ws://", 1) + "/ws"
        try:
            self.ws = await self.session.ws_connect(
                ws_url,
                params={"token": self.token},
                ssl=ssl_param(self.server_url),
                heartbeat=25,
            )
        except Exception:
            await self._cleanup()
            raise
        self._recv_task = asyncio.create_task(self._receive_loop())

    async def _receive_loop(self):
        try:
            async for msg in self.ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        await self.receive_queue.put(json.loads(msg.data))
                    except ValueError:
                        continue
                elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                    break
        except Exception:
            pass
        finally:
            code = self.ws.close_code if self.ws is not None else None
            await self.receive_queue.put({"type": "__closed__", "code": code})

    async def send(self, message):
        if not self.connected:
            return False
        await self.ws.send_json(message)
        return True

    async def receive(self):
        return await self.receive_queue.get()

    async def create_room(self, name, password=None):
        """Tạo phòng qua REST (server không có sự kiện WS create_room)."""
        body = {"name": name, "is_public": password is None, "password": password}
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self.server_url}/api/rooms",
                json=body,
                headers={"Authorization": f"Bearer {self.token}"},
                ssl=ssl_param(self.server_url),
            ) as resp:
                data = await resp.json()
                return resp.status == 201, data

    async def _cleanup(self):
        if self._recv_task and not self._recv_task.done():
            self._recv_task.cancel()
        if self.ws is not None and not self.ws.closed:
            await self.ws.close()
        if self.session is not None and not self.session.closed:
            await self.session.close()
        self.ws = None
        self.session = None

    async def close(self):
        await self._cleanup()
