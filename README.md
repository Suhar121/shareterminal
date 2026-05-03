# shareterm

Mirror any running terminal to your phone — live. One command prefix.

---

## Install

```bash
cd shareterm
npm install
npm link          # makes `shareterm` available globally
```

## Usage

Just prefix any command:

```bash
shareterm uvicorn app:app --reload
shareterm npm start
shareterm python train.py
shareterm bash               # share a full shell
```

Your terminal runs exactly as normal. A pairing banner appears with a
6-character code. Open the URL on your phone, enter the code → you're in.

### Watch-only mode (phone can't type, only watch)

```bash
shareterm --watch uvicorn app:app --reload
```

---

## Phone

1. Open the URL printed in the banner (same WiFi)
2. Enter the 6-character code
3. Done — live terminal on your phone

---

## Beyond local WiFi

```bash
# Cloudflare Tunnel (free, no account)
npx cloudflared tunnel --url http://localhost:<port>

# ngrok
ngrok http <port>
```

Use the public URL + same 6-char code from anywhere.

---

## How it works

`shareterm` wraps your command in a PTY (pseudo-terminal), so it runs
exactly like a normal terminal. All output is:
- Written to your local screen as usual
- Buffered (last 5000 chars) so phone gets full history on connect
- Streamed live over WebSocket to any connected phones

The 6-char session code is generated fresh each run. No accounts, no cloud,
no data leaves your machine (unless you use a tunnel).
