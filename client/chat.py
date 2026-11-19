import asyncio
import time

from colorama import Fore, Style

from console import ainput

HELP = (
    "Lệnh: /rooms, /join <id> [mật khẩu], /create <tên> [mật khẩu], /leave, "
    "/msg <user_id> <nội dung>, /node on|off|status, /help, /exit"
)


class ChatInterface:
    def __init__(self, ws_client, node_manager, sync_only=False):
        self.ws = ws_client
        self.node = node_manager
        self.sync_only = sync_only
        self.current_room_id = None
        self.current_room_password = None
        self.pending_password = None
        self.user_id = ws_client.user_id
        self.running = True
        self.rooms = []
        self._upload_task = None
        self._uploaded = False        # đã gửi backup trong kết nối này
        self._last_upload = 0.0
        self.ack_counts = {}
        self.node_received = 0

    async def start(self):
        await self.ws.connect()
        print(f"{Fore.CYAN}Đã kết nối tới server{Style.RESET_ALL}")
        await self._announce_node()
        if self.sync_only:
            print("Chế độ backup ẩn danh đang chạy. Nhấn Ctrl+C để thoát.")
            tasks = [asyncio.create_task(self._receive_handler())]
        else:
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

    async def _send_node_mode(self, enabled):
        """Báo trạng thái node + con trỏ backup; server sẽ tự gửi bù phần còn thiếu."""
        await self.ws.send({"type": "node_mode", "enabled": enabled})
        # Không tự upload khi vừa kết nối. Chỉ phản hồi node_restore_request từ server.

    def _start_upload(self, force=False):
        if self._upload_task and not self._upload_task.done():
            return
        if self._uploaded and not force:
            return  # kết nối này đã gửi rồi (tránh gửi lặp khi server vừa bảo vừa nhắc)
        self._upload_task = asyncio.create_task(self._upload_node_data())

    async def _upload_node_data(self):
        try:
            self.ack_counts = {}
            n = await self.node.send_sync(self.ws)
            self._uploaded = True
            self._last_upload = time.monotonic()
            if n:
                await asyncio.sleep(1.5)  # chờ server trả kết quả
                print(f"{Fore.GREEN}Node backup: đã gửi {n} bản ghi lên server → {self._ack_summary()}{Style.RESET_ALL}")
        except Exception:
            pass  # mất kết nối giữa chừng: lần kết nối sau sẽ gửi lại

    def _ack_summary(self):
        names = {"ok": "khôi phục mới", "dup": "đã có (bỏ qua)", "invalid": "không hợp lệ",
                 "no_user": "thiếu user", "no_room": "thiếu phòng"}
        if not self.ack_counts:
            return "server chưa phản hồi (có thể ngoài cửa sổ khôi phục hoặc bản ghi bị từ chối)"
        return ", ".join(f"{names.get(k, k)}: {v}" for k, v in self.ack_counts.items())

    async def _announce_node(self):
        """Báo cho server biết client này là node backup (nếu đang bật)."""
        if self.node.enabled:
            await self._send_node_mode(True)
            print(f"{Fore.GREEN}Node backup: BẬT{Style.RESET_ALL} (đang lưu {self.node.count()} bản ghi, tắt bằng /node off)")
        else:
            print("Node backup: TẮT (bật bằng /node on)")

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
            if len(parts) == 1 or parts[1].lower() == "status":
                state = "BẬT" if self.node.enabled else "TẮT"
                return print(f"Node backup: {state} (đang lưu {self.node.count()} bản ghi)")
            if parts[1].lower() not in ("on", "off"):
                return print("Cú pháp: /node on|off|status")
            enabled = parts[1].lower() == "on"
            self.node.set_enabled(enabled)
            await self._send_node_mode(enabled)
            print(f"Node backup {'bật' if enabled else 'tắt'} (đã lưu lại cho lần chạy sau)")
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
            self._uploaded = False
            if self.node.enabled:
                await self._send_node_mode(True)
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
            self.node.store_encrypted(msg.get("data"), msg.get("id"), msg.get("kind", "message"))
        elif t == "node_catchup_done":
            if not self.node.enabled:
                return
            self.node_received += msg.get("sent", 0)
            if msg.get("more"):
                await self.ws.send({"type": "node_catchup", "afterId": msg.get("upTo", 0)})
            else:
                print(f"{Fore.GREEN}Node backup: đã nhận dữ liệu từ server (tổng {self.node.count()} bản ghi){Style.RESET_ALL}")
        elif t == "node_catchup_wait":
            if self.node.enabled:
                await asyncio.sleep(max(0.05, msg.get("retryAfterMs", 250) / 1000))
                await self.ws.send({"type": "node_catchup", "afterId": msg.get("afterId", 0)})
        elif t == "node_restore_request":
            if self.node.enabled:
                # Admin yêu cầu / server rỗng: gửi lại nếu lần gửi trước đã cách đây > 30s
                self._start_upload(force=time.monotonic() - self._last_upload > 30)
        elif t == "node_sync_ack":
            key = msg.get("result") or ("ok" if msg.get("restored") else "dup")
            self.ack_counts[key] = self.ack_counts.get(key, 0) + 1
        elif t == "error":
            print(f"{Fore.RED}Lỗi: {msg.get('message')}{Style.RESET_ALL}")
        elif t == "warning":
            print(f"{Fore.YELLOW}Cảnh báo: {msg.get('message')}{Style.RESET_ALL}")
