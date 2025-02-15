import { injectable, LifecyclePolicy } from '@vlocode/core';
import { cache, extractNamespaceAndName, normalizeSalesforceName, PropertyTransformHandler, removeNamespacePrefix, substringAfterLast, substringBefore } from '@vlocode/util';
import { QueryResultRecord } from './connection';
import { SalesforceSchemaService } from './salesforceSchemaService';

export const RecordAttributes = Symbol('attributes');
export const RecordId = Symbol('id');
export const RecordType = Symbol('type');

interface RecordFactoryCreateOptions {
    /**
     * Create records using a proxy to intercept property access and transform the property name to the correct casing.
     *
     * If false uses the defineProperty approach to transform the property names which is by design case sensitive.
     *
     * @default false
     */
    useRecordProxy?: boolean
}

export class RecordFactory {
    /**
     * Symbol under which the field map is stored on the record when using proxy transformation
     */
    private static readonly fieldMapKey = Symbol('fields');

    /**
     * Create records using a proxy to intercept property access and transform the property name to the correct casing.
     *
     * If false uses the defineProperty approach to transform the property names which is by design case sensitive.
     */
    public static readonly useRecordProxy = false;

    private readonly schemaService: SalesforceSchemaService;

    /**
     * Static method for creating records using the default factory instance.
     */
    public static create<T extends object = any>(queryResultRecord: QueryResultRecord, options?: RecordFactoryCreateOptions): T {
        return RecordFactory.prototype.create(queryResultRecord, options);
    }

    /**
     * Normalize the field names to the correct casing for making queried records accessible by both the API name and the normalized name.
     *
     * When using the proxy transformation (see {@link useRecordProxy} or `options.useRecordProxy`) fields access is case insensitive.
     *
     * @param queryResultRecord The raw salesforce record returned by the API
     * @param options Transformation options that override the default behavior of the factory
     * @returns The transformed record based on the specified options
     */
    public create<T extends object = any>(queryResultRecord: QueryResultRecord, options?: RecordFactoryCreateOptions): T {
        if (queryResultRecord.attributes) {
            Object.assign(queryResultRecord, {
                [RecordAttributes]: queryResultRecord.attributes,
                [RecordType]: queryResultRecord.attributes?.type,
                [RecordId]: queryResultRecord.attributes?.url ? substringBefore(substringAfterLast(queryResultRecord.attributes.url, '/'), '.') : undefined,
            });
        }

        if (RecordFactory.useRecordProxy && options?.useRecordProxy !== false) {
            return this.createWithProxy(queryResultRecord);
        }
        return this.createWithDefine(queryResultRecord);
    }

    private createWithProxy<T extends object>(queryResultRecord: QueryResultRecord): T {
        return new Proxy<T>(queryResultRecord as any, new PropertyTransformHandler(RecordFactory.getPropertyKey));
    }

    private createWithDefine<T extends object>(queryResultRecord: QueryResultRecord): T {
        const properties: Record<string, PropertyDescriptor> = {};
        const relationships: Array<string> = [];

        for (const [key, value] of Object.entries(queryResultRecord)) {
            if (typeof key === 'symbol') {
                continue;
            }

            if (value !== null && typeof value === 'object') {
                if (key === 'attributes') {
                    // Ignore attributes which hold the type of the record and URL
                    continue;
                } else if (Array.isArray(value)) {
                    // Modify the array in-place
                    value.filter((value) => typeof value === 'object' && value !== null)
                        .forEach((record, i) => value[i] = this.createWithDefine(record));
                } else {
                    // Modify the object in-place
                    queryResultRecord[key] = this.createWithDefine<any>(value as QueryResultRecord);
                }
            }

            const accessor = {
                get: () => queryResultRecord[key],
                set: (value: any) => queryResultRecord[key] = value,
                enumerable: false,
                configurable: false
            };

            const name = extractNamespaceAndName(key);
            if (name.namespace) {
                properties[name.name] = accessor;
            }

            properties[normalizeSalesforceName(name.name)] = accessor;
            if (name.name.endsWith('__r')) {
                relationships.push(normalizeSalesforceName(name.name));
            }
        }

        // Remove relationship properties that are also defined as regular properties
        for (const name of relationships) {
            const commonName = name.slice(0, -3);
            if (!properties[commonName]) {
                properties[commonName] = properties[name];
            }
        }

        const newProperties = Object.fromEntries(
            Object.entries(properties).filter(([key]) => !(key in queryResultRecord)));
        return Object.defineProperties(queryResultRecord as T, newProperties);
    }

    @cache({ scope: 'instance', unwrapPromise: true, immutable: false })
    private async getNormalizedFieldMap(sobjectType: string): Promise<Map<string, string>> {
        const fields = await this.schemaService.getSObjectFields(sobjectType);
        return RecordFactory.generateNormalizedFieldMap([...fields.values()].map(field => field.name));
    }

    private getObjectTypes(queryResultRecord: QueryResultRecord, types?: Set<string>): Set<string> {
        types = types ?? new Set<string>();
        for (const [key, value] of Object.entries(queryResultRecord)) {
            if (value !== null && typeof value === 'object') {
                if (key === 'attributes') {
                    types.add(value['type']);
                } else if (Array.isArray(value)) {
                    // All items in the Array are always of the same type
                    this.getObjectTypes(value[0], types);
                } else {
                    this.getObjectTypes(value as QueryResultRecord, types);
                }
            }
        }
        return types;
    }

    private static getPropertyKey<T extends object>(this: void, target: T, name: string | number | symbol) {
        if (target[name] !== undefined) {
            return name;
        }

        let fieldMap = target[RecordFactory.fieldMapKey];
        if (fieldMap === undefined) {
            fieldMap = RecordFactory.generateNormalizedFieldMap(Object.keys(target));
        }

        if (String(name).toLowerCase() === 'id' && target['']) {
            return 'Id';
        }

        return fieldMap.get(String(name).toLowerCase())
            ?? fieldMap.get(normalizeSalesforceName(String(name)).toLowerCase())
            ?? name;
    }

    private static generateNormalizedFieldMap(this: void, fields: string[]) {
        const relationships: Map<string, string> = new Map<string, string>();
        const fieldMap: Map<string, string> = new Map<string, string>();

        for (const fieldName of fields) {
            const namespaceNormalized = removeNamespacePrefix(fieldName);
            fieldMap.set(fieldName.toLowerCase(), fieldName);
            fieldMap.set(namespaceNormalized.toLowerCase(), fieldName);
            fieldMap.set(normalizeSalesforceName(fieldName).toLowerCase(), fieldName);
            if (fieldName.endsWith('__r')) {
                relationships.set(normalizeSalesforceName(fieldName).slice(0, -3), fieldName);
            }
        }

        for (const [relationship, target] of relationships) {
            if (!fieldMap.has(relationship)) {
                fieldMap.set(relationship, target);
            }
        }

        return fieldMap;
    }
}

@injectable({ lifecycle: LifecyclePolicy.transient })
export class Query2Service {
    // private wrapRecord<T extends object>(record: T) {
    //     const getPropertyKey = (target: T, name: string | number | symbol) => {
    //         const fieldMap = this.getRecordFieldMap(target);
    //         const normalizedName = normalizeSalesforceName(name.toString());
    //         return fieldMap.get(normalizedName) ?? name;
    //     };
    //     return new Proxy(record, new PropertyTransformHandler(getPropertyKey));
    // }

    // private getRecordFieldMap<T extends object>(record: T) {
    //     let fieldMap = this.recordFieldNames.get(record);
    //     if (!fieldMap) {
    //         fieldMap = Object.keys(record).reduce((map, key) => map.set(normalizeSalesforceName(key.toString()), key), new Map());
    //         this.recordFieldNames.set(record, fieldMap);
    //     }
    //     return fieldMap;
    // }
}