# Live Voice

Live Voice is a hands-free way to run T3 Code: start a call and talk to a
voice assistant that can see every server your app is connected to — what's
running, what's waiting on you — and act on any of them: kick off new agent
threads, send follow-ups, or interrupt work, all by voice.

It works like a chief of staff across your machines. Ask "what's running on my
desktop?", "start an agent in the api repo on my laptop to fix the failing
tests", or "tell that thread to also update the changelog", and it routes the
work to the right server.

## Requirements

- **Codex signed in** on the server that hosts the call. Live Voice speaks
  through Codex's realtime voice API, so it uses your existing ChatGPT
  subscription (or Codex API key) — no extra API key to configure.
- **Codex 0.145.0 or newer** on that server.
- A **secure context** in the browser: `https://` or `localhost`. On a plain
  `http://` LAN address the microphone is unavailable and the launcher will
  say so.

## Starting a call

Click the voice button in the sidebar footer (web/desktop) and pick which
server hosts the call — any connected server with Live Voice support works.
Your voice goes directly from your device to OpenAI over an encrypted
peer-to-peer connection; T3 servers only carry call setup, transcripts, and
the actions you ask for.

While a call is active a small card stays visible wherever you navigate, with
the live transcript, a mute toggle, and a stop button. Ending the call, losing
the connection, or closing the app all end the session cleanly.

## What it can do

- List your connected servers and what's happening on each.
- Read project and thread status anywhere ("anything waiting on approval?").
- Start new agent threads, send messages to existing ones, and interrupt runs
  — always on one named server, and it confirms before anything destructive.

It never sees or shares server addresses or credentials, and its tools are
limited to the actions above.

## Mobile

Live Voice works in the mobile app with the same cross-server abilities.
Calls keep running on iOS while the app is in the background or the screen is
locked; on Android, keep the app in the foreground during a call. Mobile
support requires an app version built with voice support — if your app
predates it, the launcher will ask you to update.
