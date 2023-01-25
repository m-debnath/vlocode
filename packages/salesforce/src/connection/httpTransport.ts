import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import * as csv from 'csv-parse/sync';
import { URL } from 'url';
import { CookieJar } from 'tough-cookie';
import { HttpApiOptions } from 'jsforce/http-api';
import { DeferredPromise, withDefaults, XML } from '@vlocode/util';
import { SalesforceConnection } from './salesforceConnection';
import { ILogger, Logger, LogManager } from '@vlocode/core';

export interface HttpResponse {
    statusCode?: number;
    statusMessage?: string;
    headers: http.IncomingHttpHeaders; 
    body?: string | object;
}

export interface HttpRequestInfo {
    url: string;
    method: string;
    body?: string | undefined;
    headers?: http.OutgoingHttpHeaders | undefined;
}

interface HttpContentType {
    /**
     * Type of content after the first slash: **type**\/subtype+suffix; param=value
     */
    type: string; 
    /**
     * Sub type of content after the first slash: type/**subtype**+suffix; param=value
     */
    subtype: string; 
    /**
     * Type of content after the first slash: type/subtype+**suffix**; param=value
     */
    suffix?: string;
    /**
     * Object with all key value parameters in the content-type: type/subtype+suffix; **param=value**
     */
    parameters: Record<string, string | undefined>;
}

interface HttpTransportOptions {
    /**
     * Threshold value when to apply Gzip encoding when posting data to Salesforce.
     * @default 128
     */
    gzipThreshold: number;

    /**
     * When true and the length of the body exceeds {@link gzipThreshold} the request will be encoded using gzip compression. This also 
     * sets the accept-encoding: gzip header on the request to tell Salesforce it can send back responses with gzip compression.
     * 
     * When disabled neither requests or responses will be encoded with gzip.
     * @default true
     */
    useGzipEncoding: boolean;

    /**
     * Include a keep-alive header in all requests to re-use the HTTP connection and socket.
     * @default true
     */
    shouldKeepAlive: boolean;

    /**
     * Parse set-cookies header and store cookies to be included in the request header on subsequent requests.
     * 
     * Note: handling of cookies is not required but avoids Salesforce from sending the full set-cookie header on each request
     * @default true
     */
    handleCookies: boolean;
}

export class HttpTransport{
    private cookies = new CookieJar(); 

    /**
     * Shared HTTP agent used by this {@link HttpTransport} used for connection pooling
     */
    public httpAgent = new https.Agent({ 
        defaultPort: 443,
        keepAlive: true,
        keepAliveMsecs: 60000,
        maxSockets: 10,
        scheduling: 'lifo',
        timeout: 120000 // Time out connections after 120 seconds
    });

    /**
     * Encoding used for encoding and decoding response and request bodies
     */
    public bodyEncoding: BufferEncoding = 'utf8';

    /**
     * Options applied to to this HTTP transport
     */
    public options: HttpTransportOptions & { baseUrl?: string, instanceUrl?: string };
    
    /**
     * Default configuration for the transport options. When no specific value is set for an individual transport the
     * defaults are used instead. 
     */
    static options: HttpTransportOptions = {
        gzipThreshold: 128,
        useGzipEncoding: true,
        shouldKeepAlive: true,
        handleCookies: true,
    };

    constructor(
        options: Partial<HttpTransportOptions & { baseUrl?: string, instanceUrl?: string }>,
        private logger: ILogger = Logger.null) {
        this.options = withDefaults(options, HttpTransport.options);
        this.logger.info(`Enabled features ${this.getFeatureList().map(v => v.toUpperCase()).join(' ')}`);
    }

    public getFeatureList() {
        const features = new Array<string>();
        this.options.useGzipEncoding && features.push('gzip');
        this.options.handleCookies && features.push('cookies');
        this.options.shouldKeepAlive && features.push('keepAlive');
        return features;
    }

    public httpRequest(info: HttpRequestInfo, options?: HttpApiOptions): Promise<HttpResponse> {
        const url = this.parseUrl(info.url);
        const requestPromise = new DeferredPromise<HttpResponse>();

        if (url.protocol === 'http') {
            url.protocol = 'https';
        }

        const startTime = Date.now();
        const request = https.request({
            agent: this.httpAgent,
            host: url.host,
            path: url.pathname + url.search,
            port: url.port,
            headers: info.headers,
            protocol: url.protocol,
            method: info.method
        });

        if (this.options.shouldKeepAlive) {
            request.shouldKeepAlive = true;
        }

        if (this.httpAgent.options.keepAlive !== this.options.shouldKeepAlive) {
            this.httpAgent.options.keepAlive = this.options.shouldKeepAlive;
        }

        if (this.options.useGzipEncoding) {
            request.setHeader('accept-encoding', 'gzip, deflate');
        }

        if (this.options.handleCookies) {
            request.setHeader('cookie', this.cookies.getCookieStringSync(url.href));
        }
        
        request.once('error', (err) => requestPromise.reject(err));

        request.on('response', (response) => {
            this.logger.debug(`${url.pathname}, status=${response.statusCode} (${Date.now() - startTime}ms)`);

            const setCookiesHeader = response.headers['set-cookie'];
            if (this.options.handleCookies && setCookiesHeader?.length) {
                setCookiesHeader.forEach(cookie => this.cookies.setCookieSync(cookie, url.href));
            }
            
            if (this.isRedirect(response)) {
                const redirectRequestInfo = this.getRedirectRequest(response, info);
                response.destroy();
                return requestPromise.resolve(this.httpRequest(redirectRequestInfo, options));
            }

            const responseData = new Array<Buffer>();
            response.on('data', (chunk) => responseData.push(chunk));
            response.once('end', () => {        
                this.decodeResponseBody(response, Buffer.concat(responseData))
                    .then(body => { 
                        const parsed = this.parseResponseBody(response, body);
                        if (typeof parsed !== 'string') {
                            response.headers['content-type'] = 'no-parse';
                        }
                        return parsed;
                    })
                    .then(body => requestPromise.resolve(Object.assign(response, { 
                        time: Date.now() - startTime, body
                    })))
                    .catch(err => requestPromise.reject(err));
            });
        });  

        if (info.body) {
            this.sendRequestBody(request, info.body)
                .catch((err) => requestPromise.reject(err));
        } else {
            request.end();
        }

        return requestPromise;
    }

    private sendRequestBody(request: http.ClientRequest, body: string) : Promise<http.ClientRequest> {
        if (body.length > this.options.gzipThreshold && this.options.useGzipEncoding) {
            return new Promise((resolve, reject) => {
                zlib.gzip(body, (err, value) => {
                    err ? reject(err) : resolve(request
                        .setHeader('Content-Encoding', 'gzip')
                        .end(value, 'binary'));
                });
            }); 
        }
        return Promise.resolve(request.end(body, this.bodyEncoding));
    }

    private decodeResponseBody(response: http.IncomingMessage, responseBuffer: Buffer): Promise<Buffer> {
        // TODO: support chained encoding
        const encoding = response.headers['content-encoding'];

        if (encoding === 'gzip') {
            return new Promise((resolve, reject) => {
                zlib.gunzip(responseBuffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH }, (err, body) => {
                    err ? reject(err) : resolve(body);
                });
            });            
        } 
        
        if (encoding === 'deflate') {
            return new Promise((resolve, reject) => {
                zlib.inflate(responseBuffer, (err, body) => {
                    err ? reject(err) : resolve(body);
                });
            });            
        }

        if (encoding === 'identity' || !encoding) {
            return Promise.resolve(responseBuffer);
        }

        throw new Error(`Received unsupported 'content-encoding' header value: ${encoding}`);
    }

    private parseResponseBody(response: http.IncomingMessage, responseBuffer: Buffer): object | string {
        const contentType = this.parseContentType(response.headers['content-type']);
        const contentCharset = contentType?.parameters['charset'];
        const encoding = contentCharset && Buffer.isEncoding(contentCharset) ? contentCharset : this.bodyEncoding;

        try {
            if (contentType) {
                if (contentType.subtype === 'json' || contentType.suffix === 'json') {
                    return JSON.parse(responseBuffer.toString(encoding));
                } else if (contentType.subtype === 'xml' || contentType.suffix === 'xml') {
                    return XML.parse(responseBuffer.toString(encoding));
                } else if (contentType.subtype === 'csv' || contentType.suffix === 'csv') {
                    return csv.parse(responseBuffer, { encoding });
                }
            }            
        } catch (err) {
            this.logger.warn(`Failed to parse response of type ${contentType}: ${err?.message ?? err}`);
        }

        // Fallback to string decoding
        return responseBuffer.toString(encoding);
    }

    private parseContentType(contentTypeHeader: string | undefined): HttpContentType | undefined {
        if (!contentTypeHeader) {
            return;
        }
        
        const contentHeaderParts = contentTypeHeader.split(';');
        const [type, subtypeWithSuffix] = contentHeaderParts.shift()!.split('/').map(v => v.trim().toLowerCase());
        const [subtype, suffix] = subtypeWithSuffix.split('+').map(v => v.trim().toLowerCase());
        const parameters = Object.fromEntries(contentHeaderParts.map(param => param.split('=') as [string, string | undefined]));

        return { type, subtype, suffix, parameters };
    }

    private getRedirectRequest(response: http.IncomingMessage, info: HttpRequestInfo): HttpRequestInfo {
        const redirectLocation = response.headers.location;
        if (!redirectLocation) {
            throw new Error(`Redirected (${response.statusCode}) without location header`);
        }

        this.logger.debug(`http redirect ${info.url} -> ${redirectLocation}`);

        const redirectRequestInfo = { ...info, url: redirectLocation };
        if (response.statusCode === 303) {
            // incorrect method; change to GET
            this.logger.debug(`http ${response.statusCode} change http method ${info.method} -> GET`);
            redirectRequestInfo.method = 'GET';
        }

        return redirectRequestInfo;
    }

    private isRedirect(response: http.IncomingMessage) {
        return response.statusCode && [300, 301, 302, 303, 307, 308].includes(response.statusCode);
    }

    private parseUrl(url: string) {
        if (url.startsWith('/')) {
            if (url.startsWith('/services/')) {
                return new URL(this.options.instanceUrl + url);
            } 
            return new URL(this.options.baseUrl + url);
        } 
        return new URL(url);
    }
}