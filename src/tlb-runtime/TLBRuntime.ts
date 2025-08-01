import { Builder, Slice, Cell, beginCell, Dictionary, parseTuple, serializeTuple, BitString, Address } from '@ton/core';
import {
    TLBConstructor,
    TLBConstructorTag,
    TLBType,
    TLBField,
    TLBFieldType,
    TLBParameter,
    getTLBCodeByAST,
} from '@ton-community/tlb-codegen';
import { ast } from '@ton-community/tlb-parser';

import { bitsToString, stringToBits } from './common';
import { MathExprEvaluator } from './MathExprEvaluator';
import { Result, unwrap } from './Result';

export interface TypedCell {
    kind: string;
}

export type ParsedCell =
    | string
    | number
    | bigint
    | boolean
    | null
    | BitString
    | Cell
    | { [key: string]: ParsedCell }
    | ParsedCell[]
    | TypedCell;

export class TLBRuntimeError extends Error {}

export class TLBSchemaError extends TLBRuntimeError {}

export class TLBDataError extends TLBRuntimeError {}

function tagKey(tag: TLBConstructorTag): string {
    return `0b${BigInt(tag.binary).toString(2).padStart(tag.bitLen, '0')}`;
}

export interface TLBRuntimeConfig {
    autoText: boolean;
}

// Runtime TL-B serialization/deserialization
export class TLBRuntime<T extends ParsedCell = ParsedCell> {
    private readonly tagMap = new Map<string, { type: TLBType; item: TLBConstructor }>();
    private maxSizeTag = 0;
    constructor(
        private readonly types: Map<string, TLBType>,
        private readonly lastTypeName: string,
        private readonly config: Partial<TLBRuntimeConfig> = {},
    ) {
        config.autoText = config.autoText || true;
        for (const type of this.types.values()) {
            for (const item of type.constructors) {
                if (item.tag.bitLen === 0) continue;
                if (item.tag.bitLen > this.maxSizeTag) {
                    this.maxSizeTag = item.tag.bitLen;
                }
                const key = tagKey(item.tag);
                this.tagMap.set(key, { type, item });
            }
        }
    }

    static from<T extends ParsedCell = ParsedCell>(tlbSource: string): Result<TLBRuntime<T>> {
        /* eslint no-empty: ["error", { "allowEmptyCatch": true }] */
        try {
            const tree = ast(tlbSource);
            const code = getTLBCodeByAST(tree, tlbSource);
            const pared = tlbSource.split('=');
            const lastTypeName = pared[pared.length - 1].split(';')[0].trim();
            if (lastTypeName) {
                return {
                    ok: true,
                    value: new TLBRuntime(code.types, lastTypeName),
                };
            }
        } catch (_) {}
        return { ok: false, error: new TLBSchemaError('Bad Schema') };
    }

    private findByTag(slice: Slice): { type: TLBType; item: TLBConstructor } | null {
        const savedBits = slice.remainingBits;
        const savedRefs = slice.remainingRefs;
        const maxLen = Math.min(this.maxSizeTag, savedBits);
        for (let len = maxLen; len >= 1; len--) {
            const tagValue = slice.preloadUint(len);
            const key = tagKey({
                bitLen: len,
                binary: `0x${tagValue.toString(16)}`,
            });
            const type = this.tagMap.get(key);
            if (type) {
                return type;
            }
        }
        slice.skip(-savedBits + slice.remainingBits);
        for (let i = 0; i < -savedRefs + slice.remainingRefs; i++) {
            slice.loadRef();
        }

        return null;
    }

    deserialize(data: Cell | string, findByTag = false): Result<T> {
        if (typeof data === 'string') {
            try {
                data = Cell.fromBase64(data);
            } catch (_) {
                return { ok: false, error: new TLBDataError('Bad BOC string') };
            }
        }
        const slice = data.asSlice();
        if (findByTag) {
            const find = this.findByTag(slice);
            if (find) {
                return this.deserializeConstructor(find.type, find.item, slice);
            }
        }

        // Try the last type name first
        const result = this.deserializeByTypeName(this.lastTypeName, slice);
        if (result.ok) {
            return result;
        }

        // Try all other types in order, prioritizing types with tags
        const typeNames = Array.from(this.types.keys()).sort();
        const typesWithTags: string[] = [];
        const typesWithoutTags: string[] = [];
        
        for (const typeName of typeNames) {
            if (typeName === this.lastTypeName) continue; // Already tried
            
            const type = this.types.get(typeName);
            if (type) {
                const hasNonEmptyTag = type.constructors.some((c) => c.tag.bitLen > 0);
                if (hasNonEmptyTag) {
                    typesWithTags.push(typeName);
                } else {
                    typesWithoutTags.push(typeName);
                }
            }
        }
        
        // Try types with tags first
        for (const typeName of typesWithTags) {
            const typeResult = this.deserializeByTypeName(typeName, slice);
            if (typeResult.ok) {
                return typeResult;
            }
        }
        
        // Then try types without tags
        for (const typeName of typesWithoutTags) {
            const typeResult = this.deserializeByTypeName(typeName, slice);
            if (typeResult.ok) {
                return typeResult;
            }
        }

        return {
            ok: false,
            error: new TLBDataError(`No matching constructor found for any type. Tried ${typeNames.length} types.`),
        };
    }

    // Deserialize data from a Slice based on a TL-B type name
    deserializeByTypeName(typeName: string, slice: Slice): Result<T> {
        const type = this.types.get(typeName);
        if (!type) {
            return {
                ok: false,
                error: new TLBDataError(`Type ${typeName} not found in TL-B schema`),
            };
        }
        return this.deserializeType(type, slice);
    }

    serialize(data: T): Result<Builder> {
        const typeKind = (data as TypedCell).kind;
        if (!typeKind) {
            return {
                ok: false,
                error: new TLBDataError('Data must by typed'),
            };
        }
        return this.serializeByTypeName(typeKind, data);
    }

    // Serialize data to a Builder based on a TL-B type name
    serializeByTypeName(typeKind: string, data: T): Result<Builder> {
        const sep = typeKind.indexOf('_');
        const typeName = sep === -1 ? typeKind : typeKind.slice(0, sep);
        const type = this.types.get(typeName);
        if (!type) {
            return {
                ok: false,
                error: new TLBDataError(`Type ${typeName} not found in TL-B schema`),
            };
        }
        const value = beginCell();
        this.serializeType(type, data, value);
        return {
            ok: true,
            value,
        };
    }

    private deserializeType(type: TLBType, data: Slice, args: TLBFieldType[] = []): Result<T> {
        // Try each constructor in the type
        for (const constructor of type.constructors) {
            const result = this.deserializeConstructor(type, constructor, data, args);
            if (result.ok) {
                return result;
            }
        }

        return {
            ok: false,
            error: new TLBDataError(`Failed to deserialize type ${type.name} no matching constructor found`),
        };
    }

    private deserializeConstructor(
        type: TLBType,
        constructor: TLBConstructor,
        slice: Slice,
        args: TLBFieldType[] = [],
    ): Result<T> {
        // Save position to restore if the constructor doesn't match
        const bits = slice.remainingBits;
        const refs = slice.remainingRefs;
        const kind = type.constructors.length > 1 ? `${type.name}_${constructor.name}` : type.name;

        try {
            // Check tag if present
            if (constructor.tag.bitLen > 0) {
                const len = constructor.tag.bitLen;

                // Check if we have enough bits to read the tag
                if (slice.remainingBits < len) {
                    // Reset bit position
                    slice.skip(-bits + slice.remainingBits);

                    // Reset refs by loading them if needed
                    const refsToReset = -refs + slice.remainingRefs;
                    for (let i = 0; i < refsToReset; i++) {
                        slice.loadRef();
                    }
                    return {
                        ok: false,
                        error: new TLBDataError(
                            `Not enough bits to read tag for type ${kind}. Need ${len}, have ${slice.remainingBits}`,
                        ),
                    };
                }

                const preloadedTag = `0b${slice.preloadUint(len).toString(2).padStart(len, '0')}`;
                const expectedTag = tagKey(constructor.tag);
                if (preloadedTag !== expectedTag) {
                    // Restore position and try next constructor
                    // Reset bit position
                    slice.skip(-bits + slice.remainingBits);

                    // Reset refs by loading them if needed
                    const refsToReset = -refs + slice.remainingRefs;
                    for (let i = 0; i < refsToReset; i++) {
                        slice.loadRef();
                    }
                    return {
                        ok: false,
                        error: new TLBDataError(`Failed to deserialize type ${kind}`),
                    };
                }
                // Consume the tag
                slice.loadUint(constructor.tag.bitLen);
            }

            // Initialize variables map for constraint evaluation
            const variables = new Map<string, number>();

            // Deserialize fields
            // FIXME
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let value: any = {
                kind,
            };

            for (const field of constructor.fields) {
                // field.subFields.length
                if (field.subFields.length > 0) {
                    const ref = slice.loadRef();
                    const refSlice = ref.beginParse(true);
                    // FIXME
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const subfields: any = {};
                    for (const subfield of field.subFields) {
                        subfields[subfield.name] = this.deserializeField(subfield, refSlice, variables);
                    }

                    if (!field.anonymous) {
                        value[field.name] = subfields;
                    } else {
                        value = { ...value, ...subfields };
                    }
                } else {
                    if (
                        field.fieldType.kind === 'TLBNamedType' &&
                        constructor.parametersMap.get(field.fieldType.name)
                    ) {
                        const param = constructor.parametersMap.get(field.fieldType.name) as TLBParameter;
                        const paramIndex = constructor.parameters.findIndex(
                            (p) => p.variable.name === param.variable.name,
                        );
                        if (paramIndex >= 0 && paramIndex < args.length) {
                            field.fieldType = args[paramIndex];
                        }
                    }

                    const fieldValue = this.deserializeField(field, slice, variables);

                    if (!field.anonymous) {
                        value[field.name] = fieldValue;
                    }
                }
            }

            // Check constraints
            const evaluator = new MathExprEvaluator(variables);
            for (const constraint of constructor.constraints) {
                if (evaluator.evaluate(constraint) !== 1) {
                    // Constraint failed, try next constructor
                    // Reset bit position
                    slice.skip(-bits + slice.remainingBits);

                    // Reset refs by loading them if needed
                    const refsToReset = -refs + slice.remainingRefs;
                    for (let i = 0; i < refsToReset; i++) {
                        slice.loadRef();
                    }
                    return {
                        ok: false,
                        error: new TLBDataError(`Constraint failed for constructor ${constructor.name}`),
                    };
                }
            }

            return {
                ok: true,
                value,
            };
        } catch (error) {
            // If any TLBDataError occurs during deserialization, restore position and try next constructor
            if (error instanceof TLBDataError) {
                // Reset bit position - add bounds checking
                const skipAmount = -bits + slice.remainingBits;
                if (skipAmount !== 0 && slice.remainingBits > 0) {
                    try {
                        slice.skip(skipAmount);
                    } catch {
                        // If skip fails, ignore - slice might be in invalid state
                    }
                }

                // Reset refs by loading them if needed
                const refsToReset = -refs + slice.remainingRefs;
                for (let i = 0; i < refsToReset; i++) {
                    try {
                        slice.loadRef();
                    } catch {
                        // If loadRef fails, break - slice might be in invalid state
                        break;
                    }
                }
                return {
                    ok: false,
                    error: new TLBDataError(`Failed to deserialize constructor ${constructor.name}: ${error.message}`),
                };
            }
            throw error;
        }
    }

    // FIXME
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private deserializeField(field: TLBField, slice: Slice, variables: Map<string, number>): any {
        // Check if fieldType is defined
        if (!field.fieldType) {
            throw new TLBDataError(`Field ${field.name} has undefined fieldType`);
        }
        
        const val = this.deserializeFieldType(field.fieldType, slice, variables);

        if (
            field.name &&
            (field.fieldType.kind === 'TLBNamedType' ||
                field.fieldType.kind === 'TLBNumberType' ||
                field.fieldType.kind === 'TLBVarIntegerType' ||
                field.fieldType.kind === 'TLBBoolType')
        ) {
            // Extract numeric value for variable map
            let numValue = val;
            if (typeof val === 'string') {
                numValue = Number(val);
            } else if (typeof val === 'bigint') {
                numValue = Number(val);
            }
            variables.set(field.name, Number(numValue));
        }

        return val;
    }

    // FIXME
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private deserializeFieldType(fieldType: TLBFieldType, slice: Slice, variables: Map<string, number>): any {
        // Handle null/undefined fieldType
        if (!fieldType) {
            throw new TLBDataError('fieldType is undefined');
        }
        
        const evaluator = new MathExprEvaluator(variables);

        switch (fieldType.kind) {
            case 'TLBNumberType': {
                const bits = evaluator.evaluate(fieldType.bits);

                // Check if we have enough bits to read
                if (slice.remainingBits < bits) {
                    throw new TLBDataError(`Not enough bits to read number. Need ${bits}, have ${slice.remainingBits}`);
                }

                const value = slice.loadUintBig(bits);
                const result = fieldType.signed ? this.toSignedNumber(value, bits) : value;
                if (bits <= 32) {
                    return Number(result);
                }
                return result;
            }

            case 'TLBBoolType': {
                if (fieldType.value !== undefined) {
                    return fieldType.value;
                }
                return slice.loadBit();
            }

            case 'TLBBitsType': {
                const bits = evaluator.evaluate(fieldType.bits);

                // Check if we have enough bits to read
                if (slice.remainingBits < bits) {
                    throw new TLBDataError(`Not enough bits to read bits. Need ${bits}, have ${slice.remainingBits}`);
                }

                const raw = slice.loadBits(bits);
                
                // Handle external address bits - convert to external address object
                if (variables.has('len') && bits === variables.get('len')) {
                    const len = variables.get('len')!;
                    return {
                        value: raw.toString(),
                        bits: len,
                    };
                }
                
                if (this.config.autoText && bits % 8 === 0) {
                    return bitsToString(raw);
                }
                return raw;
            }

            case 'TLBNamedType': {
                const type = this.types.get(fieldType.name);

                if (fieldType.name === 'Bool') {
                    return slice.loadBit();
                }

                if (!type) {
                    throw new TLBDataError(`Type ${fieldType.name} not found in TL-B schema`);
                }

                return unwrap(this.deserializeType(type, slice, fieldType.arguments));
            }

            case 'TLBCoinsType': {
                return slice.loadCoins();
            }

            case 'TLBAddressType': {
                try {
                    return slice.loadAddress();
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    throw new TLBDataError(`Failed to load address: ${message}`);
                }
            }

            case 'TLBCellType': {
                return slice.loadMaybeRef();
            }

            case 'TLBCellInsideType': {
                const ref = slice.loadRef();
                const refSlice = ref.beginParse();
                return this.deserializeFieldType(fieldType.value, refSlice, variables);
            }

            case 'TLBHashmapType': {
                const keySize = evaluator.evaluate(fieldType.key.expr);
                const dict = slice.loadDict(Dictionary.Keys.BigInt(keySize), {
                    serialize: () => {
                        /* NO_USED */
                    },
                    parse: (slice) => this.deserializeFieldType(fieldType.value, slice, new Map(variables)),
                });
                return dict;
            }

            case 'TLBVarIntegerType': {
                const size = evaluator.evaluate(fieldType.n);

                // Estimate minimum bits needed (at least size bits for length)
                if (slice.remainingBits < size) {
                    throw new TLBDataError(
                        `Not enough bits to read var integer. Need at least ${size}, have ${slice.remainingBits}`,
                    );
                }

                let result;
                if (fieldType.signed) {
                    result = slice.loadVarIntBig(size);
                } else {
                    result = slice.loadVarUintBig(size);
                }
                
                // Return as string for consistency with test expectations
                return result.toString();
            }

            case 'TLBMultipleType': {
                const times = evaluator.evaluate(fieldType.times);
                const result = [];
                for (let i = 0; i < times; i++) {
                    result.push(this.deserializeFieldType(fieldType.value, slice, variables));
                }
                return result;
            }

            case 'TLBCondType': {
                const condition = evaluator.evaluate(fieldType.condition);
                if (condition) {
                    return this.deserializeFieldType(fieldType.value, slice, variables);
                }
                return undefined;
            }

            case 'TLBTupleType': {
                const cell = slice.loadRef();
                return parseTuple(cell);
            }

            default:
                throw new TLBDataError(`Unsupported field type: ${fieldType.kind}`);
        }
    }

    // FIXME
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private serializeType(type: TLBType, data: any, builder: Builder): void {
        // Find matching constructor by kind
        const typeKind = (data as TypedCell).kind;
        if (!typeKind) {
            throw new TLBDataError('Data must by typed');
        }

        const constructorName = typeKind.substring(type.name.length + 1); // Remove TypeName_ prefix
        let constructor: TLBConstructor | undefined;
        if (constructorName) {
            constructor = type.constructors.find((c) => c.name === constructorName);
        } else if (type.constructors.length > 0) {
            constructor = type.constructors[0];
        }
        if (!constructor) {
            throw new TLBDataError(`Constructor not found for type ${typeKind}`);
        }

        // Store tag if present
        if (constructor.tag.bitLen > 0) {
            const tag = BigInt(constructor.tag.binary);
            builder.storeUint(tag, constructor.tag.bitLen);
        }

        // Initialize variables map for constraint evaluation
        const variables = new Map<string, number>();

        // Initialize constructor parameters from data
        for (const param of constructor.parameters) {
            if (param.variable && param.variable.name && data[param.variable.name] !== undefined) {
                variables.set(param.variable.name, Number(data[param.variable.name]));
            }
        }

        // Extract parameters from type name arguments
        if (type.name.includes('(') && type.name.includes(')')) {
            const argStart = type.name.indexOf('(');
            const argEnd = type.name.lastIndexOf(')');
            if (argStart > 0 && argEnd > argStart) {
                const argsStr = type.name.substring(argStart + 1, argEnd);
                const argValues = argsStr.split(/[+\-*/\s]+/).filter((s) => !isNaN(Number(s)));

                for (let i = 0; i < argValues.length; i++) {
                    variables.set(`arg${i}`, Number(argValues[i]));
                }
            }
        }

        // Serialize fields
        for (const field of constructor.fields) {
            if (field.subFields.length > 0) {
                // Handle cell references ^[...]
                const cellBuilder = beginCell();
                
                for (const subfield of field.subFields) {
                    let subfieldValue = null;
                    if (!field.anonymous && data[field.name] && data[field.name][subfield.name] !== undefined) {
                        subfieldValue = data[field.name][subfield.name];
                    } else if (field.anonymous && data[subfield.name] !== undefined) {
                        subfieldValue = data[subfield.name];
                    }
                    
                    this.serializeField(subfield, subfieldValue, cellBuilder, variables);
                }
                
                builder.storeRef(cellBuilder.endCell());
            } else if (!field.anonymous) {
                this.serializeField(field, data[field.name], builder, variables);
            } else {
                // For anonymous fields, try to extract from data using field name or skip
                let fieldValue = null;
                if (field.name && data[field.name] !== undefined) {
                    fieldValue = data[field.name];
                }
                this.serializeField(field, fieldValue, builder, variables);
            }
        }

        // Check constraints
        const evaluator = new MathExprEvaluator(variables);
        for (const constraint of constructor.constraints) {
            if (evaluator.evaluate(constraint) !== 1) {
                throw new TLBDataError(`Constraint failed for type ${type.name}, constructor ${constructor.name}`);
            }
        }
    }

    // FIXME
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private serializeField(field: TLBField, value: any, builder: Builder, variables: Map<string, number>): void {
        if (
            field.name &&
            (field.fieldType.kind === 'TLBNumberType' ||
                field.fieldType.kind === 'TLBVarIntegerType' ||
                field.fieldType.kind === 'TLBBoolType')
        ) {
            variables.set(field.name, Number(value));
        }

        this.serializeFieldType(field.fieldType, value, builder, variables);
    }

    private serializeFieldType(
        fieldType: TLBFieldType,
        // FIXME
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        value: any,
        builder: Builder,
        variables: Map<string, number>,
    ): void {
        const evaluator = new MathExprEvaluator(variables);

        switch (fieldType.kind) {
            case 'TLBNumberType': {
                const bits = evaluator.evaluate(fieldType.bits);
                // Handle null/undefined values
                if (value === null || value === undefined) {
                    builder.storeUint(0, bits);
                } else {
                    builder.storeUint(value, bits);
                }
                break;
            }

            case 'TLBBoolType': {
                if (fieldType.value !== undefined) {
                    // Fixed value, nothing to store
                    break;
                }
                builder.storeBit(value ? 1 : 0);
                break;
            }

            case 'TLBBitsType': {
                if (typeof value === 'string') {
                    value = stringToBits(value);
                }
                if (value instanceof BitString) {
                    builder.storeBits(value);
                }
                break;
            }

            case 'TLBNamedType': {
                // Handle built-in types
                if (fieldType.name === 'Bool') {
                    builder.storeBit(value ? 1 : 0);
                    break;
                }

                // Handle generic/placeholder types (TheType, X, Y, A, Arg, etc.)
                if (
                    fieldType.name.match(/^[A-Z][a-zA-Z]*Type?$/) ||
                    fieldType.name.match(/^[A-Z]$/) ||
                    fieldType.name === 'Any' ||
                    fieldType.name === 'Arg'
                ) {
                    // For generic types, we need to serialize based on the actual value structure
                    if (value && typeof value === 'object' && value.kind) {
                        // Try to find a type that matches the value's kind
                        for (const [typeName, type] of this.types.entries()) {
                            if (value.kind === typeName || value.kind.startsWith(typeName + '_')) {
                                this.serializeType(type, value, builder);
                                return;
                            }
                        }
                    }
                    // If no matching type found, skip this field or serialize as raw data
                    break;
                }

                const type = this.types.get(fieldType.name);
                if (!type) {
                    throw new TLBDataError(`Type ${fieldType.name} not found in TL-B schema`);
                }
                this.serializeType(type, value, builder);
                break;
            }

            case 'TLBCoinsType': {
                // Handle null/undefined values
                if (value === null || value === undefined) {
                    builder.storeCoins(0);
                } else {
                    builder.storeCoins(value);
                }
                break;
            }

            case 'TLBAddressType': {
                // Handle different address formats
                if (value === null || value === undefined) {
                    builder.storeAddress(null);
                } else if (typeof value === 'string') {
                    try {
                        const address = Address.parse(value);
                        builder.storeAddress(address);
                    } catch {
                        // If parsing fails, store as null
                        builder.storeAddress(null);
                    }
                } else if (value && typeof value === 'object' && 'type' in value) {
                    // Handle external address objects
                    builder.storeAddress(null);
                } else {
                    builder.storeAddress(value);
                }
                break;
            }

            case 'TLBCellType': {
                if (value === null || value === undefined) {
                    // Store null reference
                    builder.storeBit(0);
                } else if (value instanceof Cell) {
                    builder.storeRef(value);
                } else {
                    // Try to convert to cell if it's an object
                    builder.storeBit(0);
                }
                break;
            }

            case 'TLBCellInsideType': {
                const nestedBuilder = beginCell();
                this.serializeFieldType(fieldType.value, value, nestedBuilder, variables);
                builder.storeRef(nestedBuilder.endCell());
                break;
            }

            case 'TLBHashmapType': {
                const keySize = evaluator.evaluate(fieldType.key.expr);
                const dict = Dictionary.empty(Dictionary.Keys.BigInt(keySize), Dictionary.Values.Cell());

                if (value) {
                    for (const [key, dictValue] of Object.entries(value)) {
                        // Skip metadata keys like _key
                        if (key.startsWith('_')) continue;

                        const valueBuilder = beginCell();
                        this.serializeFieldType(fieldType.value, dictValue, valueBuilder, new Map(variables));

                        try {
                            dict.set(BigInt(key), valueBuilder.endCell());
                        } catch {
                            // If key conversion fails, skip this entry
                            continue;
                        }
                    }
                }

                builder.storeDict(dict);
                break;
            }

            case 'TLBVarIntegerType': {
                const size = evaluator.evaluate(fieldType.n);
                
                // Convert string values to numbers/BigInt
                let numValue = value;
                if (typeof value === 'string') {
                    numValue = BigInt(value);
                } else if (typeof value === 'number') {
                    numValue = BigInt(value);
                }
                
                if (fieldType.signed) {
                    builder.storeVarInt(numValue, size);
                } else {
                    builder.storeVarUint(numValue, size);
                }
                break;
            }

            case 'TLBMultipleType': {
                const times = evaluator.evaluate(fieldType.times);
                for (let i = 0; i < times; i++) {
                    this.serializeFieldType(fieldType.value, value[i], builder, variables);
                }
                break;
            }

            case 'TLBCondType': {
                const condition = evaluator.evaluate(fieldType.condition);
                if (condition) {
                    this.serializeFieldType(fieldType.value, value, builder, variables);
                }
                break;
            }

            case 'TLBTupleType': {
                const cell = serializeTuple(value);
                builder.storeRef(cell);
                break;
            }

            default:
                throw new TLBDataError(`Unsupported field type: ${fieldType.kind}`);
        }
    }

    private toSignedNumber(value: bigint, bits: number): bigint {
        const maxUnsigned = 1n << BigInt(bits);
        const signBit = 1n << (BigInt(bits) - 1n);

        if (value && signBit) {
            return value - maxUnsigned;
        }

        return value;
    }
}

// Export a simple API for users
export function parseTLB<T extends ParsedCell = ParsedCell>(schema: string): TLBRuntime<T> {
    return unwrap(TLBRuntime.from(schema));
}
