import aiohttp
import asyncio
import json
import os

class WSClient:
    def __init__(self, token, username, user_id, server_url=None):
        self.token = token
        self.username = username
        self.user_id = user_id
        # Nếu không truyền server_url, lấy từ env hoặc mặc định localhost
        self.server_url = server_url or os.getenv('CHAT_SERVER_URL', 'https://localhost')
        self.ws = None
        self.session = None
        self.receive_queue = asyncio.Queue()
        self.running = True

    async def connect(self):
        self.session = aiohttp.ClientSession()
        # Chuyển đổi http/https sang ws/wss
        ws_url = self.server_url.replace('https://', 'wss://').replace('http://', 'ws://')
        ws_url += f"/ws?token={self.token}"
        print(f"Connecting to WebSocket: {ws_url}")

        # Xác định ssl: nếu URL bắt đầu bằng https thì dùng ssl=True, ngược lại False
        use_ssl = self.server_url.startswith('https://')
        # Với localhost tự ký, ssl=False; với production (Render) ssl=True
        self.ws = await self.session.ws_connect(
            ws_url,
            ssl=use_ssl
        )
        asyncio.create_task(self._receive_loop())

    async def _receive_loop(self):
        async for msg in self.ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = json.loads(msg.data)
                await self.receive_queue.put(data)
            elif msg.type == aiohttp.WSMsgType.ERROR:
                break
        self.running = False

    async def send(self, message):
        if self.ws:
            await self.ws.send_json(message)

    async def receive(self):
        return await self.receive_queue.get()

    async def close(self):
        if self.ws:
            await self.ws.close()
        if self.session:
            await self.session.close()
        self.running = False
