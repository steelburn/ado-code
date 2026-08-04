import * as vscode from 'vscode';

export enum LogLevel {
  Info = 'INFO',
  Warn = 'WARN',
  Error = 'ERROR',
  Debug = 'DEBUG',
}

class Logger {
  private channel?: vscode.OutputChannel;

  activate(context: vscode.ExtensionContext): void {
    this.channel = vscode.window.createOutputChannel('ADO Code');
    context.subscriptions.push(this.channel);
    this.info('Extension activated');
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (!this.channel) return;
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}]`;
    this.channel.appendLine(`${prefix} ${message}`);
    if (data !== undefined) {
      const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      this.channel.appendLine(json);
    }
  }

  info(message: string, data?: unknown): void { this.log(LogLevel.Info, message, data); }
  warn(message: string, data?: unknown): void { this.log(LogLevel.Warn, message, data); }
  error(message: string, data?: unknown): void { this.log(LogLevel.Error, message, data); }
  debug(message: string, data?: unknown): void { this.log(LogLevel.Debug, message, data); }

  getChannel(): vscode.OutputChannel | undefined { return this.channel; }
}

export const logger = new Logger();
