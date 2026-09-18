# ⚡ Arena AI Proxy (arena-ai-proxy)

> نسخه‌ی به‌روزشده‌ی پروژه‌ی arena2api — پراکسی محلی arena.ai به OpenAI API سازگار

پراکسی محلی که **arena.ai** (۳۰۰+ مدل هوش مصنوعی) را به یک **API سازگار با OpenAI**
تبدیل می‌کند تا بتوانید آن را به **ایجنت‌های لوکال** مثل **هرمس (Hermes)**،
**OpenClaw**، Cline، Continue، LibreChat و هر کلاینت سازگار با OpenAI متصل کنید.

این نسخه نسبت به ریپوی اصلی به‌روز شده است:

| مشکل ریپوی اصلی | وضعیت در این نسخه |
|---|---|
| سایت arena.ai افزونه را نمی‌شناخت (مدل‌ها خالی) | ✅ فایل کاملاً اصلاح شده است — `injector.js` با ساختار جدید RSC صفحه کار می‌کند |
| UUID به‌جای نام مدل نمایش داده می‌شد | ✅ بین آرایه‌های کاندید، فقط آرایه‌ی «نام‌دار» انتخاب می‌شود + محافظ سمت سرور |
| فرمت جدید capabilities سایت | ✅ پشتیبانی می‌شود (دیکشنری به‌جای آرایه) |
| هر پیام یک توکن reCAPTCHA مصرف می‌کرد | ✅ **Agent Mode**: یک توکن برای کل مکالمه (بخش بعدی) |
| — | ✅ اسکریپت `start.sh` برای راه‌اندازی یک‌دستوری روی لینوکس |

---

## 🤖 Agent Mode — یک reCAPTCHA برای کل مکالمه

در حالت مستقیم (مدل‌های عادی) **هر پیام یک توکن reCAPTCHA** مصرف می‌کند، چون هر بار یک
`create-evaluation` جدید ساخته می‌شود. حالت ایجنت از پروتکل گفتگوی ایجنت arena.ai استفاده می‌کند:

1. **پیام اول** مکالمه → `create-chat` (یک توکن `agentic_chat_submit` مصرف می‌شود)
2. سشن ایجنت با `publicAccessToken` بالا می‌آید
3. **پیام‌های بعدی** روی همان سشنِ زنده فرستاده می‌شوند (`in/append`) — **بدون هیچ توکن جدید**

کافی است به‌جای نام مدل، از مدل مجازی **`agent`** استفاده کنید:

```python
client.chat.completions.create(
    model="agent",               # یا "agent:gpt-5-chat" برای انتخاب مدل خاص
    messages=[
        {"role": "user", "content": "یه تابع فیبوناچی بنویس"},
        # پیام‌های بعدی مکالمه را کلاینت اضافه می‌کند — سرور همان گفتگو را ادامه می‌دهد
        {"role": "assistant", "content": "..."},
        {"role": "user", "content": "حالا memoize اش کن"},   # ← بدون توکن تازه
    ],
)
```

**تشخیص خودکار مکالمه:** سرور با تطبیق پیشوندِ پیام‌های user، درخواست شما را به گفتگوی
موجود وصل می‌کند. اگر تاریخچه را ادیت کنید یا مکالمه‌ی تازه‌ای شروع شود، خودکار گفتگوی جدید
ساخته می‌شود (یک توکن جدید). تاریخچه‌ی تکراریِ بدون پیام جدید، از کش پاسخ می‌گیرد (هزینه: صفر).

| رفتار | هزینه‌ی توکن |
|---|---|
| شروع مکالمه‌ی جدید (`agent`) | ۱ توکن `agentic_chat_submit` |
| ادامه‌ی مکالمه (پیام دوم به بعد) | **۰** |
| ارسال مجدد همان تاریخچه | **۰** (پاسخ کش‌شده) |
| مکالمه‌ی مستقیم با اسم مدل عادی | ۱ توکن `chat_submit` به‌ازای هر پیام |

نکته‌ها:
- افزونه حالا **دو استخر توکن** نگه می‌دارد (`chat_submit` + `agentic_chat_submit`)؛ بعد از آپدیت، افزونه را حتماً **ری‌لود** کنید.
- سشن‌های ایجنت ۳۰ دقیقه (پیش‌فرض) در کش زنده می‌مانند؛ بعد از آن مکالمه‌ی جدید ساخته می‌شود.
- پاسخ‌های Chain-of-Thought/ابزارها فعلاً به متن نهایی تقلیل می‌یابد؛ فقط متن اصلی پاسخ برمی‌گردد.
- حالت استریم (`stream: true`) هم پشتیبانی می‌شود.

---

## 🏗 معماری

```
ایجنت لوکال (هرمس/OpenClaw/…)
        │  OpenAI API  (POST /v1/chat/completions)
        ▼
┌─────────────────────┐        push هر ۳۰ ثانیه:        ┌──────────────────────────┐
│  سرور پایتون FastAPI │ ◄── توکن reCAPTCHA + کوکی‌ها ── │  افزونه‌ی کروم            │
│  localhost:9090      │                                │  (داخل تب arena.ai)      │
└─────────────────────┘                                └──────────────────────────┘
        │  arena.ai payload (توکن + کوکی واقعی)
        ▼
   https://arena.ai/nextjs-api/stream/create-evaluation
        │  SSE: a0:/ag:/ad:/a2:/a3:
        ▼  تبدیل به فرمت OpenAI SSE
   پاسخ به ایجنت
```

چرا افزونه لازم است؟ arena.ai پشت **reCAPTCHA v3** است؛ افزونه توکن را در مرورگر
واقعی و داخل خود صفحه می‌سازد (امتیاز بالا) و هر ۸۰ ثانیه تازه‌اش می‌کند.
بنابراین **تب arena.ai باید همیشه باز بماند.**

---

## 🚀 نصب و راه‌اندازی (لینوکس)

### پیش‌نیاز
- Python 3.8+ ، کروم یا فایرفاکس، حساب کاربری در arena.ai (رایگان)
- اگر `venv` ندارید: `sudo apt install python3-venv python3-pip`

### ۱) اجرای سرور

روش آسان (خودکار — پیشنهادی):
```bash
cd arena-ai-proxy
chmod +x start.sh
./start.sh
```

روش دستی:
```bash
cd arena-ai-proxy
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

سرور روی `http://localhost:9090` بالا می‌آید و منتظر اتصال افزونه می‌ماند.

### ۲) نصب افزونه‌ی مرورگر

**کروم / Edge / Brave:**
1. به `chrome://extensions/` بروید
2. «Developer mode» را روشن کنید
3. «Load unpacked» را بزنید و پوشه‌ی `arena-ai-proxy/extension/` را انتخاب کنید

**فایرفاکس:** نسخه‌ی مخصوص فایرفاکس (Manifest V2) در پوشه‌ی `extension-firefox/` قرار دارد:
1. به `about:debugging#/runtime/this-firefox` بروید
2. «Load Temporary Add-on...» را بزنید و فایل `extension-firefox/manifest.json` را انتخاب کنید
(توجه: این روش موقت است و با بستن فایرفاکس افزونه پاک می‌شود؛ برای نصب دائمی باید افزونه را امضا (sign) کنید)

### ۳) اتصال به arena.ai

1. آیکون افزونه (⚡) را بزنید → دکمه‌ی **Open Arena.ai**
2. در سایت **لاگین** کنید و چند ثانیه صبر کنید تا صفحه کامل لود شود (~۵ ثانیه)
3. دوباره آیکون افزونه — همه‌ی وضعیت‌ها باید سبز باشند:
   - Server → **Connected**
   - Arena Tab → **Active**
   - Auth Cookie → **Yes**
   - Models → عددی بزرگ‌تر از صفر (معمولاً ۱۰۰۰+)

### ۴) تست

```bash
# لیست مدل‌ها (باید نام واقعی ببینید: gpt-5-chat, claude-..., grok-...)
curl http://localhost:9090/v1/models

# چت غیراستریمی
curl http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5-chat","messages":[{"role":"user","content":"سلام!"}]}'

# چت استریمی
curl http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-1","messages":[{"role":"user","content":"Hi"}],"stream":true}'
```

> نام مدل‌ها دقیقاً همان publicNameهای arena.ai است (با حروف کوچک مثل
> `gpt-5-chat`). سرور **fuzzy match** دارد: اگر بگویید `claude` نزدیک‌ترین
> مدل پیدا می‌شود.

---

## 🤖 اتصال به ایجنت‌های لوکال

این سرور یک API سازگار با OpenAI است؛ در هر ایجنتی کافی است این‌ها را تنظیم کنید:

- **Base URL:** `http://localhost:9090/v1`
- **API Key:** هر مقداری (پیش‌فرض بدون احراز هویت است؛ برای فعال کردن:
  `API_KEY=mysecret python server.py` و سپس همان کلید را در ایجنت بگذارید)
- **Model:** یکی از نام‌های `/v1/models` (مثل `gpt-5-chat`)

### Hermes Agent (Nous)
در `~/.hermes/config.yaml` (یا با `hermes config edit`):
```yaml
model:
  provider: custom
  default: agent                       # یا نام هر مدل از /v1/models
  base_url: http://127.0.0.1:9090/v1   # حتماً با /v1
  api_key: dummy                       # خالی نباشد
  context_length: 128000
```
سپس: `hermes config check` و تست: `hermes chat -q "سلام" -Q`
- `/v1` را جا نیندازید؛ بدون آن هرمس به `/chat/completions` می‌زند (404).
- به‌جای `model_aliases` از کلیدهای سراسری بالا استفاده کنید (باگ شناخته‌شده‌ی هرمس).
- اگر هرمس داخل Docker/WSL است، به‌جای `127.0.0.1` آی‌پی هاست (مثل `172.17.0.1`) را بگذارید.

### هر کلاینت SDK پایتون
```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:9090/v1", api_key="anything")
r = client.chat.completions.create(
    model="gpt-5-chat",
    messages=[{"role": "user", "content": "سلام"}],
    stream=True,
)
for c in r:
    if c.choices[0].delta.content:
        print(c.choices[0].delta.content, end="")
```

### OpenClaw / Cline / Continue / LibreChat / Open WebUI
در تنظیمات provider، گزینه‌ی **OpenAI Compatible** را انتخاب کنید و:
- Endpoint: `http://localhost:9090/v1`
- API Key: `local`
- Model: `gpt-5-chat`

### curl خام
همان مثال‌های بخش تست.

---

## 📡 اندپوینت‌ها

| مسیر | متد | توضیح |
|---|---|---|
| `/v1/models` | GET | لیست مدل‌ها (فرمت OpenAI) |
| `/v1/chat/completions` | POST | چت، با/بدون `stream` |
| `/v1/extension/push` | POST | دریافت توکن/کوکی/مدل از افزونه (داخلی) |
| `/v1/extension/status` | GET | وضعیت اتصال افزونه و استخر توکن |
| `/health` | GET | سلامت‌سنجی |

## ⚙️ تنظیمات (متغیرهای محیطی)

| متغیر | پیش‌فرض | توضیح |
|---|---|---|
| `PORT` | `9090` | پورت سرور |
| `API_KEY` | — | اگر ست شود، `Authorization: Bearer <کلید>` اجباری می‌شود |
| `DEBUG` | — | لاگ‌های تفصیلی |
| `AGENT_SESSION_TTL` | `1800` | عمر کش گفتگوهای ایجنت (ثانیه) |
| `AGENT_REPLAY_MAX` | `3` | حداکثر پیام تاریخچه که زنده بازپخش می‌شود؛ بیشتر از این → ادغام به رونوشت |
| `AGENT_TURN_TIMEOUT` | `600` | مهلت کامل یک نوبت ایجنت (ثانیه) |
| `AGENT_STALL_TIMEOUT` | `120` | مهلت سکون استریم پاسخ (ثانیه) |

---

## 🧩 ساختار پروژه

```
arena2api/
├── server.py            # سرور FastAPI (پچ‌شده: نادیده گرفتن مدل‌های بی‌نام)
├── requirements.txt
├── start.sh             # راه‌انداز لینوکس (venv خودکار)
├── README.md
├── extension/           # افزونه‌ی کروم/Edge/Brave (Manifest V3)
│   ├── manifest.json
│   ├── background.js    # Service Worker — استخر توکن، تازه‌سازی، push دوره‌ای
│   ├── content.js       # پل پیام (ISOLATED world)
│   ├── injector.js      # v2 اصلاح‌شده — استخراج مدل از RSC فعلی سایت + reCAPTCHA
│   ├── popup.html/js    # رابط وضعیت
│   └── icons/
└── extension-firefox/   # افزونه‌ی فایرفاکس (Manifest V2)
    ├── manifest.json
    ├── background.js    # Background Script — نسخه‌ی browser.* API
    ├── content.js       # پل پیام
    ├── injector.js      # v2 اصلاح‌شده + دسترسی wrappedJSObject برای Xray فایرفاکس
    ├── popup.html/js
    └── icons/
```

---

## 🛠 عیب‌یابی

| علامت | علت | راه‌حل |
|---|---|---|
| `/v1/models` فقط `waiting-for-extension` | افزونه وصل نیست | پاپ‌آپ: Server URL = `http://127.0.0.1:9090`؛ تب arena.ai باز و رفرش شود |
| Models در پاپ‌آپ = 0 | تزریق انجام نشده | تب را **بعد از نصب/ریلود افزونه** رفرش کامل کنید (Ctrl+Shift+R) |
| خطای 503 در چت | آخرین push > ۱۲۰ ثانیه | تب arena.ai را باز و فعال نگه دارید؛ پاپ‌آپ → دکمه‌ی Push |
| پاسخ خطا/خالی از arena | توکن تمام شده یا کوکی منقضی | چند ثانیه صبر کنید؛ پاپ‌آپ → Get Token؛ در سایت دوباره لاگین کنید |
| Auth Cookie = No | لاگین نیستید یا کوکی عوض شده | در arena.ai لاگین کنید و تب را رفرش کنید |
| در Console `models: 0` | ساختار سایت دوباره عوض شده | وصله نیاز به به‌روزرسانی دارد — گزارش دهید |
| `503 No reCAPTCHA token available` | افزونه توکن نمی‌سازد | Console تب arena.ai را ببینید؛ باید `Got V3 token` چاپ شود. AdBlock/Shields را برای arena.ai خاموش کنید |
| **(Firefox)** `Permission denied to access object` + `Injector timeout` | نسخه‌ی قدیمی افزونه (< 2.0.2) | افزونه را به‌روز و در `about:debugging` ریلود کنید، تب را دوباره باز کنید |
| `403 Attention Required! Cloudflare` | Cloudflare اثر انگشت TLS پایتون را می‌شناسد | `pip install curl_cffi` (در requirements هست) و سرور را ری‌استارت کنید؛ سرور با TLS شبیه مرورگر شما درخواست می‌زند. در لاگ استارت باید `TLS impersonation: ON` ببینید |

**بررسی سریع وضعیت سرور:**
```bash
curl -s http://127.0.0.1:9090/v1/extension/status | python3 -m json.tool
```
`v3_chat_tokens` (حالت مستقیم) و `v3_agent_tokens` (حالت agent) باید بزرگ‌تر از ۰ باشند.

**دیباگ:** در صفحه‌ی arena.ai کلید F12 → Console. باید ببینید:
```
[Arena2API] Injector ready, models: 1074 | sample names: Max, claude-...
```
اگر این پیام نیست، تزریق انجام نشده؛ اگر `models: 0` است ساختار سایت عوض شده.

---

## ⚠️ نکات مهم

- **تب arena.ai همیشه باز بماند** — توکن reCAPTCHA فقط ~۲ دقیقه عمر دارد.
- **محدودیت نرخ:** استخر توکن حداکثر ۱۰ عدد است؛ درخواست‌های هم‌زمان زیاد با تأخیر کوتاه مواجه می‌شود.
- **امنیت:** سرور روی `0.0.0.0` گوش می‌دهد — در شبکه‌های نامطمئن حتماً `API_KEY` ست کنید.
  کوکی‌های سشن شما فقط بین مرورگر و همین سرور لوکال رد و بدل می‌شود؛ Server URL افزونه را هرگز روی سرور راه دور نگذارید.
- **شرایط استفاده:** این ابزار ساختار داخلی arena.ai را مهندسی معکوس کرده است؛ با هر به‌روزرسانی سایت ممکن است بشکند و استفاده از آن مسئولیت خودتان است.
- مکالمات چندنوبتی به یک پرامپت واحد تبدیل می‌شوند (محدودیت طول پیام سایت را در نظر بگیرید).
