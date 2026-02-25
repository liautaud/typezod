# typezod

Zod-like DSL for comparing TypeScript compiler types against
user-defined schemas.

## Why?

Writing type-aware ESLint rules (or codemods, code generators, etc.) means
working with the TypeScript compiler's `ts.Type` objects. Checking whether
a type matches a specific schema quickly turns into verbose, repetitive
calls to `checker.isTypeAssignableTo()`, `type.getProperty()`, and friends.

This library lets you **declare** the types you care about with a concise,
Zod-inspired API and then ask "is this compiler type assignable to my
schema?" in a single call.

## Usage

```typescript
import { t, isAssignableTo, type SchemaContext } from "@liautaud/typezod";

// Define schemas for the types you want to check against.
const Rectangle = t.object({
  x: t.number(),
  y: t.number(),
  width: t.number(),
  height: t.number(),
});

const ElectronWindow = t.fromModule("electron", "BaseWindow");

// Inside a typescript-eslint rule's `create()` function, build a context
// from the parser services and use `isAssignableTo` to check types.
const checker = parserServices.program.getTypeChecker();
const ctx: SchemaContext = { checker, program: parserServices.program };

if (isAssignableTo(ctx, objectType, ElectronWindow)) {
  if (!isAssignableTo(ctx, argType, Rectangle)) {
    context.report({ ... });
  }
}
```

## API

### `isAssignableTo(ctx, type, schema)`

Returns `true` if the given `ts.Type` is assignable to the type represented
by the schema.

### `SchemaContext`

The context object passed to `isAssignableTo`. Contains a `checker`
(always required), a `program` (required when using `t.fromModule()`),
and a `sourceFile` (required when using `t.fromModule()` with a relative
module specifier such as `"./foo"` or `"../foo"`).

Example for relative module specifiers inside an ESLint rule:

```typescript
const tsNode = parserServices.esTreeNodeToTSNodeMap.get(node);
const ctx: SchemaContext = {
  checker: parserServices.program.getTypeChecker(),
  program: parserServices.program,
  sourceFile: tsNode.getSourceFile(),
};
```

### Primitives

| Builder         | Description                     |
| --------------- | ------------------------------- |
| `t.string()`    | Represents the `string` type    |
| `t.number()`    | Represents the `number` type    |
| `t.boolean()`   | Represents the `boolean` type   |
| `t.void()`      | Represents the `void` type      |
| `t.undefined()` | Represents the `undefined` type |
| `t.null()`      | Represents the `null` type      |
| `t.any()`       | Accepts any type                |
| `t.unknown()`   | Accepts any type                |

### Combinators

| Builder                      | Description                                                      |
| ---------------------------- | ---------------------------------------------------------------- |
| `t.object(shape)`            | Represents an object with the given shape (structural subtyping) |
| `t.array(element)`           | Represents an array whose element satisfies the given schema     |
| `t.union(...schemas)`        | Represents a union of the given schemas                          |
| `t.intersection(...schemas)` | Represents an intersection of the given schemas                  |

### Advanced

| Builder                                | Description                                             |
| -------------------------------------- | ------------------------------------------------------- |
| `t.fromModule(moduleName, exportName)` | Represents a type exported from a module in the program |
| `t.custom(fn)`                         | Escape hatch for arbitrary predicates                   |

`t.fromModule()` accepts the same module specifier you'd write in an `import` statement.
Installed packages (`"typescript"`, `"electron"`), relative paths (`"./types"`,
`"../shared/types"`), and ambient module declarations (`declare module '...'`) are
all supported. Relative specifiers require `sourceFile` in the context. Throws if the
module or export cannot be found.

### Modifiers

| Modifier      | Description                                                       |
| ------------- | ----------------------------------------------------------------- |
| `.optional()` | Inside `t.object()`, allows the property to be absent or optional |
| `.nullable()` | Also accepts `null`                                               |
| `.nullish()`  | Also accepts `null \| undefined`                                  |
