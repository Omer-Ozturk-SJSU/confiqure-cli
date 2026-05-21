# @confiqure/cli

The official CLI for [confiqure.ai](https://confiqure.ai) — push `@Confiqure`-annotated classes to your workspace.

## Install

```bash
npm install -g @confiqure/cli
# or run without installing:
npx @confiqure/cli <command>
```

## Quick start

```bash
confiqure login       # paste an API key from https://confiqure.ai/dashboard
confiqure init        # scaffold confiqure.config.json in the project root
confiqure diff        # preview which classes will be added / changed / deleted
confiqure push        # upload the changeset; backend generates the chat playbook
confiqure status      # check the most recent push result
```

## How the scan works

`confiqure push` parses each `@Confiqure`-annotated class with tree-sitter, walks the field-type graph, and ships every file transitively reachable from a root — not just the file with the annotation on it. This means nested configuration classes (e.g. `EmailPreferences` referenced from a root `NotificationPreferences`) come along automatically, without needing their own `@Confiqure` tag.

Sample push output:

```
Scanned 10 files; 1 @Confiqure root.

⏵ Root: NotificationPreferences — 10 reachable files
    ├─ src/main/java/com/example/notifications/NotificationPreferences.java  root
    ├─ src/main/java/com/example/notifications/EmailPreferences.java         referenced
    ├─ src/main/java/com/example/notifications/AlertPreferences.java         referenced
    ├─ src/main/java/com/example/model/Channel.java                          referenced
    └─ … (6 more)
```

## Supported languages

V1 ships tree-sitter parsing for **Java**. The other 8 languages (Kotlin, Scala, Python, TypeScript, C#, Rust, PHP, Swift) use a keyword-scan fallback until their grammars are wired in. Track progress at [github.com/Omer-Ozturk-SJSU/confiqure-cli/issues](https://github.com/Omer-Ozturk-SJSU/confiqure-cli/issues).

## Configuration

`confiqure init` writes `confiqure.config.json`:

```json
{
  "scanPaths": ["src/main/java"],
  "ignore": ["target", ".git", ".idea"],
  "languages": {
    "java": { "extensions": [".java"], "tokenPattern": "@Confiqure" }
  }
}
```

## Environment variables

Override the file-based credentials for CI:

- `CONFIQURE_API_KEY` — workspace API key (`cqai_…`)
- `CONFIQURE_WORKSPACE_KEY` — workspace URL key
- `CONFIQURE_API_BASE` — backend URL (defaults to `https://api.confiqure.ai`)

## License

MIT — see [LICENSE](./LICENSE).
