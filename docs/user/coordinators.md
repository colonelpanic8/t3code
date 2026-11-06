# Coordinators

A coordinator is a standing thread that keeps track of agent work across your machines and tells
you what needs you. Each one lives on one machine and has an inbox: threads on that machine and
every [linked machine](./remote-access.md) that are waiting on a question or approval, failed, or
finished since you last opened them, plus notes the coordinator leaves you.

## Add a coordinator

Coordinators are set in the machine's `settings.json`, under `coordinators`:

```json
{
  "coordinators": {
    "chief-of-staff": {
      "name": "Chief of Staff",
      "workspaceRoot": "/home/me/notes/coordinator",
      "instructions": "Check CI on anything I asked you to watch.",
      "wakeEveryMinutes": 60
    }
  }
}
```

- `workspaceRoot` is the folder the coordinator works in, usually a repository. Its `AGENTS.md`,
  skills, and MCP servers apply the way they do for any thread, so that is where its standing
  instructions and notes belong. Leave it out and T3 Code makes a folder for it.
- `modelSelection` picks its model; otherwise the project's default is used.
- `wakeEveryMinutes` starts a fresh session in the same thread on that interval, with a briefing
  and the current inbox. **New session** in the inbox does the same at once. Each session starts
  without the earlier ones in context, so a coordinator keeps what matters in files in its folder.

T3 Code creates the coordinator's thread and pins it. To see other machines' threads in its inbox,
turn on **Settings → Labs → Linked environments** on every machine involved and link them.

## Use the inbox

The inbox appears at the top of the sidebar and in the **Inbox** tab on mobile. **Needs you** lists
questions, approvals, failures, and notes; **Finished** lists threads that finished since you last
opened them. Opening a thread clears its item. Notes stay until you dismiss them or the coordinator
resolves them.

With several coordinators, choose which one this device shows under **Settings → General →
Coordinator** (on mobile, **Settings → General**). **Open coordinator** in the command palette opens
its thread; bind `coordinator.open` to give it a shortcut.

Agents reach the same inbox with the `t3_inbox` tool. A worker on another machine can leave you a
note by passing that machine's `environmentId`.
