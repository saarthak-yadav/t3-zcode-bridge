# ZCode ACP bridge for T3 Code

An experimental community ACP v1 adapter for ZCode's native agent harness. It translates ACP JSON-RPC into ZCode's bundled `app-server --stdio` protocol, so T3 Code and other ACP clients can run ZCode's own agent, tools and GLM models.

This project is independently maintained. It is not affiliated with or endorsed by Z.ai or T3 Code. Version **0.3.0** is an experimental release, verified on macOS with **ZCode Desktop 3.14.4 / Agent CLI 0.16.9** and **T3 Code 0.0.45**. Native sessions reject other CLI versions until they have been verified. Other runtime versions and platforms are not verified.

## Requirements

- Node.js **24 or newer**, available on `PATH` (also required for the registry archive).
- ZCode Desktop installed. The default resource path is `/Applications/ZCode.app/Contents/Resources`.
- A Z.ai or BigModel Coding Plan API key. Run `zcode-acp --setup` in an interactive terminal to configure it. Existing enabled API-key accounts in ZCode's legacy `~/.zcode/v2/config.json` also work. OAuth-only accounts are not supported.

Terminal setup hides key input and saves bridge-owned credentials with mode 0600 in `~/.zcode/v2/t3-bridge-account.json`; it does not overwrite ZCode account configuration. An existing account can be reused without copying its key. The first model request verifies the key with the provider. The bridge reads credentials from local account configuration on demand and sends them only through the native subprocess pipe. It does not copy them into T3 settings or modify ZCode's original account configuration. Native diagnostics are suppressed because they can contain request headers.

## Install

Download the npm-format `.tgz` asset from the [v0.3.0 GitHub release](https://github.com/saarthak-yadav/t3-zcode-bridge/releases/tag/v0.3.0) and install that downloaded file:

```sh
npm install --global ./t3-zcode-bridge-0.3.0.tgz
zcode-acp --version
zcode-acp --setup
zcode-acp models
```

This release is distributed through GitHub; it is not published to the npm registry or listed in the ACP Registry.

Alternatively, run from source:

```sh
git clone https://github.com/saarthak-yadav/t3-zcode-bridge.git
cd t3-zcode-bridge
node bridge.mjs --version
node bridge.mjs --setup
node bridge.mjs models
node bridge.mjs --acp
```

`--acp` waits for ACP messages on stdin. Do not expect an interactive terminal UI. No npm dependencies are required.

## Connect to T3 Code

### Generic ACP clients

In a T3 version offering **Settings → Providers → Add provider → Local ACP command**, set the command to `zcode-acp` (or its absolute installed path), argument to `--acp`, and display name to **ZCode**. Other ACP v1 clients use the same command. Generic ACP operation has not yet been tested end-to-end on current T3 main; the installed version used for verification predates that UI.

### T3 Code 0.0.45 compatibility mode

This version only exposes specific provider drivers. Add an instance with driver **Grok**, display name **ZCode**, and executable override pointing to the absolute path of the shell launcher `zcode-acp` in this source checkout. The shell launcher automatically uses legacy Grok compatibility mode. The npm-installed `zcode-acp` command is the generic agent executable; it is not the legacy shell launcher.

The legacy shell launcher uses Node from `PATH`, then the standard Homebrew paths. Set `ZCODE_NODE_BINARY` to an absolute Node executable if needed. T3 may display “Grok account”, “Early Access”, or Grok wording, but actual agent/model requests use ZCode. Hide the synthetic Grok Build model in T3's picker if it appears.

Choose **ZCode → GLM-5.3** or **GLM-5.3-Flash**. Available models come from the installed ZCode configuration. Flash is preferred as the default; reasoning defaults to `high`. Start a new thread after updating the bridge so T3 launches the new code.

## Supported behavior

- Text prompts, streamed replies and reasoning.
- Native tool activity, exact permission decisions, permission modes and Stop.
- Model selection and native session resume across bridge restarts.
- Session-scoped MCP transport configuration.
- Images, PDFs, embedded text, local file links and binary resources.

Use **Attach files** or paste an image in T3's composer. T3 0.0.45's Grok driver sends images inline and other uploaded files as saved paths in prompt text; ZCode can read those paths with native file tools. Other ACP clients can send embedded resource blocks or resource links, which the bridge translates directly.

Images support PNG, JPEG, WebP, GIF and BMP, up to **10 MiB each**. Total prompt content is limited to **50 MiB and 100 blocks**. Native runtime/model limits may be stricter. PDFs use native document handling when identified by MIME type or file extension. Remote resource links remain references; the bridge does not download them automatically.

Binary resources without a native inline representation are saved with private permissions under `~/.zcode/v2/t3-bridge-attachments`. They persist for session resume. Delete unused staged files only after their sessions are no longer needed; automatic retention is not implemented.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ZCODE_RESOURCES` | Override ZCode Desktop resource directory |
| `ZCODE_CLI_PATH` | Override bundled `zcode.cjs` path |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | Override builtin provider configuration |
| `ZCODE_DATA_BASE_DIR` | Base directory under which `.zcode/v2` is located; defaults to home |
| `ZCODE_BRIDGE_CREDENTIALS_FILE` | Override the private bridge-owned credential file |
| `ZCODE_BRIDGE_ACCOUNT_CONFIG` | Override legacy account configuration file |
| `ZCODE_NODE_BINARY` | Absolute Node executable for the legacy shell launcher |

## Limitations

- Audio transcription is not implemented; audio prompt blocks are rejected. Video resources are routed to the native runtime but have not been live-tested.
- Structured questions are shown in conversation and declined so the agent can ask in ordinary text. No answer is invented.
- Native conversation rollback, session listing/import, usage reporting and rich subagent lineage are not implemented.
- Native skills/plugins load inside ZCode, but their catalog is not mirrored into T3's skills menu.
- Official ZCode MCP services needing host-specific authentication are unsupported. Injected ordinary MCP transports are translated; live MCP integration has not been verified.
- OAuth refresh and desktop-specific quota behavior are unverified. This release uses Coding Plan API-key configuration.
- No automatic updates or full transport line-size enforcement yet. Native CLI compatibility is restricted to the verified 0.16.9 version. Update ZCode separately, and expect compatibility to change with its private/native protocol.
- `--version` reports the bridge version. Legacy Grok mode deliberately returns an unversioned label because T3's Grok version policy is unrelated to this bridge. `--bridge-version` always reports the actual version.

## Verification

```sh
npm test
npm run smoke
npm run smoke:attachments
```

Thirteen automated tests require no account, network or installed ZCode. CI runs them on macOS/Linux with Node 24/26; this checks the adapter's portable code, not ZCode runtime support on Linux.

The two smoke scripts require a configured ZCode installation, create temporary test workspaces and **consume model quota**. Verified live: streaming, process restart and remembered context, an approved Bash write, a denied Bash write with no file created, cancellation, and a real T3 thread returning `T3_ZCODE_OK`. Attachment checks identified a synthetic image's shapes/colors/number and extracted verification codes from a PDF, embedded text and a privately staged CSV.

Synthetic fixtures contain no user data. Local settings backups and credentials are excluded from Git and package contents.

## Publishing and upstream adoption

See [UPSTREAM.md](UPSTREAM.md) for the release roadmap and proposed registry/vendor adoption route. Public source availability does not imply official endorsement or ACP Registry acceptance.

## License

MIT. ZCode and T3 Code are separate projects with their own licenses and distribution terms. This package includes neither application's binaries.
