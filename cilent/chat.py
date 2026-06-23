import asyncio
from colorama import Fore, Style
import json

class ChatInterface:
    def __init__(self, ws_client, node_manager):
        self.ws = ws_client
        self.node = node_manager
        self.current_room_id = None
        self.running = True
        self.rooms = {}
        self.messages = []

    async def start(self):
        await self.ws.connect()
        print(f"{Fore.CYAN}Connected to chat server{Style.RESET_ALL}")
        print("Commands: /join <room_id>, /create <name> [password], /leave, /node on|off, /exit")
        # Start input handler
        asyncio.create_task(self._input_handler())
        # Start receive handler
        await self._receive_handler()

    async def _input_handler(self):
        loop = asyncio.get_event_loop()
        while self.running:
            cmd = await loop.run_in_executor(None, input, f"{Fore.YELLOW}>> {Style.RESET_ALL}")
            if cmd.startswith('/'):
                await self._handle_command(cmd)
            else:
                # Send message to current room
                if self.current_room_id and cmd.strip():
                    await self.ws.send({
                        'type': 'send_message',
                        'room_id': self.current_room_id,
                        'content': cmd
                    })

    async def _handle_command(self, cmd):
        parts = cmd.split()
        if parts[0] == '/join':
            if len(parts) < 2:
                print("Usage: /join <room_id> [password]")
                return
            room_id = int(parts[1])
            password = parts[2] if len(parts) > 2 else None
            await self.ws.send({
                'type': 'join_room',
                'room_id': room_id,
                'password': password
            })
            self.current_room_id = room_id
            print(f"{Fore.GREEN}Joined room {room_id}{Style.RESET_ALL}")
        elif parts[0] == '/create':
            if len(parts) < 2:
                print("Usage: /create <name> [password]")
                return
            name = parts[1]
            password = parts[2] if len(parts) > 2 else None
            # Call REST API to create room
            # For simplicity, we'll send via websocket (we need to add create_room handler in server)
            await self.ws.send({
                'type': 'create_room',
                'name': name,
                'is_public': password is None,
                'password': password
            })
        elif parts[0] == '/leave':
            if self.current_room_id:
                await self.ws.send({
                    'type': 'leave_room',
                    'room_id': self.current_room_id
                })
                self.current_room_id = None
                print("Left room")
        elif parts[0] == '/node':
            if len(parts) < 2:
                print("Usage: /node on|off")
                return
            enabled = parts[1].lower() == 'on'
            self.node.set_enabled(enabled)
            await self.ws.send({
                'type': 'node_mode',
                'enabled': enabled
            })
            print(f"Node mode {'enabled' if enabled else 'disabled'}")
        elif parts[0] == '/exit':
            self.running = False
            await self.ws.close()
            print("Exiting...")
        elif parts[0] == '/msg':
            # Private message: /msg <user_id> <message>
            if len(parts) < 3:
                print("Usage: /msg <user_id> <message>")
                return
            user_id = int(parts[1])
            content = ' '.join(parts[2:])
            await self.ws.send({
                'type': 'send_message',
                'content': content,
                'is_private': True,
                'recipient_id': user_id
            })
        else:
            print(f"Unknown command: {parts[0]}")

    async def _receive_handler(self):
        while self.running:
            msg = await self.ws.receive()
            await self._process_message(msg)

    async def _process_message(self, msg):
        msg_type = msg.get('type')
        if msg_type == 'message' or msg_type == 'private_message':
            data = msg['data']
            sender = data.get('username', 'Unknown')
            content = data['content']
            private = msg_type == 'private_message'
            color = Fore.CYAN if not private else Fore.MAGENTA
            print(f"{color}{sender}: {content}{Style.RESET_ALL}")
            # If node mode is on, store encrypted message
            if self.node.enabled and msg_type == 'message':
                # Server sends encrypted data via node_sync? Actually we need to capture from server
                # We'll rely on separate node_sync messages.
                pass
        elif msg_type == 'node_sync':
            # Server sends encrypted data for node clients
            encrypted = msg['data']
            self.node.store_encrypted(encrypted)
        elif msg_type == 'node_restore_request':
            # Server requests node data
            await self.node.send_sync(self.ws)
        elif msg_type == 'history':
            # Display history
            for m in msg['data']:
                print(f"{m['username']}: {m['content']}")
        elif msg_type == 'error':
            print(f"{Fore.RED}Error: {msg['message']}{Style.RESET_ALL}")
        elif msg_type == 'warning':
            print(f"{Fore.YELLOW}Warning: {msg['message']}{Style.RESET_ALL}")
        else:
            print(f"Received: {msg}")
