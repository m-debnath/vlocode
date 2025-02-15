
import { QueryService, SalesforceLookupService, SalesforceSchemaService, RecordBatch, RecordBatchOptions, SalesforceConnectionProvider, Field } from '@vlocode/salesforce';
import { Logger, injectable, container, LifecyclePolicy, Container } from '@vlocode/core';
import { Timer, groupBy, Iterable, CancellationToken, forEachAsyncParallel, isReadonlyArray, removeNamespacePrefix, CustomError, getErrorMessage } from '@vlocode/util';
import { NAMESPACE_PLACEHOLDER } from './constants';
import { DatapackDeployment } from './datapackDeployment';
import { DatapackDeploymentRecord, DeploymentStatus } from './datapackDeploymentRecord';
import { DatapackDeploymentRecordGroup } from './datapackDeploymentRecordGroup';
import { DatapackRecordFactory } from './datapackRecordFactory';
import { DatapackDeploymentSpec, DeploymentSpecExecuteOptions } from './datapackDeploymentSpec';
import { DatapackDeploymentSpecRegistry } from './datapackDeploymentSpecRegistry';
import { DatapackDeploymentEvent } from './datapackDeploymentEvent';
import { VlocityDatapack } from '@vlocode/vlocity';

/**
 * Import all default deployment specs and trigger the decorators to register each sepc
 * in the deployment spec registry singleton
 */
import './deploymentSpecs';

export type VlocityDataPackDependencyType = 'VlocityMatchingKeyObject' | 'VlocityLookupMatchingKeyObject';

export type DatapackRecordDependency = {
    VlocityRecordSObjectType: string;
    [key: string]: any;
} & ({
    VlocityDataPackType: 'VlocityMatchingKeyObject';
    VlocityMatchingRecordSourceKey: string;
    VlocityLookupRecordSourceKey: undefined;
} | {
    VlocityDataPackType: 'VlocityLookupMatchingKeyObject';
    VlocityMatchingRecordSourceKey: undefined;
    VlocityLookupRecordSourceKey: string;
});

export interface DependencyResolver {
    resolveDependency(dep: DatapackRecordDependency): Promise<string | undefined>;
    resolveDependencies(dependencies: DatapackRecordDependency[]): Promise<Array<string | undefined>>;
}

export interface DatapackDeploymentOptions extends RecordBatchOptions {
    /**
     * Disable all Vlocity Triggers before starting the deployment; triggers are automatically re-enabled after the deployment completes.
     * @default false
     */
    disableTriggers?: boolean;
    /**
     * Number of times to retry the update or insert operation when it fails; defaults to 1 when not set
     * @default 1
     */
    maxRetries?: number;
    /**
     * Chunk size for retrying failed records; defaults to 5
     * @default 5
     */
    retryChunkSize?: number;
    /**
     * Attempt to lookup dependencies that are part of the deployment but failed to deploy. By setting this to true when part of a datapack fails to deploy
     * the deployment will attempt to lookup an existing record that also matches the lookup requirements. This can help resolve deployment issues whe
     * deploying datapacks from which the parent record cannot be updated, but it does introduce a risk of incorrectly linking records.
     * @default false
     */
    lookupFailedDependencies?: boolean;
    /**
     * Purge dependent records after deploying any record. This setting controls whether or not the deployment will delete direct dependencies linked
     * through a matching (not lookup) dependency. This is especially useful to delete for example PCI records and ensure that old relationships are deleted.
     * @default false
     */
    purgeMatchingDependencies?: boolean;
    /**
     * When @see DatapackDeploymentOptions.purgeMatchingDependencies is enabled this setting controls how embedded datapacks are deleted from the target org
     * when enabled purging of existing records happens in bulk, this is more efficient but in this mode it is not possible to related errors while deleting
     * records to a particular datapack.
     * @default true
     */
    purgeLookupOptimization?: boolean;
    /**
     * When enabled teh deployment wil check for changes between the datapack source and the source org and only deploy
     * @default false;
     */
    deltaCheck?: boolean;
    /**
     * Continue the deployment when a fatal error occurs, note that continuing the deployment on fatal errors will result in an incomplete deployment. This setting
     * affects fatal errors such as unable to convert a datapack to valid Salesforce records and should not be enabled on production deployments.
     * @default false;
     */
    continueOnError?: boolean;
    /**
     * When strict order is enabled the deployment will wait for all records in a datapack to complete before proceeding with deploying
     * any dependent datapacks. By default Vlocode determines deployment order based on record level dependencies this allows for optimal 
     * chunking improving the overall speed of the deployment. By setting `strictOrder` to `true` Vlocode also enforces that any datapack 
     * that is dependent on another datapack is deployed after the datapack it depends on.
     *
     * Enabling this reduces deployment performance as the deployment will be split in smaller chunks increasing the number of API calls to Salesforce.
     * @default false;
     */
    strictOrder?: boolean;
    /**
     * When enabled the deployment will not fail when a dependency cannot be resolved. If a record has a dependency that cannot be resolved the 
     * record will normally be skipped  as deploying the record would fail or cause a corrupted state in the org.
     *
     * When this option is enabled records the deployment will try to deploy the record wihtout resolving the dependency. Only enable this if you are
     * sure that all records can be deployed without all dependencies resolved.
     * @default false;
     */
    allowUnresolvedDependencies?: boolean;
    /**
     * When enabled LWC enabled OmniScripts will not get compiled into native LWC components and be deployed to the target org during deployment.
     *
     * Use this if you want to manually compile OmniScripts into LWC or have a batch process ot activate OmniScript LWCs in bulk.
     * @default false;
     */
    skipLwcActivation?: boolean;
    /**
     * When true LWC components are deployed using the metadata API instead of the tooling API. The tooling API is usually faster and thus the preferred way to compiled deploy LWC components.
     *
     * Disable this if you need to use the metadata API to deploy LWC components.
     * @default false;
     */
    useMetadataApi?: boolean;
    /**
     * When enabled the deployment will activate OmniScripts in the target org using Anonyms Apex.
     * @default false;
     */
    remoteScriptActivation?: boolean;
}

export type DatapackFilter =
    { recordFilter?: RegExp | string, datapackFilter: RegExp | string } |
    { recordFilter: RegExp | string, datapackFilter?: RegExp | string };

@injectable({ lifecycle: LifecyclePolicy.transient })
export class DatapackDeployer {

    private readonly container = (this.creatingContainer ?? container).new();
    private readonly specRegistry = this.container.get(DatapackDeploymentSpecRegistry);

    constructor(
        private readonly connectionProvider: SalesforceConnectionProvider,
        private readonly objectLookupService: SalesforceLookupService,
        private readonly schemaService: SalesforceSchemaService,
        private readonly logger: Logger,
        private readonly creatingContainer?: Container) {
    }

    /**
     * Create new Datapack deployment
     * @param datapacks Datapacks to deploy
     * @returns Datapack deployment object
     */
    public async createDeployment(datapacks: VlocityDatapack[], options?: DatapackDeploymentOptions, cancellationToken?: CancellationToken) {
        this.container.register(this.container.create(QueryService, this.connectionProvider).setCacheDefault(false));
        const deployment = this.container.create(DatapackDeployment, options);
        const recordFactory = this.container.create(DatapackRecordFactory);

        deployment.on('afterDeployGroup', group => this.afterDeployRecordGroup(deployment, group));
        deployment.on('beforeDeployGroup', group => this.beforeDeployRecordGroup(deployment, group));
        deployment.on('afterDeployRecord', records => this.afterDeployRecord(deployment, records));
        deployment.on('beforeDeployRecord', records => this.beforeDeployRecord(deployment, records));

        const timerStart = new Timer();
        this.logger.info('Converting datapacks to Salesforce records...');
        await forEachAsyncParallel(datapacks, async (datapack) => {
            if (cancellationToken?.isCancellationRequested) {
                return;
            }
            try {
                await this.runSpecFunction('preprocess', { args: [ datapack ] });
                const records = await recordFactory.createRecords(datapack);
                await this.runSpecFunction('afterRecordConversion', { args: [ records ], ignoreErrors: options?.continueOnError, errorSeverity: 'error' });
                deployment.add(...records);
            } catch(err) {
                const errorMessage = `Error while loading Datapack '${datapack.headerFile}' -- ${getErrorMessage(err)}`;
                if (!options?.continueOnError) {
                    throw new CustomError(errorMessage, err);
                }
                this.logger.error(errorMessage);
            }
        }, 8);
        this.logger.info(`Converted ${datapacks.length} datapacks to ${deployment.totalRecordCount} records [${timerStart.stop()}]`);

        return deployment;
    }

    /**
     * Creates and starts a deployment returning the {@link DatapackDeployment} object which contains results of the deployment.
     * @param datapacks Datapacks to deploy
     * @param options options passed to the deployment
     * @param cancellationToken optional cancellation token
     * @returns
     */
    public async deploy(datapacks: VlocityDatapack[], options?: DatapackDeploymentOptions, cancellationToken?: CancellationToken) {
        const deployment = await this.createDeployment(datapacks, options, cancellationToken);
        return deployment.start(cancellationToken).then(() => deployment);
    }

    /**
     * Disable or enable all Vlocity triggers
     * @param newTriggerState true to enable all Vlocity Triggers; false to disabled all Vlocity triggers
     */
    private async setVlocityTriggerState(newTriggerState: boolean) {
        const timer = new Timer();
        const connection = await this.connectionProvider.getJsForceConnection();
        const triggerSetupObject = await this.schemaService.describeSObject(`${NAMESPACE_PLACEHOLDER}__TriggerSetup__c`);
        const triggerOnField = await this.schemaService.describeSObjectField(triggerSetupObject.name, 'IsTriggerOn__c');

        const allTriggersName = 'AllTriggers';
        const allTriggerSetup = await this.objectLookupService.lookupSingle(triggerSetupObject.name, { Name: allTriggersName }, [ 'Id', 'Name', triggerOnField.name ]);

        if (!allTriggerSetup) {
            // Triggers not setup; create new record to disable all triggers
            await connection.insert(triggerSetupObject.name, { Name: allTriggersName, [triggerOnField.name]: newTriggerState });
        } else if (allTriggerSetup[triggerOnField.name] != newTriggerState) {
            // Update current trigger state when required
            await connection.update(triggerSetupObject.name, { Id: allTriggerSetup.Id, [triggerOnField.name]: newTriggerState });
        }

        this.logger.verbose(`Update CustomSetting ${triggerSetupObject.name}.${triggerOnField.name} to '${newTriggerState}' [${timer.stop()}]`);
    }

    /**
     * Verifies the data deployed to the org matched the local data for the specified list of fields. This is especially useful for GlobalKey fields that are
     * updated by a Vlocity before update/insert trigger making it impossible to update the global key when Vlocity triggers are enabled.
     * @param records records
     * @param fieldNames Array of field names to compare
     */
    private async verifyDeployedFieldData(records: Iterable<DatapackDeploymentRecord>, fieldNames: string[]) {
        const deployedRecordsByType = groupBy(Iterable.filter(records, r => r.isDeployed), r => r.sobjectType);
        const recordBatch = new RecordBatch(this.schemaService, { useBulkApi: false, chunkSize: 100 });

        for (const [sobjectType, records] of Object.entries(deployedRecordsByType)) {
            const fields = (await Promise.all(
                fieldNames.map(name => this.schemaService.describeSObjectField(sobjectType, name, false))
            )).filter(f => !!f) as Array<Field>;

            if (!fields.length) {
                continue;
            }

            this.logger.verbose(`Verifying org-data after deployment on ${sobjectType} fields [${fields.map(f => f.name).join(', ')}] for ${records.length} record(s)`);
            const deployedData = new Map(records.map(r => [r.recordId as string, r]));
            const orgData = await this.objectLookupService.lookupById(deployedData.keys(), fields.map(f => f.name), false);

            for (const result of orgData.values()) {
                const mismatchedFieldData = fields.map(field => ({
                    field: field.name,
                    actual: result[field.name],
                    expected: deployedData.get(result.Id)?.values[field.name]
                })).filter(comp => comp.actual !== comp.expected);

                if (mismatchedFieldData.length) {
                    const update = mismatchedFieldData.reduce((acc, mismatch) => Object.assign(acc, {
                        [mismatch.field]: mismatch.expected
                    }), { Id: result.Id });
                    recordBatch.add(sobjectType, update);
                }
            }
        }

        if (recordBatch.size > 0) {
            this.logger.info(`Updating ${recordBatch.size} records with mismatching values on: ${fieldNames.join(', ')}`);

            // For global key updates to always succeed ensure that the triggers are off
            await this.setVlocityTriggerState(false);
            try {
                for await (const result of recordBatch.execute(await this.connectionProvider.getJsForceConnection())) {
                    if (result.error) {
                        this.logger.error(`Field update failed for ${result.recordId} -- ${result.error}`);
                    }
                }
            } finally {
                await this.setVlocityTriggerState(true);
            }
        }
    }

    private async beforeDeployRecord(deployment: DatapackDeployment, datapackRecords: Iterable<DatapackDeploymentRecord>) {
        if (deployment.options.disableTriggers) {
            await this.setVlocityTriggerState(false);
        }
        if (deployment.isCancelled) {
            return;
        }
        await this.runSpecFunction('beforeDeployRecord', { 
            args: [ [...datapackRecords] ], 
            ignoreErrors: true, 
            errorSeverity: 'error' 
        });
    }

    private async afterDeployRecord(deployment: DatapackDeployment, datapackRecords: Iterable<DatapackDeploymentRecord>) {
        if (deployment.options.disableTriggers) {
            await this.setVlocityTriggerState(true);
        }
        if (deployment.isCancelled) {
            return;
        }
        await this.verifyDeployedFieldData(datapackRecords, [ 'GlobalKey__c', 'GlobalKey2__c', 'GlobalGroupKey__c' ]);
        await this.runSpecFunction('afterDeployRecord', { 
            args: [ [...datapackRecords] ], 
            ignoreErrors: true, 
            errorSeverity: 'warn' 
        });
    }

    /**
     * Event handler running before the deployment
     * @param datapackRecords Datapacks being deployed
     */
    private async beforeDeployRecordGroup(deployment: DatapackDeployment, datapackGroups: Iterable<DatapackDeploymentRecordGroup>) {
        if (deployment.isCancelled) {
            return;
        }
        return this.runSpecFunction('beforeDeploy', { 
            args: [ new DatapackDeploymentEvent(deployment, [...datapackGroups]) ], 
            ignoreErrors: true, 
            errorSeverity: 'error' 
        });
    }

    /**
     * Event handler running after the deployment
     * @param datapackRecords Datapacks that have been deployed
     */
    private async afterDeployRecordGroup(deployment: DatapackDeployment, datapackGroups: Iterable<DatapackDeploymentRecordGroup>) {
        if (deployment.isCancelled) {
            return;
        }
        return this.runSpecFunction('afterDeploy', { 
            args: [ new DatapackDeploymentEvent(deployment, [...datapackGroups]) ],
            ignoreErrors: true, 
            errorSeverity: 'warn' 
        });
    }

    /**
     * Run a datapack spec function and await the result
     * @param datapackType Datapack type
     * @param eventType Event/function type to run
     * @param args Arguments
     */
    private async runSpecFunction<T extends keyof DatapackDeploymentSpec, E extends Required<DatapackDeploymentSpec>[T]>(eventType: T, options: DeploymentSpecExecuteOptions<Parameters<E>>) {
        for (const { spec, filter } of this.specRegistry.getSpecs()) {
            const specFunction = spec?.[eventType];
            const specParams = [ ...options.args ];

            if (typeof specFunction !== 'function') {
                continue;
            }

            if (isReadonlyArray(specParams[0])) {
                const records = this.filterApplicableRecords(filter, specParams[0]);
                if (!records.length) {
                    continue;
                }
                specParams[0] = records;
            } else if ((specParams[0] as any) instanceof VlocityDatapack) {
                if (!this.evalFilter(filter, specParams[0] as VlocityDatapack)) {
                    continue;
                }
            } else {
                const recordGroups = specParams[0].recordGroups
                    .map(group => this.evalFilter(filter, group) ? group : this.filterApplicableRecords(filter, group))
                    .filter(group => group.records.length)
                if (!recordGroups.length) {
                    continue;
                }
                specParams[0] = new DatapackDeploymentEvent(specParams[0].deployment, recordGroups);
            }

            try {
                await specFunction.apply(spec, specParams) as ReturnType<E>;
            } catch(err) {
                if (!options?.ignoreErrors) {
                    throw err;
                }
                this.handleSpecFunctionError(eventType, err, options);
            }
        }
    }

    private handleSpecFunctionError(eventType: string, err: unknown, options: DeploymentSpecExecuteOptions) {
        this.logger.error(`Spec function failed to execute:`, getErrorMessage(err, { includeStack: true }));
        for (const record of this.getAffectedRecords(options.args)) {
            if (options.errorSeverity === 'warn') {
                record.addWarning(`${eventType} spec error: ${getErrorMessage(err)}`);
            } else if (options.errorSeverity === 'error') {
                record.setFailed(`${eventType} spec error: ${getErrorMessage(err)}`);
            }
        }
    }

    private getAffectedRecords(parameters: unknown[]) {
        const affectedRecords = new Set<DatapackDeploymentRecord>();
        for (const param of parameters) {
            if (param instanceof DatapackDeploymentEvent) {
                param.records.forEach(record => affectedRecords.add(record));
            } else if (param instanceof DatapackDeploymentRecord) {
                affectedRecords.add(param);
            } else if (Array.isArray(param) && param.length) {
                this.getAffectedRecords(param).forEach(record => affectedRecords.add(record));
            }
        }
        return [...affectedRecords];
    }

    private filterApplicableRecords(filter: DatapackFilter, arg: readonly DatapackDeploymentRecord[]): DatapackDeploymentRecord[];
    private filterApplicableRecords(filter: DatapackFilter, arg: DatapackDeploymentRecordGroup): DatapackDeploymentRecordGroup;
    private filterApplicableRecords(filter: DatapackFilter, arg: readonly DatapackDeploymentRecord[] | DatapackDeploymentRecordGroup) {
        if (arg instanceof DatapackDeploymentRecordGroup) {
            return new DatapackDeploymentRecordGroup(arg.key, this.filterApplicableRecords(filter, arg.records));
        }
        return arg.filter(record => this.evalFilter(filter, record)) as any;
    }

    private evalFilter(filter: DatapackFilter, arg: string | VlocityDatapack | DatapackDeploymentRecord | DatapackDeploymentRecordGroup) : boolean {
        const isMatch = (a: string | RegExp, b: string) => typeof a === 'string' ? a.toLowerCase() === b.toLowerCase() : a.test(b);

        if (typeof arg === 'string') {
            return (!!filter.datapackFilter && isMatch(filter.datapackFilter, arg)) ||
                (!!filter.recordFilter && isMatch(filter.recordFilter, arg));
        } else if (arg instanceof DatapackDeploymentRecord) {
            return (!!filter.datapackFilter && isMatch(filter.datapackFilter, arg.datapackType)) ||
                (!!filter.recordFilter && isMatch(filter.recordFilter, arg.normalizedSObjectType));
        } else if (arg instanceof VlocityDatapack) {
            return (!!filter.datapackFilter && isMatch(filter.datapackFilter, arg.datapackType)) ||
                (!!filter.recordFilter && isMatch(filter.recordFilter, removeNamespacePrefix(arg.sobjectType)));
        } else if (arg instanceof DatapackDeploymentRecordGroup) {
            return !!filter.datapackFilter && isMatch(filter.datapackFilter, arg.datapackType);
        }

        throw new Error('EvalFilter does not understand comparison argument type; pass either a VlocityDatapack or DatapackDeploymentRecord');
    }
}
