import asyncio
import json
import os

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


async def main():
    auth = AuthManager(await resolve_server_url())

    logged_in = False
    if auth.has_creds():
        for _ in range(3):
            master = await agetpass("Master password (Enter để bỏ qua / đăng nhập tài khoản khác): ")
            if not master:
                break
            if await auth.load_and_login(master):
                logged_in = True
                break
        if not logged_in:
            if (await ainput("Xoá thông tin đăng nhập đã lưu? (y/N): ")).strip().lower() == "y":
                auth.forget_creds()
    if logged_in:
        print(f"{Fore.GREEN}Đã đăng nhập: {auth.username}{Style.RESET_ALL}")

    while not logged_in:
        print("\n1. Đăng nhập\n2. Đăng ký\n3. Đổi URL server\n4. Thoát")
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
