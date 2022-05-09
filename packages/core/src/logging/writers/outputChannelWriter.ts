import type { OutputChannel } from 'vscode';
import * as moment from 'moment';
import { LogWriter, LogEntry, LogLevel } from '../../logging';

export class OutputChannelWriter implements LogWriter {

    public static LOG_DATE_FORMAT = "HH:mm:ss.SS";

    private _outputChannel: OutputChannel;

    public get outputChannel(): OutputChannel {
        return this._outputChannel || (this._outputChannel = require('vscode').window.createOutputChannel(this.channelName));
    }

    constructor(private readonly channelName: string) {
    }

    public dispose() {
        if (this._outputChannel) {
            this._outputChannel.hide();
            this._outputChannel.dispose();
        }
    }

    public focus() {
        this._outputChannel?.show(true);
    }

    public write({level, time, message} : LogEntry) : void {
        const levelPrefix = (LogLevel[level] || 'unknown')[0];
        this.outputChannel.appendLine(`[${moment(time).format(OutputChannelWriter.LOG_DATE_FORMAT)}] ${levelPrefix}: ${message}`);
    }
}