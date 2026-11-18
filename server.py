#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Engineering AI Console — 本地微服务端（单文件，零第三方依赖，Python 3.9+）。

安全边界（对应仓库 README / AGENTS.md 的红线）：
- 只绑定 127.0.0.1，不暴露局域网；
- 每个请求入口先校验 Host，只接受 127.0.0.1:<port> / localhost:<port>，其余 403；
- 静态文件服务只允许读取 dist/ 内的文件，Path.resolve() + relative_to 双重校验封堵穿越；
- 配置读写严格限制在 --data-dir（默认 .console_data/）；
- 所有 /api/* 必须携带同源防伪令牌 X-Console-Token，并校验 Origin 精确等于
  http://127.0.0.1:<port>；没有令牌即 403。唯一的例外是 GET /api/health：单实例探测
  需要不带令牌访问，但 Host 与 Origin 校验照旧；
- 不提供任何读取任意磁盘文件或执行系统命令的接口；
- 聊天转发使用配置槽位（primary/backup）里保存的真实 URL 与密钥，前端无法把服务端
  当成任意目标 URL 的裸代理；上游 30x 跨源重定向一律拒绝，认证头与自定义头不会
  被带到第二个源；
- 所有 POST 强制检查 Content-Length 上限（配置 1 MB、聊天/文件 32 MB），超限或缺失
  合法长度直接 413/400，绝不无界读取请求体；
- 所有 urllib 请求都带显式 Socket 超时；SSE 转发按上游到达的节奏逐块 flush，客户端
  断连时在 finally 中安静关闭上游响应；
- 未显式指定 --port 时先扫描 18765..18795 上是否有本程序实例（/api/health），
  已有在线实例就直接打开该端口并退出 0；没有任何实例才从 18765 起绑定空闲端口；
- 出站请求默认带干净的 User-Agent（可被用户自定义同名头覆盖）与协议匹配的 Accept：
  urllib 默认的 Python-urllib/3.x 会被部分 WAF 对 POST /chat/completions 直接拒绝；
- Windows pythonw.exe 下 sys.stdout / sys.stderr 可能是 None 或不可写，入口处统一兜底到
  os.devnull，保证无控制台启动时 print / 错误日志不会把正常请求变成崩溃；
- 显式传入 --auto-exit 时启用标签页生命周期联动：正常关闭全部控制台网页约 5 秒后进程
  以 0 退出，F5 刷新（1 秒内新心跳）不误杀，后台静默超过 10 分钟才按浏览器崩溃回收。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import mimetypes
import os
import re
import secrets as pysecrets
import shutil
import socket
import ssl
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

APP_NAME = "engineering-ai-console"
VERSION = "0.1.0"
ROOT_DIR = Path(__file__).resolve().parent
DIST_DIR = (ROOT_DIR / "dist").resolve()
DEFAULT_DATA_DIR = ROOT_DIR / ".console_data"
CONFIG_LOCK = threading.Lock()

MAX_CONFIG_BODY = 1 * 1024 * 1024
MAX_STREAM_BODY = 32 * 1024 * 1024
MAX_FILE_BODY = 32 * 1024 * 1024
MAX_ERROR_BODY = 64 * 1024
MAX_UPSTREAM_JSON = 4 * 1024 * 1024
DEFAULT_TIMEOUT_SEC = 60
MAX_TIMEOUT_SEC = 600
MAX_SECRET_LENGTH = 4096
MAX_QUERY_LENGTH = 4000
MAX_HEADER_COUNT = 16
MAX_HEADER_VALUE_LENGTH = 2048
MAX_HEADER_TOTAL_CHARS = 16384
MAX_TAB_ID_LENGTH = 128

# 干净通用客户端标识：默认 User-Agent 缺失时 urllib 会发 Python-urllib/3.x，
# Cloudflare 一类网关会放行 GET /models 却对 POST /chat/completions 返回 403 (error 1010)。
DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; EngineeringAIConsole/0.1)"

# --auto-exit 标签页生命周期参数
LIFECYCLE_STARTUP_GRACE_SEC = 60.0
LIFECYCLE_REFRESH_BUFFER_SEC = 5.0
LIFECYCLE_SILENT_TIMEOUT_SEC = 600.0
LIFECYCLE_TICK_SEC = 0.5
# 无 --auto-exit 时也存在的接口路径；只有显式开启才真正改变进程生命周期
LIFECYCLE_PATH = "/api/lifecycle"
INFLIGHT_PATHS = ("/api/chat/stream", "/api/config")

DEFAULT_PORT = 18765
PORT_SCAN_SPAN = 30
HEALTH_PROBE_TIMEOUT_SEC = 0.5
# 单实例扫描时同时探测的端口数量；31 个端口全部超时也只多花约 2 秒
HEALTH_SCAN_WORKERS = 8
# 未显式指定端口时识别到已在线实例的实际端口（供启动器打开正确地址）
DETECTED_INSTANCE_PORT: Optional[int] = None

SESSION_TOKEN = pysecrets.token_hex(24)

FILE_BETA = "files-api-2025-04-14"
BLOCKED_HEADERS = {
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "x-console-token",
    "x-console-slot",
    "origin",
    "referer",
}

# ---------------------------------------------------------------------------
# 默认配置（与前端 config/types.ts 对齐；不含任何厂商预设）
# ---------------------------------------------------------------------------


def default_channel(label: str) -> Dict[str, Any]:
    return {
        "label": label,
        "protocol": "openai",
        "baseUrl": "",
        "apiKey": "",
        "apiKeyEnv": "",
        "model": "",
        "thinkingModel": "",
        "thinkingParamMode": "none",
        "modalityMode": "auto",
        "webSearchMode": "off",
        "enableRemoteFileApi": False,
        "lockRawUrl": False,
        "proxyMode": "system",
        "proxyUrl": "",
        "allowInsecureTls": False,
        "customHeaders": [],
        "temperatureEnabled": False,
        "temperature": 1,
        "maxTokensEnabled": False,
        "maxTokens": 4096,
        "requestTimeoutSec": DEFAULT_TIMEOUT_SEC,
    }


def default_settings() -> Dict[str, Any]:
    return {
        "version": 1,
        "activeChannel": "primary",
        "channels": {"primary": default_channel("Primary"), "backup": default_channel("Backup")},
        "exa": {
            "endpoint": "https://api.exa.ai/search",
            "apiKey": "",
            "apiKeyEnv": "EXA_API_KEY",
            "numResults": 5,
        },
        "prompts": {"systemPrompt": {}, "capsules": {}, "downstreamLanguage": "follow"},
        "ui": {
            "locale": "en",
            "themePreference": "system",
            "fontScale": 1,
            "contentWidth": "standard",
            "reduceFlicker": True,
            "siderCollapsed": False,
        },
        "watchdog": {"firstByteMs": 45000, "idleMs": 25000},
        "thinking": False,
        "webSearch": False,
    }


def empty_secrets() -> Dict[str, Any]:
    """明文密钥只落在 secrets.json：槽位 API Key + 各槽位自定义 Header 值。"""
    return {
        "primary": "",
        "backup": "",
        "exa": "",
        "customHeaders": {"primary": {}, "backup": {}},
    }


# ---------------------------------------------------------------------------
# 确定性校验 / 归一化
# ---------------------------------------------------------------------------

PROTOCOLS = {"openai", "anthropic"}
SLOTS = {"primary", "backup"}
THINKING_MODES = {
    "none",
    "anthropic_thinking",
    "deepseek_thinking",
    "openai_reasoning_effort",
    "enable_thinking",
}
MODALITY_MODES = {"auto", "text_only", "multimodal"}
WEB_SEARCH_MODES = {"off", "exa", "native"}
PROXY_MODES = {"system", "direct", "custom"}
LOCALES = {"en", "zh", "fr", "ru"}
THEMES = {"light", "dark", "system"}
FONT_SCALES = {0.9, 1, 1.12, 1.25}
CONTENT_WIDTHS = {"standard", "wide"}
DOWNSTREAM_LANGUAGES = {"follow", "en", "zh", "fr", "ru"}
HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")


def _str(value: Any, fallback: str, max_length: int) -> str:
    return value[:max_length] if isinstance(value, str) else fallback


def _trimmed(value: Any, fallback: str, max_length: int) -> str:
    return _str(value, fallback, max_length).strip()


def _bool(value: Any, fallback: bool) -> bool:
    return value if isinstance(value, bool) else fallback


def _number(value: Any, fallback: float, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    if value != value or value in (float("inf"), float("-inf")):
        return fallback
    return max(minimum, min(maximum, float(value)))


def _enum(value: Any, fallback: str, allowed: set) -> str:
    return value if isinstance(value, str) and value in allowed else fallback


def sanitize_header_pairs(raw: Any, keep_values: bool = False) -> List[Dict[str, str]]:
    """规范化自定义 Header 列表：名称合法、去重、有界；values 仅探测草稿需要保留。"""
    headers: List[Dict[str, str]] = []
    if not isinstance(raw, list):
        return headers
    total = 0
    seen = set()
    for item in raw[:MAX_HEADER_COUNT]:
        if not isinstance(item, dict):
            continue
        name = _trimmed(item.get("name"), "", 100)
        if not name or not HEADER_NAME_RE.match(name) or name in seen:
            continue
        value = _str(item.get("value"), "", MAX_HEADER_VALUE_LENGTH).strip() if keep_values else ""
        if total + len(name) + len(value) > MAX_HEADER_TOTAL_CHARS:
            break
        total += len(name) + len(value)
        seen.add(name)
        headers.append({"name": name, "value": value})
    return headers


def sanitize_channel(
    raw: Any, fallback: Dict[str, Any], keep_header_values: bool = False
) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        result = dict(fallback)
        result["customHeaders"] = []
        return result
    return {
        "label": _trimmed(raw.get("label"), fallback["label"], 80) or fallback["label"],
        "protocol": _enum(raw.get("protocol"), fallback["protocol"], PROTOCOLS),
        "baseUrl": _trimmed(raw.get("baseUrl"), fallback["baseUrl"], 2048),
        "apiKey": "",
        "apiKeyEnv": _trimmed(raw.get("apiKeyEnv"), fallback["apiKeyEnv"], 120),
        "model": _trimmed(raw.get("model"), fallback["model"], 240),
        "thinkingModel": _trimmed(raw.get("thinkingModel"), fallback["thinkingModel"], 240),
        "thinkingParamMode": _enum(
            raw.get("thinkingParamMode"), fallback["thinkingParamMode"], THINKING_MODES
        ),
        "modalityMode": _enum(raw.get("modalityMode"), fallback["modalityMode"], MODALITY_MODES),
        "webSearchMode": _enum(
            raw.get("webSearchMode"), fallback["webSearchMode"], WEB_SEARCH_MODES
        ),
        "enableRemoteFileApi": _bool(
            raw.get("enableRemoteFileApi"), fallback["enableRemoteFileApi"]
        ),
        "lockRawUrl": _bool(raw.get("lockRawUrl"), fallback["lockRawUrl"]),
        "proxyMode": _enum(raw.get("proxyMode"), fallback["proxyMode"], PROXY_MODES),
        "proxyUrl": _trimmed(raw.get("proxyUrl"), fallback["proxyUrl"], 2048),
        "allowInsecureTls": _bool(raw.get("allowInsecureTls"), fallback["allowInsecureTls"]),
        "customHeaders": sanitize_header_pairs(raw.get("customHeaders"), keep_header_values),
        "temperatureEnabled": _bool(
            raw.get("temperatureEnabled"), fallback["temperatureEnabled"]
        ),
        "temperature": _number(raw.get("temperature"), fallback["temperature"], 0, 2),
        "maxTokensEnabled": _bool(raw.get("maxTokensEnabled"), fallback["maxTokensEnabled"]),
        "maxTokens": int(_number(raw.get("maxTokens"), fallback["maxTokens"], 1, 2_000_000)),
        "requestTimeoutSec": int(
            _number(
                raw.get("requestTimeoutSec"),
                fallback["requestTimeoutSec"],
                5,
                MAX_TIMEOUT_SEC,
            )
        ),
    }


def _sanitize_locale_map(raw: Any, max_length: int) -> Dict[str, str]:
    result: Dict[str, str] = {}
    if isinstance(raw, dict):
        for locale in LOCALES:
            value = raw.get(locale)
            if isinstance(value, str) and value.strip():
                result[locale] = value[:max_length]
    return result


def sanitize_settings(raw: Any) -> Dict[str, Any]:
    base = default_settings()
    if not isinstance(raw, dict):
        return base
    channels_raw = raw.get("channels") if isinstance(raw.get("channels"), dict) else {}
    exa_raw = raw.get("exa") if isinstance(raw.get("exa"), dict) else {}
    ui_raw = raw.get("ui") if isinstance(raw.get("ui"), dict) else {}
    watchdog_raw = raw.get("watchdog") if isinstance(raw.get("watchdog"), dict) else {}
    prompts_raw = raw.get("prompts") if isinstance(raw.get("prompts"), dict) else {}

    capsules: Dict[str, Dict[str, str]] = {}
    raw_capsules = prompts_raw.get("capsules")
    if isinstance(raw_capsules, dict):
        for locale in LOCALES:
            item = raw_capsules.get(locale)
            if not isinstance(item, dict):
                continue
            entry: Dict[str, str] = {}
            for capsule_id in ("agent2", "agent3", "distill"):
                value = item.get(capsule_id)
                if isinstance(value, str) and value.strip():
                    entry[capsule_id] = value[:8000]
            if entry:
                capsules[locale] = entry

    return {
        "version": 1,
        "activeChannel": _enum(raw.get("activeChannel"), base["activeChannel"], SLOTS),
        "channels": {
            "primary": sanitize_channel(channels_raw.get("primary"), base["channels"]["primary"]),
            "backup": sanitize_channel(channels_raw.get("backup"), base["channels"]["backup"]),
        },
        "exa": {
            "endpoint": _trimmed(exa_raw.get("endpoint"), base["exa"]["endpoint"], 2048),
            "apiKey": "",
            "apiKeyEnv": _trimmed(exa_raw.get("apiKeyEnv"), base["exa"]["apiKeyEnv"], 120),
            "numResults": int(_number(exa_raw.get("numResults"), 5, 1, 10)),
        },
        "prompts": {
            "systemPrompt": _sanitize_locale_map(prompts_raw.get("systemPrompt"), 20000),
            "capsules": capsules,
            "downstreamLanguage": _enum(
                prompts_raw.get("downstreamLanguage"),
                base["prompts"]["downstreamLanguage"],
                DOWNSTREAM_LANGUAGES,
            ),
        },
        "ui": {
            "locale": _enum(ui_raw.get("locale"), base["ui"]["locale"], LOCALES),
            "themePreference": _enum(
                ui_raw.get("themePreference"), base["ui"]["themePreference"], THEMES
            ),
            "fontScale": (
                ui_raw.get("fontScale")
                if isinstance(ui_raw.get("fontScale"), (int, float))
                and ui_raw.get("fontScale") in FONT_SCALES
                else 1
            ),
            "contentWidth": _enum(
                ui_raw.get("contentWidth"), base["ui"]["contentWidth"], CONTENT_WIDTHS
            ),
            "reduceFlicker": _bool(ui_raw.get("reduceFlicker"), True),
            "siderCollapsed": _bool(ui_raw.get("siderCollapsed"), False),
        },
        "watchdog": {
            "firstByteMs": int(
                _number(watchdog_raw.get("firstByteMs"), 45000, 3000, 600000)
            ),
            "idleMs": int(_number(watchdog_raw.get("idleMs"), 25000, 3000, 600000)),
        },
        "thinking": _bool(raw.get("thinking"), False),
        "webSearch": _bool(raw.get("webSearch"), False),
    }


def sanitize_secret_header_values(raw: Any) -> Dict[str, Dict[str, str]]:
    """规范化 secrets.json 里的自定义 Header 明文值：{slot: {name: value}}。"""
    result: Dict[str, Dict[str, str]] = {"primary": {}, "backup": {}}
    if not isinstance(raw, dict):
        return result
    for slot in ("primary", "backup"):
        slot_raw = raw.get(slot)
        if not isinstance(slot_raw, dict):
            continue
        values: Dict[str, str] = {}
        total = 0
        for name, value in list(slot_raw.items())[:MAX_HEADER_COUNT]:
            if not isinstance(name, str) or not HEADER_NAME_RE.match(name):
                continue
            if not isinstance(value, str):
                continue
            trimmed = value.strip()[:MAX_HEADER_VALUE_LENGTH]
            if not trimmed:
                continue
            if total + len(name) + len(trimmed) > MAX_HEADER_TOTAL_CHARS:
                break
            total += len(name) + len(trimmed)
            values[name] = trimmed
        result[slot] = values
    return result


def sanitize_secrets(raw: Any) -> Dict[str, Any]:
    result = empty_secrets()
    if isinstance(raw, dict):
        for slot in ("primary", "backup", "exa"):
            value = raw.get(slot)
            if isinstance(value, str):
                result[slot] = value.strip()[:MAX_SECRET_LENGTH]
        result["customHeaders"] = sanitize_secret_header_values(raw.get("customHeaders"))
    return result


def is_http_url(value: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(value)
        return parsed.scheme in ("http", "https") and bool(parsed.netloc)
    except ValueError:
        return False


def _strip_slashes(value: str) -> str:
    return value.rstrip("/")


def normalize_chat_url(channel: Dict[str, Any]) -> Optional[str]:
    raw = _trimmed(channel.get("baseUrl"), "", 2048)
    if not raw:
        return None
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    if not channel.get("lockRawUrl"):
        if parsed.query or parsed.fragment:
            return None
        base = _strip_slashes(raw)
        if channel.get("protocol") == "openai":
            if re.search(r"/chat/completions$", base, re.I):
                return base
            if re.search(r"/v1$", base, re.I):
                return base + "/chat/completions"
            return base + "/v1/chat/completions"
        if re.search(r"/messages$", base, re.I):
            return base
        if re.search(r"/v1$", base, re.I):
            return base + "/messages"
        if re.search(r"/anthropic$", base, re.I):
            return base + "/v1/messages"
        return base + "/v1/messages"
    return raw


def normalize_models_url(channel: Dict[str, Any]) -> Optional[str]:
    raw = _trimmed(channel.get("baseUrl"), "", 2048)
    if not raw:
        return None
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    if channel.get("lockRawUrl"):
        return raw
    if parsed.query or parsed.fragment:
        return None
    base = _strip_slashes(raw)
    if channel.get("protocol") == "openai":
        if re.search(r"/chat/completions$", base, re.I):
            return re.sub(r"/chat/completions$", "/models", base, flags=re.I)
        if re.search(r"/v1$", base, re.I):
            return base + "/models"
        return base + "/v1/models"
    if re.search(r"/messages$", base, re.I):
        return re.sub(r"/messages$", "/models", base, flags=re.I)
    if re.search(r"/v1$", base, re.I):
        return base + "/models"
    if re.search(r"/anthropic$", base, re.I):
        return base + "/v1/models"
    return base + "/v1/models"


def normalize_files_url(channel: Dict[str, Any]) -> Optional[str]:
    raw = _trimmed(channel.get("baseUrl"), "", 2048)
    if not raw:
        return None
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    base = _strip_slashes(raw)
    # 完整 /messages 端点要换成同级的 /files，不能在其后再拼 /v1/files。
    if re.search(r"/messages$", base, re.I):
        return re.sub(r"/messages$", "/files", base, flags=re.I)
    if re.search(r"/anthropic/v1$", base, re.I):
        return base + "/files"
    if re.search(r"/v1$", base, re.I):
        return base + "/files"
    if re.search(r"/anthropic$", base, re.I):
        return base + "/v1/files"
    return base + "/v1/files"


# ---------------------------------------------------------------------------
# 原子存储（A/B 双区 + 互斥锁 + .bak 恢复）
# ---------------------------------------------------------------------------


def mask_secret(value: str) -> Dict[str, Any]:
    if not value:
        return {"hasKey": False, "mask": ""}
    return {"hasKey": True, "mask": "..." + value[-4:]}


def key_fingerprint(key: str) -> str:
    """实际生效凭据的单向短指纹：只下发 12 位十六进制，绝不下发任何明文字符。

    远端 file_id 的归属必须以“真正会被发出去的密钥”为准：填了但未生效的环境变量名
    不算凭据，因此这里复用 resolve_api_key() 的解析结果，而不是环境变量名本身。
    """
    trimmed = (key or "").strip()
    if not trimmed:
        return "none"
    return hashlib.sha256(trimmed.encode("utf-8")).hexdigest()[:12]


def _write_bytes_atomic(
    path: Path, payload: bytes, backup: bool = True, validate_backup_json: bool = False
) -> None:
    """写唯一临时文件 → flush+fsync → 备份合法正式文件 → 原子替换。

    临时名带 pid 与随机后缀，失败路径负责清理；backup=False 用于迁移与回滚，
    避免把含明文或刚被撤销的旧内容再复制到 .bak。只有当前正式文件仍是合法 JSON
    时才允许覆盖 .bak，否则损坏的主文件会把可恢复的备份也毁掉。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(
        "%s.%d.%s.tmp" % (path.name, os.getpid(), pysecrets.token_hex(6))
    )
    bak = path.with_name(path.name + ".bak")
    try:
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            try:
                os.close(fd)
            except OSError:
                pass
            raise
        if backup and path.exists():
            try:
                if validate_backup_json:
                    json.loads(path.read_text(encoding="utf-8"))
                else:
                    path.read_bytes()
                shutil.copyfile(path, bak)
                if os.name == "posix":
                    os.chmod(bak, 0o600)
            except (OSError, ValueError):
                # 正式文件已损坏 / 无法读取时不覆盖原有 .bak
                pass
        os.replace(tmp, path)
        if os.name == "posix":
            os.chmod(path, 0o600)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def atomic_write_json(path: Path, data: Any, backup: bool = True) -> None:
    """序列化后原子写入；落盘前重新解析校验，data 迁移写盘时 backup=False。"""
    payload = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    # 重新解析校验：确保写出的内容一定是合法 JSON
    json.loads(payload.decode("utf-8"))
    _write_bytes_atomic(path, payload, backup=backup, validate_backup_json=True)


def restore_file_bytes(path: Path, payload: Optional[bytes]) -> None:
    """用事务开始前的原始快照恢复文件；payload 为 None 表示该文件原本不存在。"""
    if payload is None:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        return
    _write_bytes_atomic(path, payload, backup=False)


def load_json_with_recovery(
    path: Path, allow_backup: bool = True
) -> Tuple[Any, str]:
    """读取 JSON；正式文件损坏时回退 .bak，并用恢复数据重写正式文件。状态：ok/recovered/missing。

    allow_backup=False 用于 .bak 已被标记为脏（可能含刚撤销的旧凭据或明文）的场景：
    此时宁可暂时读不到配置，也绝不能用脏备份覆盖当前主文件。
    """
    bak = path.with_name(path.name + ".bak")
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8")), "ok"
        except (OSError, ValueError):
            pass
    if allow_backup and bak.exists():
        try:
            data = json.loads(bak.read_text(encoding="utf-8"))
            try:
                atomic_write_json(path, data)
            except OSError:
                pass
            return data, "recovered"
        except (OSError, ValueError):
            return None, "missing"
    return None, "missing"


# 错误响应脱敏：绝不把本机磁盘路径或临时文件名回传给页面
_WINDOWS_PATH_RE = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s\"'<>|]*")
_TEMP_FILE_RE = re.compile(r"[^\s\"'<>|]*\.\d+\.[0-9a-f]+\.tmp\b", re.I)
_HOME_DIR_RE = re.compile(
    "(?:"
    + "|".join(
        [
            "/" + "Users" + "/",
            "/" + "home" + "/",
            "/" + "root" + "/",
            "/" + "tmp" + "/",
        ]
    )
    + ")[^\\s\"'<>|]*"
)


def redact_local_paths(text: str) -> str:
    """把异常文本里的本机路径与临时文件名替换掉，保留可读的错误类型说明。"""
    if not text:
        return text
    redacted = _WINDOWS_PATH_RE.sub("<redacted-path>", text)
    redacted = _HOME_DIR_RE.sub("<redacted-path>", redacted)
    redacted = _TEMP_FILE_RE.sub("<redacted-temp-file>", redacted)
    return redacted


def _redacted_reason(value: Any) -> str:
    """异常原因统一的脱敏字符串形式；None 时给出通用说明。"""
    if value is None:
        return "connection failed"
    return redact_local_paths(str(value))[:600]


def _stream_usable(stream: Any) -> bool:
    """标准流是否真的可写：pythonw.exe 下可能是 None、已关闭或写入即抛 OSError。"""
    if stream is None:
        return False
    try:
        writable = getattr(stream, "writable", None)
        if callable(writable) and not writable():
            return False
        stream.write("")
        stream.flush()
    except (AttributeError, OSError, ValueError):
        return False
    return True


def _devnull_stream() -> Any:
    return open(os.devnull, "w", encoding="utf-8", errors="replace")


def ensure_console_streams() -> None:
    """无控制台（pythonw.exe / 服务方式）启动时把不可用的 stdout/stderr 指向 os.devnull。

    否则 main() 里的一行 print、BaseHTTPRequestHandler 的错误日志或 traceback 输出都会
    直接抛异常，把本来正常的请求变成 500，或在启动阶段静默失败。重定向只吞掉日志文本，
    绝不打印请求体、密钥或请求头。
    """
    for name in ("stdout", "stderr"):
        if not _stream_usable(getattr(sys, name, None)):
            try:
                setattr(sys, name, _devnull_stream())
            except (OSError, ValueError):
                pass


def write_stderr_safely(text: str) -> None:
    """日志写入失败绝不能反过来打断请求：所有兜底日志都走这里。"""
    try:
        stream = sys.stderr
        if stream is not None:
            stream.write(text)
            stream.flush()
    except (AttributeError, OSError, ValueError):
        pass


def _raw_custom_header_values(payload: Any, slot: str) -> Dict[str, str]:
    """从待保存的 settings 原始 JSON 里取非空 Header 值；明文只允许写进 secrets.json。"""
    values: Dict[str, str] = {}
    if not isinstance(payload, dict):
        return values
    channels = payload.get("channels")
    if not isinstance(channels, dict):
        return values
    channel = channels.get(slot)
    if not isinstance(channel, dict):
        return values
    for item in sanitize_header_pairs(channel.get("customHeaders"), keep_values=True):
        if item["value"]:
            values[item["name"]] = item["value"]
    return values


def _legacy_custom_header_values(raw_settings: Any) -> Dict[str, Dict[str, str]]:
    """旧版本可能把自定义 Header 明文留在 settings.json；返回需要迁入 secrets 的值。"""
    result: Dict[str, Dict[str, str]] = {}
    if not isinstance(raw_settings, dict):
        return result
    channels = raw_settings.get("channels")
    if not isinstance(channels, dict):
        return result
    for slot in ("primary", "backup"):
        channel = channels.get(slot)
        if not isinstance(channel, dict):
            continue
        values: Dict[str, str] = {}
        for item in sanitize_header_pairs(channel.get("customHeaders"), keep_values=True):
            if item["value"]:
                values[item["name"]] = item["value"]
        if values:
            result[slot] = values
    return result


class ConfigStore:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.settings_path = data_dir / "settings.json"
        self.secrets_path = data_dir / "secrets.json"
        # 进程启动后一旦从 .bak 恢复过，健康状态在整个进程生命周期内保持 recovered
        self._recovered = False
        # 迁移 / 备份清洗失败时的告警态；一次成功读或写后自动恢复
        self._degraded = False
        # 备份待同步（sticky）：主文件写成功但 .bak 原子替换失败时置位。
        # 置位期间 degraded 不允许在后续请求里被重置，且禁止回退使用含旧凭据的脏 .bak。
        # 标记同时落盘（<name>.bak.dirty），进程重启后仍然生效。
        self._secrets_bak_dirty = (data_dir / "secrets.json.bak.dirty").is_file()
        self._settings_bak_dirty = (data_dir / "settings.json.bak.dirty").is_file()
        # 旧版明文 Header 迁移尚未落盘：secrets.json 写入失败时在内存里保留待迁移值，
        # 后续任何一次 update（哪怕只是改界面语言）都必须先把它写进 secrets.json。
        self._legacy_migration_pending = False
        self._legacy_pending_headers: Dict[str, Dict[str, str]] = {}

    @staticmethod
    def _backup_path(path: Path) -> Path:
        return path.with_name(path.name + ".bak")

    def _set_bak_dirty_locked(self, primary: Path, dirty: bool) -> None:
        """置位 / 清除 sticky dirty 标记并同步落盘，保证跨进程重启仍然有效。"""
        if primary == self.secrets_path:
            self._secrets_bak_dirty = dirty
        else:
            self._settings_bak_dirty = dirty
        marker = primary.with_name(primary.name + ".bak.dirty")
        try:
            if dirty:
                _write_bytes_atomic(marker, b"1", backup=False)
            else:
                marker.unlink(missing_ok=True)
        except OSError:
            # 标记落盘失败时内存标记仍然生效；后续成功读会再次尝试清除
            pass

    def _sync_backup_from_main_locked(self, primary: Path, backup: Path) -> bool:
        """用当前主文件字节原子覆盖 .bak；只有真正替换成功才返回 True。

        这是清除 sticky dirty 标记的唯一合法前提：内容比对、槽位补丁这类“看起来
        一样”的判断都不算数，必须是 .bak 已被最新主文件的完整字节替换。
        """
        try:
            payload = primary.read_bytes()
            json.loads(payload.decode("utf-8"))
        except (OSError, ValueError):
            return False
        try:
            _write_bytes_atomic(backup, payload, backup=False)
            return True
        except OSError:
            return False

    def _sync_backup_locked(self, primary: Path) -> bool:
        return self._sync_backup_from_main_locked(
            primary, self._backup_path(primary)
        )

    def _resync_backups_after_update(
        self, secrets_written: bool, settings_written: bool
    ) -> None:
        """更新尾部守卫：写过主文件或标记为脏时，一律用最新主文件整体覆盖 .bak。

        覆盖成功才允许清脏标记；.bak 仍被占用 / 替换失败时保持 dirty 与 degraded
        不变。绝不因为“本次没有新的删除操作”或“保存的是另一个槽位”提前清标记。
        """
        if secrets_written or self._secrets_bak_dirty:
            if self._sync_backup_from_main_locked(
                self.secrets_path, self._backup_path(self.secrets_path)
            ):
                self._set_bak_dirty_locked(self.secrets_path, False)
            else:
                self._set_bak_dirty_locked(self.secrets_path, True)
                self._degraded = True
        if settings_written or self._settings_bak_dirty:
            if self._sync_backup_from_main_locked(
                self.settings_path, self._backup_path(self.settings_path)
            ):
                self._set_bak_dirty_locked(self.settings_path, False)
            else:
                self._set_bak_dirty_locked(self.settings_path, True)
                self._degraded = True

    def _retry_dirty_backups_locked(self, settings_state: str, secrets_state: str) -> None:
        """读取 / 更新配置时自动补清洗：主文件合法才重试，覆盖成功后才清 dirty 与告警。"""
        if self._secrets_bak_dirty and secrets_state == "ok":
            if self._sync_backup_locked(self.secrets_path):
                self._set_bak_dirty_locked(self.secrets_path, False)
        if self._settings_bak_dirty and settings_state == "ok":
            if self._sync_backup_locked(self.settings_path):
                self._set_bak_dirty_locked(self.settings_path, False)

    def _read_locked(self) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
        # .bak 被标记为脏时禁止用它回退：脏备份可能含刚撤销的密钥 / 明文 Header
        raw_settings, settings_state = load_json_with_recovery(
            self.settings_path, allow_backup=not self._settings_bak_dirty
        )
        raw_secrets, secrets_state = load_json_with_recovery(
            self.secrets_path, allow_backup=not self._secrets_bak_dirty
        )
        settings = (
            sanitize_settings(raw_settings) if raw_settings is not None else default_settings()
        )
        secrets = sanitize_secrets(raw_secrets) if raw_secrets is not None else empty_secrets()
        self._degraded = False
        legacy_headers = _legacy_custom_header_values(raw_settings)
        if self._legacy_migration_pending and not legacy_headers:
            # 上一次迁移其实已经完成（例如 settings 已擦除明文）：待迁移状态可以安全撤销
            self._legacy_migration_pending = False
            self._legacy_pending_headers = {}
        if legacy_headers:
            # 旧配置里残留的明文 Header 值迁入 secrets.json，并把 settings.json 的 value 清空。
            # 顺序不可颠倒：先确认 secrets.json 真正写成功，最后才擦除含明文的 settings 文件。
            changed = False
            for slot, values in legacy_headers.items():
                for name, value in values.items():
                    if not secrets["customHeaders"][slot].get(name):
                        secrets["customHeaders"][slot][name] = value
                        changed = True
            migrated = True
            if changed:
                try:
                    atomic_write_json(self.secrets_path, secrets)
                except OSError:
                    # 写失败时保留原文件与内存中的有效凭据，绝不擦除 settings 里的明文。
                    # 待迁移值必须留在内存里：后续任何一次 save 都要先把它写进 secrets.json，
                    # 绝不能让一次普通的界面设置保存把 settings 里的明文擦掉却没落盘。
                    migrated = False
                    self._legacy_migration_pending = True
                    self._legacy_pending_headers = {
                        slot: dict(values) for slot, values in legacy_headers.items()
                    }
                    self._degraded = True
            if migrated:
                try:
                    # 不备份含明文的旧文件
                    atomic_write_json(self.settings_path, settings, backup=False)
                    settings_primary_ok = True
                except OSError:
                    # secrets 已经安全落盘；settings 清理失败只告警，下次读取继续重试
                    self._degraded = True
                    settings_primary_ok = False
                if settings_primary_ok:
                    self._legacy_migration_pending = False
                    self._legacy_pending_headers = {}
                    # secrets.json 刚写入迁移后的凭据，但 atomic_write_json 只会把
                    # “写入前的旧文件”复制成 .bak，备份仍是迁移前的内容。必须立即
                    # 用最新主文件整体镜像 .bak，否则主文件后续意外损坏、重启恢复时，
                    # 备份里没有任何刚迁移的请求头，凭据会静默丢失。settings.json 的
                    # 明文清洗也走同一条守卫：替换失败置位 sticky dirty 并保持 degraded。
                    for primary_path in (self.secrets_path, self.settings_path):
                        if self._sync_backup_from_main_locked(
                            primary_path, self._backup_path(primary_path)
                        ):
                            self._set_bak_dirty_locked(primary_path, False)
                        else:
                            self._set_bak_dirty_locked(primary_path, True)
                            self._degraded = True
        if self._legacy_migration_pending:
            self._degraded = True
        # 补清洗重试必须排在迁移之后：确保用于覆盖 .bak 的主文件已经不含明文
        self._retry_dirty_backups_locked(settings_state, secrets_state)
        if "recovered" in (settings_state, secrets_state):
            self._recovered = True
        if self._secrets_bak_dirty or self._settings_bak_dirty:
            self._degraded = True
        storage = {
            "settings": settings_state,
            "secrets": secrets_state,
            "recovered": self._recovered,
            "degraded": self._degraded,
        }
        return settings, secrets, storage

    @staticmethod
    def _build_snapshot_locked(
        settings: Dict[str, Any],
        secrets: Dict[str, Any],
        storage: Dict[str, Any],
    ) -> Dict[str, Any]:
        """单锁内构造对外快照：密钥与自定义 Header 只暴露末四位掩码。"""
        masks: Dict[str, Any] = {}
        for slot in ("primary", "backup"):
            masks[slot] = mask_secret(secrets.get(slot, ""))
            channel_env = settings["channels"][slot].get("apiKeyEnv", "")
            masks[slot]["envSet"] = bool(
                channel_env and os.environ.get(channel_env, "").strip()
            )
            # 前端远归属指纹只认实际生效密钥：环境变量未生效时，轮换本地存储的 Key
            # 必须立即改变指纹；这里绝不下发任何明文。
            masks[slot]["keyFingerprint"] = key_fingerprint(
                resolve_api_key(settings["channels"][slot], secrets.get(slot, ""))
            )
        masks["exa"] = mask_secret(secrets.get("exa", ""))
        exa_env = settings["exa"].get("apiKeyEnv", "")
        masks["exa"]["envSet"] = bool(exa_env and os.environ.get(exa_env, "").strip())
        header_masks: Dict[str, List[Dict[str, str]]] = {}
        for slot in ("primary", "backup"):
            stored = secrets["customHeaders"].get(slot, {})
            names = [
                item["name"] for item in settings["channels"][slot].get("customHeaders", [])
            ]
            for name in stored:
                if name not in names:
                    names.append(name)
            header_masks[slot] = [
                {"name": name, "mask": ("..." + stored[name][-4:]) if name in stored else ""}
                for name in names
            ]
        masks["customHeaders"] = header_masks
        return {"settings": settings, "secrets": masks, "storage": storage}

    def snapshot(self) -> Dict[str, Any]:
        with CONFIG_LOCK:
            return self._build_snapshot_locked(*self._read_locked())

    def read_channel(self, slot: Optional[str]) -> Tuple[Dict[str, Any], str, Dict[str, str]]:
        """一次加锁取出槽位配置、落盘密钥与自定义 Header 明文值。slot 为空时用活动槽位。"""
        with CONFIG_LOCK:
            settings, secrets, _storage = self._read_locked()
            resolved = slot if slot in SLOTS else settings.get("activeChannel", "primary")
            channel = settings["channels"].get(resolved) or settings["channels"]["primary"]
            stored = secrets.get(resolved, "")
            header_values = dict(secrets["customHeaders"].get(resolved, {}))
            return channel, stored, header_values

    def read_exa(self) -> Tuple[Dict[str, Any], str]:
        with CONFIG_LOCK:
            settings, secrets, _storage = self._read_locked()
            return settings["exa"], secrets.get("exa", "")

    def update(
        self,
        settings_payload: Any = None,
        keys: Any = None,
        clear_keys: Any = None,
        custom_headers: Any = None,
    ) -> Dict[str, Any]:
        with CONFIG_LOCK:
            settings, secrets, storage = self._read_locked()
            settings_changed = False
            secrets_changed = False
            migration_pending = self._legacy_migration_pending

            if settings_payload is not None:
                settings = sanitize_settings(settings_payload)
                settings_changed = True
            if isinstance(keys, dict):
                for slot in ("primary", "backup", "exa"):
                    value = keys.get(slot)
                    if isinstance(value, str):
                        secrets[slot] = value.strip()[:MAX_SECRET_LENGTH]
                        secrets_changed = True
            if isinstance(clear_keys, list):
                for slot in clear_keys:
                    if slot in ("primary", "backup", "exa"):
                        secrets[slot] = ""
                        secrets_changed = True

            stored_headers = {
                slot: dict(secrets["customHeaders"].get(slot, {}))
                for slot in ("primary", "backup")
            }

            if migration_pending:
                # 上一次读取时 secrets.json 写入失败：这次保存必须先把待迁移凭据合并进
                # 本次 secrets，并强制走“先原子写通 secrets.json”的双文件事务。
                # 即便用户只是改了界面语言，也绝不能丢掉那批明文 Header 值。
                for slot, values in self._legacy_pending_headers.items():
                    for name, value in values.items():
                        if not stored_headers[slot].get(name):
                            stored_headers[slot][name] = value
                secrets["customHeaders"] = {
                    slot: dict(stored_headers[slot]) for slot in ("primary", "backup")
                }
                secrets_changed = True
                # settings 也要写一份无明文的版本：明文擦除必须与 secrets 落盘同批完成
                settings_changed = True

            # 只有 payload 里实际提交的槽位才允许重写该槽位名单；
            # 未提交的另一槽位必须原样保留 secrets.json 里的既有请求头键值。
            if isinstance(custom_headers, dict):
                for slot in ("primary", "backup"):
                    if slot not in custom_headers:
                        continue
                    pairs = sanitize_header_pairs(custom_headers.get(slot), keep_values=True)
                    next_values: Dict[str, str] = {}
                    for item in pairs:
                        name = item["name"]
                        if item["value"]:
                            next_values[name] = item["value"]
                        elif stored_headers[slot].get(name):
                            # 空值语义是“保留已存密钥”，不是删除
                            next_values[name] = stored_headers[slot][name]
                    stored_headers[slot] = next_values
                    settings["channels"][slot]["customHeaders"] = [
                        {"name": item["name"], "value": ""} for item in pairs
                    ]
                    settings_changed = True
            elif settings_payload is not None:
                # 整包 settings 只是“名称清单 + 空值”，绝不能把另一槽位解读为空列表删除。
                # 仅迁入 payload 中意外携带的非空明文值，不删除既有密钥。
                for slot in ("primary", "backup"):
                    for name, value in _raw_custom_header_values(
                        settings_payload, slot
                    ).items():
                        if stored_headers[slot].get(name) != value:
                            stored_headers[slot][name] = value
                            secrets_changed = True

            if stored_headers != secrets["customHeaders"]:
                secrets["customHeaders"] = stored_headers
                secrets_changed = True

            if not settings_changed and not secrets_changed:
                return self._build_snapshot_locked(settings, secrets, storage)

            # 联合事务：先快照旧字节，先写 secrets 再写 settings；
            # 第二步失败时在锁内把 secrets 恢复原状，避免“新 URL + 旧密钥”的半提交。
            old_settings_bytes = (
                self.settings_path.read_bytes() if self.settings_path.is_file() else None
            )
            old_secrets_bytes = (
                self.secrets_path.read_bytes() if self.secrets_path.is_file() else None
            )
            secrets_written = False
            settings_written = False
            try:
                if secrets_changed:
                    atomic_write_json(self.secrets_path, secrets)
                    secrets_written = True
                if settings_changed:
                    atomic_write_json(self.settings_path, settings)
                    settings_written = True
            except BaseException:
                if secrets_written:
                    try:
                        restore_file_bytes(self.secrets_path, old_secrets_bytes)
                    except OSError:
                        # 回滚失败属于存储降级，至少让健康状态与后续读取可见
                        self._degraded = True
                restore_settings = settings_changed and self.settings_path.is_file()
                if restore_settings:
                    # settings 写入失败时文件通常尚未替换；防御性比对后再恢复
                    try:
                        current = self.settings_path.read_bytes()
                        if old_settings_bytes is not None and current != old_settings_bytes:
                            restore_file_bytes(self.settings_path, old_settings_bytes)
                        elif old_settings_bytes is None:
                            self.settings_path.unlink(missing_ok=True)
                    except OSError:
                        self._degraded = True
                raise

            if migration_pending:
                # secrets 与 settings 都已原子落盘成功：此时才允许撤销待迁移状态。
                # settings.json.bak 的明文清洗由下面的统一同步完成（用干净主文件整体覆盖）。
                self._legacy_migration_pending = False
                self._legacy_pending_headers = {}
            self._resync_backups_after_update(secrets_written, settings_written)
            settings, secrets, storage = self._read_locked()
            if self._secrets_bak_dirty or self._settings_bak_dirty:
                # sticky dirty：主文件已干净但 .bak 还没同步，degraded 必须一路保持
                self._degraded = True
            storage["degraded"] = self._degraded
            return self._build_snapshot_locked(settings, secrets, storage)


# ---------------------------------------------------------------------------
# 上游请求构造
# ---------------------------------------------------------------------------


def resolve_api_key(channel: Dict[str, Any], stored: str) -> str:
    env_name = _trimmed(channel.get("apiKeyEnv"), "", 120)
    if env_name:
        candidate = os.environ.get(env_name, "").strip()
        if candidate:
            return candidate
    return stored.strip()


def apply_auth_headers(
    headers: Dict[str, str], channel: Dict[str, Any], key: str, beta: bool = False
) -> None:
    if channel.get("protocol") == "anthropic":
        headers["anthropic-version"] = "2023-06-01"
        if key:
            headers["x-api-key"] = key
        if beta:
            headers["anthropic-beta"] = FILE_BETA
    else:
        if key:
            headers["Authorization"] = "Bearer " + key


def url_origin(url: str) -> Optional[Tuple[str, str, int]]:
    """(scheme, hostname, port) 归一化，省略端口时按协议补默认值。"""
    try:
        parsed = urllib.parse.urlparse(url)
        scheme = (parsed.scheme or "").lower()
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError:
        return None
    if scheme not in ("http", "https") or not host:
        return None
    if port is None:
        port = 443 if scheme == "https" else 80
    return (scheme, host, port)


class SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    """30x 只跟随同源目标。

    urllib 默认会带着 Authorization / x-api-key / 自定义 Header 跳到任意 Location，
    等于把凭据交给重定向目标。这里在任何跨源跳转发生前直接抛错，请求以 502 结束。
    opener 每次上游请求新建，一个实例只服务一条重定向链。
    """

    def __init__(self) -> None:
        super().__init__()
        self._initial_origin: Optional[Tuple[str, str, int]] = None

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> Optional[urllib.request.Request]:
        if self._initial_origin is None:
            self._initial_origin = url_origin(req.full_url)
        target_origin = url_origin(newurl)
        if (
            self._initial_origin is None
            or target_origin is None
            or target_origin != self._initial_origin
        ):
            raise urllib.error.URLError(
                "cross-origin redirect rejected: %s -> %s" % (req.full_url, newurl)
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def resolve_custom_headers(
    channel: Dict[str, Any], stored_values: Optional[Dict[str, str]] = None
) -> List[Tuple[str, str]]:
    """settings 里的名称清单 + secrets 里的明文值合并；草稿里非空的同名值优先。"""
    values = stored_values or {}
    pairs: List[Tuple[str, str]] = []
    seen = set()
    for item in channel.get("customHeaders", []):
        name = item.get("name", "")
        if not name or name in seen or name.lower() in BLOCKED_HEADERS:
            continue
        value = item.get("value") or values.get(name, "")
        seen.add(name)
        pairs.append((name, value))
    return pairs


def apply_custom_headers(
    headers: Dict[str, str],
    channel: Dict[str, Any],
    stored_values: Optional[Dict[str, str]] = None,
) -> None:
    for name, value in resolve_custom_headers(channel, stored_values):
        if value:
            headers[name] = value


def header_present(headers: Dict[str, str], name: str) -> bool:
    """大小写不敏感地判断某个非空请求头是否已存在（自定义头名不强制规范化）。"""
    wanted = name.lower()
    return any(key.lower() == wanted and bool(value) for key, value in headers.items())


def apply_default_headers(headers: Dict[str, str], accept: str) -> None:
    """补齐干净客户端标识与 Accept，用户自定义的非空同名头优先，绝不覆盖。

    urllib 默认发送 User-Agent: Python-urllib/3.x。Cloudflare 一类网关会放行 GET /models，
    却对 POST /chat/completions 返回 403 (error 1010)，表现正是“连通性自检通过但无法对话”。
    """
    if not header_present(headers, "User-Agent"):
        headers["User-Agent"] = DEFAULT_USER_AGENT
    if accept and not header_present(headers, "Accept"):
        headers["Accept"] = accept


def build_opener(channel: Dict[str, Any]) -> urllib.request.OpenerDirector:
    handlers: List[Any] = [SameOriginRedirectHandler()]
    proxy_mode = channel.get("proxyMode")
    if proxy_mode == "direct":
        handlers.append(urllib.request.ProxyHandler({}))
    elif proxy_mode == "custom" and _trimmed(channel.get("proxyUrl"), "", 2048):
        proxy_url = _trimmed(channel.get("proxyUrl"), "", 2048)
        handlers.append(urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url}))
    else:
        handlers.append(urllib.request.ProxyHandler())
    if channel.get("allowInsecureTls"):
        context = ssl._create_unverified_context()  # noqa: S323 — 用户显式开启内网自签名兼容
        handlers.append(urllib.request.HTTPSHandler(context=context))
    return urllib.request.build_opener(*handlers)


def upstream_error_message(error: urllib.error.HTTPError) -> str:
    """从上游错误体提取可读消息。

    兼容三类真实返回：
    - OpenAI/Anthropic 风格 {"error": {"message": ..., "code": ...}}；
    - {"error": "..."} 字符串；
    - 部分网关（如 SiliconFlow）把错误摊平在顶层：{"code":30014,"message":"Token is invalid."}。
    顶层 message 不识别时用户只能看到一整串 JSON，鉴权失败尤其难以定位。
    """
    try:
        raw = error.read(MAX_ERROR_BODY)
    except Exception:  # noqa: BLE001 — 读取失败时用状态行兜底
        raw = b""
    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
        if isinstance(payload, dict):
            inner = payload.get("error")
            message: Optional[str] = None
            code: Any = None
            if isinstance(inner, dict):
                if isinstance(inner.get("message"), str):
                    message = inner["message"]
                code = inner.get("code")
            elif isinstance(inner, str):
                message = inner
            elif isinstance(payload.get("message"), str):
                message = payload["message"]
                code = payload.get("code")
            if message and message.strip():
                suffix = ""
                if isinstance(code, (str, int)) and str(code).strip():
                    suffix = " (upstream code %s)" % str(code).strip()[:40]
                return message.strip()[:500] + suffix
    except (ValueError, UnicodeDecodeError):
        pass
    text = raw.decode("utf-8", "replace").strip()
    return text[:500] or (error.reason if isinstance(error.reason, str) else "upstream error")


def parse_model_list(payload: Any) -> List[str]:
    ids: List[str] = []

    def push(value: Any) -> None:
        if isinstance(value, str) and value.strip():
            ids.append(value.strip())

    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        items = payload.get("data") or payload.get("models") or []
    else:
        items = []
    if isinstance(items, list):
        for item in items:
            if isinstance(item, str):
                push(item)
            elif isinstance(item, dict):
                push(item.get("id"))
                push(item.get("name"))
    unique: List[str] = []
    for model in ids:
        if model not in unique:
            unique.append(model)
    return unique[:2000]


def pick_stream_reader(response: Any) -> Optional[Any]:
    """选择低延迟的流式读取器。

    response.read(8192) 会等满 8192 字节才返回，SSE 小帧因此被攒住。这里改成 read1：
    底层缓冲里有多少就先返回多少。带 Content-Length 或 chunked 的上游必须走
    HTTPResponse.read1，它负责长度记账与分块头解析；只有连接关闭定界（长度未知且未
    分块）时才直接读 fp.read1。都没有时退回逐行读取，SSE 帧本身以换行分隔。
    """
    if getattr(response, "chunked", False) or getattr(response, "length", None) is not None:
        reader = getattr(response, "read1", None)
        if callable(reader):
            return reader
    raw = getattr(response, "fp", None)
    reader = getattr(raw, "read1", None)
    if callable(reader):
        return reader
    reader = getattr(response, "read1", None)
    return reader if callable(reader) else None


def declared_content_length(response: Any) -> Optional[int]:
    """上游声明的合法整数 Content-Length；缺失、非整数或负数一律视为未声明。"""
    try:
        raw = response.headers.get("Content-Length")
    except AttributeError:
        return None
    if raw is None:
        return None
    text = str(raw).strip()
    if not text.isdigit():
        return None
    try:
        return int(text)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------


class ConsoleHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    server_version = "EngineeringAIConsole/" + VERSION
    sys_version = ""
    # 慢客户端不允许长期占住线程
    timeout = 30

    # ---------- 基础响应 ----------

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: N802
        # 不记录请求头与令牌；失败信息由上层显式输出
        return

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
            "font-src 'self' data:; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        )

    def send_json(self, status: int, payload: Any, extra_headers: Optional[dict] = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def send_error_json(self, status: int, message: str, code: Optional[str] = None) -> None:
        error: Dict[str, Any] = {"message": redact_local_paths(message)}
        if code:
            error["code"] = code
        self.send_json(status, {"error": error})

    # ---------- 授权 ----------

    def _expected_origin(self) -> str:
        port = self.server.server_port
        return "http://127.0.0.1:%d" % port

    def check_host_header(self) -> bool:
        """所有请求入口的第一道检查：只接受环回地址 + 本服务实际端口的 Host。"""
        host = (self.headers.get("Host") or "").strip().lower()
        port = self.server.server_port
        allowed = {"127.0.0.1:%d" % port, "localhost:%d" % port}
        if port == 80:
            allowed.update({"127.0.0.1", "localhost"})
        if host in allowed:
            return True
        self.send_error_json(403, "invalid Host header")
        return False

    def authorize_origin_only(self) -> bool:
        origin = self.headers.get("Origin")
        if origin is not None and origin != self._expected_origin():
            self.send_error_json(403, "cross-origin request rejected")
            return False
        return True

    def authorize_api(self) -> bool:
        token = self.headers.get("X-Console-Token", "")
        if not token or not pysecrets.compare_digest(token, SESSION_TOKEN):
            self.send_error_json(403, "invalid console session token")
            return False
        return self.authorize_origin_only()

    # ---------- 请求体 ----------

    def read_body(self, max_bytes: int) -> Optional[bytes]:
        if self.headers.get("Transfer-Encoding"):
            self.send_error_json(400, "chunked request bodies are not accepted")
            return None
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            self.send_error_json(400, "missing Content-Length")
            return None
        try:
            length = int(length_header)
        except ValueError:
            self.send_error_json(400, "invalid Content-Length")
            return None
        if length <= 0:
            self.send_error_json(400, "empty request body")
            return None
        if length > max_bytes:
            self.send_error_json(413, "request body exceeds the %d byte limit" % max_bytes)
            return None
        data = self.rfile.read(length)
        if len(data) != length:
            self.send_error_json(400, "incomplete request body")
            return None
        return data

    def read_json_body(self, max_bytes: int) -> Optional[Any]:
        data = self.read_body(max_bytes)
        if data is None:
            return None
        try:
            return json.loads(data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self.send_error_json(400, "request body is not valid JSON")
            return None

    # ---------- 静态文件 ----------

    def resolve_static_path(self, raw_path: str) -> Optional[Path]:
        if not DIST_DIR.is_dir():
            return None
        path_only = urllib.parse.urlparse(raw_path).path
        try:
            decoded = urllib.parse.unquote(path_only)
        except ValueError:
            return None
        if decoded in ("", "/"):
            decoded = "/index.html"
        if "\x00" in decoded:
            return None
        relative = decoded.lstrip("/")
        try:
            candidate = (DIST_DIR / relative).resolve()
        except (OSError, RuntimeError):
            return None
        if not candidate.is_relative_to(DIST_DIR):
            return None
        if candidate.is_dir():
            candidate = candidate / "index.html"
        # 拼上 index.html 之后重新 resolve 再校验一次，符号链接不能把读取带出 dist/
        try:
            target = candidate.resolve()
        except (OSError, RuntimeError):
            return None
        if not target.is_relative_to(DIST_DIR) or not target.is_file():
            return None
        return target

    def inject_session_token(self, html: str) -> str:
        meta = '<meta name="console-session-token" content="%s">' % SESSION_TOKEN
        # 已有同名 meta 时先移除，避免重复
        html = re.sub(
            r'<meta\s+name="console-session-token"[^>]*>', "", html, flags=re.I
        )
        match = re.search(r"<head[^>]*>", html, flags=re.I)
        if match:
            return html[: match.end()] + meta + html[match.end() :]
        return meta + html

    def serve_static(self, raw_path: str, head_only: bool = False) -> None:
        path = self.resolve_static_path(raw_path)
        if path is None:
            if raw_path.startswith("/api/"):
                self.send_error_json(404, "unknown api endpoint")
                return
            if raw_path in ("/", "/index.html") and not DIST_DIR.is_dir():
                self.send_dist_missing_page()
                return
            self.send_error_json(404, "not found")
            return
        try:
            data = path.read_bytes()
        except OSError:
            self.send_error_json(404, "not found")
            return
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if path.name == "index.html":
            try:
                html = data.decode("utf-8")
            except UnicodeDecodeError:
                html = ""
            data = self.inject_session_token(html).encode("utf-8")
            content_type = "text/html; charset=utf-8"
            cache = "no-store"
        elif path.suffix in (".js", ".css", ".woff", ".woff2", ".ttf"):
            cache = "public, max-age=3600"
        else:
            cache = "no-store"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self._security_headers()
        self.end_headers()
        if not head_only:
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    def send_dist_missing_page(self) -> None:
        body = (
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            "<title>Engineering AI Console</title></head><body>"
            "<h1>Engineering AI Console</h1>"
            "<p>The static build directory <code>dist/</code> is missing.</p>"
            "<p>Build the front end first: <code>pnpm install &amp;&amp; pnpm build</code>, "
            "or use the prebuilt <code>dist/</code> shipped with this repository.</p>"
            "</body></html>"
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    # ---------- API 实现 ----------

    @property
    def store(self) -> ConfigStore:
        return self.server.config_store  # type: ignore[attr-defined]

    def handle_health(self) -> None:
        snapshot = self.store.snapshot()
        monitor = self._lifecycle()
        self.send_json(
            200,
            {
                "ok": True,
                "service": APP_NAME,
                "version": VERSION,
                "bind": "127.0.0.1",
                "port": self.server.server_port,
                "autoExit": monitor is not None,
                # 启动器与自检用它判断真实页面是否已发出首包心跳
                "activeTabs": monitor.active_tabs() if monitor is not None else 0,
                "storage": snapshot["storage"],
            },
        )

    def handle_config_get(self) -> None:
        self.send_json(200, self.store.snapshot())

    def handle_config_post(self) -> None:
        payload = self.read_json_body(MAX_CONFIG_BODY)
        if payload is None:
            return
        if not isinstance(payload, dict):
            self.send_error_json(400, "config payload must be a JSON object")
            return
        settings = payload.get("settings")
        keys = payload.get("keys")
        clear_keys = payload.get("clearKeys")
        custom_headers = payload.get("customHeaders")
        if settings is not None and not isinstance(settings, dict):
            self.send_error_json(400, "settings must be a JSON object")
            return
        if keys is not None and not isinstance(keys, dict):
            self.send_error_json(400, "keys must be a JSON object")
            return
        if clear_keys is not None and not isinstance(clear_keys, list):
            self.send_error_json(400, "clearKeys must be an array")
            return
        if custom_headers is not None and not isinstance(custom_headers, dict):
            self.send_error_json(400, "customHeaders must be a JSON object")
            return
        if isinstance(custom_headers, dict):
            for slot, pairs in custom_headers.items():
                if not isinstance(pairs, list) or not all(isinstance(item, dict) for item in pairs):
                    self.send_error_json(
                        400, "customHeaders.%s must be an array of name/value objects" % slot
                    )
                    return
        try:
            snapshot = self.store.update(settings, keys, clear_keys, custom_headers)
        except Exception:  # noqa: BLE001 — 配置联合事务失败，绝不回显本机路径
            self.send_error_json(
                500,
                "configuration could not be saved; the previous files were restored, "
                "check the local data directory and retry",
                code="configPersistFailed",
            )
            return
        self.send_json(200, snapshot)

    # ---------- 标签页生命周期（仅 --auto-exit 时真正生效） ----------

    def _lifecycle(self) -> Optional["LifecycleMonitor"]:
        return getattr(self.server, "lifecycle", None)

    def handle_lifecycle(self) -> None:
        """POST /api/lifecycle：页面心跳与关页通知。

        与其他 /api/* 一样强制回环 Host + 同源 Origin + X-Console-Token。未开启
        --auto-exit 时接口按正常语义应答但绝不改变进程生命周期，前端因此不必区分模式。
        """
        monitor = self._lifecycle()
        payload = self.read_json_body(MAX_CONFIG_BODY)
        if payload is None:
            return
        if not isinstance(payload, dict):
            self.send_error_json(400, "lifecycle payload must be a JSON object")
            return
        action = payload.get("action")
        tab_id = payload.get("tabId")
        if action not in ("heartbeat", "leave"):
            self.send_error_json(400, "lifecycle action must be heartbeat or leave")
            return
        if (
            not isinstance(tab_id, str)
            or not tab_id.strip()
            or len(tab_id) > MAX_TAB_ID_LENGTH
        ):
            self.send_error_json(400, "lifecycle tabId is required")
            return
        tab_id = tab_id.strip()
        if monitor is None:
            self.send_json(200, {"ok": True, "autoExit": False, "activeTabs": 0})
            return
        if action == "heartbeat":
            monitor.heartbeat(tab_id)
        else:
            monitor.leave(tab_id)
        self.send_json(
            200,
            {"ok": True, "autoExit": True, "activeTabs": monitor.active_tabs()},
        )

    def _resolve_probe_channel(
        self, payload: Dict[str, Any]
    ) -> Tuple[Dict[str, Any], str, Dict[str, str]]:
        requested = payload.get("slot")
        slot = requested if requested in SLOTS else None
        base, stored, header_values = self.store.read_channel(slot)
        draft = payload.get("draft")
        if isinstance(draft, dict):
            channel = sanitize_channel(draft, base, keep_header_values=True)
            if "customHeaders" not in draft:
                channel["customHeaders"] = [dict(item) for item in base.get("customHeaders", [])]
        else:
            channel = base
        draft_key = payload.get("draftKey")
        key = draft_key.strip()[:MAX_SECRET_LENGTH] if isinstance(draft_key, str) else ""
        if not key:
            key = resolve_api_key(channel, stored)
        return channel, key, header_values

    def _fetch_models(
        self,
        channel: Dict[str, Any],
        key: str,
        header_values: Optional[Dict[str, str]] = None,
    ) -> Tuple[bool, List[str], str]:
        url = normalize_models_url(channel)
        if url is None:
            return False, [], "invalid or missing base URL"
        headers = {"Accept": "application/json"}
        apply_auth_headers(headers, channel, key)
        apply_custom_headers(headers, channel, header_values)
        apply_default_headers(headers, "application/json")
        timeout = min(MAX_TIMEOUT_SEC, max(5, int(channel.get("requestTimeoutSec", 60))))
        request = urllib.request.Request(url, headers=headers, method="GET")
        opener = build_opener(channel)
        try:
            with opener.open(request, timeout=timeout) as response:
                raw = response.read(MAX_UPSTREAM_JSON)
                try:
                    models = parse_model_list(json.loads(raw.decode("utf-8", "replace")))
                except ValueError:
                    models = []
                return True, models, ""
        except urllib.error.HTTPError as error:
            message = "HTTP %d: %s" % (
                error.code,
                redact_local_paths(upstream_error_message(error)),
            )
            # 404/405/501 通常表示端点存在但不提供 /models；连接本身可达
            reachable = error.code in (404, 405, 501)
            return reachable, [], message
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as error:
            reason = getattr(error, "reason", error)
            return False, [], _redacted_reason(reason)
        except OSError as error:
            return False, [], _redacted_reason(error)

    def handle_ping(self) -> None:
        payload = self.read_json_body(MAX_CONFIG_BODY)
        if payload is None:
            return
        if not isinstance(payload, dict):
            self.send_error_json(400, "ping payload must be a JSON object")
            return
        channel, key, header_values = self._resolve_probe_channel(payload)
        reachable, models, message = self._fetch_models(channel, key, header_values)
        self.send_json(
            200,
            {
                "reachable": reachable,
                "modelsAvailable": bool(models),
                "message": message,
            },
        )

    def handle_models(self) -> None:
        payload = self.read_json_body(MAX_CONFIG_BODY)
        if payload is None:
            return
        if not isinstance(payload, dict):
            self.send_error_json(400, "models payload must be a JSON object")
            return
        channel, key, header_values = self._resolve_probe_channel(payload)
        reachable, models, message = self._fetch_models(channel, key, header_values)
        self.send_json(
            200,
            {
                "reachable": reachable,
                "models": models,
                "message": message,
            },
        )

    def handle_chat_stream(self) -> None:
        payload = self.read_json_body(MAX_STREAM_BODY)
        if payload is None:
            return
        if not isinstance(payload, dict):
            self.send_error_json(400, "chat payload must be a JSON object")
            return
        slot = payload.get("slot")
        if slot not in SLOTS:
            self.send_error_json(400, "unknown channel slot")
            return
        body = payload.get("payload")
        if not isinstance(body, dict):
            self.send_error_json(400, "missing normalized request payload")
            return
        channel, stored, header_values = self.store.read_channel(slot)
        url = normalize_chat_url(channel)
        if url is None:
            self.send_error_json(400, "channel base URL is invalid or incomplete")
            return
        key = resolve_api_key(channel, stored)
        headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        apply_auth_headers(headers, channel, key, beta=bool(channel.get("enableRemoteFileApi")))
        apply_custom_headers(headers, channel, header_values)
        apply_default_headers(headers, "text/event-stream")
        timeout = min(MAX_TIMEOUT_SEC, max(5, int(channel.get("requestTimeoutSec", 60))))
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(url, data=data, headers=headers, method="POST")
        opener = build_opener(channel)
        try:
            response = opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            message = redact_local_paths(upstream_error_message(error))
            body_bytes = json.dumps(
                {"error": {"message": message}}, ensure_ascii=False
            ).encode("utf-8")
            self.send_response(error.code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body_bytes)))
            self.send_header("Cache-Control", "no-store")
            self._security_headers()
            self.end_headers()
            try:
                self.wfile.write(body_bytes)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            return
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as error:
            reason = getattr(error, "reason", error)
            self.send_error_json(502, "upstream request failed: %s" % _redacted_reason(reason))
            return
        except OSError as error:
            self.send_error_json(502, "upstream request failed: %s" % _redacted_reason(error))
            return

        upstream_type = (response.headers.get("Content-Type") or "").lower()
        if "text/event-stream" not in upstream_type and (
            "application/json" in upstream_type or "text/plain" in upstream_type
        ):
            # 网关无视 stream:true：把整段 JSON 错误体 / 完整回复 / 纯文本原样回给前端，
            # 由前端一次性解析。继续按 SSE 转发的话前端一个事件都读不到，只会误报“流提前结束”。
            try:
                raw = response.read(MAX_UPSTREAM_JSON)
            except (socket.timeout, TimeoutError, ConnectionError, OSError) as error:
                reason = getattr(error, "reason", error)
                self.send_error_json(
                    502, "upstream request failed: %s" % _redacted_reason(reason)
                )
                return
            finally:
                try:
                    response.close()
                except Exception:  # noqa: BLE001 — 关闭上游失败不影响当前响应
                    pass
            content_type = (
                "application/json; charset=utf-8"
                if "application/json" in upstream_type
                else "text/plain; charset=utf-8"
            )
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self._security_headers()
            self.end_headers()
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self._security_headers()
        self.end_headers()
        # 响应头一旦发出，后面的一切失败都只能用标准 SSE error 事件表达，
        # 绝不能再往正文里塞第二套 HTTP 500 响应头。
        self._stream_started = True
        reader = pick_stream_reader(response)
        expected_length = declared_content_length(response)
        total_read = 0
        client_gone = False
        premature = False
        try:
            while True:
                # 有数据就透传，绝不等满固定缓冲；小帧毫秒级到达前端。
                # 上游读取异常（TCP RST / 读超时 / 分块损坏）与本地写客户端失败必须分开：
                # 前者是上游中断，流已开始后只能发标准 SSE error 帧；后者只是客户端断开。
                try:
                    chunk = reader(4096) if reader is not None else response.readline()
                except Exception as error:  # noqa: BLE001 — 上游读超时 / 连接中断 / 分块错误
                    self.send_stream_error(
                        "streamInterrupted",
                        "upstream stream interrupted: %s"
                        % _redacted_reason(getattr(error, "reason", error)),
                    )
                    break
                if not chunk:
                    # 上游声明了 Content-Length 却提前干净关闭：这是截断，不是正常结束
                    if expected_length is not None and total_read < expected_length:
                        premature = True
                    break
                total_read += len(chunk)
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError, OSError):
                    # 前端看门狗 / 用户停止 / 软复位导致断开：安静退出，不打印堆栈
                    client_gone = True
                    break
        finally:
            try:
                response.close()
            except Exception:  # noqa: BLE001 — 关闭上游失败不影响当前请求线程
                pass
        if premature and not client_gone:
            self.send_premature_length_error()

    def send_premature_length_error(self) -> None:
        """上游按 Content-Length 提前断开：补发一条标准 SSE error 帧，提示响应被截断。"""
        payload = json.dumps(
            {"error": "Upstream closed prematurely before Content-Length"}
        )
        frame = ("\n\nevent: error\ndata: %s\n\n" % payload).encode("utf-8")
        try:
            self.wfile.write(frame)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass

    def send_stream_error(self, code: str, message: str) -> None:
        """SSE 已开始后唯一合法的错误通道：一条 event: error 事件后关闭流。

        帧首统一前置两个换行：上游可能在半截未换行的数据后超时 / 重置，
        先终止那条不完整的行，客户端才能解析出独立合法的 event: error 事件。
        """
        payload = json.dumps(
            {"error": {"code": code, "message": redact_local_paths(message)}},
            ensure_ascii=False,
        )
        frame = ("\n\nevent: error\ndata: %s\n\n" % payload).encode("utf-8")
        try:
            self.wfile.write(frame)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass

    def handle_exa_search(self) -> None:
        payload = self.read_json_body(MAX_CONFIG_BODY)
        if payload is None:
            return
        if not isinstance(payload, dict):
            self.send_error_json(400, "search payload must be a JSON object")
            return
        query = payload.get("query")
        if not isinstance(query, str) or not query.strip():
            self.send_error_json(400, "missing search query")
            return
        query = query.strip()[:MAX_QUERY_LENGTH]
        exa, stored_exa_key = self.store.read_exa()
        endpoint = _trimmed(exa.get("endpoint"), "", 2048)
        if not is_http_url(endpoint):
            self.send_error_json(400, "invalid Exa endpoint")
            return
        env_name = _trimmed(exa.get("apiKeyEnv"), "", 120)
        key = ""
        if env_name:
            key = os.environ.get(env_name, "").strip()
        if not key:
            key = stored_exa_key
        try:
            num_results = int(_number(payload.get("numResults"), exa.get("numResults", 5), 1, 10))
        except (TypeError, ValueError):
            num_results = 5
        body = json.dumps(
            {
                "query": query,
                "numResults": num_results,
                "contents": {"text": {"maxCharacters": 600}},
            },
            ensure_ascii=False,
        ).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if key:
            headers["x-api-key"] = key
        apply_default_headers(headers, "application/json")
        request = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
        # 检索通道不跟随聊天通道代理；使用系统代理即可
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler(), SameOriginRedirectHandler()
        )
        try:
            with opener.open(request, timeout=30) as response:
                raw = response.read(MAX_UPSTREAM_JSON)
            parsed = json.loads(raw.decode("utf-8", "replace"))
        except urllib.error.HTTPError as error:
            self.send_error_json(502, "search request failed: %s" % upstream_error_message(error))
            return
        except (urllib.error.URLError, socket.timeout, TimeoutError, ValueError, OSError) as error:
            reason = getattr(error, "reason", error)
            self.send_error_json(502, "search request failed: %s" % reason)
            return

        results: List[Dict[str, str]] = []
        raw_results = parsed.get("results") if isinstance(parsed, dict) else None
        if isinstance(raw_results, list):
            for item in raw_results[:10]:
                if not isinstance(item, dict):
                    continue
                url = item.get("url")
                if not isinstance(url, str) or not url:
                    continue
                title = item.get("title") if isinstance(item.get("title"), str) else url
                snippet_source = item.get("text") or item.get("snippet") or item.get("summary") or ""
                if isinstance(snippet_source, list):
                    snippet = " ".join(str(part) for part in snippet_source)
                else:
                    snippet = str(snippet_source)
                results.append(
                    {
                        "title": title[:300],
                        "url": url[:2048],
                        "text": " ".join(snippet.split())[:600],
                    }
                )
        self.send_json(200, {"results": results})

    def handle_file_upload(self) -> None:
        slot = self.headers.get("X-Console-Slot", "")
        channel, stored, header_values = self.store.read_channel(slot if slot in SLOTS else None)
        # 先做有界读取（超限直接 413），再检查内容类型与通道开关
        body = self.read_body(MAX_FILE_BODY)
        if body is None:
            return
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("multipart/form-data"):
            self.send_error_json(400, "file upload must be multipart/form-data")
            return
        if not channel.get("enableRemoteFileApi"):
            self.send_error_json(403, "remote file API is disabled for this channel")
            return
        if channel.get("protocol") != "anthropic":
            self.send_error_json(400, "remote file API requires the Anthropic protocol")
            return
        url = normalize_files_url(channel)
        if url is None:
            self.send_error_json(400, "channel base URL is invalid or incomplete")
            return
        key = resolve_api_key(channel, stored)
        headers = {"Content-Type": content_type}
        apply_auth_headers(headers, channel, key, beta=True)
        apply_custom_headers(headers, channel, header_values)
        apply_default_headers(headers, "application/json")
        timeout = min(MAX_TIMEOUT_SEC, max(5, int(channel.get("requestTimeoutSec", 60))))
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        opener = build_opener(channel)
        try:
            with opener.open(request, timeout=timeout) as response:
                raw = response.read(MAX_UPSTREAM_JSON)
                status = response.status
        except urllib.error.HTTPError as error:
            self.send_error_json(502, upstream_error_message(error))
            return
        except (urllib.error.URLError, socket.timeout, TimeoutError, OSError) as error:
            reason = getattr(error, "reason", error)
            self.send_error_json(502, "file upload failed: %s" % reason)
            return
        try:
            parsed = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            self.send_error_json(502, "invalid JSON response from upstream file API")
            return
        self.send_json(status if 200 <= status < 300 else 502, parsed)

    def handle_file_delete(self) -> None:
        payload = self.read_json_body(MAX_CONFIG_BODY)
        if payload is None:
            return
        if not isinstance(payload, dict):
            self.send_error_json(400, "delete payload must be a JSON object")
            return
        slot = payload.get("slot")
        if slot not in SLOTS:
            self.send_error_json(400, "unknown channel slot")
            return
        file_id = payload.get("fileId")
        if not isinstance(file_id, str) or not file_id.strip():
            self.send_error_json(400, "missing file id")
            return
        channel, stored, header_values = self.store.read_channel(slot)
        if not channel.get("enableRemoteFileApi"):
            self.send_error_json(403, "remote file API is disabled for this channel")
            return
        base = normalize_files_url(channel)
        if base is None:
            self.send_error_json(400, "channel base URL is invalid or incomplete")
            return
        url = base + "/" + urllib.parse.quote(file_id.strip(), safe="")
        key = resolve_api_key(channel, stored)
        headers: Dict[str, str] = {}
        apply_auth_headers(headers, channel, key, beta=True)
        apply_custom_headers(headers, channel, header_values)
        apply_default_headers(headers, "application/json")
        timeout = min(MAX_TIMEOUT_SEC, max(5, int(channel.get("requestTimeoutSec", 60))))
        request = urllib.request.Request(url, headers=headers, method="DELETE")
        opener = build_opener(channel)
        try:
            with opener.open(request, timeout=timeout) as response:
                status = response.status
        except urllib.error.HTTPError as error:
            self.send_error_json(502, upstream_error_message(error))
            return
        except (urllib.error.URLError, socket.timeout, TimeoutError, OSError) as error:
            reason = getattr(error, "reason", error)
            self.send_error_json(502, "file delete failed: %s" % reason)
            return
        self.send_json(200 if 200 <= status < 300 else 502, {"ok": 200 <= status < 300})

    # ---------- 路由 ----------

    def do_OPTIONS(self) -> None:  # noqa: N802
        if not self.check_host_header():
            return
        self.send_error_json(403, "cross-origin preflight rejected")

    def do_HEAD(self) -> None:  # noqa: N802
        if not self.check_host_header():
            return
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/"):
            self.send_error_json(404, "unknown api endpoint")
            return
        self.serve_static(self.path, head_only=True)

    def do_GET(self) -> None:  # noqa: N802
        if not self.check_host_header():
            return
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/api/"):
            self.serve_static(self.path)
            return
        # GET /api/health 允许免令牌（仅供启动器探测在线实例），Origin 仍须精确同源
        if path == "/api/health":
            if not self.authorize_origin_only():
                return
            try:
                self.handle_health()
            except Exception:  # noqa: BLE001 — 兜底，避免线程崩溃与堆栈泄露路径
                self.send_error_json(500, "internal server error")
            return
        if not self.authorize_api():
            return
        monitor = self._lifecycle()
        tracked = monitor is not None and path in INFLIGHT_PATHS
        if tracked:
            monitor.begin_request()
        try:
            if path == "/api/config":
                self.handle_config_get()
            else:
                self.send_error_json(404, "unknown api endpoint")
        except Exception:  # noqa: BLE001 — 兜底，避免线程崩溃与堆栈泄露路径
            self.send_error_json(500, "internal server error")
        finally:
            if tracked:
                monitor.end_request()

    def do_POST(self) -> None:  # noqa: N802
        if not self.check_host_header():
            return
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/api/"):
            self.send_error_json(404, "not found")
            return
        if not self.authorize_api():
            return
        monitor = self._lifecycle()
        tracked = monitor is not None and path in INFLIGHT_PATHS
        if tracked:
            monitor.begin_request()
        try:
            if path == "/api/config":
                self.handle_config_post()
            elif path == "/api/ping":
                self.handle_ping()
            elif path == "/api/models":
                self.handle_models()
            elif path == LIFECYCLE_PATH:
                self.handle_lifecycle()
            elif path == "/api/search/exa":
                self.handle_exa_search()
            elif path == "/api/chat/stream":
                self.handle_chat_stream()
            elif path == "/api/files/upload":
                self.handle_file_upload()
            else:
                self.send_error_json(404, "unknown api endpoint")
        except BrokenPipeError:
            pass
        except Exception:  # noqa: BLE001
            # SSE 响应头一旦发出，二次错误响应会污染流正文；此时只允许静默收尾
            if getattr(self, "_stream_started", False):
                return
            self.send_error_json(500, "internal server error")
        finally:
            if tracked:
                monitor.end_request()

    def do_DELETE(self) -> None:  # noqa: N802
        if not self.check_host_header():
            return
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/api/"):
            self.send_error_json(404, "not found")
            return
        if not self.authorize_api():
            return
        try:
            if path == "/api/files":
                self.handle_file_delete()
            else:
                self.send_error_json(404, "unknown api endpoint")
        except Exception:  # noqa: BLE001
            self.send_error_json(500, "internal server error")


class ConsoleServer(ThreadingHTTPServer):
    daemon_threads = True
    # Windows 上 SO_REUSEADDR 允许多个进程绑定同一端口，会导致端口自愈失效；
    # 因此仅在 POSIX 上启用（用于 TIME_WAIT 复用）。
    allow_reuse_address = os.name != "nt"

    def __init__(self, address: Tuple[str, int], data_dir: Path) -> None:
        super().__init__(address, ConsoleHandler)
        self.config_store = ConfigStore(data_dir)
        # 只有 --auto-exit 启动时才会挂上监控器；默认 None 表示进程常驻
        self.lifecycle: Optional[LifecycleMonitor] = None

    def handle_error(self, request: Any, client_address: Any) -> None:
        """请求线程异常只写一条脱敏摘要：绝不打印路径、请求体或密钥，且写日志失败也不扩散。"""
        exc_type, exc_value, _traceback = sys.exc_info()
        if exc_type is None:
            write_stderr_safely("request handler error\n")
            return
        write_stderr_safely(
            "".join(traceback.format_exception_only(exc_type, exc_value))
        )


class LifecycleMonitor:
    """--auto-exit：控制台页面标签页生命周期联动。

    只有在显式传入 --auto-exit 时才创建，默认常驻启动（自动化测试、`python server.py
    --no-browser`）完全不受影响。语义：

    - 启动后最多等 60 秒首个标签页心跳，始终没有页面就把进程一起回收；
    - heartbeat 刷新该 tabId 的时间戳，leave 移除标签页；
    - 活跃标签数归零后先等 5 秒刷新缓冲，期间任何新心跳（F5 / 硬复位重载）都会取消关停；
    - 标签页静默超过 600 秒视为浏览器崩溃：后台最小化被节流到 1 分钟以上也不会误杀；
    - 只有当前没有在途 /api/chat 或 /api/config 请求时才调用 httpd.shutdown() 干净退出。
    """

    def __init__(
        self,
        httpd: Any,
        startup_grace: float = LIFECYCLE_STARTUP_GRACE_SEC,
        refresh_buffer: float = LIFECYCLE_REFRESH_BUFFER_SEC,
        silent_timeout: float = LIFECYCLE_SILENT_TIMEOUT_SEC,
        tick: float = LIFECYCLE_TICK_SEC,
    ) -> None:
        self._httpd = httpd
        self._startup_grace = max(0.0, startup_grace)
        self._refresh_buffer = max(0.0, refresh_buffer)
        self._silent_timeout = max(1.0, silent_timeout)
        self._tick = max(0.05, tick)
        self._lock = threading.Lock()
        self._tabs: Dict[str, float] = {}
        self._seen_tab = False
        self._started_at = time.monotonic()
        self._leave_deadline: Optional[float] = None
        self._inflight = 0
        self._stopping = threading.Event()
        self._thread = threading.Thread(
            target=self._run, name="console-lifecycle", daemon=True
        )

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stopping.set()

    def heartbeat(self, tab_id: str) -> None:
        now = time.monotonic()
        with self._lock:
            self._tabs[tab_id] = now
            self._seen_tab = True
            # 刷新 / 新标签页在缓冲期内到达：取消关停
            self._leave_deadline = None

    def leave(self, tab_id: str) -> None:
        now = time.monotonic()
        with self._lock:
            self._tabs.pop(tab_id, None)
            self._seen_tab = True
            if not self._tabs and self._leave_deadline is None:
                self._leave_deadline = now + self._refresh_buffer

    def active_tabs(self) -> int:
        with self._lock:
            return len(self._tabs)

    def begin_request(self) -> None:
        with self._lock:
            self._inflight += 1

    def end_request(self) -> None:
        with self._lock:
            if self._inflight > 0:
                self._inflight -= 1

    def _should_shutdown_locked(self, now: float) -> bool:
        # 浏览器异常崩溃（或被系统杀掉）不会再发 leave：静默超时后按关页处理
        for tab_id, last_seen in list(self._tabs.items()):
            if now - last_seen >= self._silent_timeout:
                del self._tabs[tab_id]
        if self._tabs or self._inflight > 0:
            return False
        if not self._seen_tab:
            # 启动后始终没有页面连上来（例如 pythonw 拉起了服务但浏览器被拦下）
            return now - self._started_at >= self._startup_grace
        if self._leave_deadline is None:
            # 标签页全部被静默回收：同样给一个刷新缓冲，再干净关停
            self._leave_deadline = now + self._refresh_buffer
            return False
        return now >= self._leave_deadline

    def _run(self) -> None:
        while not self._stopping.wait(self._tick):
            with self._lock:
                shutdown = self._should_shutdown_locked(time.monotonic())
            if shutdown:
                try:
                    self._httpd.shutdown()
                except Exception:  # noqa: BLE001 — 监控线程的回收失败不能拖垮进程
                    pass
                return


def create_server(data_dir: Path, start_port: int, span: int = PORT_SCAN_SPAN) -> ConsoleServer:
    """从 start_port 起向上尝试 span+1 个连续端口。"""
    host = "127.0.0.1"
    for offset in range(0, span + 1):
        port = start_port + offset
        try:
            return ConsoleServer((host, port), data_dir)
        except OSError:
            continue
    raise SystemExit(
        "No free port in range %d..%d on 127.0.0.1" % (start_port, start_port + span)
    )


def probe_running_instance(port: int, timeout: float = HEALTH_PROBE_TIMEOUT_SEC) -> bool:
    """探测本机端口上是否已有本程序实例；只访问免令牌的 /api/health，不走系统代理。"""
    url = _local_url(port) + "/api/health"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(MAX_ERROR_BODY)
    except Exception:  # noqa: BLE001 — 端口扫描必须对任意无关协议的响应保持静默
        return False
    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
    except (ValueError, UnicodeDecodeError):
        return False
    return isinstance(payload, dict) and payload.get("service") == APP_NAME


def find_running_instance(
    start_port: Optional[int] = None, span: Optional[int] = None
) -> Optional[int]:
    """扫描默认端口段（18765..18795），返回第一个在线的本主控台实例端口。

    只认 /api/health 里专属 service 标识；无关程序占用该端口不会误判。
    多个端口同时探测，避免 31 个端口逐个等超时拖慢默认启动。
    """
    first = DEFAULT_PORT if start_port is None else start_port
    count = PORT_SCAN_SPAN if span is None else span
    ports = [first + offset for offset in range(0, count + 1)]
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(HEALTH_SCAN_WORKERS, len(ports))
    ) as executor:
        matches = list(executor.map(probe_running_instance, ports))
    for port, matched in zip(ports, matches):
        if matched:
            return port
    return None


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Engineering AI Console local micro-service (127.0.0.1 only)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help=(
            "preferred port; omit it to reuse a running instance found in %d..%d "
            "or fall back to %d..%d"
            % (
                DEFAULT_PORT,
                DEFAULT_PORT + PORT_SCAN_SPAN,
                DEFAULT_PORT + 1,
                DEFAULT_PORT + PORT_SCAN_SPAN,
            )
        ),
    )
    parser.add_argument(
        "--no-browser", action="store_true", help="do not open the default browser"
    )
    parser.add_argument(
        "--auto-exit",
        action="store_true",
        help=(
            "stop the service about %d s after the last console tab closes "
            "(used by the double-click launchers; refresh within the buffer is safe)"
            % int(LIFECYCLE_REFRESH_BUFFER_SEC)
        ),
    )
    parser.add_argument(
        "--foreground",
        action="store_true",
        help=(
            "keep the service resident in the foreground: --auto-exit is ignored even "
            "when both are passed (the launch-with-arguments contract of start.bat/start.sh)"
        ),
    )
    parser.add_argument(
        "--data-dir",
        default=str(DEFAULT_DATA_DIR),
        help="local settings/secrets directory (default .console_data)",
    )
    return parser.parse_args(argv)


def _local_url(port: int) -> str:
    return "http://127.0.0.1:%d" % port


def _start_on_default_port(data_dir: Path) -> Optional[ConsoleServer]:
    """未显式指定端口：先扫描 18765..18795 是否有本程序实例；有则复用，无则从 18765 起绑定。"""
    global DETECTED_INSTANCE_PORT
    running = find_running_instance(DEFAULT_PORT, PORT_SCAN_SPAN)
    if running is not None:
        DETECTED_INSTANCE_PORT = running
        return None
    try:
        return ConsoleServer(("127.0.0.1", DEFAULT_PORT), data_dir)
    except OSError:
        pass
    # 默认端口被别的程序占用：按契约顺延 18766..18795
    return create_server(data_dir, DEFAULT_PORT + 1, PORT_SCAN_SPAN - 1)


def main(argv: Optional[List[str]] = None) -> int:
    # pythonw.exe 下标准流可能是 None / 不可写：先兜底，后面所有 print 与错误日志才安全
    ensure_console_streams()
    args = parse_args(argv)
    data_dir = Path(args.data_dir).expanduser().resolve()
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        print("Failed to create data directory: %s" % error, file=sys.stderr)
        return 1
    if args.port is None:
        server = _start_on_default_port(data_dir)
        if server is None:
            existing_port = DETECTED_INSTANCE_PORT or DEFAULT_PORT
            existing_url = _local_url(existing_port)
            print("Engineering AI Console is already running at %s" % existing_url)
            print("Reusing the running instance; this process exits now.")
            sys.stdout.flush()
            if not args.no_browser:
                webbrowser.open(existing_url)
            return 0
    else:
        server = create_server(data_dir, max(1, args.port))
    port = server.server_port
    url = _local_url(port)
    print("Engineering AI Console %s" % VERSION)
    print("Local service: %s" % url)
    print("Static root : dist/")
    # --foreground 是启动器“带参数即前台”的显式契约：与 --auto-exit 同时传入时前者优先
    auto_exit = args.auto_exit and not args.foreground
    if auto_exit:
        server.lifecycle = LifecycleMonitor(server)
        server.lifecycle.start()
        print(
            "Auto exit   : on (close every console tab to stop this service; "
            "refresh is safe)"
        )
    else:
        print("Press Ctrl+C to stop.")
    sys.stdout.flush()
    if not args.no_browser:
        timer = threading.Timer(0.4, lambda: webbrowser.open(url))
        timer.daemon = True
        timer.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        if server.lifecycle is not None:
            server.lifecycle.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    ensure_console_streams()
    raise SystemExit(main())
