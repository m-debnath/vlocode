import * as vm from 'vm';
import { singleton } from './singleton';
import { cache } from './cache';

/**
 * Helper to allow cache decorator to be used for compiled code
 */
class Compiler {

    @cache(-1)
    public compile(code: string, options?: { mode: 'vm' | 'sandbox' }) : (context?: any, contextMutable?: boolean) => any {
        let compiledFn : (context: any) => any;
        if (options?.mode === 'sandbox') {
            compiledFn = new Function('sandbox', `with (context) { ${code} }`) as typeof compiledFn;
        } else {
            const script = new vm.Script(code);
            compiledFn = script.runInNewContext.bind(script);
        }

        return function (context?: any, contextMutable?: boolean) {
            const sandboxValues = contextMutable ? (context ?? {}) : {};
            const sandboxContext = new Proxy({}, {
                get(target, prop) {
                    return sandboxValues[prop] ?? context[prop];
                },
                set(target, prop, value) {
                    sandboxValues[prop] = value;
                    return true;
                },
                getOwnPropertyDescriptor(target, prop) {
                    const contextProperty = Object.getOwnPropertyDescriptor(context, prop);
                    const sandboxProperty = Object.getOwnPropertyDescriptor(sandboxValues, prop);
                    return sandboxProperty ?? contextProperty;
                },
                ownKeys() {
                    return contextMutable ? Reflect.ownKeys(context) : [...Reflect.ownKeys(context), ...Reflect.ownKeys(sandboxValues)];
                }
            });
            compiledFn(sandboxContext);
            return sandboxValues;
        };
    }
}

/**
 * Compiles the specified code as sandboxed function 
 * @param code JS code
 * @param options specifies how to compile the function
 * @returns 
 */
export function compileFunction(code: string, options?: { mode: 'vm' | 'sandbox' }) {
    return singleton(Compiler).compile(code, options);
}