#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""server.py 实测自检：仅标准库，拉起真实子进程逐项验证安全与容错门禁。

覆盖：
- 仅绑定 127.0.0.1；端口占用时自动改端口；未显式指定端口时识别已运行实例；
- Host 头只接受 127.0.0.1:<port> / localhost:<port>，其余 403；
- HTML 动态注入 console-session-token；
- 缺失 / 错误令牌 403、错误 Origin 403、无 Origin 正常；GET /api/health 允许免令牌；
- 目录穿越请求拦截；
- 超大请求体 413（配置 1 MB / 聊天 32 MB）、缺失 Content-Length 400；
- SSE 小帧按到达节奏即时透传；跨源重定向被拒且认证头不外泄；
- 并发写互斥、原子写入无 .tmp 残留、失败路径清理临时文件；
- 正式文件损坏时从 .bak 自动恢复并在健康状态标记，recovered 在进程内保持粘性；
- 配置接口不返回明文密钥 / 明文自定义 Header，自定义 Header 合并语义正确；
- 聊天转发与模型探测把 settings 名称与 secrets 明文值合并，草稿非空值优先；
- URL 归一化与默认配置校验（含 /messages 结尾的 Files API 拼接）。
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import http.client
import json
import os
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_PATH = ROOT / "server.py"
sys.path.insert(0, str(ROOT))

import server as console  # noqa: E402 — 仅导入纯函数，不启动服务

passed = 0
failed = 0


def ok(condition: bool, label: str, detail: str = "") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("ok - %s" % label)
    else:
        failed += 1
        print("FAIL: %s%s" % (label, (" — " + detail) if detail else ""))


def eq(actual, expected, label: str) -> None:
    ok(actual == expected, label, "expected %r, got %r" % (expected, actual))


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


class ServerProcess:
    def __init__(self, data_dir: Path, preferred_port=None, extra_env=None):
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        env.setdefault("EAC_TEST_KEY", "env-secret-9999")
        if extra_env:
            env.update(extra_env)
        command = [sys.executable, str(SERVER_PATH)]
        if preferred_port is not None:
            command.extend(["--port", str(preferred_port)])
        command.extend(["--no-browser", "--data-dir", str(data_dir)])
        self.process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
        self.url = ""
        self.port = 0
        self.output_lines = []
        deadline = time.time() + 20
        while time.time() < deadline:
            line = self.process.stdout.readline() if self.process.stdout else ""
            if not line:
                if self.process.poll() is not None:
                    break
                time.sleep(0.05)
                continue
            self.output_lines.append(line.strip())
            match = re.search(r"http://127\.0\.0\.1:(\d+)", line)
            if match:
                self.port = int(match.group(1))
                self.url = "http://127.0.0.1:%d" % self.port
                break
        if not self.url:
            output = " ".join(self.output_lines)
            if self.process.stdout:
                output += self.process.stdout.read()
            raise RuntimeError("server did not start: %s" % output[:2000])

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)


class AutoExitServer:
    """--auto-exit 子进程：端口靠 /api/health 发现，不依赖 stdout（无控制台启动也能测）。"""

    def __init__(self, data_dir: Path, port: int):
        self.port = port
        self.url = "http://127.0.0.1:%d" % port
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        self.process = subprocess.Popen(
            [
                sys.executable,
                str(SERVER_PATH),
                "--port",
                str(port),
                "--no-browser",
                "--auto-exit",
                "--data-dir",
                str(data_dir),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        deadline = time.time() + 20
        while time.time() < deadline:
            if console.probe_running_instance(port):
                break
            if self.process.poll() is not None:
                raise RuntimeError(
                    "auto-exit server exited early with code %s" % self.process.returncode
                )
            time.sleep(0.05)
        else:
            raise RuntimeError("auto-exit server did not become ready")
        self.token = fetch_session_token(port)

    def wait_exit(self, timeout: float = 20) -> int:
        try:
            return self.process.wait(timeout=timeout)
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait(timeout=5)

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)


class MockUpstreamHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: N802
        return

    def _dispatch(self):
        server = self.server
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        body = self.rfile.read(length) if length > 0 else b""
        record = {
            "method": self.command,
            "path": self.path,
            "headers": dict(self.headers),
            "body": body,
        }
        server.requests.append(record)
        server.on_request(self, record)

    do_GET = _dispatch
    do_POST = _dispatch
    do_DELETE = _dispatch


class MockUpstreamServer(ThreadingHTTPServer):
    """线程化的本地假上游，用来验证转发、重定向与流式读取行为。"""

    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        # 这些假上游会主动 RST / 半关连接，socketserver 默认打印的堆栈属于预期噪声
        return

    def __init__(self, on_request):
        super().__init__(("127.0.0.1", 0), MockUpstreamHandler)
        self.requests = []
        self.on_request = on_request
        self.first_sent_at = None
        self._thread = threading.Thread(target=self.serve_forever, daemon=True)
        self._thread.start()

    @property
    def host(self) -> str:
        return "http://127.0.0.1:%d" % self.server_address[1]

    def stop(self) -> None:
        self.shutdown()
        self.server_close()


def header_value(record, name):
    wanted = name.lower()
    for key, value in record.get("headers", {}).items():
        if key.lower() == wanted:
            return value
    return None


def mock_send_json(handler, payload, status=200):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)
    handler.wfile.flush()


def request(
    port: int,
    method: str,
    path: str,
    *,
    token=None,
    body=None,
    body_bytes=None,
    headers=None,
    origin=None,
    timeout=10,
):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    all_headers = dict(headers or {})
    if token is not None:
        all_headers["X-Console-Token"] = token
    if origin is not None:
        all_headers["Origin"] = origin
    payload = body_bytes
    if payload is None and body is not None:
        payload = json.dumps(body).encode("utf-8")
        all_headers.setdefault("Content-Type", "application/json")
    try:
        connection.request(method, path, body=payload, headers=all_headers)
        response = connection.getresponse()
        data = response.read()
        return response.status, data, dict(response.getheaders())
    finally:
        connection.close()


def request_declared_length(port: int, path: str, token: str, declared: int):
    """只发送头部并声明超大 Content-Length，验证服务端在读体前直接 413。"""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.putrequest("POST", path)
        connection.putheader("X-Console-Token", token)
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Length", str(declared))
        connection.endheaders()
        response = connection.getresponse()
        data = response.read()
        return response.status, data
    finally:
        connection.close()


def request_without_length(port: int, path: str, token: str):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.putrequest("POST", path)
        connection.putheader("X-Console-Token", token)
        connection.endheaders()
        response = connection.getresponse()
        data = response.read()
        return response.status, data
    finally:
        connection.close()


def fetch_session_token(port: int) -> str:
    status, body, _headers = request(port, "GET", "/")
    if status != 200:
        raise RuntimeError("index not served: HTTP %d" % status)
    text = body.decode("utf-8", "replace")
    match = re.search(r'<meta name="console-session-token" content="([0-9a-f]+)"', text)
    if not match:
        raise RuntimeError("session token meta was not injected")
    return match.group(1)


def post_config(port: int, token: str, payload, origin=None):
    return request(
        port,
        "POST",
        "/api/config",
        token=token,
        body=payload,
        origin=origin,
    )


def find_headless_browser() -> str | None:
    """定位无头 Edge/Chromium；EDGE_PATH / CHROME_PATH 可覆盖自动探测。"""
    for variable in ("EDGE_PATH", "CHROME_PATH"):
        explicit = os.environ.get(variable)
        if explicit and Path(explicit).is_file():
            return explicit
    candidates: list[str] = []
    if os.name == "nt":
        for variable in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
            base = os.environ.get(variable)
            if not base:
                continue
            candidates.append(
                str(Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe")
            )
            candidates.append(
                str(Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe")
            )
    elif sys.platform == "darwin":
        candidates.extend(
            [
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            ]
        )
    else:
        candidates.extend(
            [
                "/usr/bin/microsoft-edge",
                "/usr/bin/google-chrome",
                "/usr/bin/chromium",
                "/usr/bin/chromium-browser",
            ]
        )
    for name in ("msedge", "chrome", "google-chrome", "chromium", "chromium-browser"):
        resolved = shutil.which(name)
        if resolved:
            candidates.append(resolved)
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    return None


class HeadlessBrowser:
    """无头 Edge/Chromium + HTTP 版 DevTools 端点。

    只用 /json/version、/json/new、/json/close 三个 HTTP 接口，不引入 WebSocket
    依赖；开标签页 / 关标签页等价于真实用户打开与关闭生产页面。
    """

    def __init__(self, executable: str):
        self._profile = Path(tempfile.mkdtemp(prefix="eac-headless-"))
        self._debug_port = free_port()
        self.process = subprocess.Popen(
            [
                executable,
                "--headless=new",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--disable-sync",
                "--disable-background-networking",
                "--remote-debugging-port=%d" % self._debug_port,
                "--user-data-dir=%s" % self._profile,
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def _control(self, method: str, path: str, timeout: float = 5.0):
        connection = http.client.HTTPConnection("127.0.0.1", self._debug_port, timeout=timeout)
        try:
            connection.request(method, path)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def wait_ready(self, timeout: float = 20.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                return False
            try:
                status, _body = self._control("GET", "/json/version", timeout=1.0)
                if status == 200:
                    return True
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(0.1)
        return False

    def open_tab(self, url: str) -> str | None:
        quoted = urllib.parse.quote(url, safe="")
        try:
            status, body = self._control("PUT", "/json/new?%s" % quoted, timeout=10.0)
            if status != 200:
                status, body = self._control("GET", "/json/new?%s" % quoted, timeout=10.0)
        except (OSError, http.client.HTTPException):
            return None
        if status != 200:
            return None
        try:
            payload = json.loads(body.decode("utf-8"))
        except ValueError:
            return None
        target_id = payload.get("id")
        return target_id if isinstance(target_id, str) else None

    def close_tab(self, target_id: str) -> bool:
        try:
            status, _body = self._control("GET", "/json/close/%s" % target_id, timeout=10.0)
        except (OSError, http.client.HTTPException):
            return False
        return status == 200

    def stop(self) -> None:
        if self.process.poll() is None:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/pid", str(self.process.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.process.kill()
            else:
                self.process.terminate()
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
        for _ in range(5):
            try:
                shutil.rmtree(self._profile)
                break
            except OSError:
                time.sleep(0.2)


def find_installed_package(name: str, from_dir: Path):
    """按 Node 的解析顺序向上查找已安装包目录（与 scripts/third-party-licenses.mjs 一致）。"""
    current = from_dir
    while True:
        base = (
            current / name
            if current.name == "node_modules"
            else current / "node_modules" / name
        )
        if base.is_dir():
            try:
                return base.resolve()
            except OSError:
                return base
        parent = current.parent
        if parent == current:
            return None
        current = parent


def scan_prebundled_map_sources(root: Path) -> dict:
    """遍历全部入包运行时依赖目录里的 .map，返回 {预打包包名: {宿主包}}。"""
    try:
        manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    packages: dict = {}
    visited = set()
    queue = []
    for name in manifest.get("dependencies", {}):
        found = find_installed_package(name, root)
        if found is not None:
            queue.append((name, found))
    while queue:
        requested, package_dir = queue.pop()
        if package_dir in visited:
            continue
        visited.add(package_dir)
        try:
            package_manifest = json.loads(
                (package_dir / "package.json").read_text(encoding="utf-8")
            )
        except (OSError, ValueError):
            continue
        package_name = package_manifest.get("name") or requested
        packages[package_name] = package_dir
        dependencies = list(package_manifest.get("dependencies") or {}) + list(
            package_manifest.get("optionalDependencies") or {}
        )
        for dependency in dependencies:
            found = find_installed_package(dependency, package_dir)
            if found is not None:
                queue.append((dependency, found))
    installed = set(packages)
    references: dict = {}
    source_pattern = re.compile(r"node_modules[\\/]+((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]")
    for package_name, package_dir in packages.items():
        for map_path in package_dir.rglob("*.map"):
            try:
                if "node_modules" in map_path.relative_to(package_dir).parts:
                    continue
                if map_path.stat().st_size > 16 * 1024 * 1024:
                    continue
                payload = json.loads(map_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            sources = payload.get("sources") if isinstance(payload, dict) else None
            if not isinstance(sources, list):
                continue
            for source in sources:
                if not isinstance(source, str):
                    continue
                for match in source_pattern.finditer(source):
                    dependency = match.group(1).replace("\\", "/")
                    # pnpm 的虚拟目录前缀不是 npm 包名
                    if dependency.startswith("."):
                        continue
                    if dependency in installed:
                        continue
                    references.setdefault(dependency, set()).add(package_name)
    return references


def main() -> int:
    print("== URL 归一化与默认配置（纯函数） ==")
    channel = console.default_channel("T")
    channel["baseUrl"] = "http://192.168.1.10:8000"
    eq(
        console.normalize_chat_url(channel),
        "http://192.168.1.10:8000/v1/chat/completions",
        "OpenAI bare host normalization",
    )
    channel["baseUrl"] = "http://192.168.1.10:8000/v1"
    eq(
        console.normalize_chat_url(channel),
        "http://192.168.1.10:8000/v1/chat/completions",
        "OpenAI /v1 normalization",
    )
    channel["protocol"] = "anthropic"
    channel["baseUrl"] = "https://gateway.example/anthropic/v1/messages"
    eq(
        console.normalize_chat_url(channel),
        "https://gateway.example/anthropic/v1/messages",
        "Anthropic full endpoint kept",
    )
    channel["baseUrl"] = "https://gateway.example/anthropic/v1"
    eq(
        console.normalize_chat_url(channel),
        "https://gateway.example/anthropic/v1/messages",
        "Anthropic prefix normalization",
    )
    eq(
        console.normalize_models_url(channel),
        "https://gateway.example/anthropic/v1/models",
        "Anthropic models URL",
    )
    eq(
        console.normalize_files_url(channel),
        "https://gateway.example/anthropic/v1/files",
        "Anthropic files URL",
    )
    channel["baseUrl"] = "https://gateway.example/anthropic/v1/messages"
    eq(
        console.normalize_files_url(channel),
        "https://gateway.example/anthropic/v1/files",
        "Anthropic files URL replaces a full /messages endpoint",
    )
    channel["baseUrl"] = "https://gateway.example/anthropic"
    eq(
        console.normalize_files_url(channel),
        "https://gateway.example/anthropic/v1/files",
        "Anthropic prefix files URL",
    )
    channel["baseUrl"] = "https://gateway.example"
    eq(
        console.normalize_files_url(channel),
        "https://gateway.example/v1/files",
        "Bare host files URL",
    )
    raw_channel = console.default_channel("raw")
    raw_channel["baseUrl"] = "https://gateway.example/llm?api-version=1"
    raw_channel["lockRawUrl"] = True
    eq(
        console.normalize_chat_url(raw_channel),
        "https://gateway.example/llm?api-version=1",
        "locked raw URL untouched",
    )
    defaults = console.sanitize_settings({})
    eq(defaults["ui"]["locale"], "en", "server default locale is English")
    ok(
        '.'.join(['api', 'deepseek', 'com']) not in json.dumps(defaults),
        "server defaults contain no vendor endpoint",
    )
    polluted = console.sanitize_settings(
        {"ui": {"locale": "de", "fontScale": 9}, "channels": {"primary": {"baseUrl": " x "}}}
    )
    eq(polluted["ui"]["locale"], "en", "invalid locale falls back to English")
    eq(polluted["ui"]["fontScale"], 1, "invalid font scale falls back")
    eq(polluted["channels"]["primary"]["baseUrl"], "x", "base URL trimmed")

    print("\n== 启动 / 令牌 / 绑定 ==")
    temp_dir = Path(tempfile.mkdtemp(prefix="eac-server-selftest-"))
    server = ServerProcess(temp_dir, free_port())
    port = server.port
    token = fetch_session_token(port)
    ok(bool(re.fullmatch(r"[0-9a-f]{48}", token)), "session token is 48 hex chars", token)
    ok(port >= 1, "server reported its port", str(port))

    status, body, _ = request(port, "GET", "/api/health", token=token)
    health = json.loads(body.decode("utf-8"))
    eq(status, 200, "health with token")
    eq(health.get("bind"), "127.0.0.1", "health reports loopback bind")
    eq(health.get("ok"), True, "health ok flag")
    eq(health.get("port"), port, "health reports actual port")

    # 局域网地址不应当可连（绑定 0.0.0.0 时这里会立即成功）
    lan_ip = None
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        lan_ip = probe.getsockname()[0]
        probe.close()
    except OSError:
        lan_ip = None
    if lan_ip and not lan_ip.startswith("127."):
        reachable = False
        try:
            with socket.create_connection((lan_ip, port), timeout=1.5):
                reachable = True
        except OSError:
            reachable = False
        ok(not reachable, "server not reachable via LAN address", "%s:%d" % (lan_ip, port))
    else:
        print("ok - LAN address unavailable, loopback bind verified via health")

    print("\n== 同源防伪令牌 ==")
    status, _body, _ = request(port, "GET", "/api/config")
    eq(status, 403, "missing X-Console-Token rejected")
    status, _body, _ = request(port, "GET", "/api/config", token="0" * 48)
    eq(status, 403, "wrong X-Console-Token rejected")
    status, _body, _ = request(
        port, "GET", "/api/config", token=token, origin="http://evil.example"
    )
    eq(status, 403, "cross-origin request rejected")
    status, _body, _ = request(
        port, "GET", "/api/config", token=token, origin="http://127.0.0.1:%d" % port
    )
    eq(status, 200, "same-origin request accepted")

    status, body, _ = request(port, "GET", "/api/health")
    health_probe = json.loads(body.decode("utf-8"))
    eq(status, 200, "health accepts the token-less launcher probe")
    eq(health_probe.get("service"), console.APP_NAME, "token-less health identifies the service")
    status, _body, _ = request(port, "GET", "/api/health", origin="http://evil.example")
    eq(status, 403, "token-less health still rejects a foreign Origin")
    status, _body, _ = request(port, "GET", "/api/health", token="0" * 48)
    eq(status, 200, "health ignores a stale token when the origin is local")
    status, _body, _ = request(
        port, "GET", "/api/health", origin="http://127.0.0.1:%d" % port
    )
    eq(status, 200, "health accepts the exact same origin without a token")

    print("\n== Host 头防线 ==")
    status, _body, _ = request(port, "GET", "/", headers={"Host": "evil.example"})
    eq(status, 403, "foreign Host rejected for static files")
    status, _body, _ = request(port, "HEAD", "/", headers={"Host": "evil.example"})
    eq(status, 403, "foreign Host rejected for HEAD")
    status, _body, _ = request(
        port, "GET", "/api/config", token=token, headers={"Host": "evil.example"}
    )
    eq(status, 403, "foreign Host rejected before API handling")
    status, _body, _ = request(
        port, "POST", "/api/config", token=token, headers={"Host": "evil.example"}, body={}
    )
    eq(status, 403, "foreign Host rejected for POST")
    status, _body, _ = request(port, "GET", "/", headers={"Host": "127.0.0.1:%d" % port})
    eq(status, 200, "loopback Host accepted")
    status, _body, _ = request(port, "GET", "/", headers={"Host": "localhost:%d" % port})
    eq(status, 200, "localhost Host accepted")
    status, body, _ = request(
        port, "GET", "/api/config", token=token, headers={"Host": "localhost:%d" % port}
    )
    eq(status, 200, "localhost Host accepted for API calls")

    print("\n== 目录穿越拦截 ==")
    traversal_paths = [
        "/../server.py",
        "/%2e%2e/server.py",
        "/..%2fserver.py",
        "/static/../../server.py",
        "/%2e%2e%2f%2e%2e%2fREADME.md",
        "/" + "C:" + "/Windows/win.ini",
    ]
    for path in traversal_paths:
        status, body, _ = request(port, "GET", path)
        text = body.decode("utf-8", "replace")
        ok(
            status in (400, 403, 404) and "def main" not in text and "[paths]" not in text,
            "traversal blocked: %s" % path,
            "status=%d" % status,
        )

    print("\n== 静态文件 ==")
    status, body, _ = request(port, "GET", "/LICENSE")
    eq(status, 200, "LICENSE served")
    ok(b"MIT License" in body, "LICENSE content correct")
    ok(b"DeepSeek" in body, "dual copyright line present")
    status, body, _ = request(port, "GET", "/nonexistent-asset.js")
    eq(status, 404, "missing static asset is 404")

    print("\n== 有界请求体 ==")
    status, _body = request_declared_length(port, "/api/config", token, 1024 * 1024 + 1)
    eq(status, 413, "1 MB config limit enforced")
    status, _body = request_declared_length(port, "/api/chat/stream", token, 32 * 1024 * 1024 + 1)
    eq(status, 413, "32 MB chat limit enforced")
    status, _body = request_declared_length(port, "/api/files/upload", token, 32 * 1024 * 1024 + 1)
    eq(status, 413, "32 MB file limit enforced")
    status, _body = request_without_length(port, "/api/config", token)
    eq(status, 400, "missing Content-Length rejected")
    status, body, _ = request(port, "POST", "/api/config", token=token, body_bytes=b"{bad json")
    eq(status, 400, "invalid JSON rejected")
    status, body, _ = request(
        port, "POST", "/api/config", token=token, body_bytes=b'{"settings":"nope"}'
    )
    eq(status, 400, "invalid settings payload rejected")

    print("\n== 配置与密钥 ==")
    settings_payload = console.default_settings()
    settings_payload["channels"]["primary"]["label"] = "Primary Selftest"
    settings_payload["channels"]["primary"]["baseUrl"] = "http://127.0.0.1:9"
    settings_payload["channels"]["primary"]["model"] = "selftest-model"
    settings_payload["channels"]["primary"]["apiKeyEnv"] = "EAC_TEST_KEY"
    status, body, _ = post_config(port, token, {"settings": settings_payload})
    eq(status, 200, "config save")
    snapshot = json.loads(body.decode("utf-8"))
    eq(snapshot["settings"]["channels"]["primary"]["label"], "Primary Selftest", "settings persisted")
    ok("settings" in snapshot and "secrets" in snapshot and "storage" in snapshot, "snapshot shape complete")

    status, body, _ = post_config(port, token, {"keys": {"primary": "sk-selftest-1234"}})
    eq(status, 200, "secret save")
    snapshot = json.loads(body.decode("utf-8"))
    eq(snapshot["secrets"]["primary"]["hasKey"], True, "stored key reported as set")
    eq(snapshot["secrets"]["primary"]["mask"], "...1234", "only last four characters returned")
    ok("sk-selftest-1234" not in body.decode("utf-8"), "plaintext key never returned")
    status, body, _ = request(port, "GET", "/api/config", token=token)
    text = body.decode("utf-8")
    ok("sk-selftest-1234" not in text, "GET config never returns plaintext key")
    snapshot = json.loads(text)
    eq(snapshot["secrets"]["primary"]["envSet"], True, "environment variable priority flagged")

    status, body, _ = post_config(port, token, {"clearKeys": ["primary"]})
    eq(json.loads(body.decode("utf-8"))["secrets"]["primary"]["hasKey"], False, "clearKeys works")

    print("\n== 自定义 Header 脱敏与合并 ==")
    header_settings = console.default_settings()
    header_settings["channels"]["primary"]["customHeaders"] = [{"name": "X-Org", "value": ""}]
    status, body, _ = post_config(
        port,
        token,
        {
            "settings": header_settings,
            "customHeaders": {"primary": [{"name": "X-Org", "value": "header-secret-1234"}]},
        },
    )
    eq(status, 200, "custom header save")
    snapshot = json.loads(body.decode("utf-8"))
    eq(
        snapshot["settings"]["channels"]["primary"]["customHeaders"],
        [{"name": "X-Org", "value": ""}],
        "settings keep only the header name",
    )
    eq(
        snapshot["secrets"]["customHeaders"]["primary"],
        [{"name": "X-Org", "mask": "...1234"}],
        "custom header mask is the last four characters",
    )
    ok("header-secret-1234" not in body.decode("utf-8"), "POST response never returns header plaintext")
    eq(snapshot["secrets"]["customHeaders"]["backup"], [], "backup slot has no custom headers")

    status, body, _ = request(port, "GET", "/api/config", token=token)
    text = body.decode("utf-8")
    ok("header-secret-1234" not in text, "GET config never returns header plaintext")
    snapshot = json.loads(text)
    eq(
        snapshot["settings"]["channels"]["primary"]["customHeaders"],
        [{"name": "X-Org", "value": ""}],
        "GET settings expose an empty header value",
    )
    eq(
        snapshot["secrets"]["customHeaders"]["primary"],
        [{"name": "X-Org", "mask": "...1234"}],
        "GET masks the stored header value",
    )
    settings_text = (temp_dir / "settings.json").read_text(encoding="utf-8")
    ok("header-secret-1234" not in settings_text, "settings.json stores no header plaintext")
    ok("X-Org" in settings_text, "settings.json stores the header name")
    secrets_text = (temp_dir / "secrets.json").read_text(encoding="utf-8")
    ok("header-secret-1234" in secrets_text, "secrets.json stores the header plaintext")

    status, body, _ = post_config(
        port, token, {"customHeaders": {"primary": [{"name": "X-Org", "value": ""}]}}
    )
    eq(
        json.loads(body.decode("utf-8"))["secrets"]["customHeaders"]["primary"],
        [{"name": "X-Org", "mask": "...1234"}],
        "an empty header value keeps the stored secret",
    )
    status, body, _ = post_config(
        port,
        token,
        {"customHeaders": {"primary": [{"name": "X-Trace", "value": "trace-secret-5678"}]}},
    )
    snapshot = json.loads(body.decode("utf-8"))
    eq(
        snapshot["secrets"]["customHeaders"]["primary"],
        [{"name": "X-Trace", "mask": "...5678"}],
        "a header name missing from the submitted list is deleted",
    )
    eq(
        snapshot["settings"]["channels"]["primary"]["customHeaders"],
        [{"name": "X-Trace", "value": ""}],
        "settings header names follow the merge",
    )
    status, body, _ = post_config(
        port,
        token,
        {"customHeaders": {"primary": [{"name": "X-Trace", "value": "x" * 64}]}},
    )
    eq(status, 200, "long header value accepted")
    eq(
        json.loads(body.decode("utf-8"))["secrets"]["customHeaders"]["primary"][0]["mask"],
        "..." + "x" * 4,
        "long header value masked by its tail",
    )
    status, _body, _ = post_config(port, token, {"customHeaders": {"primary": "nope"}})
    eq(status, 400, "invalid customHeaders payload rejected")
    status, body, _ = post_config(
        port,
        token,
        {
            "customHeaders": {
                "primary": [{"name": "X-H%02d" % index, "value": "v%d" % index}
                            for index in range(20)]
            }
        },
    )
    eq(
        len(json.loads(body.decode("utf-8"))["secrets"]["customHeaders"]["primary"]),
        16,
        "custom header count is capped at 16",
    )
    status, body, _ = post_config(
        port,
        token,
        {
            "customHeaders": {
                "primary": [
                    {"name": "Good-Name", "value": "ok"},
                    {"name": "Bad Header", "value": "nope"},
                ]
            }
        },
    )
    snapshot = json.loads(body.decode("utf-8"))
    eq(
        [item["name"] for item in snapshot["secrets"]["customHeaders"]["primary"]],
        ["Good-Name"],
        "invalid custom header names are dropped",
    )
    status, body, _ = post_config(
        port,
        token,
        {
            "customHeaders": {
                "primary": [{"name": "X-%02d" % index, "value": "w" * 2000}
                            for index in range(16)]
            }
        },
    )
    entries = json.loads(body.decode("utf-8"))["secrets"]["customHeaders"]["primary"]
    ok(0 < len(entries) < 16, "custom header total size is capped", "count=%d" % len(entries))

    # 旧版本可能把 Header 明文写进 settings.json：读取时迁移到 secrets.json 并清空原值
    post_config(port, token, {"customHeaders": {"primary": []}})
    legacy_settings = console.default_settings()
    legacy_settings["channels"]["primary"]["customHeaders"] = [
        {"name": "X-Legacy", "value": "legacy-secret-4321"}
    ]
    legacy_text = json.dumps(legacy_settings, ensure_ascii=False, indent=2)
    (temp_dir / "settings.json").write_text(legacy_text, encoding="utf-8")
    (temp_dir / "settings.json.bak").write_text(legacy_text, encoding="utf-8")
    status, body, _ = request(port, "GET", "/api/config", token=token)
    text = body.decode("utf-8")
    snapshot = json.loads(text)
    eq(status, 200, "config request with a legacy plaintext header succeeds")
    ok("legacy-secret-4321" not in text, "legacy plaintext header is not returned")
    eq(
        snapshot["settings"]["channels"]["primary"]["customHeaders"],
        [{"name": "X-Legacy", "value": ""}],
        "legacy header value is emptied in the response",
    )
    ok(
        {"name": "X-Legacy", "mask": "...4321"}
        in snapshot["secrets"]["customHeaders"]["primary"],
        "legacy header value is exposed only as a mask",
    )
    ok(
        "legacy-secret-4321" not in (temp_dir / "settings.json").read_text(encoding="utf-8"),
        "legacy plaintext is removed from settings.json",
    )
    ok(
        "legacy-secret-4321" not in (temp_dir / "settings.json.bak").read_text(encoding="utf-8"),
        "legacy plaintext is removed from settings.json.bak",
    )
    ok(
        "legacy-secret-4321" in (temp_dir / "secrets.json").read_text(encoding="utf-8"),
        "legacy plaintext is preserved in secrets.json",
    )

    print("\n== 并发写互斥 / 原子性 ==")
    def write_config(index: int):
        payload = console.default_settings()
        payload["channels"]["primary"]["label"] = "concurrent-%d" % index
        return post_config(port, token, {"settings": payload})[0]

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        statuses = list(executor.map(write_config, range(8)))
    eq(statuses, [200] * 8, "concurrent config writes all succeed")
    status, body, _ = request(port, "GET", "/api/config", token=token)
    eq(status, 200, "config readable after concurrent writes")
    json.loads(body.decode("utf-8"))
    settings_file = temp_dir / "settings.json"
    ok(settings_file.is_file(), "settings.json exists")
    json.loads(settings_file.read_text(encoding="utf-8"))
    bak_file = temp_dir / "settings.json.bak"
    ok(bak_file.is_file(), "settings.json.bak exists")
    try:
        json.loads(bak_file.read_text(encoding="utf-8"))
        ok(True, "backup is valid JSON")
    except ValueError:
        ok(False, "backup is valid JSON")
    leftovers = list(temp_dir.glob("*.tmp"))
    eq(leftovers, [], "no .tmp files left behind")

    atomic_target = temp_dir / "atomic-target-dir"
    atomic_target.mkdir()
    raised = False
    try:
        console.atomic_write_json(atomic_target, {"probe": True})
    except OSError:
        raised = True
    ok(raised, "atomic write surfaces a replace failure")
    eq(
        list(temp_dir.glob("atomic-target-dir.*.tmp")),
        [],
        "failed atomic write removes its temporary file",
    )
    atomic_target.rmdir()

    print("\n== .bak 损坏回退恢复 ==")
    preserved_label = json.loads(settings_file.read_text(encoding="utf-8"))["channels"]["primary"]["label"]
    settings_file.write_text("{ this is broken", encoding="utf-8")
    status, body, _ = request(port, "GET", "/api/config", token=token)
    eq(status, 200, "corrupt settings recovered without crashing")
    snapshot = json.loads(body.decode("utf-8"))
    eq(snapshot["storage"]["settings"], "recovered", "storage health marks settings recovery")
    eq(snapshot["storage"]["recovered"], True, "recovered flag set")
    ok(
        snapshot["settings"]["channels"]["primary"]["label"] == preserved_label
        or snapshot["settings"]["channels"]["primary"]["label"].startswith("concurrent-"),
        "recovered settings readable",
    )
    json.loads(settings_file.read_text(encoding="utf-8"))
    status, body, _ = request(port, "GET", "/api/config", token=token)
    sticky = json.loads(body.decode("utf-8"))
    eq(sticky["storage"]["settings"], "ok", "recovered file was rewritten and reads as ok")
    eq(sticky["storage"]["recovered"], True, "recovered flag stays true for the process lifetime")

    post_config(port, token, {"keys": {"backup": "sk-backup-AAAA"}})
    post_config(port, token, {"keys": {"backup": "sk-backup-BBBB"}})
    secrets_file = temp_dir / "secrets.json"
    secrets_file.write_text("{ broken secrets", encoding="utf-8")
    status, body, _ = request(port, "GET", "/api/config", token=token)
    snapshot = json.loads(body.decode("utf-8"))
    eq(status, 200, "corrupt secrets recovered")
    eq(snapshot["storage"]["secrets"], "recovered", "storage health marks secrets recovery")
    eq(
        snapshot["secrets"]["backup"]["mask"],
        "...BBBB",
        "recovered key mirrors the last committed key, not the overwritten one",
    )
    ok((temp_dir / "secrets.json.bak").is_file(), "secrets backup exists")
    if os.name == "posix":
        mode = secrets_file.stat().st_mode & 0o777
        eq(mode, 0o600, "secrets.json is 0600 on POSIX")

    print("\n== SSE 真流式透传 ==")
    first_frame = b"data: " + b"a" * 22 + b"\n\n"
    second_frame = b"data: " + b"b" * 22 + b"\n\n"

    def slow_sse(handler, _record):
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Transfer-Encoding", "chunked")
        handler.end_headers()
        handler.wfile.write(b"%x\r\n" % len(first_frame) + first_frame + b"\r\n")
        handler.wfile.flush()
        handler.server.first_sent_at = time.monotonic()
        time.sleep(0.5)
        handler.wfile.write(b"%x\r\n" % len(second_frame) + second_frame + b"\r\n0\r\n\r\n")
        handler.wfile.flush()

    sse_mock = MockUpstreamServer(slow_sse)
    stream_settings = console.default_settings()
    stream_settings["channels"]["primary"]["baseUrl"] = sse_mock.host
    stream_settings["channels"]["primary"]["customHeaders"] = [{"name": "X-Org", "value": ""}]
    post_config(
        port,
        token,
        {
            "settings": stream_settings,
            "keys": {"primary": "sk-forwarded-1234"},
            "customHeaders": {"primary": [{"name": "X-Org", "value": "header-secret-1234"}]},
        },
    )
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    connection.request(
        "POST",
        "/api/chat/stream",
        body=json.dumps({"slot": "primary", "payload": {"messages": []}}).encode("utf-8"),
        headers={"X-Console-Token": token, "Content-Type": "application/json"},
    )
    response = connection.getresponse()
    eq(response.status, 200, "chat stream accepted")
    first_chunk = response.read(len(first_frame))
    first_arrival = time.monotonic()
    rest_chunks = response.read()
    connection.close()
    sent_at = sse_mock.first_sent_at
    sse_mock.stop()
    eq(first_chunk, first_frame, "first SSE frame forwarded unchanged")
    eq(rest_chunks, second_frame, "second SSE frame forwarded unchanged")
    latency = (first_arrival - sent_at) if sent_at is not None else -1.0
    ok(sent_at is not None and latency < 0.2, "first SSE frame reaches the client promptly",
       "latency=%.3fs" % latency)
    forwarded = sse_mock.requests[0] if sse_mock.requests else {}
    eq(header_value(forwarded, "Authorization"), "Bearer sk-forwarded-1234", "stored key forwarded")
    eq(header_value(forwarded, "X-Org"), "header-secret-1234",
       "custom header merges the settings name with the secrets value")

    print("\n== 跨源重定向防护 ==")
    redirect_target = MockUpstreamServer(
        lambda handler, _record: mock_send_json(handler, {"ok": True})
    )

    def cross_origin_redirect(handler, _record):
        handler.send_response(302)
        handler.send_header("Location", redirect_target.host + "/v1/chat/completions")
        handler.send_header("Content-Length", "0")
        handler.end_headers()

    redirect_source = MockUpstreamServer(cross_origin_redirect)
    redirect_settings = console.default_settings()
    redirect_settings["channels"]["primary"]["baseUrl"] = redirect_source.host
    redirect_settings["channels"]["primary"]["customHeaders"] = [{"name": "X-Org", "value": ""}]
    post_config(
        port,
        token,
        {
            "settings": redirect_settings,
            "keys": {"primary": "sk-cross-1234"},
            "customHeaders": {"primary": [{"name": "X-Org", "value": "header-secret-1234"}]},
        },
    )
    status, body, _ = request(
        port, "POST", "/api/chat/stream", token=token,
        body={"slot": "primary", "payload": {"messages": []}},
    )
    text = body.decode("utf-8", "replace")
    eq(status, 502, "cross-origin redirect rejected with 502")
    ok("cross-origin redirect" in text, "redirect failure mentions cross-origin redirect", text[:300])
    eq(redirect_target.requests, [], "redirect target received no request at all")
    leaked = []
    for record in redirect_target.requests:
        for name in ("Authorization", "x-api-key", "X-Org"):
            value = header_value(record, name)
            if value:
                leaked.append((name, value))
    eq(leaked, [], "no auth or custom header reached the second origin")

    anthropic_redirect = console.default_settings()
    anthropic_redirect["channels"]["primary"]["protocol"] = "anthropic"
    anthropic_redirect["channels"]["primary"]["baseUrl"] = redirect_source.host
    anthropic_redirect["channels"]["primary"]["customHeaders"] = [{"name": "X-Org", "value": ""}]
    post_config(
        port,
        token,
        {
            "settings": anthropic_redirect,
            "customHeaders": {"primary": [{"name": "X-Org", "value": "header-secret-1234"}]},
        },
    )
    status, body, _ = request(
        port, "POST", "/api/chat/stream", token=token,
        body={"slot": "primary", "payload": {"messages": []}},
    )
    eq(status, 502, "cross-origin redirect is rejected for the Anthropic protocol too")
    ok(
        "cross-origin redirect" in body.decode("utf-8", "replace"),
        "Anthropic redirect failure mentions cross-origin redirect",
        body[:300],
    )
    eq(redirect_target.requests, [], "no x-api-key or custom header reached the second origin")
    redirect_target.stop()
    redirect_source.stop()

    print("\n== 同源重定向放行 ==")

    def same_origin_redirect(handler, record):
        if record["path"].endswith("/v1/retry"):
            mock_send_json(handler, {"ok": True, "redirected": True})
            return
        handler.send_response(302)
        handler.send_header("Location", "/v1/retry")
        handler.send_header("Content-Length", "0")
        handler.end_headers()

    same_mock = MockUpstreamServer(same_origin_redirect)
    same_settings = console.default_settings()
    same_settings["channels"]["primary"]["baseUrl"] = same_mock.host
    post_config(port, token, {"settings": same_settings})
    status, body, _ = request(
        port, "POST", "/api/chat/stream", token=token,
        body={"slot": "primary", "payload": {"messages": []}},
    )
    eq(status, 200, "same-origin redirect is followed")
    ok(b'"redirected": true' in body, "same-origin redirect target response forwarded", body[:200])
    same_mock.stop()

    print("\n== 模型探测的 Header 优先级 ==")
    probe_mock = MockUpstreamServer(
        lambda handler, _record: mock_send_json(handler, {"data": [{"id": "probe-model"}]})
    )
    probe_settings = console.default_settings()
    probe_settings["channels"]["primary"]["baseUrl"] = probe_mock.host
    probe_settings["channels"]["primary"]["customHeaders"] = [{"name": "X-Org", "value": ""}]
    post_config(
        port,
        token,
        {
            "settings": probe_settings,
            "keys": {"primary": "sk-stored-9999"},
            "customHeaders": {"primary": [{"name": "X-Org", "value": "header-secret-1234"}]},
        },
    )
    status, body, _ = request(
        port,
        "POST",
        "/api/models",
        token=token,
        body={
            "slot": "primary",
            "draft": {
                "baseUrl": probe_mock.host,
                "protocol": "openai",
                "customHeaders": [{"name": "X-Org", "value": "draft-override"}],
            },
        },
    )
    eq(status, 200, "model probe with a draft succeeds")
    ok(b"probe-model" in body, "model probe returns the upstream list", body[:200])
    probe_record = probe_mock.requests[0] if probe_mock.requests else {}
    eq(header_value(probe_record, "X-Org"), "draft-override",
       "a non-empty draft header value beats the stored one")
    eq(header_value(probe_record, "Authorization"), "Bearer sk-stored-9999",
       "the probe falls back to the stored key")
    probe_mock.stop()

    print("\n== 出站默认请求头：干净 User-Agent 与协议 Accept ==")
    header_settings = console.default_settings()
    header_probe_mock = MockUpstreamServer(
        lambda handler, _record: mock_send_json(handler, {"data": [{"id": "header-model"}]})
    )
    header_settings["channels"]["primary"]["baseUrl"] = header_probe_mock.host
    post_config(port, token, {"settings": header_settings, "keys": {"primary": "sk-header-1234"}})
    status, _body, _ = request(port, "POST", "/api/models", token=token, body={"slot": "primary"})
    eq(status, 200, "the model probe through the header-recording mock succeeds")
    header_probe_record = header_probe_mock.requests[0] if header_probe_mock.requests else {}
    eq(
        header_value(header_probe_record, "User-Agent"),
        console.DEFAULT_USER_AGENT,
        "the model probe sends the clean default User-Agent instead of Python-urllib",
    )
    ok(
        not str(header_value(header_probe_record, "User-Agent") or "").startswith("Python-urllib"),
        "the probe never leaks the default urllib client identity",
    )
    eq(
        header_value(header_probe_record, "Accept"),
        "application/json",
        "the model probe asks for a JSON response",
    )
    header_probe_mock.stop()

    def header_chat_sse(handler, _record):
        payload = b'data: {"choices":[{"delta":{"content":"header-ok"}}]}\n\ndata: [DONE]\n\n'
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Content-Length", str(len(payload)))
        handler.end_headers()
        handler.wfile.write(payload)
        handler.wfile.flush()

    header_chat_mock = MockUpstreamServer(header_chat_sse)
    header_settings["channels"]["primary"]["baseUrl"] = header_chat_mock.host
    post_config(port, token, {"settings": header_settings, "keys": {"primary": "sk-header-1234"}})
    status, header_chat_body, header_chat_headers = request(
        port,
        "POST",
        "/api/chat/stream",
        token=token,
        body={"slot": "primary", "payload": {"messages": []}},
    )
    eq(status, 200, "chat forwarding through the header-recording mock succeeds")
    ok(b"header-ok" in header_chat_body, "the forwarded SSE body reaches the client")
    ok(
        "text/event-stream" in (header_chat_headers.get("Content-Type") or ""),
        "a real SSE upstream is still relayed as text/event-stream",
    )
    header_chat_record = header_chat_mock.requests[0] if header_chat_mock.requests else {}
    eq(
        header_value(header_chat_record, "User-Agent"),
        console.DEFAULT_USER_AGENT,
        "chat forwarding sends the clean default User-Agent",
    )
    eq(
        header_value(header_chat_record, "Accept"),
        "text/event-stream",
        "chat forwarding asks for an event stream",
    )
    eq(
        header_value(header_chat_record, "Authorization"),
        "Bearer sk-header-1234",
        "chat forwarding still carries the stored credential",
    )
    header_chat_mock.stop()

    custom_ua_mock = MockUpstreamServer(
        lambda handler, _record: mock_send_json(handler, {"data": []})
    )
    header_settings["channels"]["primary"]["baseUrl"] = custom_ua_mock.host
    header_settings["channels"]["primary"]["customHeaders"] = [{"name": "User-Agent", "value": ""}]
    post_config(
        port,
        token,
        {
            "settings": header_settings,
            "customHeaders": {"primary": [{"name": "User-Agent", "value": "gateway-client/9.9"}]},
        },
    )
    status, _body, _ = request(port, "POST", "/api/models", token=token, body={"slot": "primary"})
    eq(status, 200, "a probe with a custom User-Agent succeeds")
    custom_ua_record = custom_ua_mock.requests[0] if custom_ua_mock.requests else {}
    eq(
        header_value(custom_ua_record, "User-Agent"),
        "gateway-client/9.9",
        "a non-empty custom User-Agent beats the built-in default",
    )
    custom_ua_mock.stop()
    header_settings["channels"]["primary"]["customHeaders"] = []
    post_config(port, token, {"settings": header_settings, "customHeaders": {"primary": []}})

    print("\n== 网关错误体：摊平的 message / code 也要读懂 ==")

    def flattened_error(handler, _record):
        mock_send_json(
            handler,
            {"code": 30014, "data": None, "message": "Token is invalid."},
            status=403,
        )

    flattened_mock = MockUpstreamServer(flattened_error)
    flattened_settings = console.default_settings()
    flattened_settings["channels"]["primary"]["baseUrl"] = flattened_mock.host
    post_config(
        port,
        token,
        {"settings": flattened_settings, "keys": {"primary": "sk-invalid-0000"}},
    )
    status, body, _ = request(
        port,
        "POST",
        "/api/chat/stream",
        token=token,
        body={"slot": "primary", "payload": {"messages": []}},
    )
    eq(status, 403, "an upstream 403 keeps its HTTP status")
    flattened_text = body.decode("utf-8", "replace")
    ok(
        "Token is invalid." in flattened_text,
        "the flattened upstream message reaches the page",
        flattened_text[:300],
    )
    ok(
        "upstream code 30014" in flattened_text,
        "the upstream error code is kept for diagnosis",
        flattened_text[:300],
    )
    ok(
        '"code":30014' not in flattened_text,
        "the raw JSON body is replaced by a readable message",
        flattened_text[:300],
    )
    flattened_mock.stop()

    print("\n== HTTP 200 但返回非 SSE 正文：错误体与完整回复都不能解析失败 ==")

    def json_200_error(handler, _record):
        mock_send_json(
            handler,
            {"error": {"message": "reasoning_effort is not supported by this model"}},
            status=200,
        )

    json_error_mock = MockUpstreamServer(json_200_error)
    json_settings = console.default_settings()
    json_settings["channels"]["primary"]["baseUrl"] = json_error_mock.host
    post_config(port, token, {"settings": json_settings, "keys": {"primary": "sk-json-2000"}})
    status, json_error_body, json_error_headers = request(
        port,
        "POST",
        "/api/chat/stream",
        token=token,
        body={"slot": "primary", "payload": {"messages": []}},
    )
    eq(status, 200, "a 200 JSON response is relayed as 200")
    ok(
        "application/json" in (json_error_headers.get("Content-Type") or "").lower(),
        "the non-SSE response keeps its real JSON content type",
        str(json_error_headers.get("Content-Type")),
    )
    ok(
        b"reasoning_effort is not supported" in json_error_body,
        "the JSON error body is forwarded verbatim for the page to parse",
        json_error_body[:300],
    )
    json_error_mock.stop()

    def json_200_completion(handler, _record):
        mock_send_json(
            handler,
            {
                "choices": [
                    {"message": {"role": "assistant", "content": "non-stream reply"}}
                ],
                "usage": {"prompt_tokens": 3, "completion_tokens": 4},
            },
            status=200,
        )

    json_completion_mock = MockUpstreamServer(json_200_completion)
    json_settings["channels"]["primary"]["baseUrl"] = json_completion_mock.host
    post_config(port, token, {"settings": json_settings, "keys": {"primary": "sk-json-2000"}})
    status, json_completion_body, json_completion_headers = request(
        port,
        "POST",
        "/api/chat/stream",
        token=token,
        body={"slot": "primary", "payload": {"messages": []}},
    )
    eq(status, 200, "a 200 JSON completion is relayed as 200")
    ok(
        "application/json" in (json_completion_headers.get("Content-Type") or "").lower(),
        "the JSON completion keeps its content type",
    )
    ok(
        b"non-stream reply" in json_completion_body,
        "the full non-streaming reply is forwarded without SSE framing",
        json_completion_body[:300],
    )
    json_completion_mock.stop()

    restore_settings = console.default_settings()
    restore_settings["channels"]["primary"]["baseUrl"] = "http://127.0.0.1:9"
    post_config(port, token, {"settings": restore_settings})

    print("\n== 受控路由边界 ==")
    status, _body, _ = request(
        port, "POST", "/api/chat/stream", token=token, body={"slot": "unknown", "payload": {}}
    )
    eq(status, 400, "chat rejects unknown slot")
    status, _body, _ = request(
        port, "POST", "/api/chat/stream", token=token, body={"slot": "primary"}
    )
    eq(status, 400, "chat rejects missing payload")
    status, _body, _ = request(
        port, "POST", "/api/models", token=token, body={"slot": "primary"}
    )
    eq(status, 200, "models probe with unreachable endpoint returns gracefully")
    status, _body, _ = request(port, "POST", "/api/ping", token=token, body={"slot": "primary"})
    eq(status, 200, "ping with unreachable endpoint returns gracefully")
    status, _body, _ = request(
        port, "POST", "/api/files/upload", token=token, body={"x": 1}
    )
    eq(status, 400, "file upload requires multipart")

    settings_payload = console.default_settings()
    settings_payload["exa"]["endpoint"] = "http://127.0.0.1:9/search"
    post_config(port, token, {"settings": settings_payload})
    status, _body, _ = request(
        port, "POST", "/api/search/exa", token=token, body={"query": "selftest"}
    )
    eq(status, 502, "Exa search failure surfaces as 502 without hanging")
    status, _body, _ = request(port, "GET", "/api/unknown", token=token)
    eq(status, 404, "unknown api endpoint is 404")

    print("\n== /api/lifecycle：未开启 --auto-exit 时是纯空操作 ==")
    status, body, _ = request(
        port,
        "POST",
        "/api/lifecycle",
        token=token,
        body={"action": "heartbeat", "tabId": "resident-tab"},
    )
    resident_payload = json.loads(body.decode("utf-8"))
    eq(status, 200, "the resident service answers lifecycle heartbeats")
    eq(resident_payload.get("autoExit"), False, "the resident service reports auto-exit disabled")
    status, _body, _ = request(
        port,
        "POST",
        "/api/lifecycle",
        token=token,
        body={"action": "leave", "tabId": "resident-tab"},
    )
    eq(status, 200, "the resident service accepts a leave event")
    ok(
        console.probe_running_instance(port),
        "a leave event never stops the default resident service",
    )

    print("\n== 自定义 Header 槽位隔离（P1-01） ==")
    isolation_settings = console.default_settings()
    isolation_settings["channels"]["primary"]["customHeaders"] = [{"name": "X-Iso-P", "value": ""}]
    isolation_settings["channels"]["backup"]["customHeaders"] = [{"name": "X-Iso-B", "value": ""}]
    status, body, _ = post_config(
        port,
        token,
        {
            "settings": isolation_settings,
            "customHeaders": {
                "primary": [{"name": "X-Iso-P", "value": "primary-secret-1111"}],
                "backup": [{"name": "X-Iso-B", "value": "backup-secret-2222"}],
            },
        },
    )
    eq(status, 200, "both slots save their custom headers")
    snapshot = json.loads(body.decode("utf-8"))
    eq(
        snapshot["secrets"]["customHeaders"]["backup"],
        [{"name": "X-Iso-B", "mask": "...2222"}],
        "backup header mask is stored",
    )
    status, body, _ = post_config(
        port,
        token,
        {"customHeaders": {"primary": [{"name": "X-Iso-P", "value": "primary-secret-3333"}]}},
    )
    eq(status, 200, "updating only the primary slot succeeds")
    snapshot = json.loads(body.decode("utf-8"))
    eq(
        snapshot["secrets"]["customHeaders"]["primary"],
        [{"name": "X-Iso-P", "mask": "...3333"}],
        "primary header is updated",
    )
    eq(
        snapshot["secrets"]["customHeaders"]["backup"],
        [{"name": "X-Iso-B", "mask": "...2222"}],
        "backup header survives a primary-only update",
    )
    status, body, _ = request(port, "GET", "/api/config", token=token)
    snapshot = json.loads(body.decode("utf-8"))
    eq(
        snapshot["secrets"]["customHeaders"]["backup"],
        [{"name": "X-Iso-B", "mask": "...2222"}],
        "GET config still masks the untouched backup header",
    )
    secrets_data = json.loads((temp_dir / "secrets.json").read_text(encoding="utf-8"))
    eq(
        secrets_data["customHeaders"]["backup"].get("X-Iso-B"),
        "backup-secret-2222",
        "backup header plaintext is preserved byte-for-byte in secrets.json",
    )
    # 整包 settings 只带名称与空值，也绝不能把未提交槽位的密钥解释为空并删除
    status, body, _ = post_config(port, token, {"settings": snapshot["settings"]})
    eq(status, 200, "whole-settings save succeeds")
    snapshot = json.loads(body.decode("utf-8"))
    eq(
        snapshot["secrets"]["customHeaders"]["backup"],
        [{"name": "X-Iso-B", "mask": "...2222"}],
        "whole-settings save never deletes the other slot's stored header",
    )

    print("\n== 联合事务回滚与错误脱敏（P1-02） ==")
    settings_file = temp_dir / "settings.json"
    secrets_file = temp_dir / "secrets.json"
    post_config(port, token, {"keys": {"backup": "sk-rollback-AAAA"}})
    old_secrets_bytes = secrets_file.read_bytes()
    settings_file.unlink()
    settings_file.mkdir()
    rollback_settings = console.default_settings()
    rollback_settings["channels"]["primary"]["label"] = "rollback-new"
    status, body, _ = post_config(
        port,
        token,
        {"settings": rollback_settings, "keys": {"backup": "sk-rollback-BBBB"}},
    )
    eq(status, 500, "settings write failure surfaces as 500")
    text = body.decode("utf-8", "replace")
    ok(
        str(temp_dir) not in text and ".tmp" not in text and not re.search(r"[A-Za-z]:[\\/]", text),
        "500 body contains no local disk path or temp file name",
        text[:300],
    )
    ok('"configPersistFailed"' in text, "500 body exposes a stable redacted error code", text[:300])
    eq(
        secrets_file.read_bytes(),
        old_secrets_bytes,
        "secrets.json is restored byte-for-byte after the second write fails",
    )
    eq(list(temp_dir.glob("*.tmp")), [], "failed joint transaction leaves no temp files")
    settings_file.rmdir()
    restored_settings_text = json.dumps(
        console.default_settings(), ensure_ascii=False, indent=2
    )
    settings_file.write_text(restored_settings_text, encoding="utf-8")
    (temp_dir / "settings.json.bak").write_text(restored_settings_text, encoding="utf-8")
    status, body, _ = request(port, "GET", "/api/config", token=token)
    snapshot = json.loads(body.decode("utf-8"))
    eq(status, 200, "server recovers after the simulated settings write failure")
    eq(
        snapshot["secrets"]["backup"]["mask"],
        "...AAAA",
        "rolled-back secrets still hold the previous key",
    )

    print("\n== 凭据写命中真实文件锁：500 后仍可恢复（P1-2） ==")
    lock_key = "sk-" + "filelock-primary-1111"
    lock_old_secrets = secrets_file.read_bytes()
    lock_temp_files_before = sorted(temp_dir.glob("*.tmp"))
    lock_handle = None
    lock_dir_mode = None
    try:
        if os.name == "nt":
            # Windows：保留一个不带 FILE_SHARE_DELETE 的打开句柄，原子替换目标文件必然失败
            lock_handle = open(secrets_file, "rb")
        else:
            # POSIX：rename 不被打开句柄阻止，改为去掉数据目录写权限，让临时文件无法创建
            lock_dir_mode = temp_dir.stat().st_mode
            os.chmod(temp_dir, 0o500)
        status, body, _ = post_config(port, token, {"keys": {"primary": lock_key}})
    finally:
        if lock_handle is not None:
            lock_handle.close()
        if lock_dir_mode is not None:
            os.chmod(temp_dir, lock_dir_mode)
    eq(status, 500, "a locked secrets.json makes the key save fail with HTTP 500")
    locked_text = body.decode("utf-8", "replace")
    ok(
        '"configPersistFailed"' in locked_text,
        "the locked key save exposes the stable redacted error code",
        locked_text[:300],
    )
    ok(
        str(temp_dir) not in locked_text
        and ".tmp" not in locked_text
        and not re.search(r"[A-Za-z]:[\\/]", locked_text),
        "the locked key save never echoes local disk paths or temp file names",
        locked_text[:300],
    )
    eq(
        secrets_file.read_bytes(),
        lock_old_secrets,
        "a failed locked key write leaves secrets.json byte-for-byte intact",
    )
    eq(
        sorted(temp_dir.glob("*.tmp")),
        lock_temp_files_before,
        "a failed locked key write leaves no new temp file residue",
    )
    status, body, _ = post_config(port, token, {"keys": {"primary": lock_key}})
    eq(status, 200, "the same key save succeeds once the file lock is released")
    lock_snapshot = json.loads(body.decode("utf-8"))
    eq(
        lock_snapshot["secrets"]["primary"]["keyFingerprint"],
        hashlib.sha256(lock_key.encode("utf-8")).hexdigest()[:12],
        "the recovered key save returns the new effective-key fingerprint",
    )
    eq(
        lock_snapshot["secrets"]["primary"]["mask"],
        "..." + lock_key[-4:],
        "the recovered key save returns the new key mask",
    )
    eq(
        json.loads(secrets_file.read_text(encoding="utf-8")).get("primary"),
        lock_key,
        "the recovered key save persists the credential in secrets.json",
    )

    print("\n== 旧明文 Header 迁移失败降级（P1-03） ==")
    legacy_settings = console.default_settings()
    legacy_settings["channels"]["primary"]["customHeaders"] = [
        {"name": "X-Migrate", "value": "migrate-secret-4321"}
    ]
    legacy_text = json.dumps(legacy_settings, ensure_ascii=False, indent=2)
    settings_file.write_text(legacy_text, encoding="utf-8")
    (temp_dir / "settings.json.bak").write_text(legacy_text, encoding="utf-8")
    secrets_file.write_text("{}", encoding="utf-8")
    secrets_bak = temp_dir / "secrets.json.bak"
    if secrets_bak.exists():
        secrets_bak.unlink()
    if os.name == "nt":
        os.chmod(secrets_file, stat.S_IREAD)
    else:
        os.chmod(temp_dir, 0o500)
    try:
        status, body, _ = request(port, "GET", "/api/config", token=token)
    finally:
        if os.name == "nt":
            os.chmod(secrets_file, stat.S_IWRITE | stat.S_IREAD)
        else:
            os.chmod(temp_dir, 0o700)
    eq(status, 200, "migration failure still serves a healthy snapshot")
    snapshot = json.loads(body.decode("utf-8"))
    eq(snapshot["storage"]["degraded"], True, "migration write failure marks storage degraded")
    ok(
        {"name": "X-Migrate", "mask": "...4321"}
        in snapshot["secrets"]["customHeaders"]["primary"],
        "in-memory legacy header value is preserved when secrets write fails",
    )
    ok(
        "migrate-secret-4321" in settings_file.read_text(encoding="utf-8"),
        "settings plaintext is not erased before secrets.json is safely written",
    )
    eq(list(temp_dir.glob("*.tmp")), [], "failed migration leaves no temp files")
    status, body, _ = request(port, "GET", "/api/config", token=token)
    snapshot = json.loads(body.decode("utf-8"))
    eq(snapshot["storage"]["degraded"], False, "degraded clears after a successful retry")
    ok(
        "migrate-secret-4321" not in settings_file.read_text(encoding="utf-8"),
        "plaintext is wiped only after the secrets write succeeded",
    )
    ok(
        "migrate-secret-4321" in secrets_file.read_text(encoding="utf-8"),
        "legacy header value is persisted in secrets.json after retry",
    )
    ok(
        "migrate-secret-4321" not in (temp_dir / "settings.json.bak").read_text(encoding="utf-8"),
        "legacy plaintext is also wiped from settings.json.bak",
    )

    print("\n== 旧明文迁移后 secrets.bak 同步失败置脏与恢复（P1-3） ==")
    guard_dir = Path(tempfile.mkdtemp(prefix="eac-migrate-bak-guard-"))
    guard_settings = console.default_settings()
    guard_settings["channels"]["primary"]["customHeaders"] = [
        {"name": "X-Guard-Migrate", "value": "guard-secret-8765"}
    ]
    (guard_dir / "settings.json").write_text(
        json.dumps(guard_settings, ensure_ascii=False), encoding="utf-8"
    )
    (guard_dir / "secrets.json").write_text("{}", encoding="utf-8")
    # 把 secrets.json.bak 做成目录，令迁移后的备份原子替换必然失败
    (guard_dir / "secrets.json.bak").mkdir()
    guard_store = console.ConfigStore(guard_dir)
    guard_snapshot = guard_store.snapshot()
    eq(
        guard_snapshot["storage"]["degraded"],
        True,
        "a failed backup mirror during migration marks storage degraded",
    )
    ok(
        (guard_dir / "secrets.json.bak.dirty").is_file(),
        "a failed backup mirror persists the sticky secrets bak dirty marker",
    )
    ok(
        {"name": "X-Guard-Migrate", "mask": "...8765"}
        in guard_snapshot["secrets"]["customHeaders"]["primary"],
        "the migrated header stays visible in memory even when the backup mirror fails",
    )
    ok(
        "guard-secret-8765" in (guard_dir / "secrets.json").read_text(encoding="utf-8"),
        "the migrated header is committed to the primary secrets file",
    )
    ok(
        "guard-secret-8765"
        not in (guard_dir / "settings.json").read_text(encoding="utf-8"),
        "the plaintext is erased from settings.json only after the secrets write landed",
    )
    # 解除锁定后再次读取：必须补齐备份并清除脏标记
    (guard_dir / "secrets.json.bak").rmdir()
    guard_snapshot = guard_store.snapshot()
    eq(
        guard_snapshot["storage"]["degraded"],
        False,
        "degraded clears after the backup mirror eventually succeeds",
    )
    ok(
        not (guard_dir / "secrets.json.bak.dirty").is_file(),
        "the sticky dirty marker clears only after a byte-exact backup mirror",
    )
    guard_bak = json.loads(
        (guard_dir / "secrets.json.bak").read_text(encoding="utf-8")
    )
    eq(
        guard_bak.get("customHeaders", {}).get("primary", {}).get("X-Guard-Migrate"),
        "guard-secret-8765",
        "the recovered backup carries the migrated header exactly like the primary file",
    )

    print("\n== 旧明文迁移 + 损坏恢复 + 真实转发请求头（P1-3） ==")
    migrate_dir = Path(tempfile.mkdtemp(prefix="eac-legacy-bak-e2e-"))
    migrate_upstream = MockUpstreamServer(
        lambda handler, _record: mock_send_json(handler, {"ok": True})
    )
    legacy_migrate_settings = console.default_settings()
    legacy_migrate_settings["channels"]["primary"]["baseUrl"] = migrate_upstream.host
    legacy_migrate_settings["channels"]["primary"]["model"] = "migrate-model"
    legacy_migrate_settings["channels"]["primary"]["customHeaders"] = [
        {"name": "X-Migrated-Bak", "value": "migrated-secret-4321"}
    ]
    (migrate_dir / "settings.json").write_text(
        json.dumps(legacy_migrate_settings, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (migrate_dir / "secrets.json").write_text("{}", encoding="utf-8")
    for leftover in migrate_dir.glob("secrets.json.bak*"):
        if leftover.is_file():
            leftover.unlink()
    first_instance = ServerProcess(migrate_dir, free_port())
    try:
        first_token = fetch_session_token(first_instance.port)
        status, body, _ = request(first_instance.port, "GET", "/api/config", token=first_token)
        eq(status, 200, "legacy plaintext header migration serves a config snapshot")
        migrated_secrets = json.loads(
            (migrate_dir / "secrets.json").read_text(encoding="utf-8")
        )
        eq(
            migrated_secrets.get("customHeaders", {}).get("primary", {}).get("X-Migrated-Bak"),
            "migrated-secret-4321",
            "the legacy header value is migrated into secrets.json",
        )
        migrate_bak_path = migrate_dir / "secrets.json.bak"
        ok(migrate_bak_path.is_file(), "migration mirrors the fresh secrets.json into secrets.json.bak")
        migrate_bak = json.loads(migrate_bak_path.read_text(encoding="utf-8"))
        eq(
            migrate_bak.get("customHeaders", {}).get("primary", {}).get("X-Migrated-Bak"),
            "migrated-secret-4321",
            "secrets.json.bak already carries the migrated header before any corruption",
        )
        migrate_settings_after = json.loads(
            (migrate_dir / "settings.json").read_text(encoding="utf-8")
        )
        ok(
            "migrated-secret-4321" not in json.dumps(migrate_settings_after),
            "plaintext is erased from settings.json after migration",
        )
        migrate_settings_bak_path = migrate_dir / "settings.json.bak"
        ok(
            migrate_settings_bak_path.is_file(),
            "migration mirrors the cleaned settings.json into settings.json.bak",
        )
        ok(
            "migrated-secret-4321"
            not in migrate_settings_bak_path.read_text(encoding="utf-8"),
            "settings.json.bak is scrubbed of the legacy plaintext",
        )
    finally:
        first_instance.stop()

    # 截断损坏主文件后重启新实例：迁移后的请求头必须能从 .bak 完整恢复
    (migrate_dir / "secrets.json").write_text('{"primary": "sk-trunc', encoding="utf-8")
    second_instance = ServerProcess(migrate_dir, free_port())
    try:
        second_token = fetch_session_token(second_instance.port)
        status, body, _ = request(second_instance.port, "GET", "/api/config", token=second_token)
        eq(status, 200, "a restarted instance recovers the truncated secrets.json")
        recovered = json.loads(body.decode("utf-8"))
        eq(
            recovered["storage"]["recovered"],
            True,
            "the restart reports that state was recovered from backup",
        )
        ok(
            {"name": "X-Migrated-Bak", "mask": "...4321"}
            in recovered["secrets"]["customHeaders"]["primary"],
            "the migrated custom header survives the damage-and-restart cycle",
        )
        status, _body, _ = request(
            second_instance.port,
            "POST",
            "/api/chat/stream",
            token=second_token,
            body={"slot": "primary", "payload": {"messages": []}},
        )
        eq(status, 200, "chat forwarding works after the backup recovery")
        forwarded_records = migrate_upstream.requests
        ok(len(forwarded_records) >= 1, "the recovered configuration really forwarded a chat request")
        forwarded_record = forwarded_records[-1] if forwarded_records else {}
        eq(
            header_value(forwarded_record, "X-Migrated-Bak"),
            "migrated-secret-4321",
            "the upstream receives the migrated custom header after the recovery",
        )
    finally:
        second_instance.stop()
        migrate_upstream.stop()

    print("\n== 清空密钥同步清洗 .bak（P1-04） ==")
    post_config(port, token, {"keys": {"backup": "sk-scrub-AAAA"}})
    post_config(port, token, {"keys": {"backup": "sk-scrub-BBBB"}})
    bak_before = (temp_dir / "secrets.json.bak").read_text(encoding="utf-8")
    ok("sk-scrub-BBBB" in bak_before, "secrets.json.bak mirrors the latest key before clearing")
    ok("sk-scrub-AAAA" not in bak_before, "overwritten key is already scrubbed from secrets.json.bak")
    status, body, _ = post_config(port, token, {"clearKeys": ["backup"]})
    eq(status, 200, "clear key succeeds")
    bak_after = json.loads((temp_dir / "secrets.json.bak").read_text(encoding="utf-8"))
    eq(bak_after.get("backup"), "", "cleared key is scrubbed from secrets.json.bak")
    main_after = json.loads(secrets_file.read_text(encoding="utf-8"))
    eq(main_after.get("backup"), "", "cleared key is removed from secrets.json")
    ok(
        "sk-scrub-AAAA" not in json.dumps(bak_after) and "sk-scrub-BBBB" not in json.dumps(bak_after),
        "no revoked key plaintext remains in the backup file",
    )

    print("\n== keys 空串清空密钥同步清洗 .bak（回归） ==")
    post_config(port, token, {"keys": {"primary": "sk-empty-body-AAAA"}})
    post_config(port, token, {"keys": {"primary": "sk-empty-body-BBBB"}})
    overwrite_bak = (temp_dir / "secrets.json.bak").read_text(encoding="utf-8")
    ok(
        "sk-empty-body-BBBB" in overwrite_bak,
        "overwriting a key mirrors the latest value into secrets.json.bak",
    )
    ok(
        "sk-empty-body-AAAA" not in overwrite_bak,
        "overwritten key is scrubbed from secrets.json.bak immediately",
    )
    status, _body, _ = post_config(port, token, {"keys": {"primary": ""}})
    eq(status, 200, "empty-string key submission clears the key")
    main_empty = json.loads(secrets_file.read_text(encoding="utf-8"))
    eq(main_empty.get("primary"), "", "empty-string clear empties the primary key in secrets.json")
    bak_empty = json.loads((temp_dir / "secrets.json.bak").read_text(encoding="utf-8"))
    eq(bak_empty.get("primary"), "", "empty-string clear also empties secrets.json.bak")
    ok(
        "sk-empty-body-AAAA" not in json.dumps(bak_empty)
        and "sk-empty-body-BBBB" not in json.dumps(bak_empty),
        "no revoked key plaintext survives in secrets.json.bak after the empty-string clear",
    )
    # 主文件损坏后只能从已清洗的 .bak 恢复：旧密钥绝不复活
    secrets_file.write_text("{ broken after empty clear", encoding="utf-8")
    status, body, _ = request(port, "GET", "/api/config", token=token)
    eq(status, 200, "corrupt primary after the empty-string clear still serves")
    snapshot = json.loads(body.decode("utf-8"))
    eq(snapshot["storage"]["secrets"], "recovered", "clean backup recovers the cleared state")
    eq(snapshot["secrets"]["primary"]["hasKey"], False, "recovered snapshot keeps the key cleared")
    eq(snapshot["secrets"]["primary"]["mask"], "", "recovered mask exposes no key")
    ok(
        "sk-empty-body-BBBB" not in body.decode("utf-8"),
        "revoked key never reappears in the recovered config snapshot",
    )

    print("\n== 备份待清洗状态与脏 .bak 阻断（P1-02） ==")
    post_config(port, token, {"keys": {"backup": "sk-dirty-AAAA"}})
    post_config(port, token, {"keys": {"backup": "sk-dirty-BBBB"}})
    stale_bak_bytes = (temp_dir / "secrets.json.bak").read_bytes()
    ok(
        b"sk-dirty-BBBB" in stale_bak_bytes and b"sk-dirty-AAAA" not in stale_bak_bytes,
        "dirty backup holds exactly the key that the clear must revoke",
    )
    backup_handle = None
    backup_replaced_with_dir = False
    try:
        if os.name == "nt":
            # Windows 上保持打开的文件句柄会让 os.replace 目标报 Access denied，
            # 精确复现“主文件写成功、.bak 原子替换失败”的降级路径
            backup_handle = open(temp_dir / "secrets.json.bak", "rb")
        else:
            # POSIX 上打开句柄不阻塞 rename；用同路径目录制造确定性的替换失败
            (temp_dir / "secrets.json.bak").unlink()
            (temp_dir / "secrets.json.bak").mkdir()
            backup_replaced_with_dir = True
        status, body, _ = post_config(port, token, {"clearKeys": ["backup"]})
        eq(status, 200, "clear key still succeeds when the backup replace fails")
        snapshot = json.loads(body.decode("utf-8"))
        eq(snapshot["storage"]["degraded"], True, "failed backup scrub marks storage degraded")
        eq(snapshot["secrets"]["backup"]["hasKey"], False, "cleared key is gone from the live snapshot")
        clean_primary_bytes = secrets_file.read_bytes()
        eq(
            json.loads(clean_primary_bytes.decode("utf-8")).get("backup"),
            "",
            "primary secrets file is clean after clearing",
        )
        status, body, _ = request(port, "GET", "/api/config", token=token)
        snapshot = json.loads(body.decode("utf-8"))
        eq(status, 200, "config GET after the failed scrub still succeeds")
        eq(
            snapshot["storage"]["degraded"],
            True,
            "degraded stays sticky until the backup is resynchronized",
        )
        # 脏 .bak 存在时主文件损坏：禁止回退使用脏备份，已撤销的旧密钥绝不能复活
        secrets_file.write_text("{broken", encoding="utf-8")
        status, body, _ = request(port, "GET", "/api/config", token=token)
        snapshot = json.loads(body.decode("utf-8"))
        eq(status, 200, "corrupt primary with a dirty backup still serves")
        eq(
            snapshot["secrets"]["backup"]["hasKey"],
            False,
            "dirty backup is never used to resurrect the cleared key",
        )
        eq(
            snapshot["storage"]["degraded"],
            True,
            "dirty backup keeps degraded after a corrupt primary",
        )
        secrets_file.write_bytes(clean_primary_bytes)
    finally:
        if backup_handle is not None:
            backup_handle.close()
        if backup_replaced_with_dir:
            (temp_dir / "secrets.json.bak").rmdir()
            (temp_dir / "secrets.json.bak").write_bytes(stale_bak_bytes)
    status, body, _ = request(port, "GET", "/api/config", token=token)
    snapshot = json.loads(body.decode("utf-8"))
    eq(status, 200, "config GET after unlocking succeeds")
    eq(snapshot["storage"]["degraded"], False, "backup resync clears the sticky degraded flag")
    cleaned_bak = json.loads((temp_dir / "secrets.json.bak").read_text(encoding="utf-8"))
    eq(cleaned_bak.get("backup"), "", "unlocked backup is automatically scrubbed")
    ok(
        "sk-dirty-AAAA" not in json.dumps(cleaned_bak)
        and "sk-dirty-BBBB" not in json.dumps(cleaned_bak),
        "no revoked key survives in the backup after resync",
    )
    secrets_file.write_text("{broken-again", encoding="utf-8")
    status, body, _ = request(port, "GET", "/api/config", token=token)
    snapshot = json.loads(body.decode("utf-8"))
    eq(
        snapshot["storage"]["secrets"],
        "recovered",
        "corrupt primary after resync recovers from the cleaned backup",
    )
    eq(
        snapshot["secrets"]["backup"]["hasKey"],
        False,
        "recovery from the cleaned backup never revives the revoked key",
    )
    eq(list(temp_dir.glob("*.tmp")), [], "dirty backup handling leaves no temp files")

    print("\n== 旧明文迁移的 settings.bak 补清洗重试（P1-02） ==")
    legacy_dirty_settings = console.default_settings()
    legacy_dirty_settings["channels"]["primary"]["customHeaders"] = [
        {"name": "X-Bak-Migrate", "value": "legacy-bak-4321"}
    ]
    legacy_dirty_text = json.dumps(legacy_dirty_settings, ensure_ascii=False, indent=2)
    settings_file.write_text(legacy_dirty_text, encoding="utf-8")
    settings_bak_path = temp_dir / "settings.json.bak"
    settings_bak_path.write_text(legacy_dirty_text, encoding="utf-8")
    settings_bak_stale_bytes = settings_bak_path.read_bytes()
    settings_bak_handle = None
    settings_bak_replaced_with_dir = False
    try:
        if os.name == "nt":
            settings_bak_handle = open(settings_bak_path, "rb")
        else:
            settings_bak_path.unlink()
            settings_bak_path.mkdir()
            settings_bak_replaced_with_dir = True
        status, body, _ = request(port, "GET", "/api/config", token=token)
        snapshot = json.loads(body.decode("utf-8"))
        eq(status, 200, "legacy migration with a failing settings backup still serves")
        eq(
            snapshot["storage"]["degraded"],
            True,
            "failed settings backup cleanup marks storage degraded",
        )
        ok(
            "legacy-bak-4321" not in settings_file.read_text(encoding="utf-8"),
            "plaintext is erased from the clean primary settings file",
        )
        status, body, _ = request(port, "GET", "/api/config", token=token)
        snapshot = json.loads(body.decode("utf-8"))
        eq(
            snapshot["storage"]["degraded"],
            True,
            "settings degraded flag stays sticky while the backup is dirty",
        )
    finally:
        if settings_bak_handle is not None:
            settings_bak_handle.close()
        if settings_bak_replaced_with_dir:
            settings_bak_path.rmdir()
            settings_bak_path.write_bytes(settings_bak_stale_bytes)
    status, body, _ = request(port, "GET", "/api/config", token=token)
    snapshot = json.loads(body.decode("utf-8"))
    eq(snapshot["storage"]["degraded"], False, "settings backup resync clears degraded")
    ok(
        "legacy-bak-4321" not in settings_bak_path.read_text(encoding="utf-8"),
        "legacy plaintext is wiped from settings.json.bak after the automatic retry",
    )
    ok(
        "legacy-bak-4321" in secrets_file.read_text(encoding="utf-8"),
        "migrated header value is kept in secrets.json",
    )
    eq(list(temp_dir.glob("*.tmp")), [], "settings backup retry leaves no temp files")

    print("\n== .bak 待同步标记跨进程重启持久（P1-02） ==")
    reload_dir = Path(tempfile.mkdtemp(prefix="eac-storage-reload-"))
    clean_reload_secrets = console.empty_secrets()
    clean_reload_secrets["backup"] = ""
    dirty_reload_secrets = console.empty_secrets()
    dirty_reload_secrets["backup"] = "sk-reload-AAAA"
    reload_secrets_path = reload_dir / "secrets.json"
    reload_bak_path = reload_dir / "secrets.json.bak"
    reload_marker_path = reload_dir / "secrets.json.bak.dirty"
    reload_secrets_path.write_text(json.dumps(clean_reload_secrets), encoding="utf-8")
    reload_bak_path.write_text(json.dumps(dirty_reload_secrets), encoding="utf-8")
    # 模拟上一个进程在 .bak 替换失败后被杀：主文件干净、备份含旧密钥、sticky 标记在盘上
    reload_marker_path.write_text("1", encoding="utf-8")
    reload_handle = None
    reload_bak_replaced_with_dir = False
    try:
        if os.name == "nt":
            reload_handle = open(reload_bak_path, "rb")
        else:
            reload_bak_path.unlink()
            reload_bak_path.mkdir()
            reload_bak_replaced_with_dir = True
        restarted_store = console.ConfigStore(reload_dir)
        snapshot = restarted_store.snapshot()
        eq(
            snapshot["storage"]["degraded"],
            True,
            "a restarted process reloads the sticky backup marker",
        )
        reload_secrets_path.write_text("{broken", encoding="utf-8")
        snapshot = restarted_store.snapshot()
        eq(
            snapshot["secrets"]["backup"]["hasKey"],
            False,
            "a restarted process never recovers from a dirty backup",
        )
        eq(
            snapshot["storage"]["degraded"],
            True,
            "dirty backup keeps degraded after a restart",
        )
        reload_secrets_path.write_text(json.dumps(clean_reload_secrets), encoding="utf-8")
    finally:
        if reload_handle is not None:
            reload_handle.close()
        if reload_bak_replaced_with_dir:
            reload_bak_path.rmdir()
            reload_bak_path.write_text(json.dumps(dirty_reload_secrets), encoding="utf-8")
    snapshot = restarted_store.snapshot()
    eq(
        snapshot["storage"]["degraded"],
        False,
        "restart resync clears degraded once the backup can be replaced",
    )
    eq(
        reload_marker_path.is_file(),
        False,
        "sticky marker is removed after a successful backup resync",
    )
    cleaned_reload_bak = json.loads(reload_bak_path.read_text(encoding="utf-8"))
    eq(cleaned_reload_bak.get("backup"), "", "restart resync wipes the revoked key from the backup")
    eq(list(reload_dir.glob("*.tmp")), [], "restart resync leaves no temp files")

    print("\n== 旧明文迁移未落盘时拦截常规保存（P1-02） ==")
    migration_settings = console.default_settings()
    migration_settings["channels"]["primary"]["customHeaders"] = [
        {"name": "X-Pending", "value": "pending-secret-7788"}
    ]
    migration_text = json.dumps(migration_settings, ensure_ascii=False, indent=2)
    migration_settings_file = temp_dir / "settings.json"
    migration_settings_bak = temp_dir / "settings.json.bak"
    migration_settings_file.write_text(migration_text, encoding="utf-8")
    migration_settings_bak.write_text(migration_text, encoding="utf-8")
    migration_secrets_file = temp_dir / "secrets.json"
    migration_secrets_file.write_text("{}", encoding="utf-8")
    migration_secrets_bak = temp_dir / "secrets.json.bak"
    if migration_secrets_bak.exists():
        migration_secrets_bak.unlink()
    if os.name == "nt":
        os.chmod(migration_secrets_file, stat.S_IREAD)
    else:
        os.chmod(temp_dir, 0o500)
    try:
        status, body, _ = request(port, "GET", "/api/config", token=token)
        eq(status, 200, "a failed migration still serves a healthy snapshot")
        migration_snapshot = json.loads(body.decode("utf-8"))
        eq(
            migration_snapshot["storage"]["degraded"],
            True,
            "an unpersisted legacy migration keeps storage degraded",
        )
        target_settings = json.loads(migration_text)
        target_settings["ui"]["locale"] = "fr"
        status, body, _ = post_config(port, token, {"settings": target_settings})
        eq(status, 500, "ordinary save is rejected while the pending migration cannot be persisted")
        error_payload = json.loads(body.decode("utf-8"))
        eq(
            (error_payload.get("error") or {}).get("code"),
            "configPersistFailed",
            "rejected save returns a stable error code",
        )
        ok(
            "pending-secret-7788" in migration_settings_file.read_text(encoding="utf-8"),
            "settings plaintext is never erased by a save that failed before secrets.json",
        )
        eq(
            json.loads(migration_settings_file.read_text(encoding="utf-8"))["ui"]["locale"],
            "en",
            "the rejected save never rewrites settings.json",
        )
        eq(list(temp_dir.glob("*.tmp")), [], "the rejected migration save leaves no temp residue")
    finally:
        if os.name == "nt":
            os.chmod(migration_secrets_file, stat.S_IWRITE | stat.S_IREAD)
        else:
            os.chmod(temp_dir, 0o700)
    status, body, _ = post_config(port, token, {"settings": target_settings})
    eq(status, 200, "the same ordinary save succeeds once secrets.json is writable")
    migration_snapshot = json.loads(body.decode("utf-8"))
    eq(
        migration_snapshot["storage"]["degraded"],
        False,
        "pending migration state clears after both files were written",
    )
    ok(
        "pending-secret-7788" in migration_secrets_file.read_text(encoding="utf-8"),
        "the pending credential is eventually persisted in secrets.json",
    )
    ok(
        "pending-secret-7788" not in migration_settings_file.read_text(encoding="utf-8"),
        "plaintext is erased from settings.json only after the secrets write succeeded",
    )
    ok(
        "pending-secret-7788" not in migration_settings_bak.read_text(encoding="utf-8"),
        "plaintext is also erased from settings.json.bak after the successful save",
    )
    eq(list(temp_dir.glob("*.tmp")), [], "the completed pending migration leaves no temp files")

    print("\n== 远端文件指纹基于实际生效凭据（P1-07） ==")
    fingerprint_settings = console.default_settings()
    # 填一个并不存在的环境变量名：它没有生效，指纹必须跟随真正发出去的存储密钥
    fingerprint_settings["channels"]["primary"]["apiKeyEnv"] = "EAC_FINGERPRINT_UNSET"
    post_config(port, token, {"settings": fingerprint_settings})
    status, body, _ = post_config(port, token, {"keys": {"primary": "sk-fp-1111"}})
    fingerprint_snapshot = json.loads(body.decode("utf-8"))
    fingerprint_one = fingerprint_snapshot["secrets"]["primary"].get("keyFingerprint")
    eq(
        fingerprint_one,
        hashlib.sha256(b"sk-fp-1111").hexdigest()[:12],
        "key fingerprint is the sha256 prefix of the effective key",
    )
    ok(
        re.fullmatch(r"[0-9a-f]{12}", fingerprint_one or "") is not None,
        "key fingerprint exposes exactly 12 hex characters",
    )
    eq(
        fingerprint_snapshot["secrets"]["primary"].get("envSet"),
        False,
        "an unset environment variable name is reported as not effective",
    )
    ok(b"sk-fp-1111" not in body, "the fingerprint response never contains key plaintext")
    status, body, _ = post_config(port, token, {"keys": {"primary": "sk-fp-2222"}})
    fingerprint_snapshot = json.loads(body.decode("utf-8"))
    fingerprint_two = fingerprint_snapshot["secrets"]["primary"].get("keyFingerprint")
    ok(
        fingerprint_two != fingerprint_one,
        "rotating the stored key changes the fingerprint even with an unset env name configured",
    )
    eq(
        fingerprint_two,
        hashlib.sha256(b"sk-fp-2222").hexdigest()[:12],
        "the rotated key produces the matching fingerprint",
    )
    # 环境变量真正生效时优先于存储密钥：指纹必须跟随实际会发送的凭据
    fingerprint_settings["channels"]["primary"]["apiKeyEnv"] = "EAC_TEST_KEY"
    status, body, _ = post_config(port, token, {"settings": fingerprint_settings})
    fingerprint_snapshot = json.loads(body.decode("utf-8"))
    eq(
        fingerprint_snapshot["secrets"]["primary"].get("envSet"),
        True,
        "a configured and present environment variable is reported as effective",
    )
    eq(
        fingerprint_snapshot["secrets"]["primary"].get("keyFingerprint"),
        hashlib.sha256(b"env-secret-9999").hexdigest()[:12],
        "the fingerprint follows the effective environment key instead of the stored key",
    )
    ok(b"env-secret-9999" not in body, "the environment key is never echoed back")
    # 备份槽位独立计算指纹，绝不复用主槽位结果
    status, body, _ = post_config(port, token, {"keys": {"backup": "sk-fp-backup-3333"}})
    backup_snapshot = json.loads(body.decode("utf-8"))
    eq(
        backup_snapshot["secrets"]["backup"].get("keyFingerprint"),
        hashlib.sha256(b"sk-fp-backup-3333").hexdigest()[:12],
        "the backup slot gets its own effective-key fingerprint",
    )
    post_config(port, token, {"clearKeys": ["primary", "backup"]})
    restore_fingerprint_settings = console.default_settings()
    post_config(port, token, {"settings": restore_fingerprint_settings})

    print("\n== .bak 只允许在主文件字节完整替换后清脏（P1-01） ==")
    invariant_dir = Path(tempfile.mkdtemp(prefix="eac-bak-invariant-"))
    invariant_settings = console.default_settings()
    invariant_secrets = console.empty_secrets()
    invariant_secrets["primary"] = "sk-invariant-1111"
    invariant_secrets["backup"] = "sk-invariant-2222"
    (invariant_dir / "settings.json").write_text(
        json.dumps(invariant_settings, ensure_ascii=False), encoding="utf-8"
    )
    (invariant_dir / "secrets.json").write_text(
        json.dumps(invariant_secrets, ensure_ascii=False), encoding="utf-8"
    )
    # 主文件干净、.bak 缺失、sticky 标记仍为脏：只有真正写出与主文件逐字节一致的 .bak
    # 才允许清除标记；绝不允许“看起来没新删除”就提前撤销。
    (invariant_dir / "secrets.json.bak.dirty").write_text("1", encoding="utf-8")
    (invariant_dir / "settings.json.bak.dirty").write_text("1", encoding="utf-8")
    invariant_store = console.ConfigStore(invariant_dir)
    invariant_snapshot = invariant_store.update(keys={"primary": "sk-invariant-3333"})
    invariant_secrets_bak = invariant_dir / "secrets.json.bak"
    ok(
        invariant_secrets_bak.is_file()
        and invariant_secrets_bak.read_bytes() == (invariant_dir / "secrets.json").read_bytes(),
        "dirty secrets backup is replaced by the exact bytes of the current main file",
    )
    ok(
        not (invariant_dir / "secrets.json.bak.dirty").is_file(),
        "secret dirty marker clears only after the byte-exact replacement succeeded",
    )
    invariant_settings_bak = invariant_dir / "settings.json.bak"
    ok(
        invariant_settings_bak.is_file()
        and invariant_settings_bak.read_bytes() == (invariant_dir / "settings.json").read_bytes(),
        "dirty settings backup is replaced by the exact bytes of the current main file",
    )
    ok(
        not (invariant_dir / "settings.json.bak.dirty").is_file(),
        "settings dirty marker clears only after the byte-exact replacement succeeded",
    )
    eq(invariant_snapshot["storage"]["degraded"], False, "byte-exact resync clears degraded")
    eq(list(invariant_dir.glob("*.tmp")), [], "byte-exact resync leaves no temp files")

    # 真实服务进程：.bak 被占用时保存另一个槽位 / 无关设置，绝不能提前清掉脏标记
    post_config(port, token, {"keys": {"backup": "sk-sticky-AAAA"}})
    post_config(port, token, {"keys": {"backup": "sk-sticky-BBBB"}})
    live_settings_bak = temp_dir / "settings.json.bak"
    sticky_handle = None
    sticky_replaced_with_dir = False
    try:
        if os.name == "nt":
            sticky_handle = open(live_settings_bak, "rb")
        else:
            live_settings_bak.unlink()
            live_settings_bak.mkdir()
            sticky_replaced_with_dir = True
        status, body, _ = request(port, "GET", "/api/config", token=token)
        live_settings = json.loads(body.decode("utf-8"))["settings"]
        live_settings["ui"]["locale"] = "fr"
        status, body, _ = post_config(port, token, {"settings": live_settings})
        eq(status, 200, "settings save still succeeds when the settings backup replace fails")
        sticky_snapshot = json.loads(body.decode("utf-8"))
        eq(
            sticky_snapshot["storage"]["degraded"],
            True,
            "failed settings backup replacement keeps storage degraded",
        )
        ok(
            (temp_dir / "settings.json.bak.dirty").is_file(),
            "failed settings backup replacement persists the sticky marker",
        )
        status, body, _ = post_config(port, token, {"keys": {"primary": "sk-other-slot-1234"}})
        sticky_snapshot = json.loads(body.decode("utf-8"))
        eq(
            sticky_snapshot["storage"]["degraded"],
            True,
            "saving another slot never clears the sticky marker early",
        )
        ok(
            (temp_dir / "settings.json.bak.dirty").is_file(),
            "saving another slot keeps the settings dirty marker on disk",
        )
    finally:
        if sticky_handle is not None:
            sticky_handle.close()
        if sticky_replaced_with_dir:
            live_settings_bak.rmdir()
    status, body, _ = request(port, "GET", "/api/config", token=token)
    sticky_snapshot = json.loads(body.decode("utf-8"))
    eq(sticky_snapshot["storage"]["degraded"], False, "settings backup resync clears the sticky state")
    ok(
        not (temp_dir / "settings.json.bak.dirty").is_file(),
        "settings dirty marker is removed after the byte-exact resync",
    )
    ok(
        live_settings_bak.read_bytes() == (temp_dir / "settings.json").read_bytes(),
        "resynchronized settings backup mirrors the current main file byte-for-byte",
    )
    # 每次写 settings 都必须把当前主文件整体镜像到 .bak（旧实现只会留下上一版内容）
    live_settings["ui"]["locale"] = "en"
    status, _body, _ = post_config(port, token, {"settings": live_settings})
    eq(status, 200, "settings mirror probe save succeeds")
    ok(
        live_settings_bak.read_bytes() == (temp_dir / "settings.json").read_bytes(),
        "every settings write mirrors the current bytes into settings.json.bak",
    )
    eq(list(temp_dir.glob("*.tmp")), [], "backup invariant probes leave no temp files")

    print("\n== 流开始后的 SSE 错误事件（P1-06 边界） ==")
    partial_frame = b"data: " + b"c" * 22 + b"\n\n"

    def stalling_stream(handler, _record):
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Transfer-Encoding", "chunked")
        handler.end_headers()
        handler.wfile.write(b"%x\r\n" % len(partial_frame) + partial_frame + b"\r\n")
        handler.wfile.flush()
        # 首帧之后不再发送任何数据，让服务端读超时（通道 timeout 设为 5 秒）
        time.sleep(7)

    stall_mock = MockUpstreamServer(stalling_stream)
    stall_settings = console.default_settings()
    stall_settings["channels"]["primary"]["baseUrl"] = stall_mock.host
    stall_settings["channels"]["primary"]["requestTimeoutSec"] = 5
    post_config(port, token, {"settings": stall_settings})
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    connection.request(
        "POST",
        "/api/chat/stream",
        body=json.dumps({"slot": "primary", "payload": {"messages": []}}).encode("utf-8"),
        headers={"X-Console-Token": token, "Content-Type": "application/json"},
    )
    response = connection.getresponse()
    eq(response.status, 200, "stalled stream keeps the 200 SSE response status")
    stall_body = response.read()
    connection.close()
    stall_mock.stop()
    stall_text = stall_body.decode("utf-8", "replace")
    ok(stall_text.startswith(partial_frame.decode("utf-8")), "first SSE frame is forwarded", stall_text[:200])
    ok("event: error" in stall_text, "timed-out stream emits a standard SSE error event", stall_text[:400])
    ok('"code": "streamInterrupted"' in stall_text, "SSE error event carries a stable error code", stall_text[:400])
    ok("HTTP/1.0 500" not in stall_text and "HTTP/1.1 500" not in stall_text, "no naked HTTP 500 header is embedded in the stream body")
    ok("internal server error" not in stall_text, "no second JSON 500 error body is appended after the stream starts")
    restore_settings = console.default_settings()
    restore_settings["channels"]["primary"]["baseUrl"] = "http://127.0.0.1:9"
    post_config(port, token, {"settings": restore_settings})

    print("\n== 上游连接重置 / 半行超时的 SSE 错误帧（P2） ==")
    reset_frame = b'data: {"choices":[{"delta":{"content":"cut"}}]}\n\n'

    def upstream_reset_stream(handler, _record):
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Transfer-Encoding", "chunked")
        handler.end_headers()
        handler.wfile.write(b"%x\r\n" % len(reset_frame) + reset_frame + b"\r\n")
        handler.wfile.flush()
        time.sleep(0.2)
        # 发 TCP RST：上游读取端拿到 ConnectionResetError，而不是干净 EOF
        handler.connection.setsockopt(
            socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0)
        )
        handler.connection.close()
        handler.close_connection = True

    reset_mock = MockUpstreamServer(upstream_reset_stream)
    reset_settings = console.default_settings()
    reset_settings["channels"]["primary"]["baseUrl"] = reset_mock.host
    reset_settings["channels"]["primary"]["requestTimeoutSec"] = 5
    post_config(port, token, {"settings": reset_settings})
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    connection.request(
        "POST",
        "/api/chat/stream",
        body=json.dumps({"slot": "primary", "payload": {"messages": []}}).encode("utf-8"),
        headers={"X-Console-Token": token, "Content-Type": "application/json"},
    )
    response = connection.getresponse()
    eq(response.status, 200, "upstream reset keeps the 200 SSE response status")
    reset_body = response.read()
    connection.close()
    reset_mock.stop()
    reset_text = reset_body.decode("utf-8", "replace")
    ok(
        reset_text.startswith(reset_frame.decode("utf-8")),
        "first upstream frame is forwarded before the reset",
        reset_text[:200],
    )
    ok(
        "\n\nevent: error" in reset_text,
        "upstream TCP reset is reported as a standard SSE error event",
        reset_text[:400],
    )
    ok(
        '"code": "streamInterrupted"' in reset_text,
        "upstream reset error frame carries a stable error code",
        reset_text[:400],
    )
    ok(
        "HTTP/1.0 500" not in reset_text and "HTTP/1.1 500" not in reset_text,
        "upstream reset never leaks a second HTTP 500 header into the stream",
    )

    half_frame = b'data: {"choices":[{"delta":{"content":"half'

    def half_line_stream(handler, _record):
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Transfer-Encoding", "chunked")
        handler.end_headers()
        handler.wfile.write(b"%x\r\n" % len(half_frame) + half_frame + b"\r\n")
        handler.wfile.flush()
        # 上游停在半截未换行的数据后超时；错误帧必须先补空行再起 event 行
        time.sleep(7)

    half_mock = MockUpstreamServer(half_line_stream)
    half_settings = console.default_settings()
    half_settings["channels"]["primary"]["baseUrl"] = half_mock.host
    half_settings["channels"]["primary"]["requestTimeoutSec"] = 5
    post_config(port, token, {"settings": half_settings})
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    connection.request(
        "POST",
        "/api/chat/stream",
        body=json.dumps({"slot": "primary", "payload": {"messages": []}}).encode("utf-8"),
        headers={"X-Console-Token": token, "Content-Type": "application/json"},
    )
    response = connection.getresponse()
    eq(response.status, 200, "half-line timeout keeps the 200 SSE response status")
    half_body = response.read()
    connection.close()
    half_mock.stop()
    half_text = half_body.decode("utf-8", "replace")
    ok(
        half_text.startswith(half_frame.decode("utf-8")),
        "partial upstream line is forwarded byte-for-byte",
        half_text[:200],
    )
    ok(
        "\n\nevent: error" in half_text,
        "partial line is terminated before the error event starts",
        repr(half_text[:300]),
    )
    half_frames = half_text.split("\n\n")
    eq(
        half_frames[0],
        half_frame.decode("utf-8"),
        "partial data stays byte-identical before the padding newlines",
    )
    ok(
        len(half_frames) > 1 and half_frames[1].startswith("event: error"),
        "error event begins on a fresh line and is independently parseable",
        repr(half_frames[1][:120]) if len(half_frames) > 1 else "missing frame",
    )
    ok(
        "HTTP/1.0 500" not in half_text and "HTTP/1.1 500" not in half_text,
        "half-line timeout never embeds a second HTTP 500 header",
    )

    print("\n== 上游 Content-Length 提前断流（P2） ==")
    declared_partial = b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'

    def truncated_by_content_length(handler, _record):
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        # 声明的长度故意大于实际写出的字节：上游随后干净关闭连接
        handler.send_header("Content-Length", str(len(declared_partial) + 64))
        handler.end_headers()
        handler.wfile.write(declared_partial)
        handler.wfile.flush()
        handler.close_connection = True

    declared_mock = MockUpstreamServer(truncated_by_content_length)
    declared_settings = console.default_settings()
    declared_settings["channels"]["primary"]["baseUrl"] = declared_mock.host
    post_config(port, token, {"settings": declared_settings})
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    connection.request(
        "POST",
        "/api/chat/stream",
        body=json.dumps({"slot": "primary", "payload": {"messages": []}}).encode("utf-8"),
        headers={"X-Console-Token": token, "Content-Type": "application/json"},
    )
    response = connection.getresponse()
    eq(response.status, 200, "a short Content-Length body keeps the 200 SSE response status")
    declared_body = response.read()
    connection.close()
    declared_mock.stop()
    declared_text = declared_body.decode("utf-8", "replace")
    ok(
        declared_text.startswith(declared_partial.decode("utf-8")),
        "bytes received before the truncation are forwarded intact",
        declared_text[:200],
    )
    ok(
        "\n\nevent: error" in declared_text,
        "a truncated Content-Length body is reported as a standard SSE error event",
        declared_text[:400],
    )
    ok(
        '"error": "Upstream closed prematurely before Content-Length"' in declared_text,
        "the truncation frame carries the documented error message",
        declared_text[:400],
    )
    ok(
        "HTTP/1.0 500" not in declared_text and "HTTP/1.1 500" not in declared_text,
        "the truncation frame never embeds a second HTTP 500 header",
    )

    complete_frame = b'data: {"choices":[{"delta":{"content":"whole"}}]}\n\ndata: [DONE]\n\n'

    def complete_by_content_length(handler, _record):
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Content-Length", str(len(complete_frame)))
        handler.end_headers()
        handler.wfile.write(complete_frame)
        handler.wfile.flush()
        handler.close_connection = True

    complete_mock = MockUpstreamServer(complete_by_content_length)
    complete_settings = console.default_settings()
    complete_settings["channels"]["primary"]["baseUrl"] = complete_mock.host
    post_config(port, token, {"settings": complete_settings})
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    connection.request(
        "POST",
        "/api/chat/stream",
        body=json.dumps({"slot": "primary", "payload": {"messages": []}}).encode("utf-8"),
        headers={"X-Console-Token": token, "Content-Type": "application/json"},
    )
    response = connection.getresponse()
    complete_body = response.read()
    connection.close()
    complete_mock.stop()
    complete_text = complete_body.decode("utf-8", "replace")
    ok(
        complete_text.startswith(complete_frame.decode("utf-8")),
        "a complete Content-Length body is forwarded byte-for-byte",
    )
    ok(
        "closed prematurely" not in complete_text,
        "a complete Content-Length stream never emits a false truncation frame",
    )

    print("\n== 端口自愈 ==")
    second_dir = Path(tempfile.mkdtemp(prefix="eac-server-second-"))
    second = ServerProcess(second_dir, port)
    try:
        ok(second.port != port, "port auto-heals when preferred port is occupied",
           "%d -> %d" % (port, second.port))
        ok(port < second.port <= port + 30, "healed port inside documented range")
    finally:
        second.stop()

    print("\n== 单实例检测 ==")
    if not port_is_free(console.DEFAULT_PORT):
        if console.probe_running_instance(console.DEFAULT_PORT):
            # 默认端口上已经躺着本程序实例（例如上一个会话遗留）：直接验证第二个启动器
            instance_b = ServerProcess(Path(tempfile.mkdtemp(prefix="eac-instance-b-")), None)
            instance_b.process.wait(timeout=20)
            eq(instance_b.process.returncode, 0, "second launcher exits with status 0")
            output = " ".join(instance_b.output_lines)
            ok(
                "already running" in output.lower(),
                "second launcher reports the running instance",
                output[:300],
            )
        else:
            print(
                "skip - %d 已被无关进程占用，无法验证本机单实例检测"
                % console.DEFAULT_PORT
            )
            ok(True, "single-instance detection skipped because the default port is busy")
    else:
        instance_a = ServerProcess(
            Path(tempfile.mkdtemp(prefix="eac-instance-a-")), console.DEFAULT_PORT
        )
        try:
            eq(instance_a.port, console.DEFAULT_PORT, "explicit --port binds the requested port")
            instance_b = ServerProcess(
                Path(tempfile.mkdtemp(prefix="eac-instance-b-")), None
            )
            instance_b.process.wait(timeout=20)
            eq(instance_b.process.returncode, 0, "second launcher exits with status 0")
            output = " ".join(instance_b.output_lines)
            ok("already running" in output.lower(),
               "second launcher reports the running instance", output[:300])
            ok(str(console.DEFAULT_PORT) in output,
               "second launcher points at the existing port", output[:300])
        finally:
            instance_a.stop()

    if port_is_free(console.DEFAULT_PORT):
        blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            blocker.bind(("127.0.0.1", console.DEFAULT_PORT))
            blocker.listen(8)
            fallback = ServerProcess(
                Path(tempfile.mkdtemp(prefix="eac-instance-fallback-")), None
            )
            try:
                ok(
                    console.DEFAULT_PORT + 1 <= fallback.port
                    <= console.DEFAULT_PORT + console.PORT_SCAN_SPAN - 1,
                    "a foreign listener pushes the service into the documented fallback range",
                    "port=%d" % fallback.port,
                )
            finally:
                fallback.stop()
        finally:
            blocker.close()

    # 默认端口被占用时也要覆盖识别与顺延逻辑本身：换一个空闲基准端口直接验证内部路径
    probe_base = free_port()
    saved_default_port = console.DEFAULT_PORT
    probe_dir = Path(tempfile.mkdtemp(prefix="eac-instance-probe-"))
    try:
        console.DEFAULT_PORT = probe_base
        probe_instance = ServerProcess(
            Path(tempfile.mkdtemp(prefix="eac-instance-p-")), probe_base
        )
        try:
            ok(
                console.probe_running_instance(probe_base),
                "health probe identifies the running instance",
            )
            ok(
                console._start_on_default_port(probe_dir) is None,
                "default-port start reuses a running instance",
            )
        finally:
            probe_instance.stop()
        probe_blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe_blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe_blocker.bind(("127.0.0.1", probe_base))
            probe_blocker.listen(8)
            fallback_server = console._start_on_default_port(probe_dir)
            try:
                ok(
                    probe_base + 1 <= fallback_server.server_port
                    <= probe_base + console.PORT_SCAN_SPAN - 1,
                    "foreign listener fallback stays inside the documented span",
                    "port=%d" % fallback_server.server_port,
                )
            finally:
                fallback_server.server_close()
        finally:
            probe_blocker.close()
    finally:
        console.DEFAULT_PORT = saved_default_port

    print("\n== 全端口段单实例探活（默认端口被无关 Socket 占用） ==")
    scan_base = None
    for _ in range(200):
        candidate = free_port()
        if candidate + 2 > 65535:
            continue
        if all(port_is_free(candidate + offset) for offset in (0, 1)):
            scan_base = candidate
            break
    if scan_base is None:
        ok(True, "range-scan test skipped because no contiguous free ports were found")
    else:
        foreign_listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            foreign_listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            foreign_listener.bind(("127.0.0.1", scan_base))
            foreign_listener.listen(8)
            reused_instance = ServerProcess(
                Path(tempfile.mkdtemp(prefix="eac-scan-instance-")), scan_base + 1
            )
            try:
                live_port = reused_instance.port
                ok(
                    scan_base < live_port <= scan_base + console.PORT_SCAN_SPAN,
                    "explicit-port instance landed inside the scan range",
                    "port=%d" % live_port,
                )
                eq(
                    console.find_running_instance(scan_base, console.PORT_SCAN_SPAN),
                    live_port,
                    "range scan skips the foreign listener and finds the real console instance",
                )
                saved_default_port = console.DEFAULT_PORT
                console.DEFAULT_PORT = scan_base
                console.DETECTED_INSTANCE_PORT = None
                try:
                    scan_result = console._start_on_default_port(
                        Path(tempfile.mkdtemp(prefix="eac-scan-launcher-"))
                    )
                    ok(
                        scan_result is None,
                        "default-port start reuses an instance found later in the range",
                    )
                    eq(
                        console.DETECTED_INSTANCE_PORT,
                        live_port,
                        "detected instance port is the live port, not the blocked default port",
                    )
                finally:
                    console.DEFAULT_PORT = saved_default_port
                    console.DETECTED_INSTANCE_PORT = None
            finally:
                reused_instance.stop()
        finally:
            foreign_listener.close()

    # 真实默认端口段：18765 被无关 Socket 占用、实例跑在 18766 时，第二次默认启动仍复用 18766
    if (
        port_is_free(console.DEFAULT_PORT)
        and port_is_free(console.DEFAULT_PORT + 1)
        and not (console.DEFAULT_PORT <= port <= console.DEFAULT_PORT + console.PORT_SCAN_SPAN)
        and console.find_running_instance(
            console.DEFAULT_PORT, console.PORT_SCAN_SPAN
        )
        is None
    ):
        default_blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            default_blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            default_blocker.bind(("127.0.0.1", console.DEFAULT_PORT))
            default_blocker.listen(8)
            reused = ServerProcess(
                Path(tempfile.mkdtemp(prefix="eac-default-reused-")),
                console.DEFAULT_PORT + 1,
            )
            try:
                launcher = ServerProcess(
                    Path(tempfile.mkdtemp(prefix="eac-default-launcher-")), None
                )
                launcher.process.wait(timeout=20)
                eq(launcher.process.returncode, 0, "second default launch exits with status 0")
                output = " ".join(launcher.output_lines)
                ok(
                    str(reused.port) in output,
                    "second default launch reuses the live instance port instead of the blocked default",
                    output[:400],
                )
                ok(
                    "already running" in output.lower(),
                    "second default launch reports the reused instance",
                    output[:400],
                )
            finally:
                reused.stop()
        finally:
            default_blocker.close()
    else:
        ok(
            True,
            "real 18765/18766 reuse test skipped because the default port range is not free",
        )

    server.stop()

    print("\n== 数据目录隔离 ==")
    ok((ROOT / "server.py").is_file(), "server.py present")

    print("\n== 四语 README 出站说明、致谢与第三方许可证索引（P2-06 / P3 / P1-4） ==")
    affiliation_markers = {
        "README.md": "Non-Affiliation",
        "README_ZH.md": "非官方",
        "README_FR.md": "non-affiliation",
        "README_RU.md": "аффилированности",
    }
    for readme_name in ("README.md", "README_ZH.md", "README_FR.md", "README_RU.md"):
        readme_path = ROOT / readme_name
        ok(readme_path.is_file(), "%s is present" % readme_name)
        try:
            readme_text = readme_path.read_text(encoding="utf-8")
        except OSError:
            readme_text = ""
        ok(
            "20.19" in readme_text and "22.12" in readme_text,
            "%s documents the Rspack Node.js requirement" % readme_name,
        )
        ok(
            "enableRemoteFileApi" in readme_text,
            "%s documents the opt-in remote file API outbound request" % readme_name,
        )
        ok(
            "deepseek-ai/chat-demo" in readme_text,
            "%s acknowledges the upstream chat-demo project" % readme_name,
        )
        ok(
            affiliation_markers[readme_name] in readme_text,
            "%s states the non-affiliation disclaimer" % readme_name,
        )
    license_bundle_path = ROOT / "dist" / "THIRD_PARTY_LICENSES.txt"
    ok(license_bundle_path.is_file(), "built third-party license bundle is present")
    try:
        license_bundle = license_bundle_path.read_text(encoding="utf-8")
    except OSError:
        license_bundle = ""
    ok("mhchem" in license_bundle, "license bundle indexes the bundled mhchem extension")
    ok("Martin Hensel" in license_bundle, "license bundle reproduces the mhchem copyright line")
    ok("MathJax Consortium" in license_bundle, "license bundle reproduces the MathJax copyright line")
    ok(
        "SIL Open Font License 1.1" in license_bundle,
        "license bundle indexes the KaTeX fonts under the SIL Open Font License 1.1",
    )
    ok("Thenable" in license_bundle, "license bundle indexes the embedded Thenable implementation")
    ok(
        "Ralf S. Engelschall" in license_bundle,
        "license bundle reproduces the bundled Thenable copyright line",
    )
    ok(
        "Embedded-notice scan" in license_bundle,
        "license bundle records the automated embedded-notice scan",
    )
    ok(
        "Uncovered embedded notices found:" in license_bundle,
        "license bundle reports the automated scan result",
    )
    ok(
        not re.search(r"[A-Za-z]:[\\/](?:Users|Work)[\\/]", license_bundle),
        "license bundle contains no local absolute filesystem paths",
    )

    print("\n== 第三方许可证子包条目自洽性（P3-1） ==")
    section_bar = "=" * 78
    bundle_lines = license_bundle.splitlines()
    license_sections = {}
    line_index = 0
    while line_index + 2 < len(bundle_lines):
        if bundle_lines[line_index] == section_bar and bundle_lines[line_index + 2] == section_bar:
            title = bundle_lines[line_index + 1].strip()
            body_start = line_index + 3
            next_index = body_start
            while next_index < len(bundle_lines):
                if (
                    bundle_lines[next_index] == section_bar
                    and next_index + 2 < len(bundle_lines)
                    and bundle_lines[next_index + 2] == section_bar
                ):
                    break
                next_index += 1
            license_sections[title] = "\n".join(bundle_lines[body_start:next_index])
            line_index = next_index
        else:
            line_index += 1
    package_sections = {
        title: body
        for title, body in license_sections.items()
        if re.fullmatch(r"[^\s=()]+ \d+\.\d+\.\d+", title)
    }
    eq(
        len(package_sections),
        212,
        "license bundle carries one self-contained section per runtime package",
    )
    bare_sections = sorted(
        title
        for title, body in package_sections.items()
        if "File:" not in body
        and "Permission is hereby granted" not in body
        and "Copyright" not in body
        and "©" not in body
    )
    eq(
        bare_sections,
        [],
        "every package entry carries license text or a copyright holder, with no bare "
        "'License declared in package.json' shell entries",
    )
    micromark_chunked = package_sections.get("micromark-util-chunked 2.0.0", "")
    ok(
        "Titus Wormer" in micromark_chunked,
        "micromark-util-chunked entry names its copyright holder extracted from the README",
    )
    ok(
        "Permission is hereby granted" in micromark_chunked,
        "micromark-util-chunked entry embeds the standard MIT license text",
    )
    micromark_factory = package_sections.get("micromark-factory-destination 2.0.0", "")
    ok(
        "Titus Wormer" in micromark_factory and "Permission is hereby granted" in micromark_factory,
        "micromark-factory-destination entry is self-contained as well",
    )

    print("\n== 四语 README 两阶段附件流向与 Fetch models 出站说明（P1-3） ==")
    attachment_phase_markers = {
        "README.md": ("before you press send", "Pressing send"),
        "README_ZH.md": ("点击发送之前", "点击发送"),
        "README_FR.md": ("avant l'envoi", "Envoi du message"),
        "README_RU.md": ("до нажатия", "Нажатие «Отправить»"),
    }
    for readme_name, (draft_marker, send_marker) in attachment_phase_markers.items():
        try:
            phase_text = (ROOT / readme_name).read_text(encoding="utf-8")
        except OSError:
            phase_text = ""
        ok(
            draft_marker in phase_text,
            "%s documents the no-network pre-send attachment stage" % readme_name,
        )
        ok(
            send_marker in phase_text,
            "%s documents the send-stage attachment flow" % readme_name,
        )
        ok(
            "Fetch models" in phase_text,
            "%s lists the Fetch models probe next to Test connection" % readme_name,
        )
        ok(
            "GET .../models" in phase_text,
            "%s spells out the GET .../models outbound request" % readme_name,
        )
        ok(
            "<attached_file>" in phase_text,
            "%s documents the attached_file wrapper used when sending" % readme_name,
        )

    print("\n== 四语 README 出站补充：OPTIONS 预检与 Exa 30 秒独立超时（P3-1） ==")
    outbound_detail_markers = {
        "README.md": "30-second",
        "README_ZH.md": "30 秒",
        "README_FR.md": "30 secondes",
        "README_RU.md": "30 секунд",
    }
    for readme_name, exa_timeout_marker in outbound_detail_markers.items():
        try:
            detail_text = (ROOT / readme_name).read_text(encoding="utf-8")
        except OSError:
            detail_text = ""
        ok(
            "OPTIONS" in detail_text,
            "%s documents the credential-free OPTIONS preflight request" % readme_name,
        )
        ok(
            "CORS" in detail_text,
            "%s ties the preflight request to the standard CORS rules" % readme_name,
        )
        ok(
            "/api/search/exa" in detail_text,
            "%s names the Exa search endpoint for the independent timeout" % readme_name,
        )
        ok(
            exa_timeout_marker in detail_text,
            "%s documents Exa's independent bounded 30-second timeout" % readme_name,
        )

    print("\n== 四语 README：云端主控与本地 Agent 的挂载边界说明（P1-1） ==")
    scope_markers = {
        "README.md": (
            "mounts neither your local project directory",
            "real compiler and test toolchain",
        ),
        "README_ZH.md": (
            "不挂载你的本地工程目录与终端",
            "真实的编译与测试工具链",
        ),
        "README_FR.md": (
            "ne monte ni votre répertoire de projet",
            "vraie chaîne de compilation et de test",
        ),
        "README_RU.md": (
            "не подключает ни каталог вашего проекта",
            "настоящую цепочку компиляции и тестов",
        ),
    }
    for readme_name, (cloud_marker, local_marker) in scope_markers.items():
        try:
            scope_text = (ROOT / readme_name).read_text(encoding="utf-8")
        except OSError:
            scope_text = ""
        ok(
            cloud_marker in scope_text,
            "%s explains why Agent 1 is the cloud / pure-dialogue role" % readme_name,
        )
        ok(
            local_marker in scope_text,
            "%s states that Agents 2 and 3 mount the project folder and local toolchain"
            % readme_name,
        )

    print("\n== 第三方许可证：Cure53 / KaTeX SVG 字形署名（P1-4） ==")
    for marker, label in (
        ("Cure53", "the DOMPurify Cure53 attribution"),
        ("Mario Heiderich", "the DOMPurify upstream copyright holder"),
        ("MPL-2.0 OR Apache-2.0", "the DOMPurify dual-license declaration"),
        ("Design Science", "the KaTeX SVG glyph MathJax / Design Science attribution"),
        ("Copyright (c) 2014-2017 Khan Academy", "the KaTeX SVG glyph Khan Academy attribution"),
    ):
        ok(marker in license_bundle, "license bundle reproduces %s" % label)
    ok(
        "KaTeX SVG glyph geometry" in license_bundle,
        "license bundle indexes the KaTeX SVG glyph geometry notice",
    )
    ok(
        "DOMPurify upstream attribution" in license_bundle,
        "license bundle indexes the DOMPurify upstream attribution section",
    )
    ok(
        "regenerator-runtime" in license_bundle,
        "license bundle keeps the embedded regenerator-runtime Facebook notice",
    )

    print("\n== 第三方许可证：内嵌算法/事件来源索引与 KaTeX 字体元数据（P1-4） ==")
    for marker, label in (
        (
            "Embedded algorithm and event code source index",
            "the embedded algorithm / event code source index",
        ),
        ("src/util/SVD.js", "the layout-base SVD routine provenance path"),
        ("dragonfly-ai/JamaJS", "the JamaJS upstream source link"),
        ("NIST JAMA public-domain", "the JamaJS / NIST public-domain provenance"),
        ("src/event.mjs", "the cytoscape event object provenance path"),
        (
            "OpenJS Foundation and distributed under the MIT license",
            "the jQuery / OpenJS Foundation MIT attribution",
        ),
        (
            "katex/dist/fonts/KaTeX_Main-Regular.ttf",
            "the KaTeX font file that carries the metadata copyright",
        ),
        (
            "Copyright (c) 2014-2018 Khan Academy",
            "the KaTeX font metadata copyright line",
        ),
        (
            "Copyright (c) 2014-2017 Khan Academy",
            "the separate KaTeX SVG glyph copyright line",
        ),
    ):
        ok(marker in license_bundle, "license bundle reproduces %s" % label)
    ok(
        "SIL Open Font License 1.1" in license_bundle
        and "font metadata" in license_bundle,
        "license bundle distinguishes the font metadata record from the glyph path data",
    )

    print("\n== 预打包上游子包许可证与 .map 来源审计（P1-3） ==")
    for marker, label in (
        ("Pre-bundled upstream package scan", "the source-map pre-bundled package scan section"),
        ("path-browserify 1.0.1 (pre-bundled upstream package)", "the path-browserify entry"),
        ("Copyright (c) 2013 James Halliday", "the path-browserify copyright line"),
        ("js-yaml 4.1.0 (pre-bundled upstream package)", "the js-yaml entry"),
        ("Copyright (C) 2011-2015 by Vitaly Puzrin", "the js-yaml copyright line"),
        (
            "Uncovered pre-bundled upstream packages: 0.",
            "the zero-omission pre-bundled package audit result",
        ),
    ):
        ok(marker in license_bundle, "license bundle reproduces %s" % label)
    prebundled_references = scan_prebundled_map_sources(ROOT)
    eq(
        sorted(prebundled_references),
        ["js-yaml", "path-browserify"],
        "the runtime dependency source maps reference exactly the audited pre-bundled packages",
    )
    missing_prebundled = sorted(
        name for name in prebundled_references if name not in license_bundle
    )
    eq(
        missing_prebundled,
        [],
        "every pre-bundled sub-package referenced by source maps is covered by the license bundle",
    )

    print("\n== --auto-exit：心跳 / 关页 / 刷新缓冲闭环 ==")
    lifecycle_dir = Path(tempfile.mkdtemp(prefix="eac-lifecycle-"))
    lifecycle_port = free_port()
    lifecycle = AutoExitServer(lifecycle_dir, lifecycle_port)
    try:
        status, _body, _ = request(
            lifecycle_port,
            "POST",
            "/api/lifecycle",
            body={"action": "heartbeat", "tabId": "tab-1"},
        )
        eq(status, 403, "lifecycle requires the console token")
        status, _body, _ = request(
            lifecycle_port,
            "POST",
            "/api/lifecycle",
            token=lifecycle.token,
            origin="http://evil.example",
            body={"action": "heartbeat", "tabId": "tab-1"},
        )
        eq(status, 403, "lifecycle rejects a foreign Origin")
        status, _body, _ = request(
            lifecycle_port,
            "POST",
            "/api/lifecycle",
            token=lifecycle.token,
            body={"action": "bogus", "tabId": "tab-1"},
        )
        eq(status, 400, "lifecycle rejects an unknown action")
        status, body, _ = request(
            lifecycle_port,
            "POST",
            "/api/lifecycle",
            token=lifecycle.token,
            body={"action": "heartbeat", "tabId": "tab-1"},
        )
        lifecycle_payload = json.loads(body.decode("utf-8"))
        eq(status, 200, "the auto-exit service accepts a tab heartbeat")
        eq(lifecycle_payload.get("activeTabs"), 1, "the active tab is tracked")
        # ① 关闭唯一标签页：约 5 秒刷新缓冲后进程以 0 干净退出
        leave_at = time.monotonic()
        status, body, _ = request(
            lifecycle_port,
            "POST",
            "/api/lifecycle",
            token=lifecycle.token,
            body={"action": "leave", "tabId": "tab-1"},
        )
        lifecycle_payload = json.loads(body.decode("utf-8"))
        eq(status, 200, "the leave event is accepted")
        eq(lifecycle_payload.get("activeTabs"), 0, "closing the last tab empties the active table")
        lifecycle_exit = lifecycle.wait_exit(timeout=20)
        lifecycle_elapsed = time.monotonic() - leave_at
        eq(lifecycle_exit, 0, "the auto-exit service exits with status 0 after the last tab leaves")
        ok(
            3.5 <= lifecycle_elapsed <= 12.0,
            "auto exit honours the documented refresh buffer before stopping",
            "%.2fs" % lifecycle_elapsed,
        )
        ok(
            not console.probe_running_instance(lifecycle_port),
            "the port is released after the automatic exit",
        )
    finally:
        lifecycle.stop()

    print("\n== --auto-exit：F5 刷新（缓冲期内新 tabId 心跳）不误杀 ==")
    refresh_dir = Path(tempfile.mkdtemp(prefix="eac-lifecycle-refresh-"))
    refresh_port = free_port()
    refresh = AutoExitServer(refresh_dir, refresh_port)
    try:
        request(
            refresh_port,
            "POST",
            "/api/lifecycle",
            token=refresh.token,
            body={"action": "heartbeat", "tabId": "old-tab"},
        )
        request(
            refresh_port,
            "POST",
            "/api/lifecycle",
            token=refresh.token,
            body={"action": "leave", "tabId": "old-tab"},
        )
        time.sleep(1.0)
        status, _body, _ = request(
            refresh_port,
            "POST",
            "/api/lifecycle",
            token=refresh.token,
            body={"action": "heartbeat", "tabId": "refreshed-tab"},
        )
        eq(status, 200, "the refreshed page can register a new tabId inside the buffer")
        time.sleep(6.5)
        ok(
            console.probe_running_instance(refresh_port),
            "a refresh heartbeat inside the buffer cancels the shutdown past the leave deadline",
        )
        status, _body, _ = request(refresh_port, "GET", "/api/config", token=refresh.token)
        eq(status, 200, "the refreshed service still answers /api/config normally")
        request(
            refresh_port,
            "POST",
            "/api/lifecycle",
            token=refresh.token,
            body={"action": "leave", "tabId": "refreshed-tab"},
        )
        eq(
            refresh.wait_exit(timeout=20),
            0,
            "closing the refreshed tab stops the service cleanly",
        )
    finally:
        refresh.stop()

    print("\n== 真实 dist 生产入口：无头浏览器首包心跳与关页自动退出（P1 回归） ==")
    browser_executable = find_headless_browser()
    ok(
        browser_executable is not None,
        "a headless Edge/Chromium is available for the production-entry lifecycle check",
    )
    if browser_executable is not None:
        entry_dir = Path(tempfile.mkdtemp(prefix="eac-entry-lifecycle-"))
        entry_port = free_port()
        entry = AutoExitServer(entry_dir, entry_port)
        entry_browser = HeadlessBrowser(browser_executable)
        try:
            ok(entry_browser.wait_ready(), "the headless browser exposes its DevTools endpoint")
            started_at = time.monotonic()
            target_id = entry_browser.open_tab(entry.url + "/")
            ok(
                target_id is not None,
                "the browser opens the real built page at the served root without injected JS",
            )
            first_tab_at = None
            active_tabs = 0
            deadline = started_at + 3.0
            while time.monotonic() < deadline:
                status, body, _ = request(entry_port, "GET", "/api/health")
                if status == 200:
                    try:
                        health = json.loads(body.decode("utf-8"))
                    except ValueError:
                        health = {}
                    active_tabs = health.get("activeTabs", 0)
                    if active_tabs >= 1:
                        first_tab_at = time.monotonic()
                        break
                time.sleep(0.1)
            ok(
                first_tab_at is not None and active_tabs >= 1,
                "/api/health reports activeTabs >= 1 within 3 s of the real page loading",
                "activeTabs=%r after %.2fs"
                % (active_tabs, (first_tab_at or time.monotonic()) - started_at),
            )
            if first_tab_at is not None:
                ok(
                    first_tab_at - started_at <= 3.0,
                    "the production page emitted its first lifecycle heartbeat within 3 s",
                    "%.2fs" % (first_tab_at - started_at),
                )
            status, body, _ = request(entry_port, "GET", "/api/health")
            health = json.loads(body.decode("utf-8")) if status == 200 else {}
            eq(status, 200, "the production-entry service still answers /api/health")
            eq(health.get("autoExit"), True, "the production-entry service runs with auto exit")
            if target_id is not None:
                ok(
                    entry_browser.close_tab(target_id),
                    "the headless browser closes the real production page",
                )
                close_at = time.monotonic()
                exit_code = entry.wait_exit(timeout=20)
                elapsed = time.monotonic() - close_at
                eq(
                    exit_code,
                    0,
                    "the auto-exit service exits cleanly after the real page closes",
                )
                ok(
                    4.5 <= elapsed <= 9.5,
                    "auto exit honours the refresh buffer after a real page close",
                    "%.2fs" % elapsed,
                )
        finally:
            entry_browser.stop()
            entry.stop()

    print("\n== LifecycleMonitor 单元行为（加速时钟） ==")

    class FakeHttpd:
        def __init__(self):
            self.shutdown_called = 0
            self.closed = threading.Event()

        def shutdown(self):
            self.shutdown_called += 1
            self.closed.set()

    grace_httpd = FakeHttpd()
    grace_monitor = console.LifecycleMonitor(
        grace_httpd, startup_grace=0.2, refresh_buffer=0.1, silent_timeout=5.0, tick=0.02
    )
    grace_monitor.start()
    ok(
        grace_httpd.closed.wait(3.0),
        "a service that never receives a tab heartbeat stops after the startup grace",
    )
    grace_monitor.stop()
    eq(grace_httpd.shutdown_called, 1, "the startup grace calls httpd.shutdown exactly once")

    buffer_httpd = FakeHttpd()
    buffer_monitor = console.LifecycleMonitor(
        buffer_httpd, startup_grace=30, refresh_buffer=0.3, silent_timeout=5.0, tick=0.02
    )
    buffer_monitor.start()
    buffer_monitor.heartbeat("old")
    buffer_monitor.leave("old")
    time.sleep(0.1)
    buffer_monitor.heartbeat("new")
    time.sleep(0.6)
    eq(
        buffer_httpd.shutdown_called,
        0,
        "a heartbeat inside the refresh buffer cancels the shutdown",
    )
    buffer_monitor.leave("new")
    ok(buffer_httpd.closed.wait(3.0), "the monitor stops the service once the buffer expires")
    buffer_monitor.stop()

    inflight_httpd = FakeHttpd()
    inflight_monitor = console.LifecycleMonitor(
        inflight_httpd, startup_grace=30, refresh_buffer=0.1, silent_timeout=5.0, tick=0.02
    )
    inflight_monitor.start()
    inflight_monitor.heartbeat("tab")
    inflight_monitor.leave("tab")
    inflight_monitor.begin_request()
    time.sleep(0.5)
    eq(
        inflight_httpd.shutdown_called,
        0,
        "an in-flight /api/chat or /api/config request holds the service open",
    )
    inflight_monitor.end_request()
    ok(
        inflight_httpd.closed.wait(3.0),
        "the service stops once the last in-flight request finishes",
    )
    inflight_monitor.stop()

    silent_httpd = FakeHttpd()
    silent_monitor = console.LifecycleMonitor(
        silent_httpd, startup_grace=30, refresh_buffer=0.1, silent_timeout=0.3, tick=0.02
    )
    silent_monitor.start()
    silent_monitor.heartbeat("crashed-browser")
    ok(
        silent_httpd.closed.wait(3.0),
        "a silent tab (browser crash without leave) is reclaimed after the silent timeout",
    )
    silent_monitor.stop()

    print("\n== pythonw 无控制台容忍：sys.stdout / sys.stderr 为 None ==")
    saved_streams = (sys.stdout, sys.stderr)
    sys.stdout = None
    sys.stderr = None
    quiet_server = None
    try:
        console.ensure_console_streams()
        sys.stdout.write("pythonw selftest\n")
        sys.stdout.flush()
        console.write_stderr_safely("pythonw selftest\n")
        quiet_dir = Path(tempfile.mkdtemp(prefix="eac-pythonw-streams-"))
        quiet_server = console.ConsoleServer(("127.0.0.1", 0), quiet_dir)
        quiet_thread = threading.Thread(target=quiet_server.serve_forever, daemon=True)
        quiet_thread.start()
        quiet_port = quiet_server.server_port
        quiet_token = fetch_session_token(quiet_port)
        # 没有控制台时，线程异常的兜底日志也不能反过来把请求线程炸掉
        quiet_server.handle_error(None, None)
        status, _body, _ = request(quiet_port, "GET", "/api/config", token=quiet_token)
        eq(status, 200, "a request is served while stdout/stderr point at os.devnull")
        status, _body, _ = post_config(
            quiet_port, quiet_token, {"keys": {"primary": "sk-pythonw-1234"}}
        )
        eq(status, 200, "a config write is served without any console stream")
    finally:
        if quiet_server is not None:
            quiet_server.shutdown()
            quiet_server.server_close()
        sys.stdout, sys.stderr = saved_streams
    ok(True, "the server survives pythonw-style missing standard streams")

    print("\n== pythonw.exe 真实无控制台启动 ==")
    pythonw_path = Path(sys.executable).with_name("pythonw.exe")
    if os.name == "nt" and pythonw_path.is_file():
        pythonw_dir = Path(tempfile.mkdtemp(prefix="eac-pythonw-real-"))
        pythonw_port = free_port()
        pythonw_process = subprocess.Popen(
            [
                str(pythonw_path),
                str(SERVER_PATH),
                "--port",
                str(pythonw_port),
                "--no-browser",
                "--data-dir",
                str(pythonw_dir),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            pythonw_deadline = time.time() + 20
            pythonw_ready = False
            while time.time() < pythonw_deadline:
                if console.probe_running_instance(pythonw_port):
                    pythonw_ready = True
                    break
                if pythonw_process.poll() is not None:
                    break
                time.sleep(0.05)
            ok(pythonw_ready, "pythonw.exe runs the service without a console window")
            ok(
                console.probe_running_instance(pythonw_port),
                "the pythonw-hosted service answers /api/health",
            )
        finally:
            pythonw_process.terminate()
            try:
                pythonw_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pythonw_process.kill()
                pythonw_process.wait(timeout=5)
    else:
        ok(True, "pythonw.exe is not available on this platform (skipped)")

    print("\n== --foreground：带参数启动的前台常驻契约 ==")
    foreground_args = console.parse_args(["--foreground", "--no-browser", "--auto-exit"])
    ok(bool(getattr(foreground_args, "foreground", False)), "parse_args registers --foreground")
    ok(foreground_args.auto_exit, "parse_args still records --auto-exit independently")
    foreground_dir = Path(tempfile.mkdtemp(prefix="eac-foreground-"))
    foreground_port = free_port()
    foreground_env = dict(os.environ)
    foreground_env["PYTHONIOENCODING"] = "utf-8"
    foreground_env["PYTHONUTF8"] = "1"
    foreground_process = subprocess.Popen(
        [
            sys.executable,
            str(SERVER_PATH),
            "--foreground",
            "--auto-exit",
            "--no-browser",
            "--port",
            str(foreground_port),
            "--data-dir",
            str(foreground_dir),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=foreground_env,
    )
    try:
        foreground_deadline = time.time() + 20
        foreground_ready = False
        while time.time() < foreground_deadline:
            if console.probe_running_instance(foreground_port):
                foreground_ready = True
                break
            if foreground_process.poll() is not None:
                break
            time.sleep(0.05)
        ok(foreground_ready, "server.py --foreground --no-browser starts normally")
        if foreground_ready:
            status, body, _ = request(foreground_port, "GET", "/api/health")
            health = json.loads(body.decode("utf-8")) if status == 200 else {}
            eq(status, 200, "the foreground service answers /api/health")
            eq(
                health.get("autoExit"),
                False,
                "--foreground forces the resident mode even when --auto-exit is also passed",
            )
            eq(
                health.get("activeTabs"),
                0,
                "the resident foreground service has no lifecycle monitor",
            )
    finally:
        foreground_process.terminate()
        try:
            foreground_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            foreground_process.kill()
            foreground_process.wait(timeout=5)

    bat_dir = Path(tempfile.mkdtemp(prefix="eac-foreground-bat-"))
    if os.name == "nt":
        bat_port = free_port()
        bat_process = subprocess.Popen(
            [
                "cmd",
                "/c",
                str(ROOT / "start.bat"),
                "--foreground",
                "--auto-exit",
                "--no-browser",
                "--port",
                str(bat_port),
                "--data-dir",
                str(bat_dir),
            ],
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            bat_deadline = time.time() + 30
            bat_ready = False
            while time.time() < bat_deadline:
                if console.probe_running_instance(bat_port):
                    bat_ready = True
                    break
                if bat_process.poll() is not None:
                    break
                time.sleep(0.05)
            ok(
                bat_ready,
                "start.bat --foreground --no-browser passes the flag through and starts normally",
            )
            if bat_ready:
                status, body, _ = request(bat_port, "GET", "/api/health")
                health = json.loads(body.decode("utf-8")) if status == 200 else {}
                eq(status, 200, "the start.bat foreground service answers /api/health")
                eq(
                    health.get("autoExit"),
                    False,
                    "start.bat --foreground keeps the visible foreground service resident",
                )
        finally:
            subprocess.run(
                ["taskkill", "/pid", str(bat_process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                bat_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                bat_process.kill()
                bat_process.wait(timeout=5)
    else:
        ok(True, "start.bat --foreground is Windows-only (skipped)")

    print("\n== 跨平台换行锁定：.gitattributes 与 start.sh 归档（P3-1） ==")
    gitattributes_path = ROOT / ".gitattributes"
    ok(gitattributes_path.is_file(), "repository root .gitattributes is present")
    try:
        gitattributes_text = gitattributes_path.read_text(encoding="utf-8")
    except OSError:
        gitattributes_text = ""
    for rule in (
        "*.sh text eol=lf",
        "*.py text eol=lf",
        "*.mjs text eol=lf",
        "*.ts text eol=lf",
        "*.tsx text eol=lf",
        "*.bat text eol=crlf",
        "LICENSE text eol=lf",
        "*.md text eol=lf",
        "*.json text eol=lf",
        "*.txt text eol=lf",
        "*.js text eol=lf",
        "*.css text eol=lf",
        "*.html text eol=lf",
        "*.woff2 binary",
        "*.woff binary",
        "*.ttf binary",
        "dist/** -text",
    ):
        ok(rule in gitattributes_text, ".gitattributes pins %s" % rule)
    try:
        start_sh_bytes = (ROOT / "start.sh").read_bytes()
    except OSError:
        start_sh_bytes = b""
    ok(bool(start_sh_bytes), "working-tree start.sh is readable")
    ok(b"\r" not in start_sh_bytes, "working-tree start.sh uses pure LF line endings")
    start_sh_text = start_sh_bytes.decode("utf-8", "replace")
    ok(
        "--auto-exit" in start_sh_text and '"$#" -eq 0' in start_sh_text,
        "start.sh passes --auto-exit for the argument-free launch",
    )
    try:
        start_bat_text = (ROOT / "start.bat").read_text(encoding="utf-8", errors="replace")
    except OSError:
        start_bat_text = ""
    ok(bool(start_bat_text), "working-tree start.bat is readable")
    ok(
        "pythonw.exe" in start_bat_text,
        "start.bat locates pythonw.exe for a windowless background launch",
    )
    ok(
        'start "" "%PYTHONW%" "%~dp0server.py" --auto-exit' in start_bat_text,
        "start.bat starts the detached pythonw service with --auto-exit",
    )
    ok(
        'if not "%~1"=="" goto foreground' in start_bat_text,
        "start.bat keeps the foreground python.exe path for command-line arguments",
    )
    ok(
        start_bat_text.count("exit /b 0") >= 2,
        "start.bat closes its own CMD window after the background launch",
    )
    git_executable = shutil.which("git")
    ok(bool(git_executable), "git executable is available for the archive check")
    if git_executable:
        ls_files = subprocess.run(
            [git_executable, "ls-files", "-s", "start.sh"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
        )
        ok(
            ls_files.stdout.startswith("100755"),
            "start.sh is recorded as mode 100755 in the Git index",
            ls_files.stdout.strip()[:80],
        )
        def read_archived_start(extra_config: list[str]) -> tuple[bytes, int]:
            """导出 HEAD 里的 start.sh，返回（字节内容, tar 头模式）。"""
            import io
            import tarfile

            args = [git_executable, "-c", "core.autocrlf=true", *extra_config]
            result = subprocess.run(
                [*args, "archive", "--format=tar", "HEAD", "start.sh"],
                cwd=str(ROOT),
                capture_output=True,
            )
            if result.returncode != 0 or not result.stdout:
                return b"", 0
            archived = b""
            archived_mode = 0
            try:
                with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:*") as tar:
                    for member in tar.getmembers():
                        if member.name == "start.sh":
                            archived_mode = member.mode
                            extracted = tar.extractfile(member)
                            archived = extracted.read() if extracted is not None else b""
            except (OSError, tarfile.TarError):
                return b"", 0
            return archived, archived_mode

        # 1) 用户实际会用的命令：验证行尾属性把归档内容锁成 LF
        archived_content, _archived_mode = read_archived_start([])
        ok(bool(archived_content), "git -c core.autocrlf=true archive HEAD exports start.sh")
        ok(
            b"\r" not in archived_content,
            "archived start.sh contains no CR bytes",
        )
        ok(archived_content == start_sh_bytes, "archived start.sh matches the LF working-tree bytes")
        # 2) tar.umask 默认值因环境而异（Windows Git 默认 002 会写出 0775）：
        #    这里固定成常规 022，才能确定性地断言归档保留了索引里的 100755 可执行位
        _umask_content, umask_mode = read_archived_start(["-c", "tar.umask=0022"])
        ok(
            stat.S_IMODE(umask_mode) == 0o755,
            "archived start.sh keeps the executable 100755 mode",
            oct(umask_mode),
        )
        # 3) 宽松 tar.umask（Windows Git 默认 002）只会加宽 group/other 写位，
        #    可执行位仍然保留，与 AGENTS.md 对 git archive 权限的描述一致
        _wide_content, wide_umask_mode = read_archived_start(["-c", "tar.umask=0002"])
        ok(
            stat.S_IMODE(wide_umask_mode) in (0o775, 0o755),
            "a permissive tar.umask keeps the archived start.sh executable",
            oct(wide_umask_mode),
        )
        if os.name == "nt":
            eq(
                stat.S_IMODE(wide_umask_mode),
                0o775,
                "the Windows-default tar.umask widens the archived mode to 100775",
            )
        try:
            agents_text = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        except OSError:
            agents_text = ""
        ok(
            "tar.umask" in agents_text and "100775" in agents_text,
            "AGENTS.md documents the tar.umask-dependent archived start.sh mode",
        )
        ok(
            "git archive" in agents_text,
            "AGENTS.md documents the git archive executable-bit behaviour",
        )
        ok(
            "--auto-exit" in agents_text and "/api/lifecycle" in agents_text,
            "AGENTS.md documents the tag-lifecycle auto-exit contract",
        )

        # 4) 全量归档字节核验：Windows 默认 `core.autocrlf=true` 下，提交树里的全部
        #    151 个 dist/ 文件与根 LICENSE 必须与原始 Git blob 逐字节一致（0 次 LF→CRLF）。
        import io
        import tarfile

        archive_result = subprocess.run(
            [git_executable, "-c", "core.autocrlf=true", "archive", "--format=tar", "HEAD"],
            cwd=str(ROOT),
            capture_output=True,
        )
        ok(
            archive_result.returncode == 0 and bool(archive_result.stdout),
            "git -c core.autocrlf=true archive HEAD exports the full tree for byte verification",
        )
        archive_members: dict[str, bytes] = {}
        if archive_result.returncode == 0 and archive_result.stdout:
            try:
                with tarfile.open(fileobj=io.BytesIO(archive_result.stdout), mode="r:*") as full_tar:
                    for member in full_tar.getmembers():
                        if not member.isfile():
                            continue
                        if member.name == "LICENSE" or member.name.startswith("dist/"):
                            extracted = full_tar.extractfile(member)
                            archive_members[member.name] = (
                                extracted.read() if extracted is not None else b""
                            )
            except (OSError, tarfile.TarError):
                archive_members = {}
        tracked = subprocess.run(
            [git_executable, "ls-tree", "-r", "--name-only", "HEAD", "dist"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
        )
        tracked_dist = [line for line in tracked.stdout.splitlines() if line]
        archived_dist = sorted(name for name in archive_members if name.startswith("dist/"))
        eq(len(tracked_dist), 151, "the committed build tree contains exactly 151 dist/ files")
        eq(
            archived_dist,
            sorted(tracked_dist),
            "the full Windows-style archive exports every committed dist/ file",
        )
        ok("LICENSE" in archive_members, "the full archive exports the root LICENSE")
        # 一次 `git cat-file --batch` 取回所有原始 blob，避免逐文件起进程
        archive_names = ["LICENSE", *archived_dist]
        cat_batch = subprocess.run(
            [git_executable, "cat-file", "--batch"],
            cwd=str(ROOT),
            input=("\n".join("HEAD:%s" % name for name in archive_names) + "\n").encode("utf-8"),
            capture_output=True,
        )
        blob_bytes: dict[str, bytes] = {}
        batch_parse_ok = cat_batch.returncode == 0 and bool(cat_batch.stdout)
        if batch_parse_ok:
            offset = 0
            data = cat_batch.stdout
            try:
                for name in archive_names:
                    newline = data.index(b"\n", offset)
                    header = data[offset:newline].decode("utf-8")
                    position = newline + 1
                    blob_size = int(header.split()[2])
                    blob_bytes[name] = data[position : position + blob_size]
                    offset = position + blob_size + 1
            except (IndexError, ValueError):
                batch_parse_ok = False
                blob_bytes = {}
        ok(batch_parse_ok, "git cat-file --batch resolves the original blobs for the archive")
        dist_sha_matches = 0
        archive_mismatches: list[str] = []
        if batch_parse_ok:
            for name in archived_dist:
                archived_digest = hashlib.sha256(archive_members[name]).digest()
                blob_digest = hashlib.sha256(blob_bytes.get(name, b"")).digest()
                if archived_digest == blob_digest:
                    dist_sha_matches += 1
                else:
                    archive_mismatches.append(name)
        eq(
            dist_sha_matches,
            151,
            "SHA-256 of all 151 archived dist/ files matches the original Git blobs (151/151)",
        )
        eq(
            archive_mismatches,
            [],
            "the Windows-style archive performs zero LF→CRLF conversions on dist/",
        )
        license_sha_match = False
        if batch_parse_ok and "LICENSE" in archive_members:
            license_sha_match = hashlib.sha256(archive_members["LICENSE"]).digest() == hashlib.sha256(
                blob_bytes.get("LICENSE", b"")
            ).digest()
        ok(
            license_sha_match,
            "SHA-256 of the archived root LICENSE matches the original Git blob",
        )

    print("\n== 无 git 元数据时的隐私扫描回退（P3-1） ==")
    scan_copy = Path(tempfile.mkdtemp(prefix="eac-no-git-scan-"))
    skip_names = {
        "node_modules",
        ".git",
        ".console_data",
        ".selftest",
        ".browser",
        "__pycache__",
    }
    try:
        for entry in ROOT.iterdir():
            if entry.name in skip_names:
                continue
            target = scan_copy / entry.name
            if entry.is_dir():
                shutil.copytree(
                    entry,
                    target,
                    ignore=shutil.ignore_patterns(*skip_names),
                )
            else:
                shutil.copy2(entry, target)
        node_executable = shutil.which("node")
        ok(bool(node_executable), "node executable is available for the privacy scan")
        scan_returncode = -1
        scan_output = ""
        if node_executable:
            scan_completed = subprocess.run(
                [node_executable, "tests/privacy-scan.mjs"],
                cwd=scan_copy,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=300,
            )
            scan_returncode = scan_completed.returncode
            scan_output = (scan_completed.stdout or "") + (scan_completed.stderr or "")
        ok(
            scan_returncode == 0,
            "privacy scan succeeds without git metadata",
            scan_output[-800:],
        )
        count_match = re.search(r"privacy scan: (\d+) text files", scan_output)
        ok(count_match is not None, "privacy scan reports its scanned file count")
        scanned_count = int(count_match.group(1)) if count_match else 0
        ok(
            scanned_count >= 230,
            "the no-git recursive fallback scans at least 230 source files",
            str(scanned_count),
        )
        ok(
            "0 hits" in scan_output,
            "the no-git fallback reports zero privacy hits",
            scan_output[-800:],
        )
    finally:
        shutil.rmtree(scan_copy, ignore_errors=True)

    print("\nSELFTEST RESULT: %d passed, %d failed" % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
