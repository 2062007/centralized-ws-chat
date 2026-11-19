import asyncio
import json
import os
import sys

from colorama import init, Fore, Style

from auth import AuthManager, normalize_url
from chat import ChatInterface
from console import ainput, agetpass
from node import NodeManager
from ws_client import WSClient

init(autoreset=True)

SERVER_CONFIG = "server_config.json"


def save_server_url(url):
    with open(SERVER_CONFIG, "w") as f:
        json.dump({"server_url": url}, f)


async def resolve_server_url():
    url = os.getenv("CHAT_SERVER_URL")
    if not url and os.path.exists(SERVER_CONFIG):
        try:
            with open(SERVER_CONFIG) as f:
                url = json.load(f).get("server_url")
        except (ValueError, OSError):
            url = None
    if not url:
        url = (await ainput("Nhập URL server (vd: https://localhost hoặc https://your-app.onrender.com): ")).strip()
        url = url or "https://localhost"
        save_server_url(normalize_url(url))
    else:
        print(f"Server: {url}")
    return normalize_url(url)


async def recover_server(auth):
    """Server mất tài khoản (vd. Render reset DB): dùng token đã lưu để node gửi backup lên trước,
    server sẽ khôi phục user/phòng/tin nhắn từ đó. Trả về True nếu có gửi được."""
    info = auth.recovery_info()
    node = NodeManager(info[2]) if info else None
    if not info or not node.enabled or node.count() == 0:
        if node:
            node.close()
        return False
    token, user_id, username = info
    ws = WSClient(token, username, user_id, auth.server_url)
    counts = {}
    try:
        print(f"{Fore.YELLOW}Server không còn tài khoản — thử khôi phục từ node backup ({node.count()} bản ghi)...{Style.RESET_ALL}")
        await ws.connect()
        await ws.send({"type": "node_mode", "enabled": True})
        sender = asyncio.create_task(node.send_sync(ws))
        loop = asyncio.get_event_loop()
        deadline = loop.time() + 60
        quiet_until = None
        while loop.time() < deadline:
            wait = 2.0 if sender.done() else 5.0
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=wait)
            except asyncio.TimeoutError:
                if sender.done():
                    break
                continue
            t = msg.get("type")
            if t == "__closed__":
                print(f"{Fore.RED}Server từ chối token đã lưu (hết hạn 7 ngày hoặc sai JWT_SECRET).{Style.RESET_ALL}")
                return False
            if t == "node_sync_ack":
                k = msg.get("result") or ("ok" if msg.get("restored") else "dup")
                counts[k] = counts.get(k, 0) + 1
        print(f"Kết quả khôi phục: {counts or 'server không phản hồi'}")
        return counts.get("ok", 0) > 0
    except Exception as exc:
        print(f"{Fore.RED}Không khôi phục được: {exc}{Style.RESET_ALL}")
        return False
    finally:
        await ws.close()
        node.close()


async def main():
    auth = AuthManager(await resolve_server_url())

    # Chạy node backup thuần tuý, không cần username/password/token.
    if "--sync-only" in sys.argv:
        ws = WSClient(None, "anonymous", None, auth.server_url)
        node = NodeManager("anonymous")
        node.set_enabled(True)
        try:
            await ChatInterface(ws, node, sync_only=True).start()
        except OSError as exc:
            print(f"{Fore.RED}Không kết nối được WebSocket: {exc}{Style.RESET_ALL}")
        return

    logged_in = False
    if auth.has_creds():
        for _ in range(3):
            master = await agetpass("Master password (Enter để bỏ qua / đăng nhập tài khoản khác): ")
            if not master:
                break
            if await auth.load_and_login(master):
                logged_in = True
                break
            # Mật khẩu đã lưu đúng nhưng server báo sai thông tin = server đã bị reset, mất tài khoản
            if auth.creds_ok and auth.last_status == 401:
                if await recover_server(auth) and await auth.retry_login():
                    logged_in = True
                    break
                ans = (await ainput("Tài khoản chưa có trên server. Đăng ký lại bằng thông tin đã lưu? (Y/n): ")).strip().lower()
                if ans != "n" and await auth.register_saved() and await auth.retry_login():
                    logged_in = True
                    break
                break
        if not logged_in:
            if (await ainput("Xoá thông tin đăng nhập đã lưu? (y/N): ")).strip().lower() == "y":
                auth.forget_creds()
    if logged_in:
        print(f"{Fore.GREEN}Đã đăng nhập: {auth.username}{Style.RESET_ALL}")

    while not logged_in:
        print("\n1. Đăng nhập\n2. Đăng ký\n3. Đổi URL server\n4. Đồng bộ backup ẩn danh (không đăng nhập)\n5. Thoát")
        choice = (await ainput("Chọn: ")).strip()
        if choice == "1":
            username = (await ainput("Tên đăng nhập: ")).strip()
            password = await agetpass("Mật khẩu: ")
            master = await agetpass("Master password (để mã hoá mật khẩu lưu cục bộ): ")
            if not master:
                print("Master password không được để trống")
            elif await auth.login(username, password, master):
                print(f"{Fore.GREEN}Đã đăng nhập: {auth.username}{Style.RESET_ALL}")
                logged_in = True
        elif choice == "2":
            username = (await ainput("Tên đăng nhập (3-32 ký tự): ")).strip()
            password = await agetpass("Mật khẩu (>= 8 ký tự): ")
            if await auth.register(username, password):
                print(f"{Fore.GREEN}Đăng ký thành công! Hãy đăng nhập.{Style.RESET_ALL}")
        elif choice == "3":
            new_url = normalize_url(await ainput("URL server mới: "))
            if new_url:
                auth.server_url = new_url
                save_server_url(new_url)
                print(f"{Fore.GREEN}Đã đổi server: {new_url}{Style.RESET_ALL}")
        elif choice == "4":
            ws = WSClient(None, "anonymous", None, auth.server_url)
            node = NodeManager("anonymous")
            node.set_enabled(True)
            chat = ChatInterface(ws, node, sync_only=True)
            try:
                await chat.start()
            except OSError as exc:
                print(f"{Fore.RED}Không kết nối được WebSocket: {exc}{Style.RESET_ALL}")
            return
        elif choice == "5":
            return
        else:
            print("Lựa chọn không hợp lệ")

    ws = WSClient(auth.token, auth.username, auth.user_id, auth.server_url)
    node = NodeManager(auth.username)
    chat = ChatInterface(ws, node)
    try:
        await chat.start()
    except OSError as exc:
        print(f"{Fore.RED}Không kết nối được WebSocket: {exc}{Style.RESET_ALL}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
