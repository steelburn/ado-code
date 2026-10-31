import * as assert from 'assert';

import {
  QR_PANEL_TITLE,
  REMOTE_COPY_URL_COMMAND,
  REMOTE_ROTATE_TOKEN_COMMAND,
  REMOTE_SETTINGS_COMMAND,
  REMOTE_STOP_COMMAND,
  RemoteQrPanel,
  TUNNEL_START_COMMAND,
  renderQrHtml,
  type QrPanelHost,
  type RemoteQrPanelPayload,
} from '../../../remote/RemoteQrPanel';
import type { RemoteUrlResolution } from '../../../remote/remoteUrl';

const LOOPBACK = 'http://127.0.0.1:41414';

class FakePanel implements QrPanelHost {
  reveals = 0;
  disposals = 0;
  private listeners: Array<() => void> = [];
  /** Single source of truth for the rendered markup, shared with `webview`. */
  private readonly state = { html: '' };

  get html(): string {
    return this.state.html;
  }

  set html(value: string) {
    this.state.html = value;
  }

  /** Live view onto `html`, mirroring `vscode.WebviewPanel.webview`. */
  get webview(): { html: string } {
    return this.state;
  }

  onDidDispose(listener: () => void): void {
    this.listeners.push(listener);
  }

  reveal(): void {
    this.reveals += 1;
  }

  dispose(): void {
    this.disposals += 1;
    const pending = this.listeners;
    this.listeners = [];
    for (const listener of pending) {
      listener();
    }
  }
}

function createFakePanel(): FakePanel {
  return new FakePanel();
}

function localResolution(overrides: Partial<RemoteUrlResolution> = {}): RemoteUrlResolution {
  return {
    kind: 'local',
    url: `${LOOPBACK}/?t=abc`,
    loopbackUrl: `${LOOPBACK}/`,
    message: 'Local only — no public URL. This QR only works on this machine.',
    ...overrides,
  };
}

function payload(overrides: Partial<RemoteQrPanelPayload> = {}): RemoteQrPanelPayload {
  return {
    url: `${LOOPBACK}/?t=abc`,
    resolution: localResolution(),
    deviceCount: 0,
    ...overrides,
  };
}

interface Rig {
  panel: RemoteQrPanel;
  panels: FakePanel[];
  shown: number;
}

function createRig(): Rig {
  const panels: FakePanel[] = [];
  const rig: Rig = {
    panels,
    shown: 0,
    panel: new RemoteQrPanel({
      createPanel: () => {
        const created = createFakePanel();
        panels.push(created);
        return created;
      },
      onShown: () => {
        rig.shown += 1;
      },
    }),
  };
  return rig;
}

suite('RemoteQrPanel', () => {
  test('show opens one panel and renders the console URL', () => {
    const rig = createRig();
    rig.panel.show(payload());

    assert.strictEqual(rig.panels.length, 1, 'one panel');
    const html = rig.panels[0]!.html;
    assert.ok(html.includes('<svg'), 'renders a QR code');
    assert.ok(html.includes(`${LOOPBACK}/?t=abc`), 'shows the URL');
    assert.ok(rig.panel.isOpen);
  });

  test('a second show re-renders in place instead of opening another panel', () => {
    const rig = createRig();
    rig.panel.show(payload());
    rig.panel.show(payload({ url: `${LOOPBACK}/?t=def`, resolution: localResolution({ url: `${LOOPBACK}/?t=def` }) }));

    assert.strictEqual(rig.panels.length, 1, 'no second panel');
    assert.ok(rig.panels[0]!.html.includes('?t=def'), 'html follows the new URL');
    assert.ok(!rig.panels[0]!.html.includes('?t=abc'), 'stale URL is gone');
  });

  test('setUrl before the panel was ever opened is a no-op', () => {
    const rig = createRig();
    rig.panel.setUrl(`${LOOPBACK}/?t=abc`);

    assert.strictEqual(rig.panels.length, 0, 'no panel is opened implicitly');
  });

  test('setUrl updates an open panel and reveals it', () => {
    const rig = createRig();
    rig.panel.show(payload());
    const before = rig.panels[0]!.reveals;
    rig.panel.setUrl(`${LOOPBACK}/?t=xyz`, localResolution({ url: `${LOOPBACK}/?t=xyz` }));

    assert.strictEqual(rig.panels.length, 1);
    assert.ok(rig.panels[0]!.html.includes('?t=xyz'));
    assert.strictEqual(rig.panels[0]!.reveals, before + 1, 'revealed again');
  });

  test('dispose closes the panel and later updates are no-ops', () => {
    const rig = createRig();
    rig.panel.show(payload());
    const htmlBefore = rig.panels[0]!.html;

    rig.panel.dispose();

    assert.strictEqual(rig.panels[0]!.disposals, 1, 'panel disposed');
    assert.strictEqual(rig.panel.isOpen, false);

    rig.panel.setUrl(`${LOOPBACK}/?t=later`);
    assert.strictEqual(rig.panels[0]!.html, htmlBefore, 'no re-render after dispose');
  });

  test('after the user closes the panel, the next show opens a new one', () => {
    const rig = createRig();
    rig.panel.show(payload());
    rig.panels[0]!.dispose();
    assert.strictEqual(rig.panel.isOpen, false);

    rig.panel.show(payload());
    assert.strictEqual(rig.panels.length, 2, 'reopened');
  });

  test('onShown fires once per open, not on a re-render', () => {
    const rig = createRig();
    assert.strictEqual(rig.shown, 0);

    rig.panel.show(payload());
    assert.strictEqual(rig.shown, 1);

    rig.panel.show(payload());
    assert.strictEqual(rig.shown, 1, 're-render does not fire again');

    rig.panels[0]!.dispose();
    rig.panel.show(payload());
    assert.strictEqual(rig.shown, 2);
  });

  test('a local-only URL warns and offers the tunnel command', () => {
    const html = renderQrHtml(payload({ resolution: localResolution() }));

    assert.ok(html.includes('Local only'), 'warns it is local only');
    assert.ok(html.includes(`command:${TUNNEL_START_COMMAND}`), 'offers the tunnel command');
  });

  test('a tunnel URL replaces the loopback URL in the QR and drops the call to action', () => {
    const tunnelUrl = 'https://random-words-here.trycloudflare.com/?t=abc';
    const html = renderQrHtml(
      payload({
        url: tunnelUrl,
        tunnelUrl,
        resolution: {
          kind: 'tunnel',
          url: tunnelUrl,
          loopbackUrl: `${LOOPBACK}/`,
          message: 'Reachable through the tunnel.',
        },
      }),
    );

    assert.ok(html.includes(tunnelUrl), 'shows the tunnel URL');
    assert.ok(!html.includes(LOOPBACK), 'never prints the loopback URL');
    assert.ok(html.includes('<svg'), 'still renders a QR code');
    assert.ok(!html.includes(`command:${TUNNEL_START_COMMAND}`), 'no tunnel prompt when a tunnel runs');
  });

  test('an externally forwarded URL is announced as port forwarding', () => {
    const external = 'https://example-41414.devtunnels.ms/?t=abc';
    const html = renderQrHtml(
      payload({
        url: external,
        resolution: {
          kind: 'external',
          url: external,
          loopbackUrl: `${LOOPBACK}/`,
          message: 'Provided by VS Code port forwarding.',
        },
      }),
    );

    assert.ok(/port forwarding/i.test(html), 'mentions port forwarding');
    assert.ok(html.includes(external));
    assert.ok(!html.includes(`command:${TUNNEL_START_COMMAND}`), 'no tunnel prompt needed');
  });

  test('no URL renders a placeholder instead of a broken QR', () => {
    const html = renderQrHtml(
      payload({
        url: '',
        resolution: {
          kind: 'unavailable',
          url: null,
          loopbackUrl: `${LOOPBACK}/`,
          message: 'Remote access is off.',
        },
      }),
    );

    assert.ok(!html.includes('<svg'), 'no QR for a missing URL');
    assert.ok(html.includes('Remote access is off'));
  });

  test('the document is self-contained: CSP, no script, no remote resources', () => {
    const html = renderQrHtml(payload());

    assert.ok(/Content-Security-Policy/.test(html), 'declares a CSP');
    assert.ok(/default-src 'none'/.test(html), 'denies remote loads');
    assert.ok(!/<script/i.test(html), 'no scripts');
    assert.ok(!/https?:\/\/[^"' ]*\.(js|css)/i.test(html), 'no remote resources');
  });

  test('the panel title is exported for the host to use', () => {
    assert.strictEqual(QR_PANEL_TITLE, 'Remote Access');
  });

  test('the panel carries the off switch and the reconfiguration links', () => {
    const html = renderQrHtml(payload({ resolution: localResolution() }));

    assert.ok(html.includes(`command:${REMOTE_STOP_COMMAND}`), 'offers turning remote access off');
    assert.ok(html.includes(`command:${REMOTE_COPY_URL_COMMAND}`), 'offers copying the URL');
    assert.ok(html.includes(`command:${REMOTE_ROTATE_TOKEN_COMMAND}`), 'offers rotating the token');
    assert.ok(
      html.includes(`command:${REMOTE_SETTINGS_COMMAND}`),
      'offers opening the remote settings',
    );
    assert.ok(
      REMOTE_SETTINGS_COMMAND.startsWith('workbench.action.openSettings?'),
      'the settings link is a command URI with an encoded query',
    );
    assert.ok(
      decodeURIComponent(REMOTE_SETTINGS_COMMAND).includes('adoCode.remote'),
      'the query narrows to the remote settings',
    );
    assert.ok(!/<script/i.test(html), 'still no scripts');
  });

  test('the action row is there whatever the URL resolves to', () => {
    const tunnel = renderQrHtml(
      payload({
        resolution: {
          kind: 'tunnel',
          url: 'https://abc.trycloudflare.com/?t=abc',
          loopbackUrl: `${LOOPBACK}/`,
          message: 'Reachable through the tunnel.',
        },
      }),
    );
    const unavailable = renderQrHtml(
      payload({ resolution: { kind: 'unavailable', url: '', loopbackUrl: '', message: 'Off.' } }),
    );

    for (const html of [tunnel, unavailable]) {
      assert.ok(html.includes(`command:${REMOTE_STOP_COMMAND}`), 'an off switch is always offered');
    }
  });
});
