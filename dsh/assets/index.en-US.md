# dsh (DeepSeek Harness)

## 1. What is this

dsh runs the **DeepSeek Harness (dsh)** AI agent workspace inside the host. DeepSeek Harness is an AI agent workbench that can help you with everyday tasks such as coding and writing.

It mainly offers:

- **Full AI assistant UI**: configure models, manage workspaces, and chat with the AI.
- **No manual install**: everything needed to run it is installed and configured automatically.
- **Chat surface you can embed elsewhere**: a simple chat interface that other plugins (for example, the "AI" panel in Dev Tools) can use to bring dsh's AI capabilities into their own UI.
- **Follows the host appearance**: automatically uses the host's current language and theme — nothing to configure.

## 2. How to use

1. Open the dsh app — or, if another plugin embeds its chat surface, open that panel directly.
2. On first use the required software is installed automatically; this can take a few minutes, so please be patient.
3. Inside the UI, enter your AI service API key under **Settings**, then pick a workspace to start.

## 3. Permissions requested

- **Running software**: starts Node.js / npm to install and run dsh (the host resolves the runtime automatically — no manual setup).
- **File access**: installs its runtime files under the host's data directory; a confirmation dialog may appear on first use.
- **Local port access**: the dsh UI is served over a local port, so the plugin needs to access the local network to display it.
- **Saving configuration**: reads / writes dsh's configuration (such as language and theme) to keep it in sync with the host.

## 4. Dependencies

- **Host-provided runtime**: running dsh needs Node.js, which the host prepares automatically — no separate install required.
- **Embedded by other plugins**: its chat surface can be embedded by other plugins (for example, the "AI" panel in Dev Tools).
- **Shared configuration with the CLI (optional)**: if you already have dsh installed via the command line, both share the same configuration.
