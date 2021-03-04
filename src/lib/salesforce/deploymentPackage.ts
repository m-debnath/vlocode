
import * as path from 'path';
import * as constants from '@constants';
import * as xml2js from 'xml2js';
import * as fs from 'fs-extra';
import * as ZipArchive from 'jszip';
import { PackageManifest } from './deploy/packageXml';

export class SalesforcePackage {

    /**
     * Get the metadata mainfest for this package
     */
    private readonly manifest = new PackageManifest();

    /**
     * Access the pre or post destructive changes in this package
     */
    private readonly destructiveChanges = {
        pre: new PackageManifest(),
        post: new PackageManifest()
    };

    private readonly packageData = new Map<string, Buffer | string>();

    constructor(
        public readonly apiVersion: string,
        private readonly packageDir = 'src') {
        if (!/^\d{2,3}\.\d$/.test(apiVersion)) {
            throw new Error(`Invalid API version: ${apiVersion}`);
        }
    }

    public addPackageData(packagePath: string, data: string | Buffer) {
        this.packageData.set(packagePath.replace(/\/|\\/g, '/'), data);
    }

    public addPackageMember(xmlName: string, componentName: string) {
        this.manifest.add(xmlName, componentName);
    }

    /**
     * By default, deletions are processed before component additions (pre)
     * @param xmlName XML Name of the component to delete
     * @param componentName Name of the component to delete; cannot be a wild card
     * @param type Type of change can be pre or post, default is pre.
     */
    public addDestructiveChange(xmlName: string, componentName: string, type: keyof SalesforcePackage['destructiveChanges'] = 'pre') {
        this.destructiveChanges[type].add(xmlName, componentName);
    }

    /**
     * Merge an existing destructive changes XML into the package as pre or post change.
     * @param sourceFile Source file path
     * @param type Type of changes
     */
    public async mergeDestructiveChanges(sourceFile: string, type: keyof SalesforcePackage['destructiveChanges'] = 'pre') {
        const items = (await xml2js.parseStringPromise(await fs.readFile(sourceFile))).Package;
        for (const packageType of items.types) {
            const xmlName = packageType.name[0];
            for (const member of packageType.members) {
                this.addDestructiveChange(xmlName, member, type);
            }
        }
    }

    /**
     * Get a list of all test classes with unit tests from added to the current package. 
     * Uses annotation and testmethod detection on APEX class bodies.
     */
    public getTestClasses() {
        const testClasses = new Array<String>();
        for (const [packagePath, data] of this.packageData.entries()) {
            if (!packagePath.endsWith('.cls')) {
                continue;
            }

            // Get data, buffer assumes UTF-8 encoding.
            const classBody = typeof data === 'string' ? data : data.toString();
            const testClassName = path.basename(packagePath, '.cls');

            // Cheap test but accurate test for test classes; you can create false posetives but you have to try real hard
            const hasTestAnnotations = (/@IsTest([(\s]+)/ig.exec(classBody)?.length ?? 0) > 1; // atleast 2 annotations are required
            const hasTestMethods = /\s+testMethod\s+/ig.test(classBody); // or atleast one testMethod

            if (hasTestMethods || hasTestAnnotations) {
                testClasses.push(testClassName);
            }
        }

        return testClasses;
    }

    /**
     * Get the currently packaged data for the specified path in the package.
     * @param packagePath Package path
     */
    public getPackageData(packagePath: string) {
        return this.packageData.get(packagePath.replace(/\/|\\/g, '/'));
    }

    /**
     * Determine if a file exists in the current packahge
     * @param packagePath Path of file in package
     */
    public hasPackageData(packagePath: string) {
        return this.packageData.has(packagePath.replace(/\/|\\/g, '/'));
    }

    /**
     * Get an iterator over the defined types in the current package
     */
    public *getPackageTypes() {
        yield *this.manifest.types();
    }

    /**
     * Get the number of packaged components for a specific XML memeber type
     * @param xmlName XML type name
     */
    public getPackageTypeCount(xmlName: string) {
        return this.manifest.count(xmlName);
    }

    /**
     * Builds the ZipArchive from the current package and returns the package archive
     */
    private buildPackage() : ZipArchive {
        this.generateMissingMetaFiles();
        const packageZip = new ZipArchive();

        packageZip.file(path.posix.join(this.packageDir, 'package.xml'), this.manifest.toXml(this.apiVersion));

        if (this.destructiveChanges.pre.count() > 0) {
            packageZip.file(path.posix.join(this.packageDir, 'destructiveChanges.xml'),
                this.destructiveChanges.pre.toXml(this.apiVersion));
        }

        if (this.destructiveChanges.post.count() > 0) {
            packageZip.file(path.posix.join(this.packageDir, 'destructiveChangesPost.xml'),
                this.destructiveChanges.post.toXml(this.apiVersion));
        }

        for (const [packagePath, data] of this.packageData.entries()) {
            packageZip.file(path.posix.join(this.packageDir, packagePath), data);
        }

        return packageZip;
    }

    /**
     * Generates missing -meta.xml files for APEX classes using the package specified API version.
     */
    private generateMissingMetaFiles() {
        for (const [packagePath] of this.packageData.entries()) {
            if (packagePath.endsWith('.cls')) {
                // APEX classes
                if (!this.packageData.has(`${packagePath}-meta.xml`)) {
                    this.packageData.set(`${packagePath}-meta.xml`, this.buildClassMetadata(this.apiVersion));
                }
            } else if (packagePath.endsWith('.trigger')) {
                // APEX classes
                if (!this.packageData.has(`${packagePath}-meta.xml`)) {
                    this.packageData.set(`${packagePath}-meta.xml`, this.buildTriggerMetadata(this.apiVersion));
                }
            }
        }
    }

    private buildClassMetadata(apiVersion: string) {
        return this.buildMetadataXml('ApexClass', {
            apiVersion: apiVersion,
            status: 'Active'
        });
    }

    private buildTriggerMetadata(apiVersion: string) {
        return this.buildMetadataXml('ApexTrigger', {
            apiVersion: apiVersion,
            status: 'Active'
        });
    }

    private buildMetadataXml(rootName: string, data?: any) {
        const xmlBuilder = new xml2js.Builder(constants.MD_XML_OPTIONS);
        return xmlBuilder.buildObject({
            [rootName]: {
                $: { xmlns: 'http://soap.sforce.com/2006/04/metadata' },
                ...(data || {})
            }
        });
    }

    /**
     * Save the package as zip file
     * @param zipFile target file.
     */
    public savePackage(savePath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.buildPackage().generateNodeStream({ streamFiles: true, compressionOptions: { level: 8 } })
                .pipe(fs.createWriteStream(savePath))
                .on('finish', () => {
                    resolve();
                }).on('error', err => {
                    reject(err);
                });
        });
    }

    /**
     * Generate a nodejs buffer with compressed package zip that can be uploaded to Salesforce.
     * @param compressionLevel levle of compression
     */
    public generatePackage(compressionLevel: number = 7): Promise<Buffer> {
        return this.buildPackage().generateAsync({
            type: 'nodebuffer',
            compression: 'DEFLATE',
            compressionOptions: {
                level: compressionLevel
            }
        });
    }
}
