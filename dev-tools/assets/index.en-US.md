# Dev Tools

## 1. What is this

Dev Tools is a toolbox for managing and previewing plugins that are still in development. It covers the whole flow — create, edit, debug, and package — without leaving the host or typing commands by hand.

It mainly offers:

- **Create plugins**: create a new plugin project from the official template in one click; base dependencies are set up for you automatically.
- **Manage local plugins**: add existing plugin folders on your machine and manage them all in one place.
- **Auto-build**: plugins rebuild automatically after you save, so you always preview the latest version.
- **Live preview**: open the plugin right inside the host; after editing, click **Refresh** to see the new UI immediately — the AI chat panel next to it is not affected.
- **AI chat panel**: open dsh's chat interface on the right side to talk to an AI while you work (requires the dsh plugin).
- **Logs**: view each plugin's build / runtime logs to help troubleshoot problems.
- **One-click packaging**: package a plugin into a `.dlient` file that can be imported into the host or shared with others.

## 2. How to use

1. Open Dev Tools.
2. Click **Create plugin** and enter a name to create a new project from the template; or click **Add directory** to choose an existing plugin folder on your machine.
3. The plugin builds automatically once registered, and can then be opened in the host (you can also open it in a separate tab).
4. After editing and saving your code, click **Refresh** to preview the latest result; check the **Logs** tab when something goes wrong.
5. To distribute, click **Pack** — a `.dlient` file is generated in the plugin directory.

## 3. Permissions requested

- **File access**: reads and writes the plugin directories you register, to load and save your project files.
- **Running commands**: starts Node.js / npm to install dependencies and build plugins. The host finds a usable runtime automatically — no manual setup needed.
- **Directory authorization**: a confirmation dialog appears the first time you add a directory (you can choose "always allow").
- **Others**: logging, choosing files / directories, and revealing folders in the file manager.

## 4. Dependencies

- **Host-provided runtime**: building plugins needs Node.js, which the host prepares automatically — no separate install required.
- **dsh plugin (optional)**: the right-side **AI** panel requires the dsh plugin; without it the panel is unavailable and everything else keeps working.
