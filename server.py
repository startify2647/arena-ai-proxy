"""
arena2api - Arena.ai to OpenAI API Proxy
=========================================

极简设计：Chrome 扩展提供 reCAPTCHA token 和 cookies，
本服务器负责 OpenAI 格式转换和 arena.ai API 调用。

使用方式：
  1. pip install -r requirements.txt
  2. python server.py
  3. 安装 Chrome 扩展，打开 arena.ai
  4. 在 OpenAI 客户端中配置 http://localhost:9090/v1
"""

import asyncio
import json
import logging
import os
import re
import secrets
import time
import uuid
from typing import Optional

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import StreamingResponse, JSONResponse

# ============================================================
# 日志
# ============================================================
logging.basicConfig(
    level=logging.DEBUG if os.environ.get("DEBUG") else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("arena2api")

# ============================================================
# 配置
# ============================================================
PORT = int(os.environ.get("PORT", "9090"))
API_KEY = os.environ.get("API_KEY", "").strip()
ARENA_BASE = "https://arena.ai"
ARENA_CREATE_EVAL = f"{ARENA_BASE}/nextjs-api/stream/create-evaluation"
ARENA_POST_EVAL = f"{ARENA_BASE}/nextjs-api/stream/post-to-evaluation"  # + /{id}

# Agent Mode endpoints (reverse-engineered from arena.ai web bundles)
ARENA_CREATE_CHAT = f"{ARENA_BASE}/nextjs-api/stream/create-chat"
ARENA_TRIGGER_SESSION = f"{ARENA_BASE}/api/chat/trigger-session"
ARENA_REALTIME = f"{ARENA_BASE}/ai-proxy/realtime/v1/sessions"  # + /{sid}/in/append | /{sid}/out

# Agent behaviour tuning
AGENT_REPLAY_MAX = int(os.environ.get("AGENT_REPLAY_MAX", "3"))      # حداکثر پیام تاریخچه که «زنده» بازپخش می‌شود
AGENT_SESSION_TTL = float(os.environ.get("AGENT_SESSION_TTL", "1800"))  # عمر کش گفتگو (ثانیه)
AGENT_TURN_TIMEOUT = float(os.environ.get("AGENT_TURN_TIMEOUT", "600"))  # مهلت کامل یک نوبت ایجنت
AGENT_STALL_TIMEOUT = float(os.environ.get("AGENT_STALL_TIMEOUT", "120"))  # مهلت سکون استریم

# reCAPTCHA
# فقط جهت مستندسازی — افزونه سایت‌کی را خودکار از صفحه تشخیص می‌دهد
RECAPTCHA_V3_SITEKEY = "6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0"  # قبلی: 6Led_uYr...

# ============================================================
# UUIDv7
# ============================================================
def uuid7() -> str:
    ts = int(time.time() * 1000)
    ra = secrets.randbits(12)
    rb = secrets.randbits(62)
    u = ts << 80 | (0x7000 | ra) << 64 | (0x8000000000000000 | rb)
    h = f"{u:032x}"
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


# ============================================================
# Token / Cookie Store（从扩展接收）
# ============================================================
class Store:
    def __init__(self):
        self.cookies: dict = {}
        self.auth_token: str = ""
        self.cf_clearance: str = ""
        self.user_agent: str = ""   # UA مرورگر — باید با کوکی cf_clearance یکی باشد
        self.v3_tokens: list = []  # [{token, action, ts}]
        self.v2_token: Optional[dict] = None
        self.last_push: float = 0
        self.models: list = []
        self.text_models: dict = {}  # publicName -> id
        self.image_models: dict = {}
        self.vision_models: list = []
        self.next_actions: dict = {}  # action name -> hash

    @property
    def active(self) -> bool:
        return self.last_push > 0 and (time.time() - self.last_push < 120)

    def push(self, data: dict):
        self.last_push = time.time()
        if data.get("cookies"):
            self.cookies = data["cookies"]
        if data.get("auth_token"):
            self.auth_token = data["auth_token"]
        if data.get("cf_clearance"):
            self.cf_clearance = data["cf_clearance"]
        if data.get("user_agent"):
            self.user_agent = str(data["user_agent"])[:300]
        # V3 tokens
        if data.get("v3_tokens"):
            for t in data["v3_tokens"]:
                tok = t.get("token", "")
                if not tok or len(tok) < 20:
                    continue
                age = t.get("age_ms", 0)
                if age > 120000:
                    continue
                if any(x["token"] == tok for x in self.v3_tokens):
                    continue
                self.v3_tokens.append({
                    "token": tok,
                    "action": t.get("action", "chat_submit"),
                    "ts": time.time() - age / 1000,
                })
            while len(self.v3_tokens) > 10:
                self.v3_tokens.pop(0)
        # V2 token
        if data.get("v2_token"):
            v2 = data["v2_token"]
            if v2.get("token") and v2.get("age_ms", 0) < 120000:
                self.v2_token = {
                    "token": v2["token"],
                    "ts": time.time() - v2.get("age_ms", 0) / 1000,
                }
        # Models
        if data.get("models"):
            self._update_models(data["models"])
        # Next actions
        if data.get("next_actions"):
            self.next_actions.update(data["next_actions"])

    def _update_models(self, models: list):
        self.models = models
        self.text_models = {}
        self.image_models = {}
        self.vision_models = []
        for m in models:
            name = m.get("publicName", "")
            # [PATCH] اگر مدل نام واقعی (publicName) ندارد، نادیده‌اش بگیر
            # تا UUID به‌جای نام در /v1/models نمایش داده نشود
            if not name or not isinstance(name, str):
                continue
            mid = m.get("id", "")
            caps = m.get("capabilities", {}) or {}
            out_caps = caps.get("outputCapabilities", []) or {}
            in_caps = caps.get("inputCapabilities", []) or {}
            if "text" in out_caps:
                self.text_models[name] = mid
            if "image" in out_caps:
                self.image_models[name] = mid
            if "image" in in_caps:
                self.vision_models.append(name)

    def pop_v3_token(self, action: Optional[str] = None, strict: bool = False) -> Optional[str]:
        """برداشتن یک توکن V3. اگر action داده شود، توکن با همان action ترجیح دارد.
        با strict=True فقط همان action قبول می‌شود (برای agentic_chat_submit لازم است)."""
        now = time.time()
        self.v3_tokens = [t for t in self.v3_tokens if now - t["ts"] < 120]
        if not self.v3_tokens:
            return None
        if action:
            for i, t in enumerate(self.v3_tokens):
                if t["action"] == action:
                    return self.v3_tokens.pop(i)["token"]
            if strict:
                return None
        return self.v3_tokens.pop(0)["token"]

    def count_v3(self, action: Optional[str] = None) -> int:
        now = time.time()
        return len([t for t in self.v3_tokens
                    if now - t["ts"] < 120 and (action is None or t["action"] == action)])

    def pop_v2_token(self) -> Optional[str]:
        if not self.v2_token:
            return None
        if time.time() - self.v2_token["ts"] > 120:
            self.v2_token = None
            return None
        tok = self.v2_token["token"]
        self.v2_token = None
        return tok

    def build_cookie_header(self) -> str:
        parts = []
        for k, v in self.cookies.items():
            parts.append(f"{k}={v}")
        return "; ".join(parts)

    def status(self) -> dict:
        now = time.time()
        valid_v3 = [t for t in self.v3_tokens if now - t["ts"] < 120]
        return {
            "active": self.active,
            "last_push_ago": round(now - self.last_push, 1) if self.last_push else None,
            "v3_tokens": len(valid_v3),
            "v3_chat_tokens": len([t for t in valid_v3 if t["action"] == "chat_submit"]),
            "v3_agent_tokens": len([t for t in valid_v3 if t["action"] == "agentic_chat_submit"]),
            "has_v2": bool(self.v2_token and now - self.v2_token["ts"] < 120),
            "has_auth": bool(self.auth_token),
            "has_cf": bool(self.cf_clearance),
            "user_agent": self.user_agent or None,
            "text_models": len(self.text_models),
            "image_models": len(self.image_models),
            "next_actions": list(self.next_actions.keys()),
            "cookies": list(self.cookies.keys()),
        }


store = Store()

# ============================================================
# Agent Mode — گفتگوهای چندنوبتی با یک reCAPTCHA برای کل مکالمه
# ============================================================
# پروتکل (بازیابی‌شده از باندل‌های وب arena.ai):
#   1) پیام اول:   POST /nextjs-api/stream/create-chat
#                  (نیازمند توکن reCAPTCHA با action=agentic_chat_submit)
#   2) شروع سشن:   POST /api/chat/trigger-session {sessionId, timezone}
#                  → {publicAccessToken}
#   3) پیام بعدی:  POST /ai-proxy/realtime/v1/sessions/{sid}/in/append
#                  (با Bearer=publicAccessToken — بدون reCAPTCHA)
#   4) خواندن پاسخ: GET /ai-proxy/realtime/v1/sessions/{sid}/out  (SSE)
#                  پایان نوبت: chunk.type == "trigger:turn-complete"
# ============================================================

DEFAULT_USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def current_user_agent() -> str:
    """UA همان مرورگری که اکستنشن در آن است — Cloudflare کوکی cf_clearance را به UA قفل می‌کند"""
    return store.user_agent or DEFAULT_USER_AGENT

_UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


class AgentError(Exception):
    """خطای سمت arena.ai در زنجیره‌ی ایجنت"""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class AgentConversation:
    """یک گفتگوی ایجنت که روی arena.ai زنده است"""
    __slots__ = ("session_id", "pat", "turns", "created", "touched",
                 "model_id", "lock", "last_reply")

    def __init__(self, session_id: str, pat: str, model_id: Optional[str]):
        self.session_id = session_id
        self.pat = pat                       # publicAccessToken سشن (trigger.dev)
        self.turns: list = []                # متن پیام‌های user که «مصرف» شده‌اند
        self.created = time.time()
        self.touched = time.time()
        self.model_id = model_id
        self.lock = asyncio.Lock()
        self.last_reply: str = ""            # برای پاسخ به درخواست‌های تکراری بدون هزینه


class AgentManager:
    """کش گفتگوها — تطبیق پیشوند تاریخچه برای استفاده‌ی مجدد از سشن"""

    def __init__(self):
        self.conversations: list = []

    def gc(self):
        now = time.time()
        self.conversations = [c for c in self.conversations
                              if now - c.touched < AGENT_SESSION_TTL]

    def find(self, turns: list) -> Optional[AgentConversation]:
        """گفتگویی با طولانی‌ترین turn-های سازگار با پیشوند turns"""
        self.gc()
        best = None
        for c in self.conversations:
            n = len(c.turns)
            if n == 0 or n > len(turns):
                continue
            if c.turns == turns[:n]:
                if best is None or n > len(best.turns):
                    best = c
        return best

    def add(self, conv: AgentConversation):
        self.gc()
        self.conversations.append(conv)

    def drop(self, conv: AgentConversation):
        if conv in self.conversations:
            self.conversations.remove(conv)


agent_mgr = AgentManager()


def _msg_text(content) -> str:
    """استخراج متن از content رشته‌ای یا لیست پارت‌های OpenAI"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [p.get("text", "") for p in content
                 if isinstance(p, dict) and p.get("type") == "text"]
        return "\n".join(p for p in parts if p)
    return ""


def build_agent_turns(messages: list) -> list:
    """تبدیل تاریخچه‌ی OpenAI به دنباله‌ی متن‌های user برای ایجنت.

    پیام‌های system در اولین پیام user ادغام می‌شوند؛
    پیام‌های assistant نادیده گرفته می‌شوند (arena آن‌ها را سمت سرور دارد).
    """
    system_texts, user_texts = [], []
    for m in messages:
        role = m.get("role", "")
        text = _msg_text(m.get("content", ""))
        if not text.strip():
            continue
        if role == "system":
            system_texts.append(text)
        elif role == "user":
            user_texts.append(text)
    if not user_texts:
        raise HTTPException(400, "messages must contain at least one user message")
    if system_texts:
        user_texts[0] = "\n\n".join(system_texts) + "\n\n" + user_texts[0]
    return user_texts


def _agent_headers(sid: Optional[str] = None, pat: Optional[str] = None,
                   sse: bool = False) -> dict:
    h = {
        "origin": ARENA_BASE,
        "referer": f"{ARENA_BASE}/agent/{sid}" if sid else f"{ARENA_BASE}/",
        "user-agent": current_user_agent(),
        "cookie": store.build_cookie_header(),
    }
    if sse:
        h["accept"] = "text/event-stream"
    else:
        h["accept"] = "*/*"
        h["content-type"] = "application/json"
    if pat:
        h["authorization"] = f"Bearer {pat}"
    return h


def _extract_session_id(text: str, our_msg_id: str) -> Optional[str]:
    """session id را از پاسخ create-chat استخراج می‌کند (JSON یا خام)"""
    try:
        j = json.loads(text)
        if isinstance(j, dict):
            for key in ("id", "sessionId", "chatId"):
                if isinstance(j.get(key), str) and _UUID_RE.fullmatch(j[key]):
                    return j[key]
    except Exception:
        pass
    for m in _UUID_RE.finditer(text):
        if m.group(0).lower() != our_msg_id.lower():
            return m.group(0)
    return None


async def agent_recreate(client: httpx.AsyncClient, conv: AgentConversation):
    """گرفتن publicAccessToken تازه (بدون reCAPTCHA)"""
    r = await client.post(ARENA_TRIGGER_SESSION,
                          json={"sessionId": conv.session_id, "timezone": "UTC"},
                          headers=_agent_headers(conv.session_id))
    if r.status_code != 200:
        raise AgentError(r.status_code, f"trigger-session failed: {r.text[:300]}")
    try:
        j = json.loads(r.text)
    except Exception:
        raise AgentError(502, f"trigger-session: invalid JSON: {r.text[:200]}")
    pat = j.get("publicAccessToken") or j.get("token")
    if not pat:
        raise AgentError(502, f"trigger-session: no token in response: {r.text[:200]}")
    conv.pat = pat


async def agent_create(client: httpx.AsyncClient, seed_text: str,
                       model_id: Optional[str], v3_token: Optional[str],
                       v2_token: Optional[str]) -> AgentConversation:
    """ایجاد گفتگوی جدید با پیام اول (اینجاست که reCAPTCHA مصرف می‌شود)"""
    msg_id = uuid7()
    payload = {
        "message": {"id": msg_id, "role": "user",
                    "parts": [{"type": "text", "text": seed_text}]},
        "timezone": "UTC",
    }
    if v2_token:
        payload["recaptchaV2Token"] = v2_token
        payload["recaptchaV3Token"] = None
    else:
        payload["recaptchaV3Token"] = v3_token
    if model_id:
        payload["modelId"] = model_id

    r = await client.post(ARENA_CREATE_CHAT, json=payload, headers=_agent_headers())
    if r.status_code != 200:
        raise AgentError(r.status_code, f"create-chat failed: {r.text[:300]}")
    sid = _extract_session_id(r.text, msg_id)
    if not sid:
        raise AgentError(502, f"create-chat: session id not found: {r.text[:300]}")

    conv = AgentConversation(sid, "", model_id)
    await agent_recreate(client, conv)   # publicAccessToken اولیه
    log.info(f"[agent] conversation created: {sid} (model={model_id or 'default'})")
    return conv


async def agent_append(client: httpx.AsyncClient, conv: AgentConversation, text: str):
    """ارسال پیام user بعدی روی همان سشن — بدون reCAPTCHA"""
    msg_id = uuid7()
    chunk = {
        "kind": "message",
        "payload": {
            "message": {"id": msg_id, "role": "user",
                        "parts": [{"type": "text", "text": text}]},
            "chatId": conv.session_id,
            "trigger": "submit-message",
            "messageId": msg_id,
            "metadata": {"originHost": "arena.ai", "timezone": "UTC"},
        },
    }
    url = f"{ARENA_REALTIME}/{conv.session_id}/in/append"
    for attempt in range(2):
        h = _agent_headers(conv.session_id, pat=conv.pat)
        h["x-trigger-source"] = "sdk"
        h["X-Part-Id"] = str(uuid.uuid4())
        r = await client.post(url, json=chunk, headers=h)
        if r.status_code == 200:
            return
        if r.status_code in (401, 403, 404) and attempt == 0:
            log.info(f"[agent] append got {r.status_code}, recreating session token")
            await agent_recreate(client, conv)
            continue
        raise AgentError(r.status_code, f"append failed: {r.text[:300]}")


async def agent_read_turn(client: httpx.AsyncClient, conv: AgentConversation,
                          on_delta=None) -> str:
    """خواندن پاسخ نوبت فعلی از استریم SSE تا رسیدن trigger:turn-complete.

    on_delta(str) برای هر تکه‌ی متن (فقط در صورت داده شدن) صدا زده می‌شود.
    متن کامل این نوبت بازگردانده می‌شود.
    """
    url = f"{ARENA_REALTIME}/{conv.session_id}/out"
    deadline = time.time() + AGENT_TURN_TIMEOUT
    parts: list = []
    headers = _agent_headers(conv.session_id, pat=conv.pat, sse=True)
    timeout = httpx.Timeout(connect=30.0, read=AGENT_STALL_TIMEOUT,
                            write=60.0, pool=60.0)

    for attempt in range(2):
        data_lines: list = []
        try:
            async with client.stream("GET", url, headers=headers, timeout=timeout) as resp:
                if resp.status_code != 200:
                    body = (await resp.aread()).decode("utf-8", "replace")[:300]
                    if resp.status_code in (401, 403, 404) and attempt == 0:
                        log.info(f"[agent] out-stream got {resp.status_code}, recreating token")
                        await agent_recreate(client, conv)
                        headers = _agent_headers(conv.session_id, pat=conv.pat, sse=True)
                        continue
                    raise AgentError(resp.status_code, f"out-stream failed: {body}")

                async for line in resp.aiter_lines():
                    if time.time() > deadline:
                        raise AgentError(504, "agent turn overall timeout")
                    if line.startswith(":"):
                        continue                      # کامنت/keep-alive
                    if line.startswith("data:"):
                        data_lines.append(line[5:].lstrip())
                        continue
                    if line.strip() == "":
                        if not data_lines:
                            continue                  # پایان ایونت بدون data
                        raw = "\n".join(data_lines)
                        data_lines = []
                        try:
                            ev = json.loads(raw)
                        except Exception:
                            continue
                        if not isinstance(ev, dict):
                            continue
                        # چرخش توکن در بعضی ایونت‌ها
                        evh = ev.get("headers")
                        if isinstance(evh, dict):
                            newpat = evh.get("public-access-token")
                            if isinstance(newpat, str) and newpat:
                                conv.pat = newpat
                        chunk = ev.get("chunk")
                        if not isinstance(chunk, dict):
                            chunk = ev if isinstance(ev.get("type"), str) else None
                        if not isinstance(chunk, dict):
                            continue
                        ctype = chunk.get("type")
                        if ctype == "trigger:turn-complete":
                            return "".join(parts)
                        if isinstance(ctype, str) and ctype.startswith("trigger:"):
                            continue                  # رویدادهای داخلی trigger.dev
                        if ctype == "error":
                            raise AgentError(502, f"stream error: {str(chunk)[:300]}")
                        if ctype == "text-delta":
                            d = (chunk.get("delta") or chunk.get("textDelta")
                                 or chunk.get("text") or "")
                            if d:
                                parts.append(d)
                                if on_delta:
                                    on_delta(d)
        except AgentError:
            raise
    raise AgentError(502, "out-stream: exhausted retries")


async def _agent_flow(model_name: str, messages: list, on_delta=None) -> str:
    """جریان کامل یک درخواست ایجنت؛ متن پاسخ نهایی را برمی‌گرداند."""
    turns = build_agent_turns(messages)
    conv = agent_mgr.find(turns)
    timeout = httpx.Timeout(connect=30.0, read=AGENT_STALL_TIMEOUT,
                            write=60.0, pool=60.0)

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        if conv is not None:
            # سریال‌سازی دسترسی به سشن مشترک
            await conv.lock.acquire()
        try:
            pending_seed = False
            if conv is None:
                hint = model_name.split(":", 1)[1].strip() if ":" in model_name else ""
                model_id = None
                if hint:
                    model_id = store.text_models.get(hint)
                    if not model_id:
                        for n, mid in store.text_models.items():
                            if hint.lower() in n.lower() or n.lower() in hint.lower():
                                model_id = mid
                                log.info(f"[agent] model hint '{hint}' → '{n}'")
                                break
                    if not model_id:
                        log.warning(f"[agent] model hint '{hint}' not found; using arena default")
                v3 = store.pop_v3_token("agentic_chat_submit", strict=True)
                v2 = store.pop_v2_token() if not v3 else None
                if not v3 and not v2:
                    raise HTTPException(
                        503,
                        "Agent mode needs an 'agentic_chat_submit' reCAPTCHA token. "
                        "Keep the arena.ai tab open and retry in a few seconds.")
                try:
                    if len(turns) > AGENT_REPLAY_MAX + 1:
                        # تاریخچه‌ی طولانی: همه به‌جز آخری را به‌صورت رونوشت یک‌جا بفرست
                        seed = "\n\n".join(f"<|user|>\n{t}" for t in turns[:-1])
                        conv = await agent_create(client, seed, model_id, v3, v2)
                        conv.turns = list(turns[:-1])
                    else:
                        conv = await agent_create(client, turns[0], model_id, v3, v2)
                        conv.turns = list(turns[:1])
                except AgentError as e:
                    log.error(f"[agent] create failed: {e.status} {e.message}")
                    raise HTTPException(502, f"Agent create error ({e.status}): {e.message}")
                agent_mgr.add(conv)
                await conv.lock.acquire()
                pending_seed = True

            remaining = turns[len(conv.turns):]

            if not remaining and not pending_seed:
                # تاریخچه‌ی تکراری — بدون هزینه از کش پاسخ می‌دهیم
                if conv.last_reply:
                    log.info(f"[agent] identical history; serving cached reply ({conv.session_id})")
                    if on_delta:
                        on_delta(conv.last_reply)
                    return conv.last_reply
                raise HTTPException(
                    409, "This exact conversation was already completed and no reply "
                         "is cached. Send a new message to continue.")

            try:
                # نوبت seed (پیام اول) از قبل در صف است؛ فقط باید خوانده شود
                if pending_seed:
                    emit = on_delta if not remaining else None
                    seed_reply = await agent_read_turn(client, conv, emit)
                    conv.last_reply = seed_reply
                    conv.touched = time.time()
                    if not remaining:
                        return seed_reply

                # واحدهای ارسالی: (متن روی سیم، تعداد turn منطقی مصرف‌شده)
                if len(remaining) > AGENT_REPLAY_MAX and len(remaining) > 1:
                    merged = "\n\n".join(f"<|user|>\n{t}" for t in remaining[:-1])
                    units = [(merged, len(remaining) - 1), (remaining[-1], 1)]
                else:
                    units = [(t, 1) for t in remaining]

                reply = ""
                for i, (text, count) in enumerate(units):
                    emit = on_delta if i == len(units) - 1 else None
                    await agent_append(client, conv, text)
                    reply = await agent_read_turn(client, conv, emit)
                    conv.turns = list(turns[:len(conv.turns) + count])
                    conv.touched = time.time()
                conv.last_reply = reply
                log.info(f"[agent] turn done on {conv.session_id}: "
                         f"{len(reply)} chars, turns consumed: {len(conv.turns)}")
                return reply
            except AgentError as e:
                # سشن خراب/منقضی → از کش حذفش کن تا دفعه‌ی بعد تازه ساخته شود
                log.error(f"[agent] conversation {conv.session_id} failed: {e.status} {e.message}")
                agent_mgr.drop(conv)
                raise HTTPException(502, f"Agent error ({e.status}): {e.message}")
        finally:
            if conv is not None and conv.lock.locked():
                conv.lock.release()


def _openai_chunk(chat_id: str, created: int, model: str,
                  delta: dict, finish: Optional[str] = None) -> str:
    return "data: " + json.dumps({
        "id": chat_id, "object": "chat.completion.chunk", "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }) + "\n\n"


async def _agent_stream_gen(model_name: str, messages: list, on_delta_unused=None):
    """ژنراتور SSE خروجی OpenAI برای حالت ایجنت"""
    chat_id = f"chatcmpl-{uuid7()}"
    created = int(time.time())
    q: asyncio.Queue = asyncio.Queue()
    SENTINEL = object()

    async def runner():
        err = None
        try:
            await _agent_flow(model_name, messages,
                              on_delta=lambda d: q.put_nowait(("delta", d)))
        except HTTPException as e:
            err = f"[Error {e.status_code}] {e.detail}"
        except Exception as e:  # noqa: BLE001
            log.exception("[agent] stream runner failed")
            err = f"[Agent error] {e}"
        await q.put(("error", err) if err else ("done", SENTINEL))

    task = asyncio.create_task(runner())
    yield _openai_chunk(chat_id, created, model_name, {"role": "assistant"})
    try:
        while True:
            kind, payload = await q.get()
            if kind == "delta":
                yield _openai_chunk(chat_id, created, model_name, {"content": payload})
            elif kind == "error":
                yield _openai_chunk(chat_id, created, model_name,
                                    {"content": payload}, finish="stop")
                break
            else:
                yield _openai_chunk(chat_id, created, model_name, {}, finish="stop")
                break
    finally:
        if not task.done():
            task.cancel()
    yield "data: [DONE]\n\n"


async def agent_chat_completions(model_name: str, messages: list,
                                 stream: bool, client_type: str):
    """نقطه‌ی ورود Agent Mode از /v1/chat/completions"""
    if stream:
        return StreamingResponse(
            _agent_stream_gen(model_name, messages),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                     "X-Accel-Buffering": "no"},
        )
    parts: list = []
    text = await _agent_flow(model_name, messages, on_delta=parts.append)
    full = text or "".join(parts)
    now = int(time.time())
    return JSONResponse({
        "id": f"chatcmpl-{uuid7()}",
        "object": "chat.completion",
        "created": now,
        "model": model_name,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": full},
            "finish_reason": "stop",
        }],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    })

# ============================================================
# FastAPI
# ============================================================
app = FastAPI(title="arena2api", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def verify_api_key(request: Request):
    """Optional API key auth for OpenAI endpoints.

    If API_KEY is set, require: Authorization: Bearer <API_KEY>
    """
    if not API_KEY:
        return

    auth_header = request.headers.get("authorization", "")
    expected = f"Bearer {API_KEY}"
    if auth_header != expected:
        raise HTTPException(status_code=401, detail="Invalid API key")


# ============================================================
# 扩展端点
# ============================================================
@app.post("/v1/extension/push")
async def extension_push(request: Request):
    """接收扩展推送的 token、cookies、models"""
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    store.push(data)
    need = store.count_v3("chat_submit") < 3
    need_agent = store.count_v3("agentic_chat_submit") < 2
    return {
        "status": "ok",
        "need_tokens": need,
        "need_agent_tokens": need_agent,
        "v3_count": len(store.v3_tokens),
    }


@app.get("/v1/extension/status")
async def extension_status():
    s = store.status()
    agent_mgr.gc()
    s["agent_conversations"] = len(agent_mgr.conversations)
    return s


# ============================================================
# OpenAI 兼容端点
# ============================================================
@app.get("/v1/models")
async def list_models(request: Request):
    """列出可用模型"""
    verify_api_key(request)
    all_models = {}
    all_models.update(store.text_models)
    all_models.update(store.image_models)
    data = []
    # مدل مجازی Agent Mode — گفتگوی چندنوبتی: یک reCAPTCHA برای اولین پیام،
    # پیام‌های بعدی روی همان سشن بدون توکن جدید
    data.append({
        "id": "agent",
        "object": "model",
        "created": 0,
        "owned_by": "arena.ai",
    })
    for name in sorted(all_models.keys()):
        data.append({
            "id": name,
            "object": "model",
            "created": 0,
            "owned_by": "arena.ai",
        })
    if not data:
        # 返回一个占位模型
        data.append({
            "id": "waiting-for-extension",
            "object": "model",
            "created": 0,
            "owned_by": "arena.ai",
        })
    return {"object": "list", "data": data}


def detect_client(request: Request) -> str:
    """检测客户端类型"""
    ua = request.headers.get("user-agent", "").lower()
    if "claude" in ua or "anthropic" in ua:
        return "claude"
    if "gemini" in ua or "google" in ua:
        return "gemini"
    if "codex" in ua:
        return "codex"
    if "opencode" in ua:
        return "opencode"
    # NewAPI/OneAPI 通常使用标准 OpenAI 格式
    return "openai"


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """OpenAI 兼容的聊天补全"""
    verify_api_key(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")

    client_type = detect_client(request)
    model_name = body.get("model", "")
    messages = body.get("messages", [])
    stream = body.get("stream", False)

    if not messages:
        raise HTTPException(400, "messages is required")

    # 检查扩展是否连接
    if not store.active:
        raise HTTPException(503, "Extension not connected. Please open arena.ai in Chrome with the extension installed.")

    # ---------- Agent Mode ----------
    # مدل «agent» یا «agent:<modelName>» → گفتگوی چندنوبتی با یک reCAPTCHA برای کل مکالمه
    if model_name == "agent" or model_name.startswith("agent:"):
        log.info(f"[agent] request: model={model_name}, messages={len(messages)}, stream={stream}")
        return await agent_chat_completions(model_name, messages, stream, client_type)

    # 解析模型
    model_id = store.text_models.get(model_name) or store.image_models.get(model_name)
    if not model_id:
        # 尝试模糊匹配
        for name, mid in {**store.text_models, **store.image_models}.items():
            if model_name.lower() in name.lower() or name.lower() in model_name.lower():
                model_id = mid
                model_name = name
                break
    if not model_id:
        available = list(store.text_models.keys()) + list(store.image_models.keys())
        raise HTTPException(404, f"Model '{model_name}' not found. Available: {available[:20]}")

    # 构建 prompt（取最后一条 user 消息）
    prompt = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, list):
                # 多模态消息
                text_parts = [p.get("text", "") for p in content if p.get("type") == "text"]
                prompt = "\n".join(text_parts)
            else:
                prompt = content
            break
    if not prompt:
        prompt = messages[-1].get("content", "")

    # 如果有 system message，拼接到 prompt 前面
    system_parts = [m["content"] for m in messages if m.get("role") == "system"]
    if system_parts:
        prompt = "\n".join(system_parts) + "\n\n" + prompt

    # 如果有多轮对话，拼接历史
    if len(messages) > 1:
        history_parts = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if isinstance(content, list):
                content = "\n".join(p.get("text", "") for p in content if p.get("type") == "text")
            if role == "system":
                continue  # 已经处理
            history_parts.append(f"<|{role}|>\n{content}")
        prompt = "\n".join(history_parts)

    # 获取 reCAPTCHA token（ ترجیح با action=chat_submit ）
    v3_token = store.pop_v3_token(action="chat_submit")
    v2_token = store.pop_v2_token() if not v3_token else None

    is_image = model_name in store.image_models
    modality = "image" if is_image else "chat"

    # 构建 arena.ai 请求
    eval_id = uuid7()
    user_msg_id = uuid7()
    model_a_msg_id = uuid7()

    # 从 cookies 中提取 userId
    user_id = store.cookies.get("arena-user-id", "")
    if not user_id:
        # 尝试从其他 cookie 中提取
        for key, value in store.cookies.items():
            if "user" in key.lower() and len(value) > 20:
                user_id = value
                break

    arena_payload = {
        "id": eval_id,
        "mode": "direct",
        "modelAId": model_id,
        "userMessageId": user_msg_id,
        "modelAMessageId": model_a_msg_id,
        "userMessage": {
            "content": prompt,
            "experimental_attachments": [],
            "metadata": {},
        },
        "modality": modality,
    }

    # 添加 userId（如果有）
    if user_id:
        arena_payload["userId"] = user_id

    if v2_token:
        arena_payload["recaptchaV2Token"] = v2_token
        arena_payload["recaptchaV3Token"] = None
    elif v3_token:
        arena_payload["recaptchaV3Token"] = v3_token
    else:
        # بدون توکن، arena/Cloudflare قطعاً 403 می‌دهد؛ بهتر است صریح 503 برگردانیم
        log.warning("No reCAPTCHA token available (chat_submit); refusing request")
        raise HTTPException(
            503,
            "No reCAPTCHA token available. Keep the arena.ai tab open (logged in) "
            "and retry in a few seconds. Check /v1/extension/status → v3_chat_tokens.")

    # 构建 headers
    headers = {
        "accept": "*/*",
        "content-type": "application/json",
        "origin": ARENA_BASE,
        "referer": f"{ARENA_BASE}/?mode=direct",
        "user-agent": current_user_agent(),
        "cookie": store.build_cookie_header(),
    }

    # 添加认证 header（如果有 auth_token）
    if store.auth_token:
        headers["authorization"] = f"Bearer {store.auth_token}"

    url = ARENA_CREATE_EVAL
    log.info(f"Sending to arena.ai: model={model_name}, eval_id={eval_id}, has_v3={bool(v3_token)}, has_v2={bool(v2_token)}")

    if stream:
        return StreamingResponse(
            stream_response(url, arena_payload, headers, model_name, eval_id, client_type),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    else:
        return await non_stream_response(url, arena_payload, headers, model_name, eval_id, client_type)


async def stream_response(url, payload, headers, model_name, eval_id, client_type="openai"):
    """流式响应生成器"""
    chat_id = f"chatcmpl-{eval_id}"
    created = int(time.time())

    try:
        async with httpx.AsyncClient(timeout=300, follow_redirects=True) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    log.error(f"Arena API error: {resp.status_code} {body[:500]}")
                    error_chunk = {
                        "id": chat_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_name,
                        "choices": [{
                            "index": 0,
                            "delta": {"content": f"[Error: Arena API returned {resp.status_code}]"},
                            "finish_reason": "stop",
                        }],
                    }
                    yield f"data: {json.dumps(error_chunk)}\n\n"
                    yield "data: [DONE]\n\n"
                    return

                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue

                    content = None
                    reasoning = None
                    finish = None

                    if line.startswith("a0:"):
                        # 文本内容
                        try:
                            content = json.loads(line[3:])
                            if content == "hasArenaError":
                                content = "[Arena Error]"
                                finish = "stop"
                        except json.JSONDecodeError:
                            continue
                    elif line.startswith("ag:"):
                        # 推理内容
                        try:
                            reasoning = json.loads(line[3:])
                        except json.JSONDecodeError:
                            continue
                    elif line.startswith("ad:"):
                        # 完成
                        finish = "stop"
                        try:
                            data = json.loads(line[3:])
                            if data.get("finishReason"):
                                finish = data["finishReason"]
                        except json.JSONDecodeError:
                            pass
                    elif line.startswith("a2:"):
                        # heartbeat 或图片
                        if "heartbeat" in line:
                            continue
                        try:
                            data = json.loads(line[3:])
                            images = [img.get("image") for img in data if img.get("image")]
                            if images:
                                content = "\n".join(f"![image]({url})" for url in images)
                        except json.JSONDecodeError:
                            continue
                    elif line.startswith("a3:"):
                        # 错误
                        try:
                            content = f"[Error: {json.loads(line[3:])}]"
                        except:
                            content = f"[Error: {line[3:]}]"
                        finish = "stop"
                    else:
                        continue

                    if content is not None:
                        chunk = {
                            "id": chat_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model_name,
                            "choices": [{
                                "index": 0,
                                "delta": {"content": content},
                                "finish_reason": None,
                            }],
                        }
                        # Claude/Anthropic 格式兼容
                        if client_type == "claude":
                            chunk["type"] = "content_block_delta"
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                    if reasoning is not None:
                        # 将推理内容作为普通内容输出（或可以用 reasoning_content）
                        chunk = {
                            "id": chat_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model_name,
                            "choices": [{
                                "index": 0,
                                "delta": {"reasoning_content": reasoning},
                                "finish_reason": None,
                            }],
                        }
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                    if finish:
                        chunk = {
                            "id": chat_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model_name,
                            "choices": [{
                                "index": 0,
                                "delta": {},
                                "finish_reason": finish if finish != "stop" else "stop",
                            }],
                        }
                        yield f"data: {json.dumps(chunk)}\n\n"
                        yield "data: [DONE]\n\n"
                        return

    except Exception as e:
        log.error(f"Stream error: {e}")
        error_chunk = {
            "id": chat_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model_name,
            "choices": [{
                "index": 0,
                "delta": {"content": f"[Stream Error: {e}]"},
                "finish_reason": "stop",
            }],
        }
        yield f"data: {json.dumps(error_chunk, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"


async def non_stream_response(url, payload, headers, model_name, eval_id, client_type="openai"):
    """非流式响应"""
    content_parts = []
    reasoning_parts = []
    finish_reason = "stop"
    usage = {}

    try:
        async with httpx.AsyncClient(timeout=300, follow_redirects=True) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    log.error(f"Arena API error: {resp.status_code} {body[:500]}")
                    raise HTTPException(resp.status_code, f"Arena API error: {body[:200]}")

                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    if line.startswith("a0:"):
                        try:
                            text = json.loads(line[3:])
                            if isinstance(text, str) and text != "hasArenaError":
                                content_parts.append(text)
                        except json.JSONDecodeError:
                            pass
                    elif line.startswith("ag:"):
                        try:
                            text = json.loads(line[3:])
                            if isinstance(text, str):
                                reasoning_parts.append(text)
                        except json.JSONDecodeError:
                            pass
                    elif line.startswith("ad:"):
                        try:
                            data = json.loads(line[3:])
                            if data.get("finishReason"):
                                finish_reason = data["finishReason"]
                            if data.get("usage"):
                                usage = data["usage"]
                        except json.JSONDecodeError:
                            pass
                    elif line.startswith("a2:"):
                        if "heartbeat" in line:
                            continue
                        try:
                            data = json.loads(line[3:])
                            images = [img.get("image") for img in data if img.get("image")]
                            for img_url in images:
                                content_parts.append(f"![image]({img_url})")
                        except json.JSONDecodeError:
                            pass
                    elif line.startswith("a3:"):
                        try:
                            content_parts.append(f"[Error: {json.loads(line[3:])}]")
                        except:
                            content_parts.append(f"[Error: {line[3:]}]")

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Non-stream error: {e}")
        raise HTTPException(500, str(e))

    full_content = "".join(content_parts)
    full_reasoning = "".join(reasoning_parts)

    message = {"role": "assistant", "content": full_content}
    if full_reasoning:
        message["reasoning_content"] = full_reasoning

    response = {
        "id": f"chatcmpl-{eval_id}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_name,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason,
        }],
        "usage": usage or {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    }

    # Claude 格式兼容
    if client_type == "claude":
        response["type"] = "message"
        response["role"] = "assistant"
        response["content"] = [{"type": "text", "text": full_content}]

    return response


# ============================================================
# 健康检查
# ============================================================
@app.get("/health")
@app.get("/")
async def health():
    return {
        "status": "ok",
        "version": "1.0.0",
        "extension": store.status(),
    }


# ============================================================
# 启动
# ============================================================
if __name__ == "__main__":
    log.info(f"Starting arena2api on port {PORT}")
    log.info(f"OpenAI API: http://localhost:{PORT}/v1")
    log.info("Waiting for Chrome extension to connect...")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
