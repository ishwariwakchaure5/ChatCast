# client_gui.py (Updated with Welcome Message)

import tkinter as tk
from tkinter import scrolledtext, messagebox, simpledialog, Listbox, Frame, Label, Radiobutton, StringVar
import socket
import threading
import os
import json
import time
import queue

from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

SERVER_HOST = '127.0.0.1'
SERVER_PORT = 9999

class SecureChatClientGUI:
    def __init__(self, master):
        self.master = master
        master.title("Secure Chat")
        master.geometry("700x500")

        # --- Main Layout Frames ---
        self.main_frame = Frame(master)
        self.main_frame.pack(padx=10, pady=10, expand=True, fill='both')
        self.main_frame.grid_rowconfigure(0, weight=1)
        self.main_frame.grid_columnconfigure(0, weight=3) # Chat area
        self.main_frame.grid_columnconfigure(1, weight=1) # Side panel

        # --- Chat Area (Left) ---
        chat_frame = Frame(self.main_frame)
        chat_frame.grid(row=0, column=0, sticky="nsew", rowspan=2)

        self.connect_button = tk.Button(chat_frame, text="Connect", command=self.prompt_credentials_and_connect)
        self.connect_button.pack(pady=5, fill='x')

        self.chat_box = scrolledtext.ScrolledText(chat_frame, state='disabled', wrap=tk.WORD, bg="#2b2b2b", fg="#d3d3d3")
        self.chat_box.pack(pady=5, expand=True, fill='both')

        self.msg_entry = tk.Entry(chat_frame, bg="#3c3f41", fg="#d3d3d3", insertbackground="white")
        self.msg_entry.pack(pady=5, fill='x')
        self.msg_entry.bind("<Return>", self.send_message_on_enter)
        
        self.send_button = tk.Button(chat_frame, text="Send", command=self.send_message)
        self.send_button.pack(pady=5, fill='x')
        
        self.status_label = Label(chat_frame, text="Status: Disconnected", fg="red")
        self.status_label.pack(pady=2, fill='x')

        # --- Side Panel (Right) ---
        side_panel = Frame(self.main_frame, padx=10)
        side_panel.grid(row=0, column=1, sticky="nsew")

        Label(side_panel, text="Mode").pack(anchor='w')
        self.chat_mode = StringVar(value="broadcast")
        Radiobutton(side_panel, text="Broadcast", variable=self.chat_mode, value="broadcast").pack(anchor='w')
        Radiobutton(side_panel, text="Unicast", variable=self.chat_mode, value="unicast").pack(anchor='w')

        Label(side_panel, text="Connected Users").pack(anchor='w', pady=(10,0))
        self.user_listbox = Listbox(side_panel, bg="#3c3f41", fg="#d3d3d3", exportselection=False)
        self.user_listbox.pack(expand=True, fill='both')

        # --- Socket and State ---
        self.sock, self.encryptor, self.decryptor = None, None, None
        self.is_connected = False
        self.gui_queue = queue.Queue()
        self.master.after(100, self.process_gui_queue)
        master.protocol("WM_DELETE_WINDOW", self.on_closing)

    def process_gui_queue(self):
        try:
            while not self.gui_queue.empty():
                task, args = self.gui_queue.get_nowait()
                task(*args)
        except queue.Empty:
            pass
        self.master.after(100, self.process_gui_queue)

    def queue_update(self, task, *args): self.gui_queue.put((task, args))
    def update_status(self, text, color): self.status_label.config(text=text, fg=color)
    
    def update_chat_box(self, message, tag=None):
        self.chat_box.config(state='normal')
        self.chat_box.insert(tk.END, message + '\n', tag)
        self.chat_box.config(state='disabled')
        self.chat_box.see(tk.END)
        self.chat_box.tag_config('system', foreground='yellow')
        self.chat_box.tag_config('private', foreground='#87CEFA') # Light blue

    def update_user_list(self, users):
        self.user_listbox.delete(0, tk.END)
        for user in sorted(users):
            self.user_listbox.insert(tk.END, user)

    def prompt_credentials_and_connect(self):
        username = simpledialog.askstring("Username", "Enter username", parent=self.master)
        if not username: return
        password = simpledialog.askstring("Password", "Enter password", show='*', parent=self.master)
        if not password: return
        
        self.connect_button.config(state='disabled', text="Connecting...")
        self.queue_update(self.update_status, "Status: Connecting...", "orange")
        threading.Thread(target=self.connect_to_server, args=(username, password), daemon=True).start()

    def connect_to_server(self, username, password):
        try:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.connect((SERVER_HOST, SERVER_PORT))
            
            self.sock.sendall(f"{username}:{password}".encode('utf-8'))
            auth_response = self.sock.recv(1024)
            if auth_response != b"AUTH_SUCCESS":
                self.queue_update(self.update_chat_box, "[System]: Authentication failed.", 'system')
                self.cleanup_connection()
                return

            with open("public_key.pem", "rb") as key_file:
                public_key = serialization.load_pem_public_key(key_file.read())
            aes_key, iv = os.urandom(32), os.urandom(16)
            encrypted_aes_key = public_key.encrypt(aes_key, padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
            encrypted_iv = public_key.encrypt(iv, padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
            self.sock.sendall(encrypted_aes_key)
            self.sock.sendall(encrypted_iv)

            self.encryptor = Cipher(algorithms.AES(aes_key), modes.CFB(iv)).encryptor()
            self.decryptor = Cipher(algorithms.AES(aes_key), modes.CFB(iv)).decryptor()
            
            self.is_connected = True
            self.queue_update(self.update_status, "Status: Connected", "green")
            self.queue_update(lambda: self.connect_button.config(state='disabled', text='Connected'))
            
            # *** NEW: Added welcome message here ***
            self.queue_update(self.update_chat_box, f"[System]: Welcome {username}! You are now connected.", 'system')
            
            threading.Thread(target=self.receive_messages, daemon=True).start()
            threading.Thread(target=self.keep_alive, daemon=True).start()
        except Exception as e:
            self.queue_update(self.update_chat_box, f"[System]: Connection failed: {e}", 'system')
            self.cleanup_connection()

    def receive_messages(self):
        while self.is_connected:
            try:
                encrypted_data = self.sock.recv(1024)
                if not encrypted_data: break
                
                decrypted_bytes = self.decryptor.update(encrypted_data)
                message_data = json.loads(decrypted_bytes.decode('utf-8'))
                
                msg_type = message_data.get("type")
                if msg_type == "user_list_update":
                    self.queue_update(self.update_user_list, message_data.get("users", []))
                
                elif msg_type == "chat_message":
                    content = message_data.get("content")
                    if message_data.get("private"):
                        if message_data.get("sender") == "You":
                            recipient = message_data.get("recipient")
                            self.queue_update(self.update_chat_box, f'[To {recipient}]: {content}', 'private')
                        else:
                            sender = message_data.get("sender")
                            self.queue_update(self.update_chat_box, f'[Private from {sender}]: {content}', 'private')
                    else:
                        sender = message_data.get("sender")
                        self.queue_update(self.update_chat_box, f'[{sender}]: {content}')
            except Exception:
                break
        self.cleanup_connection()

    def send_json_message(self, data):
        if self.is_connected:
            try:
                message_bytes = json.dumps(data).encode('utf-8')
                encrypted_message = self.encryptor.update(message_bytes)
                self.sock.sendall(encrypted_message)
            except Exception as e:
                self.queue_update(self.update_chat_box, f"[System]: Error sending: {e}", 'system')

    def send_message(self):
        if not self.is_connected:
            messagebox.showwarning("Not Connected", "You must be connected to send messages.")
            return
        
        content = self.msg_entry.get()
        if not content: return

        mode = self.chat_mode.get()
        message_data = {"type": "chat_message", "content": content, "mode": mode}

        if mode == "unicast":
            selected_indices = self.user_listbox.curselection()
            if not selected_indices:
                messagebox.showwarning("No Recipient", "Please select a user from the list for unicast.")
                return
            recipient = self.user_listbox.get(selected_indices[0])
            message_data["recipient"] = recipient
        else: # Broadcast
            self.queue_update(self.update_chat_box, f'[You]: {content}')

        self.send_json_message(message_data)
        self.msg_entry.delete(0, tk.END)

    def keep_alive(self):
        while self.is_connected:
            time.sleep(25)
            if self.is_connected:
                self.send_json_message({"type": "ping"})

    def send_message_on_enter(self, event): self.send_message()

    def cleanup_connection(self):
        if not self.is_connected: return
        self.is_connected = False
        if self.sock: self.sock.close()
        self.sock, self.encryptor, self.decryptor = None, None, None
        self.queue_update(lambda: self.connect_button.config(state='normal', text='Connect'))
        self.queue_update(self.update_status, "Status: Disconnected", "red")
        self.queue_update(self.update_chat_box, "[System]: Disconnected.", 'system')
        self.queue_update(self.update_user_list, [])

    def on_closing(self):
        self.cleanup_connection()
        self.master.destroy()

if __name__ == "__main__":
    root = tk.Tk()
    app = SecureChatClientGUI(root)
    root.mainloop()