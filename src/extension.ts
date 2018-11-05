'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as vlocity from 'vlocity';
import * as path from 'path';
import * as process from 'process';
import * as constants from './constants';
import VlocodeConfiguration from './models/VlocodeConfiguration';
import VlocodeService from './services/vlocodeService';
import * as vds from './services/vlocityDatapackService';
import * as s from './singleton';
import * as c from './commands';
import * as l from './loggers';

function setVlocityToolsLogger(){
    const vlocityLogFilterRegex = [
        /^(Current Status|Elapsed Time|Version Info|Initializing Project|Using SFDX|Salesforce Org|Continuing Export|Adding to File|Deploy).*/,
        /^(Success|Remaining|Error).*?[0-9]+$/
    ];
    vds.setLogger(new l.ChainLogger( 
        new l.LogFilterDecorator(new l.OutputLogger(s.get(VlocodeService).outputChannel), (args: any[]) => 
            !vlocityLogFilterRegex.some(r => r.test(args.join(' ')))
        ),  
        new l.ConsoleLogger()
    ));
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

    // Init logging and regsiter services
    let vloService = s.register(VlocodeService, new VlocodeService(context, VlocodeConfiguration.fromWorkspaceConfiguration(constants.CONFIG_SECTION)));
    let logger = s.register(l.Logger, new l.ChainLogger( 
        new l.OutputLogger(vloService.outputChannel),  
        new l.ConsoleLogger()        
    ));

    // Report some thing so that the users knows we are active
    logger.info(`Vlocode version ${constants.VERSION} started`);
    setVlocityToolsLogger();    

    // Resgiter all datapack commands from the commands file
    c.datapackCommands
        .map(cmd => {
            logger.verbose(`Register command ${cmd.name}`);
            return vscode.commands.registerCommand(cmd.name, async (...args) => {     
                try {
                    s.get(VlocodeService).validateConfig();
                    s.get(VlocodeService).validateSalesforce();
                } catch (err) {
                    logger.error(`${cmd.name}: ${err}`);
                    return vscode.window.showErrorMessage(err, { modal: false }, { title: 'Open settings' }).then(r => 
                        r === undefined || vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', 'test'));
                }
                logger.verbose(`Invoke command ${cmd.name}`);
                try {
                    await cmd.execute.apply(cmd, args);
                    logger.verbose(`Execution of command ${cmd.name} done`);
                } catch(err) {
                    logger.error(`Command execution resulted in error: ${err}`);
                }
            });
        })
        .forEach(sub => context.subscriptions.push(sub));
}


// this method is called when your extension is deactivated
export function deactivate() {
}