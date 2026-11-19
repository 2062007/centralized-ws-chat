import hashlib
import hmac
import os

import pyaes

PBKDF2_ROUNDS = 200_000
MAGIC = b"C2"  # phiên bản định dạng


def _derive(password, salt):
    if isinstance(password, str):
        password = password.encode()
    # 64 byte: 32 cho AES-256, 32 cho HMAC-SHA256
    material = hashlib.pbkdf2_hmac("sha256", password, salt, PBKDF2_ROUNDS, dklen=64)
    return material[:32], material[32:]


def encrypt(data, password):
    """AES-256-CTR + HMAC-SHA256 (encrypt-then-MAC), khoá dẫn xuất bằng PBKDF2.

    Bản cũ dùng thẳng master password làm khoá AES nên lỗi nếu độ dài không phải
    16/24/32 byte, và không có xác thực nên sai mật khẩu vẫn "giải mã" ra rác.
    """
    if isinstance(data, str):
        data = data.encode()
    salt = os.urandom(16)
    iv = os.urandom(16)
    enc_key, mac_key = _derive(password, salt)
    counter = pyaes.Counter(initial_value=int.from_bytes(iv, "big"))
    ciphertext = pyaes.AESModeOfOperationCTR(enc_key, counter=counter).encrypt(data)
    body = MAGIC + salt + iv + ciphertext
    return body + hmac.new(mac_key, body, hashlib.sha256).digest()


def decrypt(blob, password):
    """Ném ValueError nếu sai mật khẩu hoặc dữ liệu bị hỏng."""
    if len(blob) < len(MAGIC) + 16 + 16 + 32 or blob[: len(MAGIC)] != MAGIC:
        raise ValueError("Định dạng dữ liệu không hợp lệ (có thể là file config cũ)")
    body, mac = blob[:-32], blob[-32:]
    salt = body[len(MAGIC): len(MAGIC) + 16]
    iv = body[len(MAGIC) + 16: len(MAGIC) + 32]
    ciphertext = body[len(MAGIC) + 32:]
    enc_key, mac_key = _derive(password, salt)
    if not hmac.compare_digest(mac, hmac.new(mac_key, body, hashlib.sha256).digest()):
        raise ValueError("Sai master password hoặc dữ liệu bị hỏng")
    counter = pyaes.Counter(initial_value=int.from_bytes(iv, "big"))
    return pyaes.AESModeOfOperationCTR(enc_key, counter=counter).decrypt(ciphertext)
