import asyncio
import json
import sys
from colorama import init, Fore, Style
from auth import AuthManager
from chat import ChatInterface
from ws_client import WSClient
from node import NodeManager

init(autoreset=True)

async def main():
    auth = AuthManager()
    if auth.has_creds():
        master_pass = input("Enter master password: ")
        if auth.load_and_login(master_pass):
            print(f"{Fore.GREEN}Logged in as {auth.username}{Style.RESET_ALL}")
        else:
            print(f"{Fore.RED}Login failed. Exiting.{Style.RESET_ALL}")
            return
    else:
        # Show menu: login or register
        while True:
            print("\n1. Login")
            print("2. Register")
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
            else:
                print("Invalid choice")

    ws = WSClient(auth.token, auth.username, auth.user_id)
    node = NodeManager(auth.username)
    chat = ChatInterface(ws, node)
    await chat.start()

if __name__ == "__main__":
    asyncio.run(main())
