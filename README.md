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

Since CLI 1.0 the scan reads the **annotation 3.0** vocabulary (`ai.confiqure:confiqure-annotation-java` 3.0.0):

| annotation | on | pushed as |
|---|---|---|
| `@Confiqure.Setting(end)` / `@Confiqure.List(end)` | class | an object (one record / many records per organization) |
| `@Confiqure.User.Setting(end)` / `@Confiqure.User.List(end)` | class | the per-user pair |
| `@Confiqure.Identity` | a field of a List object | the field that identifies a record |
| `@Confiqure.Facts(callback)` | class | the user-facts contract |
| `@Confiqure.Tool(name)` | class | a tool class: its Javadoc is the flow, every public method one operation |
| `@Confiqure.Browser` / `@Confiqure.Async` | a tool-class method | runs in the page / result delivered later |

An operation's URL comes from Spring: the class `@RequestMapping` joined with the method's `@PostMapping` / `@GetMapping` / `@PutMapping` / `@DeleteMapping`. A public method with neither a mapping nor `@Confiqure.Browser` stops the push. So do the pre-3.0 forms — `@Confiqure(end = …)` on a class and `@Confiqure.Tool` on a method — each with a message naming the file and the replacement. An object without `end` gets `/<snake_case class name>`.

`confiqure push` parses each class with tree-sitter, walks the field-type graph, and ships every file transitively reachable from it — for an object its field types, for a tool class the input and return DTOs of its operations. Nested classes (e.g. `EmailPreferences` referenced from `NotificationPreferences`) come along automatically without an annotation of their own. Objects and tool classes are both diffed by path and content, so only what changed is uploaded.

Tools are registered by `confiqure push`; `confiqure tools set` is retired (`tools list` / `tools delete` remain).

Sample push output:

```
Scanned 12 files; 1 object, 1 tool class.

⏵ Tool class: ListingsTool — 3 reachable files
    ├─ src/main/java/com/example/Listing.java              referenced
    ├─ src/main/java/com/example/ListingsTool.java         root
    └─ src/main/java/com/example/TitleQuery.java           referenced
⏵ Root: NotificationPreferences — 10 reachable files
    ├─ src/main/java/com/example/notifications/NotificationPreferences.java  root
    ├─ src/main/java/com/example/notifications/EmailPreferences.java         referenced
    └─ … (8 more)
```

## Supported languages

V1 ships tree-sitter parsing for **Java**. The other 8 languages (Kotlin, Scala, Python, TypeScript, C#, Rust, PHP, Swift) use a keyword-scan fallback until their grammars are wired in. Track progress at [github.com/Omer-Ozturk-SJSU/confiqure-cli/issues](https://github.com/Omer-Ozturk-SJSU/confiqure-cli/issues).

## Configuration

`confiqure init` writes `confiqure.config.json`:

```json
{
  "scanPaths": ["src/main/java"],
  "guides": ["docs/user-guides"],
  "ignore": ["target", ".git", ".idea"],
  "languages": {
    "java": { "extensions": [".java"], "tokenPattern": "@Confiqure" }
  }
}
```

## User guides

`guides` marks the folders holding your product's own documentation. On every
full `confiqure push` the CLI hashes each guide file, uploads only what changed,
and tells the backend the full local list so a page you deleted in git is retired
server-side. **Git stays the version control — the CLI mirrors it.** There is no
guide-authoring screen and no separate versioning: a guide's identity is its
repo-relative path, and its version is its content.

The chat searches these guides and answers "how do I…" questions from them,
citing the page — instead of improvising an answer or asking the user something
your documentation already explains.

- **Synced types:** `.md` `.markdown` `.txt` `.html` `.htm` `.pdf`, plus
  `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` screenshots. Anything else in the
  folder is ignored. Per-file limit: 10 MB.
- **Where they land:** the sandbox, like every `confiqure push`.
  `confiqure push --production` (or `--live`) mirrors the guides corpus to
  production along with your endpoints.
- **`--file` pushes skip guides.** A selective push is update-only and must
  never compute deletions; guides sync is a full sync by definition. Run a plain
  `confiqure push` to sync them.
- Set `"guides": []` to turn the sync off.

## Environment variables

Override the file-based credentials for CI:

- `CONFIQURE_API_KEY` — workspace API key (`cqai_…`)
- `CONFIQURE_WORKSPACE_KEY` — workspace URL key
- `CONFIQURE_API_BASE` — backend URL (defaults to `https://api.confiqure.ai`)

## License

MIT — see [LICENSE](./LICENSE).
