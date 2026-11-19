import asyncio
import getpass
import threading


def _run_blocking(func, *args):
    """Chạy hàm chặn (input/getpass) trong daemon thread.

    Dùng run_in_executor sẽ làm tiến trình treo lúc thoát vì asyncio.run chờ
    thread đang kẹt ở input(); daemon thread thì không.
    """
    loop = asyncio.get_running_loop()
    fut = loop.create_future()

    def worker():
        try:
            result = func(*args)
        except BaseException as exc:  # EOFError, KeyboardInterrupt...
            loop.call_soon_threadsafe(lambda: fut.done() or fut.set_exception(exc))
        else:
            loop.call_soon_threadsafe(lambda: fut.done() or fut.set_result(result))

    threading.Thread(target=worker, daemon=True).start()
    return fut


def ainput(prompt=""):
    return _run_blocking(input, prompt)


def agetpass(prompt=""):
    return _run_blocking(getpass.getpass, prompt)
