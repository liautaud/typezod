import ts, {
  type TypeChecker,
  type Type,
  type Program,
  type SymbolFlags,
  type SourceFile,
} from "typescript";

const TS_SYMBOL_FLAGS_OPTIONAL = 16777216 satisfies SymbolFlags.Optional;

/**
 * Context required by all schema checks.
 *
 * `program` is required by schemas that resolve module exports
 * ({@link t.fromModule}).
 *
 * `sourceFile` is only required when resolving relative module specifiers
 * (`"./x"`, `"../x"`) with {@link t.fromModule}. It should be the source file
 * currently being analyzed.
 */
export type SchemaContext = {
  checker: TypeChecker;
  program?: Program;
  sourceFile?: SourceFile;
};

type AcceptsFn = (type: Type, ctx: SchemaContext) => boolean;

/**
 * A type schema that checks whether a TypeScript compiler type is assignable
 * to the type represented by the schema.
 *
 * Obtain instances through the {@link t} builder, never instantiate directly.
 */
export class TypeSchema {
  /** @internal */
  readonly _accepts: AcceptsFn;

  /** @internal */
  readonly _isOptional: boolean;

  /** @internal */
  constructor(accepts: AcceptsFn, isOptional = false) {
    this._accepts = accepts;
    this._isOptional = isOptional;
  }

  /**
   * Marks this schema as optional when used as a property in {@link t.object}.
   * An optional property may be absent from the type or carry the TypeScript
   * `Optional` symbol flag.
   *
   * @example
   * ```typescript
   * const Shape = t.object({
   *   label: t.string().optional(),
   * });
   * ```
   */
  optional(): TypeSchema {
    return new TypeSchema(t.union(this, t.undefined())._accepts, true);
  }

  /**
   * Wraps this schema to also accept `null`.
   *
   * @example
   * ```typescript
   * const MaybeNumber = t.number().nullable(); // number | null
   * ```
   */
  nullable(): TypeSchema {
    return t.union(this, t.null());
  }

  /**
   * Wraps this schema to also accept `null` and `undefined`.
   *
   * @example
   * ```typescript
   * const MaybeNumber = t.number().nullish(); // number | null | undefined
   * ```
   */
  nullish(): TypeSchema {
    return this.nullable().optional();
  }
}

const schema = (check: AcceptsFn): TypeSchema => new TypeSchema(check);

/**
 * Returns `true` if the given TypeScript type is assignable to the schema–in
 * other words, if `type extends T` with `T` the TypeScript type represented
 * by the schema.
 */
export function isAssignableTo(
  ctx: SchemaContext,
  type: Type,
  schema: TypeSchema,
): boolean {
  return schema._accepts(type, ctx);
}

/**
 * Schema builder namespace.
 */
export const t = {
  /** Represents the `number` type. */
  number: (): TypeSchema =>
    schema((type, { checker }) =>
      checker.isTypeAssignableTo(type, checker.getNumberType()),
    ),

  /** Represents the `string` type. */
  string: (): TypeSchema =>
    schema((type, { checker }) =>
      checker.isTypeAssignableTo(type, checker.getStringType()),
    ),

  /** Represents the `boolean` type. */
  boolean: (): TypeSchema =>
    schema((type, { checker }) =>
      checker.isTypeAssignableTo(type, checker.getBooleanType()),
    ),

  /** Represents the `void` type. */
  void: (): TypeSchema =>
    schema((type, { checker }) =>
      checker.isTypeAssignableTo(type, checker.getVoidType()),
    ),

  /** Represents the `undefined` type. */
  undefined: (): TypeSchema =>
    schema((type, { checker }) =>
      checker.isTypeAssignableTo(type, checker.getUndefinedType()),
    ),

  /** Represents the `null` type. */
  null: (): TypeSchema =>
    schema((type, { checker }) =>
      checker.isTypeAssignableTo(type, checker.getNullType()),
    ),

  /**
   * Represents the `any` type. Useful as a placeholder in object schemas when
   * you care about a property's existence but not its type.
   */
  any: (): TypeSchema => schema(() => true),

  /**
   * Represents the `unknown` type. Semantically identical to `t.any()` as a
   * predicate, but communicates intent differently in your schema.
   */
  unknown: (): TypeSchema => schema(() => true),

  /**
   * Represents an object type with the specified shape. Each property must be
   * present and non-optional unless its schema was marked `.optional()`.
   *
   * Extra properties are allowed (structural subtyping), consistent with
   * TypeScript's own assignability rules.
   *
   * @example
   * ```typescript
   * const Point = t.object({
   *   x: t.number(),
   *   y: t.number(),
   *   label: t.string().optional(),
   * });
   * ```
   */
  object: (shape: Record<string, TypeSchema>): TypeSchema =>
    schema((type, ctx) =>
      Object.entries(shape).every(([key, propSchema]) => {
        const propSymbol = type.getProperty(key);

        if (!propSymbol) return propSchema._isOptional;

        if (
          !propSchema._isOptional &&
          (propSymbol.flags & TS_SYMBOL_FLAGS_OPTIONAL) !== 0
        ) {
          return false;
        }

        const propType = ctx.checker.getTypeOfSymbol(propSymbol);
        return propSchema._accepts(propType, ctx);
      }),
    ),

  /**
   * Represents an array type whose element type satisfies the given schema.
   * Checks for a numeric index signature, so it also covers tuples and other
   * numerically-indexed types.
   *
   * @example
   * ```typescript
   * const NumberArray = t.array(t.number());
   * ```
   */
  array: (element: TypeSchema): TypeSchema =>
    schema((type, ctx) => {
      const indexType = type.getNumberIndexType();
      if (!indexType) return false;
      return element._accepts(indexType, ctx);
    }),

  /**
   * Represents a union of the given schemas. For union source types, every
   * constituent must individually satisfy at least one member schema.
   *
   * @example
   * ```typescript
   * const StringOrNumber = t.union(t.string(), t.number());
   * ```
   */
  union: (...members: TypeSchema[]): TypeSchema =>
    schema((type, ctx) => {
      if (type.isUnion()) {
        return type.types.every((member) =>
          members.some((m) => m._accepts(member, ctx)),
        );
      }
      return members.some((m) => m._accepts(type, ctx));
    }),

  /**
   * Represents an intersection of the given schemas. The type must satisfy
   * every member schema simultaneously.
   *
   * @example
   * ```typescript
   * const NamedAndAged = t.intersection(
   *   t.object({ name: t.string() }),
   *   t.object({ age: t.number() }),
   * );
   * ```
   */
  intersection: (...members: TypeSchema[]): TypeSchema =>
    schema((type, ctx) => members.every((m) => m._accepts(type, ctx))),

  /**
   * Represents a type exported from a module. Resolves the module using
   * TypeScript's module resolution algorithm, with a fallback to ambient
   * module declarations. Resolved types are cached per `TypeChecker` instance.
   *
   * Requires `program` in the {@link SchemaContext}. Relative specifiers
   * (`"./x"`, `"../x"`) also require `sourceFile`.
   *
   * @param moduleName The module specifier, as in an `import` statement.
   * @param exportName The exported type, class or interface name.
   *
   * @example
   * ```typescript
   * const BaseWindow = t.fromModule("electron", "BaseWindow");
   * const Buffer = t.fromModule("node:buffer", "Buffer");
   * ```
   *
   * @throws When `program` is missing from the context.
   * @throws When `moduleName` is relative and `sourceFile` is missing.
   * @throws When no export named `exportName` can be resolved from `moduleName`.
   */
  fromModule: (moduleName: string, exportName: string): TypeSchema =>
    schema((type, { checker, program, sourceFile }) => {
      if (!program) {
        throw new Error(
          "t.fromModule() requires `program` in the SchemaContext.",
        );
      }
      const isRelative =
        moduleName.startsWith("./") || moduleName.startsWith("../");
      if (isRelative && !sourceFile) {
        throw new Error(
          "t.fromModule() requires `sourceFile` in the SchemaContext for relative module specifiers.",
        );
      }

      let cache = moduleTypeCache.get(checker);
      if (!cache) {
        cache = new Map();
        moduleTypeCache.set(checker, cache);
      }

      const cacheKey = JSON.stringify([
        moduleName,
        exportName,
        isRelative ? sourceFile!.fileName : null,
      ]);

      if (!cache.has(cacheKey)) {
        cache.set(
          cacheKey,
          resolveModuleType(
            checker,
            program,
            moduleName,
            exportName,
            sourceFile,
          ),
        );
      }

      const targetType = cache.get(cacheKey);
      if (targetType == null) {
        throw new Error(
          `t.fromModule(): could not resolve export "${exportName}" from module "${moduleName}".`,
        );
      }
      return checker.isTypeAssignableTo(type, targetType);
    }),

  /**
   * Escape hatch for arbitrary predicates that the DSL cannot express directly.
   *
   * @example
   * ```typescript
   * const HasLengthProp = t.custom((type) =>
   *   type.getProperty("length") != null,
   * );
   * ```
   */
  custom: (predicate: AcceptsFn): TypeSchema => schema(predicate),
};

/** Per-checker cache for `t.fromModule()` resolved types. */
const moduleTypeCache = new WeakMap<TypeChecker, Map<string, Type | null>>();

/**
 * Resolves a module's exported type using TypeScript's module resolution
 * algorithm, with a fallback to ambient module declarations.
 *
 * Returns the resolved `ts.Type`, or `null` if the export cannot be found.
 *
 * @throws When multiple ambient/resolved symbols yield different types for the
 * same export name (ambiguity).
 */
const resolveModuleType = (
  checker: TypeChecker,
  program: Program,
  moduleName: string,
  exportName: string,
  sourceFile?: SourceFile,
): Type | null => {
  const compilerOptions = program.getCompilerOptions();
  const containingFile = sourceFile
    ? sourceFile.fileName
    : program.getCurrentDirectory() + "/__typezod__.ts";

  let moduleSymbol: ts.Symbol | undefined;

  const resolved = ts.resolveModuleName(
    moduleName,
    containingFile,
    compilerOptions,
    ts.sys,
  );
  if (resolved.resolvedModule) {
    const resolvedSf = program.getSourceFile(
      resolved.resolvedModule.resolvedFileName,
    );
    if (resolvedSf) {
      moduleSymbol = checker.getSymbolAtLocation(resolvedSf);
    }
  }

  if (!moduleSymbol) {
    const quotedName = `"${moduleName}"`;
    moduleSymbol = checker
      .getAmbientModules()
      .find((s) => s.getName() === quotedName);
  }

  if (!moduleSymbol) return null;

  const exportSymbol = checker
    .getExportsOfModule(moduleSymbol)
    .find((s) => s.getName() === exportName);
  if (!exportSymbol) return null;

  return checker.getDeclaredTypeOfSymbol(exportSymbol);
};
