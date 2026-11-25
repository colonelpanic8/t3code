# Agent profiles

An agent profile gives a thread its own instructions, skills, and provider configuration in
place of your user-level ones, such as `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`, your skills,
and the MCP servers in your provider config. Sign-in, history, and project context, including
the repository's `AGENTS.md` and project skills, stay the same.

Profiles work with Codex and Claude. A thread on another provider refuses to start with a
profile instead of running with your own context.

## Create a profile

A profile is a folder in the `profiles` folder of the environment's T3 Code data, for example
`~/.t3/userdata/profiles/review`. Its name is the profile's name: letters, digits, `.`, `_`, and
`-`. Every file is optional:

| Path                    | Used for                                                        |
| ----------------------- | --------------------------------------------------------------- |
| `AGENTS.md`             | Instructions for every provider.                                |
| `skills/<name>/`        | Skills for every provider.                                      |
| `codex/`                | Codex-only entries such as `config.toml`, `skills/`, `agents/`. |
| `claude/CLAUDE.md`      | Claude instructions, used instead of `AGENTS.md`.               |
| `claude/skills/<name>/` | Claude-only skills.                                             |
| `claude/mcp.json`       | Claude MCP servers, in the `.mcp.json` format.                  |
| `claude/settings.json`  | Claude settings such as permissions and hooks.                  |
| `profile.json`          | Profile options; see below.                                     |

A profile's `codex/config.toml` replaces your Codex config entirely, so repeat any settings you
still want, such as MCP servers or features. Profiles keep their own Codex and Claude memory.

## Start a thread with a profile

In a new thread, choose the profile in the composer before sending the first message. The
profile stays with the thread, its forks, and the threads its agents start. The composer shows
it, but it can no longer change.

## Blank slate

To start an agent without T3 Code's own instructions and tools too, add a `profile.json`:

```json
{ "t3Context": false }
```

A profile folder holding only this file gives a thread with no user-level or T3 Code context.
