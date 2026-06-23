import pyaes
import os

def encrypt(data, key):
    if isinstance(data, str):
        data = data.encode()
    if isinstance(key, str):
        key = key.encode()
    iv = os.urandom(16)
    counter = pyaes.Counter(initial_value=int.from_bytes(iv, 'big'))
    aes = pyaes.AESModeOfOperationCTR(key, counter=counter)
    ciphertext = aes.encrypt(data)
    return iv + ciphertext

def decrypt(data, key):
    if isinstance(key, str):
        key = key.encode()
    iv = data[:16]
    ciphertext = data[16:]
    counter = pyaes.Counter(initial_value=int.from_bytes(iv, 'big'))
    aes = pyaes.AESModeOfOperationCTR(key, counter=counter)
    plaintext = aes.decrypt(ciphertext)
    return plaintext
