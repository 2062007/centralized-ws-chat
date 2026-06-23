import aiohttp
import asyncio
import json

class WSClient:
    def __init__(self, token, username, user_id):
        self.token = token
        self.username = username
        self.user_id = user_id
        self.ws = None
        self.session = None
        self.receive_queue = asyncio.Queue()
        self.running = True

    async def connect(self):
        self.session = aiohttp.ClientSession()
        self.ws = await self.session.ws_connect(
            f'wss://localhost/ws?token={self.token}',
            ssl=False
        )
        # Start receive loop
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
