import asyncio

from colorama import Fore, Style

from console import ainput

HELP = (
    "Lệnh: /rooms, /join <id> [mật khẩu], /create <tên> [mật khẩu], /leave, "
    "/msg <user_id> <nội dung>, /node on|off, /help, /exit"
)


class ChatInterface:
    def __init__(self, ws_client, node_manager):
        self.ws = ws_client
        self.node = node_manager
        self.current_room_id = None
        self.current_room_password = None
        self.pending_password = None
        self.user_id = ws_client.user_id
        self.running = True
        self.rooms = []

    async def start(self):
        await self.ws.connect()
        print(f"{Fore.CYAN}Đã kết nối tới server{Style.RESET_ALL}")
        print(HELP)
        tasks = [asyncio.create_task(self._input_handler()), asyncio.create_task(self._receive_handler())]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            self.running = False
            for t in tasks:
                t.cancel()
            await self.ws.close()
            self.node.close()

    # ---------- nhập liệu ----------
    async def _input_handler(self):
        while self.running:
            try:
                line = await ainput(f"{Fore.YELLOW}>> {Style.RESET_ALL}")
            except (EOFError, KeyboardInterrupt):
                self.running = False
                return
            line = line.strip()
            if not line:
                continue
            try:
                if line.startswith("/"):
                    await self._handle_command(line)
                elif self.current_room_id is None:
                    print("Hãy /join một phòng trước khi gửi tin.")
                else:
                    await self.ws.send({"type": "send_message", "roomId": self.current_room_id, "content": line})
            except Exception as exc:  # một lệnh lỗi không được làm chết cả client
                print(f"{Fore.RED}Lỗi: {exc}{Style.RESET_ALL}")

    async def _handle_command(self, cmd):
        parts = cmd.split()
        name = parts[0].lower()
        if name == "/help":
            print(HELP)
        elif name == "/rooms":
            if not self.rooms:
                print("Chưa có phòng công khai nào.")
            for r in self.rooms:
                print(f"  [{r['id']}] {r['name']}")
        elif name == "/join":
            if len(parts) < 2 or not parts[1].isdigit():
                return print("Cú pháp: /join <room_id> [mật khẩu]")
            self.pending_password = parts[2] if len(parts) > 2 else None
            await self.ws.send({"type": "join_room", "roomId": int(parts[1]), "password": self.pending_password})
        elif name == "/create":
            if len(parts) < 2:
                return print("Cú pháp: /create <tên> [mật khẩu]")
            password = parts[2] if len(parts) > 2 else None
            ok, data = await self.ws.create_room(parts[1], password)
            if not ok:
                return print(f"{Fore.RED}Tạo phòng thất bại: {data.get('error')}{Style.RESET_ALL}")
            print(f"{Fore.GREEN}Đã tạo phòng '{parts[1]}' (ID {data['id']}){Style.RESET_ALL}")
            if password:  # phòng riêng tư không hiện trong danh sách, tự vào luôn
                self.pending_password = password
                await self.ws.send({"type": "join_room", "roomId": data["id"], "password": password})
        elif name == "/leave":
            if self.current_room_id is not None:
                await self.ws.send({"type": "leave_room", "roomId": self.current_room_id})
                self.current_room_id = None
                self.current_room_password = None
                print("Đã rời phòng")
        elif name == "/node":
            if len(parts) < 2 or parts[1].lower() not in ("on", "off"):
                return print("Cú pháp: /node on|off")
            enabled = parts[1].lower() == "on"
            self.node.set_enabled(enabled)
            await self.ws.send({"type": "node_mode", "enabled": enabled})
            print(f"Node mode {'bật' if enabled else 'tắt'} (đang lưu {self.node.count()} bản ghi)")
        elif name == "/msg":
            if len(parts) < 3 or not parts[1].isdigit():
                return print("Cú pháp: /msg <user_id> <nội dung>")
            content = cmd.split(None, 2)[2]
            await self.ws.send({"type": "send_message", "content": content, "isPrivate": True, "recipientId": int(parts[1])})
        elif name == "/exit":
            self.running = False
            print("Tạm biệt...")
        else:
            print(f"Lệnh không hợp lệ: {parts[0]} (gõ /help)")

    # ---------- nhận dữ liệu ----------
    async def _receive_handler(self):
        while self.running:
            msg = await self.ws.receive()
            if msg.get("type") == "__closed__":
                if msg.get("code") == 1008:
                    print(f"{Fore.RED}Server từ chối phiên (token hết hạn hoặc tài khoản bị cấm). Hãy chạy lại.{Style.RESET_ALL}")
                    self.running = False
                    return
                if not await self._reconnect():
                    self.running = False
                    return
                continue
            await self._process_message(msg)

    async def _reconnect(self):
        delay = 1
        while self.running:
            print(f"{Fore.YELLOW}Mất kết nối, thử lại sau {delay}s...{Style.RESET_ALL}")
            await asyncio.sleep(delay)
            try:
                await self.ws.connect()
            except Exception:
                delay = min(delay * 2, 30)
                continue
            if self.node.enabled:
                await self.ws.send({"type": "node_mode", "enabled": True})
            if self.current_room_id is not None:
                await self.ws.send({"type": "join_room", "roomId": self.current_room_id, "password": self.current_room_password})
            print(f"{Fore.GREEN}Đã kết nối lại{Style.RESET_ALL}")
            return True
        return False

    async def _process_message(self, msg):
        t = msg.get("type")
        if t == "welcome":
            self.user_id = msg.get("userId", self.user_id)
            print(f"Bạn là {msg.get('username')} (ID {self.user_id})")
        elif t == "rooms":
            self.rooms = msg.get("data", [])
        elif t == "joined":
            self.current_room_id = msg["roomId"]
            self.current_room_password = self.pending_password
            print(f"{Fore.GREEN}Đã vào phòng {msg['roomId']} - {msg.get('name', '')}{Style.RESET_ALL}")
        elif t == "history":
            if msg.get("roomId") == self.current_room_id:
                for m in msg["data"]:
                    print(f"{m['username']}: {m['content']}")
        elif t == "message":
            d = msg["data"]
            if d.get("roomId") == self.current_room_id:
                print(f"{Fore.CYAN}{d.get('username', '?')}: {d['content']}{Style.RESET_ALL}")
        elif t == "private_message":
            d = msg["data"]
            if d.get("user_id") == self.user_id:
                print(f"{Fore.MAGENTA}[Riêng → #{d.get('recipientId')}] {d['content']}{Style.RESET_ALL}")
            else:
                print(f"{Fore.MAGENTA}[Riêng] {d.get('username', '?')} (#{d.get('user_id')}): {d['content']}{Style.RESET_ALL}")
        elif t == "node_sync":
            self.node.store_encrypted(msg.get("data"))
        elif t == "node_restore_request":
            if self.node.enabled:
                n = await self.node.send_sync(self.ws)
                print(f"Đã gửi {n} bản ghi node cho server")
        elif t == "node_sync_ack":
            pass
        elif t == "error":
            print(f"{Fore.RED}Lỗi: {msg.get('message')}{Style.RESET_ALL}")
        elif t == "warning":
            print(f"{Fore.YELLOW}Cảnh báo: {msg.get('message')}{Style.RESET_ALL}")
