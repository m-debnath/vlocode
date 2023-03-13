import { SalesforceService, SalesforceDeployService } from '@vlocode/salesforce';
import { injectable, Logger } from '@vlocode/core';
import { OmniScriptDefinition, OmniScriptSpecification } from './omniScriptDefinition';
import { spreadAsync, Timer } from '@vlocode/util';
import { OmniScriptLwcCompiler } from './omniScriptLwcCompiler';
import { ScriptDefinitionProvider } from './scriptDefinitionProvider';
import { OmniScriptDefinitionProvider } from './omniScriptDefinitionProvider';
import { OmniScriptLookupService, OmniScriptRecord } from './omniScriptLookupService';
import { OmniScriptLocalDefinitionProvider } from './omniScriptDefinitionGenerator';

export interface OmniScriptActivationOptions {
    /**
     * Skip deployment of LWC components even when the script is LWC enabled.
     * By default activation will rebuild and deploy the LWC component of the script; setting this option to `true` will skip this step.
     */
    skipLwcDeployment?: boolean;
    /**0
     * When `true`, the LWC components will be updated an deployed using the tooling API instead of the metadata API.
     * The benefit of this is that the LWC components will be deployed to the org without the need to deploy the entire package.
     */
    toolingApi?: boolean;
    /**
     * When `true`, the script will be activated using the standard Vlocity APEX activation function exposed by the
     * Vlocity Business Process Controller that runs as anonymous Apex.
     *
     * When `false` (default) the script will be activated by locally generating the script activation records. This is faster compared to
     * the remote activation and avoids issues with governor limits that occur when activating a large scripts.
     */
    remoteActivation?: boolean;
}

/**
 * Activates an OmniScript creating compiled OmniScriptDefinition__c records in Salesforce and sets the script state to active.
 */
@injectable()
export class OmniScriptActivator {

    /**
     * Method that is called to activate a single the script
     */
    private readonly remoteActivationFunction = `%vlocity_namespace%.BusinessProcessController.bulkActivateBP(new List<Id> { '%script_id%' });`;

    constructor(
        private readonly salesforceService: SalesforceService,
        private readonly lookup: OmniScriptLookupService,
        private readonly lwcCompiler: OmniScriptLwcCompiler,
        @injectable.param(ScriptDefinitionProvider) private readonly definitionProvider: OmniScriptDefinitionProvider,
        @injectable.param(OmniScriptLocalDefinitionProvider) private readonly definitionGenerator: OmniScriptDefinitionProvider,
        private readonly logger: Logger
    ) {
    }

    /**
     * Activates the specified OmniScript, creates the OmniScriptDefinition__c records in Salesforce and sets the OmniScript to active.
     * Any existing active OmniScriptDefinition__c records will be deleted.
     * @param input OmniScript to activate
     */
    public async activate(input: OmniScriptSpecification | string, options?: { skipLwcDeployment?: boolean, toolingApi?: boolean, remoteActivation?: boolean }) {
        const script = await this.lookup.getScript(input);

        // (Re-)Activate script
        if (options?.remoteActivation) {
            await this.remoteScriptActivation(script);
        } else {
            await this.localScriptActivation(script);
        }

        // Deploy LWC when required
        if (options?.skipLwcDeployment !== true && script.isLwcEnabled) {
            const definition = await this.definitionProvider.getScriptDefinition(script.id);
            await this.deployLwcComponent(definition, options);
        }
    }

    private async remoteScriptActivation(script: OmniScriptRecord) {
        const result = await this.salesforceService.executeAnonymous(this.remoteActivationFunction.replace(/%script_id%/, script.id), { updateNamespace: true });
        if (!result.success) {
            if (!result.compiled) {
                throw new Error(`APEX Compilation error at script activation: ${result.compileProblem}`);
            }
            throw new Error(`Activation error: ${result.exceptionMessage}`);
        }
        return this.definitionProvider.getScriptDefinition(script.id);
    }

    private async localScriptActivation(script: OmniScriptRecord) {
        const definition = await this.definitionGenerator.getScriptDefinition(script);
        await this.updateScriptDefinition(script.id, definition);
        await this.setAsActiveVersion(script);
        await this.deleteAllInactiveScriptDefinitions(script.id);
        return definition;
    }

    private async setAsActiveVersion(script: OmniScriptRecord) {
        const allVersions = await this.lookup.getScriptVersions(script);
        const scriptUpdates = allVersions
            .filter(version => version.isActive ? version.id !== script.id : version.id === script.id)
            .map(version => ({ id: version.id, isActive: script.id === version.id }));

        const versionDeactivations = scriptUpdates.filter(version => !version.isActive);
        const versionActivations = scriptUpdates.filter(version => version.isActive);

        // It is not possible to activate a new version and de-activate the old version in the same update
        // due to a there being trigger on the OmniScript__c object that ensures only one active version is allowed

        if (versionDeactivations.length) {
            for await (const updateResult of this.salesforceService.update('%vlocity_namespace%__OmniScript__c', versionDeactivations)) {
                if (!updateResult.success) {
                    throw new Error(`Unable to de-activate old script version due to Salesforce error: ${updateResult.error}`);
                }
            }
        }

        if (versionActivations.length) {
            for await (const updateResult of this.salesforceService.update('%vlocity_namespace%__OmniScript__c', versionActivations)) {
                if (!updateResult.success) {
                    throw new Error(`Unable set activate script version due to Salesforce error: ${updateResult.error}`);
                }
            }
        }
    }

    private async updateScriptDefinition(scriptId: string, definition: OmniScriptDefinition) {
        const contentChunks = this.serializeDefinition(definition);
        const records = contentChunks.map((content, index) => ({
            ref: `${scriptId}_${index}`,
            values: {
                content: content,
                sequence: index,
                omniScriptId: scriptId,
            }
        }));

        await this.deleteScriptDefinition(scriptId);

        for await (const insertResult of this.salesforceService.insert('%vlocity_namespace%__OmniScriptDefinition__c', records)) {
            if (!insertResult.success) {
                throw new Error(`Failed to insert OmniScript activation records: ${insertResult.error}`);
            }
        }
    }

    /**
     * Serializes and split the OmniScript definition into chunks of max 131072 characters to avoid the 131072 character limit of the Salesforce String field.
     *
     * The split ensures that chunks will never start or end with a whitespace character as whitespace characters are trimmed when saving the record.
     *
     * @param definition JSON definition of the OmniScript
     * @returns Array of strings containing the serialized OmniScript definition
     */
    private serializeDefinition(definition: OmniScriptDefinition, chunkSize = 131072) {
        const serializedDefinition = JSON.stringify(definition);
        const contentChunks = new Array<string>();
        let offset = 0;

        while(serializedDefinition.length > offset) {
            let splitIndex = offset + chunkSize;
            while(/\s/.test(serializedDefinition[splitIndex]) || (splitIndex+1 < serializedDefinition.length && /\s/.test(serializedDefinition[splitIndex+1]))) {
                // while the end or start of the chunk is a whitespace character, move the split index backward
                splitIndex--;
            }
            contentChunks.push(serializedDefinition.substring(offset, splitIndex));
            offset = splitIndex;
        }

        return contentChunks;
    }

    /**
     * Deletes the OmniScriptDefinition__c records for the specified OmniScript
     * @param input OmniScript to clean the script definitions for
     */
    private async deleteScriptDefinition(scriptId: string) {
        const results = await this.salesforceService.deleteWhere('%vlocity_namespace%__OmniScriptDefinition__c', {
            omniScriptId: scriptId
        });
        if (results.some(result => !result.success)) {
            this.logger.warn(
                `Unable to delete all definition record(s) for script with Id "${scriptId}"`,
                results.map(result => result.error).join(', '));
        }
    }

    private async deleteAllInactiveScriptDefinitions(input: OmniScriptSpecification | string) {
        const script = typeof input === 'string' ? await this.lookup.getScriptVersionSpecification(input) : input;
        const results = await this.salesforceService.deleteWhere('%vlocity_namespace%__OmniScriptDefinition__c', {
            omniScriptId: {
                type: script.type,
                subType: script.subType,
                language: script.language,
                isActive: false
            }
        });
        if (results.some(result => !result.success)) {
            this.logger.warn(
                `Unable to delete all definition record(s) for script ${script.type}/${script.subType}/${script.language}`,
                results.map(result => result.error).join(', '));
        }
    }

    /**
     * Activate the LWC component for the specified OmniScript regardless of the script is LWC enabled or not.
     * @param id Id of the OmniScript for which to activate the LWC component
     */
    public async activateLwc(id: string, options?: { toolingApi?: boolean }) {
        const definition = await this.definitionProvider.getScriptDefinition(id);
        await this.deployLwcComponent(definition, options);
    }

    /**
     * Get the LWC component bundle as metadata package for the specified OmniScript
     * @param id Id of the OmniScript
     * @returns Deployable Metadata package
     */
    public async getLwcComponentBundle(id: string) {
        const definition = await this.definitionProvider.getScriptDefinition(id);
        return this.lwcCompiler.compileToPackage(definition);
    }

    private async deployLwcComponent(definition: OmniScriptDefinition, options?: { toolingApi?: boolean }) {
        const timer = new Timer();
        const apiLabel = options?.toolingApi ? 'tooling' : 'metadata';
        this.logger.info(`Deploying LWC ${definition.bpType}/${definition.bpSubType} (${apiLabel} api)...`);

        if (options?.toolingApi) {
            await this.deployLwcWithToolingApi(definition);
        } else {
            await this.deployLwcWithMetadataApi(definition);
        }

        this.logger.info(`Deployed LWC ${definition.bpType}/${definition.bpSubType} in ${timer.toString("seconds")}`);
    }

    private async deployLwcWithMetadataApi(definition: OmniScriptDefinition) {
        const sfPackage = await this.lwcCompiler.compileToPackage(definition);
        const deployService = new SalesforceDeployService(this.salesforceService, Logger.null);
        const result = await deployService.deployPackage(sfPackage);
        if (!result.success) {
            throw new Error(`OmniScript LWC Component deployment failed: ${result.details?.componentFailures.map(failure => failure.problem)}`);
        }
    }

    private async deployLwcWithToolingApi(definition: OmniScriptDefinition) {
        const tollingRecord = await this.lwcCompiler.compileToToolingRecord(definition)
        const result = await this.upsertToolingRecord(`LightningComponentBundle`, tollingRecord);
        if (!result.success) {
            throw new Error(`OmniScript LWC Component deployment failed: ${JSON.stringify(result.errors)}`);
        }
    }

    private async upsertToolingRecord(type: string, toolingRecord: { Id?: string, FullName: string, Metadata: any }): Promise<{ success: boolean, errors: string[] }> {
        const connection = await this.salesforceService.getJsForceConnection();
        if (!toolingRecord.Id) {
            const existingRecord = await connection.tooling.query<{ Id: string }>(`SELECT Id FROM ${type} WHERE DeveloperName = '${toolingRecord.FullName}'`);
            if (existingRecord.totalSize > 0) {
                toolingRecord.Id = existingRecord.records[0].Id;
            }
        }

        const result: any = toolingRecord.Id
            ? await connection.tooling.update(type, toolingRecord)
            : await connection.tooling.create(type, toolingRecord)

        if (result === '') {
            // Patch can return status 204 with an empty body meaning the resource was not changed
            return { success: true, errors: [] };
        }
        return result;
    }
}
