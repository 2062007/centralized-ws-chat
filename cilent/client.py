import asyncio
import json
import os
import sys
from colorama import init, Fore, Style
from auth import AuthManager
from chat import ChatInterface
from ws_client import WSClient
from node import NodeManager

init(autoreset=True)

async def main():
    # Đọc URL server từ file cấu hình hoặc biến môi trường
    config_file = 'server_config.json'
    server_url = os.getenv('CHAT_SERVER_URL')

    # Nếu chưa có, thử đọc từ file
    if not server_url and os.path.exists(config_file):
        with open(config_file, 'r') as f:
            config = json.load(f)
            server_url = config.get('server_url')

    # Nếu vẫn chưa có, hỏi người dùng
    if not server_url:
        server_url = input("Enter server URL (e.g., https://localhost or https://your-app.onrender.com): ").strip()
        if not server_url:
            server_url = 'https://localhost'
        # Lưu lại để dùng sau
        with open(config_file, 'w') as f:
            json.dump({'server_url': server_url}, f)
    else:
        print(f"Using server URL: {server_url}")

    auth = AuthManager(server_url)
    if auth.has_creds():
        master_pass = input("Enter master password: ")
        if auth.load_and_login(master_pass):
            print(f"{Fore.GREEN}Logged in as {auth.username}{Style.RESET_ALL}")
        else:
            print(f"{Fore.RED}Login failed. Exiting.{Style.RESET_ALL}")
            return
    else:
        while True:
            print("\n1. Login")
            print("2. Register")
            print("3. Change server URL")
            choice = input("Choose: ")
            if choice == '1':
                username = input("Username: ")
                password = input("Password: ")
                master_pass = input("Master password (for encryption): ")
                if auth.login(username, password, master_pass):
                    print(f"{Fore.GREEN}Logged in as {auth.username}{Style.RESET_ALL}")
                    break
                else:
                    print(f"{Fore.RED}Login failed{Style.RESET_ALL}")
            elif choice == '2':
                username = input("Username: ")
                password = input("Password: ")
                master_pass = input("Master password (for encryption): ")
                if auth.register(username, password, master_pass):
                    print(f"{Fore.GREEN}Registered! Please login.{Style.RESET_ALL}")
                else:
                    print(f"{Fore.RED}Registration failed{Style.RESET_ALL}")
            elif choice == '3':
                new_url = input("Enter new server URL: ").strip()
                if new_url:
                    auth.server_url = new_url
                    with open(config_file, 'w') as f:
                        json.dump({'server_url': new_url}, f)
                    print(f"{Fore.GREEN}Server URL updated to {new_url}{Style.RESET_ALL}")
            else:
                print("Invalid choice")

    ws = WSClient(auth.token, auth.username, auth.user_id, auth.server_url)
    node = NodeManager(auth.username)
    chat = ChatInterface(ws, node)
    await chat.start()

if __name__ == "__main__":
    asyncio.run(main())
