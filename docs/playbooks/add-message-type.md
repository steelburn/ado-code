# Playbook: Adding a New Message Type

How to add a new message type to the webview ↔ extension host communication.

## Overview

ADO Code uses typed message passing between the extension host and the
webview UI. Messages are defined in `src/shared/messages.ts` as
discriminated unions:

- **WebviewToExtensionMessage** — messages the UI sends to the host
- **ExtensionToWebviewMessage** — messages the host sends to the UI

## Steps

### 1. Define the message type

In `src/shared/messages.ts`, add a new variant to the appropriate union:

```typescript
// For messages from the webview TO the extension host:
export type WebviewToExtensionMessage =
  | { type: 'existingMessage'; /* ... */ }
  | { type: 'myNewMessage'; payload: MyPayload }  // ← add here

// For messages from the extension host TO the webview:
export type ExtensionToWebviewMessage =
  | { type: 'existingMessage'; /* ... */ }
  | { type: 'myNewResponse'; result: MyResult }   // ← add here
```

### 2. Handle in ChatViewProvider (host side)

In `src/webview/ChatViewProvider.ts`, add a handler in the message
listener:

```typescript
// In the onDidReceiveMessage callback:
switch (message.type) {
  // ... existing cases ...
  case 'myNewMessage':
    // Process the message
    const result = await processMyNewMessage(message.payload)
    // Send response back to webview
    this._panel.webview.postMessage({
      type: 'myNewResponse',
      result,
    })
    break
}
```

### 3. Handle in the webview UI (React side)

In `src/webview-ui/src/App.tsx` (or the relevant component), handle
the message:

```typescript
// Sending to extension host:
const sendMessage = (msg: WebviewToExtensionMessage) => {
  vscode.postMessage(msg)
}

// Handling responses:
useEffect(() => {
  const handler = (event: MessageEvent) => {
    const msg = event.data as ExtensionToWebviewMessage
    switch (msg.type) {
      // ... existing cases ...
      case 'myNewResponse':
        // Update React state
        setMyState(msg.result)
        break
    }
  }
  window.addEventListener('message', handler)
  return () => window.removeEventListener('message', handler)
}, [])
```

### 4. Add TypeScript types (if needed)

If your message carries new data shapes, add interfaces in
`src/shared/messages.ts`:

```typescript
export interface MyPayload {
  id: number
  text: string
}

export interface MyResult {
  success: boolean
  detail?: string
}
```

### 5. Wire up the extension command (if needed)

If the message triggers a VS Code command or service call, register
it in `src/extension.ts`:

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('adoCode.myCommand', async () => {
    // Trigger the message flow
  })
)
```

### 6. Write tests

Test the message handling in `src/test/suite/webview/`:

```typescript
suite('myNewMessage handling', () => {
  test('processes message correctly', async () => {
    // Test the handler logic
  })
})
```

## Message Flow Diagram

```
┌──────────┐                    ┌──────────────┐
│  Webview  │  postMessage()    │  Extension   │
│  (React)  │ ──────────────►   │  Host        │
│           │                   │  (Node.js)   │
│           │ ◄──────────────   │              │
│           │  webview.postMessage()            │
└──────────┘                    └──────────────┘
```

## Pitfalls

- **Type exhaustiveness**: TypeScript will flag if you add a new message
  type but forget to handle it in a `switch` statement. Use the
  exhaustive check pattern if needed:
  ```typescript
  const _exhaustive: never = msg
  ```
- **Message serialization**: Only JSON-serializable data can cross the
  webview boundary. No functions, circular references, or class instances.
- **State synchronization**: If the message updates React state, make
  sure the state shape is defined in `src/webview-ui/src/types.ts`.
- **Memory leaks**: Always clean up `message` event listeners in
  React `useEffect` cleanup functions.

## File Checklist

| File | Action |
|------|--------|
| `src/shared/messages.ts` | Edit (add to union) |
| `src/webview/ChatViewProvider.ts` | Edit (add handler) |
| `src/webview-ui/src/App.tsx` | Edit (add handler/sender) |
| `src/webview-ui/src/types.ts` | Edit (if new data shapes) |
| `src/extension.ts` | Edit (if new commands needed) |
| `src/test/suite/webview/*.test.ts` | Edit (add test) |
