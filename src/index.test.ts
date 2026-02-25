import ts from "typescript";
import { describe, expect, test } from "vitest";

import { t, isAssignableTo, type SchemaContext } from "./index.ts";

/**
 * Test harness: compiles a TypeScript snippet in-memory and returns typed
 * accessors for use in tests.
 */
const createTestContext = (
  source: string,
): {
  getTypeOf: (name: string) => ts.Type;
  ctx: SchemaContext;
} => {
  const fileName = "test.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const host = ts.createCompilerHost({ strict: true });
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) =>
    name === fileName ? sourceFile : originalGetSourceFile(name, ...args);
  const originalFileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || originalFileExists(name);

  const program = ts.createProgram([fileName], { strict: true }, host);
  const checker = program.getTypeChecker();

  const getTypeOf = (name: string): ts.Type => {
    const sym = checker
      .getSymbolsInScope(
        sourceFile.endOfFileToken,
        ts.SymbolFlags.Variable |
          ts.SymbolFlags.Interface |
          ts.SymbolFlags.TypeAlias,
      )
      .find((s) => s.getName() === name);
    if (!sym) throw new Error(`Symbol '${name}' not found in test source`);
    return checker.getTypeOfSymbol(sym);
  };

  return { getTypeOf, ctx: { checker, program } };
};

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

describe("primitives", () => {
  const { getTypeOf, ctx } = createTestContext(`
    const num: number = 0;
    const str: string = "";
    const bool: boolean = true;
    const nul: null = null;
    const undef: undefined = undefined;
    const voidVal: void = undefined;
    const literal42: 42 = 42;
    const literalHi: "hi" = "hi";
  `);

  test("t.number() matches number and numeric literals", () => {
    expect(isAssignableTo(ctx, getTypeOf("num"), t.number())).toBe(true);
    expect(isAssignableTo(ctx, getTypeOf("literal42"), t.number())).toBe(true);
  });

  test("t.number() rejects non-number types", () => {
    expect(isAssignableTo(ctx, getTypeOf("str"), t.number())).toBe(false);
    expect(isAssignableTo(ctx, getTypeOf("bool"), t.number())).toBe(false);
    expect(isAssignableTo(ctx, getTypeOf("nul"), t.number())).toBe(false);
  });

  test("t.string() matches string and string literals", () => {
    expect(isAssignableTo(ctx, getTypeOf("str"), t.string())).toBe(true);
    expect(isAssignableTo(ctx, getTypeOf("literalHi"), t.string())).toBe(true);
  });

  test("t.string() rejects non-string types", () => {
    expect(isAssignableTo(ctx, getTypeOf("num"), t.string())).toBe(false);
  });

  test("t.boolean() matches boolean", () => {
    expect(isAssignableTo(ctx, getTypeOf("bool"), t.boolean())).toBe(true);
    expect(isAssignableTo(ctx, getTypeOf("num"), t.boolean())).toBe(false);
  });

  test("t.null() matches null", () => {
    expect(isAssignableTo(ctx, getTypeOf("nul"), t.null())).toBe(true);
    expect(isAssignableTo(ctx, getTypeOf("num"), t.null())).toBe(false);
  });

  test("t.undefined() matches undefined", () => {
    expect(isAssignableTo(ctx, getTypeOf("undef"), t.undefined())).toBe(true);
    expect(isAssignableTo(ctx, getTypeOf("num"), t.undefined())).toBe(false);
  });

  test("t.void() matches void", () => {
    expect(isAssignableTo(ctx, getTypeOf("voidVal"), t.void())).toBe(true);
  });

  test("t.any() matches everything", () => {
    expect(isAssignableTo(ctx, getTypeOf("num"), t.any())).toBe(true);
    expect(isAssignableTo(ctx, getTypeOf("str"), t.any())).toBe(true);
    expect(isAssignableTo(ctx, getTypeOf("nul"), t.any())).toBe(true);
  });

  test("t.unknown() matches everything", () => {
    expect(isAssignableTo(ctx, getTypeOf("num"), t.unknown())).toBe(true);
    expect(isAssignableTo(ctx, getTypeOf("str"), t.unknown())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Object
// ---------------------------------------------------------------------------

describe("t.object()", () => {
  const { getTypeOf, ctx } = createTestContext(`
    const full = { x: 1, y: 2, width: 100, height: 200 };
    const partial = { x: 1, y: 2 };
    const extra = { x: 1, y: 2, width: 100, height: 200, label: "rect" };
    const wrongType = { x: "one", y: 2, width: 100, height: 200 };
    const withOptional: { x: number; y?: number } = { x: 1 };
    const withRequiredY: { x: number; y: number } = { x: 1, y: 2 };
    const noY: { x: number } = { x: 1 };
  `);

  const Rect = t.object({
    x: t.number(),
    y: t.number(),
    width: t.number(),
    height: t.number(),
  });

  test("matches when all required properties are present", () => {
    expect(isAssignableTo(ctx, getTypeOf("full"), Rect)).toBe(true);
  });

  test("rejects when required properties are missing", () => {
    expect(isAssignableTo(ctx, getTypeOf("partial"), Rect)).toBe(false);
  });

  test("allows extra properties (structural subtyping)", () => {
    expect(isAssignableTo(ctx, getTypeOf("extra"), Rect)).toBe(true);
  });

  test("rejects when a property has the wrong type", () => {
    expect(isAssignableTo(ctx, getTypeOf("wrongType"), Rect)).toBe(false);
  });

  test("rejects when a required property is optional on the type", () => {
    const Shape = t.object({ x: t.number(), y: t.number() });
    expect(isAssignableTo(ctx, getTypeOf("withOptional"), Shape)).toBe(false);
  });

  test(".optional() accepts absent properties", () => {
    const Shape = t.object({ x: t.number(), y: t.number().optional() });
    expect(isAssignableTo(ctx, getTypeOf("noY"), Shape)).toBe(true);
    expect(isAssignableTo(ctx, getTypeOf("withRequiredY"), Shape)).toBe(true);
  });

  test(".optional() accepts optional properties", () => {
    const Shape = t.object({ x: t.number(), y: t.number().optional() });
    expect(isAssignableTo(ctx, getTypeOf("withOptional"), Shape)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Modifiers: .nullable(), .nullish(), .refine()
// ---------------------------------------------------------------------------

describe("modifiers", () => {
  const { getTypeOf, ctx } = createTestContext(`
    const num: number = 0;
    const maybeNum: number | null = null;
    const nullishNum: number | null | undefined = undefined;
    const justNull: null = null;
    const str: string = "";
    const maybeStr: string | null = null;
  `);

  test(".nullable() accepts the base type", () => {
    const schema = t.number().nullable();
    expect(isAssignableTo(ctx, getTypeOf("num"), schema)).toBe(true);
  });

  test(".nullable() accepts base | null", () => {
    const schema = t.number().nullable();
    expect(isAssignableTo(ctx, getTypeOf("maybeNum"), schema)).toBe(true);
  });

  test(".nullable() rejects unrelated types", () => {
    const schema = t.number().nullable();
    expect(isAssignableTo(ctx, getTypeOf("str"), schema)).toBe(false);
    expect(isAssignableTo(ctx, getTypeOf("maybeStr"), schema)).toBe(false);
  });

  test(".nullish() accepts base | null | undefined", () => {
    const schema = t.number().nullish();
    expect(isAssignableTo(ctx, getTypeOf("nullishNum"), schema)).toBe(true);
    expect(isAssignableTo(ctx, getTypeOf("maybeNum"), schema)).toBe(true);
    expect(isAssignableTo(ctx, getTypeOf("num"), schema)).toBe(true);
  });

  test(".nullish() rejects unrelated types", () => {
    const schema = t.number().nullish();
    expect(isAssignableTo(ctx, getTypeOf("str"), schema)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compound: union, intersection, array
// ---------------------------------------------------------------------------

describe("t.union()", () => {
  const { getTypeOf, ctx } = createTestContext(`
    const sn: string | number = 0;
    const s: string = "";
    const n: number = 0;
    const b: boolean = true;
    const snb: string | number | boolean = true;
  `);

  const StringOrNumber = t.union(t.string(), t.number());

  test("matches a union type whose members all fit", () => {
    expect(isAssignableTo(ctx, getTypeOf("sn"), StringOrNumber)).toBe(true);
  });

  test("matches a non-union type that fits one branch", () => {
    expect(isAssignableTo(ctx, getTypeOf("s"), StringOrNumber)).toBe(true);
    expect(isAssignableTo(ctx, getTypeOf("n"), StringOrNumber)).toBe(true);
  });

  test("rejects a type that fits no branch", () => {
    expect(isAssignableTo(ctx, getTypeOf("b"), StringOrNumber)).toBe(false);
  });

  test("rejects a union with a member that fits no branch", () => {
    expect(isAssignableTo(ctx, getTypeOf("snb"), StringOrNumber)).toBe(false);
  });
});

describe("t.intersection()", () => {
  const { getTypeOf, ctx } = createTestContext(`
    const both: { name: string; age: number } = { name: "a", age: 1 };
    const nameOnly: { name: string } = { name: "a" };
  `);

  const NamedAndAged = t.intersection(
    t.object({ name: t.string() }),
    t.object({ age: t.number() }),
  );

  test("matches when all schemas are satisfied", () => {
    expect(isAssignableTo(ctx, getTypeOf("both"), NamedAndAged)).toBe(true);
  });

  test("rejects when one schema is not satisfied", () => {
    expect(isAssignableTo(ctx, getTypeOf("nameOnly"), NamedAndAged)).toBe(false);
  });
});

describe("t.array()", () => {
  const { getTypeOf, ctx } = createTestContext(`
    const nums: number[] = [];
    const strs: string[] = [];
    const notArray: number = 0;
    const tuple: [number, number] = [1, 2];
  `);

  const numArray = t.array(t.number());

  test("matches array with correct element type", () => {
    expect(isAssignableTo(ctx, getTypeOf("nums"), numArray)).toBe(true);
  });

  test("rejects array with wrong element type", () => {
    expect(isAssignableTo(ctx, getTypeOf("strs"), numArray)).toBe(false);
  });

  test("rejects non-array type", () => {
    expect(isAssignableTo(ctx, getTypeOf("notArray"), numArray)).toBe(false);
  });

  test("matches tuple with compatible element type", () => {
    expect(isAssignableTo(ctx, getTypeOf("tuple"), numArray)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

describe("t.fromModule()", () => {
  const { getTypeOf, ctx } = createTestContext(`
    import ts from "typescript";
    declare const checker: ts.TypeChecker;
    declare const sourceFile: ts.SourceFile;
    declare const notChecker: string;
  `);

  test("matches a type resolved from a module", () => {
    const TypeCheckerSchema = t.fromModule("/typescript/", "TypeChecker");
    expect(isAssignableTo(ctx, getTypeOf("checker"), TypeCheckerSchema)).toBe(true);
  });

  test("rejects a type not assignable to the resolved type", () => {
    const TypeCheckerSchema = t.fromModule("/typescript/", "TypeChecker");
    expect(isAssignableTo(ctx, getTypeOf("notChecker"), TypeCheckerSchema)).toBe(false);
  });

  test("different exports resolve independently", () => {
    const SourceFileSchema = t.fromModule("/typescript/", "SourceFile");
    expect(isAssignableTo(ctx, getTypeOf("sourceFile"), SourceFileSchema)).toBe(true);
    expect(isAssignableTo(ctx, getTypeOf("notChecker"), SourceFileSchema)).toBe(false);
  });

  test("throws when program is not provided", () => {
    const TypeCheckerSchema = t.fromModule("/typescript/", "TypeChecker");
    const ctxNoProgram: SchemaContext = { checker: ctx.checker };
    expect(() =>
      isAssignableTo(ctxNoProgram, getTypeOf("checker"), TypeCheckerSchema),
    ).toThrow("t.fromModule() requires `program`");
  });

  test("throws for non-existent export", () => {
    const Nonexistent = t.fromModule("/typescript/", "DoesNotExist");
    expect(() => isAssignableTo(ctx, getTypeOf("checker"), Nonexistent)).toThrow(
      'could not resolve export "DoesNotExist"',
    );
  });

  test("throws for non-existent module", () => {
    const Nonexistent = t.fromModule("/no-such-module/", "Foo");
    expect(() => isAssignableTo(ctx, getTypeOf("checker"), Nonexistent)).toThrow(
      'could not resolve export "Foo" from any module matching "/no-such-module/"',
    );
  });
});

// ---------------------------------------------------------------------------
// Custom
// ---------------------------------------------------------------------------

describe("t.custom()", () => {
  const { getTypeOf, ctx } = createTestContext(`
    const arr: number[] = [];
    const num: number = 0;
  `);

  test("delegates to the provided predicate", () => {
    const HasLength = t.custom((type) => type.getProperty("length") != null);
    expect(isAssignableTo(ctx, getTypeOf("arr"), HasLength)).toBe(true);
    expect(isAssignableTo(ctx, getTypeOf("num"), HasLength)).toBe(false);
  });
});
