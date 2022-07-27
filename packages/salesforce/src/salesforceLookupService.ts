import { Logger, injectable, LifecyclePolicy } from '@vlocode/core';
import { asArray, transform, joinLimit, isSalesforceId, CancellationToken, groupBy, Iterable } from '@vlocode/util';
import { PropertyAccessor } from './types';
import { QueryService, QueryResult } from './queryService';
import { SalesforceSchemaService } from './salesforceSchemaService';
import { NamespaceService } from './namespaceService';

/**
 * Look up records from Salesforce using an more convenient syntax
 */
@injectable({ lifecycle: LifecyclePolicy.transient })
export class SalesforceLookupService {

    @injectable.property private readonly logger: Logger;
    @injectable.property private readonly nsService: NamespaceService;

    constructor(
        private readonly schemaService: SalesforceSchemaService,
        private readonly queryService: QueryService) {
    }

    public async lookupSingle<T extends object, K extends PropertyAccessor = keyof T>(type: string, filter?: T | string | Array<T | string>, lookupFields?: K[] | 'all', useCache?: boolean, cancelToken?: CancellationToken): Promise<QueryResult<T, K> | undefined>  {
        return (await this.lookup(type, filter, lookupFields, 1, useCache, cancelToken))[0];
    }

    /**
     * Lookip records in the target org by their record ID
     * @param ids Iterable list of IDs
     * @param lookupFields Fields to lookup, any fields that do not exist on the object type are ignored. In case `all` or undefined all fields are retrieved.
     * @param useCache Optionally use the query cache for retrieving the request records
     * @param cancelToken Optional cancellation token to signal the method that it should quite as soon as possible.
     * @returns Records in a Map keyed by their record ID
     */
    public async lookupById<K extends PropertyAccessor>(ids: Iterable<string>, lookupFields?: K[] | 'all', useCache?: boolean, cancelToken?: CancellationToken): Promise<Map<string, QueryResult<{ Id: string }, K>>> {
        const idsByType = await groupBy(ids, async id => (await this.schemaService.describeSObjectById(id)).name);
        const resultsById = new Map<string, QueryResult<{ Id: string }, K>>();
        for (const [type, ids] of Object.entries(idsByType)) {
            if (cancelToken?.isCancellationRequested) {
                break;
            }
            const results = await this.lookup(type, asArray(ids).map(Id => ({ Id })), lookupFields, undefined, useCache, cancelToken);
            results.forEach(r => resultsById.set(r.Id, r));
        }
        return resultsById;        
    }

    /**
     * Query multiple records based on the where condition. The filter condition can either be a string or a complex filter object.
     * @param type Name of the SObject type to lookup
     * @param filter Object filter or Where conditional string, by default the object filter uses and equals comparison (=). 
     * A different comparison mode can be specified by prefixing the value with any of these operators:
     * - `!=`: not equals
     * - `>`: greater then
     * - `<`: smaller then
     * - `~`: like/contains
     * 
     * Arrays are interpreted as as `includes` operator. For example:
     * ``` 
     * lookup('Account', { Name: ['Peter', 'ACME'] }, ['Id', 'Name'] ) 
     * ```
     * will translate to the follow query: 
     * `
     * select Id, Name from Account where Name includes ('Peter', 'ACME')
     * `
     * 
     * You can also specify multiple filters by passing an array of objects or strings:
     * ``` 
     * lookup('Account', [{ Name: 'Peter' }, { Name: 'ACME' }], ['Id', 'Name'] ) 
     * ``` 
     * Which will translate to the follow query: 
     * `
     * select Id, Name from Account where (Name = 'Peter') or (Name = 'ACME')
     * `
     * @param lookupFields fields to lookup on the record, if not field list is provided this function will lookup All fields. 
     * Note that the Id field is always included in the results even when no fields are specified, or when a limited set is specified.
     * @param limit limit the number of results to lookup, set to 0, null, undefined or false to not limit the lookup results; when specified as 1 returns a single record instead of an array.
     * @param useCache when true instructs the QueryService to cache the result in case of a cache miss and otherwise retrive the cached response. The default behavhior depends on the @see QueryService configuration.
     */
    public async lookup<T extends object, K extends PropertyAccessor = keyof T>(type: string, filter?: T | string | Array<T | string>, lookupFields?: K[] | 'all', limit?: number, useCache?: boolean, cancelToken?: CancellationToken): Promise<QueryResult<T, K>[]>  {
        const filters = await Promise.all(asArray(filter).map(f => typeof f === 'string' ? Promise.resolve(f) : this.createWhereClause(type, f)));
        const results = new Array<QueryResult<T, K>>();
        const lookupFieldLen = Array.isArray(lookupFields) ? lookupFields.reduce((a, f) => a + String(f).length, 0) : 1000;
        const filterChunks = joinLimit(filters.filter(f => f?.trim().length).map(f => `(${f})`), 8000 - lookupFieldLen, ' or '); // max query string is 10k characters

        do {
            if (cancelToken?.isCancellationRequested) {
                break;
            }
            results.push(...await this.lookupWhere<T, K>(type, filterChunks.shift(), lookupFields || 'all', limit, useCache, cancelToken));
        } while(filterChunks.length);

        return results;
    }

    private async lookupWhere<T, K extends PropertyAccessor = keyof T>(type: string, where?: string, selectFields: K[] | 'all' = 'all', limit?: number, useCache?: boolean, cancelToken?: CancellationToken): Promise<QueryResult<T, K>[]> {
        this.logger.verbose(`Lookup ${type} records ${limit ? `- limit ${limit} ` : ``}- fields:`, () => JSON.stringify(selectFields));
        const fields = new Set(['Id']);

        if (selectFields) {
            if (selectFields === 'all') {
                for (const [field] of await this.schemaService.getSObjectFields(type)) {
                    fields.add(field);
                }
            } else {
                for (const field of selectFields) {
                    const fieldPath = await this.schemaService.toSalesforceField(type, field.toString());
                    if (fieldPath == null) {
                        throw new Error(`Unable to resolve lookup field ${String(field)} on type ${type}`);
                    }
                    fields.add(fieldPath);
                }
            }
        }

        const realType = (await this.schemaService.describeSObject(type)).name;
        const limitClause = limit ? ` limit ${limit}` : '';
        const whereClause = where?.trim().length ? ` where ${  where}` : '';
        const queryString = `select ${Array.from(fields).join(',')} from ${realType}${whereClause}${limitClause}`;
        return this.queryService.query(queryString, useCache, cancelToken);
    }

    private async createWhereClause<T>(type: string, values: { [P in keyof T]?: T[P] | Array<T[P]> | string } | undefined | null, relationshipName: string = '') : Promise<string> {
        const lookupFilters: any[] = [];

        // eslint-disable-next-line prefer-const
        for (let [fieldPath, value] of Object.entries(values || {})) {
            const salesforceFields = [...await this.schemaService.describeSObjectFieldPath(type, fieldPath)];
            const salesforceField = salesforceFields.pop()!;
            const fieldName = [ ...salesforceFields.map(field => field.relationshipName), salesforceField.name ].join('.');

            if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                if (salesforceField.type != 'reference' || !salesforceField.referenceTo || !salesforceField.relationshipName) {
                    throw new Error(`Object type set for non-reference field ${fieldPath} on type ${type}`);
                }
                lookupFilters.push(await this.createWhereClause(type, transform(value!, key => `${fieldName}.${String(key)}`)));
            } else {
                // Set intended comparison operator
                let operator = '=';
                if (typeof value === 'string') {
                    if (value.startsWith('!=')) {
                        operator = '!=';
                        value = value.substring(2);
                    } else if (value.startsWith('>')) {
                        operator = '>';
                        value = value.substring(1);
                    } else if (value.startsWith('<')) {
                        operator = '<';
                        value = value.substring(1);
                    } else if (value.startsWith('~')) {
                        operator = 'like';
                        value = value.substring(1);
                    } 
                } else if (typeof value === 'object' && Array.isArray(value)) {
                    operator = 'in';
                    if (salesforceField.type == 'multipicklist') {
                        operator = 'includes';
                    }
                }
                        
                if (typeof value === 'string' && isSalesforceId(value) && salesforceField.type === 'string') {
                    // doesn't work for Arrays nor does it handle < and > operators properly
                    value = [ value, value.substring(0, 15) ];
                    operator = operator == '=' ? 'in' : 'not in';
                } 
                
                const fieldValue = QueryService.formatFieldValue(value, salesforceField);
                lookupFilters.push(`${fieldName} ${operator} ${fieldValue}`);
            }
        }

        return lookupFilters.join(' and ');
    }
}