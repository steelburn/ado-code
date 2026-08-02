import React, { useState, useEffect } from 'react';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './types';
import { MarkdownRenderer } from './components/MarkdownRenderer';
import './styles/markdown.css';

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToExtensionMessage): void;
  getState(): any;
  setState(state: any): void;
};

const vscode = acquireVsCodeApi();

function App() {
  const [messages, setMessages] = useState<{role: string; content: string}[]>([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'assistantMessage':
          // Stream accumulation: append chunks to the CURRENT assistant bubble,
          // and only seal it when done:true arrives. Prevents N bubbles per turn.
          setMessages(prev => {
            if (msg.done) {
              return prev; // bubble already final; message stream ended
            }
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') {
              const updated = [...prev];
              updated[updated.length - 1] = { role: 'assistant', content: last.content + msg.content };
              return updated;
            }
            return [...prev, { role: 'assistant', content: msg.content }];
          });
          break;
      }
    });
  }, []);

  const sendMessage = () => {
    if (!input.trim()) return;
    setMessages(prev => [...prev, { role: 'user', content: input }]);
    vscode.postMessage({ type: 'userMessage', content: input });
    setInput('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: '8px' }}>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {messages.map((m, i) => (
          <div key={i} style={{ margin: '4px 0', padding: '8px', borderRadius: '4px',
            background: m.role === 'user' ? 'var(--vscode-editor-background)' : 'var(--vscode-sideBar-background)' }}>
            <strong>{m.role === 'user' ? 'You' : 'ADO Code'}:</strong>{' '}
            {m.role === 'user' ? m.content : <MarkdownRenderer content={m.content} />}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '4px' }}>
        <input value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendMessage()}
          style={{ flex: 1 }} placeholder="Ask anything..." />
        <button onClick={sendMessage}>Send</button>
      </div>
    </div>
  );
}

export default App;
