# Writing the UI

The UI is a React bundle loaded by the host renderer through SystemJS. There is no HTML flow: the host injects your entry, links your CSS, and renders your default export inside its own layout.

## 1. Build model

- Config preset: `createPluginViteConfig` from `@dlient-open/plugin-sdk/vite-config`.
- `vite build` → **System.register** output → `dist/remoteEntry.js`.
- React and `@dlient-open/*` are externalized: the host's SystemJS import map resolves them to **single shared instances**.
- CSS is emitted as one file and injected over `dlientOpen://plugin/<pluginId>/dist/<style>.css?v=<ts>` (cache-busted). Relative `url()` inside CSS resolves against the CSS file location.
- Hot reload is output-level: `npm run dev:watch` writes `dist`; changes take effect after the host is reopened / reloaded (no dev-server port).

## 2. Use shared components — `@dlient-open/ui` (shadcn-style)

Import components from **`@dlient-open/ui`**. It re-exports a **shadcn/ui-style component set** (radix primitives + tailwind variables, `dui:` prefix) and keeps a compatibility shim for the legacy `theme` prop (`theme="primary"` maps to a shadcn `variant`). These render with the host theme and shared styles — **don't reinvent the wheel, don't hand-roll UI**.

```tsx
import { Button, Input, Card, Dialog, Tabs, Select, Badge, toast } from '@dlient-open/ui'
```

Common components shipped by `@dlient-open/ui` (shadcn-style, props aligned to standard shadcn):

| Category | Components |
| --- | --- |
| Basics | `Button` `Input` `Textarea` `Checkbox` `RadioGroup` `Select` `Switch` `Slider` `Badge` `Label` `Kbd` |
| Data display | `Table` `Tabs` `Card` `Avatar` `Skeleton` `Progress` `Separator` `Accordion` `Tooltip` `Popover` `HoverCard` |
| Feedback | `Dialog` / `AlertDialog` `Sheet` `Drawer` `DropdownMenu` `ContextMenu` `Menubar` `Command` `Alert` `toast`/`Toaster` `MessagePlugin` |
| Layout & form | `Sidebar` `Resizable` `ScrollArea` `InputOtp` `ToggleGroup` `Pagination` `Breadcrumb` `Calendar` `Carousel` |
| Icons | `Icon` (name-based compat) + every icon from **lucide-react** (common ones re-exported) |
| dlient-specific | `PluginView` `PluginIcon` `PluginErrorBoundary` `Webview` `LogViewer` `modal`/`createDialog` `useDlientApi` `useDientStore` `useDientEvent` |

- **Legacy `theme` compat**: `<Button theme="primary">` auto-maps to a shadcn `variant`; or use `variant="default" | "destructive" | "outline" | "secondary" | "ghost" | "link"` and `size="sm" | "lg" | "icon"`.
- Icons — **use lucide** instead of drawing your own SVGs:
  ```tsx
  import { Icon } from '@dlient-open/ui'      // legacy <Icon name="code" size={48} />
  import { CodeIcon, SearchIcon, UploadIcon } from '@dlient-open/ui'   // named (lucide)
  ```
- For **plugin icons** (the launcher-grid logos from the manifest) use the dedicated `PluginIcon`:
  ```tsx
  import { PluginIcon } from '@dlient-open/ui'
  <PluginIcon pluginId="my-plugin" />
  ```
- Show another plugin's UI with `PluginView` (target must have a UI):
  ```tsx
  <PluginView pluginId="plugin-auth" />
  ```
- Lightweight notices: `toast` (sonner; the host root mounts a single `<Toaster />`) or the legacy `MessagePlugin`. For feedback dialogs prefer `modal` / `createDialog` (shared, theme-aware) over hand-rolled overlays.

### 2.1 `Webview` — embedded web content

Puts a remote page into a main-process `WebContentsView` layered over the host window (a real browser view, not an iframe). **No `manifest.permissions` entry is needed** — the component calls the host through the view-bound client injected by `PluginView`; the host restricts operations to the views created by that view and keeps its own sandbox + webPreferences / webContents-method / event whitelists.

```tsx
import { useRef } from 'react'
import { Webview, type WebviewHandle } from '@dlient-open/ui'

export default function App() {
  const ref = useRef<WebviewHandle>(null)

  return (
    <div style={{ height: '100%' }}>
      <Webview
        ref={ref}
        src="https://example.com"
        onViewReady={(viewId) => console.log('view ready', viewId)}
        onDidFinishLoad={() => console.log('loaded')}
        onDidFailLoad={(code, desc) => console.error('load failed', code, desc)}
      />
    </div>
  )
}
```

Props: `src` (required) · `webPreferences?` (only whitelisted fields) · `visible?` (default true) · `onViewReady(viewId)` · `onDidFinishLoad` · `onDidFailLoad` · `onPageTitleUpdated`.
Handle: `ref.current.webContents.call(method, args)` runs whitelisted webContents methods.

**Showing / hiding across tab switches.** `WebContentsView` is a native window — CSS `display:none` will **not** actually hide it; you must toggle visibility explicitly:

```tsx
const [active, setActive] = useState('pageA')
// render only when its tab is active:
{active === 'web' && (
  <div style={{ width: '100%', height: '100%' }}>
    <Webview src="https://example.com" />
  </div>
)}
```

Two cooperation mechanisms (both via the main-process view manager):

- **Component-level**: for a persistently mounted `Webview`, pass `visible={activeTab === id}` and the component syncs visibility to the host for you. A 0×0 (hidden) container skips bounds updates to avoid reloading the page on restore.
- **Host-level exact restore (multi-view / tab orchestration)**: record `viewId` from `onViewReady`; on hide call `useWebviewClient().hideMine()` and cache the returned ids, on switch back call `showMine(cachedIds)` for **exact restore** (no permission needed).

Keep the `Webview` mounted and toggle `visible` to preserve page state; unmount only when you want to destroy the view (unmount auto-destroys).

### 2.2 `LogViewer` — plugin log view

Shows your plugin's own log (`plugin-data/<pluginId>/logs/main.log`, JSONL) with live streaming, download and clear. **Zero-config for reading your own log:**

```tsx
import { LogViewer } from '@dlient-open/ui'

export default function SettingsView() {
  return <LogViewer height={320} />   // your own log: history + live + download/clear
}
```

Props: `history?: number` (latest N, ≤200) · `reader?` (custom read source) · `subscribe?` (custom live subscription) · `event?` · `filterId?` (only append pushes for that plugin) · `onDownload?` / `onClear?` (custom actions) · `height?` (default 480) · `className?`.

**Cross-plugin viewing**: pass custom `reader`/`subscribe` (the cross-plugin read permission is your own channel) + `filterId` to scope the push stream:

```tsx
// readTargetLogs / subscribeTargetLogs come from your worker's custom methods (api.request via your own cross-plugin channel);
// reading another plugin's log cannot rely on the default "read self" implementation.
<LogViewer
  filterId={targetPluginId}
  reader={readTargetLogs}
  subscribe={subscribeTargetLogs}
/>
```

### 2.3 `modal` — imperative feedback dialog

`modal` is a shared, theme-aware, i18n-aware feedback API. **Prefer `modal` over bare `Dialog`**: presets define icons + button themes, confirm auto-loads, `onConfirm` returning `false` keeps the dialog open, it follows locale, and supports in-place `update`. Fall back to `Dialog` only when modal can't express your layout (see 2.3.3).

**2.3.1 Feedback presets**

```tsx
import { modal } from '@dlient-open/ui'

// Simple notices: button copy comes from the preset
modal.info({ title: 'Info', description: 'Saved' })
modal.success({ title: 'Done' })
modal.warn({ title: 'Warning', description: '…' })
modal.error({ title: 'Error', description: '…' })

// confirm: async handler supported (auto loading)
modal.confirm({
  title: 'Delete this item?',
  description: 'This cannot be undone.',
  confirmBtn: 'Delete',                       // string → custom copy; ReactNode → fully custom
  cancelBtn: null,                            // hide cancel
  onConfirm: async (ctx) => {
    await doDelete()
    // resolve → close; return false → keep open
  },
  onCancel: () => { /* optional; return false keeps it open */ },
  onClose: () => { /* any close path */ },
  api,                                        // pass useDlientApi() result; useI18n/useDlientApi work inside
})

// Danger default: red confirm theme
modal.delete({ title: 'Remove', description: '…' })

// Sync (await) form: confirm → true, cancel/close → false
const ok = await modal.sync.confirm('Delete this item?', 'This cannot be undone.')
if (ok) await doDelete()
```

`ModalOptions`: `icon?` (`null` hides icon) · `title?` / `description?` (ReactNode) · `confirmBtn` / `cancelBtn` (`string` copy / `ReactNode` / `null` hidden) · `closeBtn` (`boolean | ReactNode`) · `footer?` (fully replaces buttons) · `onConfirm(ctx)` / `onCancel(ctx)` (return `false` to keep open; returning a Promise auto-loads the confirm button) · `onClose()` · `width` (default 420) · `closeOnOverlayClick` / `closeOnEscKeydown` (default false) · `className` / `zIndex` · `api?` (PluginApi from `useDlientApi()`).

Returns `DuiModalInstance`: `.close()` (idempotent) · `.update(patch)` (update title/description/buttons in place) — good for progress or post-async button changes.

**2.3.2 `modal.dialog` / `createDialog` — custom layout**

When content needs an arbitrary layout (form, editor): `modal.dialog` (same as `createDialog`) renders a **top-anchored** dialog with zero-padding content — `header` / `body` / `footer` fully custom.

```tsx
const ins = modal.dialog({
  header: <h2>Edit config</h2>,
  body: <MyForm api={api} onSubmit={submit} />,   // no default buttons
  footer: (
    <div>
      <Button onClick={() => ins.close()}>Cancel</Button>
      <Button theme="primary" onClick={submit}>Save</Button>
    </div>
  ),
  width: 640,
  api,                                            // PluginApi → context available inside body
})

// update / close from anywhere
ins.update({ header: <h2>Saving…</h2> })
ins.close()
```

`DialogOptions`: `header?` / `body?`/`children?` (zero padding) / `footer?` · `closeBtn` · `width` (default 800) · `height?` (default = 2/3 of viewport max, scrollable body) · `top?` (default 0, top-anchored) / `placement: 'top' | 'center'` · `closeOnOverlayClick` / `closeOnEscKeydown` / `showOverlay` / `destroyOnClose` / `draggable` · `attach` · `className`/`dialogClassName`/`style`/`zIndex` · `api?` · `onClose` / `onOpened` / `onClosed`.

**2.3.3 When to fall back to `Dialog` / `AlertDialog`**

Only when modal can't express it (rare): e.g. fully custom capabilities modal doesn't expose. Then import `Dialog` / `AlertDialog` from `@dlient-open/ui` and follow the shared conventions (theme-aware, content area `max-width:100%; overflow:hidden`, dark scrollbars stay dark). Reviews favor `modal` by default.

## 3. State sharing (`useDientStore`) & events (`useDientEvent`)

Renderer-side state sharing and event passing go through the **store / event** modules of `@dlient-open/ui`. Identity (pluginId) is injected by the host — **unforgeable**. Isolated dialog roots keep context working when `modal` receives `api`.

### 3.1 Store — three-level namespaces

```tsx
import { useDientStore, useStoreValue } from '@dlient-open/ui'

const store = useDientStore()

// private (this plugin)
store.get('notes')            // T | undefined
store.set('notes', notes)
store.watch('notes', (prev, next, key) => {})

// org (shared by same-org plugins; disabled without an org)
store.org.get('shared-key')
store.org.set('shared-key', value)
store.org.watch('shared-key', (prev, next, key) => {})

// global (partitioned by writer; '@host' reserved for the host, get/watch default writer = '@host')
store.global.get('theme')                     // read host-published data
store.global.get('theme', 'other-plugin')     // read a specific writer
store.global.set('theme', 'dark')             // writer = self
store.global.watch('theme', (prev, next, key) => {}, '@host')
```

- Keys support dotted multi-level paths: `watch('aaa.bbb')` receives `aaa.bbb.ccc` changes; callbacks carry `actualKey`.
- **Reactive reads**: `useStoreValue(key, scope?, writerId?)` (`scope`: `'self'` default / `'org'` / `'global'`; `writerId` only for global, default `'@host'`) — re-renders only when the target key changes:

```tsx
const theme = useStoreValue('theme', 'global')        // read host '@host' theme
const myCount = useStoreValue('count')                // read this plugin's private key
```

- Host writes global: `setHostGlobal(key, value)` (host renderer only; plugin-side `store.global.get` defaults to reading it).
- Permissions: private = self only, org = same org, global = public read (knowing the writer id suffices); `global.set` always writes self, `@host` is host-only.

### 3.2 Event — three-level namespaces (stateless broadcast)

```tsx
import { useDientEvent } from '@dlient-open/ui'

const event = useDientEvent()

// self: emit / on / once
event.emit('data-changed', payload)
event.on('data-changed', (payload, meta) => {})        // returns an unsubscribe function
event.once('ready', (payload, meta) => {})

// org: same-org plugins receive (disabled without an org)
event.org.emit('member-updated', data)
event.org.on('member-updated', (payload, meta) => {})

// global: all plugins receive; listeners can filter by publisher (plugin id / '@host')
event.global.emit('app-theme', 'dark')
event.global.on('app-theme', (payload, meta) => {}, ['@host'])          // host only
event.global.on('app-theme', (payload, meta) => {}, ['@host', 'plugin-a']) // host + plugin A
event.global.on('app-theme', (payload, meta) => {})                       // all publishers
```

- Callback `(payload, meta)`, `meta`: `{ name, publisher, publisherOrg?, ts }`.
- No replay: an `on` registered after `emit` won't receive it; `once` fires once then unsubscribes.
- Host global events: `emitHostEvent(name, payload)` (host renderer only; plugins receive via `event.global.on(name, cb, ['@host'])`).

## 4. Access your own worker

```tsx
import { useDlientApi, isApiOk } from '@dlient-open/ui'

const api = useDlientApi()                       // bound to this plugin's view
const res = await api.request<string>('my-plugin.greet', ['world'])
if (isApiOk(res)) console.log(res.data)          // { ok, data, code } envelope
const off = api.onEvent('my-event', (data) => console.log(data))   // returns an unsubscribe function
```

## 5. i18n

```ts
// src/renderer/i18n.ts
import { addResourceBundle } from '@dlient-open/i18n'
addResourceBundle('my-plugin', {
  'zh-CN': { hello: '你好', btn: { save: '保存' } },
  'en-US': { hello: 'Hello', btn: { save: 'Save' } },
})
```

```tsx
// App.tsx
import './i18n'
import { useI18n } from '@dlient-open/i18n'
const { t } = useI18n()          // t('my-plugin.btn.save'); only {{name}} interpolation
```

- String values only substitute `{{name}}`; for logic use function messages: `key: ({ name }) => …`.
- Host/worker error codes are localized on this side — don't surface raw codes or worker hardcoded copy.

## 6. Full example

`src/renderer/App.tsx` (a notes plugin UI with store sharing):

```tsx
import { useEffect, useState } from 'react'
import { Button, Input, Card, Badge, Empty, toast, useDlientApi, useDientStore, useStoreValue, isApiOk } from '@dlient-open/ui'
import { useI18n } from '@dlient-open/i18n'
import './i18n'
import './styles.css'

const NS = 'my-plugin'

interface Note { id: number; text: string; ts: number }

export default function App() {
  const api = useDlientApi()
  const store = useDientStore()
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [notes, setNotes] = useState<Note[]>([])
  const [busy, setBusy] = useState(false)
  const globalCount = useStoreValue('note-count', 'global')   // read host '@host' counter

  const reload = async () => {
    const res = await api.request<Note[]>('my-plugin.listNotes')
    if (isApiOk(res)) setNotes(Array.isArray(res.data) ? res.data : [])
  }

  const save = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      const res = await api.request('my-plugin.saveNote', [text.trim()])
      if (isApiOk(res)) {
        setText('')
        store.set('note-count', notes.length + 1)          // private sharing
        await reload()
        toast.success(t(`${NS}.saved`))
      }
    } finally { setBusy(false) }
  }

  useEffect(() => {
    void reload()
    return api.onEvent('my-plugin.notes-changed', () => void reload())  // unsubscribe on unmount
  }, [api])

  return (
    <div className="app-root">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
        <Input value={text} placeholder={t(`${NS}.placeholder`)} onChange={(e) => setText(e.target.value)} />
        <Button theme="primary" disabled={busy} onClick={save}>{t(`${NS}.save`)}</Button>
      </div>

      {notes.length === 0 ? (
        <Empty description={t(`${NS}.empty`)} />
      ) : (
        <Card>
          {notes.map((n) => (
            <div key={n.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
              <span>{n.text}</span>
              <Badge variant="secondary">{new Date(n.ts).toLocaleString()}</Badge>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}
```

## 7. Theming & styles

- **CSS is auto-scoped**: your plugin's `.css` is rewritten by the build preset to `[data-plugin="<pluginId>"] :where(...)`, applying only to your view subtree and its portals (portals default to a body-level container with the same `data-plugin` attribute, so Dialog/Popover/Select/Tooltip overlays are styled automatically); host dialogs / `MessagePlugin` are unaffected. Use `:global(...)` to escape explicitly. See `docs/specs/plugin-css-scope.md`.
- Theme is tracked on `document.documentElement` (`dark` class; `localStorage['dlient-theme']`).
- shadcn components follow the theme automatically (`dui:`-prefixed tailwind variables: `--background` / `--foreground` / `--primary` / `--destructive` / `--muted` / `--border` / `--radius` …). For custom colors use two CSS variable sets:
  ```css
  :root { --app-bg: #fff; --app-fg: #222; }
  .dark { --app-bg: #1b1b1f; --app-fg: #ededf0; }
  ```
- Dark text should stay ≥ `#8A8A96` luminance; **dark scrollbars stay dark** (don't override the host's dark `::-webkit-scrollbar` with light colors).
- Dialog content areas need `max-width: 100%; overflow: hidden;`.
- Prefer lucide icons / `PluginIcon`; colors follow the theme automatically.

## 8. Worker/UI communication patterns

| Pattern | How |
| --- | --- |
| Call a worker method | UI `api.request('plugin.method', args)`; worker `registerHandler` |
| worker → UI event | worker pushes event; UI `api.onEvent(name, cb)` (unsubscribe on unmount) |
| renderer → renderer (same plugin) | `useDientStore()` private store / `useDientEvent()` self events |
| renderer → renderer (cross-plugin/org/host) | `useDientStore()` `org`/`global`, or `useDientEvent()` `org`/`global` (global supports publisher filtering) |
| host → renderer broadcast | `app.notify({ event, receiver, data })` (main process) / `setHostGlobal` / `emitHostEvent` (host renderer) |
| Cross-plugin view | `PluginView` |
| Long progress | worker pushes streamed events; UI subscribes and refreshes |

## 9. Logging

UI and worker logs share the same JSONL file (`USER_DATA/plugin-data/<pluginId>/logs/main.log`), distinguished by the `source` field. Read the file directly or pull lines through the log APIs.
